# Installing Orbit

Two paths:

- **A. Local / quick look** — run on your own machine, no nginx. Core features work.
- **B. VPS / production** — domain, TLS, nginx, pm2, all features.

---

## Prerequisites (both paths)

1. **Node.js ≥ 18.17** — `node -v`.
2. **Claude Code CLI, installed and logged in.** Orbit launches it, so it must work from the
   same user's shell first:
   ```bash
   npm install -g @anthropic-ai/claude-code
   claude            # log in once (Anthropic account or API key)
   claude -p "say hi"   # confirm it answers
   ```
   Orbit reuses this login (the CLI's token in `~/.claude`). No API key is configured in Orbit itself.
3. **Build tools for `node-pty`** (the terminal). On Debian/Ubuntu:
   ```bash
   sudo apt-get install -y build-essential python3
   ```

---

## A. Local / quick look

```bash
git clone https://github.com/thecmdguy/Orbit.git
cd orbit
npm install
npm run setup                 # choose a login password
npm start                     # starts all six services; Ctrl-C stops them
```

Open **http://localhost:3020/orbit/**.

- Works out of the box: **chat, monitor, editor, sites, terminal**.
- The **usage widget, multi-model, skills, push, and fast explain** endpoints are served by the
  side services behind nginx; on a bare `localhost` run their browser calls simply no-op. If you
  want them locally, run nginx with the provided config pointing at `127.0.0.1` (same as path B,
  minus the public domain), or just use path B on a VPS.

To run only the main server: `npm run start:server`.

### Optional local config
Copy `.env.example` to `.env` and edit. Common ones:
```ini
ORBIT_PORT=3020
ORBIT_WORKDIR=/home/me/projects     # the directory Claude works in
ORBIT_DATA_DIR=/home/me/.orbit      # where Orbit keeps its state
```

---

## B. VPS / production (full features)

Assumes Ubuntu/Debian with a domain pointed at the server. Replace `orbit.example.com`.

### 1. Get the code and dependencies
```bash
sudo mkdir -p /opt/orbit && sudo chown "$USER" /opt/orbit
git clone https://github.com/thecmdguy/Orbit.git /opt/orbit
cd /opt/orbit
npm install --omit=dev
```

### 2. Configure
```bash
cp .env.example .env
```
Edit `.env` — the important ones for production:
```ini
ORBIT_PUBLIC_URL=https://orbit.example.com
ORBIT_ORIGINS=https://orbit.example.com     # REQUIRED: locks down POSTs + WebSockets
ORBIT_WORKDIR=/opt/orbit-work               # where Claude operates (create it)
ORBIT_DATA_DIR=/opt/orbit/.data             # Orbit's state (kept out of git)
```
Then create your password:
```bash
npm run setup
```

### 3. Run under pm2
```bash
sudo npm install -g pm2
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup        # run the command it prints, to survive reboots
```
Six processes start: `orbit-server`, `orbit-usage`, `orbit-models`, `orbit-skills`,
`orbit-push`, `orbit-explain`. They bind to `127.0.0.1` only.

> Alternative without pm2: `npm start` under systemd (see the unit at the bottom).

### 4. TLS certificate
```bash
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot certonly --nginx -d orbit.example.com
```

### 5. nginx
```bash
sudo cp nginx/orbit.conf.example /etc/nginx/sites-available/orbit
sudoedit /etc/nginx/sites-available/orbit     # replace orbit.example.com and /path/to/orbit
sudo ln -s /etc/nginx/sites-available/orbit /etc/nginx/sites-enabled/orbit
sudo nginx -t && sudo systemctl reload nginx
```
`/path/to/orbit` must be the absolute repo path (e.g. `/opt/orbit`) so nginx can serve the PWA
assets. Ports in the config must match your `.env`.

### 6. Firewall
Expose only 80/443; keep the service ports private:
```bash
sudo ufw allow 'Nginx Full'
sudo ufw enable
```

Open **https://orbit.example.com/orbit/** and log in.

---

## Updating

```bash
cd /opt/orbit
git pull
npm install --omit=dev
pm2 restart ecosystem.config.cjs     # or: restart your systemd unit
```
Your `.env`, password, and `.data` are untouched (they're gitignored).

---

## systemd alternative (instead of pm2)

`/etc/systemd/system/orbit.service`:
```ini
[Unit]
Description=Orbit
After=network.target

[Service]
Type=simple
User=youruser
WorkingDirectory=/opt/orbit
EnvironmentFile=/opt/orbit/.env
ExecStart=/usr/bin/node bin/orbit-start.mjs
Restart=on-failure

[Install]
WantedBy=multi-user.target
```
```bash
sudo systemctl daemon-reload && sudo systemctl enable --now orbit
```

---

## Troubleshooting

- **Login page loads but chat does nothing / errors** — the Claude CLI isn't logged in for this
  user. Run `claude -p "hi"` from the same account and sign in, then retry.
- **403 on sending a message / "Bad origin"** — `ORBIT_ORIGINS` doesn't match the URL in your
  browser. Set it to the exact origin (scheme + host, no path) and restart.
- **WebSocket won't connect** — same origin issue, or your proxy isn't forwarding the `Upgrade`
  header. The nginx example already does; a CDN in front must allow WebSockets.
- **Usage widget / skills / push missing** — those are side services; confirm all six processes
  are up (`pm2 ls`) and that nginx has the `/orbit/api/*` location blocks.
- **Terminal fails to start** — `node-pty` needs `build-essential` + `python3` at install time.
- **Multi-model picker doesn't open** — the multi-model UI is experimental and ships without its
  client script; the rest of Orbit is unaffected.
- **Push notifications** — require HTTPS. On Android they work in Chrome (installed or not); on iOS
  they work only after "Add to Home Screen" (an Apple requirement for web push).
