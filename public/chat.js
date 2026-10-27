// Chat UI for Orbit. Talks to /claude/chat-ws; renders Agent SDK messages
// (live) and transcript messages (history) through the same block renderer.
const $ = (s, el = document) => el.querySelector(s);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

const messagesEl = $('#messages'), scrollEl = $('#scroll'), inputEl = $('#input');
const sendBtn = $('#sendBtn'), stopBtn = $('#stopBtn'), workingEl = $('#working');

marked.setOptions({ gfm: true, breaks: true });
function md(text) {
  const div = el('div', 'prose');
  div.innerHTML = DOMPurify.sanitize(marked.parse(text || ''));
  div.querySelectorAll('a').forEach((a) => { a.target = '_blank'; a.rel = 'noopener noreferrer'; });
  div.querySelectorAll('pre').forEach((pre) => {
    const b = el('button', 'copy', 'Copy');
    b.onclick = () => { navigator.clipboard.writeText(pre.innerText.replace(/Copy$/, '')); b.textContent = 'Copied'; setTimeout(() => (b.textContent = 'Copy'), 1200); };
    pre.appendChild(b);
  });
  return div;
}

// ---------- state ----------
let ws, retry = 0;
let state = { sessionId: null, busy: false, mode: 'default' };
let pendingMode = 'default';            // mode chosen before the first message of a new chat
const toolCards = new Map();            // tool_use_id -> card element
const streamBlocks = new Map();         // `${msgId}:${index}` -> { el, text, final }
let curMsgId = null;
let stickToBottom = true;

// ---------- scrolling ----------
scrollEl.addEventListener('scroll', () => {
  stickToBottom = scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight < 80;
});
function autoscroll(force) { if (force || stickToBottom) requestAnimationFrame(() => (scrollEl.scrollTop = scrollEl.scrollHeight)); }

// ---------- rendering ----------
function showEmpty(on) { $('#empty').hidden = !on; }

function assistantContainer() {
  // consecutive assistant output (text + tools) groups under one .msg.assistant
  const last = messagesEl.lastElementChild;
  if (last && last.classList.contains('assistant')) return last;
  const m = el('div', 'msg assistant');
  messagesEl.appendChild(m);
  return m;
}

function toolsGroup(container) {
  const last = container.lastElementChild;
  if (last && last.classList.contains('tools')) return last;
  const g = el('div', 'tools');
  container.appendChild(g);
  return g;
}

function cleanUserText(t) {
  const cmd = t.match(/<command-name>\s*([^<]+)<\/command-name>/);
  if (cmd) {
    const args = (t.match(/<command-args>([\s\S]*?)<\/command-args>/) || [])[1] || '';
    return { cmd: (cmd[1].trim() + ' ' + args.trim()).trim() };
  }
  if (/^\s*<(local-command-stdout|local-command-stderr|command-message|local-command-caveat)/.test(t)) return null;
  t = t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
  if (!t || t.startsWith('[Request interrupted')) return t ? { note: 'Interrupted' } : null;
  return { text: t };
}

// attachment references travel in the message text as one line each, so Claude
// knows where the file is and the UI can turn them back into chips
const ATT_RE = /^\[Attached (file|image): (.+?) \((.+?)\)\]$/gm;

function fmtSize(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

function extOf(name) { const m = /\.([a-z0-9]{1,5})$/i.exec(name); return m ? m[1] : 'file'; }

function fileChip(name, sub) {
  const box = el('div', 'att-file');
  const meta = el('div', 'att-meta');
  meta.append(el('b', null, name), el('span', null, sub));
  box.append(el('div', 'att-ico', extOf(name)), meta);
  return box;
}

function openLightbox(src) {
  const lb = el('div'); lb.id = 'lightbox';
  const img = el('img'); img.src = src;
  lb.append(img);
  lb.onclick = () => lb.remove();
  document.body.append(lb);
}

function addUser(text, images = []) {
  const files = [];
  text = String(text || '').replace(ATT_RE, (_, kind, p, size) => { if (kind === 'file') files.push({ name: p.split('/').pop(), path: p, size }); return ''; }).trim();
  const c = text ? cleanUserText(text) : null;
  if (!c && !images.length && !files.length) return;
  if (c && c.note) return addNote(c.note);
  showEmpty(false);
  const m = el('div', 'msg user');
  if (images.length) {
    const row = el('div', 'u-imgs' + (images.length > 1 ? ' many' : ''));
    for (const src of images) { const img = el('img'); img.src = src; img.alt = 'Attached image'; img.onclick = () => openLightbox(src); row.append(img); }
    m.append(row);
  }
  if (files.length) {
    const row = el('div', 'u-files');
    for (const f of files) { const chip = fileChip(f.name, f.size); chip.title = f.path; row.append(chip); }
    m.append(row);
  }
  if (c) m.append(el('div', 'bubble' + (c.cmd ? ' cmd' : ''), c.cmd || c.text));
  messagesEl.appendChild(m);
}

function addNote(text, err) { messagesEl.appendChild(el('div', 'note' + (err ? ' err' : ''), text)); }

function short(s, n = 120) { s = String(s ?? ''); return s.length > n ? s.slice(0, n) + '…' : s; }

function toolSummary(name, i) {
  i = i || {};
  switch (name) {
    case 'Bash': return i.description || i.command;
    case 'Read': case 'Write': case 'Edit': case 'MultiEdit': case 'NotebookEdit': return (i.file_path || i.notebook_path || '').replace(/^\/root\//, '~/');
    case 'Grep': return i.pattern + (i.path ? '  in ' + i.path : '');
    case 'Glob': return i.pattern;
    case 'WebFetch': return i.url;
    case 'WebSearch': return i.query;
    case 'Task': case 'Agent': return i.description;
    case 'TodoWrite': return (i.todos || []).length + ' items';
    default: {
      const v = Object.values(i).find((x) => typeof x === 'string');
      return v || '';
    }
  }
}

const TOOL_LABEL = { Bash: 'Run', Read: 'Read', Write: 'Write', Edit: 'Edit', MultiEdit: 'Edit', Grep: 'Search', Glob: 'Find files', WebFetch: 'Fetch', WebSearch: 'Web search', Task: 'Agent', Agent: 'Agent', TodoWrite: 'Todos' };

function renderToolInput(name, input) {
  const frag = document.createDocumentFragment();
  if (name === 'Bash') {
    frag.append(el('div', 'label', 'Command'), el('pre', 'mono', input.command));
  } else if (name === 'Edit' && input.old_string != null) {
    frag.append(el('div', 'label', 'Change'));
    const pre = el('pre', 'diff');
    input.old_string.split('\n').forEach((l) => pre.append(el('div', 'del', '- ' + l)));
    input.new_string.split('\n').forEach((l) => pre.append(el('div', 'add', '+ ' + l)));
    frag.append(pre);
  } else if (name === 'Write') {
    frag.append(el('div', 'label', 'Content'), el('pre', null, short(input.content, 6000)));
  } else if (name === 'TodoWrite') {
    const ul = el('ul', 'todos');
    (input.todos || []).forEach((t) => ul.append(el('li', t.status === 'completed' ? 'done' : t.status === 'in_progress' ? 'doing' : '', (t.status === 'completed' ? '✓ ' : t.status === 'in_progress' ? '▸ ' : '○ ') + (t.content || t.activeForm))));
    frag.append(ul);
  } else if (name === 'Read' || name === 'Glob' || name === 'Grep') {
    // the summary line says it all
  } else {
    frag.append(el('div', 'label', 'Input'), el('pre', null, short(JSON.stringify(input, null, 2), 6000)));
  }
  return frag;
}

function addToolUse(block, container) {
  window.Tasks?.onToolUse(block);
  if (toolCards.has(block.id)) return;
  const card = el('details', 'tool running');
  const sum = el('summary');
  sum.append(el('span', 'dot'), el('span', 'name', TOOL_LABEL[block.name] || block.name.replace(/^mcp__[^_]+__/, '')), el('span', 'arg', short(toolSummary(block.name, block.input), 200)), explainButton(block.name, block.input || {}), el('span', 'chev', '›'));
  const body = el('div', 'body');
  body.append(renderToolInput(block.name, block.input || {}));
  const fp = block.input?.file_path || block.input?.notebook_path;
  if (fp) {
    const links = el('div', 'tool-links');
    if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(block.name)) {
      const d = el('button', 'btn sm', 'View diff'); d.type = 'button';
      d.onclick = () => window.Editor?.openChange(block.id);
      links.append(d);
    }
    const o = el('button', 'btn sm', 'Open in editor'); o.type = 'button';
    o.onclick = () => window.Editor?.openFile(fp, block.input.offset || 1);
    links.append(o);
    body.append(links);
  }
  card.append(sum, body);
  if (block.name === 'TodoWrite') card.open = true;
  toolsGroup(container).append(card);
  toolCards.set(block.id, card);
}

function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (c.type === 'text' ? c.text : c.type === 'image' ? '[image]' : '')).join('\n');
  return '';
}

function addToolResult(block) {
  window.Tasks?.onToolResult(block, resultText(block.content));
  const card = toolCards.get(block.tool_use_id);
  if (!card) return;
  card.classList.remove('running');
  card.classList.add(block.is_error ? 'err' : 'ok');
  const text = resultText(block.content).trim();
  if (text && !card.querySelector('.result')) {
    const body = card.querySelector('.body');
    body.append(el('div', 'label', block.is_error ? 'Error' : 'Output'));
    const pre = el('pre', 'result', short(text, 8000));
    body.append(pre);
  }
}

function addAssistantText(text, msgId) {
  if (!text || !text.trim()) return;
  // finalize a block that was streamed for this message, if any
  for (const [k, b] of streamBlocks) {
    if (k.startsWith(msgId + ':') && !b.final) {
      b.final = true;
      const node = md(text);
      b.el.replaceWith(node);
      b.el = node;
      return;
    }
  }
  showEmpty(false);
  assistantContainer().append(md(text));
}

function renderBlocks(role, content, msgId) {
  if (typeof content === 'string') { if (role === 'user') addUser(content); else addAssistantText(content, msgId); return; }
  if (role === 'user') {
    // images + text sent together render as one bubble
    const imgs = [], texts = [];
    for (const b of content || []) {
      if (b.type === 'tool_result') addToolResult(b);
      else if (b.type === 'image' && b.source?.type === 'base64') imgs.push(`data:${b.source.media_type};base64,${b.source.data}`);
      else if (b.type === 'text') texts.push(b.text);
    }
    if (texts.length) { const t = texts.join('\n\n').replace(ATT_RE, '').trim(); if (t && !t.startsWith('<')) lastUserText = t; }
    if (imgs.length || texts.length) addUser(texts.join('\n\n'), imgs);
    return;
  }
  for (const b of content || []) {
    {
      if (b.type === 'text') addAssistantText(b.text, msgId);
      else if (b.type === 'tool_use') { showEmpty(false); addToolUse(b, assistantContainer()); }
    }
  }
}

// ---------- plain-language explanations ----------
// Instant, rule-based one-liners (no AI call) used for the live status line and the
// hover preview; the Explain button adds a short AI explanation on top.
const fname = (p) => String(p || '').split('/').pop() || 'a file';
const BASH_RULES = [
  [/^(sudo\s+)?rm\s/, 'Deleting files', 'risky'],
  [/^(sudo\s+)?(pm2|systemctl)\s+(restart|reload|stop|start)\b/, 'Restarting a website or app (it may be offline for a moment)', 'risky'],
  [/^(sudo\s+)?(kill|pkill|killall)\b/, 'Stopping a running program', 'risky'],
  [/^(sudo\s+)?(chmod|chown)\b/, 'Changing who is allowed to use some files', 'risky'],
  [/^(sudo\s+)?(reboot|shutdown)\b/, 'Restarting the whole server', 'risky'],
  [/\b(drop|truncate)\s+(table|database)\b/i, 'Deleting data from a database', 'risky'],
  [/^(sudo\s+)?nginx\s+-t\b/, 'Checking the web server settings for mistakes', 'safe'],
  [/^(sudo\s+)?(nginx\s+-s\s+reload|systemctl\s+reload\s+nginx)/, 'Applying new web server settings', 'changes'],
  [/^(sudo\s+)?certbot\b/, "Managing a site's security certificate (the padlock)", 'changes'],
  [/^pm2\s+(logs|log)\b/, "Reading an app's activity log", 'safe'],
  [/^pm2\s+(ls|list|status|jlist|describe|show|monit)\b/, 'Checking which apps are running', 'safe'],
  [/^(npm|pnpm|yarn)\s+(i|install|ci|add)\b/, "Installing the app's building blocks (dependencies)", 'changes'],
  [/^(npm|pnpm|yarn)\s+(run\s+)?build\b/, 'Building the website so the changes can go live', 'changes'],
  [/^(npm|pnpm|yarn)\s+(run\s+)?(test|lint)\b/, 'Running automatic checks on the code', 'safe'],
  [/^git\s+(status|diff|log|show|branch)\b/, 'Checking what changed in the code', 'safe'],
  [/^git\s+(commit|add)\b/, 'Saving a checkpoint of the code', 'changes'],
  [/^git\s+(push|pull|fetch|clone|checkout|reset|merge|rebase)\b/, 'Syncing the code with another copy', 'changes'],
  [/^(du|df)\b/, 'Checking how much disk space is used', 'safe'],
  [/^(free|uptime|top|htop|vmstat|ps|nproc|lscpu)\b/, 'Checking how busy the server is', 'safe'],
  [/^(ss|netstat|lsof)\b/, 'Checking which apps are listening for visitors', 'safe'],
  [/^(curl|wget|http)\b/, 'Visiting a web address to see how it responds', 'safe'],
  [/^(ping|dig|nslookup|host|traceroute)\b/, 'Checking that a website address can be reached', 'safe'],
  [/^(ls|tree|stat|file|realpath|pwd)\b/, 'Looking at which files are in a folder', 'safe'],
  [/^(cat|head|tail|less|more|wc|jq)\b/, 'Reading a file', 'safe'],
  [/^(grep|rg|ag|ugrep)\b/, 'Searching inside files for some text', 'safe'],
  [/^find\b.*-delete\b/, 'Finding and deleting files', 'risky'],
  [/^(find|locate|which|whereis)\b/, 'Looking for files', 'safe'],
  [/^sed\s+(-\w*i|--in-place)/, 'Editing text inside a file', 'changes'],
  [/^(mkdir|touch)\b/, 'Creating a new folder or file', 'changes'],
  [/^(cp|rsync)\b/, 'Copying files', 'changes'],
  [/^mv\b/, 'Moving or renaming files', 'changes'],
  [/^(tar|zip|unzip|gzip|gunzip|zstd)\b/, 'Packing or unpacking an archive (like a zip file)', 'changes'],
  [/^(pg_dump|mysqldump)\b/, 'Making a copy of a database', 'safe'],
  [/^(psql|mysql|sqlite3|redis-cli)\b/, 'Looking inside a database', 'changes'],
  [/^(journalctl|dmesg)\b/, "Reading the server's system log", 'safe'],
  [/^(systemctl\s+status|service\s+\S+\s+status)\b/, 'Checking whether a service is running', 'safe'],
  [/^(apt|apt-get|dnf|yum)\s+(install|upgrade|remove)\b/, 'Installing or updating server software', 'risky'],
  [/^(node|python3?|bash|sh|npx|tsx)\b/, 'Running a small program', 'changes'],
  [/^(echo|printf|cat\s*>|tee)\b.*>/, 'Writing text into a file', 'changes'],
  [/^(echo|printf|date|whoami|hostname|env|printenv)\b/, 'Checking a quick detail about the server', 'safe'],
];
const RISK_RANK = { safe: 0, changes: 1, risky: 2 };

function plainBash(cmd) {
  // look at each step of a chained command; report the most notable one
  const parts = String(cmd || '').split(/\s*(?:&&|\|\||;|\n)\s*/).map((x) => x.trim().replace(/^cd\s+\S+$/, '')).filter(Boolean);
  let best = null;
  for (const part of parts) {
    const first = part.split(/\s*\|\s*/)[0];
    for (const [re, text, risk] of BASH_RULES) {
      if (re.test(first) || re.test(part)) { if (!best || RISK_RANK[risk] > RISK_RANK[best.risk]) best = { text, risk }; break; }
    }
  }
  if (/(^|[^>&2])>\s*[^&\s]/.test(cmd) && (!best || best.risk === 'safe')) best = { text: best ? best.text + ' and saving the result to a file' : 'Writing to a file', risk: 'changes' };
  return best || { text: 'Running a command on the server', risk: 'changes' };
}

function plain(name, i) {
  switch (name) {
    case 'Bash': return plainBash(i.command);
    case 'Read': return { text: `Reading the file ${fname(i.file_path)}`, risk: 'safe' };
    case 'Write': return { text: `Writing the file ${fname(i.file_path)}`, risk: 'changes' };
    case 'Edit': case 'MultiEdit': return { text: `Changing part of ${fname(i.file_path)}`, risk: 'changes' };
    case 'NotebookEdit': return { text: `Changing the notebook ${fname(i.notebook_path)}`, risk: 'changes' };
    case 'Grep': return { text: `Searching the files for “${short(i.pattern, 40)}”`, risk: 'safe' };
    case 'Glob': return { text: 'Looking for files by name', risk: 'safe' };
    case 'WebFetch': { let h = i.url; try { h = new URL(i.url).host; } catch {} return { text: `Opening the web page ${h}`, risk: 'safe' }; }
    case 'WebSearch': return { text: `Searching the web for “${short(i.query, 50)}”`, risk: 'safe' };
    case 'Task': case 'Agent': return { text: `Asking a helper assistant to ${String(i.description || 'look into something').replace(/^./, (c) => c.toLowerCase())}`, risk: 'safe' };
    case 'TodoWrite': return { text: 'Updating its to-do list', risk: 'safe' };
    case 'AskUserQuestion': return { text: 'Asking you a question', risk: 'safe' };
    case 'ExitPlanMode': return { text: 'Showing you its plan', risk: 'safe' };
    default: return { text: name.startsWith('mcp__') ? `Using the ${name.split('__')[1]} connection` : `Using the ${name} tool`, risk: 'changes' };
  }
}

const RISK_LABEL = { safe: 'Just looking', changes: 'Makes changes', risky: 'Be careful' };
function riskBadge(risk) { const b = el('span', 'risk ' + risk, RISK_LABEL[risk]); return b; }

const explained = new Map(); // key -> Promise<result>
function fetchExplain(tool, input) {
  const key = tool + JSON.stringify(input).slice(0, 2000);
  if (!explained.has(key)) {
    explained.set(key, fetch('/claude/api/explain', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tool, input, request: lastUserText }) })
      .then(async (r) => { const j = await r.json(); if (!r.ok) throw new Error(j.error || 'Could not explain'); return j; })
      .catch((e) => { explained.delete(key); throw e; }));
  }
  return explained.get(key);
}

function explanationBody(tool, input, onDone) {
  const box = el('div', 'xp-body');
  const pl = plain(tool, input);
  const head = el('div', 'xp-head'); head.append(riskBadge(pl.risk), el('b', null, pl.text));
  const more = el('div', 'xp-more'); more.append(el('div', 'xp-skel'), el('div', 'xp-skel short'));
  box.append(head, more);
  fetchExplain(tool, input).then((x) => {
    head.replaceChildren(riskBadge(x.risk), el('b', null, x.title || pl.text));
    more.replaceChildren();
    const sec = (label, text) => { if (!text) return; const d = el('div', 'xp-sec'); d.append(el('span', null, label), el('p', null, text)); more.append(d); };
    sec('What it does', x.what);
    sec('Why', x.why);
    sec(x.risk === 'safe' ? 'Is it safe?' : x.risk === 'risky' ? 'Why be careful' : 'What changes', x.riskNote);
    onDone?.();
  }).catch((e) => { more.replaceChildren(el('p', 'xp-err', 'Couldn’t get a detailed explanation right now. ' + e.message)); onDone?.(); });
  return box;
}

// floating explain popover for tool cards
let xpPop = null, xpFor = null, xpPinned = false;
function closeExplain() { xpPop?.remove(); xpPop = null; xpFor = null; xpPinned = false; }
function placePop(btn) {
  const r = btn.getBoundingClientRect(), w = Math.min(360, innerWidth - 24);
  xpPop.style.width = w + 'px';
  xpPop.style.left = Math.max(12, Math.min(r.right - w, innerWidth - w - 12)) + 'px';
  const h = xpPop.offsetHeight;
  const below = r.bottom + 8 + h < innerHeight;
  xpPop.style.top = (below ? r.bottom + 8 : Math.max(12, r.top - h - 8)) + 'px';
}
function openExplain(btn, tool, input, pin) {
  if (xpFor === btn) { if (pin) { xpPinned = true; xpPop.classList.add('pinned'); } return; }
  closeExplain();
  xpPop = el('div', 'xp-pop' + (pin ? ' pinned' : ''));
  xpPop.setAttribute('role', 'dialog');
  const top = el('div', 'xp-top'); top.append(el('span', null, 'In plain words'));
  const x = el('button', 'xp-x', '×'); x.type = 'button'; x.setAttribute('aria-label', 'Close'); x.onclick = closeExplain;
  top.append(x);
  xpPop.append(top, explanationBody(tool, input, () => xpPop && placePop(btn)));
  const tech = el('details', 'xp-tech'); tech.append(el('summary', null, 'Technical details'), el('pre', null, tool === 'Bash' ? input.command : JSON.stringify(input, null, 2).slice(0, 2000)));
  tech.ontoggle = () => placePop(btn);
  xpPop.append(tech);
  xpPop.addEventListener('mouseleave', () => { if (!xpPinned) closeExplain(); });
  document.body.append(xpPop);
  xpFor = btn; xpPinned = !!pin;
  placePop(btn);
}
document.addEventListener('click', (e) => { if (xpPop && !xpPop.contains(e.target) && !e.target.closest('.xp-btn')) closeExplain(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeExplain(); });
scrollEl.addEventListener('scroll', () => { if (xpPop && !xpPinned) closeExplain(); }, { passive: true });

function explainButton(tool, input) {
  const b = el('button', 'xp-btn'); b.type = 'button';
  b.innerHTML = '<svg viewBox="0 0 20 20" width="13" height="13"><circle cx="10" cy="10" r="7.2" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 8a2 2 0 1 1 2.8 1.8c-.5.3-.8.7-.8 1.2v.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="10" cy="13.8" r=".9" fill="currentColor"/></svg><span>Explain</span>';
  b.title = plain(tool, input).text;
  b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); openExplain(b, tool, input, true); });
  // hover preview on devices with a mouse
  let t;
  b.addEventListener('mouseenter', () => { if (matchMedia('(hover: hover)').matches) t = setTimeout(() => openExplain(b, tool, input, false), 250); });
  b.addEventListener('mouseleave', (e) => { clearTimeout(t); if (!xpPinned && xpPop && !xpPop.contains(e.relatedTarget)) setTimeout(() => { if (!xpPinned && xpPop && !xpPop.matches(':hover')) closeExplain(); }, 120); });
  return b;
}

function explainInline(card, before, tool, input, btn) {
  if (card.querySelector('.xp-inline')) { card.querySelector('.xp-inline').remove(); card.querySelector('.plain-line')?.removeAttribute('hidden'); btn.textContent = 'Explain this'; return; }
  const box = el('div', 'xp-inline');
  const quick = card.querySelector('.plain-line');
  box.append(explanationBody(tool, input, () => { if (quick && box.querySelector('.xp-sec')) quick.hidden = true; autoscroll(); }));
  before.before(box);
  btn.textContent = 'Hide explanation';
}

// ---------- live streaming (partial messages) ----------
let rafPending = new Set();
function onStreamEvent(ev) {
  if (ev.type === 'message_start') curMsgId = ev.message.id;
  else if (ev.type === 'content_block_start' && ev.content_block.type === 'text') {
    showEmpty(false);
    const node = el('div', 'prose streaming');
    assistantContainer().append(node);
    streamBlocks.set(curMsgId + ':' + ev.index, { el: node, text: '', final: false });
  } else if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
    const key = curMsgId + ':' + ev.index;
    const b = streamBlocks.get(key);
    if (!b || b.final) return;
    b.text += ev.delta.text;
    if (!rafPending.has(key)) {
      rafPending.add(key);
      requestAnimationFrame(() => {
        rafPending.delete(key);
        if (b.final) return;
        const node = md(b.text);
        node.classList.add('streaming');
        b.el.replaceWith(node);
        b.el = node;
        autoscroll();
      });
    }
  } else if (ev.type === 'content_block_start' && ev.content_block.type === 'thinking') {
    setWorking('Thinking…');
  } else if (ev.type === 'content_block_start' && ev.content_block.type === 'tool_use') {
    const verb = { Bash: 'run a command', Read: 'read a file', Write: 'write a file', Edit: 'edit a file', MultiEdit: 'edit a file', Grep: 'search the files', Glob: 'look for files', WebFetch: 'open a web page', WebSearch: 'search the web', Task: 'bring in a helper', Agent: 'bring in a helper', TodoWrite: 'update its to-do list' }[ev.content_block.name] || 'take the next step';
    setWorking('Getting ready to ' + verb + '…');
  }
}

function onSdkMessage(m) {
  if (m.type === 'system' && window.Tasks?.onSystem(m)) return;
  if (m.parent_tool_use_id) return; // subagent internals stay inside their Agent card
  if (m.type === 'stream_event') return onStreamEvent(m.event);
  if (m.type === 'assistant') {
    renderBlocks('assistant', m.message.content, m.message.id);
    const tu = (m.message.content || []).filter((b) => b.type === 'tool_use').pop();
    setWorking(tu ? plain(tu.name, tu.input || {}).text + '…' : 'Working…', tu ? plain(tu.name, tu.input || {}).risk : null);
  }
  else if (m.type === 'user') renderBlocks('user', m.message.content);
  else if (m.type === 'result') {
    for (const b of streamBlocks.values()) b.el.classList.remove('streaming');
    if (m.subtype !== 'success') addNote(m.subtype === 'error_max_turns' ? 'Stopped: turn limit reached' : 'Stopped' + (m.errors?.length ? ': ' + m.errors.join('; ') : ''), true);
    else {
      const secs = Math.round((m.duration_ms || 0) / 1000);
      const meta = el('div', 'meta', `${secs >= 60 ? Math.floor(secs / 60) + 'm ' : ''}${secs % 60}s` + (m.num_turns > 1 ? ` · ${m.num_turns} steps` : ''));
      messagesEl.append(meta);
    }
    refreshSessions();
    window.dispatchEvent(new Event('orbit:turn'));
  } else if (m.type === 'system' && m.subtype === 'compact_boundary') addNote('Conversation compacted');
  autoscroll();
}

// ---------- permission + question cards ----------
const askCards = new Map();

function describeAsk(tool, input) {
  switch (tool) {
    case 'Bash': return ['Run a command?', input.command, input.description];
    case 'Write': return ['Create ' + (input.file_path || 'a file') + '?', short(input.content, 3000)];
    case 'Edit': case 'MultiEdit': return ['Edit ' + (input.file_path || 'a file') + '?', null];
    case 'WebFetch': return ['Fetch ' + input.url + '?', input.prompt];
    case 'WebSearch': return ['Search the web?', input.query];
    default: return ['Allow ' + tool + '?', JSON.stringify(input, null, 2)];
  }
}

function addPermission(p) {
  if (askCards.has(p.id)) return;
  showEmpty(false);
  // Auto-approve: allow commands/edits/fetches instantly. Questions and plan approvals
  // still need a real answer, so they are never auto-answered.
  if (autoApprove && p.tool !== 'AskUserQuestion' && p.tool !== 'ExitPlanMode') {
    ws.send(JSON.stringify({ type: 'permission', id: p.id, allow: true }));
    const pl = plain(p.tool, p.input || {});
    const trace = el('div', 'auto-trace');
    trace.innerHTML = '<svg viewBox="0 0 20 20" width="13" height="13" aria-hidden="true"><path d="M10.5 2.5 4 11h4l-1.5 6.5L14 9h-4z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    trace.append(document.createTextNode('Auto-approved: ' + pl.text.replace(/^./, (c) => c.toLowerCase())));
    assistantContainer().append(trace);
    autoscroll(true);
    return;
  }
  const card = el('div', 'ask');
  const respond = (payload, verdict) => {
    ws.send(JSON.stringify({ type: 'permission', id: p.id, ...payload }));
    resolveAsk(p.id, verdict);
  };

  if (p.tool === 'AskUserQuestion') {
    card.append(el('h3', null, 'Claude has a question'));
    const answers = {};
    const qs = p.input.questions || [];
    qs.forEach((q) => {
      const box = el('div', 'q');
      box.append(el('div', 'q-text', q.question));
      const opts = el('div', 'opts');
      const picked = new Set();
      (q.options || []).forEach((o) => {
        const b = el('button', 'opt'); b.type = 'button';
        b.append(document.createTextNode(o.label));
        if (o.description) b.append(el('small', null, o.description));
        b.onclick = () => {
          if (!q.multiSelect) { picked.clear(); opts.querySelectorAll('.opt').forEach((x) => x.classList.remove('sel')); }
          picked.has(o.label) ? picked.delete(o.label) : picked.add(o.label);
          b.classList.toggle('sel', picked.has(o.label));
          answers[q.question] = [...picked].join(', ');
        };
        opts.append(b);
      });
      const other = el('input', 'other'); other.placeholder = 'Or type your own answer…';
      other.oninput = () => { if (other.value.trim()) answers[q.question] = other.value.trim(); };
      box.append(opts, other);
      card.append(box);
    });
    const btns = el('div', 'btns');
    const ok = el('button', 'btn primary', 'Send answer');
    ok.onclick = () => respond({ allow: true, answers }, 'Answered: ' + Object.values(answers).join(' · '));
    const skip = el('button', 'btn', 'Skip');
    skip.onclick = () => respond({ allow: false, message: 'The user skipped the question.' }, 'Skipped');
    btns.append(ok, skip);
    card.append(btns);
  } else if (p.tool === 'ExitPlanMode') {
    card.append(el('h3', null, 'Ready to start on this plan?'));
    const plan = md(p.input.plan || ''); plan.classList.add('plan');
    card.append(plan);
    const btns = el('div', 'btns');
    const go = el('button', 'btn primary', 'Approve & start');
    go.onclick = () => respond({ allow: true }, 'Plan approved');
    const no = el('button', 'btn', 'Keep planning');
    no.onclick = () => respond({ allow: false, message: 'The user wants to keep planning. Ask what to change.' }, 'Kept planning');
    btns.append(go, no);
    card.append(btns);
  } else {
    const [title, detail, why] = describeAsk(p.tool, p.input || {});
    card.append(el('h3', null, title));
    const pl = plain(p.tool, p.input || {});
    const simple = el('p', 'plain-line'); simple.append(riskBadge(pl.risk), ' ' + pl.text + '.');
    card.append(simple);
    if (why || p.reason) card.append(el('p', 'why', why || p.reason));
    if (p.tool === 'Edit' && p.input.old_string != null) card.append(renderToolInput('Edit', p.input));
    else if (detail) card.append(el('pre', null, detail));
    const btns = el('div', 'btns');
    const yes = el('button', 'btn primary', 'Allow');
    yes.onclick = () => respond({ allow: true }, 'Allowed');
    btns.append(yes);
    if (p.canAlways) {
      const always = el('button', 'btn', 'Always allow');
      always.title = 'Don\'t ask again for this kind of action';
      always.onclick = () => respond({ allow: true, always: true }, 'Allowed (always)');
      btns.append(always);
    }
    const no = el('button', 'btn', 'Deny');
    no.onclick = () => respond({ allow: false }, 'Denied');
    btns.append(no);
    const ex = el('button', 'btn explain-btn', 'Explain this');
    ex.onclick = () => explainInline(card, btns, p.tool, p.input || {}, ex);
    btns.append(ex);
    card.append(btns);
  }
  assistantContainer().append(card);
  askCards.set(p.id, card);
  if (p.tool === 'AskUserQuestion') setWorking('Waiting for your answer…');
  else if (p.tool === 'ExitPlanMode') setWorking('Waiting for you to approve the plan…');
  else { const pl = plain(p.tool, p.input || {}); setWorking('Waiting for your OK: ' + pl.text.replace(/^./, (c) => c.toLowerCase()), pl.risk); }
  autoscroll(true);
}

function resolveAsk(id, verdict) {
  const card = askCards.get(id);
  if (!card || card.classList.contains('resolved')) return;
  card.classList.add('resolved');
  card.append(el('div', 'verdict', verdict || 'Answered'));
  setWorking('Working…');
}

// ---------- busy / mode / title ----------
function setWorking(text, risk) {
  $('#workingText').textContent = text;
  $('#working').dataset.risk = risk || '';
}

function applyState() {
  const busy = state.busy;
  workingEl.hidden = !busy;
  const hasDraft = !!inputEl.value.trim() || attachments.length > 0;
  sendBtn.hidden = busy && !hasDraft;
  stopBtn.hidden = !busy || hasDraft;
  sendBtn.disabled = attachments.some((a) => a.status !== 'done');
  const mode = state.sessionId || state.busy ? state.mode : pendingMode;
  document.querySelectorAll('#modes button').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
  window.syncModeBtn?.();
  const activeId = window.Models?.convoId ? 'm/' + window.Models.convoId : state.sessionId;
  document.querySelectorAll('#sessions a').forEach((a) => a.classList.toggle('active', a.dataset.id === activeId));
  window.Models?.sync();
}

// ---------- sessions sidebar ----------
function ago(t) {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}

let sessionsList = [];
async function refreshSessions() {
  try {
    const r = await fetch('/claude/api/sessions', { cache: 'no-store' });
    if (r.status === 404) return location.reload();
    sessionsList = await r.json();
  } catch { return; }
  const nav = $('#sessions');
  nav.replaceChildren();
  const items = [...sessionsList, ...(window.Models?.sidebarItems() || [])].sort((x, y) => y.at - x.at);
  for (const s of items) {
    const a = el('a', s.live ? 'live' : '');
    a.href = '#/' + (s.kind === 'model' ? 'm/' : 's/') + s.id;
    a.dataset.id = (s.kind === 'model' ? 'm/' : '') + s.id;
    a.append(document.createTextNode(short(s.title.replace(/\s+/g, ' '), 60)));
    if (s.tag) { const t = el('span', 'm-tag', s.tag); t.title = s.tagTitle || s.tag; a.append(t); }
    a.append(el('span', 'when', ago(s.at)));
    nav.append(a);
  }
  updateTitle();
  applyState();
}

function updateTitle() {
  const s = sessionsList.find((x) => x.id === state.sessionId);
  $('#navChat').href = state.sessionId ? '#/s/' + state.sessionId : '#/';
  if (view !== 'chat') { $('#title').textContent = { monitor: 'Monitor', sites: 'Sites & backups', editor: 'Editor', skills: 'Skills', settings: 'Settings' }[view]; return; }
  const mt = window.Models?.titleText();
  if (mt != null) { $('#title').textContent = short(mt, 80); return; }
  $('#title').textContent = s ? short(s.title.replace(/\s+/g, ' '), 80) : state.sessionId ? 'Chat' : 'New chat';
}

// ---------- socket ----------
function resetThread() {
  messagesEl.replaceChildren();
  toolCards.clear(); streamBlocks.clear(); askCards.clear();
  window.Tasks?.reset();
  showEmpty(true);
}

function openSession(id) {
  window.Models?.leave();
  resetThread();
  state = { sessionId: id, busy: false, mode: 'default' };
  if (!id) pendingMode = 'default';
  updateTitle(); applyState();
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'open', sessionId: id }));
}

function connect() {
  ws = new WebSocket(`wss://${location.host}/claude/chat-ws`);
  ws.onopen = () => {
    retry = 0;
    $('#conn').className = 'conn on';
    const id = /^#\/(monitor|sites|editor|skills|settings)/.test(location.hash) ? state.sessionId : sessionFromHash();
    resetThread();
    ws.send(JSON.stringify({ type: 'open', sessionId: id }));
    ws.send(JSON.stringify({ type: 'monitor' }));
  };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (window.Models?.active() && ['history', 'state', 'msg', 'permission', 'permission_done'].includes(m.type)) return;
    if (m.type === 'history') {
      resetThread();
      for (const h of m.messages) if (!h.parent_tool_use_id && h.message) renderBlocks(h.message.role || h.type, h.message.content, h.message.id);
      // anything still marked running in history has no result recorded
      toolCards.forEach((c) => c.classList.contains('running') && (c.classList.remove('running'), c.classList.add('ok')));
      window.Tasks?.fromHistory(m.messages);
      if (!m.messages.length) showEmpty(!m.sessionId);
      autoscroll(true);
    } else if (m.type === 'state') {
      const wasNew = !state.sessionId && m.sessionId;
      state = { sessionId: m.sessionId, busy: m.busy, mode: m.mode };
      window.Tasks?.setLive(!!m.live && !m.ended);
      if (wasNew) { if (view === 'chat') history.replaceState(null, '', '#/s/' + m.sessionId); refreshSessions(); }
      if (m.ended && !m.busy) toolCards.forEach((c) => c.classList.contains('running') && (c.classList.remove('running'), c.classList.add('err')));
      updateTitle(); applyState();
    } else if (m.type === 'msg') onSdkMessage(m.msg);
    else if (m.type === 'permission') addPermission(m);
    else if (m.type === 'permission_done') resolveAsk(m.id);
    else if (m.type === 'error') { addNote(m.message, true); autoscroll(); }
    else if (['metrics', 'processes', 'sites', 'monitor_init'].includes(m.type)) window.Monitor?.handle(m);
    else if (['backup_job', 'backups_changed'].includes(m.type)) window.Sites?.handle(m);
    else if (m.type === 'file_change') window.Editor?.onChange(m.change);
  };
  ws.onclose = () => {
    $('#conn').className = 'conn off';
    setTimeout(connect, Math.min(1000 * 2 ** retry++, 10000));
    if (retry > 4) fetch('/claude/api/sessions').then((r) => r.status === 404 && location.reload()).catch(() => {});
  };
}

function sessionFromHash() {
  const m = location.hash.match(/^#\/s\/([0-9a-f-]{36})$/);
  return m ? m[1] : null;
}

// ---------- views: chat (#/ or #/s/<id>) and monitor (#/monitor) ----------
let view = 'chat';
function showView(v) {
  view = v;
  $('#viewChat').hidden = v !== 'chat';
  $('#viewMonitor').hidden = v !== 'monitor';
  $('#viewSites').hidden = v !== 'sites';
  $('#viewEditor').hidden = v !== 'editor';
  $('#viewSkills').hidden = v !== 'skills';
  $('#viewSettings').hidden = v !== 'settings';
  $('#navSettings').classList.toggle('on', v === 'settings');
  $('#navSkills').classList.toggle('on', v === 'skills');
  $('#navEditor').classList.toggle('on', v === 'editor');
  $('#navChat').classList.toggle('on', v === 'chat');
  $('#navMonitor').classList.toggle('on', v === 'monitor');
  $('#navSites').classList.toggle('on', v === 'sites');
  updateTitle();
  if (v === 'monitor') window.Monitor?.shown();
  if (v === 'sites') window.Sites?.shown();
  if (v === 'editor') window.Editor?.shown();
  if (v === 'skills') window.Skills?.shown();
  if (v === 'settings') window.Settings?.shown();
}

function route() {
  document.body.classList.remove('side-open');
  if (location.hash === '#/monitor') return showView('monitor');
  if (location.hash === '#/sites') return showView('sites');
  if (location.hash === '#/skills') return showView('skills');
  if (location.hash === '#/settings') return showView('settings');
  if (location.hash.startsWith('#/editor')) return showView('editor');
  showView('chat');
  const mid = location.hash.match(/^#\/m\/([a-z0-9]{8,40})$/);
  if (mid && window.Models) return window.Models.open(mid[1]);
  const id = sessionFromHash();
  if (id !== state.sessionId || window.Models?.convoId) openSession(id);
}
window.addEventListener('hashchange', route);

// used by the monitor view: "Ask Claude" opens a fresh chat with a prompt
window.App = {
  startChat(prompt) {
    history.pushState(null, '', '#/');
    showView('chat');
    window.Models?.useClaude();
    openSession(null);
    send(prompt, false);
  },
  toast(text) {
    document.getElementById('toast')?.remove();
    const t = el('div', null, text); t.id = 'toast';
    document.body.append(t);
    setTimeout(() => t.remove(), 2600);
  },
};

// ---------- composer ----------
let lastUserText = '';
function send(text, withAttachments = true) {
  if (window.Models?.active()) return window.Models.send(text, withAttachments);
  if (text.trim()) lastUserText = text.trim();
  text = text.trim();
  const atts = withAttachments ? attachments : [];
  if ((!text && !atts.length) || !ws || ws.readyState !== 1) return;
  if (atts.some((a) => a.status !== 'done')) return;
  const lines = atts.filter((a) => a.path).map((a) => `[Attached ${a.kind}: ${a.path} (${fmtSize(a.size)})]`);
  const full = [text, lines.join('\n')].filter(Boolean).join('\n\n');
  const images = atts.filter((a) => a.kind === 'image').map((a) => ({ media_type: a.media_type, data: a.data }));
  addUser(full, atts.filter((a) => a.kind === 'image').map((a) => a.preview));
  ws.send(JSON.stringify({ type: 'send', text: full, images, mode: state.mode }));
  if (withAttachments) { attachments = []; renderTray(); }
  state.busy = true; setWorking('Working…');
  if (text === inputEl.value.trim() || withAttachments) inputEl.value = '';
  autosize(); applyState();
  autoscroll(true);
}

// ---------- attachments ----------
let attachments = [];
const trayEl = $('#tray');
const INLINE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const MAX_EDGE = 2000, INLINE_MAX = 3.5 * 1024 * 1024;

function blobToBase64(blob) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(blob); });
}

// shrink big photos so they fit the API's image limits; returns null if the browser can't decode it
async function prepareImage(file) {
  let bmp;
  try { bmp = await createImageBitmap(file); } catch { return null; }
  const big = Math.max(bmp.width, bmp.height) > MAX_EDGE;
  if (INLINE_TYPES.includes(file.type) && !big && file.size <= INLINE_MAX) {
    bmp.close?.();
    return { blob: file, media_type: file.type };
  }
  const scale = Math.min(1, MAX_EDGE / Math.max(bmp.width, bmp.height));
  const cv = document.createElement('canvas');
  cv.width = Math.round(bmp.width * scale); cv.height = Math.round(bmp.height * scale);
  cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height);
  bmp.close?.();
  const want = file.type === 'image/png' ? 'image/webp' : 'image/jpeg';
  let blob = await new Promise((r) => cv.toBlob(r, want, 0.88));
  if (!blob || blob.type !== want) blob = await new Promise((r) => cv.toBlob(r, 'image/jpeg', 0.88));
  return blob ? { blob, media_type: blob.type } : null;
}

function upload(att, file) {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    att.xhr = xhr;
    xhr.open('POST', '/claude/api/upload');
    xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name || 'file'));
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) { att.progress = e.loaded / e.total; updateTrayItem(att); } };
    xhr.onload = () => {
      let r = {};
      try { r = JSON.parse(xhr.responseText); } catch {}
      if (xhr.status === 200 && r.path) { att.path = r.path; att.name = r.name; resolve(true); }
      else { att.error = r.error || (xhr.status === 413 ? 'Too large' : 'Upload failed'); resolve(false); }
    };
    xhr.onerror = () => { att.error = 'Upload failed'; resolve(false); };
    xhr.onabort = () => resolve(false);
    xhr.send(file);
  });
}

async function addFiles(fileList) {
  for (const file of fileList) {
    if (attachments.length >= 20) break;
    const att = { id: Math.random().toString(36).slice(2), name: file.name || 'pasted-image.png', size: file.size, status: 'uploading', progress: 0 };
    let f = file;
    if (!file.name) f = new File([file], att.name, { type: file.type });
    if (file.type.startsWith('image/')) {
      att.kind = 'image';
      att.preview = URL.createObjectURL(file);
    } else att.kind = 'file';
    attachments.push(att);
    renderTray();
    (async () => {
      if (att.kind === 'image') {
        const img = await prepareImage(f);
        if (img) {
          att.media_type = img.media_type;
          att.data = await blobToBase64(img.blob);
          att.preview = 'data:' + img.media_type + ';base64,' + att.data; // survives in the chat after the tray clears
        } else att.kind = 'file'; // e.g. HEIC the browser can't decode: just upload it
      }
      const ok = await upload(att, f);
      if (!attachments.includes(att)) return;
      att.status = ok ? 'done' : 'error';
      renderTray(); applyState();
    })();
  }
  applyState();
}

function renderTray() {
  trayEl.replaceChildren();
  trayEl.hidden = !attachments.length;
  for (const a of attachments) {
    const item = el('div', 'att' + (a.status === 'error' ? ' err' : a.status === 'uploading' ? ' busy' : ''));
    item.dataset.id = a.id;
    if (a.kind === 'image' && a.preview) {
      const img = el('img', 'att-img'); img.src = a.preview; img.alt = a.name; img.title = a.name;
      item.append(img);
    } else item.append(fileChip(a.name, a.status === 'error' ? a.error : a.status === 'uploading' ? 'Uploading…' : fmtSize(a.size)));
    if (a.status === 'uploading') { const bar = el('div', 'att-bar'); bar.append(el('i')); item.append(bar); }
    const x = el('button', 'att-x', '×'); x.type = 'button'; x.setAttribute('aria-label', 'Remove ' + a.name);
    x.onclick = () => { a.xhr?.abort(); attachments = attachments.filter((y) => y !== a); renderTray(); applyState(); };
    item.append(x);
    trayEl.append(item);
    updateTrayItem(a);
  }
}

function updateTrayItem(a) {
  const bar = trayEl.querySelector(`[data-id="${a.id}"] .att-bar i`);
  if (bar) bar.style.width = Math.round((a.progress || 0) * 100) + '%';
}

// attach menu: images / camera / files / clipboard
const attachMenu = $('#attachMenu'), attachBtn = $('#attachBtn');
const pickers = { image: $('#imageInput'), camera: $('#cameraInput'), file: $('#fileInput') };
const touch = matchMedia('(hover: none) and (pointer: coarse)').matches;
attachMenu.querySelector('[data-pick="camera"]').hidden = !touch;
attachMenu.querySelector('[data-pick="paste"]').hidden = touch || !navigator.clipboard?.read;
attachMenu.querySelector('.pop-foot').hidden = touch;
function toggleAttach(open = attachMenu.hidden) {
  attachMenu.hidden = !open;
  attachBtn.classList.toggle('on', open);
  attachBtn.setAttribute('aria-expanded', open);
  if (open) attachMenu.querySelector('.pop-item:not([hidden])')?.focus({ preventScroll: true });
}
attachBtn.setAttribute('aria-haspopup', 'menu');
attachBtn.onclick = (e) => { e.stopPropagation(); toggleAttach(); };
document.addEventListener('click', (e) => { if (!attachMenu.hidden && !attachMenu.contains(e.target)) toggleAttach(false); });
attachMenu.addEventListener('keydown', (e) => {
  const items = [...attachMenu.querySelectorAll('.pop-item:not([hidden])')];
  const i = items.indexOf(document.activeElement);
  if (e.key === 'Escape') { toggleAttach(false); attachBtn.focus(); }
  else if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
});
attachMenu.querySelectorAll('.pop-item').forEach((b) => (b.onclick = async () => {
  toggleAttach(false);
  if (b.dataset.pick !== 'paste') return pickers[b.dataset.pick].click();
  try {
    const files = [];
    for (const item of await navigator.clipboard.read()) {
      const type = item.types.find((t) => t.startsWith('image/'));
      if (type) { const blob = await item.getType(type); files.push(new File([blob], 'clipboard-' + Date.now() + '.' + type.split('/')[1], { type })); }
    }
    if (files.length) addFiles(files); else window.App?.toast('No image on the clipboard');
  } catch { window.App?.toast('Clipboard access was blocked — try Ctrl+V in the message box'); }
}));
for (const input of Object.values(pickers)) input.onchange = () => { addFiles([...input.files]); input.value = ''; inputEl.focus(); };
inputEl.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) { e.preventDefault(); addFiles(files); }
});
(() => {
  const dz = $('#dropzone');
  let depth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  window.addEventListener('dragenter', (e) => { if (hasFiles(e)) { depth++; dz.hidden = false; } });
  window.addEventListener('dragleave', (e) => { if (hasFiles(e) && --depth <= 0) { depth = 0; dz.hidden = true; } });
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); depth = 0; dz.hidden = true;
    addFiles([...e.dataTransfer.files]);
  });
})();

function autosize() { inputEl.style.height = 'auto'; inputEl.style.height = inputEl.scrollHeight + 'px'; }
inputEl.addEventListener('input', () => { autosize(); applyState(); });
inputEl.addEventListener('keydown', (e) => {
  const desktop = matchMedia('(hover: hover) and (pointer: fine)').matches;
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && desktop) { e.preventDefault(); send(inputEl.value); }
});
$('#composer').addEventListener('submit', (e) => { e.preventDefault(); send(inputEl.value); });
stopBtn.onclick = () => (window.Models?.active() ? window.Models.stop() : ws.send(JSON.stringify({ type: 'interrupt' })));

document.querySelectorAll('#modes button').forEach((b) => {
  b.onclick = () => {
    if (state.sessionId && ws) ws.send(JSON.stringify({ type: 'mode', mode: b.dataset.mode }));
    pendingMode = b.dataset.mode;
    state.mode = b.dataset.mode;
    applyState();
  };
});

// ---------- Auto-approve: client-side "allow everything" toggle ----------
// Instantly answers every command/edit permission with Allow, so the user doesn't have
// to click. Questions (AskUserQuestion) and plan approvals (ExitPlanMode) still ask,
// because they need a real decision. Persisted locally; off by default.
let autoApprove = localStorage.getItem('cw_autoapprove') === '1';
const autoApproveBtn = $('#autoApprove');
function syncAutoApprove() { autoApproveBtn?.setAttribute('aria-pressed', autoApprove ? 'true' : 'false'); }
autoApproveBtn?.addEventListener('click', () => {
  autoApprove = !autoApprove;
  localStorage.setItem('cw_autoapprove', autoApprove ? '1' : '0');
  syncAutoApprove();
  window.App?.toast(autoApprove ? 'Auto-approve on — commands run without asking' : 'Auto-approve off');
});
syncAutoApprove();

document.querySelectorAll('.starters button').forEach((b) => (b.onclick = () => send(b.textContent)));
$('#newChat').onclick = () => { if (location.hash && location.hash !== '#/') location.hash = '#/'; else { showView('chat'); openSession(null); } document.body.classList.remove('side-open'); inputEl.focus(); };
$('#menu').onclick = () => document.body.classList.add('side-open');
$('#scrim').onclick = () => document.body.classList.remove('side-open');

// ---------- quick commands (stored server-side so every device shares them) ----------
let quick = [];
const chipsEl = $('#quick');

async function loadQuick() {
  try { quick = await (await fetch('/claude/api/quick', { cache: 'no-store' })).json(); } catch { quick = []; }
  renderChips();
}

async function saveQuick(method = 'PUT') {
  try {
    const r = await fetch('/claude/api/quick', { method, headers: { 'Content-Type': 'application/json' }, body: method === 'PUT' ? JSON.stringify(quick) : undefined });
    if (r.ok) quick = await r.json();
  } catch {}
  renderChips();
  renderManager();
}

function renderChips() {
  chipsEl.replaceChildren();
  if (!quick.length) chipsEl.append(el('span', 'chips-empty', 'No quick commands yet. Use Edit to add one.'));
  for (const q of quick) {
    const label = q.label || q.prompt;
    const c = el('button', 'chip' + (label.startsWith('/') ? ' slash' : '') + (q.send ? '' : ' fill'), short(label, 40));
    c.type = 'button';
    c.title = q.prompt;
    c.onclick = () => {
      if (q.send) return send(q.prompt, false);
      inputEl.value = q.prompt; autosize(); applyState(); inputEl.focus();
      inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length);
    };
    chipsEl.append(c);
  }
  updateFades();
}

function updateFades() {
  const max = chipsEl.scrollWidth - chipsEl.clientWidth;
  chipsEl.classList.toggle('fade-l', chipsEl.scrollLeft > 2);
  chipsEl.classList.toggle('fade-r', chipsEl.scrollLeft < max - 2);
}
chipsEl.addEventListener('scroll', updateFades, { passive: true });
window.addEventListener('resize', updateFades);
// vertical mouse wheel scrolls the chip row sideways
chipsEl.addEventListener('wheel', (e) => {
  if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && chipsEl.scrollWidth > chipsEl.clientWidth) {
    e.preventDefault();
    chipsEl.scrollBy({ left: e.deltaY, behavior: 'auto' });
  }
}, { passive: false });
// click-and-drag scrolling with a mouse; a drag doesn't count as a click on a chip
(() => {
  let down = null, moved = false;
  chipsEl.addEventListener('pointerdown', (e) => { if (e.pointerType === 'mouse') { down = { x: e.clientX, left: chipsEl.scrollLeft }; moved = false; } });
  window.addEventListener('pointermove', (e) => {
    if (!down) return;
    const dx = e.clientX - down.x;
    if (Math.abs(dx) > 4) moved = true;
    if (moved) chipsEl.scrollLeft = down.left - dx;
  });
  window.addEventListener('pointerup', () => { down = null; });
  chipsEl.addEventListener('click', (e) => { if (moved) { e.stopPropagation(); e.preventDefault(); moved = false; } }, true);
})();

// manager sheet
const qm = $('#qm'), qmList = $('#qmList');
let editingId = null;

function openManager() { qm.hidden = false; resetForm(); renderManager(); }
function closeManager() { qm.hidden = true; }

function renderManager() {
  if (qm.hidden) return;
  qmList.replaceChildren();
  for (const q of quick) {
    const li = el('li', editingId === q.id ? 'editing' : '');
    li.dataset.id = q.id;
    const grip = el('span', 'grip', '⋮⋮');
    grip.setAttribute('aria-label', 'Drag to reorder');
    const text = el('button', 'qm-text'); text.type = 'button';
    text.append(el('b', null, q.label || q.prompt), el('span', null, (q.send ? '' : '[fills the box] ') + q.prompt));
    text.onclick = () => startEdit(q);
    const del = el('button', 'qm-del'); del.type = 'button'; del.setAttribute('aria-label', 'Delete');
    del.innerHTML = '<svg viewBox="0 0 20 20" width="16" height="16"><path d="M6 6l8 8M14 6l-8 8" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>';
    del.onclick = () => {
      quick = quick.filter((x) => x.id !== q.id);
      if (editingId === q.id) resetForm();
      saveQuick();
    };
    li.append(grip, text, del);
    grip.addEventListener('pointerdown', (e) => startDrag(e, li));
    qmList.append(li);
  }
  if (!quick.length) qmList.append(el('li', 'chips-empty', 'Nothing here yet — add your first command below.'));
}

function startDrag(e, li) {
  e.preventDefault();
  // listen on window: moving the row in the DOM would drop pointer capture on the grip
  li.classList.add('dragging');
  document.body.style.userSelect = 'none';
  const move = (ev) => {
    const siblings = [...qmList.children].filter((x) => x !== li && x.dataset.id);
    const after = siblings.find((s) => { const r = s.getBoundingClientRect(); return ev.clientY < r.top + r.height / 2; });
    if (after) { if (li.nextElementSibling !== after) qmList.insertBefore(li, after); }
    else if (qmList.lastElementChild !== li) qmList.append(li);
    // keep the list scrolling while dragging near its edges
    const r = qmList.getBoundingClientRect();
    if (ev.clientY < r.top + 30) qmList.scrollTop -= 8; else if (ev.clientY > r.bottom - 30) qmList.scrollTop += 8;
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
    li.classList.remove('dragging');
    document.body.style.userSelect = '';
    const order = [...qmList.children].map((x) => x.dataset.id);
    const next = order.map((id) => quick.find((q) => q.id === id)).filter(Boolean);
    if (next.some((q, i) => q !== quick[i])) { quick = next; saveQuick(); }
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
}

function startEdit(q) {
  editingId = q.id;
  $('#qmLabel').value = q.label || '';
  $('#qmPrompt').value = q.prompt;
  $('#qmSend').checked = q.send !== false;
  $('#qmFormTitle').textContent = 'Edit command';
  $('#qmSubmit').textContent = 'Save';
  $('#qmCancel').hidden = false;
  renderManager();
  $('#qmPrompt').focus();
}

function resetForm() {
  editingId = null;
  $('#qmForm').reset();
  $('#qmSend').checked = true;
  $('#qmFormTitle').textContent = 'Add a command';
  $('#qmSubmit').textContent = 'Add command';
  $('#qmCancel').hidden = true;
}

$('#qmForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const item = { label: $('#qmLabel').value.trim(), prompt: $('#qmPrompt').value.trim(), send: $('#qmSend').checked };
  if (!item.prompt) return;
  const wasEditing = editingId;
  if (editingId) quick = quick.map((q) => (q.id === editingId ? { ...q, ...item } : q));
  else quick = [...quick, { id: Math.random().toString(36).slice(2, 10), ...item }];
  resetForm();
  saveQuick();
  if (!wasEditing) requestAnimationFrame(() => (qmList.scrollTop = qmList.scrollHeight));
});
$('#qmCancel').onclick = () => { resetForm(); renderManager(); };
$('#qmReset').onclick = () => { if (confirm('Replace your quick commands with the defaults?')) { resetForm(); saveQuick('DELETE'); } };
$('#quickEdit').onclick = openManager;
$('#qmClose').onclick = closeManager;
qm.addEventListener('click', (e) => { if (e.target === qm) closeManager(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !qm.hidden) closeManager(); });

loadQuick();
refreshSessions();
setInterval(refreshSessions, 30000);
connect();
showView(location.hash === '#/monitor' ? 'monitor' : location.hash === '#/sites' ? 'sites' : location.hash === '#/skills' ? 'skills' : location.hash === '#/settings' ? 'settings' : location.hash.startsWith('#/editor') ? 'editor' : 'chat');
inputEl.focus();

// ---------- light / dark switch ----------
// Toggling to the device's own setting clears the override, so Orbit follows the device again.
(() => {
  const btn = document.getElementById('themeBtn'), root = document.documentElement;
  const sys = matchMedia('(prefers-color-scheme: dark)');
  const effective = () => root.dataset.theme || (sys.matches ? 'dark' : 'light');
  const sync = () => {
    const d = effective() === 'dark';
    btn.title = btn.ariaLabel = d ? 'Switch to light mode' : 'Switch to dark mode';
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', d ? (matchMedia('(max-width: 760px)').matches ? '#000000' : '#121212') : '#ffffff');
    window.dispatchEvent(new CustomEvent('orbit:theme', { detail: effective() }));
  };
  btn.addEventListener('click', () => {
    const next = effective() === 'dark' ? 'light' : 'dark';
    if (next === (sys.matches ? 'dark' : 'light')) { delete root.dataset.theme; localStorage.removeItem('orbit_theme'); }
    else { root.dataset.theme = next; localStorage.setItem('orbit_theme', next); }
    sync();
  });
  sys.addEventListener('change', sync);
  sync();
  window.OrbitTheme = {
    get: () => root.dataset.theme || 'system',
    set(t) {
      if (t === 'light' || t === 'dark') { root.dataset.theme = t; localStorage.setItem('orbit_theme', t); }
      else { delete root.dataset.theme; localStorage.removeItem('orbit_theme'); }
      sync();
    },
  };
})();

// ---------- background tasks: a strip above the composer, with a details panel ----------
// Fed by the SDK's task_* / background_tasks_changed system messages (live, or replayed by the server on attach)
// plus "running in background with ID" tool results, which give us the output file.
window.Tasks = (() => {
  const bar = $('#tasksBar'), strip = $('#tasksStrip'), panel = $('#tasksPanel');
  const tasks = new Map(), tools = new Map(), launches = new Map();
  const TYPE = { local_bash: 'Command', local_agent: 'Helper agent', monitor: 'Monitor', local_workflow: 'Workflow', mcp_task: 'Tool task', remote_agent: 'Remote agent' };
  const DONE = { completed: 'Finished', failed: 'Failed', stopped: 'Stopped', killed: 'Stopped', ended: 'Finished' };
  const ANSI = /\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07]*\x07/g;
  let live = false, openPanel = false, expanded = null, tick = null, poll = null;

  const running = (t) => !DONE[t.status];
  const visible = (t) => !t.ambient && t.bg !== false && (!t.fromHistory || (live && running(t)));
  const list = () => [...tasks.values()].filter(visible).sort((a, b) => (running(b) - running(a)) || (b.start || 0) - (a.start || 0));
  function dur(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return s + 's';
    if (s < 3600) return Math.floor(s / 60) + 'm ' + String(s % 60).padStart(2, '0') + 's';
    return Math.floor(s / 3600) + 'h ' + String(Math.floor(s / 60) % 60).padStart(2, '0') + 'm';
  }
  const timeOf = (t) => t.start ? dur((running(t) ? Date.now() : t.end || Date.now()) - t.start) : '';
  function get(id) {
    let t = tasks.get(id);
    if (!t) { t = { id, status: 'running' }; tasks.set(id, t); }
    return t;
  }
  function link(t) {
    if (!t.toolUseId) return;
    const tu = tools.get(t.toolUseId);
    if (tu && !t.command) t.command = tu.input?.command || tu.input?.prompt || '';
    if (tu && !t.desc) t.desc = tu.input?.description || '';
    const l = launches.get(t.toolUseId);
    if (l && !t.outputFile) t.outputFile = l.path;
  }

  function onSystem(m) {
    const st = m.subtype;
    if (!['task_started', 'task_progress', 'task_updated', 'task_notification', 'background_tasks_changed'].includes(st)) return false;
    const at = m._at || Date.now();
    if (st === 'background_tasks_changed') {
      const ids = new Set();
      for (const e of m.tasks || []) {
        ids.add(e.task_id);
        const t = get(e.task_id);
        Object.assign(t, { type: e.task_type || t.type, desc: e.description || t.desc, ambient: !!e.ambient, bg: true, fromHistory: false });
        if (!t.start) t.start = at;
        if (!running(t)) t.status = 'running';
      }
      for (const t of tasks.values()) if (t.bg && running(t) && !ids.has(t.id) && !t.fromHistory) { t.status = 'ended'; t.end = at; }
    } else {
      const t = get(m.task_id);
      t.fromHistory = false;
      if (m.tool_use_id) t.toolUseId = m.tool_use_id;
      if (m.description) t.desc = m.description;
      if (m.ambient) t.ambient = true;
      if (st === 'task_started') {
        Object.assign(t, { type: m.task_type || t.type, agent: m.subagent_type, start: t.start || at, prompt: m.prompt });
        if (m.is_backgrounded !== undefined) t.bg = m.is_backgrounded;
        if (m.skip_transcript) t.ambient = true;
      } else if (st === 'task_progress') {
        Object.assign(t, { usage: m.usage, lastTool: m.last_tool_name || t.lastTool, summary: m.summary || t.summary });
        if (!t.start && m.usage?.duration_ms) t.start = at - m.usage.duration_ms;
      } else if (st === 'task_updated') {
        const p = m.patch || {};
        if (p.is_backgrounded !== undefined) t.bg = p.is_backgrounded;
        if (p.status && p.status !== 'pending') t.status = p.status === 'paused' ? 'running' : p.status;
        if (p.end_time) t.end = p.end_time;
        if (p.error) t.error = p.error;
      } else if (st === 'task_notification') {
        Object.assign(t, { status: m.status, summary: m.summary || t.summary, outputFile: m.output_file || t.outputFile, usage: m.usage || t.usage, end: t.end || at });
        if (!t.desc) t.desc = /"([^"]+)"/.exec(m.summary || '')?.[1] || '';
        if (!t.start && m.usage?.duration_ms) t.start = t.end - m.usage.duration_ms;
      }
      link(t);
    }
    render();
    return true;
  }

  function onToolUse(b) { tools.set(b.id, { name: b.name, input: b.input || {} }); }
  function onToolResult(block, text) {
    const m = /with ID: ([\w-]+)\. Output is being written to: (\S+?\.output)/.exec(text || '');
    if (!m) return;
    launches.set(block.tool_use_id, { id: m[1], path: m[2] });
    const t = tasks.get(m[1]);
    if (t) { t.toolUseId ||= block.tool_use_id; t.outputFile ||= m[2]; link(t); render(); }
  }

  // Rebuild what the transcript knows: background launches, minus the ones with a completion notice.
  function fromHistory(messages) {
    const done = new Map();
    for (const h of messages) {
      const c = h.message?.content;
      const texts = typeof c === 'string' ? [c] : (c || []).map((b) => (b.type === 'text' ? b.text : b.type === 'tool_result' ? resultText(b.content) : ''));
      for (const s of texts) for (const n of s.matchAll(/<task-notification>[\s\S]*?<task-id>([^<]+)<\/task-id>[\s\S]*?<status>([^<]+)<\/status>/g)) done.set(n[1], n[2]);
    }
    for (const [tuId, l] of launches) {
      if (tasks.has(l.id)) continue;
      const tu = tools.get(tuId);
      tasks.set(l.id, { id: l.id, toolUseId: tuId, type: 'local_bash', bg: true, fromHistory: true, outputFile: l.path,
        status: done.get(l.id) || 'running', desc: tu?.input?.description || '', command: tu?.input?.command || '' });
    }
    render();
  }

  function reset() { tasks.clear(); tools.clear(); launches.clear(); expanded = null; render(); }
  function setLive(v) { if (live !== v) { live = v; render(); } }

  function render() {
    const all = list();
    const run = all.filter(running);
    bar.hidden = !all.length;
    clearInterval(tick); tick = null;
    if (!all.length) { openPanel = false; panel.hidden = true; stopPoll(); return; }
    if (run.length) tick = setInterval(renderTimes, 1000);
    const lead = run[0] || all[0];
    strip.replaceChildren();
    strip.append(el('span', 'tk-dot ' + (run.length ? 'run' : lead.status === 'failed' ? 'bad' : 'ok')),
      el('span', 'tk-label', run.length ? (run.length > 1 ? run.length + ' running' : 'Running') : (DONE[lead.status] || 'Done')),
      el('span', 'tk-desc', lead.desc || TYPE[lead.type] || 'Background task'));
    const tm = el('span', 'tk-time', timeOf(lead)); tm.dataset.task = lead.id; strip.append(tm);
    if (all.length > 1 && run.length <= 1) strip.append(el('span', 'tk-more', '+' + (all.length - 1)));
    strip.append(el('span', 'tk-open', openPanel ? 'Hide' : 'Details'));
    strip.setAttribute('aria-expanded', openPanel);
    panel.hidden = !openPanel;
    if (openPanel) renderPanel(all);
  }

  function renderTimes() { document.querySelectorAll('#tasksBar [data-task]').forEach((e) => { const t = tasks.get(e.dataset.task); if (t) e.textContent = timeOf(t); }); }

  function renderPanel(all) {
    panel.replaceChildren();
    const head = el('div', 'tk-head');
    head.append(el('b', null, 'Background tasks'));
    if (all.some((t) => !running(t))) {
      const c = el('button', 'tk-link', 'Clear finished'); c.type = 'button';
      c.onclick = () => { for (const t of all) if (!running(t)) tasks.delete(t.id); render(); };
      head.append(c);
    }
    panel.append(head);
    for (const t of all) {
      const row = el('div', 'tk-row' + (expanded === t.id ? ' open' : ''));
      const top = el('button', 'tk-top'); top.type = 'button';
      const tm = el('span', 'tk-time', timeOf(t)); tm.dataset.task = t.id;
      top.append(el('span', 'tk-dot ' + (running(t) ? 'run' : t.status === 'failed' ? 'bad' : 'ok')),
        el('span', 'tk-desc', t.desc || t.command || 'Background task'),
        el('span', 'tk-kind', (TYPE[t.type] || 'Task') + ' · ' + (running(t) ? 'running' : (DONE[t.status] || 'done').toLowerCase())), tm);
      top.onclick = () => { expanded = expanded === t.id ? null : t.id; render(); };
      row.append(top);
      if (expanded === t.id) row.append(details(t));
      panel.append(row);
    }
    if (expanded && tasks.get(expanded)?.outputFile) startPoll(); else stopPoll();
  }

  function details(t) {
    const d = el('div', 'tk-body');
    const kv = (k, v) => { if (v) { const r = el('div', 'tk-kv'); r.append(el('span', null, k), el('span', null, v)); d.append(r); } };
    if (t.command) { d.append(el('div', 'label', t.type === 'local_agent' ? 'Task' : 'Command')); d.append(el('pre', 'tk-cmd', short(t.command, 2000))); }
    if (t.summary) kv('Status', t.summary);
    if (t.error) kv('Error', t.error);
    if (t.agent) kv('Agent', t.agent);
    if (t.lastTool && running(t)) kv('Now using', t.lastTool);
    if (t.usage) kv('Work', `${t.usage.tool_uses || 0} tool calls · ${Math.round((t.usage.total_tokens || 0) / 1000)}k tokens`);
    if (t.start) kv(running(t) ? 'Running for' : 'Took', timeOf(t));
    kv('Task ID', t.id);
    if (t.outputFile) {
      d.append(el('div', 'label', 'Output' + (running(t) ? ' (live)' : '')));
      const pre = el('pre', 'tk-out', 'Loading…'); pre.id = 'tkOut'; d.append(pre);
      loadOutput(t);
    }
    const acts = el('div', 'tk-acts');
    if (t.outputFile) { const o = el('button', 'btn sm', 'Open output'); o.type = 'button'; o.onclick = () => window.Editor?.openFile(t.outputFile, 1); acts.append(o); }
    if (running(t) && live) {
      const s = el('button', 'btn sm danger', 'Stop'); s.type = 'button';
      s.onclick = () => { if (confirm('Stop this task?')) ws?.send(JSON.stringify({ type: 'stop_task', taskId: t.id })); };
      acts.append(s);
    }
    if (!running(t)) { const x = el('button', 'btn sm', 'Dismiss'); x.type = 'button'; x.onclick = () => { tasks.delete(t.id); expanded = null; render(); }; acts.append(x); }
    if (acts.childElementCount) d.append(acts);
    return d;
  }

  async function loadOutput(t) {
    try {
      const r = await fetch('/claude/api/fs/read?path=' + encodeURIComponent(t.outputFile), { cache: 'no-store' }).then((r) => r.json());
      const pre = document.getElementById('tkOut');
      if (!pre || expanded !== t.id) return;
      let txt = r.tooLarge ? '(Output is too large to preview. Use Open output.)' : r.binary ? '(Binary output)' : (r.content || '').replace(ANSI, '').replace(/\r(?!\n)/g, '\n');
      const lines = txt.split('\n'); if (lines.length > 200) txt = '…\n' + lines.slice(-200).join('\n');
      const atEnd = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 8;
      pre.textContent = txt.trim() || (r.error ? r.error : 'Nothing written yet. Some commands send their output to their own log file.');
      if (atEnd) pre.scrollTop = pre.scrollHeight;
    } catch { const pre = document.getElementById('tkOut'); if (pre) pre.textContent = 'Could not read the output file.'; }
  }
  function startPoll() { if (!poll) poll = setInterval(() => { const t = tasks.get(expanded); if (t?.outputFile && running(t)) loadOutput(t); }, 3000); }
  function stopPoll() { clearInterval(poll); poll = null; }

  strip.onclick = () => { openPanel = !openPanel; render(); };
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && openPanel) { openPanel = false; render(); } });
  return { onSystem, onToolUse, onToolResult, fromHistory, reset, setLive, _tasks: tasks };
})();

// ---------- phones: the permission modes collapse into one capsule + menu ----------
(() => {
  const modes = document.getElementById('modes');
  if (!modes) return;
  const narrow = matchMedia('(max-width: 760px)');
  const btn = document.createElement('button');
  btn.type = 'button'; btn.className = 'mode-btn'; btn.setAttribute('aria-haspopup', 'menu'); btn.setAttribute('aria-expanded', 'false');
  btn.innerHTML = '<span></span><svg viewBox="0 0 20 20" width="12" height="12" aria-hidden="true"><path d="M6 8l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  modes.before(btn);
  const close = () => { modes.classList.remove('open'); btn.setAttribute('aria-expanded', 'false'); };
  window.syncModeBtn = () => {
    const on = modes.querySelector('button.on') || modes.querySelector('button');
    btn.firstChild.textContent = on ? on.textContent.trim() : 'Mode';
    btn.title = on ? on.title : '';
  };
  btn.addEventListener('click', () => {
    const open = !modes.classList.contains('open');
    if (open) {
      const row = modes.parentElement, w = Math.min(250, row.clientWidth);
      const left = Math.max(0, Math.min(btn.offsetLeft, row.clientWidth - w));
      modes.style.left = left + 'px';
      modes.style.setProperty('--menu-ox', (btn.offsetLeft - left + 24) + 'px');
    }
    modes.classList.toggle('open', open); btn.setAttribute('aria-expanded', String(open));
  });
  modes.addEventListener('click', () => { if (narrow.matches) setTimeout(() => { window.syncModeBtn(); close(); }, 0); });
  document.addEventListener('click', (e) => { if (modes.classList.contains('open') && !modes.contains(e.target) && !btn.contains(e.target)) close(); });
  document.getElementById('attachBtn')?.addEventListener('click', close, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  narrow.addEventListener('change', close);
  window.syncModeBtn();
})();

// mobile drawer v2: on phones the New chat button sits in the drawer header as a round compose button
(() => {
  const btn = document.getElementById('newChat'), top = document.querySelector('#side .side-top'), brand = document.querySelector('#side .brand');
  if (!btn || !top || !brand) return;
  const mq = matchMedia('(max-width: 760px)');
  const place = () => { if (mq.matches) { if (btn.parentNode !== brand) brand.append(btn); btn.setAttribute('aria-label', 'New chat'); btn.title = 'New chat'; top.hidden = true; } else { if (btn.parentNode !== top) top.append(btn); top.hidden = false; } };
  place(); mq.addEventListener('change', place);
})();

// ---------- sidebar recents: swipe left (touch) or hover (mouse) to Stop / Delete ----------
// Backend: orbit-push /claude/api/chats/{stop,delete,restore}; model chats use orbit-models.
(() => {
  const nav = document.getElementById('sessions');
  if (!nav) return;
  const ACT_W = 78;
  let openRow = null, drag = null, swallowClick = false;
  const isModel = (id) => id.startsWith('m/');
  const icon = {
    stop: '<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true"><rect x="5" y="5" width="10" height="10" rx="2" fill="currentColor"/></svg>',
    del: '<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true"><path d="M4 6h12M8 6V4.5h4V6M6 6l.7 9.2a1.5 1.5 0 0 0 1.5 1.3h3.6a1.5 1.5 0 0 0 1.5-1.3L14 6M8.5 9v5M11.5 9v5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  };

  function decorate() {
    for (const a of nav.querySelectorAll('a[data-id]')) {
      if (a.querySelector('.sw-acts')) continue;
      const acts = document.createElement('span');
      acts.className = 'sw-acts';
      const live = a.classList.contains('live');
      if (live) acts.append(btn('stop', 'Stop', a));
      acts.append(btn('del', 'Delete', a));
      a.style.setProperty('--acts', (live ? 2 : 1) * ACT_W + 'px');
      a.append(acts);
      if (openRow && openRow.dataset.id === a.dataset.id) { openRow = a; set(a, -actsW(a), false); }
    }
  }
  function btn(kind, label, a) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'sw-btn sw-' + kind; b.title = label; b.setAttribute('aria-label', label + ' chat');
    b.innerHTML = icon[kind] + '<span>' + label + '</span>';
    b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); kind === 'stop' ? stop(a) : remove(a); });
    return b;
  }
  const actsW = (a) => parseInt(a.style.getPropertyValue('--acts')) || ACT_W;
  function set(a, x, animate = true) {
    a.style.transition = animate ? 'transform .32s cubic-bezier(.32,.72,0,1)' : 'none';
    a.style.transform = x ? `translateX(${x}px)` : '';
    a.style.setProperty('--pull', Math.max(0, -x) + 'px');
    a.classList.toggle('sw-open', x < 0);
  }
  function closeOpen(except) { if (openRow && openRow !== except) { set(openRow, 0); openRow = null; } }

  new MutationObserver(decorate).observe(nav, { childList: true });
  decorate();

  // ----- gesture (touch / pen only; mice get hover buttons) -----
  nav.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') return;
    const a = e.target.closest('a[data-id]');
    if (!a || e.target.closest('.sw-btn')) return;
    drag = { a, x0: e.clientX, y0: e.clientY, start: a === openRow ? -actsW(a) : 0, x: 0, mode: null, id: e.pointerId, w: a.offsetWidth };
  });
  nav.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x0, dy = e.clientY - drag.y0;
    if (!drag.mode) {
      if (Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy) * 1.2) { drag.mode = 'swipe'; closeOpen(drag.a); try { drag.a.setPointerCapture(e.pointerId); } catch {} }
      else if (Math.abs(dy) > 8) { drag = null; return; }
      else return;
    }
    let x = drag.start + dx;
    if (x > 0) x = x / 4; // resist right
    const full = -drag.w * 0.62;
    if (x < -actsW(drag.a)) x = -actsW(drag.a) + (x + actsW(drag.a)) * 0.85;
    drag.x = x;
    drag.a.classList.toggle('sw-full', x < full);
    set(drag.a, x, false);
  });
  const end = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const { a, mode, x, w } = drag; drag = null;
    if (mode !== 'swipe') return;
    swallowClick = true; setTimeout(() => (swallowClick = false), 350);
    a.classList.remove('sw-full');
    if (x < -w * 0.62) { set(a, -w); remove(a, true); return; }
    if (x < -actsW(a) / 2) { set(a, -actsW(a)); openRow = a; navigator.vibrate?.(8); }
    else { set(a, 0); if (openRow === a) openRow = null; }
  };
  nav.addEventListener('pointerup', end);
  nav.addEventListener('pointercancel', (e) => { if (drag && e.pointerId === drag.id) { set(drag.a, drag.start); drag = null; } });
  // a swipe shouldn't also open the chat; tapping an open row just closes it
  nav.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-id]');
    if (swallowClick) { e.preventDefault(); e.stopPropagation(); return; }
    if (a && a === openRow && !e.target.closest('.sw-btn')) { e.preventDefault(); e.stopPropagation(); closeOpen(); }
  }, true);
  document.addEventListener('pointerdown', (e) => { if (openRow && !openRow.contains(e.target)) closeOpen(); }, true);

  // ----- actions -----
  async function post(path, body) {
    const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'Something went wrong');
    return j;
  }
  const titleOf = (a) => (a.firstChild?.textContent || 'Chat').trim();

  async function stop(a) {
    const id = a.dataset.id;
    const b = a.querySelector('.sw-stop'); if (b) b.disabled = true;
    try {
      if (isModel(id)) await post('/claude/api/models/stop', { convo: id.slice(2) });
      else {
        const j = await post('/claude/api/chats/stop', { id });
        App.toast(j.stopped || j.declined ? `Stopped “${short(titleOf(a), 40)}”` : 'That chat had already finished');
      }
    } catch (e) { App.toast(e.message); }
    closeOpen(); openRow = null;
    refreshSessions();
  }

  async function remove(a, swiped = false) {
    const id = a.dataset.id, title = titleOf(a), live = a.classList.contains('live');
    if (live && !confirm(`“${short(title, 60)}” is still running. Stop it and delete the chat?`)) { set(a, swiped ? 0 : -actsW(a)); return; }
    openRow = null;
    // collapse the row like iOS
    a.style.height = a.offsetHeight + 'px'; a.offsetHeight; // reflow
    a.classList.add('sw-gone');
    const wasCurrent = (isModel(id) ? 'm/' + (window.Models?.convoId || '') : state.sessionId) === id;
    try {
      let token = null;
      if (isModel(id)) {
        const r = await fetch('/claude/api/models/convos/' + id.slice(2), { method: 'DELETE' });
        if (!r.ok) throw new Error('Could not delete that chat');
      } else token = (await post('/claude/api/chats/delete', { id })).token;
      if (wasCurrent) location.hash = '#/';
      undoToast(`Deleted “${short(title, 34)}”`, token && (async () => {
        await post('/claude/api/chats/restore', { token });
        await refreshSessions();
        App.toast('Chat restored');
      }));
    } catch (e) {
      a.classList.remove('sw-gone'); a.style.height = ''; set(a, 0);
      App.toast(e.message);
    }
    setTimeout(refreshSessions, 400);
  }

  let toastEl = null, toastTimer = null;
  function undoToast(text, undo) {
    toastEl?.remove(); clearTimeout(toastTimer);
    toastEl = document.createElement('div');
    toastEl.className = 'sw-toast';
    toastEl.append(Object.assign(document.createElement('span'), { textContent: text }));
    if (undo) {
      const u = document.createElement('button'); u.type = 'button'; u.textContent = 'Undo';
      u.onclick = async () => { u.disabled = true; try { await undo(); } catch (e) { App.toast(e.message); } toastEl?.remove(); };
      toastEl.append(u);
    }
    document.body.append(toastEl);
    toastTimer = setTimeout(() => toastEl?.remove(), 6000);
  }
})();
