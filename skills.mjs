// Orbit skills service (pm2 orbit-skills, 127.0.0.1:3023).
// Installs Claude Code skills from GitHub into ~/.claude/skills/<name>/ and manages them.
// nginx puts /orbit/api/skills/ behind the Orbit login (auth_request); writes also need an allowed Origin (ORBIT_ORIGINS).
// Downloaded repos are treated as data only: extracted with system tar into a fresh temp dir, never executed,
// symlinks are dropped when copying.
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import cfg from './config.mjs';
const run = promisify(execFile);
const PORT = cfg.PORTS.skills;
const HOME = os.homedir();
const SKILLS = path.join(cfg.CLAUDE_DIR, 'skills');
const DISABLED = path.join(cfg.CLAUDE_DIR, 'skills-disabled');
const SYNCED = path.join(SKILLS, 'synced');
const TRASH = cfg.TRASH;

const MAX_DL = 80 * 1024 * 1024;
const MAX_FILE = 25 * 1024 * 1024;
const SRC_FILE = '.orbit-source.json';
const RESERVED = new Set(['synced']);
const SCRIPT_EXT = /\.(sh|bash|zsh|py|js|mjs|cjs|ts|rb|pl|php|ps1|bat|exe|bin)$/i;

fs.mkdirSync(SKILLS, { recursive: true });

// ---------- helpers ----------
const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
const exists = (p) => fsp.lstat(p).then(() => true, () => false);
const safeName = (s) => String(s || '').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 64);

async function readBody(req, cap = 64 * 1024) {
  let n = 0; const chunks = [];
  for await (const c of req) { n += c.length; if (n > cap) throw Object.assign(new Error('Request too large'), { code: 413 }); chunks.push(c); }
  const s = Buffer.concat(chunks).toString('utf8');
  return s ? JSON.parse(s) : {};
}

function parseFrontmatter(text) {
  const out = {};
  const m = text.match(/^﻿?---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return out;
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) continue;
    let [, k, v] = kv;
    if (v === '' || v === '>' || v === '|' || v === '>-' || v === '|-') {
      const buf = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) buf.push(lines[++i].trim());
      v = buf.join(v.startsWith('|') ? '\n' : ' ');
    }
    v = v.trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1).replace(/\\(["\\])/g, '$1').replace(/\\n/g, '\n');
    else if (v.startsWith("'") && v.endsWith("'")) v = v.slice(1, -1).replace(/''/g, "'");
    out[k] = v;
  }
  return out;
}

async function findSkillMd(dir) {
  for (const n of ['SKILL.md', 'skill.md', 'Skill.md']) if (await exists(path.join(dir, n))) return path.join(dir, n);
  return null;
}

// walk a skill folder: counts, scripts, symlinks (not followed)
async function inspect(dir) {
  const info = { files: 0, bytes: 0, scripts: [], symlinks: 0, big: 0 };
  async function walk(d, rel, depth) {
    if (depth > 12) return;
    for (const e of await fsp.readdir(d, { withFileTypes: true })) {
      if (e.name === '.git' || e.name === SRC_FILE) continue;
      const p = path.join(d, e.name), r = rel ? rel + '/' + e.name : e.name;
      if (e.isSymbolicLink()) { info.symlinks++; continue; }
      if (e.isDirectory()) { await walk(p, r, depth + 1); continue; }
      if (!e.isFile()) continue;
      const st = await fsp.stat(p);
      if (st.size > MAX_FILE) { info.big++; continue; }
      info.files++; info.bytes += st.size;
      if (SCRIPT_EXT.test(e.name) || (st.mode & 0o111)) info.scripts.push(r);
    }
  }
  await walk(dir, '', 0);
  return info;
}

async function describe(dir) {
  const md = await findSkillMd(dir);
  if (!md) return null;
  const text = await fsp.readFile(md, 'utf8').catch(() => '');
  const fm = parseFrontmatter(text);
  return { fm, mdName: path.basename(md) };
}

// copy without following symlinks, skipping huge files and the .git dir
async function copyTree(src, dest) {
  await fsp.mkdir(dest, { recursive: true });
  for (const e of await fsp.readdir(src, { withFileTypes: true })) {
    if (e.name === '.git') continue;
    const s = path.join(src, e.name), d = path.join(dest, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) { await copyTree(s, d); continue; }
    if (!e.isFile()) continue;
    const st = await fsp.stat(s);
    if (st.size > MAX_FILE) continue;
    await fsp.copyFile(s, d);
    await fsp.chmod(d, st.mode & 0o111 ? 0o755 : 0o644);
  }
}

async function toTrash(p, label) {
  await fsp.mkdir(TRASH, { recursive: true });
  const dest = path.join(TRASH, `skill-${label}-${Date.now()}`);
  await fsp.rename(p, dest).catch(async () => { await fsp.cp(p, dest, { recursive: true }); await fsp.rm(p, { recursive: true, force: true }); });
  return dest;
}

// ---------- GitHub ----------
let ghToken = process.env.GITHUB_TOKEN || null, ghTokenAt = 0;
async function token() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  if (Date.now() - ghTokenAt < 10 * 60e3) return ghToken;
  ghTokenAt = Date.now();
  try { ghToken = (await run('gh', ['auth', 'token'], { timeout: 5000 })).stdout.trim() || null; } catch { ghToken = null; }
  return ghToken;
}
async function gh(url, accept = 'application/vnd.github+json') {
  const t = await token();
  const headers = { 'user-agent': 'orbit-skills', accept };
  if (t) headers.authorization = 'Bearer ' + t;
  return fetch(url, { headers, redirect: 'follow' });
}

function parseGithub(input) {
  let s = String(input || '').trim();
  if (!s) throw new Error('Paste a GitHub link or owner/repo.');
  s = s.replace(/^git@github\.com:/, 'https://github.com/').replace(/\.git(\/|$)/, '$1').replace(/[?#].*$/, '');
  let m = s.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+)(?:\/(tree|blob)\/(.+))?\/?$/i);
  if (!m) {
    const short = s.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:\/(.+))?$/);
    if (!short) throw new Error('That does not look like a GitHub repo. Use github.com/owner/repo or owner/repo.');
    return { owner: short[1], repo: short[2], rest: null, kind: null, sub: short[3] || '' };
  }
  return { owner: m[1], repo: m[2], kind: m[3] || null, rest: m[4] ? m[4].replace(/\/$/, '') : null, sub: '' };
}

async function download(owner, repo, ref, file) {
  const t = await token();
  const url = t ? `https://api.github.com/repos/${owner}/${repo}/tarball/${encodeURIComponent(ref)}` : `https://codeload.github.com/${owner}/${repo}/tar.gz/${ref.split('/').map(encodeURIComponent).join('/')}`;
  const r = t ? await gh(url, 'application/vnd.github+json') : await fetch(url, { headers: { 'user-agent': 'orbit-skills' } });
  if (!r.ok) { await r.arrayBuffer().catch(() => {}); return r.status; }
  const len = Number(r.headers.get('content-length') || 0);
  if (len > MAX_DL) throw new Error('That repo is too large to download (over 80 MB).');
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > MAX_DL) throw new Error('That repo is too large to download (over 80 MB).');
  await fsp.writeFile(file, buf);
  return 200;
}

// resolve repo + ref + subpath, download, extract. Returns { dir, root, owner, repo, ref, sha, sub }
async function fetchRepo(input) {
  const p = parseGithub(input);
  const { owner, repo } = p;
  let meta = null;
  const mr = await gh(`https://api.github.com/repos/${owner}/${repo}`);
  if (mr.ok) meta = await mr.json(); else await mr.arrayBuffer().catch(() => {});
  if (mr.status === 404) throw new Error(`Couldn't find github.com/${owner}/${repo}. Check the link, or it may be private (run "gh auth login" on the server to allow private repos).`);

  // candidate (ref, subpath) splits for /tree/<ref>/<path> where the ref itself may contain slashes
  const tries = [];
  if (p.rest) {
    const parts = p.rest.split('/');
    for (let i = 1; i <= parts.length; i++) tries.push({ ref: parts.slice(0, i).join('/'), sub: parts.slice(i).join('/') });
  } else tries.push({ ref: meta?.default_branch || 'HEAD', sub: p.sub });

  const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'orbit-skills-'));
  const file = path.join(work, 'repo.tar.gz');
  let got = null;
  for (const t of tries) {
    const code = await download(owner, repo, t.ref, file);
    if (code === 200) { got = t; break; }
    if (code !== 404) throw new Error(`GitHub returned ${code} while downloading. Try again in a minute.`);
  }
  if (!got) { await fsp.rm(work, { recursive: true, force: true }); throw new Error('Couldn\'t find that branch or folder in the repo.'); }
  if (p.kind === 'blob') got.sub = path.posix.dirname(got.sub) === '.' ? '' : path.posix.dirname(got.sub); // link to a file -> its folder

  const root = path.join(work, 'src');
  await fsp.mkdir(root);
  // GNU tar refuses absolute paths and ".." members by default; no owner/permission restore
  await run('tar', ['-xzf', file, '-C', root, '--strip-components=1', '--no-same-owner', '--no-same-permissions', '--no-overwrite-dir'], { timeout: 120000, maxBuffer: 1 << 20 });
  await fsp.rm(file, { force: true });

  let sha = null;
  try {
    const sr = await gh(`https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(got.ref)}`, 'application/vnd.github.sha');
    sha = sr.ok ? (await sr.text()).trim().slice(0, 40) : (await sr.arrayBuffer(), null);
  } catch {}

  const sub = got.sub.replace(/^\/+|\/+$/g, '');
  const base = path.resolve(root, sub);
  if (!base.startsWith(root)) throw new Error('Bad path.');
  if (!(await exists(base))) throw new Error(`The folder "${sub}" isn't in that repo.`);
  return { work, root, base, owner, repo, ref: got.ref, sha, sub, stars: meta?.stargazers_count ?? null, desc: meta?.description || '' };
}

async function findSkills(base) {
  const found = [];
  async function walk(d, depth) {
    if (depth > 7 || found.length > 300) return;
    if (await findSkillMd(d)) { found.push(d); }
    let ents = [];
    try { ents = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (!e.isDirectory() || e.isSymbolicLink()) continue;
      if (['.git', 'node_modules', '.github', '__pycache__', 'dist', 'build'].includes(e.name)) continue;
      await walk(path.join(d, e.name), depth + 1);
    }
  }
  await walk(base, 0);
  return found;
}

// ---------- scans (kept for 30 min so the user can review and pick) ----------
const scans = new Map();
setInterval(() => {
  for (const [id, s] of scans) if (Date.now() - s.at > 30 * 60e3) { scans.delete(id); fsp.rm(s.work, { recursive: true, force: true }).catch(() => {}); }
}, 60e3).unref();

async function scan(input) {
  const r = await fetchRepo(input);
  const dirs = await findSkills(r.base);
  const skills = [];
  for (const d of dirs) {
    const desc = await describe(d);
    const rel = path.relative(r.root, d).split(path.sep).join('/');
    const name = safeName(desc.fm.name || path.basename(d === r.root ? r.repo : d));
    const info = await inspect(d);
    const installed = await installedState(name);
    skills.push({
      path: rel, name, title: desc.fm.name || name, description: desc.fm.description || '',
      files: info.files, bytes: info.bytes, scripts: info.scripts.slice(0, 20), scriptCount: info.scripts.length, symlinks: info.symlinks, big: info.big,
      conflict: installed ? { where: installed.where, source: installed.source ? `${installed.source.owner}/${installed.source.repo}` : null, same: !!installed.source && installed.source.owner === r.owner && installed.source.repo === r.repo && installed.source.path === rel } : null,
      reserved: RESERVED.has(name) || !name,
    });
  }
  const id = crypto.randomBytes(9).toString('hex');
  scans.set(id, { ...r, at: Date.now(), skills });
  if (!skills.length) { scans.delete(id); fsp.rm(r.work, { recursive: true, force: true }).catch(() => {}); }
  return { id, owner: r.owner, repo: r.repo, ref: r.ref, sha: r.sha, sub: r.sub, stars: r.stars, repoDescription: r.desc, skills };
}

async function installedState(name) {
  for (const [where, dir] of [['enabled', SKILLS], ['disabled', DISABLED]]) {
    const p = path.join(dir, name);
    if (await exists(p)) {
      let source = null;
      try { source = JSON.parse(await fsp.readFile(path.join(p, SRC_FILE), 'utf8')); } catch {}
      return { where, dir: p, source };
    }
  }
  return null;
}

async function installFromScan(s, rel, { overwrite = false, keepWhere = null } = {}) {
  const sk = s.skills.find((x) => x.path === rel);
  if (!sk) throw new Error('That skill is not in this scan.');
  if (sk.reserved) throw new Error(`"${sk.name}" can't be used as a skill folder name.`);
  const src = path.resolve(s.root, rel);
  if (!src.startsWith(s.root)) throw new Error('Bad path.');
  const cur = await installedState(sk.name);
  if (cur && !overwrite) throw Object.assign(new Error(`A skill called "${sk.name}" is already installed.`), { code: 409 });
  const where = keepWhere || cur?.where || 'enabled';
  const destRoot = where === 'disabled' ? DISABLED : SKILLS;
  await fsp.mkdir(destRoot, { recursive: true });
  const tmp = path.join(destRoot, `.${sk.name}.installing-${process.pid}`);
  await fsp.rm(tmp, { recursive: true, force: true });
  await copyTree(src, tmp);
  const source = { owner: s.owner, repo: s.repo, ref: s.ref, path: rel, sha: s.sha, url: `https://github.com/${s.owner}/${s.repo}/tree/${s.ref}/${rel}`.replace(/\/$/, ''), installedAt: new Date().toISOString() };
  await fsp.writeFile(path.join(tmp, SRC_FILE), JSON.stringify(source, null, 2));
  if (cur) await toTrash(cur.dir, sk.name);
  await fsp.rename(tmp, path.join(destRoot, sk.name));
  return { name: sk.name, where, replaced: !!cur };
}

// ---------- listing ----------
async function listDir(dir, where) {
  const out = [];
  let ents = [];
  try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    if (e.name.startsWith('.') || (where === 'enabled' && RESERVED.has(e.name))) continue;
    const p = path.join(dir, e.name);
    let st; try { st = await fsp.stat(p); } catch { continue; }
    if (!st.isDirectory()) continue;
    const d = await describe(p);
    if (!d) continue;
    let source = null;
    try { source = JSON.parse(await fsp.readFile(path.join(p, SRC_FILE), 'utf8')); } catch {}
    const info = await inspect(p);
    out.push({ name: e.name, title: d.fm.name || e.name, description: d.fm.description || '', where, source, files: info.files, bytes: info.bytes, scriptCount: info.scripts.length, mtime: st.mtimeMs, symlink: e.isSymbolicLink() });
  }
  return out;
}

async function listSynced() {
  const out = [];
  let accts = [];
  try { accts = await fsp.readdir(SYNCED, { withFileTypes: true }); } catch { return out; }
  for (const a of accts) {
    if (!a.isDirectory()) continue;
    for (const s of await listDir(path.join(SYNCED, a.name), 'synced')) out.push({ ...s, syncDir: a.name });
  }
  return out;
}

async function list() {
  const [enabled, disabled, synced] = await Promise.all([listDir(SKILLS, 'enabled'), listDir(DISABLED, 'disabled'), listSynced()]);
  const by = (a, b) => a.name.localeCompare(b.name);
  return { dir: SKILLS, skills: [...enabled, ...disabled].sort(by), synced: synced.sort(by), github: !!(await token()) };
}

async function skillDir(name, where) {
  name = safeName(name);
  if (!name) throw new Error('Missing name.');
  if (where === 'synced') {
    for (const a of await fsp.readdir(SYNCED).catch(() => [])) {
      const p = path.join(SYNCED, a, name);
      if (await exists(p)) return p;
    }
    throw Object.assign(new Error('Not found'), { code: 404 });
  }
  const st = await installedState(name);
  if (!st) throw Object.assign(new Error('Not found'), { code: 404 });
  return st.dir;
}

// ---------- http ----------
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const route = u.pathname.replace(new RegExp('^' + cfg.BASE.replace(/[.*+?^${}()|[\]\\]/g,'\\$&') + '/api/skills/?'), '/');
  try {
    if (req.method !== 'GET') {
      const o = req.headers.origin;
      if (!cfg.originOk(o)) return json(res, 403, { error: 'Bad origin' });
    }
    if (req.method === 'GET' && route === '/') return json(res, 200, await list());

    if (req.method === 'GET' && route === '/file') {
      let dir;
      const sid = u.searchParams.get('scan');
      if (sid) {
        const s = scans.get(sid);
        if (!s) return json(res, 410, { error: 'This search expired. Search again.' });
        dir = path.resolve(s.root, u.searchParams.get('path') || '');
        if (!dir.startsWith(s.root)) return json(res, 400, { error: 'Bad path' });
      } else dir = await skillDir(u.searchParams.get('name'), u.searchParams.get('where'));
      const md = await findSkillMd(dir);
      if (!md) return json(res, 404, { error: 'No SKILL.md' });
      const st = await fsp.stat(md);
      const text = (await fsp.readFile(md, 'utf8')).slice(0, 300000);
      const info = await inspect(dir);
      return json(res, 200, { text, truncated: st.size > 300000, files: info.files, scripts: info.scripts.slice(0, 50), dir: sid ? null : dir });
    }

    if (req.method === 'POST' && route === '/scan') {
      const b = await readBody(req);
      return json(res, 200, await scan(b.url));
    }

    if (req.method === 'POST' && route === '/install') {
      const b = await readBody(req);
      const s = scans.get(String(b.scan || ''));
      if (!s) return json(res, 410, { error: 'This search expired. Search again.' });
      const results = [];
      for (const rel of [].concat(b.paths || []).slice(0, 100)) {
        try { results.push({ path: rel, ok: true, ...(await installFromScan(s, String(rel), { overwrite: !!b.overwrite })) }); }
        catch (e) { results.push({ path: rel, ok: false, error: e.message, conflict: e.code === 409 }); }
      }
      return json(res, 200, { results });
    }

    if (req.method === 'POST' && route === '/update') {
      const b = await readBody(req);
      const st = await installedState(safeName(b.name));
      if (!st?.source) return json(res, 400, { error: 'This skill was not installed from GitHub, so it can\'t be updated here.' });
      const src = st.source;
      const url = `https://github.com/${src.owner}/${src.repo}/tree/${src.ref}/${src.path}`.replace(/\/$/, '');
      const r = await scan(url);
      const s = scans.get(r.id);
      if (!s) return json(res, 404, { error: 'The skill is no longer in that repo.' });
      const sk = s.skills.find((x) => x.path === src.path) || (s.skills.length === 1 ? s.skills[0] : null);
      if (!sk) return json(res, 404, { error: 'The skill is no longer in that repo.' });
      const changed = !src.sha || !r.sha || src.sha !== r.sha;
      const out = await installFromScan(s, sk.path, { overwrite: true, keepWhere: st.where });
      return json(res, 200, { ...out, changed, from: src.sha, to: r.sha });
    }

    if (req.method === 'POST' && route === '/toggle') {
      const b = await readBody(req);
      const name = safeName(b.name);
      const st = await installedState(name);
      if (!st) return json(res, 404, { error: 'Not found' });
      const to = st.where === 'enabled' ? DISABLED : SKILLS;
      await fsp.mkdir(to, { recursive: true });
      if (await exists(path.join(to, name))) return json(res, 409, { error: 'A copy with that name is already there.' });
      await fsp.rename(st.dir, path.join(to, name));
      return json(res, 200, { name, where: st.where === 'enabled' ? 'disabled' : 'enabled' });
    }

    if (req.method === 'POST' && route === '/remove') {
      const b = await readBody(req);
      const name = safeName(b.name);
      const st = await installedState(name);
      if (!st) return json(res, 404, { error: 'Not found' });
      const trash = await toTrash(st.dir, name);
      return json(res, 200, { name, trash });
    }

    json(res, 404, { error: 'Not found' });
  } catch (e) {
    json(res, e.code === 413 || e.code === 409 || e.code === 404 ? e.code : 400, { error: e.message || String(e) });
  }
});
server.listen(PORT, cfg.HOST, () => console.log('orbit-skills on', cfg.HOST + ':' + PORT));
