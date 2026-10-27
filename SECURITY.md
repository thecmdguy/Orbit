# Security

Orbit gives whoever logs in the ability to run commands and edit files **as the user the
Orbit processes run as**. Treat access to Orbit like SSH access to the box. This document
describes how Orbit protects that access and how to report problems.

## Authentication & the login password

- **The password is never stored.** `npm run setup` saves only a **scrypt** hash with a
  random 16-byte per-install salt, plus the scrypt parameters, to `config.json` (created
  `0600`). Default work factors: `N=32768, r=8, p=1, keylen=64` (memory-hard; tunable).
- Login verification uses `crypto.timingSafeEqual` (constant-time) against the stored hash.
- Setup **rejects weak passwords** (minimum 10 characters, no single-character or common
  passwords) and, on a TTY, reads the password with echo disabled and a confirmation prompt.
- **No plaintext password lives on disk.** Orbit's own local processes (the push service)
  authenticate to the main server with a random **256-bit service token** (also in
  `config.json`, `0600`), compared in constant time — not with the password.

## Sessions

- On success the server issues a random 256-bit session token and sets it as a cookie that is
  `HttpOnly`, `Secure`, and `SameSite=Strict`, with a 7-day TTL. Sessions are held in memory,
  so a restart logs everyone out.

## Brute-force protection

- Per-IP lockout: 5 failed logins → 15-minute block (keyed on `CF-Connecting-IP` /
  `X-Real-IP` when present).
- Global cap: 30 failures per 15 minutes across all IPs, to blunt rotating-IP attacks.
- Each failed attempt is delayed ~800 ms before responding.

## Request hardening

- **Origin allowlist** (`ORBIT_ORIGINS`): every state-changing request (POST/PUT/DELETE) and
  every WebSocket upgrade must present an allowed `Origin`. If unset, only `localhost` /
  `127.0.0.1` are allowed (dev only) — **always set it in production**.
- All API routes are behind the login; unauthenticated requests get a bare `404` (endpoints
  aren't revealed).
- Response headers: `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: no-referrer`, `Strict-Transport-Security`, `X-Robots-Tag: noindex`,
  `Cache-Control: no-store`.

## Deploying safely

- **Serve over HTTPS only.** The session cookie is `Secure`; without TLS you can't log in from
  a real browser (and your traffic would be in the clear). Use the nginx + certbot setup in
  [INSTALL.md](INSTALL.md).
- **Bind services to loopback.** The defaults listen on `127.0.0.1`; expose only nginx (80/443)
  and firewall the service ports (3020–3025).
- **Never commit secrets.** `config.json`, `.env`, `push.json`, uploads, and backups are all in
  `.gitignore`. Verify with `git status` before your first push.
- The **Auto-approve** toggle disables tool prompts entirely — only use it while supervising.
- Pick a long, unique password. Anyone with it has full shell-level control of the host.

## Reporting a vulnerability

Please **do not** open a public issue for security problems. Email the maintainer (see the
repository's profile) with details and steps to reproduce. You'll get an acknowledgement and a
fix timeline.
