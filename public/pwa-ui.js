// Orbit as a Home Screen app: service worker, Web Push subscribe/settings, install guide, presence, app badge.
// Backend: orbit-push (push.mjs, :3024) at /claude/api/push/.
(() => {
  const API = '/claude/api/push/';
  const $ = (s, el = document) => el.querySelector(s);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const toast = (t) => window.App?.toast(t);

  const ua = navigator.userAgent;
  const isIOS = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
  const pushCapable = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  if (standalone) document.documentElement.classList.add('standalone');

  // ---------- service worker ----------
  let reg = null;
  const ready = (async () => {
    if (!('serviceWorker' in navigator)) return null;
    try { reg = await navigator.serviceWorker.register('/claude/sw.js', { scope: '/claude/' }); await navigator.serviceWorker.ready; return reg; }
    catch (e) { console.warn('sw', e); return null; }
  })();
  navigator.serviceWorker?.addEventListener('message', (e) => {
    if (e.data?.type !== 'orbit:navigate') return;
    const u = new URL(e.data.url, location.origin);
    if (u.pathname === location.pathname) { if (u.hash !== location.hash) location.hash = u.hash; }
    else location.href = u.href;
  });

  // ---------- push state ----------
  let sub = null, server = null;
  async function refresh() {
    const r = await ready;
    sub = r ? await r.pushManager.getSubscription().catch(() => null) : null;
    try {
      const q = sub ? '?endpoint=' + encodeURIComponent(sub.endpoint) : '';
      server = await (await fetch(API + q, { cache: 'no-store' })).json();
    } catch { server = null; }
    // the browser has a subscription the server forgot (e.g. data reset): re-register it
    if (sub && server && !server.me) await sendSub(sub).catch(() => {});
    label();
  }
  function on() { return !!(sub && server?.me); }
  function label() {
    const l = $('#notifLabel');
    if (l) l.textContent = isIOS && !standalone ? 'Get the iPhone app' : on() ? 'Notifications on' : 'Notifications';
    render();
  }
  function deviceName() {
    const m = ua.match(/iPhone|iPad|Android|Macintosh|Windows|Linux/);
    const kind = m ? { Macintosh: 'Mac', Windows: 'Windows PC', Linux: 'Linux' }[m[0]] || m[0] : 'Device';
    const br = standalone ? 'app' : /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'browser';
    return `${kind} · ${br}`;
  }
  const b64 = (s) => { const p = '='.repeat((4 - (s.length % 4)) % 4); const raw = atob((s + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(raw, (c) => c.charCodeAt(0)); };
  async function post(path, body) {
    const r = await fetch(API + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'Something went wrong');
    return j;
  }
  const sendSub = (s) => post('subscribe', { subscription: s.toJSON(), device: deviceName() });

  async function enable() {
    const r = await ready;
    if (!r) throw new Error('This browser can\'t run Orbit\'s background worker.');
    const perm = await Notification.requestPermission(); // must run inside the tap
    if (perm !== 'granted') throw new Error(perm === 'denied' ? 'Notifications are blocked. Turn them on in Settings › Notifications › Orbit.' : 'Notifications were not allowed.');
    if (!server?.publicKey) await refresh();
    sub = await r.pushManager.getSubscription() || await r.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(server.publicKey) });
    await sendSub(sub);
    await refresh();
    await post('test', { endpoint: sub.endpoint }).catch(() => {});
  }
  async function disable() {
    if (sub) { await post('unsubscribe', { endpoint: sub.endpoint }).catch(() => {}); await sub.unsubscribe().catch(() => {}); }
    sub = null; await refresh();
  }

  // ---------- sheet ----------
  const sheet = el('div', 'sheet'); sheet.id = 'notifSheet'; sheet.hidden = true;
  const card = el('div', 'sheet-card nf-card'); card.setAttribute('role', 'dialog'); card.setAttribute('aria-modal', 'true');
  sheet.append(card);
  document.body.append(sheet);
  sheet.addEventListener('click', (e) => { if (e.target === sheet) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !sheet.hidden) close(); });
  function close() { sheet.hidden = true; }
  // Notifications live on the Settings page now; open() goes there. The sheet is only used for the iPhone install guide.
  async function open() { document.body.classList.remove('side-open'); if (location.hash !== '#/settings') location.hash = '#/settings'; else { await refresh(); render(); } }
  async function openGuide() { document.body.classList.remove('side-open'); sheet.hidden = false; card.replaceChildren(); renderInstall(); }

  function head(title) {
    const h = el('div', 'sheet-head');
    h.append(el('h2', '', title));
    const x = el('button', 'icon-btn show'); x.setAttribute('aria-label', 'Close');
    x.innerHTML = '<svg viewBox="0 0 20 20" width="18" height="18"><path d="M5 5l10 10M15 5L5 15" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
    x.onclick = close;
    h.append(x);
    return h;
  }

  function render() {
    const host = document.getElementById('setNotif');
    if (host && !document.getElementById('viewSettings')?.hidden) renderInto(host, document.getElementById('setNotifMore'));
  }
  function renderInto(host, moreHost) {
    host.replaceChildren(); moreHost?.replaceChildren();
    let body = el('div', 'nf-body nf-inline');
    host.append(body);
    if (isIOS && !standalone) {
      const g = el('div', 'nf-group');
      const r = el('button', 'nf-row nf-btnrow'); r.type = 'button';
      const tx = el('div', 'nf-row-txt'); tx.append(el('b', '', 'Get the iPhone app'), el('small', '', 'iPhone only sends web notifications to apps added to the Home Screen.'));
      r.append(tx, el('span', 'set-chev', '›'));
      r.onclick = openGuide;
      g.append(r); body.append(g);
      return;
    }

    if (!pushCapable) {
      body.append(el('p', 'nf-text', isIOS ? 'Notifications need iOS 16.4 or newer. Update iOS, then open Orbit from your Home Screen.' : 'This browser doesn\'t support web notifications.'));
      return;
    }
    const perm = Notification.permission;
    const grp = el('div', 'nf-group');
    const row = el('label', 'nf-row');
    const txt = el('div', 'nf-row-txt');
    txt.append(el('b', '', 'On this device'), el('small', '', on() ? `Orbit can notify ${server.me.device}.` : perm === 'denied' ? 'Blocked in system settings.' : 'Get pinged when Claude needs you.'));
    const sw = toggle(on(), async (v, t) => {
      t.disabled = true;
      try { v ? await enable() : await disable(); toast(v ? 'Notifications are on. A test is on its way.' : 'Notifications are off on this device'); }
      catch (e) { toast(e.message); }
      render();
    });
    if (perm === 'denied' && !on()) sw.disabled = true;
    row.append(txt, sw);
    grp.append(row);
    body.append(grp);
    if (perm === 'denied' && !on()) body.append(el('p', 'nf-note', isIOS ? 'To allow them: iPhone Settings › Notifications › Orbit › Allow Notifications. Then come back here.' : 'To allow them, click the lock icon in the address bar and allow notifications for this site.'));

    if (on()) {
      body.append(el('div', 'nf-label', 'Notify me when'));
      const g2 = el('div', 'nf-group');
      const prefs = server.me.prefs;
      for (const [k, t, d] of [
        ['approval', 'Claude needs my OK', 'Approvals, questions and plans waiting for you'],
        ['finished', 'Claude finishes a reply', 'Including when a chat stops with an error'],
        ['alerts', 'Server alerts', 'A site goes down or comes back, a process crashes, disk over 90%'],
      ]) {
        const r = el('label', 'nf-row');
        const tx = el('div', 'nf-row-txt'); tx.append(el('b', '', t), el('small', '', d));
        r.append(tx, toggle(prefs[k] !== false, async (v, tg) => {
          tg.disabled = true;
          try { const j = await post('prefs', { endpoint: sub.endpoint, prefs: { [k]: v } }); server.me = j.me; } catch (e) { toast(e.message); }
          tg.disabled = false;
        }));
        g2.append(r);
      }
      body.append(g2);
      body.append(el('p', 'nf-note', 'You won\'t be pinged about a chat while it\'s open on screen on any of your devices.'));
      const tb = el('button', 'btn nf-wide', 'Send a test notification'); tb.type = 'button';
      tb.onclick = async () => { tb.disabled = true; try { await post('test', { endpoint: sub.endpoint }); toast('Sent. It should arrive in a few seconds.'); } catch (e) { toast(e.message); } tb.disabled = false; };
      body.append(tb);
    }

    // devices and history go further down the Settings page, so theme and updates stay near the top
    if (moreHost) { body = el('div', 'nf-body nf-inline'); moreHost.append(body); }
    const others = (server?.devices || []).filter((d) => d.id !== server?.me?.id);
    if (others.length) {
      body.append(el('div', 'set-label', 'Other devices'));
      const g3 = el('div', 'nf-group');
      for (const d of others) {
        const r = el('div', 'nf-row');
        const tx = el('div', 'nf-row-txt'); tx.append(el('b', '', d.device), el('small', '', d.lastOk ? 'Last notified ' + new Date(d.lastOk).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Added ' + new Date(d.createdAt).toLocaleDateString([], { month: 'short', day: 'numeric' })));
        const rm = el('button', 'linkish nf-rm', 'Remove'); rm.type = 'button';
        rm.onclick = async () => { await post('unsubscribe', { id: d.id }).catch((e) => toast(e.message)); await refresh(); render(); };
        r.append(tx, rm);
        g3.append(r);
      }
      body.append(g3);
    }
    if (server?.recent?.length) {
      body.append(el('div', 'set-label', 'Recent notifications'));
      const g4 = el('div', 'nf-group');
      for (const n of server.recent.slice(0, 4)) {
        const r = el('div', 'nf-row');
        const tx = el('div', 'nf-row-txt'); tx.append(el('b', '', n.title), el('small', '', `${n.body || ''}`));
        r.append(tx, el('span', 'nf-when', new Date(n.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })));
        g4.append(r);
      }
      body.append(g4);
    }
  }

  function renderInstall() {
    card.append(head('Get the Orbit app'));
    const body = el('div', 'nf-body');
    const hero = el('div', 'nf-hero');
    const icon = el('img'); icon.src = '/claude/pwa/icon-180.png'; icon.alt = ''; icon.width = 64; icon.height = 64;
    const ht = el('div'); ht.append(el('b', '', 'Orbit for iPhone'), el('small', '', 'Full screen, its own icon, and notifications when Claude needs you.'));
    hero.append(icon, ht);
    body.append(hero);
    const steps = el('ol', 'nf-steps');
    const share = '<svg viewBox="0 0 20 20" width="17" height="17" aria-hidden="true"><path d="M10 12.5V3M6.5 6.5L10 3l3.5 3.5M6 9H5a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-6a1 1 0 0 0-1-1h-1" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    const plus = '<svg viewBox="0 0 20 20" width="17" height="17" aria-hidden="true"><rect x="3.5" y="3.5" width="13" height="13" rx="3" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M10 7v6M7 10h6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
    for (const html of [
      `Tap the <b>Share</b> button ${share} in Safari's toolbar.`,
      `Scroll down and tap <b>Add to Home Screen</b> ${plus}.`,
      'Tap <b>Add</b>. Orbit appears on your Home Screen.',
      'Open <b>Orbit</b> from the Home Screen, log in once, then open <b>Settings</b> from the menu and turn on <b>Notifications</b>.',
    ]) { const li = el('li'); li.innerHTML = html; steps.append(li); }
    body.append(steps);
    body.append(el('p', 'nf-note', 'iPhone only allows web notifications for apps added to the Home Screen (iOS 16.4 or newer). The app has its own login, separate from Safari.'));
    card.append(body);
  }

  function toggle(value, onChange) {
    const t = el('input', 'nf-switch'); t.type = 'checkbox'; t.checked = value; t.setAttribute('role', 'switch');
    t.onchange = () => onChange(t.checked, t);
    return t;
  }

  $('#notifBtn')?.addEventListener('click', (e) => { e.preventDefault(); open(); });

  // ---------- presence: don't ping about a chat you're looking at ----------
  const currentSession = () => (location.hash.match(/^#\/s\/([0-9a-f-]{36})$/) || [])[1] || null;
  let lastSent = null;
  function ping(force) {
    const id = currentSession();
    const visible = document.visibilityState === 'visible';
    if (!id) { lastSent = null; return; }
    const key = id + visible;
    if (!force && key === lastSent && visible === false) return;
    lastSent = key;
    const body = JSON.stringify({ sessionId: id, visible });
    if (!visible && navigator.sendBeacon) navigator.sendBeacon(API + 'presence', new Blob([body], { type: 'application/json' }));
    else fetch(API + 'presence', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => {});
  }
  setInterval(() => { if (document.visibilityState === 'visible') ping(true); }, 15000);
  window.addEventListener('hashchange', () => ping(true));
  document.addEventListener('visibilitychange', () => {
    ping(true);
    if (document.visibilityState === 'visible') { navigator.clearAppBadge?.().catch(() => {}); reg?.getNotifications?.().then((ns) => ns.forEach((n) => n.data?.url?.endsWith(location.hash) && n.close())).catch(() => {}); }
  });
  navigator.clearAppBadge?.().catch(() => {});
  ping(true);

  refresh();
  window.OrbitApp = { open, openGuide, refresh, render, standalone, isIOS, isOn: on };
})();

// ---------- reload for the Home Screen app (2026-10-25) ----------
// A Home Screen app has no address bar or reload button, and iOS resumes it from memory, so edits to Orbit never show.
// Adds: pull-to-refresh, a Reload button in the drawer footer, and an "Orbit was updated" pill when the files changed.
// Every Orbit file is served no-store, so a plain reload is already a hard reload.
(() => {
  const standalone = window.OrbitApp?.standalone ?? (navigator.standalone === true || matchMedia('(display-mode: standalone)').matches);
  const $ = (s) => document.querySelector(s);
  const DRAFT = 'orbit_reload_draft';

  function reload() {
    try { const t = $('#input'); if (t?.value) sessionStorage.setItem(DRAFT, JSON.stringify({ v: t.value, h: location.hash, at: Date.now() })); } catch {}
    document.documentElement.classList.add('reloading');
    navigator.serviceWorker?.getRegistration('/claude/').then((r) => r?.update()).catch(() => {});
    setTimeout(() => location.reload(), 60);
  }
  window.OrbitReload = reload;

  // bring back what was typed before the reload
  try {
    const d = JSON.parse(sessionStorage.getItem(DRAFT) || 'null');
    sessionStorage.removeItem(DRAFT);
    if (d && Date.now() - d.at < 60000 && d.h === location.hash) {
      const t = $('#input');
      if (t && !t.value) { t.value = d.v; t.dispatchEvent(new Event('input', { bubbles: true })); }
    }
  } catch {}

  // ---- pull to refresh (app only) ----
  if (standalone) {
    const ind = document.createElement('div');
    ind.id = 'ptr'; ind.setAttribute('aria-hidden', 'true');
    ind.innerHTML = '<svg viewBox="0 0 20 20" width="18" height="18"><path d="M15.5 10a5.5 5.5 0 1 1-1.6-3.9M15.5 3.5v3.2h-3.2" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    document.body.append(ind);
    const TRIGGER = 80, MAX = 120;
    const SKIP = 'textarea, input, select, .sheet, .monaco-editor, .xterm, #usagePop, #attachMenu, #modes, #tasksPanel, .pop, [contenteditable]';
    let y0 = null, x0 = 0, dy = 0, active = false;
    const atTop = (t) => {
      for (let n = t; n && n !== document.documentElement; n = n.parentElement) {
        if (n.scrollTop > 0) return false;
        const oy = getComputedStyle(n).overflowY;
        if ((oy === 'auto' || oy === 'scroll') && n.scrollHeight > n.clientHeight + 1) return n.scrollTop <= 0;
      }
      return (document.scrollingElement?.scrollTop || 0) <= 0;
    };
    const set = (d, anim) => {
      const p = Math.min(d / TRIGGER, 1);
      ind.style.transition = anim ? 'transform .3s cubic-bezier(.32,.72,0,1), opacity .2s' : 'none';
      ind.style.opacity = d > 4 ? String(Math.min(1, p * 1.4)) : '0';
      ind.style.transform = `translate(-50%, ${Math.min(d, MAX) * .6}px) rotate(${p * 270}deg)`;
      ind.classList.toggle('armed', d >= TRIGGER);
    };
    document.addEventListener('touchstart', (e) => {
      y0 = null; active = false; dy = 0;
      if (e.touches.length !== 1 || document.body.classList.contains('side-open')) return;
      const t = e.target;
      if (!(t instanceof Element) || t.closest(SKIP) || !t.closest('#main')) return;
      if (!atTop(t)) return;
      y0 = e.touches[0].clientY; x0 = e.touches[0].clientX;
    }, { passive: true });
    document.addEventListener('touchmove', (e) => {
      if (y0 == null) return;
      const d = e.touches[0].clientY - y0, dx = Math.abs(e.touches[0].clientX - x0);
      if (!active) {
        if (d < 8) { if (d < -4 || dx > 10) y0 = null; return; }
        if (dx > d) { y0 = null; return; }
        active = true;
      }
      dy = Math.max(0, (d - 8) * .55);
      set(dy, false);
      if (e.cancelable) e.preventDefault();
    }, { passive: false });
    const end = () => {
      if (!active) { y0 = null; return; }
      const go = dy >= TRIGGER;
      y0 = null; active = false;
      if (go) { ind.classList.add('spin'); set(TRIGGER, true); reload(); }
      else set(0, true);
    };
    document.addEventListener('touchend', end, { passive: true });
    document.addEventListener('touchcancel', end, { passive: true });
  }

  // ---- "Orbit was updated" pill: compare a fingerprint of the app's files when it comes back to the foreground ----
  const FILES = ['/claude/', '/claude/chat.js', '/claude/chat.css', '/claude/pwa-ui.js', '/claude/monitor.js', '/claude/sites.js', '/claude/skills-ui.js', '/claude/editor.js', '/claude/usage-widget.js'];
  const hash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); };
  async function fingerprint() {
    const parts = await Promise.all(FILES.map((u) => fetch(u, { cache: 'no-store', credentials: 'same-origin' })
      .then((r) => (r.ok ? r.text() : '')).then((t) => hash(t) + t.length).catch(() => null)));
    return parts.includes(null) ? null : parts.join('.');
  }
  let base = null, lastCheck = 0, hiddenAt = 0, shown = false;
  const pill = document.createElement('button');
  pill.type = 'button'; pill.id = 'updPill'; pill.hidden = true;
  pill.innerHTML = '<span>Orbit was updated</span><b>Reload</b>';
  pill.addEventListener('click', reload);
  document.body.append(pill);
  let checkedAt = 0;
  async function check(force) {
    if (shown || (!force && Date.now() - lastCheck < 60000)) return shown ? 'updated' : base ? 'current' : null;
    lastCheck = Date.now();
    const f = await fingerprint();
    if (!f) return null;
    checkedAt = Date.now();
    if (!base) { base = f; return 'current'; }
    if (f !== base) {
      shown = true; pill.hidden = false; requestAnimationFrame(() => pill.classList.add('in'));
      const b = document.getElementById('navUpd'); if (b) b.hidden = false;
      window.dispatchEvent(new Event('orbit:update'));
      return 'updated';
    }
    return 'current';
  }
  window.OrbitUpdate = { check, reload, state: () => ({ updated: shown, checkedAt }) };
  setTimeout(() => { lastCheck = 0; check(); }, 4000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { hiddenAt = Date.now(); return; }
    if (hiddenAt && Date.now() - hiddenAt > 20000) { lastCheck = 0; check(); }
  });
  window.addEventListener('pageshow', (e) => { if (e.persisted) { lastCheck = 0; check(); } });
  setInterval(() => { if (document.visibilityState === 'visible') check(); }, 10 * 60000);
})();

// ---------- Settings page (#/settings, 2026-10-25): notifications, theme, updates, account ----------
window.Settings = (() => {
  const $ = (s) => document.querySelector(s);
  const app = window.OrbitApp || {};
  const seg = $('#setTheme');
  const syncTheme = () => {
    const cur = window.OrbitTheme?.get() || 'system';
    seg?.querySelectorAll('button').forEach((b) => { const on = b.dataset.t === cur; b.classList.toggle('on', on); b.setAttribute('aria-checked', on); });
  };
  seg?.addEventListener('click', (e) => { const b = e.target.closest('button[data-t]'); if (!b) return; window.OrbitTheme?.set(b.dataset.t); syncTheme(); });
  window.addEventListener('orbit:theme', syncTheme);

  const ago = (t) => { const s = Math.round((Date.now() - t) / 1000); return s < 60 ? 'just now' : s < 3600 ? Math.round(s / 60) + ' min ago' : new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); };
  function showUpd(res) {
    const st = window.OrbitUpdate?.state() || {};
    const t = $('#setUpdTitle'), sub = $('#setUpdSub'), rl = $('#setReload');
    if (res === 'updated' || st.updated) { t.textContent = 'A new version is ready'; sub.textContent = 'Reload to use it. What you typed in the message box is kept.'; rl.classList.add('set-primary'); }
    else if (res === 'current' || st.checkedAt) { t.textContent = 'Orbit is up to date'; sub.textContent = st.checkedAt ? 'Checked ' + ago(st.checkedAt) + '.' : ''; rl.classList.remove('set-primary'); }
    else if (res === 'checking') { t.textContent = 'Checking for updates…'; }
    else { t.textContent = 'Couldn\'t check for updates'; sub.textContent = 'Check your connection and try again.'; }
  }
  $('#setReload')?.addEventListener('click', () => window.OrbitUpdate?.reload());
  $('#setCheck')?.addEventListener('click', async (e) => {
    const b = e.currentTarget; b.disabled = true; showUpd('checking');
    showUpd(await window.OrbitUpdate?.check(true)); b.disabled = false;
  });
  window.addEventListener('orbit:update', () => showUpd('updated'));

  if (app.standalone) $('#setPtrNote').hidden = false;
  $('#setInstall')?.addEventListener('click', () => app.openGuide?.());

  async function shown() {
    syncTheme();
    showUpd(window.OrbitUpdate?.state().checkedAt ? 'current' : 'checking');
    app.render?.();
    app.refresh?.();
    if (!window.OrbitUpdate?.state().updated) showUpd(await window.OrbitUpdate?.check(false));
    document.getElementById('main')?.scrollTo?.(0, 0);
  }
  return { shown };
})();
if (location.hash === '#/settings') window.Settings.shown();
