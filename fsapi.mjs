// File API for the project editor, plus a record of every file Claude edits
// (before/after content captured by PreToolUse/PostToolUse hooks) for the diff viewer.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import cfg from './config.mjs';

const MAX_READ = 4 * 1024 * 1024;
const MAX_CHANGE_CONTENT = 2 * 1024 * 1024;
const TRASH = cfg.TRASH;
const CHANGES_DIR = cfg.CHANGES_DIR;
const FORBIDDEN = /^\/(proc|sys|dev|run)(\/|$)/;
const SKIP_DIRS = ['node_modules', '.git', '.next', '.turbo', '.cache', 'dist', 'build', '.pnpm-store', 'coverage'];

let emit = () => {};
export function init(emitFn) {
  emit = emitFn;
  fs.mkdirSync(CHANGES_DIR, { recursive: true });
  loadChanges();
}

export class FsError extends Error { constructor(code, msg) { super(msg); this.code = code; } }

export function clean(p, { write = false } = {}) {
  if (typeof p !== 'string' || !p.startsWith('/')) throw new FsError(400, 'Use an absolute path');
  const r = path.resolve(p);
  if (FORBIDDEN.test(r)) throw new FsError(403, 'That location is off-limits');
  if (write && (r === '/' || /^\/(bin|sbin|lib|lib64|usr|boot)(\/|$)/.test(r))) throw new FsError(403, 'System folders are read-only here');
  return r;
}

export function list(dir) {
  dir = clean(dir);
  const entries = fs.readdirSync(dir, { withFileTypes: true }).map((e) => {
    const full = path.join(dir, e.name);
    let st = null, isDir = e.isDirectory(), link = e.isSymbolicLink();
    try { st = fs.statSync(full); if (link) isDir = st.isDirectory(); } catch {}
    return { name: e.name, dir: isDir, link, size: st && !isDir ? st.size : 0, mtime: st ? st.mtimeMs : 0, heavy: isDir && SKIP_DIRS.includes(e.name) };
  });
  entries.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  return { path: dir, entries };
}

function isBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

export function read(p) {
  p = clean(p);
  const st = fs.statSync(p);
  if (st.isDirectory()) throw new FsError(400, 'That is a folder');
  let writable = true;
  try { fs.accessSync(p, fs.constants.W_OK); } catch { writable = false; }
  if (st.size > MAX_READ) return { path: p, mtime: st.mtimeMs, size: st.size, tooLarge: true, content: '', writable: false };
  const buf = fs.readFileSync(p);
  if (isBinary(buf)) return { path: p, mtime: st.mtimeMs, size: st.size, binary: true, content: '', writable: false };
  return { path: p, mtime: st.mtimeMs, size: st.size, content: buf.toString('utf8'), writable };
}

export function write(p, content, baseMtime, force) {
  p = clean(p, { write: true });
  if (typeof content !== 'string') throw new FsError(400, 'Nothing to save');
  let mode = 0o644, exists = false;
  try {
    const st = fs.statSync(p);
    exists = true; mode = st.mode & 0o7777;
    if (!force && baseMtime && Math.abs(st.mtimeMs - baseMtime) > 1) {
      const e = new FsError(409, 'The file changed on disk since you opened it'); e.mtime = st.mtimeMs; throw e;
    }
  } catch (e) { if (e instanceof FsError) throw e; }
  // write next to the file, then rename: never leaves a half-written file behind
  const tmp = path.join(path.dirname(p), `.${path.basename(p)}.cw-${crypto.randomBytes(4).toString('hex')}`);
  fs.writeFileSync(tmp, content, { mode });
  if (exists) { try { const st = fs.statSync(p); fs.chownSync(tmp, st.uid, st.gid); } catch {} }
  fs.renameSync(tmp, p);
  return { path: p, mtime: fs.statSync(p).mtimeMs };
}

export function op({ op, path: p, to }) {
  p = clean(p, { write: true });
  switch (op) {
    case 'create': {
      if (fs.existsSync(p)) throw new FsError(409, 'A file with that name already exists');
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, '', { flag: 'wx' });
      return { path: p };
    }
    case 'mkdir': {
      if (fs.existsSync(p)) throw new FsError(409, 'That already exists');
      fs.mkdirSync(p, { recursive: true });
      return { path: p };
    }
    case 'rename': {
      const dest = clean(to, { write: true });
      if (fs.existsSync(dest)) throw new FsError(409, 'Something with that name already exists');
      fs.renameSync(p, dest);
      return { path: dest };
    }
    case 'delete': {
      // into a trash folder rather than gone for good
      fs.mkdirSync(TRASH, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const dest = path.join(TRASH, `${stamp}__${p.replace(/\//g, '__')}`);
      try { fs.renameSync(p, dest); }
      catch (e) { if (e.code !== 'EXDEV') throw e; fs.cpSync(p, dest, { recursive: true }); fs.rmSync(p, { recursive: true, force: true }); }
      return { path: p, trash: dest };
    }
  }
  throw new FsError(400, 'Unknown operation');
}

export function stat(paths) {
  const out = {};
  for (const p of (paths || []).slice(0, 100)) {
    try { out[p] = fs.statSync(clean(p)).mtimeMs; } catch { out[p] = null; }
  }
  return out;
}

// ---------- search / replace across a project ----------

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

export function search({ root, query, regex, caseSensitive, include }) {
  root = clean(root);
  if (!query) return Promise.resolve({ results: [], truncated: false });
  const args = ['-rnI', '--color=never', '-m', '200'];
  for (const d of SKIP_DIRS) args.push('--exclude-dir=' + d);
  args.push('--exclude=*.min.js', '--exclude=*.map', '--exclude=*.lock', '--exclude=package-lock.json', '--exclude=pnpm-lock.yaml');
  if (include) for (const g of String(include).split(',').map((x) => x.trim()).filter(Boolean)) args.push('--include=' + g);
  if (!caseSensitive) args.push('-i');
  args.push(regex ? '-E' : '-F', '-e', query, root);
  return new Promise((resolve) => {
    const p = spawn('nice', ['-n', '10', 'grep', ...args]);
    const files = new Map();
    let buf = '', count = 0, truncated = false;
    const LIMIT = 2000;
    p.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        const m = line.match(/^(.*?):(\d+):(.*)$/);
        if (!m) continue;
        if (++count > LIMIT) { truncated = true; p.kill(); break; }
        if (!files.has(m[1])) files.set(m[1], []);
        files.get(m[1]).push({ line: Number(m[2]), text: m[3].slice(0, 400) });
      }
    });
    const t = setTimeout(() => { truncated = true; p.kill(); }, 20000);
    p.on('close', () => { clearTimeout(t); resolve({ results: [...files].map(([file, matches]) => ({ file, matches })), truncated }); });
  });
}

export function replace({ root, query, replacement, regex, caseSensitive, files }) {
  root = clean(root);
  if (!query) throw new FsError(400, 'Nothing to find');
  const re = new RegExp(regex ? query : escapeRe(query), 'g' + (caseSensitive ? '' : 'i'));
  const changed = [];
  for (const f of (files || []).slice(0, 500)) {
    const p = clean(f, { write: true });
    if (!p.startsWith(root + '/')) continue;
    const r = read(p);
    if (r.binary || r.tooLarge) continue;
    const n = (r.content.match(re) || []).length;
    // regex mode keeps $1-style group references; plain mode inserts the text literally
    const next = r.content.replace(re, regex ? replacement : () => replacement);
    if (n) { write(p, next, r.mtime, false); recordChange({ id: 'u-' + crypto.randomBytes(6).toString('hex'), file: p, tool: 'Replace', by: 'you', before: r.content, after: next }); changed.push({ file: p, count: n }); }
  }
  return { changed };
}

// ---------- change history (Claude's edits + your replace-all) ----------

const changes = []; // newest first, metadata only; content lives on disk
function loadChanges() {
  try {
    const files = fs.readdirSync(CHANGES_DIR).filter((f) => f.endsWith('.json'));
    for (const f of files) {
      try {
        const c = JSON.parse(fs.readFileSync(path.join(CHANGES_DIR, f), 'utf8'));
        changes.push(summary(c));
      } catch {}
    }
    changes.sort((a, b) => b.at - a.at);
    // keep the folder bounded
    for (const c of changes.splice(600)) fs.rmSync(path.join(CHANGES_DIR, c.id + '.json'), { force: true });
  } catch {}
}

function lineStats(before, after) {
  const a = (before || '').split('\n'), b = (after || '').split('\n');
  const count = (arr) => { const m = new Map(); for (const l of arr) m.set(l, (m.get(l) || 0) + 1); return m; };
  const ma = count(a), mb = count(b);
  let removed = 0, added = 0;
  for (const [l, n] of ma) removed += Math.max(0, n - (mb.get(l) || 0));
  for (const [l, n] of mb) added += Math.max(0, n - (ma.get(l) || 0));
  return { added, removed };
}

function summary(c) {
  const { before, after, ...rest } = c;
  return rest;
}

export function recordChange(c) {
  if ((c.before ?? '') === (c.after ?? '')) return;
  const full = { at: Date.now(), ...c, ...lineStats(c.before, c.after), created: c.before == null };
  const safe = String(full.id).replace(/[^\w-]/g, '');
  full.id = safe;
  fs.writeFileSync(path.join(CHANGES_DIR, safe + '.json'), JSON.stringify(full));
  const s = summary(full);
  const i = changes.findIndex((x) => x.id === safe);
  if (i >= 0) changes.splice(i, 1);
  changes.unshift(s);
  if (changes.length > 600) for (const old of changes.splice(600)) fs.rmSync(path.join(CHANGES_DIR, old.id + '.json'), { force: true });
  emit({ type: 'file_change', change: s });
}

export function listChanges(limit = 200) { return changes.slice(0, limit); }

export function getChange(id) {
  const safe = String(id).replace(/[^\w-]/g, '');
  try { return JSON.parse(fs.readFileSync(path.join(CHANGES_DIR, safe + '.json'), 'utf8')); } catch { return null; }
}

export function revertChange(id, force) {
  const c = getChange(id);
  if (!c) throw new FsError(404, 'Change not found');
  let current = null;
  try { current = fs.readFileSync(c.file, 'utf8'); } catch {}
  if (!force && current !== c.after) throw new FsError(409, 'The file has changed since this edit — open the diff and revert by hand, or force it');
  if (c.before == null) { op({ op: 'delete', path: c.file }); }
  else write(c.file, c.before, 0, true);
  recordChange({ id: 'r-' + crypto.randomBytes(6).toString('hex'), file: c.file, tool: 'Revert', by: 'you', before: current, after: c.before ?? '' });
  return { ok: true };
}

// ---------- Agent SDK hooks: capture file contents around Claude's edits ----------

const EDIT_TOOLS = 'Edit|Write|MultiEdit|NotebookEdit';
const pendingBefore = new Map(); // tool_use_id -> { file, before }

function snapshotFile(file) {
  try { const st = fs.statSync(file); if (st.size > MAX_CHANGE_CONTENT) return undefined; return fs.readFileSync(file, 'utf8'); }
  catch { return null; } // doesn't exist yet
}

export function sdkHooks() {
  return {
    PreToolUse: [{ matcher: EDIT_TOOLS, hooks: [async (input) => {
      const file = input.tool_input?.file_path || input.tool_input?.notebook_path;
      if (file && input.tool_use_id) pendingBefore.set(input.tool_use_id, { file, before: snapshotFile(file) });
      return {};
    }] }],
    PostToolUse: [{ matcher: EDIT_TOOLS, hooks: [async (input) => {
      const p = pendingBefore.get(input.tool_use_id);
      pendingBefore.delete(input.tool_use_id);
      if (!p || p.before === undefined) return {};
      const after = snapshotFile(p.file);
      if (after === undefined) return {};
      try { recordChange({ id: input.tool_use_id, file: p.file, tool: input.tool_name, by: 'claude', session: input.session_id, before: p.before, after: after ?? '' }); }
      catch (e) { console.error('record change', e.message); }
      return {};
    }] }],
  };
}
