// Per-site snapshots and full backups. A "site" is one nginx config file: its domains,
// the folders it serves, the pm2 apps behind its proxy ports (and the data folders
// their env files point at), plus its SQLite / Postgres databases.
//   snapshot = code + data + config + DB dumps (skips node_modules/.next and other rebuildables)
//   full     = everything, including dependencies, build output and TLS certificates
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import cfg from './config.mjs';

const NGINX_DIR = '/etc/nginx/sites-enabled';
export const BACKUP_ROOT = cfg.BACKUP_ROOT;
const WORK = path.join(BACKUP_ROOT, '.work');
const SCHEDULE_FILE = path.join(BACKUP_ROOT, 'schedule.json');
const AUTO_KEEP = 7;
const SNAPSHOT_EXCLUDES = ['node_modules', '.next', '.turbo', '.cache', '.pnpm-store', '.npm', '*.log', '.parcel-cache', 'coverage'];

let emit = () => {};
export function init(emitFn) {
  emit = emitFn;
  fs.mkdirSync(WORK, { recursive: true });
  fs.rmSync(WORK, { recursive: true, force: true }); // leftovers from an interrupted job
  fs.mkdirSync(WORK, { recursive: true });
  setInterval(runSchedule, 60 * 60 * 1000);
  setTimeout(runSchedule, 60 * 1000);
}

const run = (cmd, args, opts = {}) => new Promise((resolve) => {
  execFile(cmd, args, { maxBuffer: 64 << 20, timeout: 20 * 60 * 1000, ...opts }, (err, stdout, stderr) => resolve({ err, stdout: String(stdout), stderr: String(stderr) }));
});

// ---------- discovery ----------

function projectRoot(p) {
  const m = p.match(/^(\/var\/www\/[^/]+|\/opt\/[^/]+|\/srv\/[^/]+|\/home\/[^/]+\/[^/]+)/);
  return m ? m[1] : p.replace(/\/+$/, '');
}

function ppidOf(pid) {
  try { return Number(fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ')[1]); } catch { return 0; }
}

function readEnvFiles(dir) {
  const files = [];
  const scan = (d) => { try { for (const f of fs.readdirSync(d)) if (/^\.env(\..+)?$|^ecosystem.*\.(c?js|json)$/.test(f)) files.push(path.join(d, f)); } catch {} };
  scan(dir);
  try { for (const sub of fs.readdirSync(path.join(dir, 'apps'))) scan(path.join(dir, 'apps', sub)); } catch {}
  return files.map((f) => { try { return [f, fs.readFileSync(f, 'utf8')]; } catch { return [f, '']; } });
}

function findSqlite(dir, depth = 0, out = []) {
  if (depth > 4) return out;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.isDirectory()) { if (!['node_modules', '.next', '.git', '.turbo', '.cache', 'dist'].includes(e.name)) findSqlite(path.join(dir, e.name), depth + 1, out); }
    else if (/\.(db|sqlite3?)$/.test(e.name)) out.push(path.join(dir, e.name));
  }
  return out;
}

let cache = { at: 0, sites: [] };
export async function discover(force = false) {
  if (!force && Date.now() - cache.at < 60000) return cache.sites;
  const [{ stdout: jl }, { stdout: ssOut }] = await Promise.all([run('pm2', ['jlist']), run('ss', ['-ltnpH'])]);
  let pm2 = [];
  try { pm2 = JSON.parse(jl).map((p) => ({ name: p.name, pid: p.pid, cwd: p.pm2_env.pm_cwd, status: p.pm2_env.status })); } catch {}
  const byPid = new Map(pm2.filter((p) => p.pid).map((p) => [p.pid, p]));
  const portOwner = new Map();
  for (const line of ssOut.split('\n')) {
    const port = line.match(/:(\d+)\s+\S+\s+users:/)?.[1];
    const pid = Number(line.match(/pid=(\d+)/)?.[1]);
    if (!port || !pid) continue;
    for (let p = pid, i = 0; p > 1 && i < 12; p = ppidOf(p), i++) if (byPid.has(p)) { portOwner.set(Number(port), byPid.get(p)); break; }
  }

  const sites = [];
  let files = [];
  try { files = fs.readdirSync(NGINX_DIR).sort(); } catch {}
  for (const file of files) {
    const conf = path.join(NGINX_DIR, file);
    let txt = '';
    try { txt = fs.readFileSync(conf, 'utf8'); } catch { continue; }
    const clean = txt.replace(/#.*$/gm, '');
    const domains = [...new Set([...clean.matchAll(/server_name\s+([^;]+);/g)].flatMap((m) => m[1].trim().split(/\s+/)).filter((d) => d !== '_'))];
    if (!domains.length) continue;
    const dirs = new Map(); // path -> kind
    for (const m of clean.matchAll(/^\s*(?:root|alias)\s+([^;]+);/gm)) {
      const p = m[1].trim();
      if (p.includes('certbot') || p.startsWith('/usr/share/nginx')) continue;
      dirs.set(projectRoot(p), 'web');
    }
    const procs = new Set();
    for (const m of clean.matchAll(/proxy_pass\s+https?:\/\/(?:127\.0\.0\.1|localhost):(\d+)/g)) {
      const owner = portOwner.get(Number(m[1]));
      if (owner) { procs.add(owner.name); if (owner.cwd) dirs.set(projectRoot(owner.cwd), 'app'); }
    }
    // a pm2 app named after the site (e.g. a stopped one with no port yet)
    const stem = file.replace(/[-_.](ge|com)$/, '');
    for (const p of pm2) if ((p.name === stem || p.name === file) && p.cwd) { procs.add(p.name); dirs.set(projectRoot(p.cwd), 'app'); }
    // pm2 apps whose folder this site serves
    for (const p of pm2) if (p.cwd && dirs.has(projectRoot(p.cwd))) procs.add(p.name);

    const postgres = [];
    for (const [dir] of [...dirs]) {
      for (const [f, body] of readEnvFiles(dir)) {
        for (const m of body.matchAll(/\/var\/www\/[\w.-]+/g)) {
          const d = m[0];
          if (!dirs.has(d) && fs.existsSync(d) && fs.statSync(d).isDirectory()) dirs.set(d, /build/.test(d) ? 'build' : 'data');
        }
        for (const m of body.matchAll(/^\s*(?:DATABASE_URL|POSTGRES_URL)\s*=\s*["']?(postgres(?:ql)?:\/\/[^"'\s]+)/gm)) {
          const url = m[1];
          const dbName = url.split('/').pop().split('?')[0];
          let host = ''; try { host = new URL(url).host; } catch {}
          if (!postgres.some((x) => x.name === dbName && x.host === host)) postgres.push({ url, name: dbName, host, from: f });
        }
      }
    }
    const sqlite = [...dirs.keys()].filter((d) => dirs.get(d) !== 'build').flatMap((d) => findSqlite(d));
    const certs = [...new Set([...clean.matchAll(/ssl_certificate(?:_key)?\s+([^;]+);/g)].map((m) => m[1].trim()))];
    sites.push({
      id: file,
      name: domains.find((d) => !d.startsWith('www.')) || domains[0],
      domains: domains.filter((d) => !d.startsWith('www.')),
      nginx: conf,
      dirs: [...dirs].map(([p, kind]) => ({ path: p, kind })),
      processes: [...procs],
      sqlite,
      postgres: postgres.map(({ name, from }) => ({ name, from })),
      _postgres: postgres,
      certs,
    });
  }
  cache = { at: Date.now(), sites };
  return sites;
}

function publicSite(s) { const { _postgres, ...rest } = s; return rest; }

// ---------- archives ----------

function siteDir(id) { return path.join(BACKUP_ROOT, id.replace(/[^\w.-]/g, '_')); }

export function listArchives(id) {
  const dir = siteDir(id);
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.tar.gz')); } catch { return []; }
  return files.map((f) => {
    const full = path.join(dir, f);
    let meta = {};
    try { meta = JSON.parse(fs.readFileSync(full.replace(/\.tar\.gz$/, '.json'), 'utf8')); } catch {}
    let size = 0; try { size = fs.statSync(full).size; } catch {}
    return { file: f, path: full, size, type: meta.type || (f.includes('-full') ? 'full' : 'snapshot'), at: meta.at || fs.statSync(full).mtimeMs, auto: !!meta.auto, note: meta.note || '', seconds: meta.seconds, warnings: meta.warnings || [] };
  }).sort((a, b) => b.at - a.at);
}

export function archivePath(id, file) {
  if (!/^[\w.-]+\.tar\.gz$/.test(file)) return null;
  const p = path.join(siteDir(id), file);
  return fs.existsSync(p) ? p : null;
}

export function deleteArchive(id, file) {
  const p = archivePath(id, file);
  if (!p) return false;
  fs.rmSync(p, { force: true });
  fs.rmSync(p.replace(/\.tar\.gz$/, '.json'), { force: true });
  emit({ type: 'backups_changed', site: id });
  return true;
}

// ---------- jobs (one at a time: this box has a single core) ----------

const queue = [];
export let current = null;
export const recent = new Map(); // site -> last finished job

export function jobs() {
  const strip = (j) => j && (({ _site, _proc, ...rest }) => rest)(j);
  return { current: strip(current), queued: queue.map(strip) };
}

export async function enqueue(siteId, type, { note = '', auto = false } = {}) {
  const sites = await discover(true);
  const site = sites.find((s) => s.id === siteId);
  if (!site) throw new Error('Unknown site');
  if ([current, ...queue].some((j) => j && j.site === siteId)) throw new Error('A backup of this site is already running or queued');
  const job = { id: crypto.randomBytes(5).toString('hex'), site: siteId, type: type === 'full' ? 'full' : 'snapshot', note: String(note).slice(0, 200), auto, status: 'queued', step: 'Waiting', bytes: 0, startedAt: null };
  job._site = site;
  queue.push(job);
  emitJob(job);
  pump();
  return job.id;
}

function emitJob(job) { const { _site, _proc, ...j } = job; emit({ type: 'backup_job', job: j }); }

async function pump() {
  if (current || !queue.length) return;
  current = queue.shift();
  const job = current;
  job.status = 'running'; job.startedAt = Date.now();
  try { await runJob(job); job.status = 'done'; }
  catch (e) { job.status = 'failed'; job.error = String(e.message || e).slice(0, 400); console.error('backup failed', job.site, job.error); }
  job.finishedAt = Date.now();
  emitJob(job);
  recent.set(job.site, (({ _site, _proc, ...j }) => j)(job));
  emit({ type: 'backups_changed', site: job.site });
  current = null;
  pump();
}

async function runJob(job) {
  const site = job._site;
  const full = job.type === 'full';
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const outDir = siteDir(site.id);
  fs.mkdirSync(outDir, { recursive: true });
  const base = `${site.id}-${stamp}-${job.type}${job.auto ? '-auto' : ''}`;
  const out = path.join(outDir, base + '.tar.gz');
  const stage = path.join(WORK, job.id);
  const meta = path.join(stage, '_backup');
  fs.mkdirSync(path.join(meta, 'db'), { recursive: true });
  fs.mkdirSync(path.join(meta, 'nginx'), { recursive: true });
  const warnings = [];
  const step = (s) => { job.step = s; emitJob(job); };

  try {
    step('Saving nginx config');
    fs.copyFileSync(site.nginx, path.join(meta, 'nginx', path.basename(site.nginx)));

    for (const db of site.sqlite) {
      step('Dumping ' + path.basename(db));
      const dest = path.join(meta, 'db', db.replace(/^\//, '').replace(/\//g, '__'));
      const r = await run('nice', ['-n', '15', 'python3', '-c', 'import sqlite3,sys; s=sqlite3.connect("file:"+sys.argv[1]+"?mode=ro", uri=True); d=sqlite3.connect(sys.argv[2]); s.backup(d); d.close(); s.close()', db, dest]);
      if (r.err) warnings.push(`SQLite ${db}: ${r.stderr.trim().split('\n').pop() || r.err.message}`);
    }
    for (const pg of site._postgres) {
      step('Dumping Postgres ' + pg.name);
      const dest = path.join(meta, 'db', `postgres-${pg.name}.dump`);
      const r = await run('nice', ['-n', '15', 'pg_dump', '--dbname=' + pg.url, '-Fc', '-f', dest], { env: { ...process.env, PGCONNECT_TIMEOUT: '10' } });
      if (r.err) warnings.push(`Postgres ${pg.name}: ${r.stderr.trim().split('\n').pop() || r.err.message}`);
    }

    const { stdout: jl } = await run('pm2', ['jlist']);
    try {
      const defs = JSON.parse(jl).filter((p) => site.processes.includes(p.name)).map((p) => ({ name: p.name, cwd: p.pm2_env.pm_cwd, script: p.pm2_env.pm_exec_path, args: p.pm2_env.args, interpreter: p.pm2_env.exec_interpreter, node_args: p.pm2_env.node_args, status: p.pm2_env.status }));
      fs.writeFileSync(path.join(meta, 'pm2.json'), JSON.stringify(defs, null, 2));
    } catch {}

    const dirs = site.dirs.filter((d) => full || d.kind !== 'build').map((d) => d.path).filter((d) => fs.existsSync(d));
    const extra = full ? site.certs.flatMap((c) => { try { return [fs.realpathSync(c)]; } catch { return []; } }) : [];
    fs.writeFileSync(path.join(meta, 'meta.json'), JSON.stringify({
      site: site.name, id: site.id, type: job.type, created: new Date().toISOString(), domains: site.domains,
      dirs, nginx: site.nginx, processes: site.processes, sqlite: site.sqlite, postgres: site.postgres.map((p) => p.name),
      certs: extra, excluded: full ? [] : SNAPSHOT_EXCLUDES, note: job.note,
      restore: 'Folders are stored with their absolute paths (minus the leading /). _backup/ holds the nginx config, DB dumps (sqlite copies; pg_restore for .dump) and pm2 app definitions.',
    }, null, 2));

    step(full ? 'Archiving everything' : 'Archiving files');
    const args = ['-n', '15', 'ionice', '-c3', 'tar', '-czf', out, '--warning=no-file-changed', '--warning=no-file-removed', '--ignore-failed-read'];
    if (!full) for (const ex of SNAPSHOT_EXCLUDES) args.push('--exclude=' + ex);
    args.push('-C', '/', ...[...dirs, ...extra].map((d) => d.replace(/^\//, '')), '-C', stage, '_backup');
    await new Promise((resolve, reject) => {
      const p = spawn('nice', args, { stdio: ['ignore', 'ignore', 'pipe'] });
      job._proc = p;
      let err = '';
      p.stderr.on('data', (d) => { err += d; if (err.length > 8000) err = err.slice(-8000); });
      const poll = setInterval(() => { try { job.bytes = fs.statSync(out).size; emitJob(job); } catch {} }, 1500);
      p.on('close', (code) => {
        clearInterval(poll);
        // tar exits 1 when files changed while being read; the archive is still good
        if (code === 0 || code === 1) resolve();
        else reject(new Error('tar failed: ' + (err.trim().split('\n').pop() || 'exit ' + code)));
      });
    });
    job.bytes = fs.statSync(out).size;
    const seconds = Math.round((Date.now() - job.startedAt) / 1000);
    fs.writeFileSync(path.join(outDir, base + '.json'), JSON.stringify({ type: job.type, at: Date.now(), auto: job.auto, note: job.note, seconds, warnings, dirs }, null, 2));
    if (warnings.length) job.warnings = warnings;
    if (job.auto) prune(site.id);
  } catch (e) {
    fs.rmSync(out, { force: true });
    throw e;
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

export function cancel(siteId) {
  const qi = queue.findIndex((j) => j.site === siteId);
  if (qi >= 0) { const [j] = queue.splice(qi, 1); j.status = 'cancelled'; emitJob(j); return true; }
  if (current?.site === siteId && current._proc) { current._proc.kill('SIGTERM'); return true; }
  return false;
}

function prune(id) {
  const autos = listArchives(id).filter((a) => a.auto);
  for (const a of autos.slice(AUTO_KEEP)) deleteArchive(id, a.file);
}

// ---------- schedule: automatic snapshots around 04:00 server time ----------

export function readSchedule() { try { return JSON.parse(fs.readFileSync(SCHEDULE_FILE, 'utf8')); } catch { return {}; } }
export function setSchedule(id, value) {
  const s = readSchedule();
  if (value === 'off') delete s[id]; else s[id] = value === 'weekly' ? 'weekly' : 'daily';
  fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(s, null, 2));
  return s;
}

async function runSchedule() {
  if (new Date().getHours() !== 4) return;
  const sched = readSchedule();
  for (const [id, every] of Object.entries(sched)) {
    const last = listArchives(id).find((a) => a.auto);
    const period = (every === 'weekly' ? 7 : 1) * 24 * 3600 * 1000;
    if (!last || Date.now() - last.at > period - 2 * 3600 * 1000) {
      try { await enqueue(id, 'snapshot', { auto: true, note: `Automatic ${every} snapshot` }); } catch {}
    }
  }
}

export async function overview() {
  const sites = await discover();
  const sched = readSchedule();
  let free = 0, total = 0;
  try { const s = fs.statfsSync(BACKUP_ROOT); free = s.bavail * s.bsize; total = s.blocks * s.bsize; } catch {}
  const all = sites.map((s) => {
    const archives = listArchives(s.id);
    return { ...publicSite(s), archives, schedule: sched[s.id] || 'off', lastJob: recent.get(s.id) || null };
  });
  const used = all.reduce((n, s) => n + s.archives.reduce((m, a) => m + a.size, 0), 0);
  return { sites: all, jobs: jobs(), storage: { used, free, total, dir: BACKUP_ROOT } };
}
