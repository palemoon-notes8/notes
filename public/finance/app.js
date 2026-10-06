'use strict';
// My Money: daily income and spending, budgets, bills and money lent or borrowed.
// Everything is kept on this device (localStorage) and synced through /api/finance to the same
// private store TenderOne uses, so every phone and computer you sign in on shows the same records.
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const REC_KEY = 'money_records';
  const DIRTY_KEY = 'money_dirty';
  const LAST_KEY = 'money_last';
  const THEME_KEY = 'money_theme';
  const KINDS = new Set(['tx', 'acc', 'cat', 'bill', 'due']);

  // ---------- Money and dates ----------
  // Amounts are whole paise, so totals never drift.
  const nf = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2, minimumFractionDigits: 0 });
  const money = (p) => (p < 0 ? '−' : '') + '₹' + nf.format(Math.abs(p) / 100);
  function compact(p) {
    const r = Math.abs(p) / 100;
    const s = r >= 1e7 ? +(r / 1e7).toFixed(1) + 'Cr' : r >= 1e5 ? +(r / 1e5).toFixed(1) + 'L' : r >= 1e3 ? +(r / 1e3).toFixed(1) + 'k' : String(Math.round(r));
    return (p < 0 ? '−' : '') + '₹' + s;
  }
  // "120", "1,250.50" or "120+45+30" (adds up a few bills at once).
  function toPaise(v) {
    const parts = String(v ?? '').replace(/[₹,\s]/g, '').split('+').filter(Boolean);
    if (!parts.length) return NaN;
    let total = 0;
    for (const part of parts) {
      if (!/^-?\d*\.?\d+$/.test(part)) return NaN;
      total += Math.round(Number(part) * 100);
    }
    return total;
  }
  const plain = (p) => (p / 100).toFixed(2).replace(/\.00$/, '');
  const pad = (n) => String(n).padStart(2, '0');
  const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const today = () => ymd(new Date());
  const addDays = (s, n) => { const d = new Date(s + 'T00:00'); d.setDate(d.getDate() + n); return ymd(d); };
  const thisMonth = () => today().slice(0, 7);
  function shiftMonth(m, n) {
    const [y, mo] = m.split('-').map(Number);
    const d = new Date(y, mo - 1 + n, 1);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
  }
  const monthName = (m, opts = { month: 'long', year: 'numeric' }) => new Date(m + '-01T00:00').toLocaleDateString('en-IN', opts);
  function dayLabel(s) {
    if (s === today()) return 'Today';
    if (s === addDays(today(), -1)) return 'Yesterday';
    if (s === addDays(today(), 1)) return 'Tomorrow';
    return new Date(s + 'T00:00').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: s.slice(0, 4) === today().slice(0, 4) ? undefined : 'numeric' });
  }
  const daysInMonth = (y, m0) => new Date(y, m0 + 1, 0).getDate();
  // Next due date of a repeating bill; `dom` keeps the 31st on the 31st (or the month's last day).
  function nextDue(s, every, dom) {
    if (every === 'week') return addDays(s, 7);
    const d = new Date(s + 'T00:00');
    const step = every === 'year' ? 12 : every === 'quarter' ? 3 : 1;
    const y = d.getFullYear(), m0 = d.getMonth() + step;
    const ny = y + Math.floor(m0 / 12), nm = ((m0 % 12) + 12) % 12;
    return ymd(new Date(ny, nm, Math.min(dom || d.getDate(), daysInMonth(ny, nm))));
  }

  // ---------- Records ----------
  // Every record has an id, a kind (k) and the time it last changed (t). Deleting keeps a small
  // marker ({ del: 1 }) so the deletion reaches your other devices too.
  const recs = new Map();
  const dirty = new Set();
  function load() {
    try { for (const r of JSON.parse(localStorage.getItem(REC_KEY) || '[]')) if (r && r.id) recs.set(r.id, r); } catch {}
    try { for (const id of JSON.parse(localStorage.getItem(DIRTY_KEY) || '[]')) dirty.add(id); } catch {}
  }
  function save() {
    try {
      localStorage.setItem(REC_KEY, JSON.stringify([...recs.values()]));
      localStorage.setItem(DIRTY_KEY, JSON.stringify([...dirty]));
    } catch {
      toast('This device is out of storage space — download a backup from More.');
    }
  }
  const newId = (k) => `${k}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  function put(rec) {
    rec.t = Math.max(Date.now(), (recs.get(rec.id)?.t || 0) + 1);
    recs.set(rec.id, rec);
    dirty.add(rec.id);
    save();
    queueSync();
  }
  function remove(id) {
    const r = recs.get(id);
    if (r) put({ id, k: r.k, del: 1 });
  }
  // Records from another device or a backup are checked before use, so one bad entry cannot break a page.
  const ok = (r) => r.k !== 'tx' || (/^\d{4}-\d{2}-\d{2}$/.test(r.date) && r.p > 0 && ['exp', 'inc', 'xfer'].includes(r.type));
  const all = (k) => [...recs.values()].filter((r) => r.k === k && !r.del && ok(r) && (k !== 'bill' || /^\d{4}-\d{2}-\d{2}$/.test(r.next)) && (k !== 'due' || (r.p > 0 && typeof r.date === 'string')));
  const byOrder = (a, b) => (a.o ?? 999) - (b.o ?? 999) || String(a.name).localeCompare(String(b.name));
  const accounts = () => all('acc').sort(byOrder);
  const cats = (type) => all('cat').filter((c) => !type || c.type === type).sort(byOrder);
  const catOf = (id) => recs.get(id) || { name: 'No category', icon: '❔' };
  const accName = (id) => recs.get(id)?.name || 'Deleted account';

  // The same starting accounts and categories on every device (fixed ids, oldest possible time),
  // so they never double up and any change you make wins.
  const DEFAULTS = [
    ['acc-cash', 'acc', 'Cash', '💵'], ['acc-bank', 'acc', 'Bank account', '🏦'],
    ['cat-groceries', 'exp', 'Groceries', '🛒'], ['cat-food', 'exp', 'Food & dining', '🍽️'],
    ['cat-transport', 'exp', 'Transport & fuel', '⛽'], ['cat-home', 'exp', 'Rent & home', '🏠'],
    ['cat-bills', 'exp', 'Bills & recharge', '💡'], ['cat-shopping', 'exp', 'Shopping', '🛍️'],
    ['cat-health', 'exp', 'Health', '💊'], ['cat-education', 'exp', 'Education', '📚'],
    ['cat-family', 'exp', 'Family & gifts', '🎁'], ['cat-fun', 'exp', 'Entertainment', '🎬'],
    ['cat-work', 'exp', 'Work & business', '💼'], ['cat-other', 'exp', 'Other', '📦'],
    ['cat-salary', 'inc', 'Salary', '💰'], ['cat-business', 'inc', 'Business income', '📈'],
    ['cat-interest', 'inc', 'Interest & returns', '🪙'], ['cat-otherin', 'inc', 'Other income', '➕'],
  ];
  function seed() {
    DEFAULTS.forEach(([id, kind, name, icon], o) => {
      if (recs.has(id)) return;
      recs.set(id, kind === 'acc' ? { id, k: 'acc', name, icon, open: 0, o, t: 1 } : { id, k: 'cat', type: kind, name, icon, o, t: 1 });
    });
  }

  // ---------- Sums ----------
  function balances() {
    const bal = new Map(accounts().map((a) => [a.id, a.open || 0]));
    const add = (id, p) => { if (bal.has(id)) bal.set(id, bal.get(id) + p); };
    for (const t of all('tx')) {
      if (t.type === 'exp') add(t.acc, -t.p);
      else if (t.type === 'inc') add(t.acc, t.p);
      else { add(t.acc, -t.p); add(t.to, t.p); }
    }
    return bal;
  }
  const txIn = (from, to) => all('tx').filter((t) => t.date >= from && t.date <= to);
  const monthTx = (m) => all('tx').filter((t) => t.date.startsWith(m));
  function totals(list) {
    let inc = 0, exp = 0;
    for (const t of list) { if (t.type === 'inc') inc += t.p; else if (t.type === 'exp') exp += t.p; }
    return { inc, exp, net: inc - exp };
  }
  const sortTx = (a, b) => b.date.localeCompare(a.date) || (b.c || b.t) - (a.c || a.t);

  // ---------- Sync with your other devices ----------
  let syncTimer = null, syncing = false, syncAgain = false;
  function syncState(text) { $('syncState').textContent = text; }
  function queueSync(delay = 1200) {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(sync, delay);
  }
  async function sync() {
    if (syncing) { syncAgain = true; return; }
    syncing = true;
    syncState('Syncing…');
    try {
      let data = null;
      do {
        const out = [...dirty].slice(0, 1000).map((id) => recs.get(id)).filter(Boolean);
        const sent = new Map(out.map((r) => [r.id, r.t]));
        const res = out.length
          ? await fetch('/api/finance', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ records: out }) })
          : await fetch('/api/finance', { cache: 'no-store' });
        if (res.status === 404) throw new Error('signed-out');
        if (!res.ok) throw new Error(String(res.status));
        data = await res.json();
        // Anything changed again while this was on its way stays queued.
        for (const [id, t] of sent) if (recs.get(id)?.t === t) dirty.delete(id);
        if (!out.length) break;
      } while (dirty.size);
      let changed = false;
      for (const r of data?.records || []) {
        const mine = recs.get(r.id);
        if (!mine || r.t > mine.t) { recs.set(r.id, r); dirty.delete(r.id); changed = true; }
      }
      save();
      syncState('Synced · ' + new Date().toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' }));
      if (changed) render();
    } catch (error) {
      syncState(error.message === 'signed-out' ? 'Not signed in — saved on this device' : 'Offline — saved on this device');
      clearTimeout(syncTimer);
      syncTimer = setTimeout(sync, 30000);
    } finally {
      syncing = false;
      if (syncAgain) { syncAgain = false; queueSync(300); }
    }
  }

  // ---------- Small UI helpers ----------
  let toastTimer = null;
  function toast(text) {
    const el = $('toast');
    el.textContent = text;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
  }
  const lastUsed = () => { try { return JSON.parse(localStorage.getItem(LAST_KEY) || '{}'); } catch { return {}; } };
  const remember = (v) => { try { localStorage.setItem(LAST_KEY, JSON.stringify({ ...lastUsed(), ...v })); } catch {} };
  const opt = (value, label, selected) => `<option value="${esc(value)}"${selected ? ' selected' : ''}>${esc(label)}</option>`;
  const accOptions = (sel) => accounts().map((a) => opt(a.id, `${a.icon || ''} ${a.name}`.trim(), a.id === sel)).join('');

  // Hover / tap details on chart marks ([data-tip]: first line bold, lines split by "|").
  function showTip(el, x, y) {
    const tip = $('tip');
    const [head, ...rest] = String(el.dataset.tip).split('|');
    tip.innerHTML = `<b>${esc(head)}</b>${rest.map(esc).join('<br>')}`;
    tip.hidden = false;
    const w = tip.offsetWidth, h = tip.offsetHeight;
    tip.style.left = Math.max(8, Math.min(innerWidth - w - 8, x + 12)) + 'px';
    tip.style.top = Math.max(8, y - h - 12) + 'px';
    document.querySelectorAll('.hit.on').forEach((n) => n.classList.remove('on'));
    if (el.classList.contains('hit')) el.classList.add('on');
  }
  function hideTip() {
    $('tip').hidden = true;
    document.querySelectorAll('.hit.on').forEach((n) => n.classList.remove('on'));
  }
  document.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse') return;
    const el = e.target.closest?.('[data-tip]');
    if (el) showTip(el, e.clientX, e.clientY); else hideTip();
  });
  document.addEventListener('click', (e) => {
    const el = e.target.closest?.('[data-tip]');
    if (el) showTip(el, e.clientX, e.clientY); else hideTip();
  });
  addEventListener('scroll', hideTip, { passive: true });

  // ---------- Views ----------
  const S = { view: 'home', month: thisMonth(), rMonth: thisMonth(), q: '', type: 'all', cat: '' };
  const main = $('main');

  function txRow(t) {
    const c = t.type === 'xfer' ? { icon: '🔁', name: 'Transfer' } : catOf(t.cat);
    const sub = t.type === 'xfer' ? `${accName(t.acc)} → ${accName(t.to)}` : accName(t.acc);
    const amt = t.type === 'inc' ? `<span class="in">+${money(t.p)}</span>` : t.type === 'exp' ? `−${money(t.p)}` : money(t.p);
    return `<button type="button" class="row" data-act="edit-tx" data-id="${esc(t.id)}">
      <span class="ico" aria-hidden="true">${esc(c.icon || '•')}</span>
      <span class="mid"><b>${esc(t.note || c.name)}</b><small>${esc(t.note ? `${c.name} · ${sub}` : sub)}</small></span>
      <span class="amt num">${amt}</span></button>`;
  }

  function budgetMeters(m) {
    const spent = new Map();
    for (const t of monthTx(m)) if (t.type === 'exp') spent.set(t.cat, (spent.get(t.cat) || 0) + t.p);
    const rows = cats('exp').filter((c) => c.budget > 0).map((c) => ({ c, used: spent.get(c.id) || 0 }))
      .sort((a, b) => b.used / b.c.budget - a.used / a.c.budget);
    if (!rows.length) return '';
    return `<div class="meters">${rows.map(({ c, used }) => {
      const pct = used / c.budget;
      const [cls, icon, note] = pct > 1 ? ['s-critical', '✕', `Over by ${money(used - c.budget)}`]
        : pct >= 0.8 ? ['s-warning', '!', `Nearly used — ${money(c.budget - used)} left`]
          : ['s-good', '✓', `${money(c.budget - used)} left`];
      return `<div><div class="meter-top"><span>${esc(c.icon)} ${esc(c.name)}</span><span class="num">${money(used)} of ${money(c.budget)}</span></div>
        <div class="meter-track"><div class="meter-fill ${cls}" style="width:${Math.min(100, Math.max(1, pct * 100)).toFixed(1)}%"></div></div>
        <div class="meter-note"><span class="s-ico ${cls}" aria-hidden="true">${icon}</span>${esc(note)}</div></div>`;
    }).join('')}</div>`;
  }

  function billRow(b) {
    const late = b.next < today();
    const when = late ? `<span class="tag late">Overdue · ${esc(dayLabel(b.next))}</span>` : `<span class="tag">${esc(dayLabel(b.next))}</span>`;
    return `<div class="row">
      <span class="ico" aria-hidden="true">${esc(catOf(b.cat).icon || '🧾')}</span>
      <span class="mid"><b>${esc(b.name)}</b><small>${when} ${b.p ? money(b.p) : ''}</small></span>
      <button type="button" class="btn small primary" data-act="pay-bill" data-id="${esc(b.id)}">Paid</button></div>`;
  }

  function dueTotals() {
    let owedToMe = 0, iOwe = 0;
    for (const d of all('due')) if (!d.done) { if (d.dir === 'lent') owedToMe += d.p; else iOwe += d.p; }
    return { owedToMe, iOwe };
  }

  function renderHome() {
    const bal = balances();
    const worth = [...bal.values()].reduce((a, b) => a + b, 0);
    const m = thisMonth();
    const mt = totals(monthTx(m));
    const todaySpent = totals(txIn(today(), today())).exp;
    const soon = all('bill').filter((b) => !b.done && b.next <= addDays(today(), 7)).sort((a, b) => a.next.localeCompare(b.next));
    const recent = all('tx').sort(sortTx).slice(0, 6);
    const meters = budgetMeters(m);
    const dues = dueTotals();
    const hello = new Date().getHours() < 12 ? 'Good morning' : new Date().getHours() < 17 ? 'Good afternoon' : 'Good evening';
    main.innerHTML = `<section class="view">
      <div class="card hero">
        <div class="label">${hello} · Money in all accounts</div>
        <div class="big num">${money(worth)}</div>
        <div class="acc-chips">${accounts().map((a) => `<button type="button" class="acc-chip" data-act="edit-acc" data-id="${esc(a.id)}">${esc(a.icon || '')} ${esc(a.name)}<b class="num">${money(bal.get(a.id) || 0)}</b></button>`).join('')}</div>
      </div>
      <div class="stats">
        <div class="stat"><span>Spent today</span><b class="num">${money(todaySpent)}</b></div>
        <div class="stat"><span>Spent in ${esc(monthName(m, { month: 'short' }))}</span><b class="num">${money(mt.exp)}</b></div>
        <div class="stat"><span>Income in ${esc(monthName(m, { month: 'short' }))}</span><b class="num in">${money(mt.inc)}</b></div>
      </div>
      ${soon.length ? `<div class="card"><h2>Bills due soon <button type="button" class="link-btn" data-go="more" data-anchor="bills">All bills</button></h2><div class="list">${soon.map(billRow).join('')}</div></div>` : ''}
      ${meters ? `<div class="card"><h2>Budgets · ${esc(monthName(m, { month: 'long' }))}</h2>${meters}</div>` : ''}
      ${dues.owedToMe || dues.iOwe ? `<div class="stats" style="grid-template-columns:1fr 1fr">
        <button type="button" class="stat" data-go="more" data-anchor="dues" style="text-align:left"><span>Others owe you</span><b class="num in">${money(dues.owedToMe)}</b></button>
        <button type="button" class="stat" data-go="more" data-anchor="dues" style="text-align:left"><span>You owe others</span><b class="num">${money(dues.iOwe)}</b></button></div>` : ''}
      <div class="card"><h2>Recent records ${recent.length ? '<button type="button" class="link-btn" data-go="tx">See all</button>' : ''}</h2>
        ${recent.length ? `<div class="list">${recent.map(txRow).join('')}</div>` : `<div class="empty"><b>📝</b>Tap the <strong>+</strong> button to record your first expense or income.<br><span class="hint">Tip: type 120+45 to add up a few amounts.</span></div>`}
      </div>
    </section>`;
  }

  function monthBar(key) {
    const m = S[key];
    return `<div class="month-bar">
      <button type="button" class="icon-btn" data-month="${key}" data-step="-1" aria-label="Previous month">‹</button>
      <h2>${esc(monthName(m))}</h2>
      <button type="button" class="icon-btn" data-month="${key}" data-step="1" aria-label="Next month"${m >= thisMonth() ? ' disabled' : ''}>›</button></div>`;
  }

  function renderTx() {
    const q = S.q.trim().toLowerCase();
    const base = monthTx(S.month);
    const list = base.filter((t) => (S.type === 'all' || t.type === S.type) && (!S.cat || t.cat === S.cat))
      .filter((t) => !q || [t.note, catOf(t.cat).name, accName(t.acc), plain(t.p)].join(' ').toLowerCase().includes(q))
      .sort(sortTx);
    const mt = totals(list);
    const days = new Map();
    for (const t of list) { if (!days.has(t.date)) days.set(t.date, []); days.get(t.date).push(t); }
    const pill = (v, label) => `<button type="button" class="pill" data-type="${v}" aria-pressed="${S.type === v}">${label}</button>`;
    main.innerHTML = `<section class="view">
      ${monthBar('month')}
      <div class="stats">
        <div class="stat"><span>Income</span><b class="num in">${money(mt.inc)}</b></div>
        <div class="stat"><span>Spent</span><b class="num">${money(mt.exp)}</b></div>
        <div class="stat"><span>Left</span><b class="num${mt.net >= 0 ? ' in' : ''}">${money(mt.net)}</b></div>
      </div>
      <div class="filters">
        <input type="search" id="txSearch" placeholder="Search notes, category, amount…" value="${esc(S.q)}" aria-label="Search records">
        <select id="txCat" aria-label="Category"><option value="">All categories</option>${cats().map((c) => opt(c.id, `${c.icon} ${c.name}`, c.id === S.cat)).join('')}</select>
        <div class="pills">${pill('all', 'All')}${pill('exp', 'Spent')}${pill('inc', 'Income')}${pill('xfer', 'Transfers')}</div>
      </div>
      <div id="txList">${list.length ? [...days].map(([d, ts]) => {
        const dt = totals(ts);
        return `<div class="day-head"><span>${esc(dayLabel(d))}</span><span class="num">${dt.exp ? '−' + money(dt.exp) : ''}${dt.inc ? ` <span class="in">+${money(dt.inc)}</span>` : ''}</span></div>
          <div class="day-group list">${ts.map(txRow).join('')}</div>`;
      }).join('') : `<div class="card empty"><b>🔍</b>${base.length ? 'Nothing matches this search.' : `No records in ${esc(monthName(S.month))}.`}</div>`}</div>
    </section>`;
    const search = $('txSearch');
    search.addEventListener('input', () => {
      S.q = search.value;
      const pos = search.selectionStart;
      renderTx();
      const again = $('txSearch');
      again.focus();
      again.setSelectionRange(pos, pos);
    });
    $('txCat').addEventListener('change', (e) => { S.cat = e.target.value; renderTx(); });
  }

  function niceMax(v) {
    const e = 10 ** Math.floor(Math.log10(v));
    const f = v / e;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * e;
  }
  function barPath(x, y, w, h) {
    if (h <= 0) return '';
    const r = Math.min(4, h, w / 2);
    return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
  }
  // Income and spending for the six months up to the chosen one: grouped bars on one axis.
  function trendChart(months, width) {
    const h = 210, padL = 46, padR = 6, padT = 18, padB = 24;
    const top = niceMax(Math.max(100, ...months.flatMap((m) => [m.inc, m.exp])));
    const y = (p) => padT + (h - padT - padB) * (1 - p / top);
    const cw = (width - padL - padR) / months.length;
    const bw = Math.max(6, Math.min(24, (cw - 16) / 2));
    let svg = '';
    for (let i = 0; i <= 4; i++) {
      const v = (top * i) / 4, yy = y(v);
      svg += `<line class="${i ? 'grid' : 'base'}" x1="${padL}" x2="${width - padR}" y1="${yy}" y2="${yy}"/><text x="${padL - 6}" y="${yy + 4}" text-anchor="end">${esc(compact(v))}</text>`;
    }
    months.forEach((m, i) => {
      const cx = padL + i * cw + cw / 2;
      const x1 = cx - bw - 1, x2 = cx + 1;
      svg += `<path d="${barPath(x1, y(m.inc), bw, y(0) - y(m.inc))}" fill="var(--s1)"/><path d="${barPath(x2, y(m.exp), bw, y(0) - y(m.exp))}" fill="var(--s2)"/>`;
      svg += `<text x="${cx}" y="${h - 6}" text-anchor="middle">${esc(monthName(m.m, { month: 'short' }))}</text>`;
      svg += `<rect class="hit" x="${padL + i * cw}" y="${padT - 14}" width="${cw}" height="${h - padT - padB + 14}" rx="6" data-tip="${esc(`${monthName(m.m)}|Income ${money(m.inc)}|Spent ${money(m.exp)}|${m.inc - m.exp >= 0 ? 'Saved' : 'Overspent'} ${money(Math.abs(m.inc - m.exp))}`)}"/>`;
    });
    return `<svg viewBox="0 0 ${width} ${h}" width="${width}" height="${h}" role="img" aria-label="Income and spending for the last six months">${svg}</svg>`;
  }

  function renderReports() {
    const m = S.rMonth;
    const list = monthTx(m);
    const mt = totals(list);
    const rate = mt.inc > 0 ? Math.round((mt.net / mt.inc) * 100) : null;
    const byCat = new Map();
    for (const t of list) if (t.type === 'exp') {
      const e = byCat.get(t.cat) || { p: 0, n: 0 };
      e.p += t.p; e.n += 1;
      byCat.set(t.cat, e);
    }
    const rows = [...byCat].sort((a, b) => b[1].p - a[1].p);
    const maxCat = rows[0]?.[1].p || 1;
    const lastDay = m === thisMonth() ? new Date().getDate() : daysInMonth(+m.slice(0, 4), +m.slice(5) - 1);
    const biggest = list.filter((t) => t.type === 'exp').sort((a, b) => b.p - a.p)[0];
    const months = Array.from({ length: 6 }, (_, i) => shiftMonth(m, i - 5)).map((mm) => ({ m: mm, ...totals(monthTx(mm)) }));
    main.innerHTML = `<section class="view">
      ${monthBar('rMonth')}
      <div class="stats four">
        <div class="stat"><span>Income</span><b class="num in">${money(mt.inc)}</b></div>
        <div class="stat"><span>Spent</span><b class="num">${money(mt.exp)}</b></div>
        <div class="stat"><span>${mt.net >= 0 ? 'Saved' : 'Overspent'}</span><b class="num${mt.net >= 0 ? ' in' : ''}">${money(Math.abs(mt.net))}</b></div>
        <div class="stat"><span>Savings rate</span><b class="num">${rate === null ? '—' : rate + '%'}</b><small>of income kept</small></div>
      </div>
      <div class="card"><h2>Where the money went <small>${rows.length ? `${money(Math.round(mt.exp / lastDay))} a day on average` : ''}</small></h2>
        ${rows.length ? `<div class="hbars">${rows.map(([id, e]) => {
          const c = catOf(id);
          const share = Math.round((e.p / mt.exp) * 100);
          return `<div class="hb" data-tip="${esc(`${c.name}|${money(e.p)} · ${share}% of spending|${e.n} record${e.n === 1 ? '' : 's'}`)}">
            <div class="hb-lbl"><span>${esc(c.icon)} ${esc(c.name)}</span><span class="num">${money(e.p)} · ${share}%</span></div>
            <div class="hb-fill" style="width:${((e.p / maxCat) * 100).toFixed(1)}%"></div></div>`;
        }).join('')}</div>
        ${biggest ? `<p class="hint" style="margin-top:14px">Biggest expense: <strong>${money(biggest.p)}</strong> — ${esc(biggest.note || catOf(biggest.cat).name)} (${esc(dayLabel(biggest.date))})</p>` : ''}`
        : '<div class="empty"><b>📊</b>No spending recorded this month.</div>'}
      </div>
      <div class="card"><h2>Last 6 months</h2>
        <div class="legend"><span><i style="background:var(--s1)"></i>Income <b class="num">${money(mt.inc)}</b></span><span><i style="background:var(--s2)"></i>Spent <b class="num">${money(mt.exp)}</b></span><span>in ${esc(monthName(m, { month: 'short' }))}</span></div>
        <div class="chart" id="trend"></div>
        <details class="table"><summary>Show as table</summary>
          <table><thead><tr><th>Month</th><th>Income</th><th>Spent</th><th>Left</th></tr></thead><tbody>
          ${months.map((x) => `<tr><td>${esc(monthName(x.m, { month: 'short', year: 'numeric' }))}</td><td>${money(x.inc)}</td><td>${money(x.exp)}</td><td>${money(x.net)}</td></tr>`).join('')}
          </tbody></table></details>
      </div>
    </section>`;
    const box = $('trend');
    box.innerHTML = trendChart(months, Math.max(280, box.clientWidth));
    box.dataset.months = JSON.stringify(months);
  }
  let resizeTimer = null;
  addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const box = $('trend');
      if (box?.dataset.months) box.innerHTML = trendChart(JSON.parse(box.dataset.months), Math.max(280, box.clientWidth));
    }, 150);
  });

  let installEvent = null;
  addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvent = e; if (S.view === 'more') render(); });

  function renderMore() {
    const bal = balances();
    const bills = all('bill').filter((b) => !b.done).sort((a, b) => a.next.localeCompare(b.next));
    const dues = all('due').sort((a, b) => (a.done ? 1 : 0) - (b.done ? 1 : 0) || b.date.localeCompare(a.date));
    const dt = dueTotals();
    const txCount = all('tx').length;
    main.innerHTML = `<section class="view">
      <div class="card" id="accounts"><h2>Accounts <button type="button" class="btn small" data-act="new-acc">+ Add</button></h2>
        <div class="list">${accounts().map((a) => `<button type="button" class="row" data-act="edit-acc" data-id="${esc(a.id)}">
          <span class="ico" aria-hidden="true">${esc(a.icon || '🏦')}</span><span class="mid"><b>${esc(a.name)}</b><small>Opening balance ${money(a.open || 0)}</small></span>
          <span class="amt num">${money(bal.get(a.id) || 0)}</span></button>`).join('')}</div>
        <p class="hint">Cash in hand, bank, UPI wallet, credit card (use a minus opening balance for money owed on the card).</p>
      </div>

      <div class="card" id="bills"><h2>Bills &amp; reminders <button type="button" class="btn small" data-act="new-bill">+ Add</button></h2>
        ${bills.length ? `<div class="list">${bills.map((b) => `<div class="row">
          <span class="ico" aria-hidden="true">${esc(catOf(b.cat).icon || '🧾')}</span>
          <button type="button" class="mid" data-act="edit-bill" data-id="${esc(b.id)}" style="border:0;background:none;text-align:left;padding:0">
            <b>${esc(b.name)}</b><small>${esc(dayLabel(b.next))} · ${esc({ week: 'Every week', month: 'Every month', quarter: 'Every 3 months', year: 'Every year', once: 'One time' }[b.every] || '')}${b.p ? ' · ' + money(b.p) : ''}</small></button>
          <button type="button" class="btn small primary" data-act="pay-bill" data-id="${esc(b.id)}">Paid</button></div>`).join('')}</div>`
        : '<p class="hint">Rent, electricity, phone recharge, EMI, insurance, school fees… Add them once and they show on Home when due.</p>'}
      </div>

      <div class="card" id="dues"><h2>Lent &amp; borrowed <button type="button" class="btn small" data-act="new-due">+ Add</button></h2>
        ${dues.length ? `<p class="hint" style="margin-bottom:6px">Others owe you <strong class="in">${money(dt.owedToMe)}</strong> · You owe <strong>${money(dt.iOwe)}</strong></p>
        <div class="list">${dues.map((d) => `<button type="button" class="row" data-act="edit-due" data-id="${esc(d.id)}"${d.done ? ' style="opacity:.55"' : ''}>
          <span class="ico" aria-hidden="true">${d.dir === 'lent' ? '🤝' : '🙏'}</span>
          <span class="mid"><b>${esc(d.person)}</b><small>${d.dir === 'lent' ? 'You gave' : 'You took'} · ${esc(dayLabel(d.date))}${d.note ? ' · ' + esc(d.note) : ''}${d.done ? ' · Settled' : ''}</small></span>
          <span class="amt num">${d.dir === 'lent' ? `<span class="in">${money(d.p)}</span>` : money(d.p)}</span></button>`).join('')}</div>`
        : '<p class="hint">Keep track of money you gave to or took from friends and family.</p>'}
      </div>

      <div class="card" id="categories"><h2>Categories &amp; budgets <button type="button" class="btn small" data-act="new-cat">+ Add</button></h2>
        <div class="list">${cats().map((c) => `<button type="button" class="row" data-act="edit-cat" data-id="${esc(c.id)}">
          <span class="ico" aria-hidden="true">${esc(c.icon)}</span><span class="mid"><b>${esc(c.name)}</b><small>${c.type === 'inc' ? 'Income' : c.budget ? `Budget ${money(c.budget)} a month` : 'No budget set'}</small></span></button>`).join('')}</div>
      </div>

      <div class="card"><h2>Backup &amp; sync</h2>
        <p class="hint" style="margin-bottom:12px">${txCount} record${txCount === 1 ? '' : 's'}. ${esc($('syncState').textContent)}. Your records are saved on this device and in your private TenderOne store, so they show on every device you sign in on.</p>
        <div class="btn-row">
          <button type="button" class="btn" data-act="sync">Sync now</button>
          <button type="button" class="btn" data-act="csv">Download Excel (CSV)</button>
          <button type="button" class="btn" data-act="backup">Download backup</button>
          <label class="btn">Restore backup<input type="file" id="restoreFile" accept="application/json,.json" hidden></label>
          ${installEvent ? '<button type="button" class="btn primary" data-act="install">Install as app</button>' : ''}
        </div>
      </div>
      <p class="hint" style="text-align:center"><a href="/">← Back to TenderOne</a></p>
    </section>`;
    $('restoreFile').addEventListener('change', restore);
  }

  function render() {
    hideTip();
    document.querySelectorAll('.tabs button').forEach((b) => { if (b.dataset.view === S.view) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
    ({ home: renderHome, tx: renderTx, reports: renderReports, more: renderMore })[S.view]();
  }
  function go(view, anchor) {
    S.view = view;
    render();
    if (anchor) document.getElementById(anchor)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    else scrollTo(0, 0);
    try { history.replaceState(null, '', view === 'home' ? '/finance/' : `/finance/#${view}`); } catch {}
  }

  // ---------- Forms ----------
  const sheet = $('sheet');
  const form = $('sheetForm');
  let onSubmit = null;
  sheet.addEventListener('click', (e) => { if (e.target === sheet || e.target.closest('[data-close]')) sheet.close(); });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const err = onSubmit?.(new FormData(form));
    if (err) { const box = form.querySelector('.err'); box.textContent = err; box.hidden = false; return; }
    sheet.close();
    render();
  });
  function openSheet(title, body, submit, { onDelete, saveLabel = 'Save' } = {}) {
    form.innerHTML = `<div class="sheet-head"><h2 id="sheetTitle">${esc(title)}</h2><button type="button" class="x" data-close aria-label="Close">×</button></div>
      ${body}<p class="err" hidden></p>
      <div class="sheet-actions">${onDelete ? '<button type="button" class="btn danger" data-del>Delete</button>' : ''}<button type="submit" class="btn primary">${esc(saveLabel)}</button></div>`;
    onSubmit = submit;
    form.querySelector('[data-del]')?.addEventListener('click', () => {
      if (!confirm('Delete this? It is removed from all your devices.')) return;
      onDelete();
      sheet.close();
      render();
      toast('Deleted');
    });
    sheet.showModal();
    const first = form.querySelector('[autofocus]');
    if (first && matchMedia('(pointer: fine)').matches) first.focus();
  }
  const field = (label, input, help = '') => `<label class="field">${esc(label)}${input}${help ? `<span class="help">${esc(help)}</span>` : ''}</label>`;
  const seg = (name, items, value) => `<div class="seg" role="radiogroup">${items.map(([v, l]) => `<label><input type="radio" name="${name}" value="${v}"${v === value ? ' checked' : ''}><span>${esc(l)}</span></label>`).join('')}</div>`;

  // Add or edit a record (expense, income or transfer).
  function openTx(t = null, prefill = {}, after = null) {
    const last = lastUsed();
    const v = t ? { ...t } : { type: last.type || 'exp', acc: last.acc, date: today(), ...prefill };
    if (!recs.has(v.acc) || recs.get(v.acc).del) v.acc = accounts()[0]?.id;
    const notes = [...new Set(all('tx').sort(sortTx).map((x) => x.note).filter(Boolean))].slice(0, 40);
    const body = `${seg('type', [['exp', 'Spent'], ['inc', 'Income'], ['xfer', 'Transfer']], v.type)}
      <label class="amount-in"><span>₹</span><input name="amt" inputmode="decimal" autocomplete="off" placeholder="0" value="${v.p ? plain(v.p) : ''}" aria-label="Amount" autofocus></label>
      <div class="field" id="catField"><span>Category</span><div class="cat-grid" id="catGrid"></div></div>
      <div class="two">
        ${field(v.type === 'xfer' ? 'From account' : 'Account', `<select name="acc">${accOptions(v.acc)}</select>`)}
        <div id="toField">${field('To account', `<select name="to">${accOptions(v.to || accounts().find((a) => a.id !== v.acc)?.id)}</select>`)}</div>
        <div id="dateField">${field('Date', `<input type="date" name="date" value="${esc(v.date)}" required>`)}</div>
      </div>
      ${field('Note', `<input name="note" maxlength="120" value="${esc(v.note || '')}" placeholder="e.g. vegetables, petrol, auto fare" list="noteHints" autocomplete="off">`)}
      <datalist id="noteHints">${notes.map((n) => `<option value="${esc(n)}">`).join('')}</datalist>`;
    openSheet(t ? 'Edit record' : 'Add record', body, (fd) => {
      const type = fd.get('type');
      const p = toPaise(fd.get('amt'));
      if (!(p > 0)) return 'Enter an amount above zero.';
      const date = String(fd.get('date') || '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return 'Pick a date.';
      const acc = String(fd.get('acc') || '');
      if (!acc) return 'Add an account first (More → Accounts).';
      const rec = { id: t?.id || newId('tx'), k: 'tx', type, p, acc, date, note: String(fd.get('note') || '').trim(), c: t?.c || Date.now() };
      if (type === 'xfer') {
        rec.to = String(fd.get('to') || '');
        if (!rec.to || rec.to === acc) return 'Pick two different accounts for a transfer.';
      } else {
        rec.cat = String(fd.get('cat') || '');
        if (!rec.cat) return 'Pick a category.';
      }
      put(rec);
      remember({ type, acc });
      after?.(rec);
      toast(t ? 'Saved' : `${type === 'inc' ? 'Income' : type === 'exp' ? 'Expense' : 'Transfer'} of ${money(p)} recorded`);
    }, { onDelete: t ? () => remove(t.id) : null });
    const layout = () => {
      const type = form.querySelector('[name=type]:checked').value;
      const chosen = form.querySelector('[name=cat]:checked')?.value || v.cat;
      const list = cats(type === 'inc' ? 'inc' : 'exp');
      $('catGrid').innerHTML = list.map((c) => `<label><input type="radio" name="cat" value="${esc(c.id)}"${c.id === chosen ? ' checked' : ''}><span><i aria-hidden="true">${esc(c.icon)}</i>${esc(c.name)}</span></label>`).join('');
      $('catField').hidden = type === 'xfer';
      $('toField').hidden = type !== 'xfer';
      form.querySelector('[name=acc]').closest('.field').firstChild.textContent = type === 'xfer' ? 'From account' : 'Account';
    };
    form.querySelectorAll('[name=type]').forEach((r) => r.addEventListener('change', layout));
    layout();
  }

  function openAcc(a = null) {
    const body = `${field('Name', `<input name="name" maxlength="40" required value="${esc(a?.name || '')}" placeholder="e.g. SBI savings, PhonePe wallet, HDFC card" autofocus>`)}
      <div class="two">${field('Icon', `<input name="icon" maxlength="4" value="${esc(a?.icon || '🏦')}">`)}
      ${field('Opening balance (₹)', `<input name="open" inputmode="decimal" value="${a?.open ? plain(a.open) : ''}" placeholder="0">`, 'Money in it before your first record.')}</div>`;
    openSheet(a ? 'Edit account' : 'Add account', body, (fd) => {
      const name = String(fd.get('name') || '').trim();
      if (!name) return 'Give the account a name.';
      const raw = String(fd.get('open') || '').trim();
      const open = raw ? toPaise(raw) : 0;
      if (!Number.isFinite(open)) return 'The opening balance is not a number.';
      put({ ...(a || { id: newId('acc'), k: 'acc', o: 100 + accounts().length }), name, icon: String(fd.get('icon') || '').trim() || '🏦', open });
    }, { onDelete: a ? () => remove(a.id) : null });
  }

  function openCat(c = null) {
    const type = c?.type || 'exp';
    const body = `${c ? '' : seg('type', [['exp', 'Spending'], ['inc', 'Income']], type)}
      ${field('Name', `<input name="name" maxlength="40" required value="${esc(c?.name || '')}" placeholder="e.g. Milk, Petrol, Kids" autofocus>`)}
      <div class="two">${field('Icon', `<input name="icon" maxlength="4" value="${esc(c?.icon || '📦')}">`)}
      <div id="budgetField">${field('Monthly budget (₹)', `<input name="budget" inputmode="decimal" value="${c?.budget ? plain(c.budget) : ''}" placeholder="No limit">`)}</div></div>`;
    openSheet(c ? 'Edit category' : 'Add category', body, (fd) => {
      const name = String(fd.get('name') || '').trim();
      if (!name) return 'Give the category a name.';
      const t = c?.type || fd.get('type');
      const raw = String(fd.get('budget') || '').trim();
      const budget = t === 'exp' && raw ? toPaise(raw) : 0;
      if (!Number.isFinite(budget) || budget < 0) return 'The budget is not a number.';
      put({ ...(c || { id: newId('cat'), k: 'cat', type: t, o: 100 + cats().length }), name, icon: String(fd.get('icon') || '').trim() || '📦', budget });
    }, { onDelete: c ? () => remove(c.id) : null });
    const sync = () => { $('budgetField').hidden = (c?.type || form.querySelector('[name=type]:checked')?.value) === 'inc'; };
    form.querySelectorAll('[name=type]').forEach((r) => r.addEventListener('change', sync));
    sync();
  }

  function openBill(b = null) {
    const body = `${field('What', `<input name="name" maxlength="60" required value="${esc(b?.name || '')}" placeholder="e.g. House rent, Electricity, Jio recharge, Bike EMI" autofocus>`)}
      <div class="two">${field('Amount (₹)', `<input name="amt" inputmode="decimal" value="${b?.p ? plain(b.p) : ''}" placeholder="Changes each time">`)}
      ${field('Next due', `<input type="date" name="next" required value="${esc(b?.next || today())}">`)}</div>
      <div class="two">${field('Repeats', `<select name="every">${[['month', 'Every month'], ['week', 'Every week'], ['quarter', 'Every 3 months'], ['year', 'Every year'], ['once', 'One time']].map(([v, l]) => opt(v, l, v === (b?.every || 'month'))).join('')}</select>`)}
      ${field('Category', `<select name="cat">${cats('exp').map((c) => opt(c.id, `${c.icon} ${c.name}`, c.id === (b?.cat || 'cat-bills'))).join('')}</select>`)}</div>
      ${field('Pay from', `<select name="acc">${accOptions(b?.acc || lastUsed().acc)}</select>`)}`;
    openSheet(b ? 'Edit bill' : 'Add bill or reminder', body, (fd) => {
      const name = String(fd.get('name') || '').trim();
      if (!name) return 'Say what the bill is.';
      const raw = String(fd.get('amt') || '').trim();
      const p = raw ? toPaise(raw) : 0;
      if (!Number.isFinite(p) || p < 0) return 'The amount is not a number.';
      const next = String(fd.get('next') || '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(next)) return 'Pick the next due date.';
      put({ ...(b || { id: newId('bill'), k: 'bill' }), name, p, next, dom: +next.slice(8), every: String(fd.get('every')), cat: String(fd.get('cat')), acc: String(fd.get('acc')) });
    }, { onDelete: b ? () => remove(b.id) : null });
  }

  // "Paid": record the payment, then move the bill to its next due date.
  function payBill(b) {
    openTx(null, { type: 'exp', p: b.p, cat: b.cat, acc: b.acc, note: b.name }, () => {
      const cur = recs.get(b.id);
      if (!cur || cur.del) return;
      if (cur.every === 'once') put({ ...cur, done: 1 });
      else put({ ...cur, next: nextDue(cur.next, cur.every, cur.dom) });
    });
  }

  function openDue(d = null) {
    const people = [...new Set(all('due').map((x) => x.person))];
    const body = `${seg('dir', [['lent', 'I gave money'], ['borrowed', 'I took money']], d?.dir || 'lent')}
      ${field('Person', `<input name="person" maxlength="60" required value="${esc(d?.person || '')}" list="peopleHints" autocomplete="off" autofocus>`)}
      <datalist id="peopleHints">${people.map((p) => `<option value="${esc(p)}">`).join('')}</datalist>
      <div class="two">${field('Amount (₹)', `<input name="amt" inputmode="decimal" required value="${d?.p ? plain(d.p) : ''}">`)}
      ${field('Date', `<input type="date" name="date" required value="${esc(d?.date || today())}">`)}</div>
      ${field('Note', `<input name="note" maxlength="120" value="${esc(d?.note || '')}" placeholder="e.g. for hospital, return by Diwali">`)}
      ${d ? `<label class="field" style="display:flex;align-items:center;gap:10px"><input type="checkbox" name="done" style="width:22px;height:22px"${d.done ? ' checked' : ''}> Settled — the money is back</label>` : ''}`;
    openSheet(d ? 'Lent / borrowed' : 'Add lent or borrowed money', body, (fd) => {
      const person = String(fd.get('person') || '').trim();
      if (!person) return 'Whose money is it?';
      const p = toPaise(fd.get('amt'));
      if (!(p > 0)) return 'Enter an amount above zero.';
      const date = String(fd.get('date') || '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return 'Pick a date.';
      put({ ...(d || { id: newId('due'), k: 'due' }), dir: String(fd.get('dir')), person, p, date, note: String(fd.get('note') || '').trim(), done: fd.get('done') ? 1 : 0 });
    }, { onDelete: d ? () => remove(d.id) : null });
  }

  // ---------- Backup ----------
  function download(name, text, type) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = Object.assign(document.createElement('a'), { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function exportCsv() {
    const cell = (v) => /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
    const rows = [['Date', 'Type', 'Amount', 'Category', 'Account', 'To account', 'Note']];
    for (const t of all('tx').sort((a, b) => a.date.localeCompare(b.date))) {
      rows.push([t.date, { exp: 'Spent', inc: 'Income', xfer: 'Transfer' }[t.type], plain(t.p), t.type === 'xfer' ? '' : catOf(t.cat).name, accName(t.acc), t.type === 'xfer' ? accName(t.to) : '', t.note || '']);
    }
    download(`my-money-${today()}.csv`, '﻿' + rows.map((r) => r.map(cell).join(',')).join('\r\n'), 'text/csv');
  }
  function exportBackup() {
    const records = [...recs.values()].filter((r) => !r.del);
    download(`my-money-backup-${today()}.json`, JSON.stringify({ app: 'my-money', version: 1, exported: new Date().toISOString(), records }), 'application/json');
  }
  async function restore(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    let data;
    try { data = JSON.parse(await file.text()); } catch { toast('That file is not a My Money backup.'); return; }
    if (data?.app !== 'my-money' || !Array.isArray(data.records)) { toast('That file is not a My Money backup.'); return; }
    let added = 0;
    for (const r of data.records) {
      if (!r || typeof r.id !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(r.id) || !KINDS.has(r.k) || !Number.isFinite(r.t)) continue;
      const mine = recs.get(r.id);
      if (mine && mine.t >= r.t) continue;
      recs.set(r.id, r);
      dirty.add(r.id);
      added++;
    }
    save();
    queueSync(200);
    render();
    toast(added ? `Restored ${added} record${added === 1 ? '' : 's'}` : 'Everything in that backup is already here.');
  }

  // ---------- Wiring ----------
  main.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act],[data-go],[data-month],[data-type]');
    if (!el) return;
    const rec = el.dataset.id ? recs.get(el.dataset.id) : null;
    if (el.dataset.go) return go(el.dataset.go, el.dataset.anchor);
    if (el.dataset.month) {
      S[el.dataset.month] = shiftMonth(S[el.dataset.month], +el.dataset.step);
      return render();
    }
    if (el.dataset.type) { S.type = el.dataset.type; return renderTx(); }
    switch (el.dataset.act) {
      case 'edit-tx': return rec && openTx(rec);
      case 'edit-acc': return rec && openAcc(rec);
      case 'new-acc': return openAcc();
      case 'edit-cat': return rec && openCat(rec);
      case 'new-cat': return openCat();
      case 'edit-bill': return rec && openBill(rec);
      case 'new-bill': return openBill();
      case 'pay-bill': return rec && payBill(rec);
      case 'edit-due': return rec && openDue(rec);
      case 'new-due': return openDue();
      case 'sync': return sync().then(() => S.view === 'more' && render());
      case 'csv': return exportCsv();
      case 'backup': return exportBackup();
      case 'install': return installEvent?.prompt().finally(() => { installEvent = null; render(); });
    }
  });
  document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => go(b.dataset.view)));
  $('addBtn').addEventListener('click', () => openTx());

  function applyTheme() {
    let t = null;
    try { t = localStorage.getItem(THEME_KEY); } catch {}
    if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
    const dark = t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    document.querySelector('meta[name=theme-color]').content = dark ? '#1a1a19' : '#0f766e';
  }
  $('themeBtn').addEventListener('click', () => {
    const dark = getComputedStyle(document.documentElement).colorScheme === 'dark';
    try { localStorage.setItem(THEME_KEY, dark ? 'light' : 'dark'); } catch {}
    applyTheme();
    if (S.view === 'reports') render();
  });

  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { queueSync(100); render(); } });
  addEventListener('online', () => queueSync(100));

  applyTheme();
  load();
  seed();
  const start = location.hash.slice(1);
  S.view = ['tx', 'reports', 'more'].includes(start) ? start : 'home';
  render();
  sync();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/finance/sw.js', { scope: '/finance/' }).catch(() => {});
})();
