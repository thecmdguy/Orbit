// Orbit explain service (pm2 orbit-explain, 127.0.0.1:3025).
// nginx serves it at /orbit/api/explain behind an auth_request to Orbit's login check,
// so it runs separately and the main Orbit server never needs a restart for explain changes.
// The actual explanation logic lives in explain.mjs (direct Messages API, SDK fallback).
import http from 'node:http';
import cfg from './config.mjs';
import { explain } from './explain.mjs';

const PORT = cfg.PORTS.explain;


function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (url.pathname !== cfg.BASE + '/api/explain' && url.pathname !== '/api/explain') return send(res, 404, '{"error":"not found"}');
    if (req.method !== 'POST' || !cfg.originOk(req.headers.origin || '')) return send(res, 403, '{"error":"forbidden"}');
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 8192) req.destroy(); });
    req.on('end', async () => {
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch { return send(res, 400, '{"error":"bad json"}'); }
      try {
        const out = await explain({ tool: String(body.tool || '').slice(0, 80), input: body.input, request: body.request });
        send(res, 200, JSON.stringify(out));
      } catch (e) {
        send(res, 502, JSON.stringify({ error: String(e.message || e) }));
      }
    });
  } catch (e) {
    send(res, 500, JSON.stringify({ error: String(e.message || e) }));
  }
});

server.listen(PORT, cfg.HOST, () => console.log(`orbit-explain on ${cfg.HOST}:${PORT}`));
