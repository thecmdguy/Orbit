const term = new Terminal({
  fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
  fontSize: window.innerWidth < 600 ? 12 : 14,
  cursorBlink: true,
  scrollback: 10000,
  allowProposedApi: true,
  theme: { background: '#141413', foreground: '#e8e6dc', cursor: '#d97757', selectionBackground: '#4a3a30' },
});
const fit = new FitAddon.FitAddon();
term.loadAddon(fit);
term.loadAddon(new WebLinksAddon.WebLinksAddon());
term.open(document.getElementById('term'));
fit.fit();

const status = document.getElementById('status');
let ws, retry = 0;

function ctl(msg) { if (ws && ws.readyState === 1) ws.send('\x00' + JSON.stringify(msg)); }
function sendResize() { fit.fit(); ctl({ type: 'resize', cols: term.cols, rows: term.rows }); }

function connect() {
  ws = new WebSocket(`wss://${location.host}/orbit/ws`);
  ws.onopen = () => { retry = 0; status.textContent = 'connected'; status.className = 'on'; sendResize(); term.focus(); };
  ws.onmessage = (e) => term.write(e.data);
  ws.onclose = (e) => {
    status.textContent = 'disconnected'; status.className = 'off';
    if (e.code === 1006 && retry > 3) { location.reload(); return; } // likely logged out
    setTimeout(connect, Math.min(1000 * 2 ** retry++, 10000));
  };
}

term.onData((d) => { if (ws && ws.readyState === 1) ws.send(d); });
window.addEventListener('resize', () => setTimeout(sendResize, 50));
new ResizeObserver(() => sendResize()).observe(document.getElementById('term'));

document.querySelectorAll('#keys button').forEach((b) => {
  const seq = JSON.parse('"' + b.dataset.k.replace(/\\x/g, '\\u00') + '"');
  b.addEventListener('mousedown', (e) => e.preventDefault()); // keep the keyboard open
  b.addEventListener('click', () => { if (ws && ws.readyState === 1) ws.send(seq); term.focus(); });
});

document.getElementById('restart').onclick = () => {
  if (confirm('Kill the current Claude session and start a new one?')) { term.clear(); ctl({ type: 'restart' }); }
};

connect();
