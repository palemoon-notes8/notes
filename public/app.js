'use strict';

(() => {
  const DATA_URL = '/tenders-lite.json';
  const CACHE_NAME = 'tenderone-data-v1';
  const SAVED_KEY = 'kppp_saved_tenders';
  const THEME_KEY = 'tenderone_theme';
  const VIEW_KEY = 'tenderone_view';
  const PROFILE_KEY = 'tenderone_profile';
  const RSAVED_KEY = 'tenderone_saved_results';
  const NOTES_KEY = 'tenderone_notes';
  const TEXT_KEY = 'tenderone_text_size';
  const WATCH_KEY = 'tenderone_watch';
  const COMPARE_KEY = 'tenderone_compare';
  const PAGE = 30;
  const DAY = 86400000;

  const $ = (id) => document.getElementById(id);
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (v) => (typeof v === 'number' && v > 0 ? v : null);
  const fmtInt = (n) => Number(n || 0).toLocaleString('en-IN');

  // ₹1.18 Cr / ₹25.4 L / ₹2,940 — how contractors read amounts.
  function money(v, { full = false } = {}) {
    const n = num(v);
    if (n === null) return null;
    if (full || n < 100000) return '₹' + n.toLocaleString('en-IN', { maximumFractionDigits: 0 });
    if (n >= 10000000) return '₹' + (n / 10000000).toFixed(n >= 1e9 ? 0 : 2).replace(/\.?0+$/, '') + ' Cr';
    return '₹' + (n / 100000).toFixed(1).replace(/\.0$/, '') + ' L';
  }
  const dateFmt = new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' });
  const shortDate = new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', timeZone: 'Asia/Kolkata' });

  // Days between publishing and bid closing; under 8 means the 7-day minimum or less.
  const bidDays = (pub, close) => (pub && close ? (close - pub) / DAY : null);
  function quickBadge(days) {
    if (days === null || days < 0 || days >= 8) return '';
    const d = Math.floor(days);
    return `<span class="badge quick" title="Only ${d} days between publishing and bid closing">⚡ ${d}-day tender</span>`;
  }

  function timeLeft(ms) {
    if (!ms) return null;
    const diff = ms - Date.now();
    if (diff <= 0) return { label: 'Closed', tone: 'hot', days: -1 };
    const days = diff / DAY;
    if (days < 1) {
      const h = Math.max(1, Math.round(diff / 3600000));
      return { label: `${h} hr left`, tone: 'hot', days };
    }
    const d = Math.floor(days);
    return { label: `${d} day${d === 1 ? '' : 's'} left`, tone: days <= 3 ? 'hot' : days <= 7 ? 'warm' : '', days };
  }

  function ago(iso) {
    const ms = Date.now() - Date.parse(iso);
    if (!Number.isFinite(ms)) return null;
    const min = Math.round(ms / 60000);
    if (min < 1) return 'just now';
    if (min < 60) return `${min} min ago`;
    const h = Math.round(min / 60);
    if (h < 48) return `${h} hr ago`;
    return `${Math.round(h / 24)} days ago`;
  }

  const S = {
    all: [], filtered: [], shown: 0, generatedAt: null,
    cat: 'ALL', soon: 0, savedOnly: false, forMe: false, q: '',
    profile: readJSON(PROFILE_KEY, null),
    saved: new Set(readJSON(SAVED_KEY, [])),
    byId: new Map(),
    compare: readJSON(COMPARE_KEY, [])
  };

  function readJSON(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback; } catch { return fallback; }
  }
  function writeJSON(key, value) {
    if (SYNC_KEYS.includes(key)) queueSync(key, value);
    try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
  }
  // ---------- Your lists, the same on every device (/api/prefs) ----------
  const SYNC_KEYS = [SAVED_KEY, RSAVED_KEY, NOTES_KEY, WATCH_KEY, PROFILE_KEY];
  const SYNC_META = 'tenderone_sync_meta'; // when each list last changed on this device
  let syncPending = {}, syncTimer = null;
  function stamp(key, t) {
    const meta = readJSON(SYNC_META, {});
    meta[key] = t;
    try { localStorage.setItem(SYNC_META, JSON.stringify(meta)); } catch {}
  }
  function queueSync(key, value) {
    const t = Date.now();
    stamp(key, t);
    syncPending[key] = { t, v: JSON.parse(JSON.stringify(value ?? null)) };
    clearTimeout(syncTimer);
    syncTimer = setTimeout(pushSync, 800);
  }
  async function pushSync() {
    const body = syncPending;
    syncPending = {};
    if (!Object.keys(body).length) return;
    try {
      const r = await fetch('/api/prefs', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error(r.status);
    } catch {
      syncPending = { ...body, ...syncPending };
      clearTimeout(syncTimer);
      syncTimer = setTimeout(pushSync, 30000);
    }
  }
  // First sync of a device that already had lists: keep both sides.
  function mergeLists(key, local, server) {
    if (key === NOTES_KEY) return { ...(server || {}), ...(local || {}) };
    if (key === PROFILE_KEY) return server ?? local;
    if (key === WATCH_KEY) {
      const out = [...(server || [])];
      for (const w of local || []) if (!out.some((x) => x.key === w.key)) out.push(w);
      return out;
    }
    return [...new Set([...(server || []), ...(local || [])])];
  }
  function useList(key, value) {
    if (key === SAVED_KEY) { S.saved = new Set(value || []); $('savedCount').textContent = S.saved.size; }
    if (key === RSAVED_KEY) { R.saved = new Set(value || []); $('rSavedCount').textContent = R.saved.size; }
    if (key === NOTES_KEY) { for (const k of Object.keys(notes)) delete notes[k]; Object.assign(notes, value || {}); }
    if (key === WATCH_KEY) watch = Array.isArray(value) ? value : [];
    if (key === PROFILE_KEY) S.profile = value || null;
  }
  async function pullSync() {
    let server;
    try {
      const r = await fetch('/api/prefs', { cache: 'no-store' });
      if (!r.ok) return;
      server = await r.json();
    } catch { return; }
    const meta = readJSON(SYNC_META, {});
    let changed = false;
    for (const key of SYNC_KEYS) {
      const remote = server[key];
      const localT = meta[key] || 0;
      let local = null;
      try { local = JSON.parse(localStorage.getItem(key) || 'null'); } catch {}
      if (remote && remote.t > localT) {
        const value = localT === 0 && local !== null ? mergeLists(key, local, remote.v) : remote.v;
        try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
        useList(key, value);
        changed = true;
        if (value !== remote.v) queueSync(key, value); else stamp(key, remote.t);
      } else if (local !== null && localT >= (remote?.t || 0) && (localT === 0 || localT > (remote?.t || 0))) {
        queueSync(key, local);
      }
    }
    if (!changed) return;
    if (S.all.length) apply({ keepScroll: true });
    if (R.all && R.mode === 'results') applyResults({ keepPage: true });
    if (R.mode === 'watching') renderWatch();
  }


  // ---------- Theme ----------
  function applyTheme(theme) {
    if (theme) document.documentElement.dataset.theme = theme;
    else delete document.documentElement.dataset.theme;
  }
  applyTheme(readJSON(THEME_KEY, null));

  // ---------- Data ----------
  function prepare(t) {
    t._close = t.closing ? Date.parse(t.closing) : null;
    t._pub = t.published ? Date.parse(t.published) : 0;
    t._hay = [t.title, t.desc, t.ref, t.dept, t.office, t.district, t.work].filter(Boolean).join(' ').toLowerCase();
    return t;
  }

  // Who each reserved tender is for (SC / ST / Cat-1 / Cat-2A), read from its KPPP conditions by collect_details.py.
  const MY_CAT = 'SC';
  let reserved = new Map();
  const resvHas = (t, cat) => Boolean(t.resv && t.resv.split('/').includes(cat));
  const resvLabel = (v) => (v === 'Reserved' ? 'Reserved – category not stated' : `${v.replace('Cat-1', 'Category I').replace('Cat-2A', 'Category II-A').replace('Cat-2B', 'Category II-B')} reserved`);
  // The full conditions (reserved.json) win; until they are read, the title/description guess (t.resvGuess) is used.
  function markReserved() { for (const t of S.all) t.resv = t.access === 'Reserved' ? (reserved.get(String(t.nit)) || t.resvGuess || 'Reserved') : null; }
  function loadReserved() {
    fetch('/reserved.json').then((r) => (r.ok ? r.json() : null)).then((d) => {
      if (!d?.tenders) return;
      reserved = new Map(Object.entries(d.tenders));
      if (S.all?.length) { markReserved(); updateCounts(); apply({ keepScroll: true }); }
      if (R.all && R.mode === 'results') applyResults();
    }).catch(() => {});
  }

  function ingest(payload) {
    const now = Date.now();
    S.generatedAt = payload.generated_at || null;
    S.all = (payload.tenders || []).map(prepare).filter((t) => !t._close || t._close > now);
    S.byId = new Map(S.all.map((t) => [t.id, t]));
    markReserved();
    buildFilterOptions();
    updateCounts();
    updateLive();
    apply();
  }

  async function readCache(url = DATA_URL) {
    try {
      const cache = await caches.open(CACHE_NAME);
      const hit = await cache.match(url);
      return hit ? await hit.json() : null;
    } catch { return null; }
  }
  async function writeCache(text, url = DATA_URL) {
    try {
      const cache = await caches.open(CACHE_NAME);
      await cache.put(url, new Response(text, { headers: { 'Content-Type': 'application/json' } }));
    } catch {}
  }

  async function load() {
    loadReserved();
    // Show the last copy instantly on repeat visits, then swap in fresh data.
    const network = fetch(DATA_URL, { cache: 'no-cache' });
    network.catch(() => {}); // handled below; avoids an "unhandled" warning when offline
    const cached = await readCache();
    if (cached?.tenders?.length) ingest(cached);
    try {
      const r = await network;
      if (r.status === 404 && r.headers.get('X-Robots-Tag')) { location.reload(); return; } // signed out on this device
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const text = await r.text();
      const fresh = JSON.parse(text);
      if (!cached || cached.generated_at !== fresh.generated_at) ingest(fresh);
      writeCache(text);
    } catch (err) {
      if (!cached) {
        $('resultTitle').textContent = 'Could not load tenders';
        $('grid').innerHTML = `<div class="empty"><strong>Tender data is unavailable right now.</strong>Please refresh in a minute. (${esc(err.message)})</div>`;
      }
    }
  }

  // ---------- Filters ----------
  function buildFilterOptions() {
    const fill = (id, label, key) => {
      const counts = new Map();
      for (const t of S.all) if (t[key]) counts.set(t[key], (counts.get(t[key]) || 0) + 1);
      const sel = $(id);
      const current = sel.value;
      const opts = [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
      sel.innerHTML = `<option value="">${label}</option>` + opts.map(([v, c]) => `<option value="${esc(v)}">${esc(v)} (${fmtInt(c)})</option>`).join('');
      if (current && counts.has(current)) sel.value = current;
    };
    fill('fDistrict', 'All districts', 'district');
    fill('fDept', 'All departments', 'dept');
  }

  function updateCounts() {
    const c = { ALL: S.all.length, WORKS: 0, GOODS: 0, SERVICES: 0, soon: 0 };
    const soonLimit = Date.now() + 7 * DAY;
    for (const t of S.all) {
      c[t.cat] = (c[t.cat] || 0) + 1;
      if (t._close && t._close <= soonLimit) c.soon++;
    }
    $('cAll').textContent = fmtInt(c.ALL);
    $('cWorks').textContent = fmtInt(c.WORKS);
    $('cGoods').textContent = fmtInt(c.GOODS);
    $('cServices').textContent = fmtInt(c.SERVICES);
    $('cSoon').textContent = fmtInt(c.soon);
    const mine = S.all.filter((t) => resvHas(t, MY_CAT));
    $('scBanner').hidden = !mine.length;
    if (mine.length) {
      const soon = mine.filter((t) => t._close && t._close <= Date.now() + 7 * DAY).length;
      $('scCount').textContent = fmtInt(mine.length);
      $('scSoon').textContent = soon ? ` · ${fmtInt(soon)} closing in 7 days` : '';
    }
  }

  function updateLive() {
    const when = S.generatedAt ? ago(S.generatedAt) : null;
    const stale = S.generatedAt && Date.now() - Date.parse(S.generatedAt) > 3 * 3600000;
    $('liveText').textContent = when ? `${fmtInt(S.all.length)} live tenders · updated ${when}` : `${fmtInt(S.all.length)} live tenders`;
    $('livePill').classList.toggle('stale', Boolean(stale));
    if (S.generatedAt) $('footData').textContent = `Source: KPPP · last updated ${dateFmt.format(new Date(S.generatedAt))}`;
  }

  function readFilters() {
    const [vmin, vmax] = ($('fValue').value || '-').split('-');
    const closing = Number($('fClosing').value || 0) || S.soon;
    return {
      q: S.q.trim().toLowerCase(),
      district: $('fDistrict').value,
      dept: $('fDept').value,
      vmin: vmin ? Number(vmin) : null,
      vmax: vmax ? Number(vmax) : null,
      closing,
      access: $('fAccess').value,
      bidTime: Number($('fBidTime').value) || 0,
      sort: $('fSort').value
    };
  }

  function apply({ keepScroll = false } = {}) {
    const f = readFilters();
    const terms = f.q ? f.q.split(/\s+/).filter(Boolean) : [];
    const closeBy = f.closing ? Date.now() + f.closing * DAY : null;
    const out = [];
    for (const t of S.all) {
      if (S.cat !== 'ALL' && t.cat !== S.cat) continue;
      if (S.savedOnly && !S.saved.has(t.id)) continue;
      if (S.forMe && !matchesProfile(t)) continue;
      if (f.district && t.district !== f.district) continue;
      if (f.dept && t.dept !== f.dept) continue;
      if (f.access) {
        if (f.access === 'mine') { if (!(t.access === 'Open' || resvHas(t, MY_CAT))) continue; }
        else if (f.access === 'Open' || f.access === 'Reserved' || f.access === 'Restricted') { if (t.access !== f.access) continue; }
        else if (f.access === 'unstated') { if (t.resv !== 'Reserved') continue; }
        else if (!resvHas(t, f.access)) continue;
      }
      if (f.vmin !== null || f.vmax !== null) {
        const v = num(t.value);
        if (v === null) continue;
        if (f.vmin !== null && v < f.vmin) continue;
        if (f.vmax !== null && v >= f.vmax) continue;
      }
      if (closeBy && !(t._close && t._close <= closeBy)) continue;
      if (f.bidTime && !(bidDays(t._pub, t._close) < f.bidTime)) continue;
      if (terms.length && !terms.every((w) => t._hay.includes(w))) continue;
      out.push(t);
    }
    const by = {
      new: (a, b) => b._pub - a._pub,
      closing: (a, b) => (a._close || Infinity) - (b._close || Infinity),
      value: (a, b) => (num(b.value) || 0) - (num(a.value) || 0),
      emd: (a, b) => (num(a.emd) ?? Infinity) - (num(b.emd) ?? Infinity)
    }[f.sort] || ((a, b) => b._pub - a._pub);
    out.sort(by);
    S.filtered = out;
    S.shown = 0;
    $('grid').innerHTML = '';
    renderMore();
    renderHead(f);
    syncControls(f);
    if (!keepScroll && window.scrollY > $('filters').offsetTop) window.scrollTo({ top: $('filters').offsetTop - 4 });
  }

  function renderHead(f) {
    const n = S.filtered.length;
    const catLabel = { ALL: 'tenders', WORKS: 'works tenders', GOODS: 'goods tenders', SERVICES: 'services tenders' }[S.cat];
    $('resultTitle').innerHTML = `${fmtInt(n)} <span>${S.savedOnly ? 'saved ' : ''}${catLabel}</span>`;
    const chips = [];
    if (S.cat !== 'ALL') chips.push(['cat', S.cat[0] + S.cat.slice(1).toLowerCase()]);
    if (f.q) chips.push(['q', `“${S.q.trim()}”`]);
    if (f.district) chips.push(['fDistrict', f.district]);
    if (f.dept) chips.push(['fDept', f.dept.length > 34 ? f.dept.slice(0, 32) + '…' : f.dept]);
    if ($('fValue').value) chips.push(['fValue', $('fValue').selectedOptions[0].text]);
    if (f.closing) chips.push(['fClosing', `Closing in ${f.closing} days`]);
    if (f.access) chips.push(['fAccess', $('fAccess').selectedOptions[0].text]);
    if (f.bidTime) chips.push(['fBidTime', $('fBidTime').selectedOptions[0].text]);
    if (S.savedOnly) chips.push(['saved', 'Saved only']);
    if (S.forMe) chips.push(['forMe', 'For me']);
    $('chips').innerHTML = chips.map(([k, label]) => `<button type="button" class="chip" data-clear="${k}">${esc(label)}<b aria-hidden="true">×</b></button>`).join('');
  }

  function syncControls(f) {
    for (const id of ['fDistrict', 'fDept', 'fValue', 'fClosing', 'fAccess', 'fBidTime']) $(id).classList.toggle('set', Boolean($(id).value));
    document.querySelectorAll('.stat[data-cat]').forEach((el) => el.classList.toggle('active', el.dataset.cat === S.cat && !f.closing));
    document.querySelector('.stat.soon').classList.toggle('active', S.soon === 7 && !$('fClosing').value);
    $('savedBtn').classList.toggle('on', S.savedOnly);
    $('forMeBtn').classList.toggle('on', S.forMe);
    $('forMeBtn').setAttribute('aria-pressed', String(S.forMe));
    $('savedBtn').setAttribute('aria-pressed', String(S.savedOnly));
    $('savedCount').textContent = S.saved.size;
  }

  // ---------- Tenders for me ----------
  function matchesProfile(t) {
    const p = S.profile;
    if (!p) return true;
    if (p.cats?.length && !p.cats.includes(t.cat)) return false;
    if (p.districts?.length && !p.districts.includes(t.district)) return false;
    if (p.work?.length && !p.work.includes(t.work)) return false;
    if (!p.reserved && t.access && t.access !== 'Open') return false;
    const v = num(t.value);
    if (v === null) return p.noValue !== false;
    if (p.min && v < p.min) return false;
    if (p.max && v > p.max) return false;
    return true;
  }

  function openProfile() {
    const p = S.profile || {};
    const box = (id, values, chosen) => {
      $(id).innerHTML = values.map(([v, label, n]) => `<label class="check"><input type="checkbox" value="${esc(v)}" ${chosen?.includes(v) ? 'checked' : ''}> ${esc(label)}${n ? ` <small>${fmtInt(n)}</small>` : ''}</label>`).join('');
    };
    const counts = (key) => {
      const m = new Map();
      for (const t of S.all) if (t[key]) m.set(t[key], (m.get(t[key]) || 0) + 1);
      return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([v, n]) => [v, v, n]);
    };
    box('pCats', [['WORKS', 'Works'], ['GOODS', 'Goods'], ['SERVICES', 'Services']], p.cats);
    box('pDistricts', counts('district'), p.districts);
    box('pWork', counts('work'), p.work);
    $('pMin').value = p.min || '';
    $('pMax').value = p.max || '';
    $('pNoValue').checked = p.noValue !== false;
    $('pReserved').checked = Boolean(p.reserved);
    $('profileDialog').showModal();
  }

  function saveProfile() {
    const picked = (id) => [...$(id).querySelectorAll('input:checked')].map((i) => i.value);
    S.profile = {
      cats: picked('pCats'), districts: picked('pDistricts'), work: picked('pWork'),
      min: Number($('pMin').value) || 0, max: Number($('pMax').value) || 0,
      noValue: $('pNoValue').checked, reserved: $('pReserved').checked
    };
    writeJSON(PROFILE_KEY, S.profile);
    S.forMe = true;
    apply();
    toast(`${fmtInt(S.filtered.length)} tenders match your profile`);
  }

  // ---------- Cards ----------
  const pinIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/></svg>';
  const cmpIcon = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M8 3v18M16 3v18M3 8h5M16 16h5"/></svg>';
  const dlIcon = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 4v11m0 0-4-4m4 4 4-4M5 20h14"/></svg>';
  const heartIcon = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8z"/></svg>';

  function fig(label, value) {
    return `<div><span>${label}</span>${value ? `<strong>${value}</strong>` : '<strong class="na">Not given</strong>'}</div>`;
  }

  function card(t) {
    const left = timeLeft(t._close);
    const saved = S.saved.has(t.id);
    const where = [t.district, t.dept].filter(Boolean).join(' · ') || t.office || 'Karnataka';
    return `<article class="card" data-id="${esc(t.id)}" tabindex="0" aria-label="${esc(t.title)}">
      <div class="card-top">
        <span class="badge ${esc(t.cat)}">${esc(t.cat)}</span>
        ${t.access && t.access !== 'Open' ? `<span class="badge reserved${resvHas(t, MY_CAT) ? ' mine' : ''}">${esc(t.resv ? resvLabel(t.resv) : t.access)}</span>` : ''}
        ${t.work ? `<span class="badge soft">${esc(t.work)}</span>` : ''}
        ${quickBadge(bidDays(t._pub, t._close))}
        ${left ? `<span class="due ${left.tone}">${esc(left.label)}</span>` : ''}
      </div>
      <h3>${esc(t.title)}</h3>
      <div class="meta">${pinIcon}<span>${esc(where)}</span></div>
      <div class="figures">${fig('Value', money(t.value))}${fig('EMD', money(t.emd))}${fig('Fee', money(t.fee))}</div>
      <button class="save ${saved ? 'on' : ''}" type="button" data-save="${esc(t.id)}" aria-label="${saved ? 'Remove from saved' : 'Save tender'}" aria-pressed="${saved}">${heartIcon}</button>
      <button class="dlb" type="button" data-dl="${esc(t.id)}" aria-label="Download tender details as PDF" title="Download PDF">${dlIcon}</button>
      <button class="cmpb ${S.compare.includes(t.id) ? 'on' : ''}" type="button" data-cmp="${esc(t.id)}" aria-pressed="${S.compare.includes(t.id)}" aria-label="Add to compare" title="Compare">${cmpIcon}</button>
      ${noteOf('t:' + t.id) ? '<span class="note-flag" title="You have a note on this tender">📝 Note</span>' : ''}
    </article>`;
  }

  function renderMore() {
    const grid = $('grid');
    if (!S.filtered.length) {
      grid.innerHTML = `<div class="empty"><strong>No tenders match these filters.</strong>Try removing a filter or searching for a different word.</div>`;
      $('moreBtn').hidden = true;
      return;
    }
    const next = S.filtered.slice(S.shown, S.shown + PAGE);
    grid.insertAdjacentHTML('beforeend', next.map(card).join(''));
    S.shown += next.length;
    const left = S.filtered.length - S.shown;
    $('moreBtn').hidden = left <= 0;
    $('moreBtn').textContent = `Show more (${fmtInt(left)} left)`;
  }

  function toggleSave(id) {
    if (S.saved.has(id)) S.saved.delete(id); else S.saved.add(id);
    writeJSON(SAVED_KEY, [...S.saved]);
    const on = S.saved.has(id);
    document.querySelectorAll(`[data-save="${CSS.escape(id)}"]`).forEach((b) => {
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
      if (b.classList.contains('btn')) b.lastChild.textContent = on ? ' Saved' : ' Save';
    });
    $('savedCount').textContent = S.saved.size;
    toast(on ? 'Saved to your list' : 'Removed from saved');
    if (S.savedOnly && !on) apply({ keepScroll: true });
  }

  // ---------- Tender page ----------
  let lastFocus = null;
  const detailCache = new Map();

  // KPPP full-view dates are 'dd-mm-yyyy HH:MM:SS' India time.
  function kpppDate(v) {
    const m = String(v || '').match(/^(\d{2})-(\d{2})-(\d{4})\s+(\d{2}):(\d{2})/);
    return m ? Date.parse(`${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}:00+05:30`) : null;
  }
  const fmtKppp = (v) => { const ms = kpppDate(v); return ms ? dateFmt.format(new Date(ms)) : null; };
  const icon = {
    doc: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>',
    check: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="m5 12 5 5 9-10"/></svg>',
    phone: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z"/></svg>',
    back: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M15 18l-6-6 6-6"/></svg>'
  };

  function openTender(id) {
    const t = S.byId.get(id);
    if (!t) return;
    lastFocus = document.activeElement;
    const left = timeLeft(t._close);
    const closeText = t._close ? dateFmt.format(new Date(t._close)) : 'Not given';
    const saved = S.saved.has(t.id);
    const place = [t.office, t.district].filter(Boolean).join(' · ');
    const d = $('drawer');
    d.innerHTML = `
      <div class="tp-bar">
        <div class="wrap tp-bar-in">
          <button class="btn ghost" type="button" data-close>${icon.back} Back to tenders</button>
          <span class="spacer"></span>
          <button class="btn" type="button" data-copy="${esc(t.ref)}">Copy tender no.</button>
          <button class="btn ${S.compare.includes(t.id) ? 'on' : ''}" type="button" data-cmp="${esc(t.id)}" aria-pressed="${S.compare.includes(t.id)}">${cmpIcon} Compare</button>
          <button class="btn" type="button" data-tdl="xlsx" title="Download this tender as Excel">${dlIcon} Excel</button>
          <button class="btn" type="button" data-tdl="pdf" title="Download this tender as PDF">${dlIcon} PDF</button>
          <button class="btn ${saved ? 'on' : ''}" type="button" data-save="${esc(t.id)}" aria-pressed="${saved}">${heartIcon}${saved ? ' Saved' : ' Save'}</button>
        </div>
      </div>
      <header class="tp-hero">
        <div class="wrap">
          <div class="row">
            <span class="badge ${esc(t.cat)}">${esc(t.cat)}</span>
            ${t.access ? `<span class="badge ${t.access === 'Open' ? 'soft' : 'reserved'}${resvHas(t, MY_CAT) ? ' mine' : ''}">${esc(t.resv ? resvLabel(t.resv) : t.access + ' tender')}</span>` : ''}
            ${t.work ? `<span class="badge soft">${esc(t.work)}</span>` : ''}
          </div>
          <h2 id="dTitle">${esc(t.title)}</h2>
          <p class="tp-sub">${esc(t.dept)}${place ? ` · ${esc(place)}` : ''}</p>
          <p class="ref">${esc(t.ref)}</p>
        </div>
      </header>
      <div class="wrap tp-grid">
        <aside class="tp-side">
          <div class="countdown ${left ? left.tone : ''}">
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2M9 2h6"/></svg>
            <div><div class="big">${left ? esc(left.label) : 'No closing date'}</div><small>Bid submission closes ${esc(closeText)}</small></div>
          </div>
          <div class="kpis">
            <div class="kpi"><span>Tender value</span><strong>${money(t.value) || '—'}</strong><small>${num(t.value) ? money(t.value, { full: true }) : 'Not published'}</small></div>
            <div class="kpi"><span>EMD</span><strong>${money(t.emd) || '—'}</strong><small id="emdNote">${num(t.emd) ? money(t.emd, { full: true }) : 'Not published'}</small></div>
            <div class="kpi"><span>Tender fee</span><strong>${money(t.fee) || '—'}</strong><small>${num(t.fee) ? money(t.fee, { full: true }) : 'Not published'}</small></div>
          </div>
          <section class="panel" id="tpDates"><h3>Important dates</h3><dl class="facts">
            ${t._pub ? `<dt>Published</dt><dd>${esc(dateFmt.format(new Date(t._pub)))}</dd>` : ''}
            <dt>Bid submission ends</dt><dd>${esc(closeText)}</dd>
          </dl></section>
          <section class="panel quick-note" id="tpQuick" hidden></section>
          <section class="panel rivals" id="tpRivals" hidden></section>
          <section class="panel" id="tpContact" hidden></section>
          ${notePanel('t:' + t.id)}
          <div class="actions col">
            <a class="btn primary" href="https://kppp.karnataka.gov.in/" target="_blank" rel="noopener">Bid on KPPP portal ↗</a>
          </div>
        </aside>
        <main class="tp-main">
          <section class="panel bid-guide" id="tpBid" hidden></section>
          <div id="tpFull">${loadingBlock()}</div>
        </main>
      </div>
      <div class="wrap tp-wide">
        <div id="tpBoqWrap"></div>
        <div class="tp-pair">
          <section class="panel" id="tpSimilar" hidden></section>
          ${calculatorHtml(t)}
        </div>
      </div>`;
    d.setAttribute('aria-hidden', 'false');
    d.classList.add('open');
    document.body.style.overflow = 'hidden';
    d.scrollTop = 0;
    d.querySelector('[data-close]').focus();
    bindCalculator(t);
    bindNote(d);
    G = { t, f: null, sim: null, ratio: null, cover: 0, past: new Map(), rec: null, recalc: null };
    loadFull(t);
    renderSimilar(t);
    renderQuickNote(t);
    renderRivals(t);
    if (location.hash !== '#t=' + t.id) history.pushState({ tender: t.id }, '', '#t=' + encodeURIComponent(t.id));
  }

  function loadingBlock() {
    return `<section class="panel"><h3>Loading full details…</h3><div class="skeleton line"></div><div class="skeleton line"></div><div class="skeleton line short"></div></section>`;
  }

  async function loadFull(t) {
    const box = $('tpFull');
    if (!t.nit) { box.innerHTML = fullUnavailable(t); return; }
    const key = `${t.cat}/${t.nit}`;
    try {
      if (!detailCache.has(key)) {
        detailCache.set(key, fetch(`/api/tender/${key}`).then((r) => r.json().catch(() => ({ success: false, message: `Server returned HTTP ${r.status}` }))).then((j) => {
          if (!j.success) throw new Error(j.message || 'Not available');
          return j;
        }));
      }
      const full = await detailCache.get(key);
      if ($('tpFull') !== box) return; // another tender was opened meanwhile
      renderFull(t, full);
    } catch (err) {
      detailCache.delete(key);
      if ($('tpFull') === box) {
        box.innerHTML = fullUnavailable(t, err?.message);
        $('retryFull')?.addEventListener('click', () => { box.innerHTML = loadingBlock(); loadFull(t); });
      }
    }
  }

  const filesCache = new Map();
  async function loadFiles(t) {
    const box = $('tpFiles');
    if (!box || !t.nit) return;
    const key = `${t.cat}/${t.nit}`;
    try {
      if (!filesCache.has(key)) {
        filesCache.set(key, fetch(`/api/tender-files/${key}`).then((r) => r.json().catch(() => ({ success: false }))).then((j) => {
          if (!j.success) throw new Error(j.message || 'Not available');
          return j.files || [];
        }));
      }
      const files = await filesCache.get(key);
      if ($('tpFiles') !== box) return;
      box.innerHTML = files.length ? `<h3>Tender documents <span class="count">${files.length}</span></h3>
        <div class="files">${files.map((x) => `<div class="file">${icon.doc}<span><b>${esc(x.name)}</b><small>${esc(x.type || 'Document')}</small></span>
          ${/\.pdf$/i.test(x.name) ? `<a class="btn" href="/pdf?src=${encodeURIComponent(x.url)}" target="_blank" rel="noopener">View</a>` : ''}
          <a class="btn primary" href="${esc(x.url)}&dl=1" download="${esc(x.name)}">Download</a></div>`).join('')}</div>
        <p class="note">Downloads come straight from KPPP. Large files can take a few seconds to start.</p>`
        : '<h3>Tender documents</h3><p class="muted-p">KPPP lists no documents for this tender.</p>';
    } catch (err) {
      filesCache.delete(key);
      if ($('tpFiles') !== box) return;
      box.innerHTML = `<h3>Tender documents</h3><p class="muted-p">KPPP didn't send the documents list right now.</p><button class="btn" type="button" id="retryFiles">Try again</button>`;
      $('retryFiles')?.addEventListener('click', () => { box.innerHTML = '<h3>Tender documents</h3><p class="muted-p">Loading documents from KPPP…</p>'; loadFiles(t); });
    }
  }

  function fullUnavailable(t, reason = '') {
    return `<section class="panel"><h3>Full details</h3><p class="muted-p">KPPP didn't send the full details right now. Search for <b class="ref">${esc(t.ref)}</b> on the KPPP portal, or try again.</p>
      ${reason ? `<p class="note">${esc(reason)}</p>` : ''}
      <button class="btn" type="button" id="retryFull">Try again</button></section>`;
  }

  function renderFull(t, f) {
    // Side column: exact dates, EMD split and contact.
    const dates = [
      ['Published', fmtKppp(f.dates.published)],
      ['Last date for questions', fmtKppp(f.dates.queries)],
      ['Pre-bid meeting', fmtKppp(f.dates.preBid)],
      ['Bid submission ends', fmtKppp(f.dates.submission)],
      ['Bids open', fmtKppp(f.dates.opening)]
    ].filter(([, v]) => v);
    if (dates.length) $('tpDates').innerHTML = `<h3>Important dates</h3><dl class="facts">${dates.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`;
    if (f.money.emdCash && f.money.emdGuarantee && $('emdNote')) {
      $('emdNote').textContent = `${money(f.money.emdCash)} cash + ${money(f.money.emdGuarantee)} bank guarantee`;
    }
    const c = f.contact || {};
    if (c.person || c.mobile || c.address) {
      const box = $('tpContact');
      box.hidden = false;
      box.innerHTML = `<h3>Contact</h3><dl class="facts">
        ${c.person ? `<dt>Officer</dt><dd>${esc(c.person)}</dd>` : ''}
        ${c.mobile ? `<dt>Mobile</dt><dd><a href="tel:${esc(c.mobile)}">${icon.phone} ${esc(c.mobile)}</a></dd>` : ''}
        ${c.address ? `<dt>Address</dt><dd>${esc(c.address)}</dd>` : ''}
      </dl>`;
    }

    // Main column.
    const terms = [
      ['Work description', f.description && f.description !== t.title ? esc(f.description) : ''],
      ['Evaluation', esc(f.terms.evaluation)],
      ['Bid type', esc(f.terms.bidType)],
      ['Tax', f.terms.tax ? esc(f.terms.tax[0].toUpperCase() + f.terms.tax.slice(1)) : ''],
      ['Bid validity', f.terms.validityDays ? `${f.terms.validityDays} days` : ''],
      ['Call', f.terms.call ? `Call ${f.terms.call}${f.terms.retender ? ' (re-tender)' : ''}` : ''],
      ['Technical weightage', f.terms.techWeight ? `${f.terms.techWeight}%` : ''],
      ['Sanctioned budget', num(f.money.provisional) ? `${money(f.money.provisional, { full: true })}<small class="fact-note">Total amount approved for the project (includes GST, contingencies etc.). You bid against the tender value, not this.</small>` : ''],
      ['File number', esc(f.fileNumber)],
      ['Department', esc(t.dept)],
      ['Office', esc(t.office)]
    ].filter(([, v]) => v);

    const files = `<section class="panel" id="tpFiles"><h3>Tender documents</h3><p class="muted-p">Loading documents…</p></section>`;

    const eligibility = f.eligibility.length ? `<section class="panel"><h3>Who is eligible <span class="count">${f.eligibility.length}</span></h3>
      <ol class="rules">${f.eligibility.map((x) => `<li>${esc(x)}</li>`).join('')}</ol></section>` : '';

    const technical = f.technical.length ? `<section class="panel"><h3>Technical qualification <span class="count">${f.technical.length}</span></h3>
      <div class="quals">${f.technical.map((q) => `<div class="qual">
        <div class="qual-top">${q.category ? `<span class="badge soft">${esc(q.category)}</span>` : ''}${q.weight ? `<span class="badge soft">${q.weight} marks</span>` : ''}</div>
        <p>${esc(q.text)}</p>
        ${q.documents.length ? `<small>Proof: ${q.documents.map(esc).join(', ')}</small>` : ''}
      </div>`).join('')}</div></section>` : '';

    const docs = f.documents.length ? `<section class="panel"><h3>Documents to upload with your bid <span class="count">${f.documents.length}</span></h3>
      <ul class="checklist">${f.documents.map((x) => `<li>${icon.check}<span>${esc(x.name)}${x.cover ? `<small>${esc(x.cover)}${x.optional ? '' : ' · mandatory'}</small>` : ''}</span></li>`).join('')}</ul></section>` : '';

    const itemCount = f.groups.reduce((n, g) => n + g.items.length, 0);
    const items = itemCount ? `<section class="panel" id="tpBoq"><h3>${t.cat === 'WORKS' ? 'Bill of quantities' : 'Items'} <span class="count">${fmtInt(itemCount)}</span></h3>
      <div id="boqPricing"></div>
      <div class="win-sum" id="winMoreSum" hidden></div>
      <div class="mybid" id="myBid"></div>
      <div class="mybid-float" id="myBidFloat" hidden></div>
      ${f.groups.map((g, gi) => {
        // Goods tenders often carry ₹1 placeholder prices; only show real rates.
        const showRate = g.items.some((i) => i.rate > 1);
        const showAmt = g.items.some((i) => i.amount > 1);
        return `<div class="boq">
        ${g.name || g.total ? `<div class="boq-head"><b>${esc(g.name || 'Items')}</b>${g.note ? `<span class="badge soft">${esc(g.note)}</span>` : ''}${g.total ? `<span class="spacer"></span><strong>${money(g.total, { full: true })}</strong>` : ''}<span class="win-group" data-wg="${gi}"></span></div>` : ''}
        <div class="table-wrap"><table>
          <thead><tr><th>#</th><th>Item</th><th class="n">Qty</th><th>Unit</th>${showRate ? '<th class="n">Rate</th>' : ''}${showAmt ? '<th class="n">Amount</th>' : ''}<th class="n win" title="Department rate at the 'To win more often' level">To win more often</th><th class="n win">Win-more amount</th><th class="n my">Your rate</th><th class="n my">Your amount</th></tr></thead>
          <tbody>${g.items.map((i, ii) => `<tr data-item="${gi}:${ii}"${ii >= 12 ? ` class="more-row" data-group="${gi}" hidden` : ''}>
            <td>${esc(i.code || ii + 1)}</td>
            <td><div class="item-name">${esc(i.name)}</div>${i.spec && i.spec !== i.name ? `<small>${esc(i.spec)}</small>` : ''}${i.section ? `<small>${esc(i.section)}</small>` : ''}</td>
            <td class="n">${i.qty ?? ''}</td><td>${esc(i.unit)}</td>
            ${showRate ? `<td class="n">${i.rate ? money(i.rate, { full: true }) : ''}<span class="past-rate" data-past="${gi}:${ii}"></span></td>` : ''}
            ${showAmt ? `<td class="n">${i.amount ? money(i.amount, { full: true }) : ''}</td>` : ''}
            <td class="n win" data-wr="${gi}:${ii}"></td><td class="n win" data-wa="${gi}:${ii}"></td>
            <td class="n my"><input type="number" min="0" step="any" inputmode="decimal" data-my="${gi}:${ii}" aria-label="Your rate for item ${esc(i.code || ii + 1)}" placeholder="₹"></td>
            <td class="n my" data-myamt="${gi}:${ii}"></td>
          </tr>`).join('')}</tbody>
        </table></div>
        ${g.items.length > 12 ? `<button class="btn ghost show-rows" type="button" data-group="${gi}">Show all ${fmtInt(g.items.length)} items</button>` : ''}
      </div>`;
      }).join('')}
    </section>` : '';

    const fieldText = (field, v) => {
      if (field === 'Documents') return `${v} files`;
      if (/EMD|fee|value/i.test(field)) return money(Number(v), { full: true }) || String(v);
      return fmtKppp(v) || String(v);
    };
    const changes = (f.changes || []).slice().reverse();
    const changesHtml = changes.length ? `<section class="panel changes"><h3>Changed by the department <span class="count">${changes.length}</span></h3>
      <ul class="change-list">${changes.map((c) => `<li><b>${esc(c.field)}</b><span><s>${esc(fieldText(c.field, c.from))}</s> → <strong>${esc(fieldText(c.field, c.to))}</strong></span><small>Noticed ${esc(ago(c.at) || '')}</small></li>`).join('')}</ul>
      <p class="note">Check the corrigendum on KPPP for the full notice.</p></section>` : '';

    $('tpFull').innerHTML = `
      ${changesHtml}
      <section class="panel"><h3>Tender details</h3><dl class="facts">${terms.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl></section>
      ${files}${eligibility}${technical}${docs}
      ${f.checkedAt ? `<p class="note">Details copied from KPPP ${esc(ago(f.checkedAt) || '')} and re-checked every few hours.</p>` : ''}`;
    // The bill of quantities gets the full page width below.
    $('tpBoqWrap').innerHTML = items;
    if (G.t === t) G.f = f;
    if (itemCount) setupMyBid(t, f);
    updateBidGuide();
    renderWinMore();
    if (t.cat === 'WORKS' && itemCount) annotateRates(t, f);
    loadFiles(t);
    if (f.partial) {
      $('tpFull').insertAdjacentHTML('afterbegin', '<p class="note">KPPP was slow, so this shows the main details only. Open the tender again in a minute for eligibility, documents checklist and bill of quantities.</p>');
    }
    $('tpBoqWrap').querySelectorAll('.show-rows').forEach((b) => b.addEventListener('click', () => {
      $('tpBoqWrap').querySelectorAll(`.more-row[data-group="${b.dataset.group}"]`).forEach((r) => { r.hidden = false; });
      b.remove();
    }));
  }

  // ---------- What to bid + price the BOQ yourself ----------
  let G = {};
  const quart = (a, q) => (a.length ? a[Math.min(a.length - 1, Math.max(0, Math.round(q * (a.length - 1))))] : null);
  const boqEstimate = (f) => (f?.groups || []).reduce((n, g) => n + g.items.reduce((m, i) => m + (num(i.amount) || (num(i.rate) && num(i.qty) ? i.rate * i.qty : 0)), 0), 0);

  function updateBidGuide() {
    const { t, f, sim, ratio, cover } = G;
    const box = $('tpBid');
    if (!t || !box) return;
    const base = num(t.value) || boqEstimate(f) || null;
    const useSim = sim && (sim.q || sim.pcts?.length >= 3) ? sim : null;
    const simQ = useSim ? (useSim.q || [quart(useSim.pcts, 0.25), quart(useSim.pcts, 0.5), quart(useSim.pcts, 0.75)]) : null;
    const simN = useSim ? (useSim.q ? useSim.count : useSim.pcts.length) : 0;
    const useItems = ratio && cover >= 30 ? ratio : null;
    if (!base || (!useSim && !useItems)) { box.hidden = true; G.rec = null; G.lowPct = null; renderWinMore(); return; }
    const simBid = useSim ? base * (1 + simQ[1] / 100) : null;
    const itemBid = useItems ? base * useItems : null;
    // Real winning totals of similar tenders come first; item rates are the fallback.
    const rec = simBid || itemBid;
    G.rec = rec;
    const low = useSim ? base * (1 + simQ[0] / 100) : rec * 0.97;
    // Same "win more often" level item by item: % against the department's rates.
    G.lowPct = (low / base - 1) * 100;
    renderWinMore();
    const high = useSim ? base * (1 + simQ[2] / 100) : rec * 1.03;
    const vs = (x) => { const p = (x / base - 1) * 100; return `${Math.abs(p).toFixed(1)}% ${p <= 0 ? 'below' : 'above'} ${num(t.value) ? 'tender value' : 'estimate'}`; };
    const hasBoq = Boolean($('tpBoq'));
    box.hidden = false;
    box.innerHTML = `<h3>What to bid</h3>
      <div class="bid-main"><span>Suggested bid based on past winners</span><strong>${money(rec, { full: true })}</strong><small>${esc(vs(rec))}</small></div>
      <div class="bid-range">
        <div><span>To win more often</span><b>${money(low, { full: true })}</b><small>${esc(vs(low))}${useSim ? ' · lower than 3 in 4 past winners' : ''}</small></div>
        <div><span>Typical winner</span><b>${money(rec, { full: true })}</b><small>middle of past winning bids</small></div>
        <div><span>Safer margin</span><b>${money(high, { full: true })}</b><small>${esc(vs(high))}${useSim ? ' · 1 in 4 past winners bid this or more' : ''}</small></div>
      </div>
      <ul class="bid-why">
        ${useSim ? `<li>Winners of ${fmtInt(simN)} similar tenders${useSim.history ? ' since 2023' : ''} (${esc(useSim.scope)}) bid a median of <b>${esc(pctText(simQ[1]))}</b>${simBid ? ` → ${money(simBid, { full: true })}` : ''}.</li>` : ''}
        ${useItems ? `<li>${useSim ? 'For comparison, pricing' : 'Pricing'} this bill of quantities at past winners' item rates (${cover.toFixed(0)}% of the work matched) gives <b>${money(itemBid, { full: true })}</b>.</li>` : ''}
      </ul>
      <p class="note">A guide from past KPPP results only — check your own costs and never bid below them.</p>
      ${hasBoq ? '<button class="btn primary" type="button" id="goBoq">Enter my rates item-wise ↓</button>' : ''}`;
    $('goBoq')?.addEventListener('click', () => $('tpBoq').scrollIntoView({ behavior: 'smooth', block: 'start' }));
    G.recalc?.();
  }

  function renderWinMore() {
    const f = G.f;
    const box = $('winMoreSum');
    if (!f || !box || $('tpBoq') === null) return;
    const factor = G.lowPct === null || G.lowPct === undefined ? null : 1 + G.lowPct / 100;
    G.winMore = new Map();
    let total = 0, dept = 0, priced = 0, count = 0;
    f.groups.forEach((g, gi) => {
      let groupTotal = 0;
      g.items.forEach((i, ii) => {
        const k = `${gi}:${ii}`;
        count++;
        const rate = i.rate > 1 ? i.rate : null; // goods often carry ₹1 placeholders
        const wr = factor && rate ? rate * factor : null;
        const amt = wr && num(i.qty) ? wr * i.qty : null;
        const rc = document.querySelector(`[data-wr="${k}"]`);
        const ac = document.querySelector(`[data-wa="${k}"]`);
        if (rc) rc.textContent = wr ? money(wr, { full: true }) : '—';
        if (ac) ac.textContent = amt ? money(amt, { full: true }) : '';
        if (wr) { G.winMore.set(k, wr); priced++; }
        if (amt) { total += amt; groupTotal += amt; dept += num(i.amount) || rate * i.qty; }
      });
      const gs = document.querySelector(`[data-wg="${gi}"]`);
      if (gs) gs.textContent = groupTotal ? ` · win-more ${money(groupTotal, { full: true })}` : '';
    });
    // No past data for this kind of tender: hide the empty win-more columns.
    $('tpBoq')?.classList.toggle('no-win', !factor || !priced);
    if (!factor || !priced) { box.hidden = true; return; }
    box.hidden = false;
    box.innerHTML = `<div><span>To win more often — total for these items</span><strong>${money(total, { full: true })}</strong>
      <small>every item at ${Math.abs(G.lowPct).toFixed(1)}% ${G.lowPct <= 0 ? 'below' : 'above'} the department's rate · ${fmtInt(priced)} of ${fmtInt(count)} items${dept ? ` · department total ${money(dept, { full: true })}` : ''}</small></div>
      <p class="note">Lower than 3 in 4 past winning bids of similar tenders. Check each rate against your own cost — use “Fill rates: To win more often” below to start from these and adjust.</p>`;
  }

  function setupMyBid(t, f) {
    const box = $('myBid');
    if (!box) return;
    const key = `tenderone_bid_${t.cat}_${t.nit}`;
    const saved = readJSON(key, {});
    const inputs = [...$('tpBoqWrap').querySelectorAll('input[data-my]')];
    const item = (k) => { const [gi, ii] = k.split(':').map(Number); return f.groups[gi].items[ii]; };
    const deptAmt = (i) => num(i.amount) || (num(i.rate) && num(i.qty) ? i.rate * i.qty : 0);
    for (const inp of inputs) if (saved[inp.dataset.my] != null) inp.value = saved[inp.dataset.my];

    box.innerHTML = `<div class="mybid-head"><b>My bid</b><small>Type your rate for each item below — the total updates as you type and is saved on this device.</small></div>
      <div class="mybid-sum" id="myBidSum"></div>
      <div class="mybid-actions">
        <span class="lbl">Fill rates:</span>
        <button class="btn" type="button" data-fill="win">To win more often</button>
        ${t.cat === 'WORKS' ? '<button class="btn" type="button" data-fill="past">Past winning rates</button>' : ''}
        <span class="fill-pct"><button class="btn" type="button" data-fill="pct">Department rate</button><input type="number" id="fillPct" value="-10" step="0.5" inputmode="decimal" aria-label="Percent above or below department rate">%</span>
        <button class="btn ghost" type="button" data-fill="clear">Clear</button>
        <span class="spacer"></span>
        <span class="lbl">Download:</span>
        <button class="btn" type="button" data-export="xlsx">Excel</button>
        <button class="btn" type="button" data-export="pdf">PDF</button>
      </div>`;

    let saveTimer;
    const recalc = () => {
      if ($('myBid') !== box) return;
      let mine = 0, rest = 0, all = 0, priced = 0;
      const store = {};
      for (const inp of inputs) {
        const i = item(inp.dataset.my);
        const rate = inp.value === '' ? null : Number(inp.value);
        const cell = box.closest('section').querySelector(`[data-myamt="${inp.dataset.my}"]`);
        all += deptAmt(i);
        if (rate !== null && Number.isFinite(rate) && rate >= 0) {
          const amt = rate * (i.qty || 0);
          mine += amt; priced++;
          store[inp.dataset.my] = rate;
          if (cell) cell.textContent = money(amt, { full: true }) || '₹0';
        } else {
          rest += deptAmt(i);
          if (cell) cell.textContent = '';
        }
      }
      const total = mine + rest;
      const pct = all ? (total / all - 1) * 100 : null;
      const pctTxt = (p, what) => `${Math.abs(p).toFixed(2)}% ${p <= 0 ? 'below' : 'above'} ${what}`;
      $('myBidSum').innerHTML = `
        <div class="hl"><span>My bid total</span><strong>${priced ? money(total, { full: true }) : '—'}</strong><small>${priced && pct !== null ? esc(pctTxt(pct, "department's estimate")) : 'Enter rates below'}</small></div>
        <div><span>Items priced</span><strong>${fmtInt(priced)} of ${fmtInt(inputs.length)}</strong><small>${priced && priced < inputs.length ? `other items counted at department rate (${money(rest, { full: true })})` : priced ? 'all items priced' : ''}</small></div>
        ${G.rec && priced ? `<div><span>vs suggested bid</span><strong>${money(Math.abs(total - G.rec), { full: true }) || '₹0'}</strong><small>${total <= G.rec ? 'below' : 'above'} the suggested ${money(G.rec, { full: true })}</small></div>` : ''}`;
      G.mine = { total, priced, all };
      const fl = $('myBidFloat');
      if (fl) {
        fl.hidden = !priced;
        fl.innerHTML = `<span>My bid</span><b>${money(total, { full: true })}</b>${pct !== null ? `<small>${esc(pctTxt(pct, 'estimate'))} · ${fmtInt(priced)}/${fmtInt(inputs.length)} priced</small>` : ''}`;
      }
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => { if (Object.keys(store).length) writeJSON(key, store); else try { localStorage.removeItem(key); } catch {} }, 400);
    };
    if (G.t === t) G.recalc = recalc;
    inputs.forEach((inp) => inp.addEventListener('input', recalc));

    box.addEventListener('click', (e) => {
      const fill = e.target.closest('[data-fill]')?.dataset.fill;
      const exp = e.target.closest('[data-export]')?.dataset.export;
      if (fill === 'clear') { inputs.forEach((inp) => { inp.value = ''; }); recalc(); toast('Rates cleared'); }
      if (fill === 'pct') {
        const p = Number($('fillPct').value) || 0;
        let n = 0;
        for (const inp of inputs) { const i = item(inp.dataset.my); if (num(i.rate)) { inp.value = (i.rate * (1 + p / 100)).toFixed(2); n++; } }
        recalc(); toast(n ? `${n} items filled at department rate ${p > 0 ? '+' : ''}${p}%` : 'This tender has no department rates to start from');
      }
      if (fill === 'win') {
        if (!G.winMore?.size) { toast('No "to win more often" level for this tender yet'); return; }
        let n = 0;
        for (const inp of inputs) { const w = G.winMore.get(inp.dataset.my); if (w) { inp.value = w.toFixed(2); n++; } }
        recalc(); toast(`${n} items filled at the "to win more often" level`);
      }
      if (fill === 'past') {
        if (!G.past.size) { toast('Past winning rates are still loading or not found for these items'); return; }
        let n = 0, other = 0;
        for (const inp of inputs) {
          const i = item(inp.dataset.my);
          const past = G.past.get(inp.dataset.my);
          if (past) { inp.value = past.toFixed(2); n++; } else if (num(i.rate) && G.ratio) { inp.value = (i.rate * G.ratio).toFixed(2); other++; }
        }
        recalc(); toast(`${n} items at past winning rates${other ? `, ${other} scaled the same way` : ''}`);
      }
      if (exp) exportBid(t, f, inputs.map((inp) => [inp.dataset.my, inp.value === '' ? null : Number(inp.value)]), exp);
    });
    recalc();
  }

  const scriptLoads = new Map();
  function loadScript(src) {
    if (!scriptLoads.has(src)) {
      scriptLoads.set(src, new Promise((resolve, reject) => {
        const el = Object.assign(document.createElement('script'), { src, onload: resolve, onerror: () => { scriptLoads.delete(src); reject(new Error('Could not load ' + src)); } });
        document.head.appendChild(el);
      }));
    }
    return scriptLoads.get(src);
  }

  async function exportBid(t, f, mineList, kind) {
    const mine = new Map(mineList);
    const rows = [];
    let deptTotal = 0, myTotal = 0;
    f.groups.forEach((g, gi) => g.items.forEach((i, ii) => {
      const k = `${gi}:${ii}`;
      const dAmt = num(i.amount) || (num(i.rate) && num(i.qty) ? i.rate * i.qty : null);
      const my = mine.get(k);
      const myAmt = my !== null && my !== undefined ? my * (i.qty || 0) : dAmt;
      deptTotal += dAmt || 0; myTotal += myAmt || 0;
      const win = G.f === f ? G.winMore?.get(k) ?? null : null;
      rows.push({ no: i.code || ii + 1, group: g.name || '', name: i.name || '', qty: i.qty ?? '', unit: i.unit || '', rate: num(i.rate), amt: dAmt, win, winAmt: win && i.qty ? win * i.qty : null, past: G.f === f ? G.past.get(k) ?? null : null, my: my ?? null, myAmt: myAmt ?? null });
    }));
    const pct = deptTotal ? (myTotal / deptTotal - 1) * 100 : null;
    const title = `My bid — ${t.ref}`;
    const info = [[t.title], [`${t.dept || ''}${t.office ? ' · ' + t.office : ''}`], [`Tender value: ${num(t.value) ? 'Rs. ' + t.value.toLocaleString('en-IN', { maximumFractionDigits: 2 }) : 'not published'}   ·   Prepared on TenderOne ${new Date().toLocaleDateString('en-IN')}`]];
    const fileBase = `bid-${String(t.ref || t.nit).replace(/[^\w-]+/g, '_')}`;
    const r2 = (v) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v ?? '');
    try {
      if (kind === 'xlsx') {
        toast('Preparing Excel file…');
        await loadScript('/vendor/xlsx.mini.min.js');
        const winTotal = rows.reduce((n, r) => n + (r.winAmt || 0), 0);
        const head = ['Item no.', 'Item', 'Qty', 'Unit', 'Department rate', 'Department amount', 'To win more often (rate)', 'To win more often (amount)', 'Past winners (median rate)', 'My rate', 'My amount'];
        const aoa = [[title], ...info, [], head,
          ...rows.map((r) => [r.no, r.name, r2(r.qty), r.unit, r2(r.rate), r2(r.amt), r2(r.win), r2(r.winAmt), r2(r.past), r2(r.my), r2(r.myAmt)]),
          [], ['', 'TOTAL', '', '', '', r2(deptTotal), '', r2(winTotal) || '', '', '', r2(myTotal)],
          ['', pct === null ? '' : `My bid is ${Math.abs(pct).toFixed(2)}% ${pct <= 0 ? 'below' : 'above'} the department's estimate`]];
        const ws = window.XLSX.utils.aoa_to_sheet(aoa);
        ws['!cols'] = [{ wch: 14 }, { wch: 60 }, { wch: 10 }, { wch: 10 }, { wch: 16 }, { wch: 18 }, { wch: 18 }, { wch: 20 }, { wch: 16 }, { wch: 14 }, { wch: 18 }];
        const wb = window.XLSX.utils.book_new();
        window.XLSX.utils.book_append_sheet(wb, ws, 'My bid');
        window.XLSX.writeFile(wb, fileBase + '.xlsx');
      } else {
        toast('Preparing PDF…');
        await loadScript('/vendor/jspdf.umd.min.js');
        await loadScript('/vendor/jspdf.plugin.autotable.min.js');
        const doc = new window.jspdf.jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });
        // Standard PDF fonts have no ₹ sign, so amounts are written as "Rs.".
        const rs = (v) => (typeof v === 'number' ? 'Rs. ' + v.toLocaleString('en-IN', { maximumFractionDigits: 2 }) : '');
        doc.setFontSize(14); doc.text(title, 40, 40);
        doc.setFontSize(9);
        doc.text(doc.splitTextToSize(info.map((x) => x[0]).join('\n'), 760), 40, 58);
        doc.autoTable({
          startY: 100,
          head: [['No.', 'Item', 'Qty', 'Unit', 'Dept. rate', 'Dept. amount', 'Win-more rate', 'Win-more amount', 'Past winners', 'My rate', 'My amount']],
          body: rows.map((r) => [r.no, r.name.slice(0, 160), r.qty, r.unit, rs(r.rate), rs(r.amt), rs(r.win), rs(r.winAmt), rs(r.past), rs(r.my), rs(r.myAmt)]),
          foot: [['', 'TOTAL', '', '', '', rs(deptTotal), '', rs(rows.reduce((n, r) => n + (r.winAmt || 0), 0)) || '', '', '', rs(myTotal)]],
          styles: { fontSize: 7.5, cellPadding: 3, overflow: 'linebreak' },
          headStyles: { fillColor: [79, 70, 229] }, footStyles: { fillColor: [229, 247, 239], textColor: [4, 120, 87] },
          columnStyles: { 1: { cellWidth: 190 }, 2: { halign: 'right' }, 4: { halign: 'right' }, 5: { halign: 'right' }, 6: { halign: 'right' }, 7: { halign: 'right' }, 8: { halign: 'right' }, 9: { halign: 'right' }, 10: { halign: 'right' } },
          margin: { left: 40, right: 40 }
        });
        const y = doc.lastAutoTable.finalY + 20;
        doc.setFontSize(10);
        doc.text(`My bid total: ${rs(myTotal)}${pct === null ? '' : `  (${Math.abs(pct).toFixed(2)}% ${pct <= 0 ? 'below' : 'above'} the department's estimate)`}`, 40, y);
        if (G.rec) doc.text(`Suggested bid from past winners: ${rs(Math.round(G.rec))}`, 40, y + 16);
        doc.save(fileBase + '.pdf');
      }
    } catch (err) {
      toast('Download failed — please try again');
    }
  }

  function closeDrawer({ fromHistory = false } = {}) {
    const d = $('drawer');
    if (!d.classList.contains('open')) return;
    d.classList.remove('open');
    d.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
    if (!fromHistory && (/^#[tca]=/.test(location.hash) || location.hash === '#compare')) history.back();
    lastFocus?.focus?.();
  }

  // ---------- Bid calculator (runs in the browser) ----------
  const PROFILES = {
    WORKS: { direct: 80, overhead: 5, contingency: 3, margin: 8 },
    GOODS: { direct: 90, overhead: 3, contingency: 2, margin: 6 },
    SERVICES: { direct: 75, overhead: 8, contingency: 4, margin: 10 }
  };

  function calculatorHtml(t) {
    const p = PROFILES[t.cat] || PROFILES.WORKS;
    const slider = (id, label, value, max) => `<div class="field"><label for="${id}">${label}<output id="${id}Out">${value}%</output></label><input id="${id}" type="range" min="0" max="${max}" step="0.5" value="${value}"></div>`;
    return `<section class="panel">
      <h3>Bid calculator</h3>
      <div class="calc-grid">
        <div class="field" style="grid-column:1/-1"><label for="cValue">Tender value (₹)</label><input id="cValue" type="number" min="0" step="1000" inputmode="numeric" value="${num(t.value) ? Math.round(t.value) : ''}" placeholder="Enter the tender value"></div>
        ${slider('cDirect', 'Direct cost (material + labour)', p.direct, 120)}
        ${slider('cOverhead', 'Site overhead', p.overhead, 30)}
        ${slider('cContingency', 'Risk / contingency', p.contingency, 20)}
        ${slider('cMargin', 'Your profit margin', p.margin, 30)}
      </div>
      <div class="calc-out" id="calcOut"></div>
      <p class="note">Percentages are of tender value and start from a typical ${esc((t.cat || 'works').toLowerCase())} profile — move them to match your own rates. Planning estimate only.</p>
    </section>`;
  }

  function bindCalculator(t) {
    const ids = ['cValue', 'cDirect', 'cOverhead', 'cContingency', 'cMargin'];
    const run = () => {
      const v = Number($('cValue').value) || 0;
      const [direct, overhead, contingency, margin] = ids.slice(1).map((id) => {
        const n = Number($(id).value) || 0;
        $(id + 'Out').textContent = n + '%';
        return n;
      });
      const out = $('calcOut');
      if (v <= 0) {
        out.innerHTML = '<div class="warnline">Enter the tender value to calculate your bid.</div>';
        return;
      }
      const cost = v * (direct + overhead + contingency) / 100;
      const bid = margin < 100 ? cost / (1 - margin / 100) : cost;
      const profit = bid - cost;
      const vsValue = ((bid - v) / v) * 100;
      const pct = (n) => `${n > 0 ? '+' : ''}${n.toFixed(2)}%`;
      out.innerHTML = `
        <div class="kpi hero-kpi"><span>Suggested bid</span><strong>${money(bid, { full: true })}</strong><small>${pct(vsValue)} vs tender value (${vsValue <= 0 ? 'below' : 'above'} estimate)</small></div>
        <div class="kpi"><span>Your total cost</span><strong>${money(cost)}</strong><small>Break-even bid</small></div>
        <div class="kpi"><span>Expected profit</span><strong>${money(profit) || '₹0'}</strong><small>${margin}% of your bid</small></div>
        <div class="kpi"><span>Maximum discount</span><strong>${cost < v ? ((v - cost) / v * 100).toFixed(1) + '%' : 'None'}</strong><small>Bid lower than this and you make a loss</small></div>
        <div class="kpi"><span>Working capital</span><strong>${money(Math.max(cost * 0.12, num(t.emd) || 0))}</strong><small>Rough cash needed to start</small></div>
        ${cost >= v ? '<div class="warnline" style="grid-column:1/-1">Your cost is at or above the tender value — check your rates before bidding.</div>' : ''}`;
    };
    ids.forEach((id) => $(id).addEventListener('input', run));
    run();
  }

  // ---------- Past results & winners ----------
  const R = { mode: 'live', all: null, filtered: [], shown: 0, q: '', loading: null, saved: new Set(readJSON(RSAVED_KEY, [])), savedOnly: false };
  const median = (arr) => {
    if (!arr.length) return null;
    const a = [...arr].sort((x, y) => x - y);
    const m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  };
  const pctText = (p) => (p === null || p === undefined ? '—' : `${Math.abs(p).toFixed(1)}% ${p < 0 ? 'below' : p > 0 ? 'above' : 'at'} estimate`);
  const winPct = (r) => r.bidders?.[0]?.pct ?? null;

  const RESULTS_URL = '/results-lite.json';
  function ingestResults(d) {
    R.generatedAt = d.generated_at || null;
    R.all = (d.results || []).map((r) => {
      r._award = r.awarded ? Date.parse(r.awarded) : (r.closed ? Date.parse(r.closed) : 0);
      r._hay = norm([r.title, r.ref, r.dept, r.office, r.district, r.work, r.winner, ...(r.bidders || []).map((b) => b.name)].filter(Boolean).join(' '));
      r._hayc = r._hay.replace(/ /g, '');
      r._names = [...new Set([r.winner, ...(r.bidders || []).map((b) => b.name)].filter(Boolean))].map((n) => [n, norm(n)]);
      return r;
    });
    R.byNit = new Map(R.all.map((r) => [r.nit, r]));
    const fill = (id, label, key) => {
      const counts = new Map();
      for (const r of R.all) if (r[key]) counts.set(r[key], (counts.get(r[key]) || 0) + 1);
      const sel = $(id);
      const current = sel.value;
      sel.innerHTML = `<option value="">${label}</option>` + [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([v, c]) => `<option value="${esc(v)}">${esc(v)} (${fmtInt(c)})</option>`).join('');
      if (current && counts.has(current)) sel.value = current;
    };
    fill('rDistrict', 'All districts', 'district');
    fill('rDept', 'All departments', 'dept');
    fill('rWork', 'All types of work', 'work');
    return R.all;
  }

  // Like the tenders: show the copy saved in the browser at once, then swap in the fresh one.
  function loadResults() {
    if (!R.loading) {
      R.loading = (async () => {
        const network = fetch(RESULTS_URL, { cache: 'no-cache' })
          .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`))));
        network.catch(() => {}); // handled below
        const cached = await readCache(RESULTS_URL);
        const refresh = network.then((text) => {
          const fresh = JSON.parse(text);
          if (!cached || cached.generated_at !== fresh.generated_at) {
            ingestResults(fresh);
            if (cached && R.mode === 'results') applyResults({ keepPage: true });
          }
          writeCache(text, RESULTS_URL);
          return R.all;
        });
        if (cached?.results?.length) {
          refresh.catch(() => {});
          return ingestResults(cached);
        }
        return refresh;
      })().catch((err) => { R.loading = null; throw err; });
    }
    return R.loading;
  }

  function setMode(mode) {
    R.mode = mode;
    document.querySelectorAll('[data-mode]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.mode === mode)));
    document.querySelector(`[data-mode="${mode}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    $('liveView').hidden = mode !== 'live';
    $('resultsView').hidden = mode !== 'results';
    $('biddersView').hidden = mode !== 'bidders';
    $('downloadsView').hidden = mode !== 'downloads';
    $('watchView').hidden = mode !== 'watching';
    $('chartsView').hidden = mode !== 'charts';
    document.querySelector('.search').hidden = ['downloads', 'watching', 'charts'].includes(mode);
    if (mode === 'downloads') loadDownloads();
    if (mode === 'watching') {
      renderWatch();
      loadResults().then(() => { if (R.mode === 'watching') renderWatch(); }).catch(() => {});
    }
    if (mode === 'charts') {
      loadResults().then(() => {
        const d = $('cDistrict'), current = d.value;
        d.innerHTML = $('rDistrict').innerHTML;
        d.value = current;
        renderCharts();
      }).catch(() => { $('rChartsBody').innerHTML = '<p class="muted-p">Past results are still being collected.</p>'; });
      renderQuickPanel();
    }
    $('q').value = mode === 'results' ? R.q : mode === 'bidders' ? B.q : S.q;
    $('q').placeholder = mode === 'results' ? 'Search results by work, department, town or contractor name…'
      : mode === 'bidders' ? 'Search a bidder or firm name…' : 'Search by work, tender number, department or town…';
    if (mode === 'bidders') {
      loadDownloads();
      $('bTitle').textContent = 'Loading bidders…';
      loadBidders().then(() => applyBidders()).catch(() => {
        $('bTitle').textContent = 'The bidder list is still being built';
        $('bList').innerHTML = '<div class="empty"><strong>Not ready yet.</strong>The full bidder list appears after tonight\'s history update.</div>';
      });
    }
    if (mode === 'results') {
      $('rTitle').textContent = 'Loading results…';
      loadResults().then(() => applyResults()).catch((err) => {
        $('rTitle').textContent = 'Results are not available yet';
        $('rList').innerHTML = `<div class="empty"><strong>Past results are still being collected.</strong>Please check again later. (${esc(err.message)})</div>`;
      });
    }
  }

  // Search ignores dots, brackets and spacing: "p.n. shashidhar", "jeevanrekha" and "JEEVAN REKHA" all match.
  const norm = (v) => ` ${String(v || '').toLowerCase().replace(/[^a-z0-9\u0c80-\u0cff]+/g, ' ').trim()} `.replace(/\s+/g, ' ');
  function queryMatch(r, q) {
    const terms = norm(q).trim().split(' ').filter(Boolean);
    if (!terms.length) return true;
    return terms.every((w) => r._hay.includes(w)) || r._hayc.includes(terms.join(''));
  }
  function matchedBidders(r, q) {
    const terms = norm(q).trim().split(' ').filter(Boolean);
    if (!terms.length) return [];
    const compact = terms.join('');
    return r._names.filter(([, n]) => terms.every((w) => n.includes(w)) || n.replace(/ /g, '').includes(compact)).map(([name]) => name);
  }
  // ---------- Bidders tab: every bidder from the whole history (bidders.json) ----------
  const B = { all: null, loading: null, q: '', shown: 0, list: [] };
  function loadBidders() {
    if (!B.loading) {
      B.loading = fetch('/bidders.json').then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))).then((d) => {
        // [name, bids, wins, value, latest, districts, usual winning %]
        B.all = (d.bidders || []).map(([name, bids, wins, value, last, districts, winPct, split]) => {
          const who = splitName(name);
          return { name, firm: who.firm, person: who.person, bids, wins, value, last, districts: districts || [], winPct, split: split || [],
            _sortName: who.firm.replace(/^[^A-Za-z]+/, '').toUpperCase(), _hay: norm(name), _hayc: norm(name).replace(/ /g, '') };
        });
        B.districts = d.districts || [...new Set(B.all.flatMap((b) => b.districts))].sort();
        B.years = d.years || [];
        $('bDistrict').innerHTML = '<option value="">All districts</option>' + B.districts.map((x) => `<option>${esc(x)}</option>`).join('');
        $('bYear').innerHTML = '<option value="">All years</option>' + B.years.slice().reverse().map((x) => `<option>${esc(x)}</option>`).join('');
        return B.all;
      }).catch((err) => { B.loading = null; throw err; });
    }
    return B.loading;
  }
  function applyBidders() {
    if (!B.all) return;
    const terms = norm(B.q).trim().split(' ').filter(Boolean);
    const district = $('bDistrict').value;
    const year = $('bYear').value;
    const min = Number($('bMin').value) || 0;
    // With a district or year chosen, count only the bids made there / then.
    const di = district ? B.districts.indexOf(district) : -1;
    const yi = year ? B.years.indexOf(year) : -1;
    const view = (b) => {
      if (di < 0 && yi < 0) return b;
      if (!b.split.length) return (!district || b.districts.includes(district)) && !year ? b : { bids: 0 }; // older data without the split
      let bids = 0, wins = 0, value = 0;
      const s = b.split;
      for (let i = 0; i < s.length; i += 5) {
        if ((di < 0 || s[i] === di) && (yi < 0 || s[i + 1] === yi)) { bids += s[i + 2]; wins += s[i + 3]; value += s[i + 4]; }
      }
      return { bids, wins, value };
    };
    const list = [];
    for (const b of B.all) {
      if (terms.length && !(terms.every((w) => b._hay.includes(w)) || b._hayc.includes(terms.join('')))) continue;
      const v = view(b);
      if (!v.bids || v.bids < min) continue;
      b.v = v;
      list.push(b);
    }
    const by = {
      wins: (a, b) => b.v.wins - a.v.wins || b.v.bids - a.v.bids,
      bids: (a, b) => b.v.bids - a.v.bids || b.v.wins - a.v.wins,
      rate: (a, b) => (b.v.bids >= 5) - (a.v.bids >= 5) || b.v.wins / b.v.bids - a.v.wins / a.v.bids || b.v.bids - a.v.bids,
      value: (a, b) => (b.v.value || 0) - (a.v.value || 0),
      latest: (a, b) => String(b.last || '').localeCompare(String(a.last || '')),
      name: (a, b) => a._sortName.localeCompare(b._sortName)
    }[$('bSort').value];
    list.sort(by);
    B.list = list; B.shown = 0;
    const where = [district, year].filter(Boolean).join(' · ');
    $('bTitle').innerHTML = `${fmtInt(list.length)} <span>bidders${where ? ` in ${esc(where)}` : ''}</span>`;
    $('bList').innerHTML = list.length ? `<div class="table-wrap"><table class="lead bidders-table">
      <thead><tr><th>#</th><th>Bidder</th><th class="n">Bid</th><th class="n">Won</th><th class="n">Win rate</th><th class="n">Value won</th><th>Works in</th><th>Latest bid</th></tr></thead>
      <tbody id="bRows"></tbody></table></div>` : '<div class="empty"><strong>No bidders match.</strong>Try a different name or remove a filter.</div>';
    moreBidders();
  }
  function moreBidders() {
    const next = B.list.slice(B.shown, B.shown + 50);
    $('bRows')?.insertAdjacentHTML('beforeend', next.map((b, i) => `<tr>
      <td>${B.shown + i + 1}</td>
      <td><button type="button" class="linkish" data-contractor="${esc(b.name)}">${isWatched(b.name) ? '👁 ' : ''}${esc(b.firm)}</button>${b.person ? `<small class="who">${esc(b.person)}</small>` : ''}</td>
      <td class="n">${fmtInt(b.v.bids)}</td><td class="n"><b>${fmtInt(b.v.wins)}</b></td>
      <td class="n">${b.v.bids ? Math.round(b.v.wins / b.v.bids * 100) + '%' : ''}</td>
      <td class="n">${b.v.value ? money(b.v.value) : '—'}</td>
      <td><small>${esc(b.districts.join(', '))}</small></td>
      <td><small>${b.last ? esc(shortDate.format(new Date(b.last))) + ' ' + esc(b.last.slice(0, 4)) : ''}</small></td></tr>`).join(''));
    B.shown += next.length;
    const left = B.list.length - B.shown;
    $('bMore').hidden = left <= 0;
    $('bMore').textContent = `Show more (${fmtInt(left)} left)`;
  }

  // ---------- Likely competitors: who usually bids on works from this office (competitors.json) ----------
  let rivalsData = null;
  function loadRivals() {
    if (!rivalsData) {
      rivalsData = fetch('/competitors.json').then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .catch((err) => { rivalsData = null; throw err; });
    }
    return rivalsData;
  }
  async function renderRivals(t) {
    if (t.cat !== 'WORKS') return;
    let d = null;
    try { d = await loadRivals(); } catch {}
    const box = $('tpRivals');
    if (!box || G.t !== t || !d) return;
    let hit = d.office?.[t.office];
    let scope = 'this office';
    if (!hit && t.dept && t.district) {
      hit = d.group?.[`${t.dept}|${t.district}|${t.work || ''}`];
      scope = `${t.dept} in ${t.district}${t.work ? ` (${t.work})` : ''}`;
    }
    if (!hit) return;
    const [n, avg, people] = hit;
    const monthYear = (v) => (v ? new Date(v + 'T00:00:00').toLocaleString('en-IN', { month: 'short', year: 'numeric' }) : '');
    box.innerHTML = `<h3>Likely competitors</h3>
      <p class="note" style="margin-top:0">Who bid most often on ${esc(scope)} in the last 3 years: ${fmtInt(n)} awarded works, about ${avg} bidders each.</p>
      <div class="table-wrap"><table class="lead rivals-table">
      <tbody>${people.map(([name, bids, wins, pct, last]) => `<tr>
        <td><button type="button" class="linkish" data-contractor="${esc(name)}">${isWatched(name) ? '👁 ' : ''}${esc(splitName(name).firm)}</button><small class="who">Last bid ${esc(monthYear(last))}</small><small class="rv-sum">${fmtInt(bids)} bids · <b>${fmtInt(wins)} won</b>${pct === null ? '' : ` · ${esc(pctText(pct).replace(' estimate', ''))}`}</small></td></tr>`).join('')}</tbody></table></div>
      <p class="note">From past results only. Tap a name for every tender they bid and their item-wise rates.</p>`;
    box.hidden = false;
  }

  // ---------- Quick tenders: published and closed fast (quick.json from the whole history) ----------
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  let quickData = null;
  function loadQuick() {
    if (!quickData) {
      quickData = fetch('/quick.json').then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))).then((d) => {
        // office row: [name, district, dept, tenders, 7 days or less, under 7 days, avg bidders, avg bidders on quick, top winners]
        d.byOffice = new Map((d.offices || []).map((o) => [o[0], o]));
        return d;
      }).catch((err) => { quickData = null; throw err; });
    }
    return quickData;
  }
  const winnersHtml = (top) => top.map(([n, c]) => `<button type="button" class="linkish" data-contractor="${esc(n)}">${esc(splitName(n).firm)}</button> (${c})`).join(', ');

  async function renderQuickNote(t) {
    const days = bidDays(t._pub, t._close);
    let q = null;
    try { q = await loadQuick(); } catch {}
    const box = $('tpQuick');
    if (!box || G.t !== t) return;
    const o = q?.byOffice.get(t.office);
    const short = days !== null && days >= 0 && days < 8;
    if (!short && !o) return;
    const band = (label) => q?.bands.find((b) => b.label === label);
    const bu = band('Under 7 days'); const b15 = band('11-15 days');
    const lines = [];
    if (short) {
      lines.push(`This tender gives only <b>${Math.floor(days)} days</b> from publishing to bid closing${days < 7 ? ' — less than the usual 7-day minimum, so fewer contractors notice it in time' : ' — the minimum time allowed'}.`);
      if (days < 7 && bu && b15) lines.push(`Past works tenders with under 7 days got ${bu.bidders} bidders on average (${bu.single}% had only one bidder), against ${b15.bidders} (${b15.single}%) for 11–15 day tenders.`);
    }
    if (o) {
      lines.push(`<b>This office</b> gave 7 days or less on ${fmtInt(o[4])} of its ${fmtInt(o[3])} past works tenders${o[5] ? ` (${fmtInt(o[5])} under 7 days)` : ''}. Those got ${o[7]} bidders on average (all its tenders: ${o[6]}).`);
      if (o[8]?.length) lines.push(`Its short tenders were usually won by ${winnersHtml(o[8])}.`);
    }
    box.innerHTML = `<h3>⚡ Time to bid</h3>${lines.map((l) => `<p>${l}</p>`).join('')}`;
    box.hidden = false;
  }

  async function renderQuickPanel() {
    const box = $('rQuickBody');
    let q;
    try { q = await loadQuick(); } catch {
      box.innerHTML = '<p class="muted-p">These figures appear after tonight\'s history update.</p>';
      return;
    }
    const district = $('cDistrict').value;
    const offices = q.offices.filter((o) => !district || o[1] === district);
    const quick = q.quick.filter((x) => !district || x[4] === district);
    const maxShare = Math.max(...q.months.map(([, n, , q8]) => (n ? q8 / n : 0)));
    const b = Object.fromEntries(q.bands.map((x) => [x.label, x]));
    const under = b['Under 7 days'];
    const fastMonths = q.months.slice().sort((x, y) => y[2] - x[2]).slice(0, 3).filter((m) => m[2]);
    box.innerHTML = `
      <div class="quick-find">
        <p><b>What the past data shows</b></p>
        <ul>
          <li>Most works tenders give 7–15 days to bid; <b>7 days</b> is the usual minimum (${fmtInt(b['7 days']?.tenders || 0)} tenders).</li>
          ${under?.tenders ? `<li>Only <b>${fmtInt(under.tenders)}</b> gave <b>less than 7 days</b>. They got ${under.bidders} bidders on average and <b>${under.single}%</b> had a single bidder (normally about ${b['11-15 days']?.single ?? 25}%).</li>` : ''}
          ${fastMonths.length ? `<li>Very short tenders cluster in <b>${fastMonths.map((m) => MONTHS[m[0] - 1]).join(', ')}</b> — offices rushing to spend the budget before the financial year ends on 31 March.</li>` : ''}
          <li>A short deadline is allowed for urgent work; treat it as a reason to look closer, not proof of anything.</li>
        </ul>
      </div>
      <h4>Time to bid vs competition</h4>
      <div class="table-wrap"><table class="lead"><thead><tr><th>Time to bid</th><th class="n">Tenders</th><th class="n">Avg bidders</th><th class="n">Only 1 bidder</th><th class="n">Usual winning bid</th></tr></thead>
        <tbody>${q.bands.map((x) => `<tr><td>${esc(x.label)}</td><td class="n">${fmtInt(x.tenders)}</td><td class="n">${x.bidders ?? '—'}</td><td class="n">${x.single ?? '—'}%</td><td class="n">${x.l1 !== null ? esc(pctText(x.l1)) : '—'}</td></tr>`).join('')}</tbody></table></div>
      <h4>When short tenders are published</h4>
      <div class="quick-months">${q.months.map(([m, n, q7, q8]) => `<div title="${fmtInt(q8)} of ${fmtInt(n)} tenders gave 7 days or less; ${fmtInt(q7)} under 7 days">
        <span>${MONTHS[m - 1]}</span><i style="height:${n ? Math.round(q8 / n / maxShare * 100) : 0}%"></i><b>${q7 || ''}</b></div>`).join('')}</div>
      <p class="note">Bar: share of tenders with 7 days or less. Number: tenders under 7 days.</p>
      <h4>Offices that use short deadlines most${district ? ` in ${esc(district)}` : ''}</h4>
      ${offices.length ? `<div class="table-wrap"><table class="lead"><thead><tr><th>Office</th><th class="n">Under 7 days</th><th class="n">7 days or less</th><th class="n">All tenders</th><th class="n">Bidders (short / all)</th><th>Short tenders usually won by</th></tr></thead>
        <tbody>${offices.slice(0, 60).map((o, i) => `<tr${i >= 15 ? ' class="more-row" hidden' : ''}><td>${esc(o[0])}<small class="who">${esc([o[1], o[2]].filter(Boolean).join(' · '))}</small></td><td class="n"><b>${fmtInt(o[5])}</b></td><td class="n">${fmtInt(o[4])}</td><td class="n">${fmtInt(o[3])}</td><td class="n">${o[7]} / ${o[6]}</td><td><small>${winnersHtml(o[8])}</small></td></tr>`).join('')}</tbody></table></div>${offices.length > 15 ? `<button class="btn ghost q-more" type="button">Show ${Math.min(offices.length, 60)} offices</button>` : ''}` : '<p class="muted-p">No office here used short deadlines more than once.</p>'}
      <h4>Tenders with less than 7 days to bid <span class="count">${fmtInt(quick.length)}</span></h4>
      ${quick.length ? `<div class="table-wrap"><table class="lead"><thead><tr><th>Closed</th><th class="n">Days</th><th>Work</th><th>Winner</th><th class="n">Bidders</th><th class="n">Winning bid</th></tr></thead>
        <tbody>${quick.slice(0, 300).map((x, i) => `<tr${i >= 20 ? ' class="more-row" hidden' : ''}><td><small>${esc(x[1])}</small></td><td class="n">${x[2]}</td>
          <td><button type="button" class="linkish item-name" data-bids="${esc(x[0])}" data-month="${esc(String(x[1]).slice(0, 7))}">${esc(x[6])}</button><small>${esc([x[3], x[4]].filter(Boolean).join(' · '))}</small></td>
          <td>${x[8] ? `<button type="button" class="linkish" data-contractor="${esc(x[8])}">${esc(splitName(x[8]).firm)}</button>` : '—'}</td><td class="n">${x[9]}</td><td class="n">${x[10] !== null ? esc(pctText(x[10])) : '—'}</td></tr>`).join('')}</tbody></table></div>${quick.length > 20 ? `<button class="btn ghost q-more" type="button">Show all ${fmtInt(Math.min(quick.length, 300))}</button>` : ''}` : ''}`;
    box.querySelectorAll('.q-more').forEach((btn) => btn.addEventListener('click', () => {
      btn.previousElementSibling.querySelectorAll('.more-row').forEach((row) => { row.hidden = false; });
      btn.remove();
    }));
  }

  // Excel downloads of every awarded works tender since 2023 (collect_history.py).
  let downloadsLoaded = false;
  async function loadDownloads() {
    if (downloadsLoaded) return;
    downloadsLoaded = true;
    const box = $('rDownloads');
    let idx;
    try {
      const r = await fetch('/history-index.json');
      idx = r.ok ? await r.json() : null;
    } catch { idx = null; }
    if (!idx?.files?.length) {
      box.innerHTML = '<h3>Download all past works results (Excel)</h3><p class="muted-p">All awarded works tenders since May 2023 are being collected. The Excel files will appear here in a few hours.</p>';
      downloadsLoaded = false;
      return;
    }
    const mb = (b) => `${(b / 1048576).toFixed(b > 10485760 ? 0 : 1)} MB`;
    const years = idx.files.filter((f) => f.year);
    const rates = idx.files.find((f) => f.file === 'works-item-rates.xlsx');
    const bidderDb = idx.files.find((f) => f.file === 'works-bidders.xlsx');
    if (bidderDb) $('bDownload').innerHTML = `<a class="btn" href="/downloads/${esc(bidderDb.file)}" download>${dlIcon} Bidder database (Excel, ${mb(bidderDb.bytes)})</a>`;
    box.innerHTML = `<h3>Download all past works results (Excel) <span class="count">${fmtInt(idx.tenders)} tenders</span></h3>
      <p class="muted-p">Every awarded works tender${idx.from ? ` from ${esc(shortDate.format(new Date(idx.from)))} ${esc(idx.from.slice(0, 4))}` : ''} with the winner and every bidder's amount.${idx.complete ? '' : ' <b>Still collecting older tenders</b> — the files grow every few hours.'}</p>
      <div class="dl-list">
        ${years.map((f) => `<a class="dl" href="/downloads/${esc(f.file)}" download><b>${esc(f.year)}</b><span>${fmtInt(f.tenders)} tenders · ${fmtInt(f.bids)} bids</span><small>${mb(f.bytes)}</small></a>`).join('')}
        ${rates ? `<a class="dl rates" href="/downloads/${esc(rates.file)}" download><b>Item rates</b><span>${fmtInt(rates.items)} BOQ items · past winning rates</span><small>${mb(rates.bytes)}</small></a>` : ''}
        ${bidderDb ? `<a class="dl rates" href="/downloads/${esc(bidderDb.file)}" download><b>Bidder database</b><span>${fmtInt(bidderDb.bidders)} bidders · bids &amp; wins by year, district, department, type of work</span><small>${mb(bidderDb.bytes)}</small></a>` : ''}
      </div>
      <p class="note">Each year file has two sheets: <b>Tenders</b> (one row per tender) and <b>All bids</b> (one row per bidder). New tenders are compared with this full history on their tender page.</p>`;
    const iw = $('iwDownloads');
    iw.innerHTML = (idx.itemwise || []).length ? `<h3>Item-wise bids — every bidder's rate for every item <span class="count">${fmtInt(idx.itemwise.length)} months</span></h3>
        <p class="muted-p">One Excel file per month: each BOQ item of each tender with the department's rate and the L1 (winner) to L5 bidders' names, quoted rates and % against the department's rate.</p>
        ${Object.entries(idx.itemwise.reduce((acc, f) => { (acc[f.month.slice(0, 4)] ||= []).push(f); return acc; }, {})).sort((a, b) => b[0].localeCompare(a[0])).map(([year, files]) => `
          <details class="iw-year"${year === String(new Date().getFullYear()) ? ' open' : ''}><summary><b>${esc(year)}</b> <span class="count">${files.length} months</span></summary>
            <div class="dl-list">${files.sort((a, b) => b.month.localeCompare(a.month)).map((f) => `<a class="dl" href="/downloads/${esc(f.file)}" download><b>${esc(new Date(f.month + '-01T00:00:00').toLocaleString('en-IN', { month: 'long' }))}</b><span>${fmtInt(f.tenders)} tenders · ${fmtInt(f.rows)} items</span><small>${mb(f.bytes)}</small></a>`).join('')}</div>
          </details>`).join('')}`
      : `<h3>Item-wise bids — every bidder's rate for every item</h3><p class="muted-p">The monthly Excel files are being rebuilt and will appear here after tonight's history update.</p>`;
  }

  function filterResults(f) {
    return (R.all || []).filter((r) => (!f.cat || r.cat === f.cat) && (!f.district || r.district === f.district)
      && (!f.dept || r.dept === f.dept) && (!f.work || r.work === f.work)
      && queryMatch(r, f.q));
  }

  function summarize(list) {
    const pcts = list.map(winPct).filter((p) => p !== null);
    const withBids = list.filter((r) => r.bidders?.length);
    const wins = new Map();
    for (const r of list) if (r.winner) wins.set(r.winner, (wins.get(r.winner) || 0) + 1);
    return {
      count: list.length,
      median: median(pcts),
      bidders: withBids.length ? withBids.reduce((n, r) => n + r.bidders.length, 0) / withBids.length : null,
      top: [...wins.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
    };
  }

  function applyResults({ keepPage = false } = {}) {
    if (!R.all) return;
    const keep = keepPage ? Math.max(R.shown, PAGE) : 0;
    const f = { q: R.q, cat: $('rCat').value, district: $('rDistrict').value, dept: $('rDept').value, work: $('rWork').value };
    const period = Number($('rPeriod').value) || 0;
    const [vMin, vMax] = ($('rValue').value || '-').split('-').map((x) => (x === '' ? null : Number(x)));
    const minBidders = $('rBidderCount').value;
    const since = period ? Date.now() - period * 30.4 * DAY : 0;
    const list = filterResults(f).filter((r) => (!R.savedOnly || R.saved.has(r.nit))
      && (!since || r._award >= since)
      && (vMin === null || (num(r.value) || 0) >= vMin) && (vMax === null || (num(r.value) || 0) < vMax)
      && (!minBidders || (minBidders === '1' ? r.bidders?.length === 1 : (r.bidders?.length || 0) >= Number(minBidders))));
    $('rSavedCount').textContent = R.saved.size;
    $('rSavedBtn').setAttribute('aria-pressed', String(R.savedOnly));
    $('rSavedBtn').classList.toggle('on', R.savedOnly);
    const sort = $('rSort').value;
    const by = {
      new: (a, b) => b._award - a._award,
      discount: (a, b) => (winPct(a) ?? 999) - (winPct(b) ?? 999),
      value: (a, b) => (num(b.value) || 0) - (num(a.value) || 0),
      bidders: (a, b) => (b.bidders?.length || 0) - (a.bidders?.length || 0)
    }[sort];
    list.sort(by);
    R.filtered = list;
    R.shown = 0;
    const sum = summarize(list);
    $('rCount').textContent = fmtInt(sum.count);
    $('rMedian').textContent = sum.median === null ? '—' : `${Math.abs(sum.median).toFixed(1)}% ${sum.median <= 0 ? 'below' : 'above'}`;
    $('rBidders').textContent = sum.bidders === null ? '—' : sum.bidders.toFixed(1);
    $('rWinners').innerHTML = sum.top.length ? sum.top.map(([n, c]) => `<li><button type="button" data-win="${esc(n)}">${esc(n)}</button><b>${c}</b></li>`).join('') : '<li>—</li>';
    $('rTitle').innerHTML = `${fmtInt(list.length)} <span>awarded works tenders</span>`;
    const people = new Map();
    if (R.q && norm(R.q).trim().length >= 3) {
      for (const r of list) for (const n of matchedBidders(r, R.q)) { const k = nameKey(n); const v = people.get(k) || { name: n, n: 0 }; v.n++; people.set(k, v); }
    }
    const chips = [...people.values()].sort((a, b) => b.n - a.n).slice(0, 8);
    $('rPeople').hidden = !chips.length;
    $('rPeople').innerHTML = chips.length ? `<span>Contractors matching “${esc(R.q.trim())}”:</span>${chips.map((c) => `<button type="button" class="chip" data-win="${esc(c.name)}">${esc(splitName(c.name).firm)} <b>${c.n}</b></button>`).join('')}` : '';
    for (const id of ['rCat', 'rDistrict', 'rDept', 'rWork', 'rPeriod', 'rValue', 'rBidderCount']) $(id).classList.toggle('set', Boolean($(id).value));
    $('rList').innerHTML = '';
    moreResults();
    while (R.shown < Math.min(keep, R.filtered.length)) moreResults();
  }

  // "NAME (1)( FIRM NAME )" → firm and person, the way KPPP writes bidders.
  function splitName(n) {
    const text = String(n || '').trim();
    const m = text.match(/^(.*?)\s*(?:\(\s*\d+\s*\)\s*)?\(\s*(.+?)\s*\)\s*$/);
    return m && m[1] && m[2] && !/^\d+$/.test(m[2]) ? { firm: m[2], person: m[1].replace(/\s*\(\s*\d+\s*\)\s*$/, '') } : { firm: text.replace(/\s*\(\s*\d+\s*\)\s*$/, ''), person: '' };
  }
  function bidderName(n) {
    const { firm, person } = splitName(n);
    return `${isWatched(n) ? '<span class="eye" title="You watch this contractor">👁</span> ' : ''}<button type="button" class="linkish" data-win="${esc(n)}">${esc(firm)}</button>${person ? `<small class="who">${esc(person)}</small>` : ''}`;
  }
  const signed = (p, digits = 2) => (p === null || p === undefined ? '' : `${p > 0 ? '+' : ''}${p.toFixed(digits)}%`);

  // Every bidder with the gap to the winning (L1) bid.
  function bidderTable(r) {
    const l1 = r.bidders.find((b) => b.rank === 1)?.amount || null;
    const goods = r.cat === 'GOODS';
    return `<div class="table-wrap"><table class="bids"><thead><tr><th>Rank</th><th>Bidder</th><th class="n">Quoted amount</th><th class="n">vs estimate</th><th class="n">Gap to L1</th>${goods ? '<th class="n">Items won</th>' : ''}</tr></thead><tbody>
      ${r.bidders.map((b) => {
        const gap = l1 && b.amount && b.rank !== 1 ? b.amount - l1 : null;
        return `<tr${b.rank === 1 ? ' class="l1"' : ''}><td>${b.rank ? 'L' + b.rank : '—'}</td><td>${bidderName(b.name)}</td>
          <td class="n">${b.amount ? money(b.amount, { full: true }) : '<small>Not all items</small>'}</td>
          <td class="n">${signed(b.pct)}</td>
          <td class="n">${gap !== null ? `${money(gap) || '₹0'}<small>${(gap / l1 * 100).toFixed(2)}% higher</small>` : (b.rank === 1 ? '<small>Winner</small>' : '')}</td>
          ${goods ? `<td class="n">${b.items || 0}</td>` : ''}</tr>`;
      }).join('')}
    </tbody></table></div>`;
  }

  function resultRow(r) {
    const hits = R.q ? matchedBidders(r, R.q).filter((n) => n !== r.winner) : [];
    const hitLine = hits.length ? `<div class="hit">Bid by ${hits.map((n) => { const b = r.bidders?.find((x) => x.name === n); return `<b>${esc(splitName(n).firm)}</b>${b?.rank ? ` (L${b.rank})` : ''}`; }).join(', ')}</div>` : '';
    const p = winPct(r);
    const tone = p === null ? '' : p <= -15 ? 'deep' : p < 0 ? 'below' : 'above';
    const when = r._award ? shortDate.format(new Date(r._award)) : '';
    return `<details class="rrow">
      <summary>
        <div class="rmain">
          <div class="card-top"><span class="badge ${esc(r.cat)}">${esc(r.cat)}</span>${r.work ? `<span class="badge soft">${esc(r.work)}</span>` : ''}${reserved.get(String(r.nit)) ? `<span class="badge reserved${reserved.get(String(r.nit)).split('/').includes(MY_CAT) ? ' mine' : ''}">${esc(resvLabel(reserved.get(String(r.nit))))}</span>` : ''}${quickBadge(bidDays(Date.parse(r.published), Date.parse(r.closed)))}${when ? `<span class="due">Awarded ${esc(when)}</span>` : ''}</div>
          <h3>${esc(r.title)}</h3>
          <div class="meta">${pinIcon}<span>${esc([r.district, r.dept].filter(Boolean).join(' · ') || r.office || '')}</span></div>
          ${hitLine}
        </div>
        <div class="rside">
          <button class="save rfav ${R.saved.has(r.nit) ? 'on' : ''}" type="button" data-rsave="${esc(r.nit)}" aria-pressed="${R.saved.has(r.nit)}" aria-label="Save this result">${heartIcon}</button>
          <span class="rlabel">Winner</span>
          <strong class="rwinner">${r.winner && isWatched(r.winner) ? '<span class="eye" title="You watch this contractor">👁</span> ' : ''}${esc(r.winner || 'Not published')}</strong>
          <div class="rstats">
            ${p !== null ? `<span class="pct ${tone}">${esc(pctText(p))}</span>` : ''}
            ${r.bidders?.length ? `<span class="badge soft">${r.bidders.length} bidder${r.bidders.length === 1 ? '' : 's'}</span>` : ''}
          </div>
        </div>
      </summary>
      <div class="rbody">
        <p class="ref">${esc(r.ref)}${num(r.value) ? ` · Estimate ${money(r.value, { full: true })}` : ''}${r.office ? ` · ${esc(r.office)}` : ''}</p>
        ${r.bidders?.length ? bidderTable(r) : '<p class="note">KPPP has not published the bid comparison for this tender.</p>'}
        ${noteOf('r:' + r.nit) ? `<p class="note-line">📝 ${esc(noteOf('r:' + r.nit))}</p>` : ''}
        <div class="row-actions"><button class="btn primary" type="button" data-award="${esc(r.nit)}">Full result · timeline &amp; item-wise rates</button>
          <button class="btn ${R.saved.has(r.nit) ? 'on' : ''}" type="button" data-rsave="${esc(r.nit)}" aria-pressed="${R.saved.has(r.nit)}">${heartIcon}${R.saved.has(r.nit) ? ' Saved' : ' Save'}</button>
          <button class="btn" type="button" data-rdl="xlsx" data-nit="${esc(r.nit)}">${dlIcon} Download Excel</button>
          <button class="btn" type="button" data-rdl="pdf" data-nit="${esc(r.nit)}">${dlIcon} Download PDF</button></div>
      </div>
    </details>`;
  }

  function moreResults() {
    if (!R.filtered.length) {
      $('rList').innerHTML = '<div class="empty"><strong>No results match.</strong>Try a different search or remove a filter.</div>';
      $('rMore').hidden = true;
      return;
    }
    const next = R.filtered.slice(R.shown, R.shown + PAGE);
    $('rList').insertAdjacentHTML('beforeend', next.map(resultRow).join(''));
    R.shown += next.length;
    const left = R.filtered.length - R.shown;
    $('rMore').hidden = left <= 0;
    $('rMore').textContent = `Show more (${fmtInt(left)} left)`;
  }

  // Past results for work like this tender: same department and type of work, else same type of work in the district.
  let similarLoading = null;
  function loadSimilar() {
    if (!similarLoading) similarLoading = fetch('/similar-lite.json').then((r) => (r.ok ? r.json() : null)).catch(() => null);
    return similarLoading;
  }

  async function similarResults(t) {
    // Whole works history (since 2023), grouped by department / district and type of work.
    const groups = t.cat === 'WORKS' ? await loadSimilar() : null;
    if (groups) {
      let g = groups[`d|${t.dept || ''}|${t.work || ''}`];
      let scope = `${t.work || 'this type of'} work in ${t.dept}`;
      const byDistrict = t.district ? groups[`x|${t.district}|${t.work || ''}`] : null;
      if ((!g || g.n < 5) && byDistrict && byDistrict.n > (g?.n || 0)) { g = byDistrict; scope = `${t.work || 'works'} work in ${t.district}`; }
      if (g) return { count: g.n, median: g.q[1], q: g.q, bidders: g.bidders, top: g.top, scope, history: true };
    }
    try { await loadResults(); } catch { return null; }
    let list = filterResults({ dept: t.dept, work: t.work, cat: t.cat });
    let scope = `${t.work || 'this type of'} work in ${t.dept}`;
    if (list.filter((r) => winPct(r) !== null).length < 5 && t.district) {
      list = filterResults({ district: t.district, work: t.work, cat: t.cat });
      scope = `${t.work || t.cat.toLowerCase()} work in ${t.district}`;
    }
    const sum = summarize(list);
    const pcts = list.map(winPct).filter((p) => p !== null).sort((a, b) => a - b);
    return sum.count ? { ...sum, scope, pcts } : null;
  }

  async function renderSimilar(t) {
    const box = $('tpSimilar');
    if (!box) return;
    const sim = await similarResults(t);
    if ($('tpSimilar') !== box) return;
    if (G.t === t) { G.sim = sim; updateBidGuide(); }
    if (!sim || sim.median === null) { box.hidden = true; return; }
    sim.top = (sim.top || []).filter(([n]) => /[a-z]{2}/i.test(n));
    box.hidden = false;
    box.innerHTML = `<h3>How similar tenders were won</h3>
      <p class="muted-p">Based on ${fmtInt(sim.count)} awarded tenders${sim.history ? ' since 2023' : ''} for ${esc(sim.scope)}.</p>
      <div class="kpis" style="margin-top:12px">
        <div class="kpi"><span>Typical winning bid</span><strong>${Math.abs(sim.median).toFixed(1)}% ${sim.median <= 0 ? 'below' : 'above'}</strong><small>the estimate (median L1)</small></div>
        <div class="kpi"><span>Average bidders</span><strong>${sim.bidders === null ? '—' : sim.bidders.toFixed(1)}</strong><small>per tender</small></div>
        <div class="kpi"><span>Most wins</span><strong style="font-size:14px">${sim.top[0] ? `<button type="button" class="linkish" data-contractor="${esc(sim.top[0][0])}">${esc(splitName(sim.top[0][0]).firm)}</button>` : '—'}</strong><small>${sim.top[0] ? `${sim.top[0][1]} tenders` : ''}</small></div>
      </div>
      ${sim.top.length ? `<div class="usual"><span>Who usually wins here:</span>${sim.top.filter(([n]) => /[a-z]{2}/i.test(n)).slice(0, 3).map(([n, c]) => `<button type="button" class="chip${isWatched(n) ? ' watched' : ''}" data-contractor="${esc(n)}">${isWatched(n) ? '👁 ' : ''}${esc(splitName(n).firm)} <b>${c}</b></button>`).join('')}</div>` : ''}
      ${num(t.value) ? `<p class="note">At that rate the winning bid for this tender would be about <b>${money(t.value * (1 + sim.median / 100), { full: true })}</b>.</p>` : ''}
      <button class="btn" type="button" id="seeSimilar">See these results</button>`;
    $('seeSimilar').addEventListener('click', () => {
      closeDrawer();
      setMode('results');
      loadResults().then(() => {
        $('rCat').value = t.cat; $('rWork').value = t.work || '';
        $('rDept').value = sim.scope.includes(t.dept) ? t.dept : '';
        $('rDistrict').value = sim.scope.includes(t.dept) ? '' : (t.district || '');
        applyResults();
        window.scrollTo({ top: $('resultsView').offsetTop - 10 });
      });
    });
  }

  // ---------- Award page: timeline, officers and every bidder's item rates ----------
  const awardCache = new Map();
  function daysBetween(a, b) {
    const d = (Date.parse(b) - Date.parse(a)) / DAY;
    return Number.isFinite(d) ? Math.round(d) : null;
  }

  async function openAward(nit, extra = null) {
    try { await loadResults(); } catch {}
    const r = R.byNit?.get(String(nit)) || extra?.r;
    if (!r) { toast('This result is not in our records yet'); return; }
    lastFocus = document.activeElement;
    const p = winPct(r);
    const l1 = r.bidders?.find((b) => b.rank === 1);
    const l2 = r.bidders?.find((b) => b.rank === 2);
    const w = splitName(r.winner);
    const place = [r.office, r.district].filter(Boolean).join(' · ');
    const d = $('drawer');
    d.innerHTML = `
      <div class="tp-bar"><div class="wrap tp-bar-in">
        <button class="btn ghost" type="button" data-close>${icon.back} Back to results</button>
        <span class="spacer"></span>
        <button class="btn" type="button" data-rdl="xlsx" data-nit="${esc(r.nit)}">${dlIcon} Excel</button>
        <button class="btn" type="button" data-rdl="pdf" data-nit="${esc(r.nit)}">${dlIcon} PDF</button>
        <button class="btn ${R.saved.has(r.nit) ? 'on' : ''}" type="button" data-rsave="${esc(r.nit)}" aria-pressed="${R.saved.has(r.nit)}">${heartIcon}${R.saved.has(r.nit) ? ' Saved' : ' Save'}</button>
      </div></div>
      <header class="tp-hero"><div class="wrap">
        <div class="row"><span class="badge ${esc(r.cat)}">${esc(r.cat)}</span><span class="badge soft">Awarded${r._award ? ' ' + esc(shortDate.format(new Date(r._award))) : ''}</span>${r.work ? `<span class="badge soft">${esc(r.work)}</span>` : ''}</div>
        <h2 id="dTitle">${esc(r.title)}</h2>
        <p class="tp-sub">${esc(r.dept || '')}${place ? ` · ${esc(place)}` : ''}</p>
        <p class="ref">${esc(r.ref)}</p>
      </div></header>
      <div class="wrap cp">
        <div class="cp-kpis two">
          <div class="kpi sanction"><span>Sanctioned amount</span><strong id="kSanction">…</strong><small id="kSanctionNote">Loading from the tender…</small></div>
          <div class="kpi"><span>Tender value (estimate)</span><strong>${num(r.value) ? money(r.value, { full: true }) : '—'}</strong><small>What bidders quote against</small></div>
        </div>
        <div class="cp-kpis">
          <div class="kpi"><span>Winner</span><strong class="win-name">${r.winner ? `<button type="button" class="linkish" data-contractor="${esc(r.winner)}">${esc(w.firm)}</button>` : 'Not published'}</strong><small>${esc(w.person)}</small></div>
          <div class="kpi"><span>Winning bid</span><strong>${l1?.amount ? money(l1.amount) : '—'}</strong><small>${p !== null ? esc(pctText(p)) : (num(r.value) ? `Estimate ${money(r.value)}` : '')}</small></div>
          <div class="kpi"><span>Bidders</span><strong>${r.bidders?.length || '—'}</strong><small>${num(r.value) ? `Estimate ${money(r.value, { full: true })}` : ''}</small></div>
          <div class="kpi"><span>Won by</span><strong>${l1?.amount && l2?.amount ? money(l2.amount - l1.amount) || '₹0' : '—'}</strong><small>${l1?.amount && l2?.amount ? `${((l2.amount - l1.amount) / l2.amount * 100).toFixed(2)}% less than L2` : 'gap to the second bidder'}</small></div>
        </div>
        ${r.bidders?.length ? `<section class="panel"><h3>All bids <span class="count">${r.bidders.length}</span></h3>${bidderTable(r)}</section>` : ''}
        ${notePanel('r:' + r.nit)}
        <div id="awardMore"><section class="panel"><h3>Loading timeline and item-wise rates…</h3><div class="skeleton line"></div><div class="skeleton line short"></div></section></div>
        <div id="awardTender"><section class="panel"><h3>Loading tender conditions from KPPP…</h3><div class="skeleton line"></div><div class="skeleton line short"></div></section></div>
      </div>`;
    d.setAttribute('aria-hidden', 'false');
    d.classList.add('open');
    document.body.style.overflow = 'hidden';
    d.scrollTop = 0;
    d.querySelector('[data-close]').focus();
    bindNote(d);
    const hash = '#a=' + encodeURIComponent(r.nit);
    if (location.hash !== hash) history.pushState({ award: r.nit }, '', hash);

    loadPastTender(r);
    const box = $('awardMore');
    try {
      if (extra?.a) awardCache.set(r.nit, Promise.resolve(extra.a));
      if (!awardCache.has(r.nit)) {
        awardCache.set(r.nit, fetch(`/api/award/${encodeURIComponent(r.nit)}`).then((x) => (x.ok ? x.json() : Promise.reject(new Error(`HTTP ${x.status}`)))));
      }
      const a = await awardCache.get(r.nit);
      if ($('awardMore') !== box) return;
      box.innerHTML = awardDetailsHtml(r, a);
      box.querySelectorAll('.show-rows').forEach((b) => b.addEventListener('click', () => {
        box.querySelectorAll('.more-row').forEach((row) => { row.hidden = false; });
        b.remove();
      }));
    } catch {
      awardCache.delete(r.nit);
      if ($('awardMore') === box) box.innerHTML = '<section class="panel"><h3>Timeline and item-wise rates</h3><p class="muted-p">These details are still being collected for this tender. Please check again in a few hours.</p></section>';
    }
  }

  // A past tender's conditions (EMD, fee, eligibility, documents, contact), asked from KPPP when the page opens.
  function showSanction(value, note) {
    if ($('kSanction')) { $('kSanction').innerHTML = value; $('kSanctionNote').textContent = note; }
  }
  async function loadPastTender(r) {
    const box = $('awardTender');
    const key = `${r.cat || 'WORKS'}/${r.nit}`;
    try {
      if (!detailCache.has(key)) {
        detailCache.set(key, fetch(`/api/tender/${key}`).then((x) => x.json().catch(() => ({ success: false }))).then((j) => (j.success ? j : Promise.reject(new Error(j.message || 'n/a')))));
      }
      const f = await detailCache.get(key);
      if ($('awardTender') !== box) return;
      showSanction(num(f.money?.provisional) ? money(f.money.provisional, { full: true }) : 'Not published', 'Total approved for the work (incl. GST, contingencies)');
      box.innerHTML = pastTenderHtml(r, f);
    } catch {
      detailCache.delete(key);
      if ($('awardTender') !== box) return;
      showSanction('—', 'KPPP did not send it right now — tap “Try again” below');
      box.innerHTML = `<section class="panel"><h3>Tender conditions</h3><p class="muted-p">KPPP didn't send this old tender's conditions (EMD, eligibility, documents) right now. It may no longer keep them for closed tenders.</p>
        <button class="btn" type="button" id="retryPast">Try again</button></section>`;
      $('retryPast')?.addEventListener('click', () => { box.innerHTML = '<section class="panel"><h3>Loading tender conditions from KPPP…</h3><div class="skeleton line"></div></section>'; loadPastTender(r); });
    }
  }

  function pastTenderHtml(r, f) {
    const m = f.money || {}; const tm = f.terms || {}; const c = f.contact || {};
    const emd = num(m.emd) ? money(m.emd, { full: true }) + (m.emdCash && m.emdGuarantee ? `<small class="fact-note">${money(m.emdCash)} cash + ${money(m.emdGuarantee)} bank guarantee</small>` : '') : '';
    const facts = [
      ['Department', esc(r.dept || '')],
      ['Office', esc(r.office || '')],
      ['EMD', emd],
      ['Tender fee', num(m.fee) ? money(m.fee, { full: true }) : ''],
      ['Sanctioned budget', num(m.provisional) ? money(m.provisional, { full: true }) : ''],
      ['Published', esc(fmtKppp(f.dates?.published) || '')],
      ['Bid submission ended', esc(fmtKppp(f.dates?.submission) || '')],
      ['Bids opened', esc(fmtKppp(f.dates?.opening) || '')],
      ['Work description', f.description && f.description !== r.title ? esc(f.description) : ''],
      ['Evaluation', esc(tm.evaluation || '')],
      ['Bid type', esc(tm.bidType || '')],
      ['Tax', tm.tax ? esc(tm.tax[0].toUpperCase() + tm.tax.slice(1)) : ''],
      ['Bid validity', tm.validityDays ? `${tm.validityDays} days` : ''],
      ['Call', tm.call ? `Call ${tm.call}${tm.retender ? ' (re-tender)' : ''}` : ''],
      ['File number', esc(f.fileNumber || '')],
      ['Officer', esc(c.person || '')],
      ['Mobile', c.mobile ? `<a href="tel:${esc(c.mobile)}">${esc(c.mobile)}</a>` : ''],
      ['Address', esc(c.address || '')]
    ].filter(([, v]) => v);
    const elig = f.eligibility?.length ? `<section class="panel"><h3>Who was eligible <span class="count">${f.eligibility.length}</span></h3><ol class="rules">${f.eligibility.map((x) => `<li>${esc(x)}</li>`).join('')}</ol></section>` : '';
    const tech = f.technical?.length ? `<section class="panel"><h3>Technical qualification <span class="count">${f.technical.length}</span></h3><div class="quals">${f.technical.map((q) => `<div class="qual">
        <div class="qual-top">${q.category ? `<span class="badge soft">${esc(q.category)}</span>` : ''}${q.weight ? `<span class="badge soft">${q.weight} marks</span>` : ''}</div>
        <p>${esc(q.text)}</p>${q.documents?.length ? `<small>Proof: ${q.documents.map(esc).join(', ')}</small>` : ''}</div>`).join('')}</div></section>` : '';
    const docs = f.documents?.length ? `<section class="panel"><h3>Documents required with the bid <span class="count">${f.documents.length}</span></h3>
      <ul class="checklist">${f.documents.map((x) => `<li>${icon.check}<span>${esc(x.name)}${x.cover ? `<small>${esc(x.cover)}${x.optional ? '' : ' · mandatory'}</small>` : ''}</span></li>`).join('')}</ul></section>` : '';
    return `<section class="panel"><h3>Tender conditions</h3><dl class="facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
      ${f.partial ? '<p class="note">KPPP was slow, so this shows the main details only. Open the tender again in a minute for eligibility and documents.</p>' : ''}</section>
      <div class="past-cols">${elig}${docs}</div>${tech}`;
  }

  function awardDetailsHtml(r, a) {
    const t = a.timeline || {};
    const steps = [
      ['Published', t.published],
      ['Bids closed', t.closed || r.closed],
      ['Technical bids opened', t.techOpened],
      ['Technical evaluation approved', t.techApproved],
      ['Price bids opened', t.finOpened],
      ['Price evaluation approved', t.finApproved],
      ['Winner gave performance guarantee', t.pbg],
      ['Work awarded', t.awarded || r.awarded]
    ].filter(([, v]) => v && Number.isFinite(Date.parse(v)));
    const closedToAward = daysBetween(t.closed || r.closed, t.awarded || r.awarded);
    const timeline = steps.length ? `<section class="panel"><h3>Timeline${closedToAward !== null ? ` <span class="count">${closedToAward} days from closing to award</span>` : ''}</h3>
      <ol class="timeline">${steps.map(([label, v], i) => {
        const gap = i ? daysBetween(steps[i - 1][1], v) : null;
        return `<li><b>${esc(label)}</b><span>${esc(dateFmt.format(new Date(v)))}${gap ? ` · <em>${gap} day${gap === 1 ? '' : 's'} later</em>` : ''}</span></li>`;
      }).join('')}</ol></section>` : '';

    const pp = a.people || {};
    const people = [
      ['Published by', pp.publishedBy], ['Price bids opened by', pp.opener], ['Result approved by', pp.approver],
      ['Technical approval by', pp.techApprover !== pp.approver ? pp.techApprover : ''], ['Contact', [pp.contact, pp.mobile].filter(Boolean).join(' · ')]
    ].filter(([, v]) => v);
    const facts = [
      ['EMD', num(a.emd) ? money(a.emd, { full: true }) : ''], ['Tender fee', num(a.fee) ? money(a.fee, { full: true }) : ''],
      ['Evaluation', a.evaluation], ['Bid type', a.bidType], ['Call', a.call ? `Call ${a.call}` : '']
    ].filter(([, v]) => v);
    const officers = people.length || facts.length ? `<section class="panel"><h3>Officers &amp; terms</h3><dl class="facts">
      ${[...people, ...facts].map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
      ${a.description && a.description !== r.title ? `<p class="muted-p" style="margin-top:12px">${esc(a.description)}</p>` : ''}</section>` : '';

    const items = a.items || [];
    const bidders = a.bidders?.length ? a.bidders : (r.bidders || []);
    let itemsHtml = '';
    if (items.length && bidders.length) {
      const cols = bidders.slice(0, 6);
      const head = cols.map((b) => `<th class="n">${b.rank ? `L${b.rank} · ` : ''}${esc(splitName(b.name).firm)}</th>`).join('');
      itemsHtml = `<section class="panel"><h3>Item-wise rates of every bidder <span class="count">${fmtInt(items.length)} items</span></h3>
        <p class="note" style="margin:0 0 10px">Rate quoted per unit. Green is the lowest rate for that item; % is against the department's rate.</p>
        <div class="table-wrap"><table class="irates"><thead><tr><th>Item</th><th class="n">Qty</th><th class="n">Dept. rate</th>${head}</tr></thead><tbody>
        ${items.map((i, n) => {
          const rates = cols.map((_, k) => i.rates?.[k]);
          const low = Math.min(...rates.filter((x) => typeof x === 'number' && x > 0));
          return `<tr${n >= 15 ? ' class="more-row" hidden' : ''}><td><div class="item-name">${esc(i.name)}</div><small>${esc([i.code, i.unit].filter(Boolean).join(' · '))}${i.winner ? ` · supplied by ${esc(splitName(i.winner).firm)}` : ''}</small></td>
            <td class="n">${i.qty ?? ''}</td><td class="n">${i.est ? money(i.est, { full: true }) : ''}</td>
            ${rates.map((x) => `<td class="n${x === low ? ' low' : ''}">${typeof x === 'number' ? money(x, { full: true }) || '₹0' : '—'}${typeof x === 'number' && i.est ? `<small>${signed((x / i.est - 1) * 100, 1)}</small>` : ''}</td>`).join('')}
          </tr>`;
        }).join('')}</tbody></table></div>
        ${items.length > 15 ? `<button class="btn ghost show-rows" type="button">Show all ${fmtInt(items.length)} items</button>` : ''}
        ${bidders.length > cols.length ? `<p class="note">Showing the first ${cols.length} bidders.</p>` : ''}</section>`;
    } else if (r.cat === 'WORKS' || r.cat === 'GOODS') {
      itemsHtml = '<section class="panel"><h3>Item-wise rates</h3><p class="muted-p">KPPP has not published item-wise rates for this tender.</p></section>';
    }
    return `<div class="cp-grid">${timeline}${officers}</div>${itemsHtml}`;
  }

  // ---------- Item-wise past rates ----------
  // Same matching key as item_key() in collect_results.py: schedule code + unit + first 10 words.
  function itemKey(code, name, unit) {
    let c = String(code || '').toLowerCase().replace(/\s+/g, '');
    if (/^(code|itemno\.?|item|sl\.?no\.?)?\d*$/.test(c)) c = '';
    const n = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).slice(0, 10).join(' ');
    const u = String(unit || '').toLowerCase().replace(/\s+/g, '');
    return `${c}|${u}|${n}`;
  }

  let ratesLoading = null;
  function loadRates() {
    if (!ratesLoading) {
      ratesLoading = fetch('/rates-lite.json', { cache: 'no-cache' })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .catch((err) => { ratesLoading = null; throw err; });
    }
    return ratesLoading;
  }

  async function annotateRates(t, f) {
    // Stored tenders come with past rates from the whole works history; others use the recent library.
    let lib = f.past || null;
    if (!lib) { try { lib = (await loadRates()).items || {}; } catch { return; } }
    const box = $('boqPricing');
    if (!box) return;
    let matched = 0, total = 0, estMatched = 0, pastMatched = 0, estAll = 0;
    f.groups.forEach((g, gi) => g.items.forEach((i, ii) => {
      total++;
      const est = num(i.rate) ? i.rate * (i.qty || 0) : 0;
      estAll += est;
      const hit = lib[itemKey(i.code, i.name, i.unit)];
      const cell = document.querySelector(`[data-past="${gi}:${ii}"]`);
      if (!hit || !cell) return;
      matched++;
      if (G.f === f) G.past.set(`${gi}:${ii}`, hit.l1[2]);
      // Middle half of winning rates: some bidders quote ₹1 on a few items, so skip the extremes.
      const [, lo, med, hi] = hit.l1;
      const vsDept = num(i.rate) ? (med / i.rate - 1) * 100 : null;
      cell.innerHTML = `<small class="past ${vsDept !== null && vsDept < 0 ? 'lower' : ''}" title="What winning (L1) bidders quoted for this item in ${hit.tenders} past KPPP tenders">
        Past winners usually ${lo === hi ? money(lo, { full: true }) : `${money(lo, { full: true })}–${money(hi, { full: true })}`}
        · median ${money(med, { full: true })}${vsDept !== null ? ` (${vsDept > 0 ? '+' : ''}${vsDept.toFixed(1)}%)` : ''} · ${hit.tenders} tender${hit.tenders === 1 ? '' : 's'}</small>`;
      if (est) { estMatched += est; pastMatched += (i.qty || 0) * med; }
    }));
    if (!matched) {
      box.innerHTML = '<p class="note">No past winning rates found yet for these items. The rates library grows every few hours as more results are collected.</p>';
      return;
    }
    const ratio = estMatched ? pastMatched / estMatched : null;
    const cover = estAll ? estMatched / estAll * 100 : 0;
    if (G.f === f) { G.ratio = ratio; G.cover = cover; updateBidGuide(); G.recalc?.(); }
    box.innerHTML = `<div class="pricing">
      <div><span>Items with past winning rates</span><strong>${fmtInt(matched)} of ${fmtInt(total)}</strong><small>${cover.toFixed(0)}% of the work by value</small></div>
      ${ratio ? `<div><span>Past winners priced these items at</span><strong>${Math.abs((ratio - 1) * 100).toFixed(1)}% ${ratio < 1 ? 'below' : 'above'}</strong><small>the department's rates (median L1 rates)</small></div>` : ''}
      ${ratio && num(t.value) ? `<div class="hl"><span>Competitive bid from real rates</span><strong>${money(t.value * ratio, { full: true })}</strong><small>if the rest of the work is priced the same way</small></div>` : ''}
    </div>`;
  }

  // ---------- Contractor profile ----------
  // KPPP writes the same bidder slightly differently across tenders ("NAME (1)( FIRM )", extra spaces).
  const nameKey = (n) => String(n || '').toUpperCase().replace(/\(\s*\d+\s*\)/g, ' ').replace(/[^A-Z0-9()]+/g, ' ').replace(/\s+/g, ' ').trim();

  function countBy(list, key) {
    const m = new Map();
    for (const r of list) if (r[key]) m.set(r[key], (m.get(r[key]) || 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }

  function bars(title, entries, total) {
    if (!entries.length) return '';
    return `<section class="panel"><h3>${title}</h3><div class="bars">${entries.slice(0, 8).map(([k, n]) => `
      <div class="bar"><span>${esc(k)}</span><i style="--w:${Math.max(4, Math.round(n / total * 100))}%"></i><b>${fmtInt(n)}</b></div>`).join('')}</div></section>`;
  }

  // A past tender from the whole history: every bidder and their item-wise rates.
  async function openTenderBids(nit, month) {
    if (R.byNit?.has(String(nit))) { openAward(nit); return; }
    const row = cpRows.find((x) => String(x.r.nit) === String(nit));
    let j = null;
    try { const res = await fetch(`/api/tender-bids/${encodeURIComponent(nit)}?m=${encodeURIComponent(month)}`); j = res.ok ? await res.json() : null; } catch {}
    if (!j?.success) { toast('Bids for this tender are not available yet'); return; }
    const bidders = j.bidders.map(([name, amount, rank, pct]) => ({ name, amount, rank, pct })).sort((a, b) => (a.rank || 99) - (b.rank || 99));
    let base = row?.r;
    if (!base && quickData) {
      const x = (await quickData.catch(() => null))?.quick.find((q) => String(q[0]) === String(nit));
      if (x) base = { title: x[6], closed: x[1], office: x[3], district: x[4], dept: x[5], value: x[7], winner: x[8] };
    }
    base = base || {};
    const r = { nit: String(nit), ref: base.ref, title: base.title || base.ref || 'Tender', district: base.district, dept: base.dept, office: base.office,
      value: base.value, closed: base.closed, winner: bidders[0]?.name || base.winner, bidders, cat: 'WORKS', _award: Date.parse(base.closed) || 0 };
    const a = { bidders, items: j.items.map(([code, name, unit, qty, est, rates]) => ({ code, name, unit, qty, est, rates })) };
    openAward(nit, { r, a });
  }

  let cpRows = [];
  async function openContractor(name) {
    // Whole works history since 2023 (collect_history.py), plus the recent results loaded here.
    const histReq = fetch(`/api/contractor?name=${encodeURIComponent(name)}`)
      .then((r) => (r.ok ? r.json() : null)).then((j) => (j?.success ? j : null)).catch(() => null);
    try { await loadResults(); } catch {}
    const key = nameKey(name);
    const rows = [];
    for (const r of R.all || []) {
      const mine = (r.bidders || []).find((b) => nameKey(b.name) === key);
      const won = nameKey(r.winner) === key || mine?.rank === 1;
      if (mine || won) rows.push({ r, mine, won, date: r._award || Date.parse(r.closed) || 0 });
    }
    const H = await Promise.race([histReq, new Promise((res) => setTimeout(() => res(null), 7000))]);
    if (!rows.length && !H) { toast('No results found for this contractor'); return; }
    // Older tenders from the history that are not in the recent list.
    const seen = new Set(rows.map((x) => x.r.nit));
    // History rows: [nit, closed, ref, title, district, dept, value, rank, amount, pct, winner-if-not-them, bidders]
    for (const t of H?.tenders || []) {
      const [nit, closed, ref, title, district, dept, value, rank, amount, pct, winner, count] = t;
      if (seen.has(nit)) continue;
      rows.push({ r: { nit, ref, title, district, dept, value, winner, closed, count },
        mine: amount || rank ? { amount, rank, pct } : null, won: !winner, date: Date.parse(closed) || 0, old: true });
    }
    rows.sort((a, b) => b.date - a.date);
    const display = H?.name || rows.find((x) => x.mine?.name)?.mine.name || rows[0]?.r.winner || name;
    const who = splitName(display);

    // Recent-only figures, used when the history is not available yet.
    const recent = rows.filter((x) => !x.old);
    const wins = recent.filter((x) => x.won);
    const withBids = recent.filter((x) => x.mine);
    const pcts = (list) => list.map((x) => x.mine?.pct).filter((p) => p !== null && p !== undefined);
    const stats = H ? {
      bids: H.bids, wins: H.wins, value: H.value, winPct: H.winPct, bidPct: H.bidPct,
      districts: H.districts, depts: H.depts, works: H.works,
      rivals: (H.rivals || []).map(([n, met, ahead]) => ({ name: n, met, ahead })), scope: 'from all works results since 2023'
    } : {
      bids: withBids.length, wins: wins.length,
      value: wins.reduce((n, x) => n + (num(x.mine?.amount) || num(x.r.value) || 0), 0),
      winPct: median(pcts(wins)), bidPct: median(pcts(withBids)),
      districts: countBy(recent.map((x) => x.r), 'district'), depts: countBy(recent.map((x) => x.r), 'dept'), works: countBy(recent.map((x) => x.r), 'work'),
      rivals: (() => {
        const m = new Map();
        for (const x of withBids) for (const b of x.r.bidders || []) {
          const k = nameKey(b.name); if (k === key) continue;
          const v = m.get(k) || { name: b.name, met: 0, ahead: 0 }; v.met++; if (b.rank && x.mine.rank && x.mine.rank < b.rank) v.ahead++; m.set(k, v);
        }
        return [...m.values()].sort((a, b) => b.met - a.met).slice(0, 8);
      })(), scope: 'recent results'
    };
    const winRate = stats.bids ? stats.wins / stats.bids * 100 : null;
    const ranks = { 1: 0, 2: 0, 3: 0 };
    for (const x of rows) if (x.mine?.rank) ranks[Math.min(3, x.mine.rank)]++;
    const years = Object.entries(H?.years || {}).filter(([y]) => y);
    const maxYear = Math.max(1, ...years.map(([, v]) => v[0]));
    const barsOf = (title, entries) => bars(title, entries, Math.max(1, entries.reduce((n, [, c]) => n + c, 0)));

    lastFocus = document.activeElement;
    const d = $('drawer');
    d.innerHTML = `
      <div class="tp-bar"><div class="wrap tp-bar-in">
        <button class="btn ghost" type="button" data-close>${icon.back} Back</button>
        <span class="spacer"></span>
        <button class="btn" type="button" id="cpXlsx">${dlIcon} Excel</button>
        <button class="btn ${isWatched(display) ? 'on' : ''}" type="button" data-follow="${esc(display)}" aria-pressed="${isWatched(display)}">👁 ${isWatched(display) ? 'Watching' : 'Watch'}</button>
        <button class="btn" type="button" data-copy="${esc(display)}">Copy name</button>
      </div></div>
      <header class="tp-hero"><div class="wrap">
        <div class="row"><span class="badge soft">Contractor profile</span>${H ? '<span class="badge soft">Full history</span>' : ''}</div>
        <h2 id="dTitle">${esc(who.firm)}</h2>
        <p class="tp-sub">${who.person ? `${esc(who.person)} · ` : ''}${fmtInt(stats.bids)} bids · ${fmtInt(stats.wins)} won · ${esc(stats.scope)}</p>
      </div></header>
      <div class="wrap cp">
        <div class="cp-kpis">
          <div class="kpi"><span>Tenders won</span><strong>${fmtInt(stats.wins)}</strong><small>${stats.value ? `worth ${money(stats.value)}` : ''}</small></div>
          <div class="kpi"><span>Win rate</span><strong>${winRate === null ? '—' : winRate.toFixed(0) + '%'}</strong><small>${stats.bids ? `of ${fmtInt(stats.bids)} tenders bid` : 'bid amounts not published'}</small></div>
          <div class="kpi"><span>Usual winning bid</span><strong>${stats.winPct == null ? '—' : pctText(stats.winPct).replace(' estimate', '')}</strong><small>median when they won</small></div>
          <div class="kpi"><span>Usual bid</span><strong>${stats.bidPct == null ? '—' : pctText(stats.bidPct).replace(' estimate', '')}</strong><small>median of all their bids</small></div>
        </div>
        <section class="panel"><h3>About</h3><dl class="facts">
          ${who.person ? `<dt>Firm</dt><dd>${esc(who.firm)}</dd><dt>Registered person</dt><dd>${esc(who.person)}</dd>` : `<dt>Name</dt><dd>${esc(display)}</dd>`}
          ${H?.first ? `<dt>First bid seen</dt><dd>${esc(shortDate.format(new Date(H.first)))} ${esc(H.first.slice(0, 4))}</dd>` : ''}
          ${H?.last ? `<dt>Latest bid</dt><dd>${esc(shortDate.format(new Date(H.last)))} ${esc(H.last.slice(0, 4))}</dd>` : ''}
          ${stats.districts[0] ? `<dt>Works mostly in</dt><dd>${esc(stats.districts.slice(0, 3).map(([k]) => k).join(', '))}</dd>` : ''}
          ${stats.works[0] ? `<dt>Main type of work</dt><dd>${esc(stats.works.slice(0, 2).map(([k]) => k).join(', '))}</dd>` : ''}
          ${stats.depts[0] ? `<dt>Main department</dt><dd>${esc(stats.depts[0][0])}</dd>` : ''}
        </dl><p class="note">KPPP publishes only the bidder's name with each result; everything here is worked out from their bids.</p></section>
        ${years.length ? `<section class="panel"><h3>Bids and wins by year</h3><div class="bars">${years.map(([y, [b, w]]) => `
          <div class="bar"><span>${esc(y)}</span><i style="--w:${Math.max(4, Math.round(b / maxYear * 100))}%"></i><b>${fmtInt(w)} won / ${fmtInt(b)}</b></div>`).join('')}</div></section>` : ''}
        ${rows.some((x) => x.mine?.rank) ? `<section class="panel"><h3>Where they finish</h3><div class="ranks">
          <div><b>${ranks[1]}</b><span>L1 (lowest)</span></div><div><b>${ranks[2]}</b><span>L2</span></div><div><b>${ranks[3]}</b><span>L3 or lower</span></div>
        </div><p class="note">From the ${fmtInt(rows.length)} tenders listed below.</p></section>` : ''}
        <div class="cp-grid">
          ${barsOf('Districts', stats.districts)}
          ${barsOf('Departments', stats.depts)}
          ${barsOf('Type of work', stats.works)}
          ${stats.rivals.length ? `<section class="panel"><h3>Frequent competitors</h3><div class="table-wrap"><table>
            <thead><tr><th>Competitor</th><th class="n">Met</th><th class="n">${esc(who.firm.split(' ')[0])} ahead</th></tr></thead>
            <tbody>${stats.rivals.map((v) => `<tr><td><button type="button" class="linkish" data-contractor="${esc(v.name)}">${esc(splitName(v.name).firm)}</button></td><td class="n">${v.met}</td><td class="n">${v.ahead} of ${v.met}</td></tr>`).join('')}</tbody>
          </table></div></section>` : ''}
        </div>
        <section class="panel"><h3>Every tender they bid <span class="count">${fmtInt(rows.length)}</span></h3>
          <p class="note" style="margin:0 0 10px">Tap a tender to see every bidder's amount and item-wise rates.</p><div class="table-wrap"><table>
          <thead><tr><th>Date</th><th>Tender</th><th>Result</th><th class="n">Their bid</th><th class="n">vs estimate</th></tr></thead>
          <tbody>${rows.map((x, i) => `<tr${x.won ? ' class="l1"' : ''}${i >= 100 ? ' class="more-row" hidden' : ''}>
            <td>${x.date ? esc(shortDate.format(new Date(x.date))) + (x.old ? ` ${new Date(x.date).getFullYear()}` : '') : ''}</td>
            <td><button type="button" class="linkish item-name" data-bids="${esc(x.r.nit)}" data-month="${esc(String(x.r.closed || '').slice(0, 7))}">${esc(x.r.title)}</button><small>${esc([x.r.ref, x.r.district, x.r.dept].filter(Boolean).join(' · '))}</small></td>
            <td>${x.won ? '<b>Won</b>' : x.mine?.rank ? `L${x.mine.rank}` : ''}${!x.won && x.r.winner ? `<small>Winner: <button type="button" class="linkish" data-contractor="${esc(x.r.winner)}">${esc(splitName(x.r.winner).firm)}</button></small>` : ''}</td>
            <td class="n">${x.mine?.amount ? money(x.mine.amount) : ''}</td>
            <td class="n">${x.mine?.pct === null || x.mine?.pct === undefined ? '' : (x.mine.pct > 0 ? '+' : '') + x.mine.pct.toFixed(1) + '%'}</td>
          </tr>`).join('')}</tbody>
        </table></div>${rows.length > 100 ? `<button class="btn ghost show-rows" type="button" id="cpMore">Show all ${fmtInt(rows.length)} tenders</button>` : ''}</section>
      </div>`;
    d.setAttribute('aria-hidden', 'false');
    d.classList.add('open');
    document.body.style.overflow = 'hidden';
    d.scrollTop = 0;
    d.querySelector('[data-close]').focus();
    $('cpMore')?.addEventListener('click', (e) => { d.querySelectorAll('.cp tr.more-row').forEach((row) => { row.hidden = false; }); e.target.remove(); });
    cpRows = rows;
    $('cpXlsx').addEventListener('click', () => downloadDoc({
      title: display, fileBase: `contractor-${safeFile(who.firm)}`,
      sections: [
        { heading: 'Summary', kv: [['Contractor', display], ['Bids', stats.bids], ['Won', stats.wins], ['Value won', stats.value ? money(stats.value, { full: true }) : ''], ['Win rate', winRate === null ? '' : winRate.toFixed(1) + '%'], ['Usual winning bid', stats.winPct == null ? '' : pctText(stats.winPct)], ['Usual bid', stats.bidPct == null ? '' : pctText(stats.bidPct)], ['First bid seen', H?.first || ''], ['Latest bid', H?.last || ''], ['Based on', stats.scope]].filter(([, v]) => v !== '' && v != null) },
        { heading: 'Tenders', head: ['Date', 'Tender number', 'Work', 'District', 'Department', 'Result', 'Their bid', 'vs estimate %', 'Winner'],
          rows: rows.map((x) => [x.date ? new Date(x.date).toISOString().slice(0, 10) : '', x.r.ref || '', x.r.title || '', x.r.district || '', x.r.dept || '', x.won ? 'Won' : x.mine?.rank ? 'L' + x.mine.rank : '', x.mine?.amount || '', x.mine?.pct ?? '', x.won ? '' : x.r.winner || '']), widths: [12, 28, 60, 14, 30, 8, 14, 12, 40] },
        { heading: 'Competitors', head: ['Competitor', 'Met', 'They finished ahead'], rows: stats.rivals.map((v) => [v.name, v.met, v.ahead]), widths: [50, 8, 18] }
      ]
    }, 'xlsx'));
    const hash = '#c=' + encodeURIComponent(display);
    if (location.hash !== hash) history.pushState({ contractor: display }, '', hash);
  }

  // ---------- Favourite results, notes and downloads ----------
  function toggleResultSave(nit) {
    if (R.saved.has(nit)) R.saved.delete(nit); else R.saved.add(nit);
    writeJSON(RSAVED_KEY, [...R.saved]);
    const on = R.saved.has(nit);
    document.querySelectorAll(`[data-rsave="${CSS.escape(nit)}"]`).forEach((b) => {
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
      if (b.classList.contains('btn')) b.lastChild.textContent = on ? ' Saved' : ' Save';
    });
    $('rSavedCount').textContent = R.saved.size;
    toast(on ? 'Result saved' : 'Removed from saved results');
    if (R.savedOnly && !on) applyResults({ keepPage: true });
  }

  const notes = readJSON(NOTES_KEY, {});
  function noteOf(key) { return notes[key] || ''; }
  function notePanel(key) {
    return `<section class="panel notes"><h3>My notes</h3>
      <textarea class="note-box" data-note="${esc(key)}" rows="3" placeholder="Private notes — site visit, material rates, who to call… Synced to all your devices.">${esc(noteOf(key))}</textarea>
      <small class="note-saved" aria-live="polite"></small></section>`;
  }
  function bindNote(root) {
    const box = root.querySelector('[data-note]');
    if (!box) return;
    let timer;
    box.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const v = box.value.trim();
        if (v) notes[box.dataset.note] = v; else delete notes[box.dataset.note];
        writeJSON(NOTES_KEY, notes);
        const s = root.querySelector('.note-saved');
        if (s) s.textContent = v ? 'Saved' : '';
        const key = box.dataset.note;
        if (key.startsWith('t:')) {
          const el = document.querySelector(`.card[data-id="${CSS.escape(key.slice(2))}"]`);
          const t = S.byId.get(key.slice(2));
          if (el && t) el.outerHTML = card(t);
        }
      }, 400);
    });
  }

  // One helper for every download: sections become sheets (Excel) or tables (PDF).
  async function downloadDoc({ title, lines = [], sections, fileBase }, kind) {
    try {
      if (kind === 'xlsx') {
        toast('Preparing Excel file…');
        await loadScript('/vendor/xlsx.mini.min.js');
        const X = window.XLSX;
        const wb = X.utils.book_new();
        const used = new Set();
        for (const sec of sections) {
          const aoa = sec.kv ? [[title], ...lines.map((l) => [l]), [], ...sec.kv] : [sec.head, ...sec.rows];
          const ws = X.utils.aoa_to_sheet(aoa);
          ws['!cols'] = (sec.widths || (sec.kv ? [28, 90] : sec.head.map(() => 16))).map((wch) => ({ wch }));
          let name = sec.heading.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31);
          while (used.has(name)) name = name.slice(0, 28) + used.size;
          used.add(name);
          X.utils.book_append_sheet(wb, ws, name);
        }
        X.writeFile(wb, fileBase + '.xlsx');
      } else {
        toast('Preparing PDF…');
        await loadScript('/vendor/jspdf.umd.min.js');
        await loadScript('/vendor/jspdf.plugin.autotable.min.js');
        const doc = new window.jspdf.jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });
        const pdfText = (v) => String(v ?? '').replace(/₹/g, 'Rs. ');
        doc.setFontSize(14);
        const titleLines = doc.splitTextToSize(pdfText(title), 760).slice(0, 3);
        doc.text(titleLines, 40, 40);
        doc.setFontSize(9);
        let y = 40 + 17 * titleLines.length + 2;
        if (lines.length) { doc.text(doc.splitTextToSize(lines.map(pdfText).join('\n'), 760), 40, y); y += 12 * lines.length + 8; }
        for (const sec of sections) {
          doc.setFontSize(11);
          if (y > 520) { doc.addPage(); y = 40; }
          doc.text(sec.heading, 40, y + 4);
          doc.autoTable({
            startY: y + 10,
            head: sec.kv ? undefined : [sec.head.map(pdfText)],
            body: (sec.kv || sec.rows).map((row) => row.map((c) => (typeof c === 'number' ? c.toLocaleString('en-IN', { maximumFractionDigits: 2 }) : pdfText(c)))),
            styles: { fontSize: 7.5, cellPadding: 3, overflow: 'linebreak' },
            headStyles: { fillColor: [79, 70, 229] },
            columnStyles: sec.kv ? { 0: { cellWidth: 170, fontStyle: 'bold' } } : {},
            margin: { left: 40, right: 40 }
          });
          y = doc.lastAutoTable.finalY + 24;
        }
        doc.save(fileBase + '.pdf');
      }
    } catch {
      toast('Download failed — please try again');
    }
  }
  const safeFile = (v) => String(v || 'tender').replace(/[^\w-]+/g, '_').slice(0, 80);
  const ist = (ms) => (ms ? dateFmt.format(new Date(ms)) : '');

  // Live tender: summary, details, bill of quantities (with my rates when entered) and my notes.
  async function exportTender(t, kind) {
    let f = null;
    if (t.nit) {
      const key = `${t.cat}/${t.nit}`;
      try {
        if (!detailCache.has(key)) detailCache.set(key, fetch(`/api/tender/${key}`).then((r) => r.json()).then((j) => (j.success ? j : Promise.reject(new Error('n/a')))));
        f = await detailCache.get(key);
      } catch { detailCache.delete(`${t.cat}/${t.nit}`); f = null; }
    }
    const kv = [
      ['Tender number', t.ref], ['Work', t.title], ['Category', t.cat], ['Department', t.dept], ['Office', t.office], ['District', t.district],
      ['Type of work', t.work], ['Who can bid', t.access], ['Tender value', num(t.value) ? money(t.value, { full: true }) : 'Not published'],
      ['EMD', num(t.emd) ? money(t.emd, { full: true }) : 'Not published'], ['Tender fee', num(t.fee) ? money(t.fee, { full: true }) : 'Not published'],
      ['Published', ist(t._pub)], ['Bid submission ends', ist(t._close)]
    ];
    if (f) {
      kv.push(['Bids open', fmtKppp(f.dates?.opening) || ''], ['Last date for questions', fmtKppp(f.dates?.queries) || ''],
        ['Evaluation', f.terms?.evaluation || ''], ['Bid type', f.terms?.bidType || ''],
        ['Contact', [f.contact?.person, f.contact?.mobile].filter(Boolean).join(' · ')], ['Address', f.contact?.address || '']);
      for (const c of f.changes || []) kv.push([`Changed: ${c.field}`, `${c.from} → ${c.to}`]);
    }
    if (G.rec && G.t === t) kv.push(['Suggested bid (past winners)', money(G.rec, { full: true })]);
    if (noteOf('t:' + t.id)) kv.push(['My notes', noteOf('t:' + t.id)]);
    const sections = [{ heading: 'Summary', kv: kv.filter(([, v]) => v) }];
    if (f?.eligibility?.length) sections.push({ heading: 'Eligibility', head: ['#', 'Condition'], rows: f.eligibility.map((x, i) => [i + 1, x]), widths: [5, 120] });
    if (f?.documents?.length) sections.push({ heading: 'Documents to upload', head: ['Document', 'Cover', 'Mandatory'], rows: f.documents.map((d) => [d.name, d.cover || '', d.optional ? 'No' : 'Yes']), widths: [80, 20, 12] });
    if (f?.groups?.some((g) => g.items.length)) {
      const saved = readJSON(`tenderone_bid_${t.cat}_${t.nit}`, {});
      const rows = [];
      f.groups.forEach((g, gi) => g.items.forEach((i, ii) => {
        const my = saved[`${gi}:${ii}`];
        const win = G.t === t ? G.winMore?.get(`${gi}:${ii}`) : null;
        rows.push([i.code || ii + 1, i.name || '', i.qty ?? '', i.unit || '', num(i.rate) || '', num(i.amount) || '',
          win ? Math.round(win * 100) / 100 : '', win && i.qty ? Math.round(win * i.qty * 100) / 100 : '',
          my ?? '', my != null && i.qty ? Math.round(my * i.qty * 100) / 100 : '']);
      }));
      const winTotal = rows.reduce((n, r) => n + (Number(r[7]) || 0), 0);
      if (winTotal) rows.push(['', 'TOTAL (to win more often)', '', '', '', '', '', Math.round(winTotal * 100) / 100, '', '']);
      sections.push({ heading: t.cat === 'WORKS' ? 'Bill of quantities' : 'Items', head: ['Item no.', 'Item', 'Qty', 'Unit', 'Dept. rate', 'Dept. amount', 'Win-more rate', 'Win-more amount', 'My rate', 'My amount'], rows, widths: [12, 70, 10, 10, 14, 16, 14, 16, 12, 16] });
    }
    await downloadDoc({ title: t.title, lines: [`${t.ref} · ${t.dept || ''}`, 'From TenderOne (KPPP data) · ' + new Date().toLocaleDateString('en-IN')], sections, fileBase: `tender-${safeFile(t.ref)}` }, kind);
  }

  // Past result: summary, every bid, timeline and item-wise rates when available.
  async function exportResult(nit, kind) {
    const r = R.byNit?.get(String(nit));
    if (!r) return;
    let a = null;
    try {
      if (!awardCache.has(r.nit)) awardCache.set(r.nit, fetch(`/api/award/${encodeURIComponent(r.nit)}`).then((x) => (x.ok ? x.json() : Promise.reject(new Error('n/a')))));
      a = await awardCache.get(r.nit);
    } catch { awardCache.delete(r.nit); }
    const l1 = r.bidders?.[0];
    const kv = [
      ['Tender number', r.ref], ['Work', r.title], ['Department', r.dept], ['Office', r.office], ['District', r.district], ['Type of work', r.work],
      ['Estimate', num(r.value) ? money(r.value, { full: true }) : ''], ['Winner', r.winner], ['Winning bid', l1?.amount ? money(l1.amount, { full: true }) : ''],
      ['Winner vs estimate', l1?.pct != null ? signed(l1.pct) : ''], ['Bidders', r.bidders?.length || ''], ['Awarded', ist(r._award)]
    ];
    const t = a?.timeline || {};
    for (const [k, v] of [['Published', t.published], ['Bids closed', t.closed || r.closed], ['Price bids opened', t.finOpened], ['Result approved', t.finApproved], ['Performance guarantee', t.pbg]]) if (v) kv.push([k, ist(Date.parse(v))]);
    for (const [k, v] of [['Opened by', a?.people?.opener], ['Approved by', a?.people?.approver], ['EMD', num(a?.emd) ? money(a.emd, { full: true }) : '']]) if (v) kv.push([k, v]);
    if (noteOf('r:' + r.nit)) kv.push(['My notes', noteOf('r:' + r.nit)]);
    const sections = [{ heading: 'Summary', kv: kv.filter(([, v]) => v !== '' && v != null) }];
    if (r.bidders?.length) {
      sections.push({ heading: 'All bids', head: ['Rank', 'Bidder', 'Quoted amount', 'vs estimate %', 'Gap to L1'],
        rows: r.bidders.map((b) => [b.rank ? 'L' + b.rank : '', b.name, b.amount || '', b.pct ?? '', l1?.amount && b.amount && b.rank !== 1 ? Math.round((b.amount - l1.amount) * 100) / 100 : '']), widths: [8, 60, 18, 14, 16] });
    }
    const items = a?.items || [];
    const bidders = a?.bidders?.length ? a.bidders : (r.bidders || []);
    if (items.length && bidders.length) {
      const cols = bidders.slice(0, 8);
      sections.push({ heading: 'Item-wise rates', head: ['Item no.', 'Item', 'Unit', 'Qty', 'Dept. rate', ...cols.map((b) => `${b.rank ? 'L' + b.rank + ' ' : ''}${splitName(b.name).firm}`)],
        rows: items.map((i) => [i.code || '', i.name || '', i.unit || '', i.qty ?? '', i.est ?? '', ...cols.map((_, k) => i.rates?.[k] ?? '')]), widths: [12, 60, 8, 8, 12, ...cols.map(() => 16)] });
    }
    await downloadDoc({ title: r.title, lines: [`${r.ref} · ${r.dept || ''}`, 'Awarded result from TenderOne (KPPP data)'], sections, fileBase: `result-${safeFile(r.ref)}` }, kind);
  }

  // All results matching the filters, as one Excel file.
  async function exportResults() {
    const list = R.filtered.slice(0, 20000);
    const tenders = list.map((r) => { const b = r.bidders || []; return [r.ref, r.title, r.dept, r.office, r.district, r.work, num(r.value) || '', r.awarded ? r.awarded.slice(0, 10) : '', r.winner || '', b[0]?.amount || '', b[0]?.pct ?? '', b.length || '', b[1]?.name || '', b[1]?.amount || '', R.saved.has(r.nit) ? 'Yes' : '', noteOf('r:' + r.nit)]; });
    const bids = [];
    for (const r of list) for (const b of r.bidders || []) bids.push([r.ref, r.title, r.district, r.work, num(r.value) || '', b.rank ? 'L' + b.rank : '', b.name, b.amount || '', b.pct ?? '']);
    await downloadDoc({
      title: 'Past works results', fileBase: `past-results-${new Date().toISOString().slice(0, 10)}`,
      sections: [
        { heading: 'Tenders', head: ['Tender number', 'Work', 'Department', 'Office', 'District', 'Type of work', 'Estimate', 'Awarded', 'Winner', 'Winning bid', 'Winner vs estimate %', 'Bidders', 'L2 bidder', 'L2 bid', 'Saved', 'My notes'], rows: tenders, widths: [26, 60, 30, 30, 14, 16, 14, 12, 40, 14, 12, 8, 40, 14, 8, 40] },
        { heading: 'All bids', head: ['Tender number', 'Work', 'District', 'Type of work', 'Estimate', 'Rank', 'Bidder', 'Quoted amount', 'vs estimate %'], rows: bids, widths: [26, 60, 14, 16, 14, 6, 44, 16, 12] }
      ]
    }, 'xlsx');
  }

  // ---------- Watch competitors ----------
  let watch = readJSON(WATCH_KEY, []); // [{ key, name, seen }]
  const isWatched = (n) => Boolean(n) && watch.some((w) => w.key === nameKey(n));
  function toggleWatch(name) {
    const key = nameKey(name);
    const on = !watch.some((w) => w.key === key);
    watch = on ? [...watch, { key, name, seen: Date.now() }] : watch.filter((w) => w.key !== key);
    writeJSON(WATCH_KEY, watch);
    document.querySelectorAll('[data-follow]').forEach((b) => {
      if (nameKey(b.dataset.follow) !== key) return;
      b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); b.textContent = on ? '👁 Watching' : '👁 Watch';
    });
    toast(on ? `Watching ${splitName(name).firm}` : 'Stopped watching');
    if (R.all && R.mode === 'results') applyResults({ keepPage: true });
    if (R.mode === 'watching') renderWatch();
  }
  function renderWatch() {
    const box = $('rWatch');
    if (!box) return;
    if (!watch.length) {
      box.innerHTML = '<h3>Contractors I watch</h3><p class="muted-p">You are not watching anyone yet. Open any contractor (from Past results or Bidders) and tap “👁 Watch” — they will appear here on all your devices.</p>';
      return;
    }
    if (!R.all) { box.innerHTML = `<h3>Contractors I watch <span class="count">${watch.length}</span></h3><p class="muted-p">Loading their bids…</p>`; return; }
    const stats = watch.map((w) => {
      let bids = 0, wins = 0, fresh = 0, last = 0;
      for (const r of R.all || []) {
        const bid = (r.bidders || []).find((b) => nameKey(b.name) === w.key);
        const won = nameKey(r.winner) === w.key || bid?.rank === 1;
        if (!bid && !won) continue;
        bids++; if (won) { wins++; last = Math.max(last, r._award); }
        if (r._award > (w.seen || 0)) fresh++;
      }
      return { ...w, bids, wins, fresh, last };
    });
    box.innerHTML = `<h3>Contractors I watch <span class="count">${watch.length}</span></h3>
      <div class="watch-list">${stats.map((w) => `<button type="button" class="watch-card" data-win="${esc(w.name)}">
        <b>${esc(splitName(w.name).firm)}</b>
        <span>${fmtInt(w.wins)} won · ${fmtInt(w.bids)} bids${w.last ? ` · last win ${esc(shortDate.format(new Date(w.last)))}` : ''}</span>
        ${w.fresh ? `<em>${fmtInt(w.fresh)} new since you started watching</em>` : ''}
      </button>`).join('')}</div>
      <p class="note">Open a contractor to see all their bids. Tap “👁 Watch” on any contractor page to add or remove.</p>`;
  }

  // ---------- Compare tenders ----------
  function toggleCompare(id) {
    const on = !S.compare.includes(id);
    if (on && S.compare.length >= 4) { toast('You can compare up to 4 tenders'); return; }
    S.compare = on ? [...S.compare, id] : S.compare.filter((x) => x !== id);
    writeJSON(COMPARE_KEY, S.compare);
    document.querySelectorAll(`[data-cmp="${CSS.escape(id)}"]`).forEach((b) => { b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
    updateCompareTray();
    toast(on ? `Added to compare (${S.compare.length})` : 'Removed from compare');
  }
  function updateCompareTray() {
    const tray = $('cmpTray');
    S.compare = S.compare.filter((id) => S.byId.has(id));
    tray.hidden = !S.compare.length;
    tray.innerHTML = `<span><b>${S.compare.length}</b> to compare</span>
      <button class="btn primary" type="button" id="cmpGo"${S.compare.length < 2 ? ' disabled title="Pick at least 2 tenders"' : ''}>Compare now</button>
      <button class="btn ghost" type="button" id="cmpClear">Clear</button>`;
    $('cmpGo').addEventListener('click', openCompare);
    $('cmpClear').addEventListener('click', () => {
      S.compare.forEach((id) => document.querySelectorAll(`[data-cmp="${CSS.escape(id)}"]`).forEach((b) => { b.classList.remove('on'); b.setAttribute('aria-pressed', 'false'); }));
      S.compare = []; writeJSON(COMPARE_KEY, []); updateCompareTray();
    });
  }
  function simGroup(t, groups) {
    if (!groups) return null;
    let g = groups[`d|${t.dept || ''}|${t.work || ''}`];
    const byDistrict = t.district ? groups[`x|${t.district}|${t.work || ''}`] : null;
    if ((!g || g.n < 5) && byDistrict && byDistrict.n > (g?.n || 0)) g = byDistrict;
    return g || null;
  }
  async function openCompare() {
    const list = S.compare.map((id) => S.byId.get(id)).filter(Boolean);
    if (list.length < 2) { toast('Pick at least 2 tenders to compare'); return; }
    const groups = await loadSimilar();
    lastFocus = document.activeElement;
    const rows = [
      ['Department', (t) => esc(t.dept || '')],
      ['District', (t) => esc(t.district || '—')],
      ['Type of work', (t) => esc(t.work || '—')],
      ['Who can bid', (t) => esc(t.access || '—')],
      ['Tender value', (t) => money(t.value, { full: true }) || '—', (t) => num(t.value)],
      ['EMD', (t) => money(t.emd, { full: true }) || '—', (t) => -(num(t.emd) || Infinity)],
      ['Tender fee', (t) => money(t.fee, { full: true }) || '—'],
      ['Closes', (t) => (t._close ? `${esc(dateFmt.format(new Date(t._close)))}<small>${esc(timeLeft(t._close)?.label || '')}</small>` : '—')],
      ['Typical winning bid', (t) => { const g = simGroup(t, groups); return g ? `${esc(pctText(g.q[1]))}<small>${fmtInt(g.n)} similar tenders</small>` : '—'; }],
      ['Suggested bid', (t) => { const g = simGroup(t, groups); return g && num(t.value) ? money(t.value * (1 + g.q[1] / 100), { full: true }) : '—'; }],
      ['Usual competition', (t) => { const g = simGroup(t, groups); return g?.bidders ? `${g.bidders} bidders on average` : '—'; }, (t) => -(simGroup(t, groups)?.bidders || Infinity)],
      ['Usual winner', (t) => { const g = simGroup(t, groups); return g?.top?.[0] ? `<button type="button" class="linkish" data-contractor="${esc(g.top[0][0])}">${esc(splitName(g.top[0][0]).firm)}</button><small>${g.top[0][1]} wins</small>` : '—'; }],
      ['My notes', (t) => esc(noteOf('t:' + t.id) || '—')]
    ];
    const d = $('drawer');
    d.innerHTML = `
      <div class="tp-bar"><div class="wrap tp-bar-in">
        <button class="btn ghost" type="button" data-close>${icon.back} Back</button>
        <span class="spacer"></span>
        <button class="btn" type="button" id="cmpXlsx">${dlIcon} Excel</button>
      </div></div>
      <header class="tp-hero"><div class="wrap">
        <div class="row"><span class="badge soft">Compare tenders</span></div>
        <h2 id="dTitle">${list.length} tenders side by side</h2>
        <p class="tp-sub">Green marks the better value in a row (bigger value, lower EMD, fewer competitors).</p>
      </div></header>
      <div class="wrap cp">
        <section class="panel"><div class="table-wrap"><table class="cmp-table">
          <thead><tr><th></th>${list.map((t) => `<th><button type="button" class="linkish" data-open="${esc(t.id)}">${esc(t.title)}</button><small>${esc(t.ref)}</small>
            <button type="button" class="btn ghost small" data-cmp="${esc(t.id)}" aria-pressed="true">Remove</button></th>`).join('')}</tr></thead>
          <tbody>${rows.map(([label, cell, score]) => {
            const scores = score ? list.map(score) : [];
            const best = scores.length ? Math.max(...scores.filter((x) => Number.isFinite(x))) : null;
            return `<tr><th>${esc(label)}</th>${list.map((t, i) => `<td${best !== null && Number.isFinite(best) && scores[i] === best ? ' class="best"' : ''}>${cell(t)}</td>`).join('')}</tr>`;
          }).join('')}</tbody>
        </table></div></section>
      </div>`;
    d.setAttribute('aria-hidden', 'false');
    d.classList.add('open');
    document.body.style.overflow = 'hidden';
    d.scrollTop = 0;
    d.querySelector('[data-close]').focus();
    d.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => openTender(b.dataset.open)));
    $('cmpXlsx').addEventListener('click', () => {
      const plain = (html) => { const el = document.createElement('div'); el.innerHTML = html.replace(/<small>/g, ' · '); return el.textContent.trim(); };
      downloadDoc({ title: 'Compare tenders', fileBase: `compare-${new Date().toISOString().slice(0, 10)}`, sections: [{
        heading: 'Compare', head: ['', ...list.map((t) => t.ref)],
        rows: [['Work', ...list.map((t) => t.title)], ...rows.map(([label, cell]) => [label, ...list.map((t) => plain(cell(t)))])],
        widths: [22, ...list.map(() => 45)]
      }] }, 'xlsx');
    });
    if (location.hash !== '#compare') history.pushState({ compare: true }, '', '#compare');
  }

  // ---------- Charts for the filtered past results ----------
  function renderCharts() {
    const box = $('rChartsBody');
    const district = $('cDistrict').value;
    const list = (R.all || []).filter((r) => !district || r.district === district);
    if (!list.length) { box.innerHTML = '<p class="muted-p">No results to chart.</p>'; return; }
    const byMonth = new Map();
    for (const r of list) {
      const p = winPct(r);
      if (!r._award) continue;
      const m = new Date(r._award + 5.5 * 3600e3).toISOString().slice(0, 7);
      const v = byMonth.get(m) || { pcts: [], n: 0 };
      v.n++; if (p !== null && p > -80 && p < 80) v.pcts.push(p);
      byMonth.set(m, v);
    }
    const months = [...byMonth.keys()].sort().slice(-18);
    const series = months.map((m) => ({ m, n: byMonth.get(m).n, med: median(byMonth.get(m).pcts) }));
    const maxBelow = Math.max(5, ...series.map((x) => (x.med !== null ? -x.med : 0)));
    const W = 640, H = 180, pad = 26, bw = (W - pad * 2) / Math.max(series.length, 1);
    const monthName = (m) => new Date(m + '-01T00:00:00').toLocaleString('en-IN', { month: 'short' }) + (m.endsWith('-01') ? ' ' + m.slice(2, 4) : '');
    const trend = series.length ? `<figure class="chart"><figcaption>Winning bid, % below estimate, by month (median L1)</figcaption>
      <svg viewBox="0 0 ${W} ${H + 24}" role="img" aria-label="Median winning discount by month">
        <line x1="${pad}" x2="${W - pad}" y1="${H}" y2="${H}" class="axis"/>
        ${[0.5, 1].map((f) => `<line x1="${pad}" x2="${W - pad}" y1="${H - (H - 20) * f}" y2="${H - (H - 20) * f}" class="grid"/><text x="${pad - 4}" y="${H - (H - 20) * f + 4}" class="tick" text-anchor="end">${Math.round(maxBelow * f)}%</text>`).join('')}
        ${series.map((x, i) => {
          const v = x.med !== null ? Math.max(0, -x.med) : 0;
          const h = (H - 20) * v / maxBelow;
          const cx = pad + i * bw;
          return `<g class="col"><rect class="hit" x="${cx}" y="0" width="${bw}" height="${H + 24}"/>
            <rect class="bar" x="${cx + bw * 0.18}" y="${H - h}" width="${bw * 0.64}" height="${Math.max(h, 1)}" rx="4"/>
            ${i % Math.ceil(series.length / 9) === 0 || i === series.length - 1 ? `<text x="${cx + bw / 2}" y="${H + 16}" class="tick" text-anchor="middle">${esc(monthName(x.m))}</text>` : ''}
            <title>${esc(monthName(x.m))} ${x.m.slice(0, 4)}: ${x.med === null ? 'no bid data' : pctText(x.med)} · ${fmtInt(x.n)} tenders</title></g>`;
        }).join('')}
      </svg></figure>` : '';
    const groupBy = (key, min) => {
      const m = new Map();
      for (const r of list) { const k = r[key]; if (!k) continue; const v = m.get(k) || []; const p = winPct(r); if (p !== null && p > -80 && p < 80) v.push(p); m.set(k, v); }
      return [...m.entries()].filter(([, v]) => v.length >= min).map(([k, v]) => [k, median(v), v.length]);
    };
    const deep = groupBy('district', 5).sort((a, b) => a[1] - b[1]).slice(0, 10);
    const deepMax = Math.max(1, ...deep.map((x) => -x[1]));
    const depts = countBy(list, 'dept').slice(0, 8);
    const wins = new Map();
    for (const r of list) if (r.winner && /[a-z]{2}/i.test(r.winner)) { const k = nameKey(r.winner); const v = wins.get(k) || { name: r.winner, n: 0 }; v.n++; wins.set(k, v); }
    const top = [...wins.values()].sort((a, b) => b.n - a.n).slice(0, 10);
    const barList = (items, max) => `<div class="bars">${items.map(([label, val, text, extra]) => `<div class="bar" title="${esc(label)}: ${esc(text)}"><span>${extra || esc(label)}</span><i style="--w:${Math.max(3, Math.round(val / max * 100))}%"></i><b>${esc(text)}</b></div>`).join('')}</div>`;
    box.innerHTML = `${trend}
      <div class="cp-grid">
        ${deep.length ? `<section><h4>Districts with the biggest discounts</h4><p class="note">Median winning bid below estimate · districts with 5+ tenders</p>${barList(deep.map(([k, v, n]) => [k, Math.max(0, -v), `${Math.abs(v).toFixed(1)}% · ${n}`]), deepMax)}</section>` : ''}
        ${depts.length ? `<section><h4>Most tenders by department</h4><p class="note">Number of awarded tenders</p>${barList(depts.map(([k, n]) => [k, n, fmtInt(n)]), depts[0][1])}</section>` : ''}
        ${top.length ? `<section><h4>Busiest winners</h4><p class="note">Tenders won · tap a name for their profile</p>${barList(top.map((w) => [w.name, w.n, fmtInt(w.n), `<button type="button" class="linkish" data-win="${esc(w.name)}">${isWatched(w.name) ? '👁 ' : ''}${esc(splitName(w.name).firm)}</button>`]), top[0].n)}</section>` : ''}
      </div>`;
  }

  // ---------- Export ----------
  function exportCsv() {
    const rows = [['Tender number', 'Category', 'Title', 'Department', 'Office', 'District', 'Tender value', 'EMD', 'Fee', 'Published', 'Closing', 'Who can bid', 'Work category']];
    const d = (ms) => (ms ? new Date(ms).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : '');
    for (const t of S.filtered) rows.push([t.ref, t.cat, t.title, t.dept, t.office, t.district, t.value, t.emd, t.fee, d(t._pub), d(t._close), t.access, t.work]);
    const csv = rows.map((r) => r.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: `karnataka-tenders-${new Date().toISOString().slice(0, 10)}.csv` });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    toast(`Exported ${fmtInt(S.filtered.length)} tenders`);
  }

  // ---------- Status (admins) ----------
  async function showStatus() {
    const dlg = $('statusDialog');
    const list = $('statusList');
    list.innerHTML = '<li>Checking…</li>';
    dlg.showModal();
    try {
      const r = await fetch('/api/system_health', { cache: 'no-store' });
      const h = await r.json();
      const db = h.database || {};
      const row = (label, ok, text) => `<li><span>${label}</span><b class="${ok ? 'ok-t' : 'bad-t'}">${ok ? '✓' : '⚠'} ${esc(text)}</b></li>`;
      list.innerHTML = [
        row('Tender data', db.ok, `${fmtInt(db.count)} tenders · ${db.age_hours == null ? 'unknown age' : ago(db.last_success_at || db.generated_at)}`),
        row('KPPP connection', h.kppp?.ok, h.kppp?.ok ? 'Reachable' : `Not reachable (HTTP ${h.kppp?.http || '—'})`),
        row('EMD & fee', db.emd_known > 0, `Known for ${fmtInt(db.emd_known)} tenders`)
      ].join('');
    } catch (err) {
      list.innerHTML = `<li><span>Status check</span><b class="bad-t">⚠ ${esc(err.message)}</b></li>`;
    }
  }

  // ---------- Misc ----------
  let toastTimer;
  function toast(text) {
    const el = $('toast');
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 1800);
  }

  function clearFilter(key) {
    if (key === 'cat') S.cat = 'ALL';
    else if (key === 'q') { S.q = ''; $('q').value = ''; }
    else if (key === 'saved') S.savedOnly = false;
    else if (key === 'forMe') S.forMe = false;
    else if (key === 'fClosing') { $('fClosing').value = ''; S.soon = 0; }
    else if ($(key)) $(key).value = '';
    apply({ keepScroll: true });
  }

  function reset() {
    S.cat = 'ALL'; S.soon = 0; S.savedOnly = false; S.forMe = false; S.q = '';
    $('q').value = '';
    for (const id of ['fDistrict', 'fDept', 'fValue', 'fClosing', 'fAccess', 'fBidTime']) $(id).value = '';
    $('fSort').value = 'new';
    apply();
  }

  // ---------- Events ----------
  let qTimer;
  $('q').addEventListener('input', (e) => {
    clearTimeout(qTimer);
    qTimer = setTimeout(() => {
      if (R.mode === 'results') { R.q = e.target.value; applyResults(); return; }
      if (R.mode === 'bidders') { B.q = e.target.value; applyBidders(); return; }
      S.q = e.target.value; apply({ keepScroll: true });
    }, 140);
  });
  for (const id of ['fDistrict', 'fDept', 'fValue', 'fAccess', 'fBidTime', 'fSort']) $(id).addEventListener('change', () => apply({ keepScroll: true }));
  $('fClosing').addEventListener('change', () => { S.soon = 0; apply({ keepScroll: true }); });
  $('scBanner').addEventListener('click', () => { $('fAccess').value = MY_CAT; $('fSort').value = 'closing'; apply(); });
  document.querySelectorAll('.stat[data-cat]').forEach((el) => el.addEventListener('click', () => {
    S.cat = el.dataset.cat; S.soon = 0; $('fClosing').value = ''; apply();
  }));
  document.querySelector('.stat.soon').addEventListener('click', () => {
    S.soon = S.soon === 7 ? 0 : 7; $('fClosing').value = ''; if (S.soon) $('fSort').value = 'closing'; apply();
  });
  $('forMeBtn').addEventListener('click', () => {
    if (!S.profile) { openProfile(); return; }
    S.forMe = !S.forMe;
    apply({ keepScroll: true });
    if (S.forMe) toast(`${fmtInt(S.filtered.length)} tenders for you · long-press or right-click “For me” to edit`);
  });
  $('forMeBtn').addEventListener('contextmenu', (e) => { e.preventDefault(); openProfile(); });
  let pressTimer;
  $('forMeBtn').addEventListener('touchstart', () => { pressTimer = setTimeout(openProfile, 600); }, { passive: true });
  $('forMeBtn').addEventListener('touchend', () => clearTimeout(pressTimer));
  $('profileForm').addEventListener('submit', saveProfile);
  $('pClear').addEventListener('click', () => {
    S.profile = null; S.forMe = false;
    try { localStorage.removeItem(PROFILE_KEY); } catch {}
    $('profileDialog').close(); apply();
  });
  $('profileDialog').addEventListener('click', (e) => { if (e.target.closest('[data-close]') || e.target === e.currentTarget) $('profileDialog').close(); });
  $('savedBtn').addEventListener('click', () => { S.savedOnly = !S.savedOnly; apply({ keepScroll: true }); });
  $('resetBtn').addEventListener('click', reset);
  $('exportBtn').addEventListener('click', exportCsv);
  $('moreBtn').addEventListener('click', renderMore);
  function setView(view) {
    const list = view === 'list';
    $('grid').classList.toggle('list', list);
    document.querySelectorAll('[data-view]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === (list ? 'list' : 'cards'))));
    writeJSON(VIEW_KEY, list ? 'list' : 'cards');
  }
  setView(readJSON(VIEW_KEY, 'cards'));
  document.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
  document.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
  for (const id of ['rCat', 'rDistrict', 'rDept', 'rWork', 'rSort', 'rPeriod', 'rValue', 'rBidderCount']) $(id).addEventListener('change', () => applyResults());
  $('rSavedBtn').addEventListener('click', () => { R.savedOnly = !R.savedOnly; applyResults(); });
  $('cDistrict').addEventListener('change', () => { $('cDistrict').classList.toggle('set', Boolean($('cDistrict').value)); if (R.all) renderCharts(); renderQuickPanel(); });
  $('rExport').addEventListener('click', () => { if (R.filtered.length) exportResults(); else toast('No results to export'); });
  $('rSavedCount').textContent = R.saved.size;
  pullSync();
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') pullSync(); });
  // Bigger text for easier reading, remembered on this device.
  const applyText = (big) => { document.documentElement.classList.toggle('big-text', big); $('textBtn').setAttribute('aria-pressed', String(big)); };
  applyText(readJSON(TEXT_KEY, false));
  $('textBtn').addEventListener('click', () => { const big = !document.documentElement.classList.contains('big-text'); applyText(big); writeJSON(TEXT_KEY, big); toast(big ? 'Bigger text on' : 'Normal text size'); });
  $('rMore').addEventListener('click', moreResults);
  for (const id of ['bDistrict', 'bYear', 'bSort', 'bMin']) $(id).addEventListener('change', applyBidders);
  $('bMore').addEventListener('click', moreBidders);
  $('biddersView').addEventListener('click', (e) => { const w = e.target.closest('[data-win]'); if (w) { e.preventDefault(); openContractor(w.dataset.win); } });
  $('rReset').addEventListener('click', () => {
    for (const id of ['rCat', 'rDistrict', 'rDept', 'rWork', 'rPeriod', 'rValue', 'rBidderCount']) $(id).value = '';
    $('rSort').value = 'new'; R.q = ''; R.savedOnly = false; $('q').value = ''; applyResults();
  });
  for (const view of ['watchView', 'chartsView']) $(view).addEventListener('click', (e) => {
    const aw = e.target.closest('[data-award]');
    if (aw) { e.preventDefault(); openAward(aw.dataset.award); return; }
    const w = e.target.closest('[data-win]');
    if (w) { e.preventDefault(); openContractor(w.dataset.win); }
  });
  $('resultsView').addEventListener('click', (e) => {
    if (e.target.closest('[data-rsave], [data-rdl]')) return;
    const aw = e.target.closest('[data-award]');
    if (aw) { e.preventDefault(); openAward(aw.dataset.award); return; }
    const w = e.target.closest('[data-win]');
    if (!w) return;
    e.preventDefault();
    openContractor(w.dataset.win);
  });
  new IntersectionObserver((entries) => {
    if (entries.some((en) => en.isIntersecting) && !$('rMore').hidden && R.mode === 'results') moreResults();
  }, { rootMargin: '600px' }).observe($('rMore'));
  $('chips').addEventListener('click', (e) => { const b = e.target.closest('[data-clear]'); if (b) clearFilter(b.dataset.clear); });
  $('statusBtn').addEventListener('click', showStatus);
  $('statusTopBtn').addEventListener('click', showStatus);

  // ---------- Install as an app ----------
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  let installPrompt = null;
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; if (!standalone) $('installBtn').hidden = false; });
  window.addEventListener('appinstalled', () => { $('installBtn').hidden = true; toast('TenderOne installed — open it from your home screen'); });
  if (!standalone && isIOS) $('installBtn').hidden = false;
  $('installBtn').addEventListener('click', async () => {
    if (installPrompt) {
      installPrompt.prompt();
      const { outcome } = await installPrompt.userChoice.catch(() => ({}));
      if (outcome === 'accepted') $('installBtn').hidden = true;
      installPrompt = null;
      return;
    }
    $('installSteps').innerHTML = isIOS
      ? '<ol><li>Open this website in <b>Safari</b>.</li><li>Tap the <b>Share</b> button (square with an arrow ↑) at the bottom.</li><li>Tap <b>Add to Home Screen</b>, then <b>Add</b>.</li></ol><p class="note">TenderOne then opens from its own icon, full screen, like an app.</p>'
      : '<ol><li>Open this website in <b>Chrome</b>.</li><li>Tap the <b>⋮</b> menu at the top right.</li><li>Tap <b>Install app</b> (or <b>Add to Home screen</b>), then <b>Install</b>.</li></ol><p class="note">TenderOne then opens from its own icon, full screen, like an app.</p>';
    $('installDialog').showModal();
  });
  $('installDialog').addEventListener('click', (e) => { if (e.target.closest('[data-close]') || e.target === e.currentTarget) $('installDialog').close(); });
  $('statusDialog').addEventListener('click', (e) => { if (e.target.closest('[data-close]') || e.target === e.currentTarget) $('statusDialog').close(); });
  $('themeBtn').addEventListener('click', () => {
    const dark = document.documentElement.dataset.theme
      ? document.documentElement.dataset.theme === 'dark'
      : matchMedia('(prefers-color-scheme: dark)').matches;
    const next = dark ? 'light' : 'dark';
    applyTheme(next); writeJSON(THEME_KEY, next);
  });

  document.addEventListener('click', (e) => {
    const save = e.target.closest('[data-save]');
    if (save) { e.stopPropagation(); toggleSave(save.dataset.save); return; }
    const copy = e.target.closest('[data-copy]');
    if (copy) { navigator.clipboard?.writeText(copy.dataset.copy).then(() => toast('Tender number copied')); return; }
    if (e.target.closest('#drawer [data-close]')) { closeDrawer(); return; }
    const fw = e.target.closest('[data-follow]');
    if (fw) { e.preventDefault(); toggleWatch(fw.dataset.follow); return; }
    const cm = e.target.closest('[data-cmp]');
    if (cm) { e.preventDefault(); e.stopPropagation(); toggleCompare(cm.dataset.cmp); if (location.hash === '#compare' && S.compare.length >= 2) openCompare(); else if (location.hash === '#compare') closeDrawer(); return; }
    const rs = e.target.closest('[data-rsave]');
    if (rs) { e.preventDefault(); e.stopPropagation(); toggleResultSave(rs.dataset.rsave); return; }
    const rdl = e.target.closest('[data-rdl]');
    if (rdl) { e.preventDefault(); e.stopPropagation(); exportResult(rdl.dataset.nit, rdl.dataset.rdl); return; }
    const tdl = e.target.closest('[data-tdl]');
    if (tdl) { const t = G.t; if (t) exportTender(t, tdl.dataset.tdl); return; }
    const cdl = e.target.closest('[data-dl]');
    if (cdl) { e.stopPropagation(); const t = S.byId.get(cdl.dataset.dl); if (t) exportTender(t, 'pdf'); return; }
    const tb = e.target.closest('[data-bids]');
    if (tb) { e.preventDefault(); openTenderBids(tb.dataset.bids, tb.dataset.month); return; }
    const aw = e.target.closest('#drawer [data-award]');
    if (aw) { e.preventDefault(); openAward(aw.dataset.award); return; }
    const bw = e.target.closest('#drawer [data-win]');
    if (bw) { e.preventDefault(); openContractor(bw.dataset.win); return; }
    const who = e.target.closest('[data-contractor]');
    if (who) { e.preventDefault(); openContractor(who.dataset.contractor); return; }
    const c = e.target.closest('.card');
    if (c) openTender(c.dataset.id);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeDrawer();
    if (e.key === 'Enter' && e.target.classList?.contains('card')) openTender(e.target.dataset.id);
    if (e.key === '/' && !/input|select|textarea/i.test(document.activeElement?.tagName || '')) { e.preventDefault(); $('q').focus(); }
  });
  window.addEventListener('popstate', () => {
    const m = location.hash.match(/^#t=(.+)$/);
    const c = location.hash.match(/^#c=(.+)$/);
    const a = location.hash.match(/^#a=(\d+)$/);
    if (m && S.byId.has(decodeURIComponent(m[1]))) openTender(decodeURIComponent(m[1]));
    else if (c) openContractor(decodeURIComponent(c[1]));
    else if (a) openAward(a[1]);
    else closeDrawer({ fromHistory: true });
  });

  // Auto-load the next page when the "Show more" button scrolls into view.
  new IntersectionObserver((entries) => {
    if (entries.some((en) => en.isIntersecting) && !$('moreBtn').hidden) renderMore();
  }, { rootMargin: '600px' }).observe($('moreBtn'));
  new IntersectionObserver(([en]) => $('filters').classList.toggle('stuck', en.intersectionRatio < 1), { threshold: [1], rootMargin: '-1px 0px 0px 0px' }).observe($('filters'));


  const deepContractor = location.hash.match(/^#c=(.+)$/);
  const deepAward = location.hash.match(/^#a=(\d+)$/);
  if (deepContractor) {
    history.replaceState(null, '', location.pathname);
    openContractor(decodeURIComponent(deepContractor[1]));
  } else if (deepAward) {
    history.replaceState(null, '', location.pathname);
    openAward(deepAward[1]);
  }
  load().then(() => {
    updateCompareTray();
    // Get past results ready in the background so the "Past results" tab opens instantly.
    const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 1500));
    idle(() => loadResults().catch(() => {}));
    const m = location.hash.match(/^#t=(.+)$/);
    if (m && S.byId.has(decodeURIComponent(m[1]))) {
      history.replaceState(null, '', location.pathname);
      openTender(decodeURIComponent(m[1]));
    }
  });
  setInterval(updateLive, 60000);
})();
