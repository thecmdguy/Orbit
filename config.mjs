// Central configuration for Orbit. Everything that used to be hardcoded (paths,
// ports, origins, the Claude CLI location) is resolved here from environment
// variables, with sensible defaults so a fresh clone runs with little or no setup.
//
// Load order: a `.env` file in the repo root (if present) is read first, then the
// process environment overrides it. See `.env.example` for every supported key.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.dirname(fileURLToPath(import.meta.url));

// --- tiny .env loader (no dependency) ---
(() => {
  const f = path.join(ROOT, '.env');
  if (!fs.existsSync(f)) return;
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const key = m[1];
    let val = m[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = val;
  }
})();

const env = process.env;
const HOME = env.HOME || os.homedir();
const num = (v, d) => (v !== undefined && v !== '' ? parseInt(v, 10) : d);

// Where the app is mounted (the URL path prefix). Served directly at this prefix,
// and reverse-proxied under the same prefix by nginx. The frontend expects /claude.
export const BASE = env.ORBIT_BASE ?? '/claude';

// Loopback host the services bind to (nginx talks to them here).
export const HOST = env.ORBIT_HOST || '127.0.0.1';

// Public base URL (used only to seed the Monitor's "this site" shortcut). Optional.
export const PUBLIC_URL = env.ORBIT_PUBLIC_URL || '';

// Ports for the main server and the five side services.
export const PORTS = {
  server: num(env.ORBIT_PORT, 3020),
  usage: num(env.ORBIT_USAGE_PORT, 3021),
  models: num(env.ORBIT_MODELS_PORT, 3022),
  skills: num(env.ORBIT_SKILLS_PORT, 3023),
  push: num(env.ORBIT_PUSH_PORT, 3024),
  explain: num(env.ORBIT_EXPLAIN_PORT, 3025),
};

// Internal URL of the main server, used by side services (push, etc.).
export const SERVER_URL = `http://${HOST}:${PORTS.server}${BASE}`;
// Origin header side services present when they open a WebSocket to the main server.
// Must pass originOk() below. Falls back to the loopback origin for local setups.
export const INTERNAL_ORIGIN = (env.ORBIT_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean)[0] || `http://${HOST}:${PORTS.server}`;
// Contact email embedded in Web Push VAPID details.
export const PUSH_EMAIL = env.ORBIT_PUSH_EMAIL || 'admin@example.com';

// Allowed browser origins for state-changing requests and WebSocket upgrades.
// Comma-separated list in ORBIT_ORIGINS, e.g. "https://orbit.example.com".
// If unset, localhost/127.0.0.1 on any port is allowed (good for local dev).
const ORIGIN_LIST = (env.ORBIT_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
export const ALLOWED_ORIGINS = ORIGIN_LIST;
export function originOk(origin) {
  if (!origin) return false;
  if (ORIGIN_LIST.length) return ORIGIN_LIST.includes(origin);
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

// The directory Claude works in (its cwd for every chat).
export const WORKDIR = env.ORBIT_WORKDIR || HOME;

// Path to the Claude Code CLI executable (shares its login/OAuth token).
// Default: ~/.local/bin/claude if present, otherwise rely on PATH ("claude").
function resolveClaudeBin() {
  if (env.ORBIT_CLAUDE_BIN) return env.ORBIT_CLAUDE_BIN;
  const local = path.join(HOME, '.local/bin/claude');
  return fs.existsSync(local) ? local : 'claude';
}
export const CLAUDE_BIN = resolveClaudeBin();

// The Claude CLI's own files (credentials + session transcripts).
export const CLAUDE_DIR = env.ORBIT_CLAUDE_DIR || path.join(HOME, '.claude');
export const CREDS = env.ORBIT_CREDS || path.join(CLAUDE_DIR, '.credentials.json');
export const PROJECTS = env.ORBIT_PROJECTS || path.join(CLAUDE_DIR, 'projects');
// Claude encodes a cwd into a project dir name by replacing "/" with "-".
export function projectDirFor(workdir = WORKDIR) {
  return path.join(PROJECTS, workdir.replace(/\//g, '-'));
}

// Orbit's own writable state (config, password, quick commands, links, push subs,
// per-chat change logs, model data). Keep OUTSIDE the repo so it's never committed.
export const DATA_DIR = env.ORBIT_DATA_DIR || path.join(HOME, '.orbit');
export const CONFIG_FILE = env.ORBIT_CONFIG_FILE || path.join(DATA_DIR, 'config.json');
export const QUICK_FILE = path.join(DATA_DIR, 'quick.json');
export const LINKS_FILE = path.join(DATA_DIR, 'links.json');
export const PUSH_FILE = path.join(DATA_DIR, 'push.json');
export const CHANGES_DIR = path.join(DATA_DIR, 'changes');
export const MODELS_DATA = env.ORBIT_MODELS_DATA || path.join(DATA_DIR, 'models-data');

// Uploads, trash, and site backups.
export const UPLOADS = env.ORBIT_UPLOADS_DIR || path.join(DATA_DIR, 'uploads');
export const TRASH = env.ORBIT_TRASH_DIR || path.join(DATA_DIR, 'trash');
export const BACKUP_ROOT = env.ORBIT_BACKUP_DIR || path.join(DATA_DIR, 'backups', 'sites');

// Ensure the writable dirs exist.
for (const d of [DATA_DIR, CHANGES_DIR, MODELS_DATA, UPLOADS, TRASH, BACKUP_ROOT]) {
  try { fs.mkdirSync(d, { recursive: true }); } catch {}
}

export default {
  ROOT, BASE, HOST, PUBLIC_URL, PORTS, SERVER_URL, ALLOWED_ORIGINS, originOk,
  WORKDIR, CLAUDE_BIN, CLAUDE_DIR, CREDS, PROJECTS, projectDirFor,
  DATA_DIR, CONFIG_FILE, QUICK_FILE, LINKS_FILE, PUSH_FILE,
  CHANGES_DIR, MODELS_DATA, UPLOADS, TRASH, BACKUP_ROOT,
};
