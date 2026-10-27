// Monitor view + sidebar mini pulse. Data arrives over the chat socket
// (metrics every 2s, pm2 every 5s, site checks every minute) via window.Monitor.handle.
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

  let hist = [], sys = null, procs = [], sites = {}, links = [];

  const pct = (n) => (n == null ? '–' : Math.round(n) + '%');
  function bytes(n) {
    if (!n) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return (n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)) + ' ' + u[i];
  }
  const rate = (n) => bytes(n) + '/s';
  function dur(ms) {
    const s = Math.floor(ms / 1000);
    if (s < 60) return s + 's';
    const m = Math.floor(s / 60); if (m < 60) return m + 'm';
    const h = Math.floor(m / 60); if (h < 48) return h + 'h ' + (m % 60) + 'm';
    return Math.floor(h / 24) + 'd ' + (h % 24) + 'h';
  }
  const level = (v) => (v >= 90 ? 'crit' : v >= 75 ? 'hot' : '');
  const levelColor = (v) => (v >= 90 ? 'var(--err)' : v >= 75 ? 'var(--high)' : 'var(--fg)'); // only high usage gets a color

  // ---------- sparkline ----------
  function drawSpark(svg, data, max) {
    const w = 300, h = 56;
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    if (data.length < 2) { svg.innerHTML = ''; return; }
    let lo = Math.min(...data), hi = Math.max(...data);
    if (max != null) { lo = Math.max(0, lo - (hi - lo) * 0.25 - 2); hi = Math.min(max, hi + (hi - lo) * 0.25 + 2); }
    else { lo = 0; hi = Math.max(hi * 1.15, 1); }
    const span = hi - lo || 1;
    const pts = data.map((v, i) => [(i / (data.length - 1)) * w, h - 2 - ((v - lo) / span) * (h - 4)]);
    const line = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join('');
    svg.innerHTML = `<path class="area" d="${line}L${w} ${h}L0 ${h}Z"/><path class="line" d="${line}"/>`;
  }

  function trend(series) {
    if (series.length < 6) return '';
    const a = series.slice(-3).reduce((x, y) => x + y, 0) / 3, b = series.slice(-6, -3).reduce((x, y) => x + y, 0) / 3;
    if (Math.abs(a - b) < 2) return '';
    return a > b ? '<span class="up">↑</span>' : '<span class="down">↓</span>';
  }

  // ---------- render ----------
  function renderMini() {
    const p = hist[hist.length - 1];
    if (!p) return;
    for (const [k, v] of [['Cpu', p.cpu], ['Mem', p.mem], ['Disk', p.disk]]) {
      $('#mp' + k).textContent = pct(v);
      const bar = $('#mp' + k + 'Bar');
      bar.style.width = Math.max(2, v) + '%';
      bar.style.background = levelColor(v);
    }
    if (sys) { $('#mpHost').textContent = sys.hostname; $('#mpUp').textContent = 'up ' + dur(sys.uptime * 1000); }
  }

  function issues() {
    const list = [];
    const p = hist[hist.length - 1];
    if (p) {
      if (p.disk >= 90) list.push('Disk is ' + pct(p.disk) + ' full');
      if (p.mem >= 90) list.push('Memory at ' + pct(p.mem));
      if (sys && sys.load[0] > sys.cores * 1.5) list.push('High load (' + sys.load[0].toFixed(2) + ')');
    }
    for (const pr of procs) if (pr.status !== 'online') list.push(pr.name + ' is ' + pr.status);
    for (const l of links) { const st = sites[l.url]; if (st && !st.ok) list.push(l.label + ' is down'); }
    return list;
  }

  function renderSummary() {
    const p = hist[hist.length - 1];
    const iss = issues();
    $('#monHeadline').textContent = !p ? 'Loading live metrics…' : iss.length ? `${iss.length} issue${iss.length === 1 ? '' : 's'} need${iss.length === 1 ? 's' : ''} attention` : 'Everything is healthy';
    $('#monSub').textContent = iss.length ? iss.slice(0, 4).join(' · ') + (iss.length > 4 ? ' …' : '') : 'All processes are online and every site is responding.';
    $('#monSub').className = iss.length ? 'bad-txt' : 'muted';
    const badge = $('#navAlert');
    badge.hidden = !iss.length; badge.textContent = iss.length;
    if (sys) {
      const online = procs.filter((x) => x.status === 'online').length;
      const up = links.filter((l) => sites[l.url]?.ok).length;
      const stats = $('#monStats');
      stats.replaceChildren();
      const add = (b, t) => { const s = el('span'); s.append(el('b', null, b), ' ', el('span', null, t)); stats.append(s); };
      add(`${online}/${procs.length}`, 'processes online');
      add(`${up}/${links.length}`, 'sites up');
      add(sys.load.map((x) => x.toFixed(2)).join(' '), 'load');
      add(dur(sys.uptime * 1000), 'uptime');
      add(sys.cores, 'cores');
    }
    if (p) for (const [k, v] of [['cpu', p.cpu], ['mem', p.mem], ['disk', p.disk]]) {
      const g = document.querySelector(`.gauge[data-g="${k}"]`);
      const c = g.querySelector('.g-val');
      c.style.strokeDashoffset = (169.6 * (1 - Math.min(100, v) / 100)).toFixed(1);
      c.style.stroke = levelColor(v);
      g.querySelector('b').textContent = pct(v);
    }
  }

  function renderPulse() {
    const p = hist[hist.length - 1];
    if (!p) return;
    const series = { cpu: hist.map((x) => x.cpu), mem: hist.map((x) => x.mem), disk: hist.map((x) => x.disk), net: hist.map((x) => x.rx + x.tx) };
    const val = { cpu: pct(p.cpu), mem: pct(p.mem), disk: pct(p.disk), net: rate(p.rx + p.tx) };
    const foot = {
      cpu: sys ? `${sys.cores} cores · load ${sys.load[0].toFixed(2)}` : '',
      mem: sys ? `${bytes(sys.memUsed)} of ${bytes(sys.memTotal)}${sys.swapTotal ? ' · swap ' + bytes(sys.swapUsed) : ''}` : '',
      disk: sys ? `${bytes(sys.diskUsed)} of ${bytes(sys.diskTotal)} used` : '',
      net: `↓ ${rate(p.rx)} · ↑ ${rate(p.tx)}`,
    };
    for (const k of ['cpu', 'mem', 'disk', 'net']) {
      const m = document.querySelector(`.metric[data-m="${k}"]`);
      m.querySelector('.m-top b').innerHTML = (k === 'net' ? '' : trend(series[k])) + val[k];
      m.className = 'metric ' + (k === 'net' ? '' : level(series[k][series[k].length - 1]));
      drawSpark(m.querySelector('.sparkline'), series[k], k === 'net' ? null : 100);
      m.querySelector('.m-foot').textContent = foot[k];
    }
  }

  function renderProcs() {
    const tb = $('#procs');
    tb.replaceChildren();
    $('#procCount').textContent = procs.length ? `${procs.filter((x) => x.status === 'online').length} of ${procs.length} online` : '';
    for (const pr of [...procs].sort((a, b) => (a.status === 'online') - (b.status === 'online') || a.name.localeCompare(b.name))) {
      const tr = el('tr');
      const st = pr.status === 'online' ? 'ok' : pr.status === 'stopped' ? 'warn' : 'bad';
      const badge = el('span', 'badge ' + st); badge.append(el('span', 'status-dot ' + (st === 'ok' ? 'ok' : st === 'warn' ? 'slow' : 'bad')), pr.status[0].toUpperCase() + pr.status.slice(1));
      const tdS = el('td'); tdS.append(badge);
      const restarts = el('td', 'r mono' + (pr.restarts > 20 ? ' warn-txt' : ''), pr.restarts);
      const act = el('td'); const box = el('div', 'row-act');
      const logsB = el('button', null, 'Logs'); logsB.onclick = () => openLogs(pr.name);
      const askB = el('button', null, 'Ask Claude'); askB.onclick = () => window.App.startChat(`Check on the pm2 process "${pr.name}" (status: ${pr.status}, ${pr.restarts} restarts, ${bytes(pr.mem)} memory). Look at its recent logs and tell me if anything is wrong and what you'd fix.`);
      const rsB = el('button', 'danger', 'Restart'); rsB.onclick = () => restart(pr.name, rsB);
      box.append(logsB, askB, rsB); act.append(box);
      tr.append(el('td', 'name', pr.name), tdS, el('td', 'r mono', pr.cpu + '%'), el('td', 'r mono', bytes(pr.mem)), restarts, el('td', 'r mono', pr.uptime ? dur(pr.uptime) : '–'), act);
      tb.append(tr);
    }
    if (!procs.length) { const tr = el('tr'); const td = el('td', 'muted', 'Loading processes…'); td.colSpan = 7; tr.append(td); tb.append(tr); }
  }

  function renderLinks() {
    const box = $('#links');
    box.replaceChildren();
    for (const l of links) {
      const a = el('a', 'link'); a.href = l.url; a.target = '_blank'; a.rel = 'noopener';
      let host = ''; try { host = new URL(l.url).host; } catch {}
      const fav = el('img'); fav.alt = ''; fav.loading = 'lazy';
      fav.src = new URL('/favicon.ico', l.url).href;
      fav.onerror = () => { const f = el('span', 'fav', (l.label || host)[0]?.toUpperCase() || '?'); fav.replaceWith(f); };
      const meta = el('div', 'l-meta');
      const st = sites[l.url];
      const line = el('span');
      const dot = el('span', 'status-dot ' + (!st ? '' : !st.ok ? 'bad' : st.ms > 1500 ? 'slow' : 'ok'));
      line.append(dot, !st ? 'Checking…' : st.ok ? `${st.code} · ${st.ms} ms` : st.code ? `Error ${st.code}` : `Down · ${st.error}`);
      meta.append(el('b', null, l.label || host), line);
      meta.title = l.url;
      const act = el('div', 'l-act');
      const ask = el('button'); ask.title = 'Ask Claude about this site'; ask.setAttribute('aria-label', ask.title);
      ask.innerHTML = '<svg viewBox="0 0 20 20" width="15" height="15"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h7A2.5 2.5 0 0 1 16 5.5v5a2.5 2.5 0 0 1-2.5 2.5H9l-3.5 3v-3H6.5A2.5 2.5 0 0 1 4 10.5z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>';
      ask.onclick = (e) => { e.preventDefault(); window.App.startChat(`Check ${l.url}: is it healthy? Look at how it's served on this server (nginx config, the app/process behind it, recent errors) and tell me about anything that needs attention.${st && !st.ok ? ` The uptime check currently reports it as down (${st.code || st.error}).` : ''}`); };
      const del = el('button'); del.title = 'Remove shortcut'; del.setAttribute('aria-label', del.title);
      del.innerHTML = '<svg viewBox="0 0 20 20" width="14" height="14"><path d="M6 6l8 8M14 6l-8 8" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>';
      del.onclick = (e) => { e.preventDefault(); if (confirm(`Remove ${l.label} from Quick access?`)) saveLinks(links.filter((x) => x !== l)); };
      act.append(ask, del);
      a.append(fav, meta, act);
      box.append(a);
    }
  }

  function renderAll() { renderMini(); if (!$('#viewMonitor').hidden) { renderSummary(); renderPulse(); } else renderSummaryBadgeOnly(); }
  function renderSummaryBadgeOnly() {
    const iss = issues(); const badge = $('#navAlert');
    badge.hidden = !iss.length; badge.textContent = iss.length;
  }

  // ---------- data ----------
  async function loadLinks() {
    try { links = await (await fetch('/claude/api/links', { cache: 'no-store' })).json(); } catch {}
    renderLinks(); renderSummaryBadgeOnly();
  }
  async function saveLinks(next) {
    const r = await fetch('/claude/api/links', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(next) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return window.App.toast(j.error || 'Could not save');
    links = j; renderLinks(); renderAll();
  }

  async function restart(name, btn) {
    if (!confirm(`Restart ${name}?`)) return;
    btn.disabled = true; btn.textContent = 'Restarting…';
    const r = await fetch('/claude/api/pm2/restart', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) }).then((x) => x.json()).catch(() => ({ ok: false }));
    window.App.toast(r.ok ? `${name} restarted` : `Restart failed: ${r.error || 'error'}`);
    btn.disabled = false; btn.textContent = 'Restart';
  }

  // ---------- logs sheet ----------
  let logsName = null, logsData = null, logsTab = 'err';
  async function openLogs(name) {
    logsName = name; $('#logsTitle').textContent = name + ' logs';
    $('#logs').hidden = false; $('#logsBody').textContent = 'Loading…';
    try { logsData = await (await fetch('/claude/api/pm2/logs?name=' + encodeURIComponent(name), { cache: 'no-store' })).json(); } catch { logsData = { err: 'Could not load logs', out: '' }; }
    if (logsTab === 'err' && !logsData.err && logsData.out) logsTab = 'out';
    showLogs();
  }
  function showLogs() {
    document.querySelectorAll('.log-tabs button').forEach((b) => b.classList.toggle('on', b.dataset.t === logsTab));
    const body = $('#logsBody');
    body.textContent = (logsData && logsData[logsTab]) || '(empty)';
    body.scrollTop = body.scrollHeight;
  }
  document.querySelectorAll('.log-tabs button').forEach((b) => (b.onclick = () => { logsTab = b.dataset.t; showLogs(); }));
  $('#logsRefresh').onclick = () => openLogs(logsName);
  $('#logsClose').onclick = () => ($('#logs').hidden = true);
  $('#logs').addEventListener('click', (e) => { if (e.target.id === 'logs') $('#logs').hidden = true; });
  $('#logsAsk').onclick = () => {
    $('#logs').hidden = true;
    window.App.startChat(`Look at the recent ${logsTab === 'err' ? 'error' : 'output'} logs of the pm2 process "${logsName}" and explain what's going on, and whether anything needs fixing.`);
  };
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('#logs').hidden = true; });

  // ---------- add shortcut ----------
  $('#linkAdd').onclick = () => { $('#linkForm').hidden = false; $('#linkUrl').focus(); };
  $('#linkCancel').onclick = () => { $('#linkForm').hidden = true; $('#linkForm').reset(); };
  $('#linkForm').onsubmit = (e) => {
    e.preventDefault();
    let url = $('#linkUrl').value.trim();
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    saveLinks([...links, { label: $('#linkLabel').value.trim(), url }]);
    $('#linkForm').hidden = true; $('#linkForm').reset();
  };

  window.Monitor = {
    handle(m) {
      if (m.type === 'monitor_init') { hist = m.history || []; sys = m.sys; procs = m.processes || []; sites = m.sites || {}; renderProcs(); renderLinks(); }
      else if (m.type === 'metrics') { hist.push(m.point); if (hist.length > 150) hist.shift(); sys = m.sys; }
      else if (m.type === 'processes') { procs = m.processes; if (!$('#viewMonitor').hidden) renderProcs(); }
      else if (m.type === 'sites') { sites = m.status; renderLinks(); window.Sites?.refreshStatus(); }
      renderAll();
    },
    shown() { renderProcs(); renderLinks(); renderSummary(); renderPulse(); },
    statusFor(url) { return sites[url]; },
    proc(name) { return procs.find((p) => p.name === name); },
  };
  loadLinks();
})();
