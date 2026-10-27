// Live server monitoring for Orbit, the Claude Code web client: system metrics from /proc,
// pm2 processes, and up/down checks for the Quick access shortcuts.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import cfg from './config.mjs';

const TICK_MS = 2000;
const HISTORY = 150; // 5 minutes at 2s
const SITE_CHECK_MS = 60000;
const LINKS_FILE = cfg.LINKS_FILE;

const listeners = new Set();
export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit(msg) { for (const fn of listeners) fn(msg); }
export const broadcast = emit;

// ---------- system metrics ----------

let prevCpu = null, prevNet = null;
export const history = [];

function readCpu() {
  const line = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0].trim().split(/\s+/).slice(1).map(Number);
  const idle = line[3] + (line[4] || 0);
  const total = line.reduce((a, b) => a + b, 0);
  return { idle, total };
}

function readMem() {
  const m = {};
  for (const l of fs.readFileSync('/proc/meminfo', 'utf8').split('\n')) {
    const [k, v] = l.split(':');
    if (v) m[k] = parseInt(v) * 1024;
  }
  return { total: m.MemTotal, used: m.MemTotal - m.MemAvailable, swapTotal: m.SwapTotal, swapUsed: m.SwapTotal - m.SwapFree };
}

function readNet() {
  let rx = 0, tx = 0;
  for (const l of fs.readFileSync('/proc/net/dev', 'utf8').split('\n').slice(2)) {
    const [name, rest] = l.split(':');
    if (!rest || /^(lo|docker|veth|br-)/.test(name.trim())) continue;
    const f = rest.trim().split(/\s+/).map(Number);
    rx += f[0]; tx += f[8];
  }
  return { rx, tx, t: Date.now() };
}

function sample() {
  const cpu = readCpu();
  const net = readNet();
  const mem = readMem();
  let disk = { total: 0, used: 0 };
  try { const s = fs.statfsSync('/'); disk = { total: s.blocks * s.bsize, used: (s.blocks - s.bfree) * s.bsize }; } catch {}
  const cpuPct = prevCpu ? 100 * (1 - (cpu.idle - prevCpu.idle) / Math.max(1, cpu.total - prevCpu.total)) : 0;
  const dt = prevNet ? (net.t - prevNet.t) / 1000 : 0;
  const point = {
    t: Date.now(),
    cpu: Math.max(0, Math.min(100, cpuPct)),
    mem: (100 * mem.used) / mem.total,
    disk: disk.total ? (100 * disk.used) / disk.total : 0,
    rx: dt ? Math.max(0, (net.rx - prevNet.rx) / dt) : 0,
    tx: dt ? Math.max(0, (net.tx - prevNet.tx) / dt) : 0,
  };
  prevCpu = cpu; prevNet = net;
  return { point, mem, disk };
}

export function systemInfo(extra) {
  const load = os.loadavg();
  return {
    hostname: os.hostname(), cores: os.cpus().length, uptime: os.uptime(), load,
    kernel: os.release(), ...extra,
  };
}

let lastSys = null;
function tick() {
  try {
    const { point, mem, disk } = sample();
    history.push(point);
    if (history.length > HISTORY) history.shift();
    lastSys = systemInfo({ memTotal: mem.total, memUsed: mem.used, swapTotal: mem.swapTotal, swapUsed: mem.swapUsed, diskTotal: disk.total, diskUsed: disk.used });
    if (listeners.size) emit({ type: 'metrics', point, sys: lastSys });
  } catch (e) { console.error('metrics', e.message); }
}

// ---------- pm2 ----------

export let processes = [];
let pm2Busy = false;
function pollPm2() {
  if (pm2Busy || !listeners.size) return;
  pm2Busy = true;
  execFile('pm2', ['jlist'], { maxBuffer: 32 << 20, timeout: 15000 }, (err, out) => {
    pm2Busy = false;
    if (err) return;
    try {
      processes = JSON.parse(out).map((p) => ({
        id: p.pm_id, name: p.name, status: p.pm2_env.status, restarts: p.pm2_env.restart_time,
        uptime: p.pm2_env.status === 'online' ? Date.now() - p.pm2_env.pm_uptime : 0,
        cpu: p.monit?.cpu ?? 0, mem: p.monit?.memory ?? 0,
        out: p.pm2_env.pm_out_log_path, err: p.pm2_env.pm_err_log_path,
      }));
      emit({ type: 'processes', processes: processes.map(({ out, err, ...p }) => p) });
    } catch {}
  });
}

function tailFile(file, lines) {
  try {
    const fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, 256 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    return buf.toString('utf8').split('\n').slice(-lines - 1).join('\n').trim();
  } catch { return ''; }
}

export function processLogs(name, lines = 120) {
  const p = processes.find((x) => x.name === name);
  if (!p) return null;
  return { name, out: tailFile(p.out, lines), err: tailFile(p.err, lines) };
}

export function restartProcess(name) {
  return new Promise((resolve) => {
    if (!processes.some((x) => x.name === name)) return resolve({ ok: false, error: 'Unknown process' });
    execFile('pm2', ['restart', name], { timeout: 30000 }, (err) => {
      resolve(err ? { ok: false, error: err.message.split('\n')[0] } : { ok: true });
      setTimeout(pollPm2, 1500);
    });
  });
}

// ---------- shortcuts (Quick access) ----------

function detectSites() {
  const domains = [];
  try {
    for (const f of fs.readdirSync('/etc/nginx/sites-enabled')) {
      const txt = fs.readFileSync(path.join('/etc/nginx/sites-enabled', f), 'utf8');
      if (!/listen\s+(\[::\]:)?443/.test(txt)) continue;
      for (const m of txt.matchAll(/server_name\s+([^;]+);/g)) {
        for (const d of m[1].trim().split(/\s+/)) if (d !== '_' && !d.startsWith('www.') && !domains.includes(d)) domains.push(d);
      }
    }
  } catch {}
  return domains.map((d, i) => ({ id: 's' + i, label: d, url: 'https://' + d + '/' }));
}

export function readLinks() {
  try { return JSON.parse(fs.readFileSync(LINKS_FILE, 'utf8')); } catch {}
  const seeded = [...detectSites(), ...(cfg.PUBLIC_URL ? [{ id: 'c0', label: 'Orbit', url: cfg.PUBLIC_URL.replace(/\/$/, '') + cfg.BASE + '/' }] : [])];
  return seeded;
}

export function writeLinks(list) {
  if (!Array.isArray(list) || list.length > 60) throw new Error('bad list');
  const clean = list.map((l) => {
    const url = new URL(String(l.url || '').trim()); // throws on garbage
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('bad url');
    return { id: String(l.id || crypto.randomBytes(5).toString('hex')).slice(0, 24), label: String(l.label || url.hostname).trim().slice(0, 40), url: url.href };
  });
  fs.writeFileSync(LINKS_FILE, JSON.stringify(clean, null, 2));
  checkSites();
  return clean;
}

export const siteStatus = {}; // url -> { ok, code, ms, at, error }
let checking = false;
export async function checkSites() {
  if (checking) return;
  checking = true;
  const links = readLinks();
  await Promise.all(links.map(async (l) => {
    const t0 = Date.now();
    try {
      const r = await fetch(l.url, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(10000), headers: { 'User-Agent': 'claude-code-monitor/1.0' } });
      await r.arrayBuffer().catch(() => {});
      siteStatus[l.url] = { ok: r.status < 500, code: r.status, ms: Date.now() - t0, at: Date.now() };
    } catch (e) {
      siteStatus[l.url] = { ok: false, code: 0, ms: Date.now() - t0, at: Date.now(), error: e.cause?.code || e.name || 'error' };
    }
  }));
  checking = false;
  emit({ type: 'sites', status: siteStatus });
}

export function snapshot() {
  return { type: 'monitor_init', history, sys: lastSys, processes: processes.map(({ out, err, ...p }) => p), sites: siteStatus };
}

export function start() {
  tick();
  setInterval(tick, TICK_MS);
  setInterval(pollPm2, 5000);
  checkSites();
  setInterval(checkSites, SITE_CHECK_MS);
}

export function poke() { pollPm2(); }
