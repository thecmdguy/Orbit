// Plain-language explanations of what Claude is doing, for non-technical people.
// One short Haiku answer per action; results are cached by tool + input.
// Primary path: a direct Messages API call with the CLI's OAuth token (fast, ~1.5s).
// Fallback: the Agent SDK query() (slower cold start) if the direct call fails.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { query } from '@anthropic-ai/claude-agent-sdk';
import cfg from './config.mjs';

const CLAUDE_BIN = cfg.CLAUDE_BIN;
const CREDS = cfg.CREDS;
const MODEL = 'claude-haiku-5-5';
const cache = new Map(); // key -> result (insertion order = LRU-ish)
const inflight = new Map(); // key -> promise
let running = 0;
const waiters = [];

const SYSTEM = `You are the explainer inside Orbit, a web app where a non-technical website owner watches an AI assistant (Claude) work on their server.
Explain ONE action the assistant is about to take or just took, in plain, friendly language a non-technical person understands.
Avoid jargon; if a technical word is unavoidable, explain it in a few words. Never invent details that are not in the action.
Reply with ONLY a JSON object, no markdown, in this exact shape:
{"title": "3-7 word plain description", "what": "1-2 sentences: what this action does", "why": "1 sentence: why the assistant is most likely doing it, based on the owner's request", "risk": "safe" | "changes" | "risky", "risk_note": "1 short sentence explaining the risk level"}
Risk levels: "safe" = only looks at or reads things; "changes" = modifies files, settings or data in a normal, expected way; "risky" = could take a site offline, delete or overwrite data, restart services, change permissions, or expose passwords/keys.`;

async function slot() {
  if (running < 2) { running++; return; }
  await new Promise((r) => waiters.push(r));
  running++;
}
function release() { running--; waiters.shift()?.(); }

function parse(text) {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) throw new Error('No explanation came back');
  const j = JSON.parse(m[0]);
  const risk = ['safe', 'changes', 'risky'].includes(j.risk) ? j.risk : 'changes';
  return { title: String(j.title || '').slice(0, 120), what: String(j.what || '').slice(0, 600), why: String(j.why || '').slice(0, 400), risk, riskNote: String(j.risk_note || '').slice(0, 300) };
}

function oauthToken() {
  const o = JSON.parse(fs.readFileSync(CREDS, 'utf8')).claudeAiOauth;
  if (!o?.accessToken) throw new Error('no oauth token');
  if (o.expiresAt && o.expiresAt < Date.now() + 30000) throw new Error('oauth token expired');
  return o.accessToken;
}

// Fast path: direct Messages API with the subscription OAuth token.
async function viaApi(prompt) {
  const token = oauthToken();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        Authorization: 'Bearer ' + token,
        'anthropic-beta': 'oauth-2025-04-20',
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        'User-Agent': 'orbit-explain/1.0',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 400,
        thinking: { type: 'disabled' },
        output_config: { effort: 'low' },
        // The OAuth (subscription) path requires the Claude Code identity as the first system block.
        system: [{ type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." }, { type: 'text', text: SYSTEM }],
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error('api ' + r.status + ' ' + (j?.error?.message || ''));
    const text = (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    return parse(text);
  } finally {
    clearTimeout(timer);
  }
}

// Fallback: the Agent SDK (spawns the CLI; slower cold start, but no OAuth-token assumptions).
async function viaSdk(prompt) {
  const q = query({
    prompt,
    options: {
      pathToClaudeCodeExecutable: CLAUDE_BIN, model: MODEL, tools: [], maxTurns: 1, settingSources: [],
      persistSession: false, systemPrompt: SYSTEM, cwd: '/tmp', effort: 'low',
    },
  });
  let result = null;
  const timer = setTimeout(() => q.interrupt?.().catch(() => {}), 45000);
  try {
    for await (const m of q) if (m.type === 'result') result = m;
  } finally {
    clearTimeout(timer);
  }
  if (!result || result.subtype !== 'success') throw new Error('The explainer did not answer');
  return parse(result.result);
}

export async function explain({ tool, input, request }) {
  const payload = JSON.stringify(input ?? {}).slice(0, 4000);
  const key = crypto.createHash('sha1').update(String(tool) + '\0' + payload).digest('hex');
  if (cache.has(key)) return cache.get(key);
  if (inflight.has(key)) return inflight.get(key);
  const job = (async () => {
    await slot();
    try {
      const prompt = `The owner asked the assistant: ${JSON.stringify(String(request || '(not available)').slice(0, 600))}\n\nThe action:\nTool: ${tool}\nInput: ${payload}`;
      let out;
      try {
        out = await viaApi(prompt);
      } catch (e) {
        console.log('explain: api path failed, falling back to sdk —', e.message);
        out = await viaSdk(prompt);
      }
      cache.set(key, out);
      if (cache.size > 800) cache.delete(cache.keys().next().value);
      return out;
    } finally {
      release();
      inflight.delete(key);
    }
  })();
  inflight.set(key, job);
  return job;
}
