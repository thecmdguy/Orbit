// Orbit models service (pm2 orbit-models, 127.0.0.1:3022).
// Lets Orbit chat with non-Claude models: any OpenAI-compatible API (OpenAI, Gemini, OpenRouter,
// Groq, DeepSeek, Mistral, xAI, Together, Anthropic's compat layer) and local servers (Ollama,
// LM Studio, llama.cpp, vLLM). nginx serves it at /claude/api/models/* behind the same
// auth_request as the usage widget, so Orbit itself never needs a restart for it.
//
// Providers marked where:"browser" are called straight from the browser (e.g. Ollama on the
// user's own computer); this service then only stores the conversation.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import cfg from './config.mjs';

const PORT = cfg.PORTS.models;
const BASE = cfg.BASE + '/api/models';
const DATA = cfg.MODELS_DATA;
const CONF = path.join(DATA, 'providers.json');
const CONVOS = path.join(DATA, 'convos');
const IMGS = path.join(DATA, 'img');
const UPLOADS = cfg.UPLOADS.replace(/\/?$/, '/');

const IMAGE_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
const MASK = '••••••••';

for (const d of [DATA, CONVOS, IMGS]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });

// ---------- config ----------
function loadConf() {
  try { return JSON.parse(fs.readFileSync(CONF, 'utf8')); } catch { return { providers: [], system: '', defaultModel: null }; }
}
function saveConf(c) {
  const tmp = CONF + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(c, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, CONF);
}
const publicProvider = (p) => ({ ...p, apiKey: p.apiKey ? MASK : '', hasKey: !!p.apiKey });

function cleanProvider(p, old) {
  const id = /^[a-z0-9-]{1,40}$/.test(p.id || '') ? p.id : 'p-' + crypto.randomBytes(4).toString('hex');
  let baseUrl = String(p.baseUrl || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//.test(baseUrl)) throw new Error('Base URL must start with http:// or https://');
  const models = (Array.isArray(p.models) ? p.models : String(p.models || '').split(','))
    .map((s) => String(s).trim()).filter(Boolean).slice(0, 100);
  return {
    id,
    name: String(p.name || 'Provider').slice(0, 60),
    preset: String(p.preset || 'custom').slice(0, 30),
    baseUrl,
    apiKey: p.apiKey === MASK ? (old?.apiKey || '') : String(p.apiKey || '').trim(),
    where: p.where === 'browser' ? 'browser' : 'server',
    enabled: p.enabled !== false,
    models,
  };
}

// ---------- upstream calls ----------
function headersFor(p) {
  const h = { 'Content-Type': 'application/json', 'User-Agent': 'orbit-models/1.0' };
  if (p.apiKey) h.Authorization = 'Bearer ' + p.apiKey;
  if (/(^|\.)anthropic\.com$/.test(hostOf(p.baseUrl))) { h['x-api-key'] = p.apiKey; h['anthropic-version'] = '2023-06-01'; }
  if (/openrouter\.ai$/.test(hostOf(p.baseUrl))) { h['HTTP-Referer'] = (cfg.PUBLIC_URL || '') + cfg.BASE + '/'; h['X-Title'] = 'Orbit'; }
  return h;
}
function hostOf(u) { try { return new URL(u).hostname; } catch { return ''; } }

async function readErr(r) {
  const t = Buffer.from(await r.arrayBuffer()).toString('utf8');
  try { const j = JSON.parse(t); return j.error?.message || j.error || j.message || t; } catch { return t.slice(0, 400) || r.statusText; }
}

const modelCache = new Map(); // provider id -> { at, models }
async function listModels(p, force) {
  const c = modelCache.get(p.id);
  if (!force && c && Date.now() - c.at < 5 * 60_000) return c.models;
  const r = await fetch(p.baseUrl + '/models', { headers: headersFor(p), signal: AbortSignal.timeout(12_000) });
  if (!r.ok) throw new Error(`${r.status}: ${String(await readErr(r)).slice(0, 300)}`);
  const j = JSON.parse(Buffer.from(await r.arrayBuffer()).toString('utf8'));
  const arr = Array.isArray(j) ? j : j.data || j.models || [];
  const models = arr.map((m) => (typeof m === 'string' ? m : m.id || m.name)).filter(Boolean)
    .map((s) => String(s).replace(/^models\//, '')).sort();
  modelCache.set(p.id, { at: Date.now(), models });
  return models;
}

// ---------- conversations ----------
const convoPath = (id) => path.join(CONVOS, id + '.json');
const validId = (id) => /^[a-z0-9]{8,40}$/.test(id || '');
function loadConvo(id) { try { return JSON.parse(fs.readFileSync(convoPath(id), 'utf8')); } catch { return null; } }
function saveConvo(c) {
  c.updated = Date.now();
  const tmp = convoPath(c.id) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(c), { mode: 0o600 });
  fs.renameSync(tmp, convoPath(c.id));
}
function newConvo(provider, model) {
  return { id: crypto.randomBytes(8).toString('hex'), title: '', provider, model, created: Date.now(), updated: Date.now(), messages: [] };
}
function listConvos() {
  const out = [];
  for (const f of fs.readdirSync(CONVOS)) {
    if (!f.endsWith('.json')) continue;
    try {
      const c = JSON.parse(fs.readFileSync(path.join(CONVOS, f), 'utf8'));
      out.push({ id: c.id, title: c.title || 'Chat', provider: c.provider, model: c.model, at: c.updated, count: c.messages.length });
    } catch {}
  }
  return out.sort((a, b) => b.at - a.at).slice(0, 300);
}

// images are stored as files so the conversation JSON stays small
function storeImages(images) {
  return (Array.isArray(images) ? images : []).slice(0, 20).filter((im) => IMAGE_TYPES[im?.media_type] && typeof im.data === 'string' && im.data.length < 8 << 20).map((im) => {
    const buf = Buffer.from(im.data, 'base64');
    const name = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 32) + '.' + IMAGE_TYPES[im.media_type];
    const p = path.join(IMGS, name);
    if (!fs.existsSync(p)) fs.writeFileSync(p, buf, { mode: 0o600 });
    return { media_type: im.media_type, file: name };
  });
}
function imageDataUrl(im) {
  try { return `data:${im.media_type};base64,` + fs.readFileSync(path.join(IMGS, path.basename(im.file))).toString('base64'); } catch { return null; }
}

// "[Attached file: /root/uploads/... (12 KB)]" lines: other models can't open server files,
// so text files are inlined into the prompt (up to 200 KB each).
const ATT_RE = /^\[Attached file: (.+?) \((.+?)\)\]$/gm;
function readAttachment(p) {
  const real = fs.realpathSync(p);
  if (!real.startsWith(UPLOADS)) throw new Error('Only uploaded files can be attached');
  const st = fs.statSync(real);
  const buf = Buffer.alloc(Math.min(st.size, 200 * 1024));
  const fd = fs.openSync(real, 'r'); fs.readSync(fd, buf, 0, buf.length, 0); fs.closeSync(fd);
  if (buf.includes(0)) return { binary: true, size: st.size };
  return { text: buf.toString('utf8'), truncated: st.size > buf.length, size: st.size };
}
function expandAttachments(text) {
  return String(text || '').replace(ATT_RE, (line, p) => {
    try {
      const a = readAttachment(p);
      const name = path.basename(p);
      if (a.binary) return `[Attached file ${name}: binary file, contents not included]`;
      return `Attached file ${name}${a.truncated ? ' (first 200 KB)' : ''}:\n\`\`\`\n${a.text}\n\`\`\``;
    } catch { return line; }
  });
}

function toOpenAI(conv, system) {
  const msgs = [];
  if (system?.trim()) msgs.push({ role: 'system', content: system.trim() });
  for (const m of conv.messages) {
    if (m.role === 'assistant') { if (m.content) msgs.push({ role: 'assistant', content: m.content }); continue; }
    const text = expandAttachments(m.content);
    const imgs = (m.images || []).map(imageDataUrl).filter(Boolean);
    msgs.push(imgs.length
      ? { role: 'user', content: [...imgs.map((url) => ({ type: 'image_url', image_url: { url } })), { type: 'text', text: text || 'See the image.' }] }
      : { role: 'user', content: text });
  }
  return msgs;
}

// ---------- streaming chat (server-side providers) ----------
async function streamChat(p, model, messages, signal, emit) {
  const body = { model, messages, stream: true, stream_options: { include_usage: true } };
  let r = await fetch(p.baseUrl + '/chat/completions', { method: 'POST', headers: headersFor(p), body: JSON.stringify(body), signal });
  if (r.status === 400 || r.status === 422) {
    const err = await readErr(r);
    if (!/stream_options|include_usage|unrecognized|extra/i.test(String(err))) throw new Error(`${r.status}: ${err}`);
    delete body.stream_options;
    r = await fetch(p.baseUrl + '/chat/completions', { method: 'POST', headers: headersFor(p), body: JSON.stringify(body), signal });
  }
  if (!r.ok) throw new Error(`${r.status}: ${String(await readErr(r)).slice(0, 500)}`);
  const out = { content: '', reasoning: '', usage: null, finish: null };
  const dec = new TextDecoder();
  let buf = '';
  const handle = (line) => {
    line = line.trim();
    if (!line.startsWith('data:')) return;
    const d = line.slice(5).trim();
    if (!d || d === '[DONE]') return;
    let j; try { j = JSON.parse(d); } catch { return; }
    if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
    const ch = j.choices?.[0];
    const delta = ch?.delta || {};
    const rz = delta.reasoning_content || delta.reasoning || '';
    if (rz) { out.reasoning += rz; emit({ type: 'reasoning', text: rz }); }
    if (delta.content) { out.content += delta.content; emit({ type: 'delta', text: delta.content }); }
    if (ch?.finish_reason) out.finish = ch.finish_reason;
    if (j.usage) out.usage = j.usage;
  };
  if (!r.headers.get('content-type')?.includes('event-stream')) {
    // some servers ignore stream:true and answer in one piece
    const j = JSON.parse(Buffer.from(await r.arrayBuffer()).toString('utf8'));
    out.content = j.choices?.[0]?.message?.content || '';
    out.reasoning = j.choices?.[0]?.message?.reasoning_content || '';
    out.usage = j.usage || null;
    if (out.reasoning) emit({ type: 'reasoning', text: out.reasoning });
    emit({ type: 'delta', text: out.content });
    return out;
  }
  for await (const chunk of r.body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { handle(buf.slice(0, i)); buf = buf.slice(i + 1); }
  }
  if (buf) handle(buf);
  return out;
}

function addUserMessage(conv, text, images) {
  const msg = { role: 'user', content: String(text || '').slice(0, 200000), images: storeImages(images), at: Date.now() };
  conv.messages.push(msg);
  if (!conv.title) conv.title = msg.content.replace(/^\[Attached .*$/gm, '').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Image chat';
  return msg;
}

// ---------- http ----------
function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
async function readJson(req, max = 60 << 20) {
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > max) throw new Error('Body too large'); chunks.push(c); }
  return n ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

const running = new Map(); // convo id -> AbortController

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname.startsWith(BASE) ? url.pathname.slice(BASE.length) || '/' : null;
  if (p == null) return send(res, 404, { error: 'Not found' });
  if (req.method !== 'GET' && !cfg.originOk(req.headers.origin || '')) return send(res, 403, { error: 'Bad origin' });
  try {
    // --- providers ---
    if (p === '/config' && req.method === 'GET') {
      const c = loadConf();
      return send(res, 200, { providers: c.providers.map(publicProvider), system: c.system || '', defaultModel: c.defaultModel || null });
    }
    if (p === '/config' && req.method === 'PUT') {
      const body = await readJson(req, 1 << 20);
      const c = loadConf();
      const old = new Map(c.providers.map((x) => [x.id, x]));
      if (Array.isArray(body.providers)) c.providers = body.providers.slice(0, 50).map((x) => cleanProvider(x, old.get(x.id)));
      if (typeof body.system === 'string') c.system = body.system.slice(0, 20000);
      if ('defaultModel' in body) c.defaultModel = body.defaultModel || null;
      saveConf(c);
      for (const id of old.keys()) modelCache.delete(id);
      for (const x of c.providers) modelCache.delete(x.id);
      return send(res, 200, { providers: c.providers.map(publicProvider), system: c.system || '', defaultModel: c.defaultModel || null });
    }
    // test a provider before saving it (key may be the mask -> use the stored one)
    if (p === '/test' && req.method === 'POST') {
      const body = await readJson(req, 1 << 20);
      const old = loadConf().providers.find((x) => x.id === body.id);
      const prov = cleanProvider(body, old);
      prov.id = 'test-' + crypto.randomBytes(3).toString('hex');
      try { const models = await listModels(prov, true); modelCache.delete(prov.id); return send(res, 200, { ok: true, models }); }
      catch (e) { return send(res, 200, { ok: false, error: String(e.message || e) }); }
    }
    const lm = p.match(/^\/providers\/([a-z0-9-]+)\/models$/);
    if (lm && req.method === 'GET') {
      const prov = loadConf().providers.find((x) => x.id === lm[1]);
      if (!prov) return send(res, 404, { error: 'No such provider' });
      if (prov.where === 'browser') return send(res, 200, { models: prov.models, browser: true });
      try {
        const live = await listModels(prov, url.searchParams.has('refresh'));
        return send(res, 200, { models: [...new Set([...prov.models, ...live])] });
      } catch (e) { return send(res, 200, { models: prov.models, error: String(e.message || e) }); }
    }
    // --- attachments (for browser-side providers) ---
    if (p === '/attachment' && req.method === 'GET') {
      try { return send(res, 200, readAttachment(url.searchParams.get('path') || '')); }
      catch (e) { return send(res, 400, { error: String(e.message || e) }); }
    }
    const im = p.match(/^\/img\/([a-f0-9]{32}\.(png|jpg|gif|webp))$/);
    if (im && req.method === 'GET') {
      try {
        const buf = fs.readFileSync(path.join(IMGS, im[1]));
        res.writeHead(200, { 'Content-Type': 'image/' + (im[2] === 'jpg' ? 'jpeg' : im[2]), 'Cache-Control': 'private, max-age=31536000, immutable' });
        return res.end(buf);
      } catch { return send(res, 404, { error: 'Not found' }); }
    }
    // --- conversations ---
    if (p === '/convos' && req.method === 'GET') return send(res, 200, listConvos().map((c) => ({ ...c, running: running.has(c.id) })));
    const cm = p.match(/^\/convos\/([a-z0-9]+)(\/append|\/truncate)?$/);
    if (cm) {
      if (!validId(cm[1])) return send(res, 400, { error: 'Bad id' });
      let conv = loadConvo(cm[1]);
      if (!cm[2] && req.method === 'GET') return conv ? send(res, 200, { ...conv, running: running.has(conv.id) }) : send(res, 404, { error: 'Not found' });
      if (!cm[2] && req.method === 'DELETE') { running.get(cm[1])?.abort(); try { fs.unlinkSync(convoPath(cm[1])); } catch {} return send(res, 200, { ok: true }); }
      if (!cm[2] && req.method === 'PATCH') {
        if (!conv) return send(res, 404, { error: 'Not found' });
        const body = await readJson(req, 1 << 20);
        if (typeof body.title === 'string') conv.title = body.title.slice(0, 120);
        saveConvo(conv);
        return send(res, 200, { ok: true });
      }
      // drop messages from index n on (used by "regenerate" / "edit and resend")
      if (cm[2] === '/truncate' && req.method === 'POST') {
        if (!conv) return send(res, 404, { error: 'Not found' });
        const body = await readJson(req, 1 << 20);
        conv.messages = conv.messages.slice(0, Math.max(0, body.keep | 0));
        saveConvo(conv);
        return send(res, 200, { ok: true });
      }
      // browser-side providers: the browser ran the model, we store the result
      if (cm[2] === '/append' && req.method === 'POST') {
        const body = await readJson(req);
        if (!conv) conv = { ...newConvo(body.provider, body.model), id: cm[1] };
        if (body.provider) conv.provider = body.provider;
        if (body.model) conv.model = body.model;
        for (const m of (body.messages || []).slice(0, 4)) {
          if (m.role === 'user') addUserMessage(conv, m.content, m.images);
          else if (m.role === 'assistant') conv.messages.push({ role: 'assistant', content: String(m.content || ''), reasoning: m.reasoning || undefined, provider: conv.provider, model: conv.model, usage: m.usage || undefined, error: m.error || undefined, ms: m.ms || undefined, at: Date.now() });
        }
        saveConvo(conv);
        return send(res, 200, { ok: true, id: conv.id, title: conv.title });
      }
    }
    // --- chat (server-side providers), streamed as server-sent events ---
    if (p === '/chat' && req.method === 'POST') {
      const body = await readJson(req);
      const conf = loadConf();
      const prov = conf.providers.find((x) => x.id === body.provider);
      if (!prov) return send(res, 400, { error: 'Pick a model first' });
      if (prov.where === 'browser') return send(res, 400, { error: 'This provider runs in the browser' });
      const model = String(body.model || '').slice(0, 200);
      if (!model) return send(res, 400, { error: 'Pick a model first' });
      let conv = validId(body.convo) ? loadConvo(body.convo) : null;
      if (!conv) conv = newConvo(prov.id, model);
      if (running.has(conv.id)) return send(res, 409, { error: 'Still answering the last message' });
      conv.provider = prov.id; conv.model = model;
      if (!body.regenerate) addUserMessage(conv, body.text, body.images);
      saveConvo(conv);

      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
      const emit = (o) => { if (!res.writableEnded) res.write('data: ' + JSON.stringify(o) + '\n\n'); };
      emit({ type: 'meta', id: conv.id, title: conv.title });
      const ac = new AbortController();
      running.set(conv.id, ac);
      res.on('close', () => { if (!res.writableFinished) ac.abort(); });
      const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
      const t0 = Date.now();
      let out = { content: '', reasoning: '' }, error = null;
      try {
        out = await streamChat(prov, model, toOpenAI(conv, conf.system), ac.signal, (o) => {
          if (o.type === 'delta') out.content += o.text; else if (o.type === 'reasoning') out.reasoning += o.text;
          emit(o);
        });
      } catch (e) {
        error = ac.signal.aborted ? 'Stopped' : String(e.message || e);
      }
      clearInterval(ping);
      running.delete(conv.id);
      const msg = { role: 'assistant', content: out.content || '', provider: prov.id, model, at: Date.now(), ms: Date.now() - t0 };
      if (out.reasoning) msg.reasoning = out.reasoning;
      if (out.usage) msg.usage = { in: out.usage.prompt_tokens, out: out.usage.completion_tokens };
      if (error) msg.error = error;
      conv.messages.push(msg);
      saveConvo(conv);
      emit({ type: 'done', message: msg });
      return res.end();
    }
    if (p === '/stop' && req.method === 'POST') {
      const body = await readJson(req, 1 << 16);
      running.get(body.convo)?.abort();
      return send(res, 200, { ok: true });
    }
    send(res, 404, { error: 'Not found' });
  } catch (e) {
    if (!res.headersSent) send(res, 500, { error: String(e.message || e) });
    else res.end();
  }
});
server.requestTimeout = 0;
server.listen(PORT, cfg.HOST, () => console.log('orbit-models on', cfg.HOST + ':' + PORT));
