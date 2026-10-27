// Orbit push service (pm2 orbit-push, 127.0.0.1:3024).
// Web Push (VAPID) to the Orbit Home Screen app / browsers, fed by:
//  - Orbit chats: logs in to Orbit locally and attaches to busy chats over the chat socket, like a browser tab,
//    so it sees approval requests and "finished" without changing or restarting claude-web.
//    It detaches as soon as a chat goes idle, so Orbit's 20-minute idle close still works.
//  - Server alerts: its own light checks (sites every 60s, pm2 every 60s, disk every 5 min).
// nginx puts /claude/api/push/ behind the Orbit login; writes also need an allowed Origin (ORBIT_ORIGINS).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import webpush from 'web-push';
import { WebSocket } from 'ws';
import { readLinks } from './monitor.mjs';

import cfg from './config.mjs';
const PORT = cfg.PORTS.push;
const B = cfg.BASE;
const ORBIT = cfg.SERVER_URL;
const DIR = path.dirname(new URL(import.meta.url).pathname);
const STORE = cfg.PUSH_FILE;
const SVC = (() => { try { return JSON.parse(fs.readFileSync(cfg.CONFIG_FILE, 'utf8')).serviceToken || ''; } catch { return ''; } })();
const AUTH = { 'x-orbit-token': SVC };
const DEFAULT_PREFS = { approval: true, finished: true, alerts: true };

// ---------- storage ----------
let db = { vapid: null, subs: [] };
try { db = JSON.parse(fs.readFileSync(STORE, 'utf8')); } catch {}
if (!db.vapid) db.vapid = webpush.generateVAPIDKeys();
db.subs ||= [];
const save = () => { const t = STORE + '.tmp'; fs.writeFileSync(t, JSON.stringify(db, null, 2), { mode: 0o600 }); fs.renameSync(t, STORE); };
save();
webpush.setVapidDetails('mailto:' + cfg.PUSH_EMAIL, db.vapid.publicKey, db.vapid.privateKey);

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const short = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

// ---------- sending ----------
const presence = new Map(); // sessionId -> last time some device said it's looking at it
const recent = new Map(); // dedupe key -> time
const history = []; // last notifications (for the settings panel)

async function notify(kind, payload, { session = null, dedupe = null, dedupeMs = 60e3 } = {}) {
  if (session && Date.now() - (presence.get(session) || 0) < 25e3) return log('skip (being viewed)', kind, payload.title);
  if (dedupe) { if (Date.now() - (recent.get(dedupe) || 0) < dedupeMs) return; recent.set(dedupe, Date.now()); }
  const pref = kind === 'approval' ? 'approval' : kind === 'finished' || kind === 'error' ? 'finished' : kind === 'test' ? null : 'alerts';
  const body = JSON.stringify({ ...payload, kind, at: Date.now(), badge: pendingCount() });
  history.unshift({ kind, title: payload.title, body: payload.body, at: Date.now() }); history.length = Math.min(history.length, 30);
  const targets = db.subs.filter((s) => !pref || s.prefs?.[pref] !== false).filter((s) => !payload.only || s.endpoint === payload.only);
  log('push', kind, JSON.stringify(payload.title), '->', targets.length);
  let changed = false;
  await Promise.all(targets.map(async (s) => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, body, { TTL: kind === 'approval' ? 3600 : 6 * 3600, urgency: kind === 'approval' || kind === 'alert' ? 'high' : 'normal' });
      s.lastOk = Date.now(); s.fails = 0; changed = true;
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) { s.dead = true; log('subscription gone', s.device); }
      else { s.fails = (s.fails || 0) + 1; log('push failed', s.device, e.statusCode || e.message); }
      changed = true;
    }
  }));
  if (changed) { db.subs = db.subs.filter((s) => !s.dead && (s.fails || 0) < 20); save(); }
}

// ---------- Orbit chat watcher ----------
let cookie = null, lastLogin = 0;
async function login() {
  if (!SVC) { if (Date.now() - lastLogin > 60e3) { lastLogin = Date.now(); log('no service token in config.json — run npm run setup'); } return false; }
  cookie = true; // sentinel: authenticated via the service-token header
  return true;
}

const watched = new Map(); // sessionId -> watcher
const titles = new Map();
function pendingCount() { let n = 0; for (const w of watched.values()) n += w.pending.size; return n; }

function plain(tool, input = {}) {
  const base = (p) => String(p || '').split('/').pop();
  switch (tool) {
    case 'Bash': return `Run: ${short(input.description || input.command, 110)}`;
    case 'Edit': case 'MultiEdit': return `Edit ${base(input.file_path)}`;
    case 'Write': return `Write ${base(input.file_path)}`;
    case 'NotebookEdit': return `Edit notebook ${base(input.notebook_path)}`;
    case 'WebFetch': return `Open ${short(input.url, 90)}`;
    case 'WebSearch': return `Search the web: ${short(input.query, 90)}`;
    case 'AskUserQuestion': return short(input.questions?.[0]?.question || 'Claude has a question for you', 140);
    case 'ExitPlanMode': return 'The plan is ready for your review';
    default: return tool.startsWith('mcp__') ? `Use ${tool.split('__').slice(1).join(' ')}` : `Use ${tool}`;
  }
}
const approvalTitle = (tool) => tool === 'AskUserQuestion' ? 'Claude has a question' : tool === 'ExitPlanMode' ? 'Plan ready' : 'Claude needs your OK';

function attach(id) {
  if (watched.has(id) || !cookie) return;
  const w = { id, ws: null, busy: false, sawBusy: false, pending: new Map(), lastText: '', idleTimer: null, opened: Date.now() };
  watched.set(id, w);
  const ws = new WebSocket(cfg.SERVER_URL.replace(/^http/, 'ws') + '/chat-ws', { headers: { ...AUTH, Origin: cfg.INTERNAL_ORIGIN }, maxPayload: 64 << 20 });
  w.ws = ws;
  const url = B + '/#/s/' + id;
  const title = () => short(titles.get(id) || 'Chat', 60);
  const maybeDetach = () => {
    clearTimeout(w.idleTimer);
    if (w.busy || w.pending.size) return;
    w.idleTimer = setTimeout(() => { if (!w.busy && !w.pending.size) ws.close(); }, 4000);
  };
  ws.on('open', () => ws.send(JSON.stringify({ type: 'open', sessionId: id })));
  ws.on('unexpected-response', (_req, res) => { log('ws refused', res.statusCode); if (res.statusCode === 401) cookie = null; watched.delete(id); });
  ws.on('error', (e) => log('ws error', e.message));
  ws.on('close', () => { clearTimeout(w.idleTimer); if (watched.get(id) === w) watched.delete(id); });
  ws.on('message', (raw) => {
    if (raw.length > 2e6) return; // history dumps
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.type === 'state' && (!m.sessionId || m.sessionId === id)) {
      if (m.busy) { w.busy = true; w.sawBusy = true; clearTimeout(w.idleTimer); return; }
      const was = w.busy; w.busy = false;
      if (was && w.sawBusy) {
        if (w.errored) notify('error', { title: 'Claude stopped with an error', body: `${title()}: ${short(w.errored, 140)}`, url, tag: 'chat-' + id }, { session: id });
        else notify('finished', { title: 'Claude finished', body: `${title()}: ${short(w.lastText || 'Reply is ready.', 160)}`, url, tag: 'chat-' + id }, { session: id, dedupe: 'fin-' + id, dedupeMs: 5000 });
        w.errored = null; w.lastText = '';
      }
      maybeDetach();
      return;
    }
    if (m.type === 'permission') {
      if (w.pending.has(m.id)) return;
      w.pending.set(m.id, m.tool);
      notify('approval', { title: approvalTitle(m.tool), body: `${title()}: ${plain(m.tool, m.input)}`, url, tag: 'approval-' + id }, { session: id, dedupe: 'perm-' + m.id, dedupeMs: 3600e3 });
      return;
    }
    if (m.type === 'permission_done') { w.pending.delete(m.id); maybeDetach(); return; }
    if (m.type === 'error') { w.errored = m.message || 'Error'; return; }
    if (m.type === 'msg' && m.msg) {
      const s = m.msg;
      if (s.type === 'assistant') {
        const t = (s.message?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join(' ').trim();
        if (t) w.lastText = t.replace(/[#*_`>|-]+/g, ' ');
      } else if (s.type === 'result') {
        if (s.is_error || (s.subtype && s.subtype !== 'success')) w.errored = s.result || s.subtype;
        else if (s.result) w.lastText = String(s.result).replace(/[#*_`>|-]+/g, ' ');
      }
    }
  });
}

let polling = false;
async function pollSessions() {
  if (polling || !db.subs.length) return;
  polling = true;
  try {
    if (!cookie && !(await login())) return;
    const r = await fetch(ORBIT + '/api/sessions', { headers: AUTH, redirect: 'manual' });
    if (r.status !== 200) { await r.arrayBuffer().catch(() => {}); cookie = null; return; }
    const list = await r.json();
    for (const s of list) {
      titles.set(s.id, s.title);
      if (s.live) attach(s.id);
    }
  } catch (e) { log('poll error', e.message); }
  finally { polling = false; }
}
setInterval(pollSessions, 4000);

// ---------- server alerts ----------
const siteState = new Map(); // url -> { ok, fails }
async function checkSites() {
  if (!db.subs.length) return;
  let links = [];
  try { links = readLinks(); } catch { return; }
  await Promise.all(links.map(async (l) => {
    let ok = false, code = 0, err = '';
    try {
      const r = await fetch(l.url, { redirect: 'follow', signal: AbortSignal.timeout(12000), headers: { 'User-Agent': 'orbit-push/1.0' } });
      await r.arrayBuffer().catch(() => {});
      code = r.status; ok = r.status < 500;
    } catch (e) { err = e.cause?.code || e.name || 'error'; }
    const st = siteState.get(l.url);
    if (!st) { siteState.set(l.url, { ok, fails: ok ? 0 : 2 }); return; } // first look: remember, don't alert
    if (ok) {
      if (!st.ok && st.fails >= 2) notify('alert', { title: `${l.label} is back up`, body: `${l.url} answers again (${code}).`, url: B + '/#/monitor', tag: 'site-' + l.url });
      st.ok = true; st.fails = 0;
    } else {
      st.fails++;
      if (st.fails === 2 && st.ok) { st.ok = false; notify('alert', { title: `${l.label} is down`, body: `${l.url} ${code ? 'returns ' + code : 'is not reachable (' + err + ')'} for over a minute.`, url: B + '/#/monitor', tag: 'site-' + l.url }); }
    }
  }));
}
setInterval(checkSites, 60e3);
setTimeout(checkSites, 5000);

const procState = new Map(); // name -> { status, restarts, at }
function checkPm2() {
  if (!db.subs.length) return;
  execFile('pm2', ['jlist'], { maxBuffer: 32 << 20, timeout: 20000 }, (err, out) => {
    if (err) return;
    let list; try { list = JSON.parse(out); } catch { return; }
    for (const p of list) {
      const name = p.name, status = p.pm2_env.status, restarts = p.pm2_env.restart_time || 0;
      const prev = procState.get(name);
      procState.set(name, { status, restarts, at: Date.now() });
      if (!prev) continue;
      if (status === 'errored' && prev.status !== 'errored') notify('alert', { title: `${name} crashed`, body: `pm2 marked ${name} as errored. Open Monitor to see its logs.`, url: B + '/#/monitor', tag: 'pm2-' + name });
      else if (restarts - prev.restarts >= 3) notify('alert', { title: `${name} keeps restarting`, body: `${restarts - prev.restarts} restarts in the last minute.`, url: B + '/#/monitor', tag: 'pm2-' + name }, { dedupe: 'loop-' + name, dedupeMs: 30 * 60e3 });
      else if (status === 'online' && prev.status === 'errored') notify('alert', { title: `${name} is running again`, body: 'pm2 shows it online.', url: B + '/#/monitor', tag: 'pm2-' + name });
    }
  });
}
setInterval(checkPm2, 60e3);
setTimeout(checkPm2, 8000);

let diskHigh = false;
function checkDisk() {
  if (!db.subs.length) return;
  fs.statfs('/', (err, s) => {
    if (err) return;
    const pct = Math.round((1 - s.bavail / s.blocks) * 100);
    if (pct >= 90 && !diskHigh) { diskHigh = true; notify('alert', { title: `Disk is ${pct}% full`, body: 'Free some space soon: logs, old backups or caches.', url: B + '/#/monitor', tag: 'disk' }); }
    if (pct < 85) diskHigh = false;
  });
}
setInterval(checkDisk, 5 * 60e3);
setTimeout(checkDisk, 10000);


// ---------- sidebar actions: stop / delete / restore a chat (POST /claude/api/chats/*) ----------
const PROJECT_DIR = cfg.projectDirFor();
const CHAT_TRASH = path.join(cfg.TRASH, 'sessions');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Attach like a browser tab, decline any waiting approvals, interrupt, wait until idle.
async function stopChat(id) {
  if (!cookie && !(await login())) throw new Error('Could not log in to Orbit');
  return new Promise((resolve) => {
    const ws = new WebSocket(cfg.SERVER_URL.replace(/^http/, 'ws') + '/chat-ws', { headers: { ...AUTH, Origin: cfg.INTERNAL_ORIGIN }, maxPayload: 64 << 20 });
    const out = { wasBusy: false, declined: 0, stopped: false };
    let interrupted = false, settleTimer = null;
    const finish = () => { clearTimeout(settleTimer); clearTimeout(hard); try { ws.close(); } catch {} resolve(out); };
    const hard = setTimeout(finish, 12000);
    ws.on('unexpected-response', (_q, res) => { if (res.statusCode === 401) cookie = null; finish(); });
    ws.on('error', finish);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'open', sessionId: id })));
    ws.on('message', (raw) => {
      if (raw.length > 2e6) return;
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (m.type === 'permission') { out.declined++; ws.send(JSON.stringify({ type: 'permission', id: m.id, allow: false, message: 'Stopped from the Orbit sidebar.' })); return; }
      if (m.type !== 'state' || (m.sessionId && m.sessionId !== id)) return;
      if (m.busy) {
        out.wasBusy = true;
        if (!interrupted) { interrupted = true; setTimeout(() => ws.send(JSON.stringify({ type: 'interrupt' })), 150); }
        return;
      }
      if (out.wasBusy) out.stopped = true;
      clearTimeout(settleTimer);
      settleTimer = setTimeout(finish, out.wasBusy ? 300 : 700); // give replayed approvals a moment to arrive
    });
  });
}

async function deleteChat(id) {
  const info = (await sessionInfo(id)) || {};
  let stop = null;
  if (info.live) stop = await stopChat(id);
  const stamp = Date.now();
  const dest = path.join(CHAT_TRASH, `${id}-${stamp}`);
  fs.mkdirSync(dest, { recursive: true });
  let moved = 0;
  for (const name of [id + '.jsonl', id]) {
    const src = path.join(PROJECT_DIR, name);
    if (fs.existsSync(src)) { fs.renameSync(src, path.join(dest, name)); moved++; }
  }
  if (!moved) { fs.rmSync(dest, { recursive: true, force: true }); throw Object.assign(new Error('That chat is already gone.'), { code: 404 }); }
  fs.writeFileSync(path.join(dest, 'meta.json'), JSON.stringify({ id, title: info.title || null, deletedAt: stamp }, null, 2));
  watched.get(id)?.ws?.close();
  log('deleted chat', id, JSON.stringify(info.title || ''));
  return { token: `${id}-${stamp}`, stop };
}

function restoreChat(token) {
  if (!/^[0-9a-f-]{36}-\d{10,14}$/.test(token)) throw new Error('Bad token');
  const dir = path.join(CHAT_TRASH, token), id = token.slice(0, 36);
  if (!fs.existsSync(dir)) throw Object.assign(new Error('Nothing to restore.'), { code: 404 });
  for (const name of [id + '.jsonl', id]) {
    const src = path.join(dir, name), dst = path.join(PROJECT_DIR, name);
    if (fs.existsSync(src) && !fs.existsSync(dst)) fs.renameSync(src, dst);
  }
  fs.rmSync(dir, { recursive: true, force: true });
  log('restored chat', id);
  return { id };
}

async function sessionInfo(id) {
  if (!cookie && !(await login())) return null;
  try {
    const r = await fetch(ORBIT + '/api/sessions', { headers: AUTH, redirect: 'manual' });
    if (r.status !== 200) { await r.arrayBuffer().catch(() => {}); cookie = null; return null; }
    return (await r.json()).find((s) => s.id === id) || null;
  } catch { return null; }
}

// ---------- http ----------
const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
async function readBody(req) {
  let s = '';
  for await (const c of req) { s += c; if (s.length > 16384) throw new Error('too large'); }
  return s ? JSON.parse(s) : {};
}
const pub = (s) => ({ id: s.id, device: s.device, prefs: { ...DEFAULT_PREFS, ...s.prefs }, createdAt: s.createdAt, lastOk: s.lastOk || null });

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const route = u.pathname.replace(/^\/claude\/api\/push\/?/, '/');
  try {
    if (req.method !== 'GET' && !cfg.originOk(req.headers.origin || '')) return json(res, 403, { error: 'Bad origin' });
    if (u.pathname.startsWith(B + '/api/chats/')) {
      if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
      const b = await readBody(req);
      const action = u.pathname.slice(B + '/api/chats/'.length);
      if (action === 'restore') return json(res, 200, restoreChat(String(b.token || '')));
      const id = String(b.id || '');
      if (!UUID.test(id)) return json(res, 400, { error: 'Bad chat id' });
      if (action === 'stop') return json(res, 200, await stopChat(id));
      if (action === 'delete') return json(res, 200, await deleteChat(id));
      return json(res, 404, { error: 'Not found' });
    }
    if (req.method === 'GET' && route === '/') {
      const ep = u.searchParams.get('endpoint');
      const me = ep ? db.subs.find((s) => s.endpoint === ep) : null;
      return json(res, 200, { publicKey: db.vapid.publicKey, me: me ? pub(me) : null, devices: db.subs.map(pub), recent: history.slice(0, 10), watching: [...watched.keys()].length });
    }
    if (req.method === 'POST' && route === '/subscribe') {
      const b = await readBody(req);
      const sub = b.subscription;
      if (!sub?.endpoint || !/^https:\/\//.test(sub.endpoint) || !sub.keys?.p256dh || !sub.keys?.auth) return json(res, 400, { error: 'Bad subscription' });
      let s = db.subs.find((x) => x.endpoint === sub.endpoint);
      if (!s) { s = { id: crypto.randomBytes(6).toString('hex'), endpoint: sub.endpoint, keys: sub.keys, createdAt: Date.now(), prefs: { ...DEFAULT_PREFS } }; db.subs.push(s); }
      s.keys = sub.keys;
      s.device = short(b.device || 'Device', 40);
      if (b.prefs) s.prefs = { ...DEFAULT_PREFS, ...s.prefs, ...pickPrefs(b.prefs) };
      save();
      pollSessions();
      return json(res, 200, { ok: true, me: pub(s) });
    }
    if (req.method === 'POST' && route === '/prefs') {
      const b = await readBody(req);
      const s = db.subs.find((x) => x.endpoint === b.endpoint);
      if (!s) return json(res, 404, { error: 'This device is not subscribed' });
      s.prefs = { ...DEFAULT_PREFS, ...s.prefs, ...pickPrefs(b.prefs || {}) };
      save();
      return json(res, 200, { ok: true, me: pub(s) });
    }
    if (req.method === 'POST' && route === '/unsubscribe') {
      const b = await readBody(req);
      const before = db.subs.length;
      db.subs = db.subs.filter((x) => x.endpoint !== b.endpoint && x.id !== b.id);
      save();
      return json(res, 200, { ok: true, removed: before - db.subs.length });
    }
    if (req.method === 'POST' && route === '/test') {
      const b = await readBody(req);
      const s = db.subs.find((x) => x.endpoint === b.endpoint);
      if (!s) return json(res, 404, { error: 'This device is not subscribed' });
      await notify('test', { title: 'Orbit notifications are on', body: 'You\'ll hear from Orbit when Claude needs your OK, finishes a reply, or a site goes down.', url: B + '/', tag: 'test', only: s.endpoint });
      return json(res, 200, { ok: true, lastOk: s.lastOk || null });
    }
    if (req.method === 'POST' && route === '/presence') {
      const b = await readBody(req);
      if (b.visible && /^[0-9a-f-]{36}$/.test(b.sessionId || '')) presence.set(b.sessionId, Date.now());
      else if (b.sessionId) presence.delete(b.sessionId);
      return json(res, 200, { ok: true });
    }
    json(res, 404, { error: 'Not found' });
  } catch (e) { json(res, e.code === 404 ? 404 : 400, { error: e.message }); }
}).listen(PORT, '127.0.0.1', () => log('orbit-push on', PORT));

function pickPrefs(p) {
  const out = {};
  for (const k of Object.keys(DEFAULT_PREFS)) if (typeof p[k] === 'boolean') out[k] = p[k];
  return out;
}
