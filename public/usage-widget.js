// Orbit: live Claude usage in the header (top right). Data: /claude/api/usage (usage.mjs via nginx).
(() => {
  const $ = (s) => document.querySelector(s);
  const btn = $('#usageBtn'), pop = $('#usagePop'), ring = $('#usageRing');
  if (!btn) return;
  const C = 2 * Math.PI * 7.5;
  ring.style.strokeDasharray = `0 ${C}`;
  let data = null, tab = localStorage.getItem('cw_usage_tab') || 'session', timer = null, loading = false;

  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const level = (p) => (p >= 90 ? 'crit' : p >= 75 ? 'high' : '');
  const fmtN = (n) => (n >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e4 ? Math.round(n / 1e3) + 'k' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n));
  const money = (minor, exp = 2, cur = 'USD') => new Intl.NumberFormat(undefined, { style: 'currency', currency: cur }).format(minor / 10 ** exp);
  function until(iso) {
    const ms = Date.parse(iso) - Date.now();
    if (!(ms > 0)) return 'now';
    const m = Math.round(ms / 6e4), d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60);
    return d ? `${d}d ${h}h` : h ? `${h}h ${m % 60}m` : `${m}m`;
  }
  const at = (iso) => {
    const d = new Date(iso), same = d.toDateString() === new Date().toDateString();
    return same ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : d.toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  };
  const ago = (t) => { const s = Math.round((Date.now() - t) / 1000); return s < 10 ? 'just now' : s < 60 ? `${s}s ago` : `${Math.round(s / 60)}m ago`; };
  const prettyModel = (m) => m.replace(/^claude-/, '').replace(/-(\d+)-(\d+)(-\d{8})?$/, ' $1.$2').replace(/^./, (c) => c.toUpperCase());

  function meter(label, pct, sub) {
    const p = Math.max(0, Math.min(100, Math.round(pct)));
    const lv = level(p);
    return `<div class="u-row">
      <div class="u-row-head"><span>${esc(label)}</span><b class="${lv}">${p}%${lv === 'crit' ? ' · near limit' : ''}</b></div>
      <div class="u-bar ${lv}" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${p}" aria-label="${esc(label)}"><i style="width:${p}%"></i></div>
      ${sub ? `<div class="u-row-sub">${sub}</div>` : ''}
    </div>`;
  }

  function renderBtn() {
    const fh = data?.limits?.five_hour;
    if (!fh) { $('#usagePct').textContent = '–'; $('#usageSub').textContent = data?.error ? 'offline' : 'usage'; return; }
    const p = Math.round(fh.utilization || 0);
    ring.style.strokeDasharray = `${(C * Math.min(p, 100)) / 100} ${C}`;
    btn.dataset.level = level(p);
    $('#usagePct').textContent = p + '%';
    $('#usageSub').textContent = fh.resets_at ? 'resets ' + until(fh.resets_at) : 'session';
    btn.title = `Claude usage: ${p}% of the 5-hour limit` + (data.limits.seven_day ? `, ${Math.round(data.limits.seven_day.utilization)}% of the weekly limit` : '');
  }

  function chart(h) {
    const vals = h.values, max = Math.max(...vals, 1);
    const W = 300, H = 44, n = vals.length, gap = 2, bw = (W - gap * (n - 1)) / n;
    const bars = vals.map((v, i) => {
      const bh = v ? Math.max(2, (v / max) * (H - 2)) : 0;
      const t = new Date(h.start + i * 36e5);
      const lab = `${t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · ${fmtN(v)} tokens`;
      return `<g class="u-col" data-tip="${esc(lab)}"><rect class="hit" x="${i * (bw + gap)}" y="0" width="${bw + gap}" height="${H}"/>`
        + (bh ? `<path class="bar" d="${roundTop(i * (bw + gap), H - bh, bw, bh, Math.min(2, bw / 2))}"/>` : `<rect class="zero" x="${i * (bw + gap)}" y="${H - 1}" width="${bw}" height="1"/>`) + '</g>';
    }).join('');
    const first = new Date(h.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return `<div class="u-chart"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" width="100%" height="${H}" role="img" aria-label="Tokens per hour, last 24 hours">${bars}</svg>
      <div class="u-axis"><span>${first}</span><span>peak ${fmtN(max)}/h</span><span>now</span></div><div class="u-tip" hidden></div></div>`;
  }
  function roundTop(x, y, w, h, r) {
    return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
  }

  function tokens(t) {
    if (!t) return '<p class="u-note">No session window right now.</p>';
    const models = Object.entries(t.models || {}).sort((a, b) => b[1].output - a[1].output);
    return `<div class="u-stats">
        <div><span>Output</span><b>${fmtN(t.output)}</b></div>
        <div><span>Input</span><b>${fmtN(t.input + t.cacheWrite)}</b></div>
        <div><span>Cache read</span><b>${fmtN(t.cacheRead)}</b></div>
        <div><span>Replies</span><b>${fmtN(t.messages)}</b></div>
      </div>
      ${models.length ? `<table class="u-models"><thead><tr><th>Model</th><th>Out</th><th>In</th><th>Replies</th></tr></thead><tbody>${models.map(([m, r]) => `<tr><td>${esc(prettyModel(m))}</td><td>${fmtN(r.output)}</td><td>${fmtN(r.input + r.cacheWrite)}</td><td>${r.messages}</td></tr>`).join('')}</tbody></table>` : ''}`;
  }

  function renderPop() {
    if (pop.hidden) return;
    if (!data) { pop.innerHTML = '<p class="u-note">Loading usage…</p>'; return; }
    const L = data.limits || {};
    const rows = [];
    if (L.five_hour) rows.push(meter('Current session (5 hours)', L.five_hour.utilization, L.five_hour.resets_at ? `Resets in ${until(L.five_hour.resets_at)} · ${at(L.five_hour.resets_at)}` : ''));
    if (L.seven_day) rows.push(meter('This week, all models', L.seven_day.utilization, L.seven_day.resets_at ? `Resets ${at(L.seven_day.resets_at)} · in ${until(L.seven_day.resets_at)}` : ''));
    for (const [k, name] of [['seven_day_opus', 'This week, Opus'], ['seven_day_sonnet', 'This week, Sonnet'], ['seven_day_oauth_apps', 'This week, apps']]) {
      if (L[k]) rows.push(meter(name, L[k].utilization, L[k].resets_at ? `Resets ${at(L[k].resets_at)}` : ''));
    }
    const sp = L.spend, ex = L.extra_usage;
    let extra = '';
    if (sp?.enabled && sp.limit) {
      extra = meter('Extra usage this month', (sp.used.amount_minor / sp.limit.amount_minor) * 100,
        `${money(sp.used.amount_minor, sp.used.exponent, sp.used.currency)} of ${money(sp.limit.amount_minor, sp.limit.exponent, sp.limit.currency)} · used only after plan limits run out`);
    } else if (ex?.is_enabled && ex.monthly_limit) {
      extra = meter('Extra usage this month', ex.utilization || 0, `${money(ex.used_credits, ex.decimal_places, ex.currency)} of ${money(ex.monthly_limit, ex.decimal_places, ex.currency)}`);
    }
    const bd = (L.seven_day_breakdown?.rows || []).filter((r) => r.percent > 0);
    const breakdown = bd.length ? `<section><h4>Where this week went</h4>${bd.map((r) => `<div class="u-split"><span>${esc(r.display_name)}</span><div class="u-bar thin"><i style="width:${r.percent}%"></i></div><b>${r.percent}%</b></div>`).join('')}</section>` : '';
    const loc = data.local || {};
    const T = { session: loc.session, today: loc.today, week: loc.week }[tab];
    const plan = data.plan ? data.plan[0].toUpperCase() + data.plan.slice(1) : '';

    pop.innerHTML = `
      <div class="u-head">
        <div><h3>Claude usage</h3><p>${plan ? `${esc(plan)} plan · ` : ''}<span class="u-live${data.error ? ' off' : ''}"></span>${data.error ? 'Couldn’t refresh, showing last data' : data.fetchedAt ? 'Updated ' + ago(data.fetchedAt) : 'Live'}</p></div>
        <button class="u-refresh${loading ? ' spin' : ''}" title="Refresh now" aria-label="Refresh"><svg viewBox="0 0 20 20" width="15" height="15"><path d="M16 10a6 6 0 1 1-1.8-4.3M16 4v3.5h-3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
      </div>
      ${rows.length ? `<section>${rows.join('')}</section>` : `<p class="u-note">${esc(data.error || 'Plan limits unavailable.')}</p>`}
      ${extra ? `<section>${extra}</section>` : ''}
      ${breakdown}
      <section>
        <div class="u-sec-head"><h4>Tokens used here</h4>
          <div class="u-tabs" role="tablist">${[['session', 'Session'], ['today', 'Today'], ['week', '7 days']].map(([k, n]) => `<button role="tab" data-tab="${k}" aria-selected="${tab === k}" class="${tab === k ? 'on' : ''}">${n}</button>`).join('')}</div>
        </div>
        ${tokens(T)}
        ${loc.hourly ? `<h5>Last 24 hours</h5>${chart(loc.hourly)}` : ''}
      </section>
      <p class="u-foot">Limits come from your Claude account and match <code>/usage</code> in the CLI. Token counts are read from Claude Code’s logs on this server, so chats on other devices only show in the limits.</p>`;
  }

  async function load(force) {
    if (loading) return;
    loading = true; renderPop();
    try {
      const r = await fetch('/claude/api/usage' + (force ? '?force=1' : ''), { cache: 'no-store' });
      if (r.ok) data = await r.json();
    } catch {}
    loading = false;
    renderBtn(); renderPop();
  }

  function schedule() {
    clearInterval(timer);
    timer = setInterval(() => { if (!document.hidden) load(); }, pop.hidden ? 60_000 : 20_000);
  }

  function open(v) {
    pop.hidden = !v;
    btn.setAttribute('aria-expanded', String(v));
    btn.classList.toggle('on', v);
    if (v) { renderPop(); load(); }
    schedule();
  }

  btn.addEventListener('click', (e) => { e.stopPropagation(); open(pop.hidden); });
  document.addEventListener('click', (e) => { if (!pop.hidden && !$('#usage').contains(e.target)) open(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !pop.hidden) { open(false); btn.focus(); } });
  pop.addEventListener('click', (e) => {
    const t = e.target.closest('[data-tab]');
    if (t) { tab = t.dataset.tab; localStorage.setItem('cw_usage_tab', tab); renderPop(); return; }
    if (e.target.closest('.u-refresh')) load(true);
  });
  pop.addEventListener('mousemove', (e) => {
    const col = e.target.closest('.u-col'), tip = pop.querySelector('.u-tip');
    if (!tip) return;
    if (!col) { tip.hidden = true; return; }
    const box = tip.parentElement.getBoundingClientRect();
    tip.textContent = col.dataset.tip; tip.hidden = false;
    tip.style.left = Math.max(0, Math.min(box.width - tip.offsetWidth, e.clientX - box.left - tip.offsetWidth / 2)) + 'px';
    pop.querySelectorAll('.u-col.hov').forEach((c) => c.classList.remove('hov')); col.classList.add('hov');
  });
  pop.addEventListener('mouseleave', () => { const tip = pop.querySelector('.u-tip'); if (tip) tip.hidden = true; });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
  // live: refresh shortly after each Claude reply finishes, and keep the "resets in" text ticking
  window.addEventListener('orbit:turn', () => setTimeout(() => load(true), 1500));
  setInterval(() => { renderBtn(); if (!pop.hidden && !pop.matches(':hover')) renderPop(); }, 30_000);

  load(); schedule();
})();
