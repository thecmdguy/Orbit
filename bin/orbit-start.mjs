#!/usr/bin/env node
// Starts Orbit's six processes together and streams their logs with a prefix.
// A dependency-free alternative to pm2 for local runs and simple VPS setups.
// (For the side services to be reachable from the browser you still need the
// nginx config in nginx/orbit.conf.example — the main server works on its own.)
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const services = [
  ['server', 'server.mjs'],
  ['usage', 'usage.mjs'],
  ['models', 'models.mjs'],
  ['skills', 'skills.mjs'],
  ['push', 'push.mjs'],
  ['explain', 'explain-service.mjs'],
];

const children = [];
for (const [name, file] of services) {
  const child = spawn(process.execPath, [path.join(ROOT, file)], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  const tag = `[${name}]`.padEnd(10);
  const pipe = (stream, out) => stream.on('data', (d) => d.toString().split('\n').filter(Boolean).forEach((l) => out(`${tag} ${l}`)));
  pipe(child.stdout, console.log);
  pipe(child.stderr, console.error);
  child.on('exit', (code) => console.error(`${tag} exited (${code}).`));
  children.push(child);
}

const stop = () => { for (const c of children) { try { c.kill('SIGTERM'); } catch {} } process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
