// Skills view (#/skills): install Claude skills from GitHub, view / update / disable / remove them.
// Backend: orbit-skills (skills.mjs, :3023) at /orbit/api/skills/. Skills live in ~/.claude/skills/<name>/.
(() => {
  const API = '/orbit/api/skills/';
  const $ = (s, el = document) => el.querySelector(s);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const toast = (t) => window.App?.toast(t);
  const bytes = (n) => { const u = ['B', 'KB', 'MB', 'GB']; let i = 0; while (n >= 1024 && i < 3) { n /= 1024; i++; } return (n >= 100 || !i ? Math.round(n) : n.toFixed(1)) + ' ' + u[i]; };
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const ago = (t) => { const s = (Date.now() - t) / 1000; return s < 60 ? 'just now' : s < 3600 ? Math.floor(s / 60) + 'm ago' : s < 86400 ? Math.floor(s / 3600) + 'h ago' : Math.floor(s / 86400) + 'd ago'; };

  let data = null, result = null, busy = false;
  const picked = new Set();
  const open = new Set(); // expanded previews: key -> loaded

  async function api(path, body) {
    const r = await fetch(API + path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { cache: 'no-store' });
    const j = await r.json().catch(() => ({ error: 'The skills service is not responding.' }));
    if (!r.ok) throw new Error(j.error || 'Something went wrong');
    return j;
  }

  async function load() {
    try { data = await api(''); } catch (e) { data = { error: e.message, skills: [], synced: [] }; }
    render();
  }

  // ---------- render ----------
  function render() {
    const root = $('#skillsRoot');
    if (!root || !data) return;
    const n = data.skills.filter((s) => s.where === 'enabled').length;
    $('#skillsHeadline').textContent = data.error ? 'Skills' : `${plural(n, 'skill')} on`;
    const off = data.skills.length - n;
    $('#skillsStats').replaceChildren(
      ...[[data.skills.length, 'installed'], [off, 'turned off'], [data.synced.length, 'from claude.ai']].filter(([v], i) => i === 0 || v)
        .map(([v, l]) => { const s = el('span'); s.append(el('b', '', String(v)), ' ', el('span', '', l)); return s; }),
    );
    renderResults();
    renderInstalled();
  }

  function renderResults() {
    const box = $('#skResults');
    box.replaceChildren();
    if (!result) return;
    const head = el('div', 'sk-res-head');
    const repo = el('a', 'sk-repo', `${result.owner}/${result.repo}`);
    repo.href = `https://github.com/${result.owner}/${result.repo}`; repo.target = '_blank'; repo.rel = 'noopener';
    const meta = el('span', 'muted small', [result.ref, result.sub, result.sha ? result.sha.slice(0, 7) : '', result.stars != null ? `${result.stars.toLocaleString()} stars` : ''].filter(Boolean).join(' · '));
    head.append(repo, meta);
    box.append(head);
    if (!result.skills.length) { box.append(el('p', 'sk-empty', 'No skills found here. A skill is a folder with a SKILL.md file in it.')); return; }

    const tools = el('div', 'sk-res-tools');
    const all = el('button', 'linkish', picked.size === result.skills.length ? 'Select none' : 'Select all');
    all.type = 'button';
    all.onclick = () => { if (picked.size === result.skills.length) picked.clear(); else result.skills.forEach((s) => !s.reserved && picked.add(s.path)); render(); };
    tools.append(el('span', 'muted small', `Found ${plural(result.skills.length, 'skill')}`), all);
    box.append(tools);

    const list = el('div', 'sk-list');
    for (const s of result.skills) {
      const row = el('label', 'sk-row pick');
      const cb = el('input'); cb.type = 'checkbox'; cb.checked = picked.has(s.path); cb.disabled = s.reserved;
      cb.onchange = () => { cb.checked ? picked.add(s.path) : picked.delete(s.path); updateInstallBtn(); };
      const main = el('div', 'sk-main');
      const top = el('div', 'sk-top');
      top.append(el('b', '', s.name));
      if (s.conflict) top.append(el('span', 'sk-note', s.conflict.same ? 'Installed · will update' : 'Replaces installed skill'));
      main.append(top);
      if (s.description) main.append(el('p', 'sk-desc', s.description));
      const facts = [s.path || '(repo root)', plural(s.files, 'file'), bytes(s.bytes)];
      if (s.scriptCount) facts.push(plural(s.scriptCount, 'script'));
      main.append(el('div', 'sk-facts mono', facts.join(' · ')));
      main.append(previewToggle(`scan:${s.path}`, () => `file?scan=${result.id}&path=${encodeURIComponent(s.path)}`));
      row.append(cb, main);
      list.append(row);
    }
    box.append(list);

    const foot = el('div', 'sk-res-foot');
    const warn = el('p', 'sk-warn', 'Skills are instructions Claude follows, and some include scripts Claude may run. Install only from sources you trust, and read the SKILL.md first.');
    const btn = el('button', 'btn primary', ''); btn.id = 'skInstall'; btn.type = 'button';
    btn.onclick = install;
    foot.append(warn, btn);
    box.append(foot);
    updateInstallBtn();
  }

  function updateInstallBtn() {
    const b = $('#skInstall'); if (!b) return;
    b.textContent = busy ? 'Installing…' : picked.size ? `Install ${plural(picked.size, 'skill')}` : 'Select skills to install';
    b.disabled = busy || !picked.size;
  }

  function previewToggle(key, url) {
    const wrap = el('div', 'sk-prev');
    const t = el('button', 'linkish', open.has(key) ? 'Hide SKILL.md' : 'Read SKILL.md');
    t.type = 'button';
    const body = el('div', 'sk-md');
    body.hidden = !open.has(key);
    const fill = async () => {
      body.replaceChildren(el('span', 'muted small', 'Loading…'));
      try {
        const j = await api(url());
        const md = j.text.replace(/^﻿?---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
        const div = el('div', 'prose');
        div.innerHTML = window.DOMPurify ? DOMPurify.sanitize(marked.parse(md)) : '';
        if (!window.DOMPurify) div.textContent = md;
        body.replaceChildren(div);
        if (j.scripts?.length) {
          const s = el('div', 'sk-scripts');
          s.append(el('span', 'muted small', 'Scripts in this skill: '), el('span', 'mono small', j.scripts.join(', ')));
          body.append(s);
        }
        if (j.truncated) body.append(el('p', 'muted small', 'Cut off: the file is long.'));
      } catch (e) { body.replaceChildren(el('span', 'bad-txt small', e.message)); }
    };
    t.onclick = (e) => {
      e.preventDefault(); e.stopPropagation();
      if (open.has(key)) { open.delete(key); body.hidden = true; t.textContent = 'Read SKILL.md'; return; }
      open.add(key); body.hidden = false; t.textContent = 'Hide SKILL.md'; fill();
    };
    if (open.has(key)) fill();
    wrap.append(t, body);
    return wrap;
  }

  function renderInstalled() {
    const box = $('#skInstalled');
    box.replaceChildren();
    if (data.error) { box.append(el('p', 'sk-empty bad-txt', data.error)); return; }
    if (!data.skills.length) box.append(el('p', 'sk-empty', 'No skills installed yet. Add one from GitHub above.'));
    else {
      const list = el('div', 'sk-list');
      for (const s of data.skills) list.append(installedRow(s));
      box.append(list);
    }
    const sy = $('#skSynced');
    sy.replaceChildren();
    $('#skSyncedCard').hidden = !data.synced.length;
    const shown = localStorage.getItem('orbit_sk_synced') === '1';
    $('#skSyncedToggle').textContent = shown ? 'Hide' : `Show ${data.synced.length}`;
    $('#skSyncedToggle').onclick = () => { localStorage.setItem('orbit_sk_synced', shown ? '0' : '1'); renderInstalled(); };
    if (data.synced.length && shown) {
      const list = el('div', 'sk-list');
      for (const s of data.synced) list.append(installedRow(s, true));
      sy.append(list);
    }
  }

  function installedRow(s, synced = false) {
    const row = el('div', 'sk-row' + (s.where === 'disabled' ? ' off' : ''));
    const main = el('div', 'sk-main');
    const top = el('div', 'sk-top');
    top.append(el('b', '', s.name));
    if (s.where === 'disabled') top.append(el('span', 'sk-note', 'Off'));
    main.append(top);
    if (s.description) main.append(el('p', 'sk-desc', s.description));
    const facts = el('div', 'sk-facts');
    if (s.source) {
      const a = el('a', '', `${s.source.owner}/${s.source.repo}${s.source.path ? '/' + s.source.path : ''}`);
      a.href = s.source.url; a.target = '_blank'; a.rel = 'noopener';
      facts.append(a, ` · installed ${ago(Date.parse(s.source.installedAt))}`);
    } else facts.append(synced ? 'Synced from claude.ai' : 'Added by hand');
    facts.append(` · ${plural(s.files, 'file')}${s.scriptCount ? ' · ' + plural(s.scriptCount, 'script') : ''}`);
    main.append(facts);
    main.append(previewToggle(`${s.where}:${s.name}`, () => `file?name=${encodeURIComponent(s.name)}&where=${s.where}`));
    row.append(main);
    if (!synced) {
      const acts = el('div', 'row-act sk-acts');
      const mk = (label, fn, cls) => { const b = el('button', cls || '', label); b.type = 'button'; b.onclick = () => act(b, fn); return b; };
      if (s.source) acts.append(mk('Update', async () => {
        const j = await api('update', { name: s.name });
        toast(j.changed ? `${s.name} updated to ${String(j.to || '').slice(0, 7) || 'the latest version'}` : `${s.name} is already up to date`);
      }));
      acts.append(mk(s.where === 'disabled' ? 'Turn on' : 'Turn off', async () => {
        const j = await api('toggle', { name: s.name });
        toast(j.where === 'enabled' ? `${s.name} is on for new chats` : `${s.name} is off for new chats`);
      }));
      acts.append(mk('Review', async () => {
        window.App.startChat(`Review the Claude skill "${s.name}" installed at ~/.claude/${s.where === 'disabled' ? 'skills-disabled' : 'skills'}/${s.name}/ before I rely on it. Read SKILL.md and every script or file it references. Tell me in plain words what it makes Claude do, whether any script touches the network, credentials, files outside its folder, or runs anything risky, and whether you think it's safe to keep. Don't change anything.`);
      }));
      acts.append(mk('Remove', async () => {
        if (!confirm(`Remove the skill "${s.name}"? It's moved to the trash folder, not deleted.`)) throw null;
        await api('remove', { name: s.name });
        toast(`${s.name} removed`);
      }, 'danger'));
      row.append(acts);
    }
    return row;
  }

  async function act(btn, fn) {
    const label = btn.textContent;
    btn.disabled = true; btn.textContent = '…';
    try { await fn(); await load(); } catch (e) { if (e) toast(e.message); btn.disabled = false; btn.textContent = label; }
  }

  // ---------- search + install ----------
  async function search(url) {
    url = (url ?? $('#skUrl').value).trim();
    if (!url) { $('#skUrl').focus(); return; }
    $('#skUrl').value = url;
    const b = $('#skFind');
    b.disabled = true; b.textContent = 'Searching…';
    $('#skErr').hidden = true;
    try {
      result = await api('scan', { url });
      picked.clear(); open.clear();
      if (result.skills.length === 1 && !result.skills[0].reserved) picked.add(result.skills[0].path);
      render();
      $('#skResults').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    } catch (e) { $('#skErr').textContent = e.message; $('#skErr').hidden = false; }
    b.disabled = false; b.textContent = 'Find skills';
  }

  async function install() {
    if (!picked.size || busy) return;
    const paths = [...picked];
    const conflicts = result.skills.filter((s) => picked.has(s.path) && s.conflict);
    if (conflicts.length && !confirm(`${conflicts.map((s) => s.name).join(', ')} ${conflicts.length === 1 ? 'is' : 'are'} already installed. Replace with this version? The old copy goes to the trash folder.`)) return;
    busy = true; updateInstallBtn();
    try {
      const j = await api('install', { scan: result.id, paths, overwrite: conflicts.length > 0 });
      const ok = j.results.filter((r) => r.ok), bad = j.results.filter((r) => !r.ok);
      if (ok.length) toast(`Installed ${ok.map((r) => r.name).join(', ')}. New chats can use ${ok.length === 1 ? 'it' : 'them'}.`);
      if (bad.length) $('#skErr').textContent = bad.map((r) => `${r.path}: ${r.error}`).join(' '), $('#skErr').hidden = false;
      if (ok.length && !bad.length) { result = null; picked.clear(); $('#skUrl').value = ''; }
    } catch (e) { toast(e.message); }
    busy = false;
    await load();
  }

  $('#skForm').addEventListener('submit', (e) => { e.preventDefault(); search(); });
  document.querySelectorAll('#skExamples [data-url]').forEach((b) => (b.onclick = () => search(b.dataset.url)));

  window.Skills = { shown: load };
  if (location.hash === '#/skills') load();
})();
