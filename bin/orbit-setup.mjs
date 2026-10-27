#!/usr/bin/env node
// First-run setup for Orbit: creates the login password.
//
// Security model:
//   - The password is NEVER stored. Only a scrypt hash (with a random per-install salt)
//     and the scrypt parameters are written to config.json, which is created 0600.
//   - A random 256-bit "service token" is also generated so the local push service can
//     authenticate to the main server WITHOUT any plaintext password on disk.
//
// Usage:
//   node bin/orbit-setup.mjs                 # prompts for a password (input hidden)
//   node bin/orbit-setup.mjs "my password"   # password as an argument
//   ORBIT_PASSWORD="my password" node bin/orbit-setup.mjs
import fs from 'node:fs';
import crypto from 'node:crypto';
import readline from 'node:readline';
import cfg from '../config.mjs';

// scrypt work factors (memory-hard). N must be a power of two.
const SCRYPT = { N: 1 << 15, r: 8, p: 1, keylen: 64, maxmem: 128 * 1024 * 1024 };

function write(file, data, mode = 0o600) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, data, { mode });
  try { fs.chmodSync(tmp, mode); } catch {}
  fs.renameSync(tmp, file);
}

// Reject obviously weak passwords. Require length >= 10 and some variety.
function weak(pw) {
  if (!pw || pw.length < 10) return 'at least 10 characters';
  if (/^(.)\1+$/.test(pw)) return 'not a single repeated character';
  const common = ['password', '1234567890', 'qwertyuiop', 'orbit12345', 'claudecode'];
  if (common.includes(pw.toLowerCase())) return 'not a common password';
  return null;
}

function save(pw) {
  const why = weak(pw);
  if (why) { console.error(`\nPassword too weak — choose ${why}.`); process.exit(1); }
  const salt = crypto.randomBytes(16).toString('hex');
  const passHash = crypto.scryptSync(String(pw), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: SCRYPT.maxmem }).toString('hex');
  const serviceToken = crypto.randomBytes(32).toString('hex');
  const existing = (() => { try { return JSON.parse(fs.readFileSync(cfg.CONFIG_FILE, 'utf8')); } catch { return {}; } })();
  write(cfg.CONFIG_FILE, JSON.stringify({ salt, passHash, scrypt: SCRYPT, serviceToken: existing.serviceToken || serviceToken }, null, 2));
  // Remove any legacy plaintext password file from older versions.
  try { fs.unlinkSync(cfg.DATA_DIR + '/password'); } catch {}
  console.log('\n✓ Orbit is set up (password hashed with scrypt; no plaintext stored).');
  console.log('  config:   ' + cfg.CONFIG_FILE + '  (0600)');
  console.log('  data dir: ' + cfg.DATA_DIR);
  console.log('\nNext: start Orbit with  npm start   (or:  pm2 start ecosystem.config.cjs)');
  console.log('Then open ' + (cfg.PUBLIC_URL || `http://localhost:${cfg.PORTS.server}`) + cfg.BASE + '/\n');
}

// Hidden prompt (no echo) for TTY input.
function askHidden(query) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const onData = (ch) => { ch = String(ch); if (ch === '\n' || ch === '\r' || ch === '\u0004') return; process.stdout.write('\x1b[2K\x1b[200D' + query); };
    process.stdout.write(query);
    process.stdin.on('data', onData);
    rl.question('', (ans) => { process.stdin.removeListener('data', onData); rl.close(); process.stdout.write('\n'); resolve(ans); });
    rl._writeToOutput = () => {}; // suppress echo
  });
}

const fromArg = process.argv[2];
const fromEnv = process.env.ORBIT_PASSWORD;
if (fromArg || fromEnv) {
  save((fromArg || fromEnv).trim());
} else if (process.stdin.isTTY) {
  const pw = (await askHidden('Choose an Orbit login password (min 10 chars): ')).trim();
  const again = (await askHidden('Confirm password: ')).trim();
  if (pw !== again) { console.error('\nPasswords did not match.'); process.exit(1); }
  save(pw);
} else {
  console.error('No password given. Run:  node bin/orbit-setup.mjs "your password"');
  process.exit(1);
}
