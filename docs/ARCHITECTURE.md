# Architecture

Orbit is a small set of **plain Node.js ESM** services with **no build step**. The frontend is
static HTML/CSS/JS in `public/`. There is no framework and no bundler.

## Processes

| Process | File | Port* | Role |
|---|---|---|---|
| **Main server** | `server.mjs` | 3020 | Login, the chat UI, the chat/terminal WebSockets, and the HTTP APIs for the editor, monitor, and sites. Imports `monitor.mjs`, `backups.mjs`, `fsapi.mjs`, `explain.mjs`. |
| Usage | `usage.mjs` | 3021 | Live Claude usage/limits widget. |
| Models | `models.mjs` | 3022 | Chat with non-Claude / local models (OpenAI-compatible, Ollama, …). *Experimental; ships without its client script.* |
| Skills | `skills.mjs` | 3023 | Install Claude Code skills from GitHub. |
| Push | `push.mjs` | 3024 | Web Push notifications; watches chats and fires alerts. |
| Explain | `explain-service.mjs` | 3025 | Hosts the plain-language "Explain" endpoint (`explain.mjs`). |

*All ports are configurable; see `.env.example`. Services bind to `127.0.0.1` by default.

Only the **main server** is required for the core experience (chat, terminal, editor, monitor,
sites). The other five are optional feature add-ons.

## How chat works

```
browser  ──WebSocket──>  server.mjs  ──@anthropic-ai/claude-agent-sdk──>  claude (CLI)
   ^                         |                                               |
   |   tool-approval         |   one long-lived query() per conversation     |
   └───  prompts  <──────────┘   canUseTool() relays approvals to the browser ┘
```

- The server launches the **Claude Code CLI already installed on the host** via the Agent SDK's
  `query()`, pointing `pathToClaudeCodeExecutable` at it. Orbit therefore **reuses the CLI's
  existing login** (the token in `~/.claude`) — there is no separate API key in Orbit.
- Each conversation is one long-lived `query()`; partial messages stream to the browser.
- When Claude wants to use a tool, `canUseTool()` sends a permission request to the browser and
  waits for Allow / Always-allow / Deny (unless a non-asking permission mode is active).
- Sessions are the CLI's own session files under `~/.claude/projects/<encoded-cwd>/`, so chats
  started in the terminal and in Orbit share one list.

## nginx and the login (`auth_request`)

The main server serves everything under its base path and enforces the login itself. The five
side services are separate processes, so in production **nginx** puts them behind the same login
using an `auth_request` subrequest to the main server (`/claude/api/quick`, a cheap authed
endpoint). See `nginx/orbit.conf.example`.

```
             ┌──────────────── nginx (443, TLS) ───────────────┐
browser ───> │  /claude/api/usage   ─auth_request─> :3020       │ ─> :3021
             │  /claude/api/skills  ─auth_request─> :3020       │ ─> :3023
             │  /claude/api/push    ─auth_request─> :3020       │ ─> :3024
             │  /claude/api/explain ─auth_request─> :3020       │ ─> :3025
             │  /claude/…  (everything else, incl. WebSockets)  │ ─> :3020
             └──────────────────────────────────────────────────┘
```

Orbit's own local processes that need to call the server (the push watcher) authenticate with a
**service token** header (`x-orbit-token`) instead of a password — see [SECURITY.md](../SECURITY.md).

## Configuration

Everything configurable lives in `config.mjs`, which reads environment variables (and a `.env`
file) with safe defaults. No path, port, origin, or domain is hardcoded. See `.env.example`.

## Where data lives

Nothing sensitive is in the repo. By default everything writable is under `~/.orbit`
(`ORBIT_DATA_DIR`):

```
~/.orbit/
  config.json     scrypt password hash + scrypt params + service token  (0600)
  quick.json      quick-command chips
  links.json      Monitor "quick access" shortcuts
  push.json       VAPID keys + push subscriptions                        (0600)
  changes/        per-edit before/after snapshots for the diff viewer
  models-data/    multi-model providers + conversations
  uploads/        attachments
  trash/          soft-deleted files and chats
  backups/sites/  site backup archives
```

The Claude CLI's own files stay in `~/.claude` (`ORBIT_CLAUDE_DIR`): `credentials` and session
transcripts (`projects/`).

## Frontend

`public/` is served directly (no build). Highlights:
- `chat.html` / `chat.js` / `chat.css` — the chat UI, routing (`#/monitor`, `#/sites`, …),
  permission cards, Explain popover, Auto-approve, settings.
- `monitor.js`, `sites.js`, `editor.js` (Monaco), `usage-widget.js`, `skills-ui.js`, `pwa-ui.js`.
- `pwa/` — manifest, service worker, icons, and iOS splash screens. Installable on iOS **and**
  Android (Chrome shows a native "Install app" prompt); splash screens are an iOS-only nicety.
- Third-party libs (xterm, marked, DOMPurify, Monaco) are served from `node_modules`.
