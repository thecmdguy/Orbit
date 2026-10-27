// Orbit live usage service (pm2 orbit-usage, 127.0.0.1:3021).
// nginx serves it at /claude/api/usage behind an auth_request to Orbit's own login check,
// so it runs separately and Orbit never needs a restart for it.
// - Plan limits come from the same endpoint the CLI's /usage uses (OAuth token from ~/.claude/.credentials.json).
// - Token counts come from the local session logs (~/.claude/projects/**/*.jsonl), read incrementally.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import cfg from './config.mjs';

const PORT = cfg.PORTS.usage;
const CREDS = cfg.CREDS;
const PROJECTS = cfg.PROJECTS;
const LIMITS_TTL = 60_000;

let limits = null, limitsAt = 0, limitsErr = null, inflight = null;

async function fetchLimits() {
  const o = JSON.parse(fs.readFileSync(CREDS, 'utf8')).claudeAiOauth || {};
  const r = await fetch('https://api.anthropic.com/api/oauth/usage', {
    headers: { Authorization: 'Bearer ' + o.accessToken, 'anthropic-beta': 'oauth-2025-04-20', 'User-Agent': 'orbit-usage/1.0' },
    signal: AbortSignal.timeout(15_000),
  });
  const buf = Buffer.from(await r.arrayBuffer()).toString('utf8');
  if (!r.ok) throw new Error(`Usage API ${r.status}`);
  return { plan: o.subscriptionType || null, tier: o.rateLimitTier || null, data: JSON.parse(buf) };
}

async function getLimits(force) {
  if (!force && limits && Date.now() - limitsAt < LIMITS_TTL) return;
  if (force && Date.now() - limitsAt < 10_000) return; // don't hammer the API
  if (!inflight) inflight = fetchLimits()
    .then((v) => { limits = v; limitsAt = Date.now(); limitsErr = null; })
    .catch((e) => { limitsErr = e.message; limitsAt = Date.now() - LIMITS_TTL + 15_000; })
    .finally(() => { inflight = null; });
  await inflight;
}

// ---- local token counts, read incrementally per file ----
const files = new Map(); // file -> { offset, rest, msgs: Map(id -> {ts, model, u}) }
const WEEK = 7 * 864e5;

function walk(dir, out) {
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) walk(p, out);
    else if (d.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

function scan() {
  const cutoff = Date.now() - WEEK;
  for (const f of walk(PROJECTS, [])) {
    let st; try { st = fs.statSync(f); } catch { continue; }
    if (st.mtimeMs < cutoff && !files.has(f)) continue;
    let e = files.get(f);
    if (!e || st.size < e.offset) { e = { offset: 0, rest: '', msgs: new Map() }; files.set(f, e); }
    if (st.size === e.offset) continue;
    const fd = fs.openSync(f, 'r');
    try {
      let pos = e.offset;
      const chunk = Buffer.alloc(4 << 20);
      while (pos < st.size) {
        const n = fs.readSync(fd, chunk, 0, Math.min(chunk.length, st.size - pos), pos);
        if (!n) break;
        pos += n;
        const lines = (e.rest + chunk.toString('utf8', 0, n)).split('\n');
        e.rest = lines.pop();
        for (const line of lines) {
          if (!line.includes('"usage"') || !line.includes('"assistant"')) continue;
          try {
            const j = JSON.parse(line);
            const m = j.message;
            if (j.type !== 'assistant' || !m?.usage || !m.model || m.model === '<synthetic>') continue;
            const ts = Date.parse(j.timestamp);
            if (ts < cutoff) continue;
            e.msgs.set(m.id || j.uuid, { ts, model: m.model, u: m.usage, side: !!j.isSidechain });
          } catch {}
        }
      }
      e.offset = pos;
    } finally { fs.closeSync(fd); }
  }
  for (const [f, e] of files) {
    for (const [id, m] of e.msgs) if (m.ts < cutoff) e.msgs.delete(id);
    if (!e.msgs.size && !fs.existsSync(f)) files.delete(f);
  }
}

function tally(since) {
  const total = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, messages: 0 };
  const models = {};
  for (const e of files.values()) for (const m of e.msgs.values()) {
    if (m.ts < since) continue;
    const row = (models[m.model] ||= { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, messages: 0 });
    for (const t of [total, row]) {
      t.input += m.u.input_tokens || 0;
      t.output += m.u.output_tokens || 0;
      t.cacheWrite += m.u.cache_creation_input_tokens || 0;
      t.cacheRead += m.u.cache_read_input_tokens || 0;
      t.messages++;
    }
  }
  return { ...total, models };
}

function hourly(since) {
  const buckets = new Array(24).fill(0);
  for (const e of files.values()) for (const m of e.msgs.values()) {
    const i = Math.floor((m.ts - since) / 36e5);
    if (i >= 0 && i < 24) buckets[i] += (m.u.output_tokens || 0) + (m.u.input_tokens || 0) + (m.u.cache_creation_input_tokens || 0);
  }
  return buckets;
}

let scannedAt = 0;
function local(sessionStart) {
  if (Date.now() - scannedAt > 15_000) { try { scan(); } catch (e) { console.error('scan', e.message); } scannedAt = Date.now(); }
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const dayStart = Date.now() - 24 * 36e5;
  return {
    session: sessionStart ? tally(sessionStart) : null,
    today: tally(today.getTime()),
    week: tally(Date.now() - WEEK),
    hourly: { start: Math.floor(dayStart / 36e5) * 36e5 + 36e5, values: hourly(Math.floor(dayStart / 36e5) * 36e5 + 36e5) },
  };
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname !== cfg.BASE + '/api/usage' || req.method !== 'GET') { res.writeHead(404); return res.end(); }
  await getLimits(url.searchParams.has('force'));
  const fh = limits?.data?.five_hour;
  const sessionStart = fh?.resets_at ? Date.parse(fh.resets_at) - 5 * 36e5 : null;
  const body = JSON.stringify({
    plan: limits?.plan, tier: limits?.tier, limits: limits?.data || null,
    fetchedAt: limits ? limitsAt : null, error: limitsErr,
    local: local(sessionStart), now: Date.now(),
  });
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(body);
}).listen(PORT, cfg.HOST, () => console.log('orbit-usage on', cfg.HOST + ':' + PORT));
