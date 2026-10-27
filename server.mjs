// Orbit (Claude Code web client). Password login -> signed session cookie.
// <BASE>/ is a chat UI driven by the Agent SDK (one long-lived query per conversation,
// tool approvals relayed to the browser); <BASE>/terminal is a raw pty terminal.
// All paths/ports/origins come from config.mjs (see .env.example).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import pty from 'node-pty';
import { query, listSessions, getSessionMessages } from '@anthropic-ai/claude-agent-sdk';
import cfg from './config.mjs';
import * as monitor from './monitor.mjs';
import * as backups from './backups.mjs';
import * as fsapi from './fsapi.mjs';
import { explain } from './explain.mjs';

const PORT = cfg.PORTS.server;
const BASE = cfg.BASE;
const CWD = cfg.WORKDIR;
const CLAUDE_BIN = cfg.CLAUDE_BIN;
const DIR = path.dirname(fileURLToPath(import.meta.url));
if (!fs.existsSync(cfg.CONFIG_FILE)) {
  console.error(`\nOrbit is not set up yet: ${cfg.CONFIG_FILE} is missing.\nRun:  npm run setup\n`);
  process.exit(1);
}
const CONF = JSON.parse(fs.readFileSync(cfg.CONFIG_FILE, 'utf8')); // { passHash, salt }
const SESSION_TTL = 7 * 24 * 3600 * 1000;
const TMUX = 'orbit';
const MODES = ['default', 'acceptEdits', 'plan', 'auto'];
const UPLOAD_DIR = cfg.UPLOADS;
const UPLOAD_MAX = 100 * 1024 * 1024;
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

const QUICK_FILE = cfg.QUICK_FILE;
const QUICK_DEFAULTS = [
  { label: 'Health check', prompt: 'Give me a quick health check of this server: load, memory, disk, and any pm2 processes that are errored or restarting a lot.' },
  { label: 'pm2 status', prompt: 'Show pm2 status as a compact table (name, status, restarts, memory, uptime).' },
  { label: 'Recent errors', prompt: 'Look through the last hour of pm2 error logs and the nginx error log and summarize anything that matters.' },
  { label: 'Disk usage', prompt: 'Check disk usage and point out the biggest directories and anything that can be safely cleaned.' },
  { label: 'nginx sites', prompt: 'List the nginx sites, their domains, and what each one proxies to or serves.' },
  { label: '/compact', prompt: '/compact' },
].map((q, i) => ({ id: 'd' + i, send: true, ...q }));

function readQuick() {
  try { return JSON.parse(fs.readFileSync(QUICK_FILE, 'utf8')); } catch { return QUICK_DEFAULTS; }
}

const sessions = new Map(); // token -> expiry
const failures = new Map(); // ip -> { n, until }
const globalFails = []; // timestamps, caps brute force even if IPs rotate

function checkPassword(pw) {
  const sc = CONF.scrypt || { N: 16384, r: 8, p: 1, keylen: 64, maxmem: 128 * 1024 * 1024 };
  const expected = Buffer.from(CONF.passHash, 'hex');
  const hash = crypto.scryptSync(String(pw), CONF.salt, expected.length || sc.keylen, { N: sc.N, r: sc.r, p: sc.p, maxmem: sc.maxmem || 128 * 1024 * 1024 });
  return hash.length === expected.length && crypto.timingSafeEqual(hash, expected);
}

// Constant-time service-token check used by Orbit's own local processes (e.g. the push
// service) so they can talk to the server without any stored plaintext password.
function serviceAuthed(req) {
  const tok = req.headers['x-orbit-token'];
  if (!tok || !CONF.serviceToken) return false;
  const a = Buffer.from(String(tok)), b = Buffer.from(String(CONF.serviceToken));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function getCookie(req, name) {
  const m = (req.headers.cookie || '').match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return m ? m[1] : null;
}

function authed(req) {
  if (serviceAuthed(req)) return true;
  const t = getCookie(req, 'cw_sess');
  const exp = t && sessions.get(t);
  if (!exp) return false;
  if (exp < Date.now()) { sessions.delete(t); return false; }
  return true;
}

function clientIp(req) {
  return req.headers['cf-connecting-ip'] || req.headers['x-real-ip'] || req.socket.remoteAddress;
}

function send(res, code, body, type = 'text/html; charset=utf-8', extra = {}) {
  res.writeHead(code, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Robots-Tag': 'noindex',
    'Strict-Transport-Security': 'max-age=15552000; includeSubDomains',
    ...extra,
  });
  res.end(body);
}

const STATIC = {
  '/xterm.css': ['node_modules/@xterm/xterm/css/xterm.css', 'text/css'],
  '/xterm.js': ['node_modules/@xterm/xterm/lib/xterm.js', 'application/javascript'],
  '/addon-fit.js': ['node_modules/@xterm/addon-fit/lib/addon-fit.js', 'application/javascript'],
  '/addon-web-links.js': ['node_modules/@xterm/addon-web-links/lib/addon-web-links.js', 'application/javascript'],
  '/marked.js': ['node_modules/marked/lib/marked.umd.js', 'application/javascript'],
  '/purify.js': ['node_modules/dompurify/dist/purify.min.js', 'application/javascript'],
  '/app.js': ['public/app.js', 'application/javascript'],
  '/chat.js': ['public/chat.js', 'application/javascript'],
  '/chat.css': ['public/chat.css', 'text/css'],
  '/monitor.js': ['public/monitor.js', 'application/javascript'],
  '/sites.js': ['public/sites.js', 'application/javascript'],
  '/editor.js': ['public/editor.js', 'application/javascript'],
  // Side-service UI scripts: also served here so they load without nginx aliases.
  '/usage-widget.js': ['public/usage-widget.js', 'application/javascript'],
  '/skills-ui.js': ['public/skills-ui.js', 'application/javascript'],
  '/pwa-ui.js': ['public/pwa-ui.js', 'application/javascript'],
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  let p = url.pathname;
  if (!p.startsWith(BASE)) return send(res, 404, 'not found');
  p = p.slice(BASE.length) || '/';

  if (p === '/login' && req.method === 'POST') {
    const ip = clientIp(req);
    const f = failures.get(ip);
    if (globalFails.filter((t) => t > Date.now() - 15 * 60 * 1000).length >= 30 || (f && f.until > Date.now())) return send(res, 429, 'Too many attempts, try later.', 'text/plain');
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
    req.on('end', () => {
      const pw = new URLSearchParams(body).get('password') || '';
      if (checkPassword(pw)) {
        failures.delete(ip);
        const token = crypto.randomBytes(32).toString('hex');
        sessions.set(token, Date.now() + SESSION_TTL);
        return send(res, 302, '', 'text/plain', {
          'Set-Cookie': `cw_sess=${token}; Path=${BASE}; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_TTL / 1000}`,
          Location: BASE + '/',
        });
      }
      globalFails.push(Date.now()); if (globalFails.length > 100) globalFails.shift();
      const n = (f ? f.n : 0) + 1;
      failures.set(ip, { n, until: n >= 5 ? Date.now() + 15 * 60 * 1000 : 0 });
      console.log(`failed login from ${ip} (${n})`);
      setTimeout(() => send(res, 302, '', 'text/plain', { Location: BASE + '/?err=1' }), 800);
    });
    return;
  }

  if (p === '/logout') {
    const t = getCookie(req, 'cw_sess');
    if (t) sessions.delete(t);
    return send(res, 302, '', 'text/plain', {
      'Set-Cookie': `cw_sess=; Path=${BASE}; Max-Age=0`,
      Location: BASE + '/',
    });
  }

  if (p === '/' || p === '/terminal') {
    const page = !authed(req) ? 'login.html' : p === '/' ? 'chat.html' : 'terminal.html';
    return send(res, 200, fs.readFileSync(path.join(DIR, 'public', page)));
  }

  if (p === '/logo-mark.png') return send(res, 200, fs.readFileSync(path.join(DIR, 'public/logo-mark.png')), 'image/png', { 'Cache-Control': 'public, max-age=86400' });

  // Monaco editor library (public open-source files, no data) — workers fetch these without cookies
  if (p.startsWith('/vs/')) {
    const base = path.join(DIR, 'node_modules/monaco-editor/min');
    const file = path.normalize(path.join(base, p));
    if (!file.startsWith(base + '/') || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, 'not found', 'text/plain');
    const type = { '.js': 'application/javascript', '.css': 'text/css', '.ttf': 'font/ttf' }[path.extname(file)] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'private, max-age=604800' });
    return fs.createReadStream(file).pipe(res);
  }

  if (!authed(req)) return send(res, 404, 'not found', 'text/plain');

  const sameOrigin = cfg.originOk(req.headers.origin || '');
  const readJson = () => new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 65536) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
  });

  if (p === '/api/links') {
    if (req.method === 'GET') return send(res, 200, JSON.stringify(monitor.readLinks()), 'application/json');
    if (req.method !== 'PUT' || !sameOrigin) return send(res, 403, 'forbidden', 'text/plain');
    const list = await readJson();
    try { return send(res, 200, JSON.stringify(monitor.writeLinks(list)), 'application/json'); }
    catch { return send(res, 400, JSON.stringify({ error: 'Invalid link — use a full http(s) URL' }), 'application/json'); }
  }

  if (p.startsWith('/api/fs/') || p.startsWith('/api/changes')) {
    const json = (code, obj) => send(res, code, JSON.stringify(obj), 'application/json');
    try {
      if (req.method === 'GET') {
        const q = url.searchParams;
        if (p === '/api/fs/projects') {
          const sites = await backups.discover();
          const seen = new Set(), out = [];
          const add = (pth, label, group) => { if (!seen.has(pth) && fs.existsSync(pth)) { seen.add(pth); out.push({ path: pth, label, group }); } };
          for (const s of sites) for (const d of s.dirs) add(d.path, d.path.split('/').pop(), s.name);
          try { for (const d of fs.readdirSync('/var/www')) add('/var/www/' + d, d, 'Other folders in /var/www'); } catch {}
          add(CWD, 'workdir', 'Server'); add(DIR, 'orbit (install)', 'Server'); add('/etc/nginx', 'nginx', 'Server');
          return json(200, out);
        }
        if (p === '/api/fs/list') return json(200, fsapi.list(q.get('path')));
        if (p === '/api/fs/read') return json(200, fsapi.read(q.get('path')));
        if (p === '/api/changes') return json(200, fsapi.listChanges());
        if (p === '/api/changes/get') { const c = fsapi.getChange(q.get('id')); return c ? json(200, c) : json(404, { error: 'Not recorded — this edit happened before change tracking existed, or in the terminal' }); }
        return json(404, { error: 'not found' });
      }
      if (req.method !== 'POST' || !sameOrigin) return send(res, 403, 'forbidden', 'text/plain');
      const body = (await readJson()) || {};
      if (p === '/api/fs/write') return json(200, fsapi.write(body.path, body.content, body.baseMtime, body.force));
      if (p === '/api/fs/op') { const r = fsapi.op(body); console.log(`fs ${body.op} ${body.path}${body.to ? ' -> ' + body.to : ''} from web`); return json(200, r); }
      if (p === '/api/fs/stat') return json(200, fsapi.stat(body.paths));
      if (p === '/api/fs/search') return json(200, await fsapi.search(body));
      if (p === '/api/fs/replace') return json(200, fsapi.replace(body));
      if (p === '/api/changes/revert') return json(200, fsapi.revertChange(body.id, body.force));
      return json(404, { error: 'not found' });
    } catch (e) {
      const code = e instanceof fsapi.FsError ? e.code : e.code === 'ENOENT' ? 404 : e.code === 'EACCES' ? 403 : 500;
      return json(code, { error: e.code === 'ENOENT' ? 'Not found' : String(e.message || e), mtime: e.mtime });
    }
  }

  if (p === '/api/explain') {
    if (req.method !== 'POST' || !sameOrigin) return send(res, 403, 'forbidden', 'text/plain');
    const body = (await readJson()) || {};
    try { return send(res, 200, JSON.stringify(await explain({ tool: String(body.tool || '').slice(0, 80), input: body.input, request: body.request })), 'application/json'); }
    catch (e) { return send(res, 502, JSON.stringify({ error: String(e.message || e) }), 'application/json'); }
  }

  if (p === '/api/sites' && req.method === 'GET') {
    return send(res, 200, JSON.stringify(await backups.overview()), 'application/json');
  }

  if (p === '/api/sites/download') {
    const file = backups.archivePath(url.searchParams.get('site') || '', url.searchParams.get('file') || '');
    if (!file) return send(res, 404, 'not found', 'text/plain');
    const size = fs.statSync(file).size;
    res.writeHead(200, {
      'Content-Type': 'application/gzip', 'Content-Length': size, 'Cache-Control': 'no-store',
      'Content-Disposition': `attachment; filename="${path.basename(file)}"`, 'X-Robots-Tag': 'noindex',
    });
    return fs.createReadStream(file).pipe(res);
  }

  if (p.startsWith('/api/sites/')) {
    if (!sameOrigin || !['POST', 'PUT'].includes(req.method)) return send(res, 403, 'forbidden', 'text/plain');
    const body = (await readJson()) || {};
    const site = String(body.site || '');
    try {
      if (p === '/api/sites/backup') {
        const id = await backups.enqueue(site, body.type, { note: body.note || '' });
        console.log(`backup ${body.type} of ${site} queued from web`);
        return send(res, 200, JSON.stringify({ ok: true, id }), 'application/json');
      }
      if (p === '/api/sites/cancel') return send(res, 200, JSON.stringify({ ok: backups.cancel(site) }), 'application/json');
      if (p === '/api/sites/delete') {
        const ok = backups.deleteArchive(site, String(body.file || ''));
        if (ok) console.log(`deleted backup ${body.file} of ${site} from web`);
        return send(res, ok ? 200 : 404, JSON.stringify({ ok }), 'application/json');
      }
      if (p === '/api/sites/schedule') return send(res, 200, JSON.stringify({ ok: true, schedule: backups.setSchedule(site, String(body.schedule || 'off')) }), 'application/json');
    } catch (e) {
      return send(res, 400, JSON.stringify({ ok: false, error: String(e.message || e) }), 'application/json');
    }
    return send(res, 404, 'not found', 'text/plain');
  }

  if (p === '/api/pm2/logs') {
    const logs = monitor.processLogs(url.searchParams.get('name') || '', 150);
    return logs ? send(res, 200, JSON.stringify(logs), 'application/json') : send(res, 404, JSON.stringify({ error: 'Unknown process' }), 'application/json');
  }

  if (p === '/api/pm2/restart') {
    if (req.method !== 'POST' || !sameOrigin) return send(res, 403, 'forbidden', 'text/plain');
    const body = await readJson();
    const r = await monitor.restartProcess(String(body?.name || ''));
    console.log(`pm2 restart ${body?.name} from web: ${r.ok ? 'ok' : r.error}`);
    return send(res, r.ok ? 200 : 400, JSON.stringify(r), 'application/json');
  }

  if (p === '/api/sessions') {
    try {
      const list = await listSessions({ dir: CWD, limit: 60 });
      const out = list.map((s) => ({
        id: s.sessionId, title: s.customTitle || s.summary || s.firstPrompt || 'Untitled', at: s.lastModified,
        live: !!chats.get(s.sessionId)?.busy,
      }));
      return send(res, 200, JSON.stringify(out), 'application/json');
    } catch (e) {
      return send(res, 500, JSON.stringify({ error: String(e.message || e) }), 'application/json');
    }
  }

  if (p === '/api/upload' && req.method === 'POST') {
    if (!cfg.originOk(req.headers.origin || '')) return send(res, 403, 'forbidden', 'text/plain');
    const len = Number(req.headers['content-length'] || 0);
    if (len > UPLOAD_MAX) return send(res, 413, JSON.stringify({ error: 'File is larger than 100 MB' }), 'application/json');
    let name = 'file';
    try { name = decodeURIComponent(req.headers['x-file-name'] || 'file'); } catch {}
    name = path.basename(name).replace(/[^\w.\- ()+@]/g, '_').replace(/^\.+/, '').slice(0, 120) || 'file';
    const day = new Date().toISOString().slice(0, 10);
    const dir = path.join(UPLOAD_DIR, day);
    fs.mkdirSync(dir, { recursive: true });
    let dest = path.join(dir, name);
    for (let i = 1; fs.existsSync(dest); i++) {
      const ext = path.extname(name);
      dest = path.join(dir, `${path.basename(name, ext)}-${i}${ext}`);
    }
    const out = fs.createWriteStream(dest, { flags: 'wx' });
    let size = 0, failed = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > UPLOAD_MAX && !failed) { failed = true; req.unpipe(out); out.destroy(); fs.rmSync(dest, { force: true }); send(res, 413, JSON.stringify({ error: 'File is larger than 100 MB' }), 'application/json'); req.destroy(); }
    });
    req.pipe(out);
    out.on('finish', () => { if (!failed) send(res, 200, JSON.stringify({ path: dest, name: path.basename(dest), size }), 'application/json'); });
    out.on('error', () => { if (!failed) { failed = true; fs.rmSync(dest, { force: true }); send(res, 500, JSON.stringify({ error: 'Could not save the file' }), 'application/json'); } });
    req.on('aborted', () => { failed = true; out.destroy(); fs.rmSync(dest, { force: true }); });
    return;
  }

  if (p === '/api/quick') {
    if (req.method === 'GET') return send(res, 200, JSON.stringify(readQuick()), 'application/json');
    if (!['PUT', 'DELETE'].includes(req.method) || !cfg.originOk(req.headers.origin || '')) return send(res, 403, 'forbidden', 'text/plain');
    if (req.method === 'DELETE') { fs.rmSync(QUICK_FILE, { force: true }); return send(res, 200, JSON.stringify(QUICK_DEFAULTS), 'application/json'); }
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 65536) req.destroy(); });
    req.on('end', () => {
      try {
        const list = JSON.parse(body);
        if (!Array.isArray(list) || list.length > 60) throw new Error('bad list');
        const clean = list.map((q) => ({
          id: String(q.id || crypto.randomBytes(5).toString('hex')).slice(0, 24),
          label: String(q.label || '').trim().slice(0, 40),
          prompt: String(q.prompt || '').trim().slice(0, 4000),
          send: q.send !== false,
        })).filter((q) => q.prompt);
        fs.writeFileSync(QUICK_FILE, JSON.stringify(clean, null, 2));
        send(res, 200, JSON.stringify(clean), 'application/json');
      } catch {
        send(res, 400, JSON.stringify({ error: 'invalid' }), 'application/json');
      }
    });
    return;
  }

  if (STATIC[p]) {
    const [file, type] = STATIC[p];
    return send(res, 200, fs.readFileSync(path.join(DIR, file)), type);
  }

  send(res, 404, 'not found', 'text/plain');
});

// ---------- chat: one Agent SDK query per conversation, shared by every tab viewing it ----------

const chats = new Map(); // sessionId (or temp key until init) -> Chat

class Chat {
  constructor(resumeId, mode) {
    this.key = resumeId || 'new-' + crypto.randomBytes(6).toString('hex');
    this.sessionId = resumeId || null;
    this.clients = new Set();
    this.pending = new Map(); // permission id -> { tool, input, suggestions, resolve }
    this.queue = [];
    this.wake = null;
    this.busy = false;
    this.mode = MODES.includes(mode) ? mode : 'default';
    this.closed = false;
    this.idleTimer = null;
    chats.set(this.key, this);
    this.start(resumeId);
  }

  async *input() {
    while (!this.closed) {
      if (this.queue.length) { yield this.queue.shift(); continue; }
      await new Promise((r) => { this.wake = r; });
      this.wake = null;
    }
  }

  start(resumeId) {
    this.q = query({
      prompt: this.input(),
      options: {
        cwd: CWD,
        resume: resumeId || undefined,
        pathToClaudeCodeExecutable: CLAUDE_BIN,
        includePartialMessages: true,
        permissionMode: this.mode,
        canUseTool: (tool, input, opts) => this.askPermission(tool, input, opts),
        hooks: fsapi.sdkHooks(),
        stderr: (d) => process.stderr.write('[claude] ' + d),
      },
    });
    (async () => {
      try {
        for await (const m of this.q) this.onMessage(m);
      } catch (e) {
        if (!this.closed) this.broadcast({ type: 'error', message: String(e.message || e) });
      }
      this.busy = false;
      this.broadcast({ type: 'state', ...this.state(), ended: true });
      this.close();
    })();
  }

  onMessage(m) {
    if (m.type === 'system' && m.subtype === 'init') {
      if (!this.sessionId || this.sessionId !== m.session_id) {
        chats.delete(this.key);
        this.sessionId = this.key = m.session_id;
        chats.set(this.key, this);
      }
      if (m.permissionMode) this.mode = m.permissionMode;
      this.broadcast({ type: 'state', ...this.state() });
    }
    if (m.type === 'result') { this.busy = false; this.broadcast({ type: 'state', ...this.state() }); }
    if (m.type === 'system' && /^(task_|background_tasks_changed$)/.test(m.subtype || '')) {
      // remembered so a browser that opens this chat later can rebuild its background-task strip
      m = { ...m, _at: Date.now() };
      (this.taskLog ||= []).push(m);
      if (this.taskLog.length > 300) this.taskLog.splice(0, this.taskLog.length - 300);
    }
    this.broadcast({ type: 'msg', msg: m });
  }

  askPermission(tool, input, { signal, suggestions, decisionReason, title }) {
    return new Promise((resolve) => {
      const id = crypto.randomBytes(8).toString('hex');
      const done = (r) => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        this.broadcast({ type: 'permission_done', id });
        resolve(r);
      };
      this.pending.set(id, { tool, input, suggestions, reason: decisionReason || title, done });
      signal?.addEventListener('abort', () => done({ behavior: 'deny', message: 'Cancelled' }));
      this.broadcast({ type: 'permission', id, tool, input, reason: decisionReason || title, canAlways: !!suggestions?.length });
    });
  }

  answerPermission({ id, allow, always, answers, message }) {
    const p = this.pending.get(id);
    if (!p) return;
    if (!allow) return p.done({ behavior: 'deny', message: message || 'The user declined this action.' });
    const r = { behavior: 'allow', updatedInput: p.input };
    if (answers) r.updatedInput = { ...p.input, answers };
    if (always && p.suggestions?.length) r.updatedPermissions = p.suggestions;
    p.done(r);
    if (p.tool === 'ExitPlanMode' && this.mode === 'plan') this.setMode('default');
  }

  sendUser(text, images = []) {
    if (this.closed) return;
    this.busy = true;
    const content = images.length
      ? [...images.map((im) => ({ type: 'image', source: { type: 'base64', media_type: im.media_type, data: im.data } })), { type: 'text', text }]
      : text;
    this.queue.push({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null });
    this.wake?.();
    this.broadcast({ type: 'state', ...this.state() });
  }

  async setMode(mode) {
    if (!MODES.includes(mode)) return;
    try { await this.q.setPermissionMode(mode); this.mode = mode; }
    catch (e) { this.broadcast({ type: 'error', message: 'Mode change failed: ' + (e.message || e) }); }
    this.broadcast({ type: 'state', ...this.state() });
  }

  async interrupt() {
    for (const p of this.pending.values()) p.done({ behavior: 'deny', message: 'Interrupted by user', interrupt: true });
    try { await this.q.interrupt(); } catch {}
  }

  state() { return { sessionId: this.sessionId, busy: this.busy, mode: this.mode, live: !this.closed }; }

  async stopTask(id) {
    try { await this.q.stopTask(String(id)); }
    catch (e) { this.broadcast({ type: 'error', message: 'Could not stop the task: ' + (e.message || e) }); }
  }

  attach(ws) {
    clearTimeout(this.idleTimer);
    this.clients.add(ws);
    ws.send(JSON.stringify({ type: 'state', ...this.state() }));
    for (const [id, p] of this.pending) ws.send(JSON.stringify({ type: 'permission', id, tool: p.tool, input: p.input, reason: p.reason, canAlways: !!p.suggestions?.length }));
    for (const msg of this.taskLog || []) ws.send(JSON.stringify({ type: 'msg', msg }));
  }

  detach(ws) {
    this.clients.delete(ws);
    // keep a running turn alive without viewers; free idle processes after a while
    if (!this.clients.size) this.idleTimer = setTimeout(() => { if (!this.clients.size && !this.busy && !this.pending.size) this.close(); }, 20 * 60 * 1000);
  }

  broadcast(obj) {
    const s = JSON.stringify(obj);
    for (const ws of this.clients) if (ws.readyState === 1) ws.send(s);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.wake?.();
    try { this.q.close?.(); } catch {}
    if (chats.get(this.key) === this) chats.delete(this.key);
  }
}

async function loadHistory(sessionId) {
  try { return await getSessionMessages(sessionId, { dir: CWD }); } catch { return []; }
}

// ---------- websockets ----------

const wss = new WebSocketServer({ noServer: true, maxPayload: 48 << 20 });

server.on('upgrade', (req, socket, head) => {
  const origin = req.headers.origin || '';
  if (![BASE + '/ws', BASE + '/chat-ws'].includes(req.url) || !authed(req) || !cfg.originOk(origin)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => (req.url === BASE + '/ws' ? terminalSocket(ws) : chatSocket(ws)));
});

function chatSocket(ws) {
  let chat = null;
  let unsubscribe = null;
  const leave = () => { if (chat) chat.detach(ws); chat = null; };
  ws.on('close', () => unsubscribe?.());
  ws.on('message', async (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (m.type === 'monitor') {
      if (!unsubscribe) unsubscribe = monitor.subscribe((msg) => { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); });
      ws.send(JSON.stringify(monitor.snapshot()));
      monitor.poke();
      return;
    }
    if (m.type === 'open') {
      leave();
      if (m.sessionId && !/^[0-9a-f-]{36}$/.test(m.sessionId)) return;
      if (m.sessionId) {
        ws.send(JSON.stringify({ type: 'history', sessionId: m.sessionId, messages: await loadHistory(m.sessionId) }));
        chat = chats.get(m.sessionId) || null;
        if (chat) chat.attach(ws);
        else ws.send(JSON.stringify({ type: 'state', sessionId: m.sessionId, busy: false, mode: 'default' }));
      } else {
        ws.send(JSON.stringify({ type: 'history', sessionId: null, messages: [] }));
        ws.send(JSON.stringify({ type: 'state', sessionId: null, busy: false, mode: m.mode || 'default' }));
      }
      ws.sessionId = m.sessionId || null;
      return;
    }
    if (m.type === 'send') {
      const images = (Array.isArray(m.images) ? m.images : []).slice(0, 20)
        .filter((im) => IMAGE_TYPES.includes(im.media_type) && typeof im.data === 'string' && im.data.length < 8 << 20)
        .map((im) => ({ media_type: im.media_type, data: im.data }));
      let text = String(m.text || '').slice(0, 200000);
      if (!text.trim() && !images.length) return;
      if (!text.trim()) text = images.length > 1 ? 'Here are some images.' : 'Here is an image.';
      if (!chat || chat.closed) {
        chat = new Chat(ws.sessionId, m.mode);
        chat.attach(ws);
      }
      chat.sendUser(text, images);
      return;
    }
    if (!chat) return;
    if (m.type === 'permission') chat.answerPermission(m);
    if (m.type === 'interrupt') chat.interrupt();
    if (m.type === 'mode') chat.setMode(m.mode);
    if (m.type === 'stop_task' && typeof m.taskId === 'string' && m.taskId.length < 100) chat.stopTask(m.taskId);
  });
  ws.on('close', leave);
}

// One tmux session shared by every browser tab, so closing the tab doesn't kill Claude.
function ensureTmux() {
  try { execFileSync('tmux', ['has-session', '-t', TMUX], { stdio: 'ignore' }); }
  catch {
    execFileSync('tmux', ['new-session', '-d', '-s', TMUX, '-x', '200', '-y', '50', '-c', CWD,
      'bash', '-lc', 'claude; exec bash -l'], { env: { ...process.env, TERM: 'xterm-256color' } });
    execFileSync('tmux', ['set', '-t', TMUX, 'mouse', 'on']);
    execFileSync('tmux', ['set', '-t', TMUX, 'status', 'off']);
    execFileSync('tmux', ['set', '-t', TMUX, 'history-limit', '50000']);
  }
}

function terminalSocket(ws) {
  ensureTmux();
  const term = pty.spawn('tmux', ['attach-session', '-t', TMUX], {
    name: 'xterm-256color', cols: 120, rows: 40, cwd: CWD,
    env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
  });
  term.onData((d) => { if (ws.readyState === 1) ws.send(d); });
  term.onExit(() => ws.close());
  ws.on('message', (msg) => {
    const s = msg.toString();
    // control messages are JSON prefixed with \x00; everything else is keyboard input
    if (s[0] === '\x00') {
      try {
        const m = JSON.parse(s.slice(1));
        if (m.type === 'resize') term.resize(Math.max(20, m.cols | 0), Math.max(5, m.rows | 0));
        if (m.type === 'restart') execFile('tmux', ['kill-session', '-t', TMUX], () => ws.close());
      } catch {}
      return;
    }
    term.write(s);
  });
  ws.on('close', () => term.kill());
}

monitor.start();
backups.init(monitor.broadcast);
fsapi.init(monitor.broadcast);
server.listen(PORT, cfg.HOST, () => console.log(`Orbit server on ${cfg.HOST}:${PORT}${BASE}`));
