// Sites & backups view: per-site snapshot / full backup, archive list, schedule.
// Job progress arrives over the chat socket (backup_job / backups_changed).
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

  let data = null;
  const jobs = new Map(); // site -> live job
  const expanded = new Set();

  function bytes(n) {
    if (!n) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return (n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)) + ' ' + u[i];
  }
  function ago(t) {
    const s = (Date.now() - t) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return Math.floor(s / 86400) + 'd ago';
  }
  const fmtDate = (t) => new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

  async function load() {
    try {
      const r = await fetch('/claude/api/sites', { cache: 'no-store' });
      data = await r.json();
    } catch { return; }
    if (data.jobs.current) jobs.set(data.jobs.current.site, data.jobs.current);
    for (const q of data.jobs.queued) jobs.set(q.site, q);
    render();
  }

  async function post(pathname, body) {
    const r = await fetch('/claude/api/sites/' + pathname, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.ok === false) window.App.toast(j.error || 'Something went wrong');
    return j;
  }

  function updateBadge() {
    const n = [...jobs.values()].filter((j) => ['queued', 'running'].includes(j.status)).length;
    const b = $('#navJob'); b.hidden = !n; b.textContent = n;
  }

  function render() {
    updateBadge();
    if (!data || $('#viewSites').hidden) return;
    const total = data.sites.reduce((n, s) => n + s.archives.length, 0);
    const protectedN = data.sites.filter((s) => s.archives.length).length;
    $('#sitesHeadline').textContent = `${data.sites.length} sites · ${protectedN} backed up`;
    const stats = $('#sitesStats'); stats.replaceChildren();
    const add = (b, t) => { const s = el('span'); s.append(el('b', null, b), ' ', el('span', null, t)); stats.append(s); };
    add(total, total === 1 ? 'archive' : 'archives');
    add(bytes(data.storage.used), 'used by backups');
    add(bytes(data.storage.free), 'free on disk');
    add(data.sites.filter((s) => s.schedule !== 'off').length, 'on a schedule');

    const box = $('#siteCards');
    box.replaceChildren();
    for (const s of data.sites) box.append(siteCard(s));
  }

  function statusLine(s) {
    const st = window.Monitor?.statusFor('https://' + s.name + '/');
    const span = el('span');
    const dot = el('span', 'status-dot ' + (!st ? '' : !st.ok ? 'bad' : st.ms > 1500 ? 'slow' : 'ok'));
    const last = s.archives[0];
    span.append(dot, (!st ? 'Checking' : st.ok ? 'Up' : 'Down') + ' · ' + (last ? `last ${last.type} ${ago(last.at)}` : 'no backups yet'));
    if (s.domains.length > 1) span.append(' · ' + s.domains.slice(1).join(', '));
    return span;
  }

  function siteCard(s) {
    const card = el('div', 'card site');
    card.dataset.site = s.id;

    // head
    const head = el('div', 'site-head');
    const fav = el('div', 'fav', s.name[0].toUpperCase());
    const img = el('img'); img.alt = ''; img.src = `https://${s.name}/favicon.ico`;
    img.onload = () => { fav.textContent = ''; fav.append(img); };
    const title = el('div', 'site-title');
    const a = el('a', null, s.name); a.href = 'https://' + s.name + '/'; a.target = '_blank'; a.rel = 'noopener';
    title.append(a, statusLine(s));
    const actions = el('div', 'site-actions');
    const job = jobs.get(s.id);
    const busy = job && ['queued', 'running'].includes(job.status);
    const snap = el('button', 'btn primary sm', 'Snapshot');
    snap.title = 'Code, data, config and database dumps (skips node_modules / build output)';
    snap.disabled = busy;
    snap.onclick = () => start(s, 'snapshot');
    const full = el('button', 'btn sm', 'Full backup');
    full.title = 'Everything, including dependencies, build output and TLS certificates';
    full.disabled = busy;
    full.onclick = () => start(s, 'full');
    const sched = dropdown(s.schedule, SCHEDULES, async (v) => {
      await post('schedule', { site: s.id, schedule: v });
      s.schedule = v;
      window.App.toast(v === 'off' ? `Auto snapshots off for ${s.name}` : `${s.name}: ${v} snapshots at ~04:00`);
    });
    actions.append(snap, full, sched);
    head.append(fav, title, actions);
    card.append(head);

    // what's in it
    const stack = el('div', 'stack');
    const tag = (kind, label, titleText) => { const t = el('span', 'tag'); t.append(el('i', null, kind), el('b', null, label)); if (titleText) t.title = titleText; stack.append(t); };
    for (const d of s.dirs) tag(d.kind === 'web' ? 'files' : d.kind, d.path.replace(/^\/var\/www\//, ''), d.path + (d.kind === 'build' ? ' (full backups only)' : ''));
    for (const p of s.processes) {
      const pr = window.Monitor?.proc(p);
      tag('pm2', p + (pr && pr.status !== 'online' ? ' · ' + pr.status : ''), pr ? `${p}: ${pr.status}` : p);
    }
    for (const db of s.sqlite) tag('sqlite', db.split('/').pop(), db);
    for (const db of s.postgres) tag('postgres', db.name, 'from ' + db.from);
    tag('nginx', s.nginx.split('/').pop(), s.nginx);
    card.append(stack);

    // running job
    if (job && job.status !== 'done' && job.status !== 'cancelled') {
      const jb = el('div', 'job-bar' + (job.status === 'failed' ? ' failed' : ''));
      const row = el('div', 'row');
      const label = job.status === 'queued' ? `${cap(job.type)} queued — waiting for another backup to finish`
        : job.status === 'failed' ? `${cap(job.type)} failed: ${job.error}` : `${cap(job.type)} · ${job.step}`;
      row.append(el('span', null, label));
      const right = el('span', 'mono');
      if (job.status === 'running') right.textContent = bytes(job.bytes) + ' · ' + Math.round((Date.now() - job.startedAt) / 1000) + 's';
      row.append(right);
      if (busy) { const c = el('button', 'linkish', 'Cancel'); c.onclick = () => post('cancel', { site: s.id }); row.append(c); }
      if (job.status === 'failed') { const x = el('button', 'linkish', 'Dismiss'); x.onclick = () => { jobs.delete(s.id); render(); }; row.append(x); }
      jb.append(row);
      if (busy) { const tr = el('div', 'track'); tr.append(el('i')); jb.append(tr); }
      card.append(jb);
    }

    // archives
    const list = s.archives;
    if (!list.length) card.append(el('div', 'empty-row', 'No backups yet. A snapshot takes a few seconds for small sites.'));
    else {
      const wrap = el('div', 'table-wrap');
      const table = el('table', 'archives');
      const shown = expanded.has(s.id) ? list : list.slice(0, 4);
      for (const ar of shown) table.append(archiveRow(s, ar));
      wrap.append(table);
      card.append(wrap);
      if (list.length > 4) {
        const more = el('button', 'more', expanded.has(s.id) ? 'Show less' : `Show all ${list.length} archives`);
        more.onclick = () => { expanded.has(s.id) ? expanded.delete(s.id) : expanded.add(s.id); render(); };
        card.append(more);
      }
    }
    return card;
  }

  const cap = (t) => t[0].toUpperCase() + t.slice(1);

  // ---------- custom dropdown (replaces the native <select>) ----------
  const ICONS = {
    off: '<svg viewBox="0 0 20 20" width="16" height="16"><circle cx="10" cy="10" r="6.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M5.5 14.5l9-9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
    daily: '<svg viewBox="0 0 20 20" width="16" height="16"><circle cx="10" cy="10" r="6.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M10 6.5V10l2.5 1.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
    weekly: '<svg viewBox="0 0 20 20" width="16" height="16"><rect x="3.5" y="4.5" width="13" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M3.5 8.5h13M7 3v3M13 3v3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  };
  const SCHEDULES = [
    { value: 'off', label: 'Off', short: 'Auto: off', desc: 'Only when you click Snapshot' },
    { value: 'daily', label: 'Daily', short: 'Auto: daily', desc: 'Nightly at ~04:00 · keeps last 7' },
    { value: 'weekly', label: 'Weekly', short: 'Auto: weekly', desc: 'Weekly at ~04:00 · keeps last 7' },
  ];
  let openDd = null;
  function closeDd() { if (openDd) { openDd.classList.remove('open'); openDd.querySelector('.dd-btn').setAttribute('aria-expanded', 'false'); openDd = null; } }
  document.addEventListener('click', (e) => { if (openDd && !openDd.contains(e.target)) closeDd(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDd(); });

  function dropdown(value, options, onChange) {
    const wrap = el('div', 'dd');
    const btn = el('button', 'dd-btn'); btn.type = 'button';
    btn.setAttribute('aria-haspopup', 'listbox'); btn.setAttribute('aria-expanded', 'false');
    const menu = el('div', 'dd-menu'); menu.setAttribute('role', 'listbox');
    const paint = () => {
      const cur = options.find((o) => o.value === value) || options[0];
      btn.innerHTML = `<span class="dd-ico ${cur.value}">${ICONS[cur.value] || ''}</span><span>${cur.short}</span><svg class="dd-chev" viewBox="0 0 20 20" width="14" height="14"><path d="M6 8l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
      menu.replaceChildren();
      menu.append(el('div', 'pop-title', 'Automatic snapshots'));
      for (const o of options) {
        const it = el('button', 'dd-item' + (o.value === value ? ' sel' : '')); it.type = 'button';
        it.setAttribute('role', 'option'); it.setAttribute('aria-selected', o.value === value);
        it.innerHTML = `<span class="dd-ico ${o.value}">${ICONS[o.value] || ''}</span><span class="pop-txt"><b></b><small></small></span><svg class="dd-check" viewBox="0 0 20 20" width="16" height="16"><path d="M5 10.5l3.2 3L15 6.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
        it.querySelector('b').textContent = o.label; it.querySelector('small').textContent = o.desc;
        it.onclick = () => { closeDd(); if (o.value !== value) { value = o.value; paint(); onChange(value); } };
        menu.append(it);
      }
    };
    btn.onclick = (e) => {
      e.stopPropagation();
      const was = openDd === wrap; closeDd();
      if (was) return;
      wrap.classList.remove('up');
      wrap.classList.add('open'); btn.setAttribute('aria-expanded', 'true'); openDd = wrap;
      // flip upward when the menu would run off the bottom of the screen
      const m = menu.getBoundingClientRect(), r = btn.getBoundingClientRect();
      if (m.bottom > window.innerHeight - 8 && r.top - m.height - 8 > 0) wrap.classList.add('up');
      (menu.querySelector('.sel') || menu.querySelector('.dd-item')).focus({ preventScroll: true });
    };
    menu.addEventListener('keydown', (e) => {
      const items = [...menu.querySelectorAll('.dd-item')], i = items.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
      if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
      if (e.key === 'Escape') { closeDd(); btn.focus(); }
    });
    paint();
    wrap.append(btn, menu);
    return wrap;
  }

  function archiveRow(s, ar) {
    const tr = el('tr');
    const when = el('td', 'when'); when.append(el('b', null, fmtDate(ar.at)), el('span', null, ago(ar.at)));
    const type = el('td'); type.append(el('span', 'type ' + ar.type, ar.type === 'full' ? 'Full' : 'Snapshot'));
    if (ar.auto) type.append(el('span', 'type auto', 'auto'));
    if (ar.warnings?.length) { const w = el('span', 'warn-ico', 'warnings'); w.title = ar.warnings.join('\n'); type.append(w); }
    const size = el('td', 'r mono', bytes(ar.size));
    const note = el('td', 'note', ar.note || (ar.seconds != null ? `took ${ar.seconds}s` : ''));
    const act = el('td'); const box = el('div', 'row-act');
    const dl = el('button', null, 'Download');
    dl.onclick = () => { location.href = `/claude/api/sites/download?site=${encodeURIComponent(s.id)}&file=${encodeURIComponent(ar.file)}`; };
    const restore = el('button', null, 'Restore…');
    restore.title = 'Claude walks you through restoring this archive, step by step';
    restore.onclick = () => window.App.startChat(
      `I want to restore ${s.name} from the backup archive ${ar.path} (${ar.type}, made ${fmtDate(ar.at)}).\n` +
      `First: read _backup/meta.json inside the archive (tar -xzOf ... _backup/meta.json), take a fresh snapshot of the current state into /root/backups/sites/${s.id}/ ` +
      `(tar of the same folders, so we can undo), and show me exactly which folders, databases and configs would be overwritten. ` +
      `Wait for my go-ahead before extracting anything. After restoring, restore the databases from _backup/db, restart these pm2 apps: ${s.processes.join(', ') || 'none'}, ` +
      `run nginx -t and reload, and check that https://${s.name}/ responds.`);
    const del = el('button', 'danger', 'Delete');
    del.onclick = async () => { if (confirm(`Delete this ${ar.type} of ${s.name} from ${fmtDate(ar.at)}? This can't be undone.`)) { await post('delete', { site: s.id, file: ar.file }); load(); } };
    box.append(dl, restore, del);
    act.append(box);
    size.classList.add('hide-sm');
    tr.append(when, type, size, note, act);
    return tr;
  }

  async function start(s, type) {
    if (type === 'full' && !confirm(`Full backup of ${s.name}? It includes node_modules and build output, so it can take a while and use more disk (${bytes(data.storage.free)} free).`)) return;
    const r = await post('backup', { site: s.id, type });
    if (r.ok) { if (!jobs.has(s.id)) jobs.set(s.id, { site: s.id, type, status: 'queued', step: 'Waiting' }); render(); }
  }

  $('#snapAll').onclick = async () => {
    if (!data || !confirm(`Queue a snapshot of all ${data.sites.length} sites? They run one at a time in the background.`)) return;
    for (const s of data.sites) if (!jobs.has(s.id) || !['queued', 'running'].includes(jobs.get(s.id).status)) {
      const r = await post('backup', { site: s.id, type: 'snapshot' });
      if (r.ok && !jobs.has(s.id)) jobs.set(s.id, { site: s.id, type: 'snapshot', status: 'queued', step: 'Waiting' });
    }
    render();
  };

  let tickTimer = null;
  window.Sites = {
    handle(m) {
      if (m.type === 'backup_job') {
        const j = m.job;
        const prev = jobs.get(j.site);
        jobs.set(j.site, j);
        if (j.status === 'done') {
          jobs.delete(j.site);
          window.App.toast(`${cap(j.type)} of ${j.site} finished · ${bytes(j.bytes)}${j.warnings?.length ? ' (with warnings)' : ''}`);
        } else if (j.status === 'failed' && prev?.status !== 'failed') window.App.toast(`${cap(j.type)} of ${j.site} failed`);
        else if (j.status === 'cancelled') jobs.delete(j.site);
        // keep re-renders cheap while bytes tick up
        if (j.status === 'running' && prev?.status === 'running' && prev.step === j.step) return patchJob(j);
        render();
      } else if (m.type === 'backups_changed') load();
    },
    shown() { load(); clearInterval(tickTimer); tickTimer = setInterval(() => { if ($('#viewSites').hidden) clearInterval(tickTimer); }, 5000); },
    refreshStatus() { if (data && !$('#viewSites').hidden) render(); },
  };

  function patchJob(j) {
    const right = document.querySelector(`.site[data-site="${CSS.escape(j.site)}"] .job-bar .mono`);
    if (right) right.textContent = bytes(j.bytes) + ' · ' + Math.round((Date.now() - j.startedAt) / 1000) + 's';
  }

  load();
})();
