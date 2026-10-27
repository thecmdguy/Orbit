// Project editor: file tree, Monaco tabs, project search/replace, Claude's change history
// with a diff viewer, save with conflict detection, and polling for changes made on disk.
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const toast = (t) => window.App?.toast(t);
  const store = {
    get(k, d) { try { const v = localStorage.getItem('cw_ed_' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('cw_ed_' + k, JSON.stringify(v)); } catch {} },
  };

  async function api(pathname, body) {
    const r = await fetch('/orbit/api/' + pathname, body === undefined ? { cache: 'no-store' } : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(j.error || 'Request failed'); e.status = r.status; e.data = j; throw e; }
    return j;
  }
  const q = (o) => new URLSearchParams(o).toString();
  const base = (p) => p.split('/').pop();
  const dirOf = (p) => p.slice(0, p.lastIndexOf('/')) || '/';
  const join = (d, n) => (d === '/' ? '' : d) + '/' + n;
  function ago(t) {
    const s = (Date.now() - t) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return Math.floor(s / 86400) + 'd ago';
  }

  // ---------- file icons ----------
  const ICON = {
    ts: ['TS', '#3178c6'], tsx: ['TSX', '#3178c6'], js: ['JS', '#d4a72c'], jsx: ['JSX', '#d4a72c'], mjs: ['JS', '#d4a72c'], cjs: ['JS', '#d4a72c'],
    json: ['{}', '#a3a3a3'], css: ['#', '#7c4dff'], scss: ['#', '#cd6799'], html: ['<>', '#e34c26'], md: ['M', '#6b7280'], py: ['PY', '#3572a5'],
    sh: ['$', '#16a34a'], yml: ['Y', '#cb171e'], yaml: ['Y', '#cb171e'], sql: ['SQ', '#e38c00'], env: ['E', '#ca8a04'], conf: ['CF', '#6b7280'],
    svg: ['SV', '#ff9900'], png: ['IM', '#0ea5e9'], jpg: ['IM', '#0ea5e9'], jpeg: ['IM', '#0ea5e9'], webp: ['IM', '#0ea5e9'], gif: ['IM', '#0ea5e9'],
    txt: ['T', '#6b7280'], log: ['L', '#6b7280'], lock: ['LK', '#6b7280'], prisma: ['P', '#5a67d8'], go: ['GO', '#00add8'], rs: ['RS', '#dea584'], php: ['PH', '#777bb3'],
  };
  function fileIcon(name) {
    const ext = name.startsWith('.env') ? 'env' : (name.match(/\.([^.]+)$/)?.[1] || '').toLowerCase();
    const [t, c] = ICON[ext] || ['•', 'var(--faint)'];
    const i = el('span', 'fi', t);
    // monochrome: the extension text is enough to tell files apart
    return i;
  }
  const FOLDER = '<svg viewBox="0 0 20 20" width="15" height="15"><path d="M2.5 6A1.5 1.5 0 0 1 4 4.5h3.2l1.6 1.6H16A1.5 1.5 0 0 1 17.5 7.6v7A1.5 1.5 0 0 1 16 16H4a1.5 1.5 0 0 1-1.5-1.5z" fill="currentColor" opacity=".55"/></svg>';
  const CHEV = '<svg viewBox="0 0 20 20" width="12" height="12"><path d="M7.5 5l5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const X = '<svg viewBox="0 0 20 20" width="12" height="12"><path d="M6 6l8 8M14 6l-8 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';

  // ---------- Monaco ----------
  let monaco = null, editor = null, diffEditor = null, monacoReady = null;
  const dark = matchMedia('(prefers-color-scheme: dark)');
  const isDark = () => (document.documentElement.dataset.theme || (dark.matches ? 'dark' : 'light')) === 'dark';
  function ensureMonaco() {
    if (monacoReady) return monacoReady;
    monacoReady = new Promise((resolve) => {
      // workers need absolute URLs when Monaco lives under a subpath
      window.MonacoEnvironment = {
        getWorkerUrl() {
          const o = location.origin;
          return URL.createObjectURL(new Blob([`self.MonacoEnvironment = { baseUrl: '${o}/orbit/' }; importScripts('${o}/orbit/vs/base/worker/workerMain.js');`], { type: 'text/javascript' }));
        },
      };
      window.require.config({ paths: { vs: location.origin + '/orbit/vs' } });
      window.require(['vs/editor/editor.main'], () => {
        monaco = window.monaco;
        monaco.editor.defineTheme('pg-dark', { base: 'vs-dark', inherit: true, rules: [], colors: {
          'editor.background': '#121212', 'editor.lineHighlightBackground': '#1b1b1b', 'editorGutter.background': '#121212',
          'editorLineNumber.foreground': '#4b4b4b', 'editorLineNumber.activeForeground': '#a1a1a1', 'editor.selectionBackground': '#ffffff30',
          'editorWidget.background': '#1a1a1a', 'editorWidget.border': '#2e2e2e', 'input.background': '#121212', 'focusBorder': '#ffffff',
          'diffEditor.insertedTextBackground': '#16a34a2e', 'diffEditor.removedTextBackground': '#dc26262e',
          'diffEditor.insertedLineBackground': '#16a34a18', 'diffEditor.removedLineBackground': '#dc262618', 'scrollbarSlider.background': '#ffffff18',
        } });
        monaco.editor.defineTheme('pg-light', { base: 'vs', inherit: true, rules: [], colors: {
          'editor.background': '#ffffff', 'editor.lineHighlightBackground': '#f6f7f9', 'editorLineNumber.foreground': '#c4c7cc',
          'editorLineNumber.activeForeground': '#6e727b', 'editor.selectionBackground': '#00000020', 'focusBorder': '#111111',
          'diffEditor.insertedTextBackground': '#16a34a26', 'diffEditor.removedTextBackground': '#dc262622', 'scrollbarSlider.background': '#00000014',
        } });
        const opts = {
          theme: isDark() ? 'pg-dark' : 'pg-light', automaticLayout: true, fontFamily: '"Roboto Mono", ui-monospace, Menlo, monospace',
          fontSize: 13, lineHeight: 20, minimap: { enabled: window.innerWidth > 1100 }, scrollBeyondLastLine: false, smoothScrolling: true,
          renderWhitespace: 'selection', tabSize: 2, padding: { top: 10 }, stickyScroll: { enabled: true }, bracketPairColorization: { enabled: true },
        };
        editor = monaco.editor.create($('#edMonaco'), opts);
        diffEditor = monaco.editor.createDiffEditor($('#edDiff'), { ...opts, readOnly: true, originalEditable: false, renderSideBySide: window.innerWidth > 900, enableSplitViewResizing: true });
        dark.addEventListener('change', () => monaco.editor.setTheme(isDark() ? 'pg-dark' : 'pg-light'));
        window.addEventListener('orbit:theme', () => monaco.editor.setTheme(isDark() ? 'pg-dark' : 'pg-light'));
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => save());
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyF, () => openSearch(editor.getModel()?.getValueInRange(editor.getSelection())));
        editor.onDidChangeCursorPosition((e) => { $('#edStPos').textContent = `Ln ${e.position.lineNumber}, Col ${e.position.column}`; });
        editor.addAction({ id: 'cw-ask', label: 'Ask Claude about this selection', contextMenuGroupId: 'navigation', contextMenuOrder: 0, run: (ed) => {
          const t = active(); if (!t) return;
          const sel = ed.getSelection(); const text = ed.getModel().getValueInRange(sel);
          window.App.startChat(`In ${t.path}${text ? ` (lines ${sel.startLineNumber}-${sel.endLineNumber})` : ''}:\n\n${text ? '```\n' + text.slice(0, 6000) + '\n```\n\n' : ''}Explain this and point out anything wrong.`);
        } });
        resolve();
      });
    });
    return monacoReady;
  }

  // ---------- state ----------
  let root = store.get('root', null);
  let projects = [];
  let readOnly = store.get('ro', false);
  const tabs = []; // { id, kind: 'file'|'diff', path, model, saved, mtime, ro, note, view, change, models }
  let activeId = null;
  const tree = new Map(); // dir -> entries
  const expanded = new Set(store.get('expanded', []));
  let selectedDir = null;
  const active = () => tabs.find((t) => t.id === activeId);
  const isDirty = (t) => t.kind === 'file' && t.model && t.model.getAlternativeVersionId() !== t.saved;

  // ---------- project picker ----------
  async function loadProjects() {
    try { projects = await api('fs/projects'); } catch { projects = []; }
    if (!root || !projects.some((p) => p.path === root)) root = root || projects[0]?.path || '/root';
    renderProjectPicker();
  }

  function renderProjectPicker() {
    const box = $('#edProject');
    box.replaceChildren();
    const wrap = el('div', 'dd');
    const btn = el('button', 'dd-btn'); btn.type = 'button';
    const cur = projects.find((p) => p.path === root);
    btn.innerHTML = `<span class="dd-ico daily">${FOLDER}</span><span class="dd-label"></span><svg class="dd-chev" viewBox="0 0 20 20" width="14" height="14"><path d="M6 8l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    btn.querySelector('.dd-label').textContent = cur ? cur.label : root;
    btn.title = root;
    const menu = el('div', 'dd-menu');
    let group = null;
    for (const p of projects) {
      if (p.group !== group) { group = p.group; menu.append(el('div', 'dd-group', group)); }
      const it = el('button', 'dd-item compact' + (p.path === root ? ' sel' : '')); it.type = 'button';
      it.innerHTML = `<span class="pop-txt"><b></b><small></small></span><svg class="dd-check" viewBox="0 0 20 20" width="16" height="16"><path d="M5 10.5l3.2 3L15 6.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
      it.querySelector('b').textContent = p.label; it.querySelector('small').textContent = p.path;
      it.onclick = () => { wrap.classList.remove('open'); setRoot(p.path); };
      menu.append(it);
    }
    btn.onclick = (e) => { e.stopPropagation(); wrap.classList.toggle('open'); };
    document.addEventListener('click', (e) => { if (!wrap.contains(e.target)) wrap.classList.remove('open'); });
    wrap.append(btn, menu);
    box.append(wrap);
  }

  function setRoot(p) {
    root = p; store.set('root', p);
    selectedDir = null;
    renderProjectPicker();
    loadTree();
    if (lastSearch) runSearch();
  }

  // ---------- tree ----------
  async function fetchDir(dir) {
    const r = await api('fs/list?' + q({ path: dir }));
    tree.set(dir, r.entries);
    return r.entries;
  }

  async function loadTree() {
    $('#edRootLabel').textContent = base(root) || root;
    $('#edRootLabel').title = root;
    const box = $('#edTree');
    box.replaceChildren(el('div', 'loading', 'Loading…'));
    try { await fetchDir(root); } catch (e) { box.replaceChildren(el('div', 'loading', e.message)); return; }
    // re-fetch expanded folders under this root so the tree comes back as you left it
    await Promise.all([...expanded].filter((d) => d.startsWith(root + '/')).map((d) => fetchDir(d).catch(() => expanded.delete(d))));
    renderTree();
  }

  function renderTree() {
    const box = $('#edTree');
    const scroll = box.scrollTop;
    box.replaceChildren();
    const walk = (dir, depth) => {
      for (const e of tree.get(dir) || []) {
        const full = join(dir, e.name);
        const row = el('div', 'tn' + (e.heavy ? ' heavy' : '') + (e.dir && expanded.has(full) ? ' open' : ''));
        row.dataset.path = full; row.dataset.dir = e.dir ? '1' : '';
        row.style.paddingLeft = 6 + depth * 14 + 'px';
        row.setAttribute('role', 'treeitem');
        const tw = el('span', 'tw'); if (e.dir) tw.innerHTML = CHEV;
        const ic = e.dir ? (() => { const s = el('span', 'fi'); s.innerHTML = FOLDER; s.style.color = 'var(--muted)'; return s; })() : fileIcon(e.name);
        const nm = el('span', 'nm', e.name + (e.link ? ' ↗' : ''));
        row.append(tw, ic, nm);
        const t = tabs.find((x) => x.kind === 'file' && x.path === full);
        if (t && isDirty(t)) row.append(el('span', 'dirty-dot'));
        const more = el('button', 'more'); more.innerHTML = '<svg viewBox="0 0 20 20" width="14" height="14"><circle cx="5" cy="10" r="1.4" fill="currentColor"/><circle cx="10" cy="10" r="1.4" fill="currentColor"/><circle cx="15" cy="10" r="1.4" fill="currentColor"/></svg>';
        more.title = 'More'; more.onclick = (ev) => { ev.stopPropagation(); showMenu(ev, full, e.dir, row); };
        row.append(more);
        if (active()?.path === full) row.classList.add('active');
        row.onclick = () => (e.dir ? toggleDir(full) : openFile(full));
        row.oncontextmenu = (ev) => { ev.preventDefault(); showMenu(ev, full, e.dir, row); };
        box.append(row);
        if (e.dir && expanded.has(full)) {
          if (tree.has(full)) walk(full, depth + 1);
          else { const l = el('div', 'loading', 'Loading…'); l.style.paddingLeft = 26 + depth * 14 + 'px'; box.append(l); }
        }
      }
    };
    walk(root, 0);
    if (!(tree.get(root) || []).length) box.append(el('div', 'loading', 'This folder is empty'));
    box.scrollTop = scroll;
  }

  async function toggleDir(dir) {
    selectedDir = dir;
    if (expanded.has(dir)) expanded.delete(dir);
    else {
      expanded.add(dir);
      if (!tree.has(dir)) { renderTree(); try { await fetchDir(dir); } catch (e) { toast(e.message); expanded.delete(dir); } }
    }
    store.set('expanded', [...expanded].slice(-200));
    renderTree();
  }

  async function refreshDir(dir) {
    try { await fetchDir(dir); } catch {}
    renderTree();
  }

  // inline name input inside the tree (new file / folder / rename)
  function inlineInput({ dir, value = '', anchor, onDone }) {
    const row = el('div', 'tn');
    const depth = dir === root ? 0 : dir.slice(root.length).split('/').filter(Boolean).length;
    row.style.paddingLeft = 6 + depth * 14 + 20 + 'px';
    const input = el('input', 'tn-rename'); input.value = value; input.spellcheck = false;
    row.append(input);
    if (anchor) anchor.replaceWith(row);
    else {
      const box = $('#edTree');
      const after = [...box.children].find((c) => c.dataset.path === dir);
      if (after) after.after(row); else box.prepend(row);
    }
    input.focus();
    const dot = value.lastIndexOf('.');
    input.setSelectionRange(0, dot > 0 ? dot : value.length);
    let done = false;
    const finish = (ok) => { if (done) return; done = true; const v = input.value.trim(); if (ok && v && v !== value && !v.includes('/')) onDone(v); else renderTree(); };
    input.onkeydown = (e) => { if (e.key === 'Enter') finish(true); if (e.key === 'Escape') finish(false); };
    input.onblur = () => finish(true);
  }

  async function newItem(kind, dir = selectedDir || root) {
    if (!expanded.has(dir) && dir !== root) { expanded.add(dir); if (!tree.has(dir)) await fetchDir(dir).catch(() => {}); renderTree(); }
    inlineInput({ dir, onDone: async (name) => {
      const p = join(dir, name);
      try { await api('fs/op', { op: kind === 'folder' ? 'mkdir' : 'create', path: p }); await refreshDir(dir); if (kind !== 'folder') openFile(p); }
      catch (e) { toast(e.message); renderTree(); }
    } });
  }

  function renameItem(p, row) {
    inlineInput({ dir: dirOf(p), value: base(p), anchor: row, onDone: async (name) => {
      const dest = join(dirOf(p), name);
      try {
        await api('fs/op', { op: 'rename', path: p, to: dest });
        for (const t of tabs) if (t.kind === 'file' && (t.path === p || t.path.startsWith(p + '/'))) retarget(t, dest + t.path.slice(p.length));
        if (expanded.has(p)) { expanded.delete(p); expanded.add(dest); }
        tree.delete(p);
        await refreshDir(dirOf(p));
        renderTabs(); persistTabs();
      } catch (e) { toast(e.message); renderTree(); }
    } });
  }

  function retarget(t, dest) {
    // Monaco models are keyed by URI, so a renamed file needs a fresh model
    const value = t.model.getValue(), dirty = isDirty(t);
    t.model.dispose();
    t.path = dest; t.id = 'f:' + dest;
    t.model = monaco.editor.createModel(value, langFor(dest), monaco.Uri.file(dest));
    t.saved = dirty ? -1 : t.model.getAlternativeVersionId();
    t.model.onDidChangeContent(() => onEdit(t));
    if (activeId && !tabs.some((x) => x.id === activeId)) activeId = t.id;
    if (active() === t) editor.setModel(t.model);
  }

  async function deleteItem(p, isDir) {
    const open = tabs.filter((t) => t.kind === 'file' && (t.path === p || t.path.startsWith(p + '/')));
    if (!confirm(`Delete ${isDir ? 'the folder' : ''} ${base(p)}?${open.some(isDirty) ? '\nIt has unsaved changes.' : ''}\n\nIt goes to the trash, so it can be recovered.`)) return;
    try {
      await api('fs/op', { op: 'delete', path: p });
      for (const t of open) closeTab(t.id, true);
      tree.delete(p); expanded.delete(p);
      await refreshDir(dirOf(p));
      toast(`Moved ${base(p)} to trash`);
    } catch (e) { toast(e.message); }
  }

  // context menu
  const menuEl = $('#edMenu');
  function showMenu(ev, p, isDir, row) {
    menuEl.replaceChildren();
    const item = (label, fn, cls = '') => { const b = el('button', 'pop-item ' + cls, label); b.type = 'button'; b.onclick = () => { hideMenu(); fn(); }; menuEl.append(b); };
    const dir = isDir ? p : dirOf(p);
    if (!isDir) item('Open', () => openFile(p));
    item('New file here', () => newItem('file', dir));
    item('New folder here', () => newItem('folder', dir));
    menuEl.append(el('hr'));
    item('Rename', () => renameItem(p, row));
    item('Copy path', () => { navigator.clipboard?.writeText(p); toast('Path copied'); });
    item(isDir ? 'Search in this folder' : 'Ask Claude about this file', () => (isDir ? (setRoot(p), openSearch()) : window.App.startChat(`Have a look at ${p} and explain what it does. Point out anything that looks wrong.`)));
    menuEl.append(el('hr'));
    item('Delete', () => deleteItem(p, isDir), 'danger');
    menuEl.hidden = false;
    row?.classList.add('menu-open');
    const r = menuEl.getBoundingClientRect();
    menuEl.style.left = Math.min(ev.clientX, innerWidth - r.width - 8) + 'px';
    menuEl.style.top = Math.min(ev.clientY, innerHeight - r.height - 8) + 'px';
  }
  function hideMenu() { menuEl.hidden = true; document.querySelectorAll('.tn.menu-open').forEach((x) => x.classList.remove('menu-open')); }
  document.addEventListener('click', (e) => { if (!menuEl.hidden && !menuEl.contains(e.target)) hideMenu(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideMenu(); });

  // ---------- tabs ----------
  function langFor(p) {
    const n = base(p);
    if (n.startsWith('.env')) return 'ini';
    if (/^(Dockerfile|Containerfile)/.test(n)) return 'dockerfile';
    if (p.startsWith('/etc/nginx/') || n.endsWith('.conf')) return 'shell';
    if (/\.(c?js|mjs)$/.test(n)) return 'javascript';
    return undefined; // Monaco picks from the extension
  }

  async function openFile(p, line) {
    await ensureMonaco();
    let t = tabs.find((x) => x.kind === 'file' && x.path === p);
    if (!t) {
      let r;
      try { r = await api('fs/read?' + q({ path: p })); } catch (e) { toast(e.message); return; }
      const uri = monaco.Uri.file(p);
      monaco.editor.getModel(uri)?.dispose();
      const note = r.binary ? 'Binary file — not shown' : r.tooLarge ? `Too large to edit here (${Math.round(r.size / 1048576)} MB)` : !r.writable ? 'No write permission — read-only' : '';
      const model = monaco.editor.createModel(r.binary || r.tooLarge ? `// ${note}` : r.content, langFor(p), uri);
      t = { id: 'f:' + p, kind: 'file', path: p, model, saved: model.getAlternativeVersionId(), mtime: r.mtime, ro: !!note, note };
      model.onDidChangeContent(() => onEdit(t));
      tabs.push(t);
      persistTabs();
    }
    activate(t.id);
    if (line) { editor.revealLineInCenter(line); editor.setPosition({ lineNumber: line, column: 1 }); editor.focus(); }
    if (innerWidth <= 900) $('.ed').classList.remove('side-open');
  }

  function onEdit(t) {
    renderTabs(); updateStatus(); updateDirtyBadge();
    const row = document.querySelector(`.tn[data-path="${CSS.escape(t.path)}"]`);
    if (row && !!row.querySelector('.dirty-dot') !== isDirty(t)) renderTree();
  }

  function activate(id) {
    const prev = active();
    if (prev?.kind === 'file' && editor) prev.view = editor.saveViewState();
    activeId = id;
    const t = active();
    $('#edEmpty').hidden = !!t;
    $('#edMonaco').hidden = !t || t.kind !== 'file';
    $('#edDiff').hidden = !t || t.kind !== 'diff';
    if (t?.kind === 'file') {
      editor.setModel(t.model);
      if (t.view) editor.restoreViewState(t.view);
      editor.updateOptions({ readOnly: readOnly || t.ro });
      editor.focus();
    } else if (t?.kind === 'diff') {
      diffEditor.setModel({ original: t.models.original, modified: t.models.modified });
      diffEditor.updateOptions({ renderSideBySide: $('.ed-stage').clientWidth > 860 });
    }
    renderTabs(); renderTree(); updateStatus(); renderBanner();
    document.querySelectorAll('.ch').forEach((c) => c.classList.toggle('active', t?.kind === 'diff' && c.dataset.id === t.change?.id));
    store.set('active', t?.kind === 'file' ? t.path : null);
  }

  function renderTabs() {
    const box = $('#edTabs');
    box.replaceChildren();
    for (const t of tabs) {
      const b = el('div', 'tab' + (t.id === activeId ? ' on' : '') + (isDirty(t) ? ' dirty' : '') + (t.kind === 'file' && (t.ro || readOnly) ? ' ro' : ''));
      b.setAttribute('role', 'tab');
      b.title = t.kind === 'diff' ? `Diff: ${t.path}` : t.path;
      if (t.kind === 'diff') b.append(el('span', 'diff-ico', '±')); else b.append(fileIcon(base(t.path)));
      b.append(el('span', 'nm', base(t.path) + (t.kind === 'diff' ? (t.label ? ` · ${t.label}` : ' · diff') : '')));
      const x = el('button', 'x'); x.innerHTML = X; x.title = 'Close';
      x.onclick = (e) => { e.stopPropagation(); closeTab(t.id); };
      b.append(x);
      b.onclick = () => activate(t.id);
      b.onauxclick = (e) => { if (e.button === 1) closeTab(t.id); };
      box.append(b);
    }
    box.querySelector('.tab.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const t = active();
    $('#edSave').disabled = !(t && isDirty(t));
    $('#edReload').disabled = !(t && t.kind === 'file');
  }

  function closeTab(id, force) {
    const i = tabs.findIndex((t) => t.id === id);
    if (i < 0) return;
    const t = tabs[i];
    if (!force && isDirty(t) && !confirm(`${base(t.path)} has unsaved changes. Close it and lose them?`)) return;
    tabs.splice(i, 1);
    if (t.kind === 'file') t.model.dispose(); else { t.models.original.dispose(); t.models.modified.dispose(); }
    if (activeId === id) activate(tabs[Math.min(i, tabs.length - 1)]?.id ?? null);
    else renderTabs();
    persistTabs(); updateDirtyBadge(); renderTree();
  }

  function persistTabs() { store.set('tabs', tabs.filter((t) => t.kind === 'file').map((t) => t.path)); }

  function updateDirtyBadge() {
    const n = tabs.filter(isDirty).length;
    const b = $('#navDirty'); b.hidden = !n; b.textContent = n;
    b.title = n ? `${n} unsaved file${n === 1 ? '' : 's'}` : '';
  }

  function updateStatus() {
    const t = active();
    $('#edStPath').textContent = t ? t.path : root || '';
    const st = $('#edStState');
    if (!t) { st.textContent = ''; $('#edStLang').textContent = ''; $('#edStPos').textContent = ''; return; }
    if (t.kind === 'diff') { st.className = 'st-ro'; st.textContent = 'Diff · read-only'; $('#edStLang').textContent = t.models.modified.getLanguageId(); return; }
    st.className = isDirty(t) ? 'st-dirty' : (readOnly || t.ro) ? 'st-ro' : 'st-saved';
    st.textContent = isDirty(t) ? 'Unsaved changes' : t.ro ? t.note : readOnly ? 'Read-only mode' : 'Saved';
    $('#edStLang').textContent = t.model.getLanguageId();
  }

  // ---------- banner (conflicts, external changes, diff controls) ----------
  function renderBanner() {
    const b = $('#edBanner');
    const t = active();
    b.replaceChildren(); b.className = 'ed-banner';
    const btn = (label, fn, primary) => { const x = el('button', 'btn sm' + (primary ? ' primary' : ''), label); x.type = 'button'; x.onclick = fn; return x; };
    if (t?.kind === 'file' && t.conflict) {
      const c = t.conflict;
      b.append(el('span', null, c.deleted ? `${base(t.path)} was deleted on disk.` : `${base(t.path)} changed on disk${c.byClaude ? ' (Claude edited it)' : ''} while you have unsaved edits.`), el('span', 'sp'));
      if (!c.deleted) b.append(btn('Compare', () => compareWithDisk(t)), btn('Reload, discard mine', () => reloadTab(t, true)));
      b.append(btn(c.deleted ? 'Save to recreate it' : 'Keep mine', () => { t.mtime = c.mtime || 0; t.conflict = null; t.force = true; renderBanner(); }, true));
      b.hidden = false; return;
    }
    if (t?.kind === 'diff' && t.change) {
      const c = t.change;
      b.classList.add('info');
      const who = el('span', 'who' + (c.by === 'claude' ? ' claude' : ''), c.by === 'claude' ? 'Claude' : 'You');
      const info = el('span'); info.append(who, ` ${c.tool} · ${ago(c.at)} · `, el('span', 'plus', '+' + c.added), ' ', el('span', 'minus', '−' + c.removed));
      b.append(info, el('span', 'sp'));
      const vsNow = btn(t.vsCurrent ? 'Show the edit itself' : 'Compare with current file', () => toggleDiffBase(t));
      b.append(vsNow, btn('Open file', () => openFile(c.file)), btn('Revert this edit', () => revert(c), false));
      b.hidden = false; return;
    }
    if (t?.kind === 'diff' && t.compare) {
      b.classList.add('info');
      b.append(el('span', null, 'Left: on disk now · Right: your unsaved version'), el('span', 'sp'), btn('Back to file', () => activate('f:' + t.path), true));
      b.hidden = false; return;
    }
    b.hidden = true;
  }

  // ---------- save / reload / external changes ----------
  async function save() {
    const t = active();
    if (!t || t.kind !== 'file') return;
    if (readOnly) return toast('Read-only mode is on — click the lock to edit');
    if (t.ro) return toast(t.note);
    if (!isDirty(t)) return;
    const version = t.model.getAlternativeVersionId();
    try {
      const r = await api('fs/write', { path: t.path, content: t.model.getValue(), baseMtime: t.mtime, force: !!t.force });
      t.mtime = r.mtime; t.saved = version; t.force = false; t.conflict = null;
      renderTabs(); updateStatus(); updateDirtyBadge(); renderBanner(); renderTree();
      toast(`Saved ${base(t.path)}`);
    } catch (e) {
      if (e.status === 409) { t.conflict = { mtime: e.data.mtime }; renderBanner(); }
      else toast(e.message);
    }
  }

  async function reloadTab(t, discard) {
    if (!discard && isDirty(t) && !confirm(`Discard your unsaved changes to ${base(t.path)} and reload it from disk?`)) return;
    let r;
    try { r = await api('fs/read?' + q({ path: t.path })); } catch (e) { toast(e.message); return; }
    const view = active() === t ? editor.saveViewState() : t.view;
    // pushEditOperations keeps undo history, unlike setValue
    t.model.pushEditOperations([], [{ range: t.model.getFullModelRange(), text: r.content }], () => null);
    t.saved = t.model.getAlternativeVersionId();
    t.mtime = r.mtime; t.conflict = null; t.force = false;
    if (active() === t && view) editor.restoreViewState(view);
    renderTabs(); updateStatus(); updateDirtyBadge(); renderBanner(); renderTree();
  }

  let checking = false;
  async function checkExternal(byClaude) {
    const files = tabs.filter((t) => t.kind === 'file' && !t.note);
    if (checking || !files.length) return;
    checking = true;
    try {
      const st = await api('fs/stat', { paths: files.map((t) => t.path) });
      for (const t of files) {
        const m = st[t.path];
        if (m === undefined) continue;
        if (m === null) { if (!t.conflict) { t.conflict = { deleted: true }; if (active() === t) renderBanner(); toast(`${base(t.path)} was deleted on disk`); } continue; }
        if (Math.abs(m - t.mtime) <= 1 || (t.conflict && t.conflict.mtime === m)) continue;
        if (isDirty(t)) { t.conflict = { mtime: m, byClaude }; if (active() === t) renderBanner(); }
        else { await reloadTab(t, true); toast(`${base(t.path)} reloaded — ${byClaude ? 'Claude changed it' : 'changed on disk'}`); }
      }
    } catch {}
    checking = false;
  }
  setInterval(() => { if (!document.hidden) checkExternal(false); }, 3000);

  // ---------- diffs ----------
  async function openChange(id) {
    if (!location.hash.startsWith('#/editor')) location.hash = '#/editor';
    await ensureMonaco();
    const existing = tabs.find((t) => t.kind === 'diff' && t.change?.id === id);
    if (existing) return activate(existing.id);
    let c;
    try { c = await api('changes/get?' + q({ id })); } catch (e) { toast(e.message); return; }
    const lang = langFor(c.file);
    const original = monaco.editor.createModel(c.before ?? '', lang, monaco.Uri.parse(`cw-before:/${id}${c.file}`));
    const modified = monaco.editor.createModel(c.after ?? '', lang, monaco.Uri.parse(`cw-after:/${id}${c.file}`));
    const t = { id: 'd:' + id, kind: 'diff', path: c.file, change: c, models: { original, modified }, label: c.created ? 'new file' : 'diff' };
    tabs.push(t);
    activate(t.id);
  }

  async function toggleDiffBase(t) {
    if (!t.vsCurrent) {
      let r; try { r = await api('fs/read?' + q({ path: t.path })); } catch (e) { toast(e.message); return; }
      t.models.modified.setValue(r.content);
      t.vsCurrent = true; t.label = 'vs now';
    } else { t.models.modified.setValue(t.change.after ?? ''); t.vsCurrent = false; t.label = 'diff'; }
    renderTabs(); renderBanner();
  }

  async function compareWithDisk(t) {
    let r; try { r = await api('fs/read?' + q({ path: t.path })); } catch (e) { toast(e.message); return; }
    const id = 'c:' + t.path;
    const old = tabs.find((x) => x.id === id);
    if (old) closeTab(id, true);
    const lang = t.model.getLanguageId();
    const original = monaco.editor.createModel(r.content, lang, monaco.Uri.parse('cw-disk:' + t.path + '#' + Date.now()));
    const modified = monaco.editor.createModel(t.model.getValue(), lang, monaco.Uri.parse('cw-mine:' + t.path + '#' + Date.now()));
    tabs.push({ id, kind: 'diff', path: t.path, compare: true, models: { original, modified }, label: 'disk vs mine' });
    activate(id);
  }

  async function revert(c) {
    if (!confirm(`Undo this ${c.tool} on ${base(c.file)}?${c.created ? ' The file was created by it, so it will be moved to trash.' : ''}`)) return;
    try { await api('changes/revert', { id: c.id }); }
    catch (e) {
      if (e.status !== 409 || !confirm(e.message + '\n\nRevert anyway? Later changes to this file will be lost.')) { if (e.status !== 409) toast(e.message); return; }
      try { await api('changes/revert', { id: c.id, force: true }); } catch (e2) { toast(e2.message); return; }
    }
    toast(`Reverted ${base(c.file)}`);
    checkExternal(false);
    refreshDir(dirOf(c.file));
  }

  // ---------- changes pane ----------
  let changes = [], unseen = 0;
  async function loadChanges() {
    try { changes = await api('changes'); } catch { changes = []; }
    renderChanges();
  }
  function renderChanges() {
    const box = $('#edChanges');
    box.replaceChildren();
    if (!changes.length) box.append(el('div', 'ed-info', 'No edits recorded yet. When Claude edits a file from the chat, it shows up here.'));
    for (const c of changes) {
      const row = el('div', 'ch'); row.dataset.id = c.id;
      const top = el('div', 'ch-top');
      top.append(fileIcon(base(c.file)), el('b', null, base(c.file)), el('span', 'plus', '+' + c.added), el('span', 'minus', '−' + c.removed));
      const meta = el('div', 'ch-meta');
      meta.append(el('span', 'who' + (c.by === 'claude' ? ' claude' : ''), c.by === 'claude' ? 'Claude' : 'You'), el('span', null, `${c.tool} · ${ago(c.at)}`), el('span', 'dir', dirOf(c.file).replace(/^\/var\/www\//, '')));
      row.append(top, meta);
      row.title = c.file;
      row.onclick = () => openChange(c.id);
      box.append(row);
    }
    const n = $('#edChangeCount'); n.hidden = !unseen; n.textContent = unseen;
  }

  // ---------- search pane ----------
  let lastSearch = null, searchTimer = null;
  const tog = (id) => $('#' + id).classList.contains('on');
  ['edCase', 'edRegex'].forEach((id) => ($('#' + id).onclick = () => { $('#' + id).classList.toggle('on'); runSearch(); }));
  $('#edQuery').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 350); });
  $('#edInclude').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 500); });
  $('#edSearchForm').onsubmit = (e) => { e.preventDefault(); runSearch(); };

  async function runSearch() {
    const query = $('#edQuery').value;
    const info = $('#edSearchInfo'), box = $('#edResults');
    if (!query) { box.replaceChildren(); info.textContent = ''; lastSearch = null; return; }
    const params = { root, query, regex: tog('edRegex'), caseSensitive: tog('edCase'), include: $('#edInclude').value };
    if (params.regex) { try { new RegExp(query); } catch { info.textContent = 'Invalid regular expression'; return; } }
    info.textContent = 'Searching…';
    const mine = (lastSearch = { ...params, results: null });
    let r;
    try { r = await api('fs/search', params); } catch (e) { info.textContent = e.message; return; }
    if (lastSearch !== mine) return;
    mine.results = r.results;
    const n = r.results.reduce((a, f) => a + f.matches.length, 0);
    info.textContent = n ? `${n} result${n === 1 ? '' : 's'} in ${r.results.length} file${r.results.length === 1 ? '' : 's'}${r.truncated ? ' (stopped early — narrow it down)' : ''}` : 'No results';
    const re = params.regex ? new RegExp(query, 'g' + (params.caseSensitive ? '' : 'i')) : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g' + (params.caseSensitive ? '' : 'i'));
    box.replaceChildren();
    for (const f of r.results) {
      const head = el('div', 'sr-file');
      const rel = f.file.startsWith(root + '/') ? f.file.slice(root.length + 1) : f.file;
      head.append(fileIcon(base(f.file)));
      const nm = el('span', 'nm'); nm.append(base(f.file) + ' ', el('span', 'dir', dirOf(rel) === rel ? '' : dirOf(rel)));
      head.append(nm, el('span', 'n', f.matches.length));
      head.title = f.file;
      const lines = el('div');
      head.onclick = () => { lines.hidden = !lines.hidden; };
      for (const m of f.matches) {
        const row = el('div', 'sr-line');
        const tx = el('span', 'tx');
        const text = m.text.trimStart();
        let last = 0; re.lastIndex = 0; let mm;
        while ((mm = re.exec(text)) && mm[0]) { tx.append(text.slice(last, mm.index), el('mark', null, mm[0])); last = mm.index + mm[0].length; }
        tx.append(text.slice(last));
        row.append(el('span', 'ln', m.line), tx);
        row.onclick = () => openFile(f.file, m.line);
        lines.append(row);
      }
      box.append(head, lines);
    }
  }

  $('#edReplaceAll').onclick = async () => {
    const s = lastSearch;
    if (!s?.results?.length) return toast('Search for something first');
    const files = s.results.map((f) => f.file);
    const dirty = tabs.filter((t) => isDirty(t) && files.includes(t.path));
    if (dirty.length) return toast(`Save or close ${base(dirty[0].path)} first — it has unsaved edits`);
    const total = s.results.reduce((a, f) => a + f.matches.length, 0);
    if (!confirm(`Replace ${total} match${total === 1 ? '' : 'es'} of “${s.query}” with “${$('#edReplace').value}” in ${files.length} file${files.length === 1 ? '' : 's'}?\n\nEach file's previous version is kept in Changes, so you can revert it.`)) return;
    try {
      const r = await api('fs/replace', { ...s, replacement: $('#edReplace').value, files });
      toast(`Replaced in ${r.changed.length} file${r.changed.length === 1 ? '' : 's'}`);
      await checkExternal(false);
      runSearch();
    } catch (e) { toast(e.message); }
  };

  function openSearch(prefill) {
    setPane('search');
    if (prefill && !prefill.includes('\n')) { $('#edQuery').value = prefill; runSearch(); }
    $('#edQuery').focus(); $('#edQuery').select();
    if (innerWidth <= 900) $('.ed').classList.add('side-open');
  }

  // ---------- panes, toolbar ----------
  function setPane(p) {
    document.querySelectorAll('.ed-modes button').forEach((b) => b.classList.toggle('on', b.dataset.pane === p));
    document.querySelectorAll('.ed-pane').forEach((x) => (x.hidden = x.dataset.pane !== p));
    if (p === 'changes') { unseen = 0; loadChanges(); }
  }
  document.querySelectorAll('.ed-modes button').forEach((b) => (b.onclick = () => setPane(b.dataset.pane)));
  $('#edNewFile').onclick = () => newItem('file');
  $('#edNewFolder').onclick = () => newItem('folder');
  $('#edRefresh').onclick = () => { tree.clear(); loadTree(); };
  $('#edCollapse').onclick = () => { expanded.clear(); store.set('expanded', []); renderTree(); };
  $('#edSave').onclick = () => save();
  $('#edReload').onclick = () => { const t = active(); if (t?.kind === 'file') reloadTab(t); };
  $('#edSideToggle').onclick = () => $('.ed').classList.toggle('side-open');

  function paintRO() {
    const b = $('#edRO');
    b.classList.toggle('on', readOnly);
    b.querySelector('span').textContent = readOnly ? 'Read-only' : 'Editing';
    b.title = readOnly ? 'Read-only mode is on: click to allow editing' : 'Click to turn on read-only mode';
    editor?.updateOptions({ readOnly: readOnly || !!active()?.ro });
    renderTabs(); updateStatus();
  }
  $('#edRO').onclick = () => { readOnly = !readOnly; store.set('ro', readOnly); paintRO(); };

  document.addEventListener('keydown', (e) => {
    if ($('#viewEditor').hidden) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); }
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'f') { e.preventDefault(); openSearch(); }
  });
  window.addEventListener('beforeunload', (e) => { if (tabs.some(isDirty)) { e.preventDefault(); e.returnValue = ''; } });

  // ---------- public ----------
  let started = false;
  window.Editor = {
    async shown() {
      if (!started) {
        started = true;
        await loadProjects();
        loadTree();
        paintRO();
        await ensureMonaco();
        // reopen the tabs you had last time
        const saved = store.get('tabs', []), act = store.get('active', null);
        for (const p of saved) await openFile(p).catch(() => {});
        if (act && tabs.some((t) => t.path === act)) activate('f:' + act);
        else if (!tabs.length) activate(null);
        loadChanges();
      }
      editor?.layout(); diffEditor?.layout();
    },
    openFile(p, line) { if (!location.hash.startsWith('#/editor')) location.hash = '#/editor'; return this.shown().then(() => openFile(p, line)); },
    openChange(id) { return this.shown().then(() => openChange(id)); },
    onChange(c) {
      if (!started) return;
      changes = [c, ...changes.filter((x) => x.id !== c.id)];
      if ($('.ed-pane[data-pane="changes"]').hidden) unseen++;
      renderChanges();
      if (tabs.some((t) => t.path === c.file)) checkExternal(c.by === 'claude');
      if (tree.has(dirOf(c.file))) refreshDir(dirOf(c.file));
    },
  };
})();
