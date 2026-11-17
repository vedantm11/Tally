/* Tally — private, on-device expense tracker. All data stays in this browser. */
(function () {
  'use strict';
  const P = window.TallyParser;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtUSD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
  const money = c => fmtUSD.format((c || 0) / 100);
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  const ymOf = d => d.slice(0, 7);
  const monthLabel = (ym, short) => { const [y, m] = ym.split('-').map(Number); const d = new Date(Date.UTC(y, m - 1, 1)); return short ? d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' }) + ' ’' + String(y).slice(2) : d.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }); };
  const addMonth = (ym, n) => { let [y, m] = ym.split('-').map(Number); m += n; while (m < 1) { m += 12; y--; } while (m > 12) { m -= 12; y++; } return `${y}-${String(m).padStart(2, '0')}`; };
  const fmtDay = d => { const [y, m, dd] = d.split('-').map(Number); return new Date(Date.UTC(y, m - 1, dd)).toLocaleString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }); };
  const todayISO = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const toCents = s => { const v = P.parseAmt(String(s).trim().replace(/^\+/, '')); return isNaN(v.cents) ? null : v.cents; };

  const DEFAULT_CATS = [
    ['rent', 'Rent & Housing', '#7c6cf0', 'spend'], ['utilities', 'Utilities', '#3fa7d6', 'spend'], ['groceries', 'Groceries', '#3aa76d', 'spend'],
    ['dining', 'Dining & Drinks', '#e8743b', 'spend'], ['transport', 'Transportation & Gas', '#d4a72c', 'spend'], ['travel', 'Travel', '#2bb3a6', 'spend'],
    ['shopping', 'Shopping', '#d6557a', 'spend'], ['entertainment', 'Entertainment', '#a05fd1', 'spend'], ['subscriptions', 'Subscriptions', '#5b7bd6', 'spend'],
    ['health', 'Health', '#e05a5a', 'spend'], ['personal', 'Personal Care', '#c97bb4', 'spend'], ['gifts', 'Gifts', '#e0a03a', 'spend'],
    ['fees', 'Fees & Interest', '#8a8f98', 'spend'], ['other', 'Other', '#9aa3ad', 'spend'],
    ['income', 'Income', '#2f9e5a', 'income'], ['transfers', 'Transfers & Payments', '#7d8590', 'transfer'],
  ].map(([id, name, color, kind]) => ({ id, name, color, kind }));
  const PERSON_COLORS = ['#d6557a', '#5b7bd6', '#e8743b', '#a05fd1', '#2bb3a6', '#d4a72c', '#e05a5a', '#3aa76d', '#7c6cf0'];
  const ME = { id: 'me', name: 'You', color: '#3d434b' };

  const blankState = () => ({ v: 1, people: [], groups: [], accounts: [], categories: DEFAULT_CATS.map(c => ({ ...c })), rules: {}, txns: [], imports: [], settings: { autoLock: 15 }, lastBackup: null, created: Date.now() });

  // ================= storage (IndexedDB) =================
  const DB = {
    db: null,
    open() { return new Promise((res, rej) => { const r = indexedDB.open('tally', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => { this.db = r.result; res(); }; r.onerror = () => rej(r.error); }); },
    get(k) { return new Promise((res, rej) => { const q = this.db.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); },
    put(k, v) { return new Promise((res, rej) => { const tx = this.db.transaction('kv', 'readwrite'); tx.objectStore('kv').put(v, k); tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); }); },
    del(k) { return new Promise((res, rej) => { const tx = this.db.transaction('kv', 'readwrite'); tx.objectStore('kv').delete(k); tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); }); },
  };

  // ================= encryption (AES-256-GCM, key from PBKDF2-SHA256) =================
  const ITER = 600000;
  const Vault = {
    key: null, salt: null, iter: ITER,
    canCrypto: !!(window.crypto && crypto.subtle),
    async derive(pass, salt, iter) {
      const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']);
      return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    },
    async seal(obj, key) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(obj)));
      return { iv, ct: new Uint8Array(ct) };
    },
    async open(rec, key) {
      const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: rec.iv }, key, rec.ct);
      return JSON.parse(new TextDecoder().decode(pt));
    },
  };
  const b64 = u8 => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
  const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

  let S = null;            // app state (decrypted, in memory only)
  let saveTimer = null, savePromise = Promise.resolve();
  function save() { clearTimeout(saveTimer); saveTimer = setTimeout(flush, 250); }
  function flush() {
    clearTimeout(saveTimer); saveTimer = null;
    if (!S) return savePromise;
    const snapshot = S;
    savePromise = savePromise.then(async () => {
      if (Vault.key) { const { iv, ct } = await Vault.seal(snapshot, Vault.key); await DB.put('state', { enc: true, salt: Vault.salt, iter: Vault.iter, iv, ct }); }
      else await DB.put('state', { enc: false, data: JSON.stringify(snapshot) });
      liveSchedule();
    }).catch(e => toast('Could not save: ' + e.message));
    return savePromise;
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && saveTimer) flush(); });
  window.addEventListener('beforeunload', () => { if (saveTimer) flush(); });

  // ================= derived data =================
  let catMap = {}, acctMap = {}, personMap = {};
  function reindex() {
    catMap = Object.fromEntries(S.categories.map(c => [c.id, c]));
    acctMap = Object.fromEntries(S.accounts.map(a => [a.id, a]));
    personMap = Object.fromEntries([ME, ...S.people].map(p => [p.id, p]));
  }
  const catKind = t => (catMap[t.cat] ? catMap[t.cat].kind : 'spend');
  const initials = n => (n || '?').trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
  const avatar = (pid, extra = '') => { const p = personMap[pid] || { name: '?', color: '#999' }; return `<span class="av" style="background:${esc(p.color)}" title="${esc(p.name)}" ${extra}>${esc(pid === 'me' ? 'Y' : initials(p.name))}</span>`; };

  // split math — returns [[personId, cents], ...]; signs follow the transaction
  function shares(t) {
    const sp = t.split;
    if (!sp || !sp.parts || !sp.parts.length) return [['me', t.amt]];
    const sign = t.amt < 0 ? -1 : 1, abs = Math.abs(t.amt);
    if (sp.mode === 'amount') {
      const out = sp.parts.filter(p => p.p !== 'me').map(p => [p.p, Math.max(0, Math.round(+p.v || 0))]);
      const used = out.reduce((s, x) => s + x[1], 0);
      out.unshift(['me', abs - used]);
      return out.filter(x => x[0] !== 'me' || x[1] !== 0 || out.length === 1).map(([p, c]) => [p, c * sign]);
    }
    let w;
    if (sp.mode === 'percent') {
      const others = sp.parts.filter(p => p.p !== 'me').map(p => [p.p, Math.max(0, +p.v || 0)]);
      const me = Math.max(0, 100 - others.reduce((s, x) => s + x[1], 0));
      w = (sp.parts.some(p => p.p === 'me') || me > 0) ? [['me', me], ...others] : others;
    } else if (sp.mode === 'shares') w = sp.parts.map(p => [p.p, Math.max(0, +p.v || 0)]);
    else w = sp.parts.map(p => [p.p, 1]);
    const W = w.reduce((s, x) => s + x[1], 0);
    if (!W) return [['me', t.amt]];
    const out = w.map(([p, x]) => [p, Math.floor(abs * x / W)]);
    let rem = abs - out.reduce((s, x) => s + x[1], 0);
    for (let i = 0; rem > 0; i = (i + 1) % out.length) if (w[i][1] > 0) { out[i][1]++; rem--; }
    return out.filter(x => x[1] !== 0 || x[0] === 'me').map(([p, c]) => [p, c * sign]);
  }
  const myShare = t => { const s = shares(t).find(x => x[0] === 'me'); return s ? s[1] : 0; };

  function summarize(list) {
    const r = { gross: 0, mine: 0, others: 0, income: 0, byCat: {}, people: {}, peopleCount: {}, review: 0, transfers: 0, count: 0 };
    for (const t of list) {
      if (t.excluded) continue;
      const k = catKind(t);
      if (k === 'transfer') { r.transfers++; continue; }
      if (k === 'income') { r.income -= t.amt; continue; }
      r.count++;
      if (!t.cat) r.review++;
      r.gross += t.amt;
      for (const [p, c] of shares(t)) {
        if (p === 'me') { r.mine += c; const key = t.cat || '_none'; r.byCat[key] = (r.byCat[key] || 0) + c; }
        else { r.others += c; r.people[p] = (r.people[p] || 0) + c; r.peopleCount[p] = (r.peopleCount[p] || 0) + 1; }
      }
    }
    return r;
  }
  // The two queues the app is organised around.
  // Inbox: charges nobody has decided on yet (mine, or shared with whom).
  // To bill: decided, shared, and not yet entered into Splitwise.
  const needsReview = t => !t.rev && !t.excluded && catKind(t) === 'spend';
  // Every transaction list is ordered newest first (the user's stated preference);
  // within a day, the larger amount (by size, not sign) comes first.
  const byRecent = (a, b) => b.date.localeCompare(a.date) || Math.abs(b.amt) - Math.abs(a.amt) || (a.ord || 0) - (b.ord || 0);
  const inboxList = () => S.txns.filter(needsReview).sort(byRecent);
  const billable = t => t.rev && t.split && !t.excluded && catKind(t) === 'spend' && shares(t).some(([p, c]) => p !== 'me' && c);
  const unbilled = () => S.txns.filter(t => billable(t) && !t.billed);
  const othersShare = t => shares(t).reduce((s, [p, c]) => s + (p === 'me' ? 0 : c), 0);
  const groupSplit = g => ({ mode: 'even', parts: ['me', ...g.members.filter(p => personMap[p])].map(p => ({ p, v: 1 })) });
  // a set of people is shown by its group name when one matches exactly
  function partyName(pids) {
    const key = pids.slice().sort().join('|');
    const g = S.groups.find(g => g.members.slice().sort().join('|') === key);
    return g ? g.name : pids.map(p => (personMap[p] || {}).name || '?').join(' + ');
  }
  const monthTx = ym => S.txns.filter(t => t.date.startsWith(ym));
  const monthsWithData = () => [...new Set(S.txns.map(t => ymOf(t.date)))].sort();

  // ================= categorization =================
  function autoCat(desc, amt) {
    const key = P.merchantKey(desc);
    const rule = S.rules[key];
    if (rule && catMap[rule.cat]) return { cat: rule.cat, src: 'rule', split: rule.split || null, mine: !!rule.mine };
    let g = P.guessCategory(desc);
    if (g === 'income' && amt > 0) g = null;
    return { cat: g && catMap[g] ? g : null, src: g ? 'auto' : null, split: rule && rule.split ? rule.split : null, mine: !!(rule && rule.mine) };
  }
  // learn a category for a merchant and apply to its other non-user-set transactions
  function learnCategory(t, cat) {
    const key = P.merchantKey(t.desc);
    S.rules[key] = { ...(S.rules[key] || {}), cat, name: t.name };
    const changed = [];
    for (const u of S.txns) if (u !== t && u.catSrc !== 'user' && u.cat !== cat && P.merchantKey(u.desc) === key) { changed.push([u, u.cat, u.catSrc]); u.cat = cat; u.catSrc = 'rule'; }
    return changed;
  }

  function linkTransfers() {
    const isT = t => catKind(t) === 'transfer' || /PAYMENT|AUTOPAY|TRANSFER|CRD|EPAY/i.test(t.desc);
    const out = S.txns.filter(t => !t.link && t.amt > 0 && isT(t));
    const inn = S.txns.filter(t => !t.link && t.amt < 0 && isT(t));
    let n = 0;
    for (const a of out) {
      const da = Date.parse(a.date);
      const b = inn.find(b => !b.link && b.acct !== a.acct && b.amt === -a.amt && Math.abs(Date.parse(b.date) - da) <= 8 * 864e5);
      if (!b) continue;
      a.link = b.id; b.link = a.id; n++;
      for (const x of [a, b]) if (x.catSrc !== 'user') { x.cat = 'transfers'; x.catSrc = 'auto'; }
    }
    return n;
  }

  // ================= UI state =================
  const ui = { visible: [], tab: null, cur: null, lastTriage: null, month: null, q: '', allMonths: false, acct: 'all', cat: null, person: null, view: 'spending', sel: new Set(), drawer: null, settingsTab: 'people' };
  let lastActivity = Date.now();

  // ================= boot =================
  async function boot() {
    try { await DB.open(); } catch (e) { return fatal('This browser blocked local storage (IndexedDB). Try Chrome, Edge or Firefox, and make sure private browsing is off.'); }
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) { }
    await liveInit();
    const rec = await DB.get('state');
    if (!rec) return showOnboarding();
    if (rec.enc) return showLock(rec);
    S = JSON.parse(rec.data); migrate(); start();
  }
  function migrate() {
    S.settings = S.settings || { autoLock: 15 }; S.imports = S.imports || []; S.rules = S.rules || {}; S.groups = S.groups || [];
    // review state arrived later: anything already split or categorised by hand counts as looked at
    for (const t of S.txns) if (t.rev === undefined) t.rev = !!(t.split || t.catSrc === 'user' || t.manual);
    // built-in category rules improve over time: give still-uncategorised rows another try
    for (const t of S.txns) if (!t.cat && t.catSrc !== 'user') { const g = P.guessCategory(t.desc); if (g && !(g === 'income' && t.amt > 0) && S.categories.some(c => c.id === g)) { t.cat = g; t.catSrc = 'auto'; } }
  }
  function fatal(msg) { $('#app').innerHTML = `<div class="center"><div class="lockcard"><h1>Can't start</h1><p class="muted">${esc(msg)}</p></div></div>`; }

  function showOnboarding() {
    $('#app').innerHTML = `<div class="center"><div class="lockcard">
      <div class="logo">T</div>
      <h1>Welcome to Tally</h1>
      <p class="muted" style="margin:0">Track, categorize and split your spending. Your statements are read on this device, and nothing is ever sent anywhere: this page has no network access.</p>
      <div id="ob-choice" style="display:flex;flex-direction:column;gap:10px">
        <button class="opt" data-act="ob-pass"><b>Protect with a passphrase (recommended)</b><span class="muted">Your data is encrypted on disk. If you forget the passphrase it can't be recovered, so keep backups.</span></button>
        <button class="opt" data-act="ob-skip"><b>Continue without a passphrase</b><span class="muted">Private to this browser profile. You can add a passphrase later in Settings.</span></button>
      </div>
      <form id="ob-form" class="hidden" style="display:flex;flex-direction:column;gap:10px">
        <label class="field"><span>Passphrase</span><input type="password" id="ob-p1" autocomplete="new-password" minlength="8" required></label>
        <label class="field"><span>Confirm passphrase</span><input type="password" id="ob-p2" autocomplete="new-password" required></label>
        <div class="faint" style="font-size:12px">Use 4+ random words or 12+ characters. Encryption: AES-256-GCM, key derived with PBKDF2 (600k rounds).</div>
        <div id="ob-err" class="note bad hidden"></div>
        <button class="btn primary" type="submit">Encrypt and start</button>
      </form>
    </div></div>`;
    if (!Vault.canCrypto) { $('[data-act=ob-pass]').disabled = true; }
    $('#ob-form').addEventListener('submit', async e => {
      e.preventDefault();
      const p1 = $('#ob-p1').value, p2 = $('#ob-p2').value, err = $('#ob-err');
      if (p1.length < 8) { err.textContent = 'Use at least 8 characters.'; err.classList.remove('hidden'); return; }
      if (p1 !== p2) { err.textContent = "Passphrases don't match."; err.classList.remove('hidden'); return; }
      $('#ob-form button').disabled = true; $('#ob-form button').textContent = 'Deriving key…';
      await setPassphrase(p1);
      S = blankState(); await flush(); start();
    });
  }
  async function setPassphrase(pass) {
    Vault.salt = crypto.getRandomValues(new Uint8Array(16)); Vault.iter = ITER;
    Vault.key = await Vault.derive(pass, Vault.salt, Vault.iter);
  }

  function showLock(rec) {
    S = null; closeOverlay();
    $('#app').innerHTML = `<div class="center"><form class="lockcard" id="lock-form">
      <div class="logo">T</div>
      <h1>Tally is locked</h1>
      <p class="muted" style="margin:0">Enter your passphrase to decrypt your data on this device.</p>
      <input type="password" id="lock-p" placeholder="Passphrase" autocomplete="current-password" autofocus>
      <div id="lock-err" class="note bad hidden">Wrong passphrase.</div>
      <button class="btn primary" type="submit">Unlock</button>
      <button class="btn ghost sm" type="button" data-act="forgot" style="align-self:center">Forgot passphrase?</button>
    </form></div>`;
    $('#lock-form').addEventListener('submit', async e => {
      e.preventDefault();
      const btn = $('#lock-form .primary'); btn.disabled = true; btn.textContent = 'Unlocking…';
      try {
        const key = await Vault.derive($('#lock-p').value, rec.salt, rec.iter);
        S = await Vault.open(rec, key);
        Vault.key = key; Vault.salt = rec.salt; Vault.iter = rec.iter;
        migrate(); start();
      } catch (err) { $('#lock-err').classList.remove('hidden'); btn.disabled = false; btn.textContent = 'Unlock'; $('#lock-p').select(); }
    });
    setTimeout(() => $('#lock-p') && $('#lock-p').focus(), 50);
  }
  async function lockNow() { if (!Vault.key) return; await flush(); const rec = await DB.get('state'); Vault.key = null; showLock(rec); }

  function start() {
    reindex();
    const ms = monthsWithData();
    ui.month = ui.month || (ms.length ? ms[ms.length - 1] : todayISO().slice(0, 7));
    if (!ui.tab) ui.tab = inboxList().length ? 'inbox' : 'month';
    renderShell();
  }

  // ================= shell =================
  function renderShell() {
    $('#app').innerHTML = `
      <header class="topbar">
        <div class="brand"><b>Tally</b><span class="badge-private" title="This page cannot make network requests. Data never leaves this browser.">● Private · on this device</span></div>
        <div class="tabs" id="tabs"><button data-act="tab" data-v="inbox">Inbox <span id="tab-inbox-n"></span></button><button data-act="tab" data-v="bill">To bill <span id="tab-bill-n"></span></button><button data-act="tab" data-v="month">Month</button><button data-act="tab" data-v="trends">Trends</button></div>
        <div class="monthnav">
          <button class="icon-btn" data-act="mprev" title="Previous month">‹</button>
          <select id="msel" class="label" style="border:0;background:transparent;text-align:center;cursor:pointer"></select>
          <button class="icon-btn" data-act="mnext" title="Next month">›</button>
        </div>
        <button class="btn primary" data-act="import">＋ Import statements</button>
        <button class="icon-btn" data-act="add" title="Add a transaction manually">✎</button>
        <button class="icon-btn" data-act="settings" title="Settings">⚙</button>
        ${Vault.key ? '<button class="icon-btn" data-act="lock" title="Lock">🔒</button>' : ''}
      </header>
      <div id="banner"></div>
      <main id="main"></main>
      <div id="overlay"></div>`;
    renderMain();
  }
  function renderMonthSelect() {
    const ms = new Set(monthsWithData()); ms.add(ui.month);
    $('#msel').innerHTML = [...ms].sort().reverse().map(m => `<option value="${m}" ${m === ui.month ? 'selected' : ''}>${monthLabel(m)}</option>`).join('');
  }
  function renderMain() {
    $$('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.v === ui.tab));
    renderMonthSelect(); renderTabCounts(); renderBanner();
    $('.monthnav').style.visibility = ui.tab === 'month' || ui.tab === 'trends' ? '' : 'hidden';
    if (S.txns.length && ui.tab === 'inbox') return renderInbox();
    if (S.txns.length && ui.tab === 'bill') return renderBill();
    if (ui.tab === 'trends') return renderTrends();
    const main = $('#main');
    if (!S.txns.length) {
      main.innerHTML = `<div class="card"><div class="empty">
        <h2>Import your first statement</h2>
        <p>Drop in a QFX/OFX download, a CSV export, or a Chase or Bilt PDF. It's read right here in your browser. Nothing is uploaded.</p>
        <p style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap"><button class="btn primary" data-act="import">＋ Import statements</button>
        <button class="btn" data-act="settings" data-v="people">Add people you split with</button></p>
        <p class="faint" style="font-size:12.5px">Tip: download statements as PDF from chase.com / the Bilt app. Scanned or photographed statements won't work.</p>
      </div></div>`;
      return;
    }
    main.innerHTML = `
      <div class="stats" id="stats"></div>
      <div class="grid">
        <div>
          <div class="card">
            <div class="filters">
              <input type="search" id="q" placeholder="Search merchant, note, amount…  ( / )" value="${esc(ui.q)}">
              <label class="check faint" style="font-size:12.5px"><input type="checkbox" id="allm" ${ui.allMonths ? 'checked' : ''}>All months</label>
              <select id="facct"><option value="all">All accounts</option>${S.accounts.map(a => `<option value="${a.id}" ${ui.acct === a.id ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select>
            </div>
            <div class="filters" id="chips"></div>
            <div id="list"></div>
          </div>
          <div id="bulk"></div>
        </div>
        <div class="side" id="side"></div>
      </div>`;
    update();
  }
  function update() {
    if (!S) return;
    reindex(); renderTabCounts();
    if (ui.tab === 'inbox' && S.txns.length) return renderInbox();
    if (ui.tab === 'bill' && S.txns.length) return renderBill();
    if (ui.tab === 'trends') return renderTrends();
    if (!$('#list')) return renderMain();
    renderStats(); renderChips(); renderList(); renderSide(); renderBulk();
  }

  // ================= month view =================
  function renderStats() {
    const s = summarize(monthTx(ui.month));
    const ppl = Object.keys(s.people).length;
    $('#stats').innerHTML = `
      <div class="stat"><div class="k">Your spending</div><div class="v num">${money(s.mine)}</div><div class="s">${s.count} transactions · ${money(s.gross)} charged in total</div></div>
      <div class="stat"><div class="k">Split to others</div><div class="v num">${money(s.others)}</div><div class="s">${ppl ? `across ${ppl} ${ppl === 1 ? 'person' : 'people'}` : 'Nothing split yet'}</div></div>
      <div class="stat"><div class="k">Income</div><div class="v num">${money(s.income)}</div><div class="s">${s.transfers} transfers &amp; card payments not counted</div></div>
      <div class="stat clickable ${s.review ? 'warn' : ''}" data-act="view" data-v="review"><div class="k">Needs a category</div><div class="v num">${s.review}</div><div class="s">${s.review ? 'Click to review' : 'All categorized ✓'}</div></div>`;
  }
  function baseList() {
    let list = ui.allMonths && ui.q ? S.txns.slice() : monthTx(ui.month);
    if (ui.acct !== 'all') list = list.filter(t => t.acct === ui.acct);
    if (ui.q) {
      const q = ui.q.toLowerCase();
      list = list.filter(t => (t.name + ' ' + t.desc + ' ' + (t.note || '') + ' ' + (catMap[t.cat] ? catMap[t.cat].name : '') + ' ' + (Math.abs(t.amt) / 100).toFixed(2)).toLowerCase().includes(q));
    }
    return list;
  }
  const VIEWS = {
    spending: ['Spending', t => catKind(t) === 'spend'],
    review: ['Needs category', t => !t.cat],
    split: ['Split', t => !!t.split],
    income: ['Income', t => catKind(t) === 'income'],
    transfers: ['Transfers', t => catKind(t) === 'transfer'],
    all: ['Everything', () => true],
  };
  function renderChips() {
    const base = baseList();
    let html = Object.entries(VIEWS).map(([k, [label, f]]) => `<button class="fchip ${ui.view === k ? 'on' : ''}" data-act="view" data-v="${k}">${label} <span class="${ui.view === k ? '' : 'faint'}">${base.filter(f).length}</span></button>`).join('');
    if (ui.cat) html += `<button class="fchip on" data-act="clearcat">${esc(ui.cat === '_none' ? 'Uncategorized' : (catMap[ui.cat] || {}).name)} ✕</button>`;
    if (ui.person) html += `<button class="fchip on" data-act="clearperson">With ${esc((personMap[ui.person] || {}).name)} ✕</button>`;
    $('#chips').innerHTML = `<div class="chipbar">${html}</div>`;
  }
  function visibleList() {
    let list = baseList().filter(VIEWS[ui.view][1]);
    if (ui.cat) list = list.filter(t => (t.cat || '_none') === ui.cat);
    if (ui.person) list = list.filter(t => t.split && shares(t).some(([p, c]) => p === ui.person && c));
    return list.sort(byRecent);
  }
  function catOptions(sel, withNone = true) {
    return (withNone ? `<option value="" ${!sel ? 'selected' : ''}>Uncategorized</option>` : '') +
      S.categories.map(c => `<option value="${c.id}" ${sel === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
  }
  function splitChip(t) {
    const k = catKind(t);
    if (k !== 'spend') return `<span class="faint" style="font-size:12px">${t.link ? '↔ matched' : '—'}</span>`;
    if (!t.split) return `<button class="splitchip mine" data-act="open" data-id="${t.id}" data-focus="split">${t.rev ? 'Mine' : 'Undecided'}</button>`;
    const sh = shares(t).filter(x => x[1]);
    const others = sh.filter(x => x[0] !== 'me').map(x => (personMap[x[0]] || {}).name || '?');
    const label = others.length > 2 ? `${others.slice(0, 2).join(', ')} +${others.length - 2}` : others.join(', ');
    return `<button class="splitchip on" data-act="open" data-id="${t.id}" data-focus="split"><span class="avs">${sh.map(x => avatar(x[0])).join('')}</span>${esc(label || 'You')}${t.billed ? ' ✓' : ''}</button>`;
  }
  function amountCell(t) {
    const neg = t.amt < 0;
    const main = `<div class="num ${neg ? 'amt-in' : ''}">${neg ? '+' : ''}${money(Math.abs(t.amt))}</div>`;
    if (!t.split || catKind(t) !== 'spend') return main;
    return main + `<div class="share num">you ${money(myShare(t))}</div>`;
  }
  function rowHTML(t) {
    const c = catMap[t.cat]; const a = acctMap[t.acct];
    const showYear = ui.allMonths && ui.q;
    return `<tr class="row ${ui.sel.has(t.id) ? 'sel' : ''} ${t.excluded ? 'dim' : ''}" data-id="${t.id}">
      <td class="c-check"><input type="checkbox" data-act="sel" data-id="${t.id}" ${ui.sel.has(t.id) ? 'checked' : ''} aria-label="Select"></td>
      <td class="c-date num">${showYear ? t.date.slice(2).replace(/-/g, '/') : fmtDay(t.date)}</td>
      <td><div class="merchant">${t.flag ? '<span class="flag" title="Flagged">⚑</span>' : ''}${esc(t.name)}${a ? `<span class="acct">${esc(a.short || a.name)}</span>` : ''}${t.excluded ? '<span class="pill">excluded</span>' : ''}</div>
        <div class="sub"><span class="mcat">${esc(c ? c.name : 'Uncategorized')} · </span>${t.note ? '✎ ' + esc(t.note) + ' · ' : ''}${esc(t.desc)}${t.detail ? ' · ' + esc(t.detail) : ''}</div></td>
      <td class="c-cat"><select class="catsel ${c ? '' : 'none'}" data-act="rowcat" data-id="${t.id}" style="--dot:${c ? esc(c.color) : 'var(--warn)'}">${catOptions(t.cat)}</select></td>
      <td class="c-split hide-sm">${splitChip(t)}</td>
      <td class="c-amt">${amountCell(t)}</td></tr>`;
  }
  function renderList() {
    const list = visibleList();
    ui.visible = list.map(t => t.id);
    if (!list.length) {
      const msg = ui.view === 'review' ? 'Everything this month has a category. 🎉' : ui.q ? 'No matches.' : 'No transactions here this month.';
      $('#list').innerHTML = `<div class="empty"><p>${msg}</p></div>`; return;
    }
    const allSel = list.every(t => ui.sel.has(t.id));
    $('#list').innerHTML = `<table class="tx"><thead><tr>
      <th class="c-check"><input type="checkbox" data-act="selall" ${allSel ? 'checked' : ''} aria-label="Select all"></th>
      <th>Date</th><th>Merchant</th><th class="c-cat">Category</th><th class="hide-sm">Split</th><th style="text-align:right">Amount</th></tr></thead>
      <tbody>${list.map(rowHTML).join('')}</tbody></table>`;
  }
  function renderSide() {
    const s = summarize(monthTx(ui.month));
    const cats = Object.entries(s.byCat).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
    const total = cats.reduce((x, [, v]) => x + v, 0) || 1;
    const col = id => id === '_none' ? 'var(--warn)' : (catMap[id] || {}).color || '#999';
    const nm = id => id === '_none' ? 'Uncategorized' : (catMap[id] || {}).name || id;
    const catsHTML = cats.length ? `<div class="stack">${cats.map(([id, v]) => `<i style="width:${(v / total * 100).toFixed(2)}%;background:${esc(col(id))}" title="${esc(nm(id))}"></i>`).join('')}</div>` +
      cats.map(([id, v]) => `<div class="catrow" data-act="filtercat" data-v="${id}"><span class="dot" style="background:${esc(col(id))}"></span><span class="name">${esc(nm(id))}</span><span class="num">${money(v)} <span class="faint">${Math.round(v / total * 100)}%</span></span>
        <span class="bar"><i style="width:${(v / cats[0][1] * 100).toFixed(1)}%;background:${esc(col(id))}"></i></span></div>`).join('')
      : '<p class="muted" style="margin:0">No spending this month.</p>';
    const people = S.people.map(p => [p, s.people[p.id] || 0, s.peopleCount[p.id] || 0]).filter(x => x[1] || x[2]);
    const peopleHTML = !S.people.length
      ? `<p class="muted" style="margin:0 0 10px">Add the people you split with: roommates, partner, family, friends.</p><button class="btn sm" data-act="settings" data-v="people">＋ Add people</button>`
      : people.length ? people.map(([p, v, n]) => `<div class="person"><span class="av" style="background:${esc(p.color)}">${esc(initials(p.name))}</span>
          <div><div style="font-weight:600;cursor:pointer" data-act="filterperson" data-v="${p.id}">${esc(p.name)}</div><div class="faint" style="font-size:12px">${n} item${n === 1 ? '' : 's'} · <a href="#" data-act="sharesum" data-v="${p.id}">share summary</a></div></div>
          <div class="amt num">${money(v)}</div></div>`).join('')
        : '<p class="muted" style="margin:0">Nothing split this month. Open a transaction and pick who shares it, or select several and use “Split”.</p>';
    const accts = S.accounts.map(a => { const l = monthTx(ui.month).filter(t => t.acct === a.id); return [a, l.length, l.filter(t => catKind(t) === 'spend').reduce((x, t) => x + t.amt, 0)]; }).filter(x => x[1]);
    $('#side').innerHTML = `
      <div class="card"><div class="card-h"><h3>Where your share went</h3><span class="faint" style="margin-left:auto;font-size:12px">${monthLabel(ui.month, true)}</span></div><div class="card-b">${catsHTML}</div></div>
      <div class="card"><div class="card-h"><h3>Split per person</h3>${people.length ? '<button class="btn sm ghost" style="margin-left:auto" data-act="sharesum" data-v="all">Copy all</button>' : ''}</div><div class="card-b">${peopleHTML}</div></div>
      ${accts.length ? `<div class="card"><div class="card-h"><h3>Accounts</h3></div><div class="card-b">${accts.map(([a, n, v]) => `<div class="person" style="grid-template-columns:1fr auto"><div><div style="font-weight:550">${esc(a.name)}</div><div class="faint" style="font-size:12px">${n} transactions</div></div><div class="num">${money(v)}</div></div>`).join('')}</div></div>` : ''}`;
  }
  function renderBulk() {
    const n = ui.sel.size;
    if (!n) { $('#bulk').innerHTML = ''; return; }
    $('#bulk').innerHTML = `<div class="bulk"><b>${n} selected</b>
      <select data-act="bulkcat"><option value="">Set category…</option>${catOptions(null, false)}</select>
      <select data-act="bulksplit"><option value="">Split evenly with…</option>${S.people.map(p => `<option value="${p.id}">You + ${esc(p.name)}</option>`).join('')}${S.people.length > 1 ? '<option value="__all">Everyone</option>' : ''}<option value="__new">＋ New person…</option></select>
      <button class="btn sm" data-act="bulkmine">Just mine</button>
      <button class="btn sm" data-act="bulkexcl">Exclude / include</button>
      <button class="btn sm" data-act="bulkclear">✕</button></div>`;
  }

  // ================= inbox: decide each new charge =================
  function renderTabCounts() {
    const a = $('#tab-inbox-n'), b = $('#tab-bill-n'); if (!a || !b) return;
    const n = inboxList().length, owed = owedTotal();
    a.innerHTML = n ? `<span class="count">${n}</span>` : '';
    b.innerHTML = owed ? `<span class="count">${money(owed)}</span>` : '';
  }
  const keyGroups = () => S.groups.filter(g => g.members.some(p => personMap[p])).slice(0, 9);
  function renderInbox() {
    const list = inboxList(), main = $('#main'), groups = keyGroups();
    ui.visible = list.map(t => t.id);
    if (!list.some(t => t.id === ui.cur)) ui.cur = list.length ? list[0].id : null;
    if (!list.length) {
      const owed = owedTotal();
      main.innerHTML = `<div class="card"><div class="empty"><h2>Inbox zero</h2>
        <p>Every charge has been decided. ${owed ? `You still have <b>${money(owed)}</b> to bill.` : 'Nothing is waiting to be billed either.'}</p>
        <p style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap">${owed ? '<button class="btn primary" data-act="tab" data-v="bill">Go to To bill</button>' : ''}<button class="btn" data-act="import">＋ Import statements</button></p></div></div>`;
      return;
    }
    const legend = `<span class="kbd">M</span> mine ${groups.map((g, i) => `<span class="kbd">${i + 1}</span> ${esc(g.name)}`).join(' ')} <span class="kbd">S</span> custom split <span class="kbd">J</span>/<span class="kbd">K</span> move <span class="kbd">U</span> undo · hold <span class="kbd">Shift</span> to always do it for that merchant`;
    main.innerHTML = `<div class="card" id="inbox">
      <div class="card-h"><h3>${list.length} charge${list.length === 1 ? '' : 's'} to decide</h3>
        <span class="faint" style="font-size:12.5px">Is it yours, or shared?</span>
        <button class="btn sm" style="margin-left:auto" data-act="trirest" title="Mark every remaining charge as yours">The rest are mine</button></div>
      <div class="filters faint" style="font-size:12.5px;gap:6px">${legend}${groups.length ? '' : ` · <a href="#" data-act="settings" data-v="people">Create a group</a> to split with one key`}</div>
      <div style="overflow-x:auto"><table class="tx"><thead><tr><th>Date</th><th>Merchant</th><th class="c-cat">Category</th><th style="text-align:right">Amount</th><th>Decide</th></tr></thead><tbody>
      ${list.map(t => { const c = catMap[t.cat], a = acctMap[t.acct]; return `<tr class="row ${t.id === ui.cur ? 'cur' : ''}" data-id="${t.id}">
        <td class="c-date num">${fmtDay(t.date)}</td>
        <td><div class="merchant">${esc(t.name)}${a ? `<span class="acct">${esc(a.short || a.name)}</span>` : ''}</div><div class="sub">${esc(t.desc)}${t.detail ? ' · ' + esc(t.detail) : ''}</div></td>
        <td class="c-cat"><select class="catsel ${c ? '' : 'none'}" data-act="rowcat" data-id="${t.id}" style="--dot:${c ? esc(c.color) : 'var(--warn)'}">${catOptions(t.cat)}</select></td>
        <td class="c-amt"><div class="num ${t.amt < 0 ? 'amt-in' : ''}">${t.amt < 0 ? '+' : ''}${money(Math.abs(t.amt))}</div></td>
        <td class="c-decide"><button class="btn sm" data-act="tri" data-v="mine" data-id="${t.id}">Mine</button>${groups.map(g => `<button class="btn sm" data-act="tri" data-v="${g.id}" data-id="${t.id}">${esc(g.name)}</button>`).join('')}<button class="btn sm ghost" data-act="open" data-id="${t.id}" data-focus="split">Split…</button></td></tr>`; }).join('')}
      </tbody></table></div></div>`;
    const cur = $('#inbox tr.cur'); if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'nearest' });
  }
  // Decide a charge: split = null means "mine". `always` also teaches the merchant
  // rule and applies it to that merchant's other undecided charges.
  function triage(t, split, always) {
    const clone = x => (x ? JSON.parse(JSON.stringify(x)) : null);
    const targets = [t];
    if (always) {
      const key = P.merchantKey(t.desc);
      const rule = S.rules[key] = { ...(S.rules[key] || { cat: t.cat }), name: t.name };
      if (split) { rule.split = clone(split); delete rule.mine; } else { rule.mine = true; delete rule.split; }
      for (const u of inboxList()) if (u !== t && P.merchantKey(u.desc) === key) targets.push(u);
    }
    const i = ui.visible.indexOf(t.id);
    ui.lastTriage = targets.map(u => ({ id: u.id, split: clone(u.split), rev: u.rev }));
    for (const u of targets) { u.split = clone(split); u.rev = true; }
    const gone = new Set(targets.map(u => u.id));
    ui.cur = ui.visible.slice(i + 1).find(id => !gone.has(id)) || ui.visible.slice(0, Math.max(i, 0)).reverse().find(id => !gone.has(id)) || null;
    save(); update();
    const what = split ? 'Split with ' + partyName(split.parts.map(p => p.p).filter(p => p !== 'me')) : 'Mine';
    toast(`${what}: ${t.name}${targets.length > 1 ? ` (+${targets.length - 1} more from this merchant)` : ''}${always ? ' · remembered' : ''}`, 'Undo', undoTriage);
  }
  function undoTriage() {
    if (!ui.lastTriage) return;
    for (const p of ui.lastTriage) { const t = S.txns.find(x => x.id === p.id); if (t) { t.split = p.split; t.rev = p.rev; } }
    ui.cur = ui.lastTriage[0].id; ui.lastTriage = null; save(); update();
  }

  // ================= to bill: what to enter into Splitwise =================
  function billBuckets() {
    const m = new Map();
    for (const t of unbilled().sort(byRecent)) {
      const pids = shares(t).filter(([p, c]) => p !== 'me' && c).map(x => x[0]).sort();
      const key = pids.join('|');
      if (!m.has(key)) m.set(key, { key, pids, items: [], total: 0, owes: {}, owed: 0 });
      const b = m.get(key); b.items.push(t); b.total += t.amt;
      for (const [p, c] of shares(t)) if (p !== 'me') { b.owes[p] = (b.owes[p] || 0) + c; b.owed += c; }
    }
    const order = p => S.people.findIndex(x => x.id === p);
    return [...m.values()].map(b => {
      b.pids.sort((x, y) => order(x) - order(y));   // show people in the order the user listed them
      b.name = partyName(b.pids);
      // "split equally" is only a true instruction if every item was an even split that includes you
      b.even = b.items.every(t => t.split.mode === 'even' && t.split.parts.some(p => p.p === 'me'));
      // For an equal split, quote what Splitwise will compute from the one total, not the
      // sum of per-item roundings (which drifts by a cent per item between people).
      if (b.even) { const per = Math.round(b.total / (b.pids.length + 1)); for (const p of b.pids) b.owes[p] = per; b.owed = per * b.pids.length; }
      return b;
    }).sort((a, b) => b.owed - a.owed);
  }
  const owedTotal = () => billBuckets().reduce((s, b) => s + b.owed, 0);   // same figures the cards show
  const pname = p => (personMap[p] || {}).name || '?';
  function billText(b) {
    const dates = b.items.map(t => t.date).sort(), first = dates[0], last = dates[dates.length - 1];
    const lines = b.items.map(t => {
      const own = t.split.mode === 'even' ? '' : '  (' + shares(t).filter(([p, c]) => p !== 'me' && c).map(([p, c]) => `${pname(p)} ${money(c)}`).join(', ') + ')';
      return `• ${fmtDay(t.date)}  ${t.name}${t.note ? ` (${t.note})` : ''}  ${money(t.amt)}${own}`;
    });
    return `${b.name}: shared expenses ${fmtDay(first)}${first === last ? '' : ' – ' + fmtDay(last)}\n` +
      `Total ${money(b.total)} paid by me${b.even ? ', split equally' : ', split by exact amounts'}\n` +
      b.pids.map(p => `${pname(p)} owes ${money(b.owes[p])}`).join(' · ') + '\n\n' + lines.join('\n');
  }
  function renderBill() {
    const buckets = billBuckets(), main = $('#main'), pending = inboxList().length;
    const billed = S.txns.filter(t => t.billed).sort((a, b) => b.billed.localeCompare(a.billed) || b.date.localeCompare(a.date)).slice(0, 60);
    const history = billed.length ? `<details class="card" style="margin-top:18px"><summary class="card-h" style="cursor:pointer"><h3>Already billed</h3><span class="faint" style="font-size:12.5px">${billed.length} most recent</span></summary>
      <div style="overflow-x:auto"><table class="tx"><tbody>${billed.map(t => `<tr><td class="c-date num">${fmtDay(t.date)}</td><td>${esc(t.name)} <span class="faint">· ${esc(partyName(shares(t).filter(([p, c]) => p !== 'me' && c).map(x => x[0])))}</span></td><td class="num" style="text-align:right">${money(othersShare(t))}</td><td class="faint" style="font-size:12px">billed ${fmtDay(t.billed)}</td><td><button class="btn sm ghost" data-act="unbill" data-id="${t.id}">Not billed</button></td></tr>`).join('')}</tbody></table></div></details>` : '';
    const warn = pending ? `<div class="note warn" style="margin-bottom:14px">${pending} charge${pending === 1 ? ' is' : 's are'} still undecided, so this list may be incomplete. <a href="#" data-act="tab" data-v="inbox">Finish the Inbox</a></div>` : '';
    if (!buckets.length) {
      main.innerHTML = `${warn}<div class="card"><div class="empty"><h2>Nothing to bill</h2><p>Every shared charge you've decided on has been marked as billed.</p></div></div>${history}`;
      return;
    }
    main.innerHTML = warn + buckets.map(b => `<div class="card bill" data-k="${esc(b.key)}" style="margin-bottom:18px">
      <div class="card-h"><span class="avs">${b.pids.map(p => avatar(p)).join('')}</span><h3>${esc(b.name)}</h3><span class="faint" style="font-size:12.5px">${b.items.length} item${b.items.length === 1 ? '' : 's'}</span>
        <span style="margin-left:auto;text-align:right"><span class="faint" style="font-size:12px">owed to you</span> <b class="num" style="font-size:18px">${money(b.owed)}</b></span></div>
      <div class="card-b" style="display:flex;flex-direction:column;gap:10px">
        <div class="note">In Splitwise: add <b>one expense of ${money(b.total)}</b>, paid by you, ${b.even ? '<b>split equally</b>' : 'split by <b>exact amounts</b>'} — ${b.pids.map(p => `${esc(pname(p))} owes <b>${money(b.owes[p])}</b>`).join(', ')}. Paste the copied list into the notes.</div>
        <div style="overflow-x:auto"><table class="tx"><tbody>${b.items.map(t => `<tr class="row" data-id="${t.id}"><td class="c-date num">${fmtDay(t.date)}</td><td><div class="merchant">${esc(t.name)}${t.auto ? '<span class="pill" title="Split automatically by a remembered rule">auto</span>' : ''}</div>${t.note ? `<div class="sub">✎ ${esc(t.note)}</div>` : ''}</td>
          <td class="num" style="text-align:right">${money(t.amt)}</td><td class="num faint" style="text-align:right">they owe ${money(othersShare(t))}</td>
          <td style="text-align:right"><button class="btn sm ghost" data-act="bill1" data-id="${t.id}">Mark billed</button></td></tr>`).join('')}</tbody></table></div>
        <div style="display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap"><button class="btn" data-act="billcopy" data-k="${esc(b.key)}">Copy for Splitwise</button><button class="btn primary" data-act="billall" data-k="${esc(b.key)}">Mark all ${b.items.length} billed</button></div>
      </div></div>`).join('') + history;
  }
  function markBilled(list) {
    const day = todayISO(); for (const t of list) t.billed = day;
    save(); update();
    toast(`Marked ${list.length} item${list.length === 1 ? '' : 's'} as billed.`, 'Undo', () => { for (const t of list) delete t.billed; save(); update(); });
  }

  // ================= backups you don't have to remember =================
  // Browser storage can vanish (cleared site data, a moved file, a new profile), so the
  // data should also live in a real file. Where the browser allows it, Tally rewrites a
  // backup file the user picked once, after every change; otherwise it nags when stale.
  const Live = { handle: null, status: 'off', name: '', at: null, timer: null };
  const canLive = typeof window.showSaveFilePicker === 'function';
  async function liveInit() {
    try {
      const h = await DB.get('backupHandle');
      if (h && h.queryPermission) { Live.handle = h; Live.name = h.name; Live.status = (await h.queryPermission({ mode: 'readwrite' })) === 'granted' ? 'on' : 'paused'; }
    } catch (e) { }
  }
  function liveSchedule() { if (Live.status !== 'on') return; clearTimeout(Live.timer); Live.timer = setTimeout(liveWrite, 1200); }
  async function liveWrite() {
    if (!Live.handle || !S) return;
    try {
      const w = await Live.handle.createWritable();
      await w.write(JSON.stringify(await buildBackup())); await w.close();
      Live.at = Date.now(); Live.status = 'on';
    } catch (e) { Live.status = 'paused'; }
    renderBanner(); if ($('#settings') && ui.settingsTab === 'data') renderSettings();
  }
  async function livePick() {
    let h; try { h = await window.showSaveFilePicker({ suggestedName: 'tally-live-backup.tally', types: [{ description: 'Tally backup', accept: { 'application/json': ['.tally'] } }] }); } catch (e) { return; }
    Live.handle = h; Live.name = h.name; Live.status = 'on';
    try { await DB.put('backupHandle', h); } catch (e) { }
    await liveWrite();
    if (Live.status === 'on') toast(`Tally now keeps ${Live.name} up to date after every change.`);
  }
  function renderBanner() {
    const el = $('#banner'); if (!el || !S) return;
    const days = S.lastBackup ? Math.floor((Date.now() - S.lastBackup) / 864e5) : null;
    if (Live.status === 'paused') el.innerHTML = `<div class="banner warn">Automatic backup to <b>${esc(Live.name)}</b> is paused until you allow it again for this visit. <button class="btn sm" data-act="liveresume">Resume</button></div>`;
    else if (Live.status === 'off' && S.txns.length && (days === null || days >= 14)) el.innerHTML = `<div class="banner">Your data lives only in this browser. ${days === null ? 'It has never been backed up.' : `Last backup was ${days} days ago.`} <button class="btn sm" data-act="backup">Back up now</button>${canLive ? '<button class="btn sm" data-act="livepick">Back up automatically…</button>' : ''}</div>`;
    else el.innerHTML = '';
  }

  // ================= trends =================
  function renderTrends() {
    const months = []; for (let i = 11; i >= 0; i--) months.push(addMonth(ui.month, -i));
    const sums = months.map(m => summarize(monthTx(m)));
    const max = Math.max(1, ...sums.map(s => s.mine));
    const W = 1200, H = 250, bw = W / 12;
    const bars = sums.map((s, i) => { const h = Math.max(0, s.mine) / max * (H - 40); return `<g><title>${monthLabel(months[i])}: ${money(s.mine)}</title><rect class="bar ${months[i] === ui.month ? 'cur' : ''}" x="${i * bw + 8}" y="${H - 22 - h}" width="${bw - 16}" height="${h}" rx="4"></rect>
      <text x="${i * bw + bw / 2}" y="${H - 6}" text-anchor="middle">${monthLabel(months[i], true)}</text>${s.mine ? `<text x="${i * bw + bw / 2}" y="${H - 27 - h}" text-anchor="middle">${'$' + Math.round(s.mine / 100).toLocaleString()}</text>` : ''}</g>`; }).join('');
    const last6 = months.slice(-6), s6 = sums.slice(-6);
    const catIds = [...new Set(s6.flatMap(s => Object.keys(s.byCat)))].sort((a, b) => s6.reduce((x, s) => x + (s.byCat[b] || 0), 0) - s6.reduce((x, s) => x + (s.byCat[a] || 0), 0));
    const nm = id => id === '_none' ? 'Uncategorized' : (catMap[id] || {}).name || id;
    const row = (label, vals, bold) => `<tr${bold ? ' style="font-weight:650"' : ''}><td>${label}</td>${vals.map(v => `<td class="num">${v ? money(v) : '<span class="faint">—</span>'}</td>`).join('')}<td class="num">${money(vals.reduce((a, b) => a + b, 0))}</td></tr>`;
    $('#main').innerHTML = `
      <div class="card trend"><div class="card-h"><h3>Your share of spending, last 12 months</h3></div><div class="card-b"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Monthly spending bars">${bars}</svg></div></div>
      <div class="card" style="margin-top:18px;overflow:auto"><div class="card-h"><h3>By category, last 6 months</h3></div>
        <table class="tx heat"><thead><tr><th>Category</th>${last6.map(m => `<th style="text-align:right">${monthLabel(m, true)}</th>`).join('')}<th style="text-align:right">Total</th></tr></thead><tbody>
        ${catIds.map(id => row(`<span class="dot" style="display:inline-block;width:9px;height:9px;border-radius:3px;margin-right:7px;background:${esc(id === '_none' ? 'var(--warn)' : (catMap[id] || {}).color)}"></span>${esc(nm(id))}`, s6.map(s => s.byCat[id] || 0))).join('')}
        ${row('Your total', s6.map(s => s.mine), true)}
        ${S.people.map(p => row(`Split to ${esc(p.name)}`, s6.map(s => s.people[p.id] || 0))).join('')}
        ${row('Income', s6.map(s => s.income))}
        </tbody></table></div>`;
  }

  // ================= transaction drawer =================
  function openDrawer(id, focus) {
    ui.drawer = id; renderDrawer(focus);
  }
  function splitPeople(t) { return t.split ? t.split.parts.map(p => p.p) : ['me']; }
  function renderDrawer(focus) {
    const t = S.txns.find(x => x.id === ui.drawer); if (!t) return closeOverlay();
    const c = catMap[t.cat]; const a = acctMap[t.acct]; const k = catKind(t);
    const sp = t.split; const who = splitPeople(t);
    const mode = sp ? sp.mode : 'even';
    const sh = shares(t);
    const shareOf = pid => (sh.find(x => x[0] === pid) || [0, 0])[1];
    const abs = Math.abs(t.amt);
    let rows = '';
    if (sp) {
      const parts = [...new Set(['me', ...sp.parts.map(p => p.p)])].filter(pid => who.includes(pid) || (pid === 'me' && (mode === 'percent' || mode === 'amount')));
      rows = parts.map(pid => {
        const part = sp.parts.find(p => p.p === pid);
        let input;
        if (mode === 'even') input = '<span class="faint" style="text-align:right">equal</span>';
        else if (pid === 'me' && (mode === 'percent' || mode === 'amount')) {
          const v = mode === 'percent' ? (abs ? (Math.abs(shareOf('me')) / abs * 100) : 0).toFixed(1).replace(/\.0$/, '') + '%' : money(Math.abs(shareOf('me')));
          input = `<span class="faint" style="text-align:right" title="Whatever's left over is yours">${v} (rest)</span>`;
        } else {
          const val = part ? (mode === 'amount' ? ((+part.v || 0) / 100).toFixed(2) : part.v) : '';
          input = `<input type="text" inputmode="decimal" data-act="splitval" data-p="${pid}" value="${esc(val)}" placeholder="${mode === 'percent' ? '%' : mode === 'amount' ? '$' : 'shares'}">`;
        }
        return `<div class="splitrow">${avatar(pid)}<span>${esc(personMap[pid] ? personMap[pid].name : '?')}</span>${input}<span class="out num">${money(Math.abs(shareOf(pid)))}</span></div>`;
      }).join('');
    }
    let warn = '';
    if (sp && mode === 'percent') { const s = sp.parts.filter(p => p.p !== 'me').reduce((x, p) => x + (+p.v || 0), 0); if (s > 100) warn = `Percentages add up to ${s}%, which is more than 100%.`; }
    if (sp && mode === 'amount') { const s = sp.parts.filter(p => p.p !== 'me').reduce((x, p) => x + (+p.v || 0), 0); if (s > abs) warn = `Amounts add up to ${money(s)}, more than the ${money(abs)} total.`; }
    const rule = S.rules[P.merchantKey(t.desc)];
    const sameCount = S.txns.filter(u => u !== t && P.merchantKey(u.desc) === P.merchantKey(t.desc)).length;
    const linked = t.link && S.txns.find(u => u.id === t.link);
    const idx = (ui.visible || []).indexOf(t.id);
    $('#overlay').innerHTML = `<div class="scrim" data-act="close"></div>
      <aside class="drawer" role="dialog" aria-label="Transaction">
        <header><input type="text" id="d-name" value="${esc(t.name)}" style="flex:1;font-size:17px;font-weight:650;border-color:transparent;padding:4px 6px" aria-label="Name">
          <button class="icon-btn" data-act="dnav" data-v="-1" title="Previous (k)" ${idx <= 0 ? 'disabled' : ''}>↑</button><button class="icon-btn" data-act="dnav" data-v="1" title="Next (j)" ${idx < 0 || idx >= ui.visible.length - 1 ? 'disabled' : ''}>↓</button>
          <button class="icon-btn" data-act="close" title="Close (Esc)">✕</button></header>
        <div class="body">
          <div>
            <div class="bigamt num ${t.amt < 0 ? 'amt-in' : ''}">${t.amt < 0 ? '+' : ''}${money(abs)}</div>
            <div class="muted">${fmtDay(t.date)}, ${t.date.slice(0, 4)} · ${esc(a ? a.name : 'Manual entry')}</div>
            <div class="faint" style="font-size:12px;margin-top:4px">${esc(t.desc)}${t.detail ? '<br>' + esc(t.detail) : ''}</div>
            ${linked ? `<div class="note" style="margin-top:8px">↔ Matched with ${esc((acctMap[linked.acct] || {}).name || 'another account')} on ${fmtDay(linked.date)}. It's a payment between your own accounts, so it isn't counted as spending.</div>` : ''}
          </div>
          ${t.manual ? `<div class="row2"><label class="field"><span>Date</span><input type="date" id="d-date" value="${t.date}"></label><label class="field"><span>Amount (negative = money in)</span><input type="text" id="d-amt" inputmode="decimal" value="${(t.amt / 100).toFixed(2)}"></label></div>` : ''}
          <label class="field"><span>Category</span><select id="d-cat">${catOptions(t.cat)}</select>
            <span class="faint" style="font-weight:400">${rule && rule.cat === t.cat && t.cat ? `Remembered for “${esc(P.merchantKey(t.desc))}”.` : ''} ${sameCount ? `Changing it also updates ${sameCount} other transaction${sameCount === 1 ? '' : 's'} from this merchant.` : 'Future transactions from this merchant will use it.'}</span></label>
          ${k === 'spend' ? `<div class="field" id="d-split"><span>Who shares this?</span>
            <div style="display:flex;gap:6px;flex-wrap:wrap">
              ${[ME, ...S.people].map(p => `<button class="ptoggle ${who.includes(p.id) ? 'on' : ''}" data-act="ptoggle" data-p="${p.id}">${avatar(p.id)}${esc(p.name)}</button>`).join('')}
              <button class="ptoggle" data-act="addperson" style="padding-left:11px">＋ Person</button>
            </div>
            ${sp ? `<div style="display:flex;align-items:center;gap:10px;margin-top:8px"><div class="seg">${[['even', 'Even'], ['percent', '%'], ['amount', '$'], ['shares', 'Shares']].map(([m, l]) => `<button class="${mode === m ? 'on' : ''}" data-act="smode" data-v="${m}">${l}</button>`).join('')}</div>
               <button class="btn sm ghost" data-act="mine">Just mine</button></div>
              <div class="splitrows" style="margin-top:6px">${rows}</div>
              ${warn ? `<div class="note warn">${esc(warn)}</div>` : ''}
              <label class="check" style="font-weight:400;margin-top:4px"><input type="checkbox" id="d-remember" ${rule && rule.split ? 'checked' : ''}> Always split “${esc(t.name)}” this way</label>`
              : `<div class="faint" style="font-weight:400">All yours. Tap a person to split it with them.</div>`}
          </div>` : ''}
          <label class="field"><span>Note</span><textarea id="d-note" rows="2" placeholder="e.g. Sam's birthday dinner">${esc(t.note || '')}</textarea></label>
          <div style="display:flex;gap:16px;flex-wrap:wrap">
            <label class="check"><input type="checkbox" id="d-flag" ${t.flag ? 'checked' : ''}> Flag</label>
            <label class="check"><input type="checkbox" id="d-excl" ${t.excluded ? 'checked' : ''}> Exclude from totals</label>
          </div>
        </div>
        <footer><button class="btn danger sm" data-act="deltx">Delete</button>${k === 'spend' && t.rev ? '<button class="btn sm" data-act="redo" title="Clear the decision and put this charge back in the Inbox">Back to Inbox</button>' : ''}<span class="faint" style="font-size:12px;margin-left:auto"><span class="kbd">j</span>/<span class="kbd">k</span> next / prev</span><button class="btn primary" data-act="ddone">Done</button></footer>
      </aside>`;
    const bind = (sel, ev, fn) => { const el = $(sel); if (el) el.addEventListener(ev, fn); };
    bind('#d-name', 'change', e => { t.name = e.target.value.trim() || t.name; commit(); });
    bind('#d-cat', 'change', e => setCategory(t, e.target.value || null));
    bind('#d-note', 'change', e => { t.note = e.target.value.trim(); commit(); });
    bind('#d-flag', 'change', e => { t.flag = e.target.checked; commit(); });
    bind('#d-excl', 'change', e => { t.excluded = e.target.checked; commit(); });
    bind('#d-date', 'change', e => { if (e.target.value) { t.date = e.target.value; commit(); } });
    bind('#d-amt', 'change', e => { const c = toCents(e.target.value); if (c) { t.amt = c; commit(true); } });
    bind('#d-remember', 'change', e => { rememberSplit(t, e.target.checked); });
    $$('[data-act=splitval]').forEach(inp => inp.addEventListener('input', () => {
      const part = t.split.parts.find(p => p.p === inp.dataset.p); const raw = inp.value.replace(/[^\d.]/g, '');
      if (part) part.v = t.split.mode === 'amount' ? Math.round((parseFloat(raw) || 0) * 100) : (parseFloat(raw) || 0);
      afterSplitChange(t, inp);
    }));
    if (focus === 'split') { const el = $('#d-split'); if (el) el.scrollIntoView({ block: 'nearest' }); }
  }
  function afterSplitChange(t, focusedInput) {
    t.rev = true;                                   // editing the split is a decision
    if (t.billed) { delete t.billed; toast('Split changed after it was billed, so it is back in To bill. Correct the Splitwise entry too.'); }
    if ($('#d-remember') && $('#d-remember').checked) rememberSplit(t, true, true);
    save(); update();
    // refresh computed outputs without stealing focus
    const pid = focusedInput && focusedInput.dataset.p, pos = focusedInput && focusedInput.selectionStart;
    renderDrawer();
    if (pid) { const el = $(`[data-act=splitval][data-p="${pid}"]`); if (el) { el.focus(); try { el.setSelectionRange(pos, pos); } catch (e) { } } }
  }
  function rememberSplit(t, on, quiet) {
    const key = P.merchantKey(t.desc);
    S.rules[key] = { ...(S.rules[key] || { cat: t.cat }), name: t.name };
    if (on && t.split) S.rules[key].split = JSON.parse(JSON.stringify(t.split)); else delete S.rules[key].split;
    if (!S.rules[key].cat) S.rules[key].cat = t.cat;
    save(); if (!quiet && on) toast(`Future “${t.name}” transactions will be split this way.`);
  }
  function commit(rerenderDrawer) { save(); update(); if (rerenderDrawer) renderDrawer(); }
  function setCategory(t, cat, quiet) {
    const prev = [[t, t.cat, t.catSrc]];
    t.cat = cat; t.catSrc = 'user';
    let changed = [];
    if (cat) changed = learnCategory(t, cat);
    save(); update(); if (ui.drawer) renderDrawer();
    if (!quiet && changed.length) toast(`Also set ${changed.length} other “${t.name}” transaction${changed.length === 1 ? '' : 's'} to ${catMap[cat].name}.`, 'Undo', () => {
      for (const [u, c, s] of [...prev, ...changed]) { u.cat = c; u.catSrc = s; } save(); update(); if (ui.drawer) renderDrawer();
    });
  }
  function togglePerson(t, pid) {
    let who = splitPeople(t);
    who = who.includes(pid) ? who.filter(x => x !== pid) : [...who, pid];
    if (!who.length || (who.length === 1 && who[0] === 'me')) { t.split = null; }
    else {
      const mode = t.split ? t.split.mode : 'even';
      const old = t.split ? t.split.parts : [];
      t.split = { mode, parts: who.map(p => old.find(o => o.p === p) || { p, v: mode === 'shares' ? 1 : mode === 'percent' ? Math.round(100 / who.length) : mode === 'amount' ? Math.round(Math.abs(t.amt) / who.length) : 1 }) };
    }
    afterSplitChange(t);
  }
  function setMode(t, mode) {
    if (!t.split) return;
    const who = splitPeople(t), n = who.length, abs = Math.abs(t.amt);
    const cur = Object.fromEntries(shares(t).map(([p, c]) => [p, Math.abs(c)]));
    t.split = { mode, parts: who.map(p => ({ p, v: mode === 'percent' ? Math.round((cur[p] || 0) / (abs || 1) * 1000) / 10 : mode === 'amount' ? (cur[p] || 0) : 1 })) };
    if (!who.includes('me') && (mode === 'percent' || mode === 'amount')) { /* paying fully for others: keep others' values */ }
    void n; afterSplitChange(t);
  }

  // ================= people prompt =================
  function askPersonName(cb) {
    modal(`<header><h2>Add a person</h2><button class="icon-btn" data-act="close">✕</button></header>
      <form class="body" id="pform" style="display:flex;flex-direction:column;gap:12px">
        <label class="field"><span>Name</span><input type="text" id="pname" placeholder="e.g. Sam, Mom, Tahoe trip crew" required autofocus></label>
        <button class="btn primary" type="submit">Add</button></form>`, 'sm', true);
    $('#pform').addEventListener('submit', e => {
      e.preventDefault(); const name = $('#pname').value.trim(); if (!name) return;
      const p = { id: uid(), name, color: PERSON_COLORS[S.people.length % PERSON_COLORS.length] };
      S.people.push(p); reindex(); save(); closeModalLayer(); cb(p);
    });
    setTimeout(() => $('#pname') && $('#pname').focus(), 30);
  }

  // ================= overlays =================
  let modalStack = null;
  function modal(html, size = '', stacked = false) {
    if (stacked) {
      modalStack = document.createElement('div'); modalStack.id = 'overlay2';
      modalStack.innerHTML = `<div class="scrim" data-act="close2" style="z-index:50"></div><div class="modal ${size}" style="z-index:51">${html.replace('data-act="close"', 'data-act="close2"')}</div>`;
      document.body.append(modalStack); return;
    }
    $('#overlay').innerHTML = `<div class="scrim" data-act="close"></div><div class="modal ${size}" role="dialog">${html}</div>`;
  }
  function closeModalLayer() { if (modalStack) { modalStack.remove(); modalStack = null; } }
  function closeOverlay() { if (modalStack) return closeModalLayer(); ui.drawer = null; const o = $('#overlay'); if (o) o.innerHTML = ''; importState = null; }
  let toastTimer;
  function toast(msg, actLabel, actFn) {
    let el = $('#toast'); if (!el) { el = document.createElement('div'); el.id = 'toast'; el.className = 'toast'; document.body.append(el); }
    el.innerHTML = esc(msg) + (actLabel ? ` <button class="btn sm" style="margin-left:10px;background:transparent;color:inherit">${esc(actLabel)}</button>` : '');
    if (actLabel) el.querySelector('button').onclick = () => { actFn(); el.remove(); };
    clearTimeout(toastTimer); toastTimer = setTimeout(() => el.remove(), actLabel ? 7000 : 3500);
  }
  function download(name, blob) {
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.append(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  }
  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch (e) {
      const ta = document.createElement('textarea'); ta.value = text; document.body.append(ta); ta.select();
      let ok = false; try { ok = document.execCommand('copy'); } catch (e2) { } ta.remove(); return ok;
    }
  }

  // ================= share summary =================
  function personSummaryText(pid, ym) {
    const p = personMap[pid]; const lines = [];
    let total = 0;
    for (const t of monthTx(ym).filter(t => !t.excluded && catKind(t) === 'spend' && t.split).sort((a, b) => a.date.localeCompare(b.date))) {
      const sh = shares(t).find(x => x[0] === pid); if (!sh || !sh[1]) continue;
      total += sh[1];
      lines.push(`• ${fmtDay(t.date)}  ${t.name}${t.note ? ` (${t.note})` : ''}: ${money(sh[1])} of ${money(t.amt)}`);
    }
    return `${p.name}: ${monthLabel(ym)}\n${lines.join('\n')}\nTotal: ${money(total)}`;
  }
  function showShareSummary(pid) {
    const ids = pid === 'all' ? S.people.map(p => p.id).filter(id => summarize(monthTx(ui.month)).people[id]) : [pid];
    const text = ids.map(id => personSummaryText(id, ui.month)).join('\n\n');
    modal(`<header><h2>Split summary · ${monthLabel(ui.month)}</h2><button class="icon-btn" data-act="close">✕</button></header>
      <div class="body" style="display:flex;flex-direction:column;gap:10px"><textarea id="sumtext" rows="14" style="font-family:var(--mono);font-size:12.5px">${esc(text)}</textarea>
      <div class="faint" style="font-size:12px">Only the items and amounts above are included. Send it by text, email, or however you like.</div></div>
      <footer><button class="btn primary" data-act="copysum" style="margin-left:auto">Copy</button></footer>`, 'sm');
  }

  // ================= import =================
  let importState = null, pdfjsReady = null;
  // pdf.js is bundled as plain inline scripts (no dynamic imports), so it works in any viewer.
  // Parsing runs in a background Worker when the browser allows one; otherwise on the main thread.
  function loadPdfjs() {
    if (pdfjsReady) return pdfjsReady;
    pdfjsReady = (async () => {
      const lib = window.pdfjsLib;
      if (!lib) throw new Error('The built-in PDF reader failed to load. Try opening Tally.html in Chrome, Edge or Firefox.');
      try {
        const src = $('#pdfjs-worker').textContent;
        const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
        const ok = await new Promise(res => {
          const to = setTimeout(() => res(false), 2500);
          w.addEventListener('message', () => { clearTimeout(to); res(true); }, { once: true });
          w.addEventListener('error', ev => { if (ev.preventDefault) ev.preventDefault(); clearTimeout(to); res(false); }, { once: true });
        });
        if (ok) lib.GlobalWorkerOptions.workerPort = w; else w.terminate();
      } catch (e) { /* main-thread fallback via globalThis.pdfjsWorker */ }
      return lib;
    })();
    pdfjsReady.catch(() => { pdfjsReady = null; });
    return pdfjsReady;
  }
  function openImport() {
    importState = { files: [] };
    modal(`<header><h2>Import statements</h2><span class="badge-private">● Read on this device. Nothing is uploaded.</span><button class="icon-btn" data-act="close">✕</button></header>
      <div class="body">
        <label class="drop" id="drop"><input type="file" id="fileinp" accept=".pdf,.csv,.qfx,.ofx,.qbo,application/pdf,text/csv" multiple hidden>
          <div style="font-size:26px">⇪</div><b>Drop statements or exports here</b> or click to choose<br><span class="faint" style="font-size:12.5px">QFX/OFX (most reliable), CSV exports, or Chase and Bilt PDFs. Several at once is fine.</span></label>
        <div id="implist"></div>
      </div>
      <footer><span class="faint" id="impsum" style="font-size:13px"></span><button class="btn" data-act="close" style="margin-left:auto">Cancel</button><button class="btn primary" id="impgo" data-act="impgo" disabled>Import</button></footer>`);
    const drop = $('#drop'), inp = $('#fileinp');
    inp.addEventListener('change', () => { handleFiles([...inp.files]); inp.value = ''; });
    drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('over'); handleFiles([...e.dataTransfer.files]); });
  }
  async function handleFiles(files) {
    for (const f of files) {
      const entry = { id: uid(), name: f.name, status: 'parsing', rows: [], showAll: false };
      importState.files.push(entry); renderImport();
      try {
        let res;
        if (/\.(qfx|ofx|qbo)$/i.test(f.name)) res = P.parseOFX(await f.text(), f.name);
        else if (/\.csv$/i.test(f.name) || f.type === 'text/csv') res = P.parseCSV(await f.text(), f.name);
        else {
          const lib = await loadPdfjs();
          let data = new Uint8Array(await f.arrayBuffer());
          const task = lib.getDocument({ data, isEvalSupported: false, disableFontFace: true, useSystemFonts: false, verbosity: 0 });
          task.onPassword = (cb, reason) => { const p = window.prompt(reason === 2 ? 'Wrong password. Try again:' : `“${f.name}” is password-protected. Enter the PDF password:`); if (p === null) task.destroy(); else cb(p); };
          const pdf = await task.promise;
          const lines = await P.linesFromPdf(pdf);
          try { await task.destroy(); } catch (e) { } data = null; // drop the file from memory
          if (!lines.length) throw new Error('This PDF has no text layer (it looks scanned). Download the statement as a PDF from the bank’s website instead.');
          entry.rawText = lines.map((l, i) => (i && l.page !== lines[i - 1].page ? `\n----- page ${l.page + 1} -----\n` : '') + l.text).join('\n');
          res = P.parseStatement(lines);
        }
        // one file can describe several accounts (an OFX with several <STMTRS>, and
        // later a PDF holding both a checking and a savings section) — each becomes
        // its own entry so it is mapped and reconciled on its own.
        const parts = (Array.isArray(res) ? res : [res]).filter(r => r.txns.length);
        if (!parts.length) throw new Error("No transactions found. If this is a statement from a bank other than Chase or Bilt, try its QFX or CSV export instead.");
        const made = parts.map((r, i) => Object.assign(
          { id: i ? uid() : entry.id, name: f.name, showAll: false, rawText: entry.rawText,
            part: parts.length > 1 ? (r.meta.acctType || (r.meta.kind === 'bank' ? 'Account' : 'Card')) + (r.meta.last4 ? ' ••' + r.meta.last4 : '') : null },
          prepareEntry(r, entry), { status: 'ready' }));
        const at = importState.files.indexOf(entry);
        if (at >= 0) importState.files.splice(at, 1, ...made);
      } catch (e) { entry.status = 'error'; entry.error = e && e.message ? e.message : String(e); }
      if (importState) renderImport();
    }
  }
  function normDesc(d) { return d.toUpperCase().replace(/[^A-Z0-9]/g, ''); }
  function prepareEntry(res, entry) {
    const { meta } = res;
    const match = S.accounts.find(a => meta.last4 && a.last4 === meta.last4 && (a.issuer === meta.issuer || meta.issuer === 'Other'))
      || S.accounts.find(a => meta.last4 && a.last4 === meta.last4)
      || S.accounts.find(a => !meta.last4 && !a.last4 && a.issuer === meta.issuer && a.kind === meta.kind);
    const acctChoice = match ? match.id : 'new';
    // Name a bank account by what the file says it is (OFX states SAVINGS/CHECKING; a
    // CSV can only hint through its file name). Calling every bank account "Checking"
    // mislabelled savings accounts.
    const hint = `${meta.acctType || ''} ${entry.name || ''}`;
    const bankWord = /sav/i.test(hint) ? 'Savings' : /check|college/i.test(hint) ? 'Checking' : 'Account';
    const newName = `${meta.issuer === 'Other' ? (meta.kind === 'bank' ? 'Bank' : 'Account') : meta.issuer} ${meta.kind === 'bank' ? bankWord : 'Card'}${meta.last4 ? ' ••' + meta.last4 : ''}`;
    const rows = res.txns.map(t => { const ac = autoCat(t.desc, t.amt); return { ...t, include: true, cat: ac.cat, catSrc: ac.src, split: ac.split, mine: ac.mine, name: (S.rules[P.merchantKey(t.desc)] || {}).name || P.merchantName(t.desc) }; });
    const e = { meta, recon: res.recon, rows, acctChoice, newName };
    markDups(e); carryBalance(e);
    return e;
  }
  // Each import remembers the account's closing balance, which is exactly the next
  // import's opening balance. That lets a download with no opening balance of its own
  // (OFX, Bilt CSV) be verified without typing it: remembered balance, plus only the
  // rows that are new, must land on the new closing balance.
  function carryBalance(f) {
    const needOpen = !f.recon || f.recon.ok === null;
    if (!needOpen || (f.balOpen != null && !f.balAuto)) return;
    const a = S.accounts.find(a => a.id === f.acctChoice);
    if (a && a.bal && (!f.meta.end || a.bal.asOf <= f.meta.end)) { f.balOpen = a.bal.amt; f.balAuto = true; }
    else if (f.balAuto) { f.balOpen = null; f.balAuto = false; }
    computeBalNote(f);
  }
  function computeBalNote(f) {
    const open = f.balOpen, close = f.balClose != null ? f.balClose : (f.recon && f.recon.closing != null ? f.recon.closing : null);
    if (open == null || close == null) { f.balNote = null; return; }
    const sum = (f.balAuto ? f.rows.filter(x => !x.dup) : f.rows).reduce((s, x) => s + x.amt, 0);
    const diff = sum - (f.meta.kind === 'bank' ? open - close : close - open);
    f.balNote = Math.abs(diff) < 1
      ? { ok: true, text: '✓ Matches: the rows explain the balance change exactly' }
      : { ok: false, text: `⚠ Off by ${money(Math.abs(diff))} — rows may be missing or misread` };
  }
  const entryVerified = f => (f.balNote ? f.balNote.ok : !!(f.recon && f.recon.ok === true));
  function markDups(e) {
    const acct = e.acctChoice;
    const existing = new Set(S.txns.filter(t => t.acct === acct).map(t => t.fp));
    const seen = {};
    for (const r of e.rows) {
      // OFX gives every transaction a bank-assigned id, so dedup is exact rather than
      // a date+amount+description guess (two identical same-day charges stay distinct).
      const base = r.fitid ? `fit|${r.fitid}` : `${r.date}|${r.amt}|${normDesc(r.desc)}`;
      seen[base] = (seen[base] || 0) + 1;
      r.fp = `${base}|${seen[base]}`;
      r.dup = acct !== 'new' && existing.has(r.fp);
      r.include = !r.dup;
    }
  }
  // How strongly this entry is verified. Balances the user typed in outrank the
  // file's own evidence, because they come from the statement itself.
  function reconPillHTML(f) {
    const r = f.recon, n = f.balNote;
    const wrap = (cls, title, text) => `<span id="imp-pill-${f.id}" class="pill ${cls}" title="${esc(title)}">${esc(text)}</span>`;
    if (n) return n.ok
      ? (f.balAuto
        ? wrap('good', 'The balance remembered from your last import, plus the new rows, lands exactly on this closing balance.', '✓ Continues exactly from your last import')
        : wrap('good', 'The rows explain the change between the balances you entered.', '✓ Matches the balances you entered'))
      : wrap('bad', 'The rows do not explain the change between the balances you entered.', n.text);
    if (!r) return wrap('warn', 'This export carries no balance, so Tally cannot confirm the rows are complete. Enter the statement balances below to check it.', 'Not verified — add balances');
    if (r.ok === true) return wrap('good', 'The rows found exactly explain the change from the opening to the closing balance.', `✓ Matches statement balance${r.via === 'running-balance' ? ` (${r.checked} row-by-row)` : ''}`);
    if (r.ok === null) return wrap('', 'This download states a closing balance but no opening one, so it can only be confirmed once an earlier period has been imported.', 'Closing balance recorded — add the opening balance to verify');
    if (r.via === 'running-balance' && r.bad && r.bad.length) return wrap('bad', 'The running balance disagrees with the amount on these rows.', `⚠ ${r.bad.length} row${r.bad.length === 1 ? '' : 's'} disagree with the running balance`);
    return wrap('warn', "The rows found don't fully explain the statement balance. Some transactions may be missing or misread.", `⚠ Off by ${money(Math.abs(r.diff))}: review rows`);
  }
  // When a file cannot prove itself, let the statement's own balances do it.
  function balFormHTML(f) {
    const r = f.recon, needOpen = !r || r.ok === null, needClose = !r;
    if (!needOpen && !needClose) return '';
    const fld = (k, label, val) => `<label>${label} <input type="text" inputmode="decimal" style="width:110px" data-act="impbal" data-k="${k}" data-f="${f.id}" value="${val == null ? '' : (val / 100).toFixed(2)}" placeholder="0.00"></label>`;
    return `<div class="faint" style="padding:6px 14px;font-size:12.5px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">
      <span>${f.balAuto ? 'Previous balance carried over from your last import:' : 'From the statement:'}</span>
      ${needOpen ? fld('open', 'Previous balance', f.balOpen) : ''}
      ${needClose ? fld('close', 'New balance', f.balClose) : ''}
      <span id="imp-note-${f.id}">${f.balNote ? `<span class="pill ${f.balNote.ok ? 'good' : 'bad'}">${esc(f.balNote.text)}</span>` : ''}</span>
    </div>`;
  }
  function renderImport() {
    if (!importState || !$('#implist')) return;
    const scrollTops = Object.fromEntries($$('#implist .scroll').map(el => [el.dataset.f, el.scrollTop]));
    $('#implist').innerHTML = importState.files.map(f => {
      if (f.status === 'parsing') return `<div class="imp"><div class="imp-h"><span class="fname">${esc(f.name)}</span><span class="faint">Reading…</span></div></div>`;
      if (f.status === 'error') return `<div class="imp"><div class="imp-h"><span class="fname">${esc(f.name)}</span><span class="pill bad">Couldn't read</span><button class="icon-btn" style="margin-left:auto" data-act="impremove" data-f="${f.id}">✕</button></div><div class="card-b"><div class="note bad">${esc(f.error)}</div>${f.rawText ? `<div style="margin-top:10px"><button class="btn sm" data-act="rawtext" data-f="${f.id}">See what Tally read from this PDF</button></div>` : ''}</div></div>`;
      const m = f.meta;
      const inc = f.rows.filter(x => x.include).length, dups = f.rows.filter(x => x.dup).length;
      const reconPill = reconPillHTML(f);
      const balForm = balFormHTML(f);
      const shown = f.showAll ? f.rows : f.rows.slice(0, 200);
      return `<div class="imp">
        <div class="imp-h"><span class="fname">${esc(f.name)}${f.part ? ` <span class="faint">› ${esc(f.part)}</span>` : ''}</span>
          <span class="pill">${esc(m.issuer)} ${m.kind === 'bank' ? 'bank account' : 'card'}</span>
          ${m.start || m.end ? `<span class="faint" style="font-size:12.5px">${m.start ? fmtDay(m.start) + ' – ' : ''}${m.end ? fmtDay(m.end) + ', ' + m.end.slice(0, 4) : ''}</span>` : ''}
          ${reconPill}
          <span style="margin-left:auto;display:flex;gap:6px;align-items:center">Account
            <select data-act="impacct" data-f="${f.id}">${S.accounts.map(a => `<option value="${a.id}" ${f.acctChoice === a.id ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}<option value="new" ${f.acctChoice === 'new' ? 'selected' : ''}>＋ New account</option></select>
            ${f.acctChoice === 'new' ? `<input type="text" data-act="impnewname" data-f="${f.id}" value="${esc(f.newName)}" style="width:170px">` : ''}</span>
          ${f.rawText ? `<button class="btn sm ghost" data-act="rawtext" data-f="${f.id}" title="Troubleshoot parsing">Raw text</button>` : ''}<button class="icon-btn" data-act="impremove" data-f="${f.id}" title="Remove file">✕</button>
        </div>
        <div class="scroll" data-f="${f.id}"><table class="tx"><thead><tr><th class="c-check"></th><th>Date</th><th>Description</th><th>Category</th><th style="text-align:right">Amount</th><th></th></tr></thead><tbody>
        ${shown.map((x, i) => `<tr class="${x.include ? '' : 'dim'}" style="${x.include ? '' : 'opacity:.55'}">
          <td><input type="checkbox" data-act="improw" data-f="${f.id}" data-i="${i}" ${x.include ? 'checked' : ''}></td>
          <td class="num" style="white-space:nowrap">${x.date}</td>
          <td><div>${esc(x.name)}</div><div class="sub">${esc(x.desc)}${x.detail ? ' · ' + esc(x.detail) : ''}</div></td>
          <td><select class="catsel ${x.cat ? '' : 'none'}" data-act="impcat" data-f="${f.id}" data-i="${i}" style="--dot:${x.cat ? esc(catMap[x.cat].color) : 'var(--warn)'}">${catOptions(x.cat)}</select></td>
          <td class="num" style="text-align:right;white-space:nowrap"><span class="${x.amt < 0 ? 'amt-in' : ''}">${x.amt < 0 ? '+' : ''}${money(Math.abs(x.amt))}</span></td>
          <td>${x.dup ? '<span class="pill">already imported</span>' : ''}</td></tr>`).join('')}
        </tbody></table>${f.rows.length > shown.length ? `<div style="padding:8px;text-align:center"><button class="btn sm" data-act="impall" data-f="${f.id}">Show all ${f.rows.length}</button></div>` : ''}</div>
        ${balForm}
        <div class="faint" style="padding:8px 14px;font-size:12.5px">${f.rows.length} rows found · ${inc} will be imported${dups ? ` · ${dups} already imported (skipped)` : ''}. <span class="faint">Spending shows as plain amounts, money in as +amounts.</span></div>
      </div>`;
    }).join('');
    $$('#implist .scroll').forEach(el => { if (scrollTops[el.dataset.f]) el.scrollTop = scrollTops[el.dataset.f]; });
    const total = importState.files.filter(f => f.status === 'ready').reduce((s, f) => s + f.rows.filter(x => x.include).length, 0);
    const busy = importState.files.some(f => f.status === 'parsing');
    $('#impgo').disabled = !total || busy;
    $('#impgo').textContent = total ? `Import ${total} transaction${total === 1 ? '' : 's'}` : 'Import';
    const ready = importState.files.filter(f => f.status === 'ready'), ver = ready.filter(entryVerified).length;
    $('#impsum').textContent = busy ? 'Reading files…' : ready.length ? `${ver} of ${ready.length} verified against a balance` : '';
  }
  function doImport() {
    const ready = importState.files.filter(f => f.status === 'ready');
    let added = 0, ord = S.txns.length, months = new Set();
    const created = {};
    const fpsByAcct = {};
    const fpSet = acct => fpsByAcct[acct] || (fpsByAcct[acct] = new Set(S.txns.filter(t => t.acct === acct).map(t => t.fp)));
    for (const f of ready) {
      let acct = f.acctChoice;
      if (acct === 'new') {
        const ck = `${f.meta.issuer}|${f.meta.kind}|${f.meta.last4 || ''}`;
        if (created[ck]) acct = created[ck];
        else {
          const a = { id: uid(), name: f.newName.trim() || 'Account', issuer: f.meta.issuer, kind: f.meta.kind, last4: f.meta.last4 };
          a.short = a.last4 ? `${a.issuer === 'Other' ? '' : a.issuer + ' '}••${a.last4}` : a.name;
          S.accounts.push(a); acct = created[ck] = a.id;
        }
      }
      const imp = { id: uid(), file: f.name, acct, start: f.meta.start, end: f.meta.end, at: Date.now(), count: 0 };
      const fps = fpSet(acct);
      for (const r of f.rows.filter(x => x.include && !fps.has(x.fp))) {
        fps.add(r.fp);
        S.txns.push({ id: uid(), acct, date: r.date, desc: r.desc, name: r.name, amt: r.amt, detail: r.detail, cat: r.cat, catSrc: r.catSrc, split: r.split ? JSON.parse(JSON.stringify(r.split)) : null, fp: r.fp, fitid: r.fitid || undefined, imp: imp.id, ord: ord++,
          // a remembered rule ("always mine" / "always split this way") is a decision already made
          rev: !!(r.split || r.mine), auto: r.split || r.mine ? true : undefined });
        if (r.catSrc === 'user' && r.cat) learnCategory({ desc: r.desc, name: r.name }, r.cat);
        imp.count++; added++; months.add(ymOf(r.date));
      }
      S.imports.push(imp);
      const close = f.balClose != null ? f.balClose : f.recon && f.recon.closing != null ? f.recon.closing : (f.meta.balances || {}).close;
      const a = S.accounts.find(a => a.id === acct);
      if (a && close != null && f.meta.end && (!a.bal || f.meta.end >= a.bal.asOf)) a.bal = { amt: close, asOf: f.meta.end };
    }
    reindex();
    const linked = linkTransfers();
    save();
    const ms = [...months].sort();
    if (ms.length && !months.has(ui.month)) ui.month = ms[ms.length - 1];
    const todo = inboxList().length;
    if (todo) ui.tab = 'inbox';
    closeOverlay(); renderShell();
    toast(`Imported ${added} transaction${added === 1 ? '' : 's'}${linked ? ` · matched ${linked} payment${linked === 1 ? '' : 's'} between your accounts` : ''}${todo ? ` · ${todo} to decide` : ''}.`);
  }

  // ================= manual add =================
  function openAdd() {
    modal(`<header><h2>Add a transaction</h2><button class="icon-btn" data-act="close">✕</button></header>
      <form class="body" id="addform" style="display:flex;flex-direction:column;gap:12px">
        <label class="field"><span>What</span><input type="text" id="a-name" placeholder="e.g. Cash: farmers market" required></label>
        <div class="row2"><label class="field"><span>Date</span><input type="date" id="a-date" value="${ui.month === todayISO().slice(0, 7) ? todayISO() : ui.month + '-01'}" required></label>
        <label class="field"><span>Amount</span><input type="text" id="a-amt" inputmode="decimal" placeholder="25.00" required></label></div>
        <label class="field"><span>Category</span><select id="a-cat">${catOptions(null)}</select></label>
        <label class="check"><input type="checkbox" id="a-in"> This is money in (refund, reimbursement, income)</label>
        <button class="btn primary" type="submit">Add</button></form>`, 'sm');
    $('#addform').addEventListener('submit', e => {
      e.preventDefault();
      let c = toCents($('#a-amt').value); if (!c) return;
      c = Math.abs(c) * ($('#a-in').checked ? -1 : 1);
      const name = $('#a-name').value.trim();
      const t = { id: uid(), acct: null, date: $('#a-date').value, desc: name, name, amt: c, cat: $('#a-cat').value || null, catSrc: 'user', split: null, manual: true, fp: 'manual|' + uid(), ord: S.txns.length };
      S.txns.push(t); ui.month = ymOf(t.date); save(); closeOverlay(); renderShell(); openDrawer(t.id);
    });
    setTimeout(() => $('#a-name').focus(), 30);
  }

  // ================= settings =================
  function openSettings(tab) { if (tab) ui.settingsTab = tab; modal(`<header><h2>Settings</h2><button class="icon-btn" data-act="close">✕</button></header><div class="settings" id="settings"></div>`); renderSettings(); }
  function renderSettings() {
    const T = [['people', 'People'], ['accounts', 'Accounts'], ['categories', 'Categories'], ['rules', 'Merchant rules'], ['security', 'Privacy & security'], ['data', 'Backup & data']];
    const tab = ui.settingsTab;
    let pane = '';
    if (tab === 'people') pane = `<h3>People you split with</h3><p class="muted" style="margin:0">Roommates, partner, family, trip friends. Each one gets a running total of their share every month.</p>
      <div class="list">${S.people.map(p => `<div class="li"><input type="color" value="${esc(p.color)}" data-act="pcolor" data-id="${p.id}"><input type="text" value="${esc(p.name)}" data-act="pname" data-id="${p.id}"><span class="faint" style="font-size:12px">${S.txns.filter(t => t.split && t.split.parts.some(x => x.p === p.id)).length} split</span><button class="icon-btn" data-act="pdel" data-id="${p.id}" title="Remove">🗑</button></div>`).join('') || '<div class="li faint">No one yet.</div>'}</div>
      <form id="padd" style="display:flex;gap:8px"><input type="text" id="padd-name" placeholder="Name" style="flex:1"><button class="btn primary" type="submit">Add person</button></form>
      <h3 style="margin-top:8px">Groups</h3><p class="muted" style="margin:0">Sets of people you often split with. In the Inbox, press a group's number to split a charge evenly between you and them.</p>
      <div class="list">${S.groups.map((g, i) => `<div class="li" style="flex-wrap:wrap"><span class="kbd">${i + 1}</span><input type="text" value="${esc(g.name)}" data-act="gname" data-id="${g.id}" style="flex:0 1 160px">
        <span style="display:flex;gap:6px;flex-wrap:wrap;flex:1">${S.people.map(p => `<button class="ptoggle ${g.members.includes(p.id) ? 'on' : ''}" data-act="gtoggle" data-id="${g.id}" data-p="${p.id}">${esc(p.name)}</button>`).join('')}</span>
        <button class="icon-btn" data-act="gdel" data-id="${g.id}" title="Delete group">🗑</button></div>`).join('') || '<div class="li faint">No groups yet.</div>'}</div>
      ${S.people.length ? `<form id="gadd" style="display:flex;gap:8px"><input type="text" id="gadd-name" placeholder="Group name, e.g. Roommates" style="flex:1"><button class="btn primary" type="submit">Add group</button></form>` : '<p class="faint" style="margin:0">Add a person first.</p>'}`;
    if (tab === 'accounts') pane = `<h3>Accounts</h3><p class="muted" style="margin:0">Created automatically when you import. Only the last 4 digits are stored.</p>
      <div class="list">${S.accounts.map(a => `<div class="li"><input type="text" value="${esc(a.name)}" data-act="aname" data-id="${a.id}"><span class="pill">${esc(a.kind === 'bank' ? 'bank' : 'card')}${a.last4 ? ' ••' + esc(a.last4) : ''}</span><span class="faint" style="font-size:12px">${S.txns.filter(t => t.acct === a.id).length} txns</span><button class="icon-btn" data-act="adel" data-id="${a.id}" title="Delete account and its transactions">🗑</button></div>`).join('') || '<div class="li faint">No accounts yet. Import a statement.</div>'}</div>`;
    if (tab === 'categories') pane = `<h3>Categories</h3><p class="muted" style="margin:0">“Transfer” categories are never counted as spending. “Income” is tracked separately.</p>
      <div class="list">${S.categories.map(c => `<div class="li"><input type="color" value="${esc(c.color)}" data-act="ccolor" data-id="${c.id}"><input type="text" value="${esc(c.name)}" data-act="cname" data-id="${c.id}">
        <select data-act="ckind" data-id="${c.id}">${[['spend', 'Spending'], ['income', 'Income'], ['transfer', 'Transfer']].map(([k, l]) => `<option value="${k}" ${c.kind === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <button class="icon-btn" data-act="cdel" data-id="${c.id}" title="Delete">🗑</button></div>`).join('')}</div>
      <form id="cadd" style="display:flex;gap:8px"><input type="text" id="cadd-name" placeholder="New category" style="flex:1"><button class="btn primary" type="submit">Add category</button></form>`;
    if (tab === 'rules') { const rules = Object.entries(S.rules).sort((a, b) => a[0].localeCompare(b[0])); pane = `<h3>Merchant rules</h3><p class="muted" style="margin:0">Learned whenever you set a category or remember a split. Applied automatically to new imports.</p>
      <div class="list">${rules.map(([k, r]) => `<div class="li"><div style="flex:1"><div style="font-weight:550">${esc(r.name || k)}</div><div class="faint" style="font-size:12px">matches “${esc(k)}”${r.split ? ' · split with ' + esc(r.split.parts.filter(p => p.p !== 'me').map(p => (personMap[p.p] || {}).name || '?').join(', ')) + ` (${r.split.mode})` : ''}</div></div>
        <select data-act="rcat" data-k="${esc(k)}">${catOptions(r.cat)}</select>${r.split ? `<button class="btn sm ghost" data-act="rnosplit" data-k="${esc(k)}">Forget split</button>` : ''}<button class="icon-btn" data-act="rdel" data-k="${esc(k)}" title="Delete rule">🗑</button></div>`).join('') || '<div class="li faint">No rules yet. Change a transaction’s category and Tally remembers it.</div>'}</div>`; }
    if (tab === 'security') pane = `<h3>Privacy & security</h3>
      <div class="note good">This page has no network access. Its security policy blocks every connection: <code style="font-size:11px">connect-src 'none'</code>, no external scripts, fonts, or images. Statements are read in memory and discarded. Only the extracted rows are kept, in this browser's storage.</div>
      ${Vault.key ? `<div class="note">🔒 Encrypted on disk with AES-256-GCM. The key is derived from your passphrase and only ever held in memory while unlocked.</div>
        <label class="field"><span>Auto-lock after inactivity</span><select data-act="autolock">${[5, 15, 30, 60, 0].map(m => `<option value="${m}" ${S.settings.autoLock === m ? 'selected' : ''}>${m ? m + ' minutes' : 'Never'}</option>`).join('')}</select></label>
        <form id="chpass" style="display:flex;flex-direction:column;gap:8px"><b>Change passphrase</b><input type="password" id="np1" placeholder="New passphrase" autocomplete="new-password"><input type="password" id="np2" placeholder="Confirm" autocomplete="new-password"><div><button class="btn" type="submit">Change passphrase</button></div></form>
        <div><button class="btn danger" data-act="rmpass">Remove passphrase (store unencrypted)</button></div>`
      : `<div class="note warn">Not encrypted. Anyone with access to this computer's browser profile could read your data.</div>
        ${Vault.canCrypto ? `<form id="chpass" style="display:flex;flex-direction:column;gap:8px"><b>Add a passphrase</b><input type="password" id="np1" placeholder="Passphrase (8+ characters)" autocomplete="new-password"><input type="password" id="np2" placeholder="Confirm" autocomplete="new-password"><div><button class="btn primary" type="submit">Encrypt my data</button></div></form>` : '<p class="muted">This browser doesn’t expose Web Crypto on this page, so encryption isn’t available.</p>'}`}`;
    if (tab === 'data') pane = `<h3>Backup & data</h3>
      <p class="muted" style="margin:0">Your data lives only in this browser. Clearing site data or switching browsers/computers loses it, so back up regularly. ${S.lastBackup ? 'Last backup: ' + new Date(S.lastBackup).toLocaleDateString() + '.' : '<b>No backup yet.</b>'}</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn primary" data-act="backup">Download ${Vault.key ? 'encrypted ' : ''}backup</button>
        <label class="btn">Restore from backup<input type="file" id="restore" accept=".tally,.json" hidden></label></div>
      ${!Vault.key ? '<label class="field"><span>Backup password (optional; encrypts the backup file)</span><input type="password" id="bpass" placeholder="Leave empty for an unencrypted file"></label>' : '<div class="faint" style="font-size:12.5px">Backups are encrypted with your passphrase, so they’re safe to keep in iCloud, Google Drive, or email.</div>'}
      <b>Automatic backup</b>
      ${Live.status !== 'off' ? `<div class="note ${Live.status === 'on' ? 'good' : 'warn'}">${Live.status === 'on' ? `Tally rewrites <b>${esc(Live.name)}</b> after every change${Live.at ? ' (last written ' + new Date(Live.at).toLocaleTimeString() + ')' : ''}.` : `Backup to <b>${esc(Live.name)}</b> is paused until you allow it again.`} ${Vault.key ? 'It is encrypted with your passphrase.' : 'It is <b>not encrypted</b> because no passphrase is set.'}</div>
        <div style="display:flex;gap:8px">${Live.status === 'paused' ? '<button class="btn primary" data-act="liveresume">Resume</button>' : ''}<button class="btn" data-act="livestop">Stop automatic backup</button></div>`
        : canLive ? `<div class="faint" style="font-size:12.5px">Pick a file once and Tally keeps it up to date after every change, so your data also exists outside the browser. Put it somewhere that is itself backed up.</div><div><button class="btn" data-act="livepick">Choose backup file…</button></div>`
          : '<div class="faint" style="font-size:12.5px">This browser cannot write to a file on its own (Chrome and Edge can). Tally will remind you when the last backup is two weeks old.</div>'}
      <hr style="border:0;border-top:1px solid var(--line);width:100%">
      <b>Export</b><div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn" data-act="csv" data-v="month">CSV: ${monthLabel(ui.month)}</button><button class="btn" data-act="csv" data-v="all">CSV: everything</button></div>
      <hr style="border:0;border-top:1px solid var(--line);width:100%">
      <b>Import history</b>
      <div class="list">${S.imports.slice().reverse().map(i => `<div class="li"><div style="flex:1"><div>${esc(i.file)}</div><div class="faint" style="font-size:12px">${esc((acctMap[i.acct] || {}).name || '')} · ${i.count} transactions · ${new Date(i.at).toLocaleDateString()}</div></div><button class="btn sm" data-act="undoimp" data-id="${i.id}">Undo import</button></div>`).join('') || '<div class="li faint">Nothing imported yet.</div>'}</div>
      <hr style="border:0;border-top:1px solid var(--line);width:100%">
      <div><button class="btn danger" data-act="wipe">Erase all data on this device</button></div>`;
    $('#settings').innerHTML = `<nav>${T.map(([k, l]) => `<button class="${tab === k ? 'on' : ''}" data-act="stab" data-v="${k}">${l}</button>`).join('')}</nav><div class="pane">${pane}</div>`;
    const f = (id, fn) => { const el = $('#' + id); if (el) el.addEventListener('submit', e => { e.preventDefault(); fn(); }); };
    f('padd', () => { const n = $('#padd-name').value.trim(); if (!n) return; S.people.push({ id: uid(), name: n, color: PERSON_COLORS[S.people.length % PERSON_COLORS.length] }); changed(); });
    f('gadd', () => { const n = $('#gadd-name').value.trim(); if (!n) return; S.groups.push({ id: uid(), name: n, members: S.people.map(p => p.id) }); changed(); });
    f('cadd', () => { const n = $('#cadd-name').value.trim(); if (!n) return; S.categories.splice(S.categories.length - 2, 0, { id: 'c' + uid().slice(0, 8), name: n, color: PERSON_COLORS[S.categories.length % PERSON_COLORS.length], kind: 'spend' }); changed(); });
    f('chpass', async () => {
      const p1 = $('#np1').value, p2 = $('#np2').value;
      if (p1.length < 8) return toast('Use at least 8 characters.'); if (p1 !== p2) return toast("Passphrases don't match.");
      await setPassphrase(p1); await flush(); toast('Your data is encrypted with the new passphrase. Download a fresh backup.'); renderShell(); openSettings('security');
    });
    const rs = $('#restore'); if (rs) rs.addEventListener('change', () => { if (rs.files[0]) restoreBackup(rs.files[0]); });
  }
  function changed() { reindex(); save(); renderSettings(); update(); }

  // backup format: { app:'tally', v:1, enc, salt?, iter?, iv?, ct? | data }
  async function buildBackup(pw) {
    if (Vault.key) { const { iv, ct } = await Vault.seal(S, Vault.key); return { app: 'tally', v: 1, enc: true, salt: b64(Vault.salt), iter: Vault.iter, iv: b64(iv), ct: b64(ct) }; }
    if (pw) { const salt = crypto.getRandomValues(new Uint8Array(16)); const key = await Vault.derive(pw, salt, ITER); const { iv, ct } = await Vault.seal(S, key); return { app: 'tally', v: 1, enc: true, salt: b64(salt), iter: ITER, iv: b64(iv), ct: b64(ct) }; }
    return { app: 'tally', v: 1, enc: false, data: S };
  }
  async function makeBackup() {
    const file = await buildBackup($('#bpass') ? $('#bpass').value : '');
    S.lastBackup = Date.now(); save();
    download(`tally-backup-${todayISO()}.tally`, new Blob([JSON.stringify(file)], { type: 'application/json' }));
    toast('Backup downloaded.'); if ($('#settings')) renderSettings(); renderBanner();
  }
  async function restoreBackup(file) {
    let obj; try { obj = JSON.parse(await file.text()); } catch (e) { return toast("That file isn't a Tally backup."); }
    if (obj.app !== 'tally') return toast("That file isn't a Tally backup.");
    let data = obj.data;
    if (obj.enc) {
      const pw = window.prompt('This backup is encrypted. Enter its passphrase:'); if (pw === null) return;
      try { const key = await Vault.derive(pw, unb64(obj.salt), obj.iter); data = await Vault.open({ iv: unb64(obj.iv), ct: unb64(obj.ct) }, key); }
      catch (e) { return toast('Wrong passphrase for this backup.'); }
    }
    const replace = !S.txns.length || window.confirm('Replace everything on this device with the backup?\n\nOK = replace · Cancel = merge (add anything missing)');
    if (replace) S = data;
    else {
      const ids = new Set(S.txns.map(t => t.id)); for (const t of data.txns) if (!ids.has(t.id)) S.txns.push(t);
      for (const k of ['people', 'accounts', 'categories', 'imports']) { const have = new Set(S[k].map(x => x.id)); for (const x of data[k] || []) if (!have.has(x.id)) S[k].push(x); }
      S.rules = { ...data.rules, ...S.rules };
    }
    migrate(); reindex(); save(); closeOverlay(); ui.month = null; start(); toast(replace ? 'Backup restored.' : 'Backup merged.');
  }
  function exportCSV(scope) {
    const list = (scope === 'month' ? monthTx(ui.month) : S.txns).slice().sort((a, b) => a.date.localeCompare(b.date));
    const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const head = ['Date', 'Merchant', 'Description', 'Account', 'Category', 'Amount', 'Your share', ...S.people.map(p => p.name + ' share'), 'Note', 'Excluded'];
    const rows = list.map(t => { const sh = Object.fromEntries(shares(t)); const k = catKind(t); return [t.date, t.name, t.desc, (acctMap[t.acct] || {}).name || 'Manual', (catMap[t.cat] || {}).name || '', (t.amt / 100).toFixed(2), k === 'spend' ? ((sh.me || 0) / 100).toFixed(2) : '', ...S.people.map(p => k === 'spend' && sh[p.id] ? (sh[p.id] / 100).toFixed(2) : ''), t.note || '', t.excluded ? 'yes' : '']; });
    download(`tally-${scope === 'month' ? ui.month : 'all'}.csv`, new Blob([[head, ...rows].map(r => r.map(q).join(',')).join('\n')], { type: 'text/csv' }));
  }

  // ================= events =================
  document.addEventListener('click', async e => {
    lastActivity = Date.now();
    const el = e.target.closest('[data-act]');
    if (!el) {
      const row = e.target.closest('tr.row'); if (row && !e.target.closest('select,input,button,a')) openDrawer(row.dataset.id);
      return;
    }
    const act = el.dataset.act, v = el.dataset.v, id = el.dataset.id;
    const t = ui.drawer && S ? S.txns.find(x => x.id === ui.drawer) : null;
    switch (act) {
      case 'ob-pass': $('#ob-choice').classList.add('hidden'); $('#ob-form').classList.remove('hidden'); $('#ob-p1').focus(); break;
      case 'ob-skip': S = blankState(); await flush(); start(); break;
      case 'forgot': if (window.confirm('Without the passphrase your data can’t be decrypted.\n\nErase everything on this device and start over? (You can restore from a backup file afterwards.)')) { await DB.del('state'); location.reload(); } break;
      case 'lock': lockNow(); break;
      case 'tab': e.preventDefault(); ui.tab = v; renderMain(); break;
      case 'mprev': ui.month = addMonth(ui.month, -1); ui.sel.clear(); renderMain(); break;
      case 'mnext': ui.month = addMonth(ui.month, 1); ui.sel.clear(); renderMain(); break;
      case 'import': openImport(); break;
      case 'add': openAdd(); break;
      case 'settings': e.preventDefault(); openSettings(v); break;
      case 'close': closeOverlay(); break;
      case 'close2': closeModalLayer(); break;
      case 'view': ui.view = v; if (ui.tab !== 'month') { ui.tab = 'month'; renderMain(); } else update(); break;
      case 'filtercat': ui.cat = ui.cat === v ? null : v; ui.view = 'spending'; update(); break;
      case 'clearcat': ui.cat = null; update(); break;
      case 'filterperson': ui.person = ui.person === v ? null : v; ui.view = 'split'; update(); break;
      case 'clearperson': ui.person = null; update(); break;
      case 'sharesum': e.preventDefault(); showShareSummary(v); break;
      case 'copysum': { const ok = await copyText($('#sumtext').value); toast(ok ? 'Copied.' : 'Select the text and copy it manually.'); break; }
      case 'open': openDrawer(id, el.dataset.focus); break;
      case 'sel': ui.sel.has(id) ? ui.sel.delete(id) : ui.sel.add(id); el.closest('tr').classList.toggle('sel'); renderBulk(); break;
      case 'selall': { const all = (ui.visible || []).every(x => ui.sel.has(x)); (ui.visible || []).forEach(x => all ? ui.sel.delete(x) : ui.sel.add(x)); renderList(); renderBulk(); break; }
      case 'bulkmine': for (const x of S.txns) if (ui.sel.has(x.id)) { x.split = null; x.rev = true; delete x.billed; } save(); update(); break;
      case 'ddone': if (t) { t.rev = true; save(); } closeOverlay(); update(); break;
      case 'redo': if (t) { t.rev = false; t.split = null; delete t.billed; delete t.auto; save(); closeOverlay(); update(); toast(`“${t.name}” is back in the Inbox.`); } break;
      case 'tri': { const x = S.txns.find(x => x.id === id); const g = S.groups.find(g => g.id === v); if (x) triage(x, v === 'mine' ? null : g ? groupSplit(g) : null, e.shiftKey); break; }
      case 'trirest': { const list = inboxList(); if (list.length && window.confirm(`Mark the remaining ${list.length} charge${list.length === 1 ? '' : 's'} as yours (not shared)?`)) { ui.lastTriage = list.map(u => ({ id: u.id, split: u.split, rev: u.rev })); for (const u of list) u.rev = true; save(); update(); toast(`Marked ${list.length} as yours.`, 'Undo', undoTriage); } break; }
      case 'bill1': { const x = S.txns.find(x => x.id === id); if (x) markBilled([x]); break; }
      case 'billall': { const b = billBuckets().find(b => b.key === el.dataset.k); if (b) markBilled(b.items); break; }
      case 'billcopy': { const b = billBuckets().find(b => b.key === el.dataset.k); if (b) { const ok = await copyText(billText(b)); toast(ok ? 'Copied. Paste it into the Splitwise expense notes.' : 'Could not copy automatically.'); } break; }
      case 'unbill': { const x = S.txns.find(x => x.id === id); if (x) { delete x.billed; save(); update(); } break; }
      case 'livepick': await livePick(); renderBanner(); if ($('#settings')) renderSettings(); break;
      case 'liveresume': try { if (Live.handle && (await Live.handle.requestPermission({ mode: 'readwrite' })) === 'granted') { Live.status = 'on'; await liveWrite(); } } catch (err) { } renderBanner(); break;
      case 'livestop': Live.handle = null; Live.status = 'off'; Live.name = ''; try { await DB.del('backupHandle'); } catch (err) { } renderBanner(); if ($('#settings')) renderSettings(); break;
      case 'gtoggle': { const g = S.groups.find(g => g.id === id); const p = el.dataset.p; if (g) { g.members = g.members.includes(p) ? g.members.filter(x => x !== p) : [...g.members, p]; changed(); } break; }
      case 'gdel': S.groups = S.groups.filter(g => g.id !== id); changed(); break;
      case 'bulkexcl': { const sel = S.txns.filter(x => ui.sel.has(x.id)); const to = !sel.every(x => x.excluded); sel.forEach(x => (x.excluded = to)); save(); update(); break; }
      case 'bulkclear': ui.sel.clear(); update(); break;
      case 'dnav': { const i = ui.visible.indexOf(ui.drawer) + Number(v); if (ui.visible[i]) openDrawer(ui.visible[i]); break; }
      case 'ptoggle': if (t) togglePerson(t, el.dataset.p); break;
      case 'addperson': if (t) askPersonName(p => togglePerson(t, p.id)); break;
      case 'smode': if (t) setMode(t, v); break;
      case 'mine': if (t) { t.split = null; afterSplitChange(t); } break;
      case 'deltx': if (t && window.confirm('Delete this transaction? (Re-importing its statement would bring it back.)')) { S.txns = S.txns.filter(x => x !== t); save(); closeOverlay(); update(); } break;
      case 'impgo': doImport(); break;
      case 'rawtext': {
        const f = importState.files.find(f => f.id === el.dataset.f);
        modal(`<header><h2>What Tally read from ${esc(f.name)}</h2><button class="icon-btn" data-act="close">✕</button></header>
          <div class="body" style="display:flex;flex-direction:column;gap:10px">
            <div class="note warn">This is your real statement text. Before sharing any of it, change names, merchants, amounts and account numbers. Keep the layout (dates, spacing, the order of columns, minus signs, CR, $) exactly as it is.</div>
            <textarea id="rawtext" rows="18" style="font-family:var(--mono);font-size:12px;white-space:pre">${esc(f.rawText)}</textarea></div>
          <footer><span class="faint" style="font-size:12px">Only shown here. Nothing is sent anywhere.</span><button class="btn primary" data-act="copyraw" style="margin-left:auto">Copy</button></footer>`, '', true);
        break;
      }
      case 'copyraw': { const ok = await copyText($('#rawtext').value); toast(ok ? 'Copied. Remember to redact before sharing.' : 'Select the text and copy it manually.'); break; }
      case 'impremove': importState.files = importState.files.filter(f => f.id !== el.dataset.f); renderImport(); break;
      case 'impall': importState.files.find(f => f.id === el.dataset.f).showAll = true; renderImport(); break;
      case 'improw': { const f = importState.files.find(f => f.id === el.dataset.f); const r = f.rows[+el.dataset.i]; r.include = el.checked; renderImport(); break; }
      case 'stab': ui.settingsTab = v; renderSettings(); break;
      case 'pdel': if (window.confirm('Remove this person? Their part of any split goes back to you.')) { S.people = S.people.filter(p => p.id !== id); for (const g of S.groups) g.members = g.members.filter(p => p !== id); for (const x of S.txns) if (x.split) { x.split.parts = x.split.parts.filter(p => p.p !== id); if (!x.split.parts.some(p => p.p !== 'me')) x.split = null; } for (const r of Object.values(S.rules)) if (r.split) { r.split.parts = r.split.parts.filter(p => p.p !== id); if (!r.split.parts.some(p => p.p !== 'me')) delete r.split; } changed(); } break;
      case 'adel': if (window.confirm('Delete this account AND all of its transactions?')) { S.accounts = S.accounts.filter(a => a.id !== id); S.txns = S.txns.filter(x => x.acct !== id); S.imports = S.imports.filter(i => i.acct !== id); changed(); } break;
      case 'cdel': if (window.confirm('Delete this category? Its transactions become uncategorized.')) { S.categories = S.categories.filter(c => c.id !== id); for (const x of S.txns) if (x.cat === id) x.cat = null; for (const [k, r] of Object.entries(S.rules)) if (r.cat === id) delete S.rules[k]; changed(); } break;
      case 'rdel': delete S.rules[el.dataset.k]; changed(); break;
      case 'rnosplit': delete S.rules[el.dataset.k].split; changed(); break;
      case 'rmpass': if (window.confirm('Store your data unencrypted on this device?')) { Vault.key = null; Vault.salt = null; await flush(); renderShell(); openSettings('security'); } break;
      case 'backup': makeBackup(); break;
      case 'csv': exportCSV(v); break;
      case 'undoimp': if (window.confirm('Remove all transactions added by this import?')) { S.txns = S.txns.filter(x => x.imp !== id); S.imports = S.imports.filter(i => i.id !== id); changed(); } break;
      case 'wipe': if (window.confirm('Erase ALL Tally data on this device? This cannot be undone.') && window.confirm('Really erase everything? Make sure you have a backup.')) { await DB.del('state'); location.reload(); } break;
    }
  });
  document.addEventListener('change', e => {
    const el = e.target; const act = el.dataset && el.dataset.act; const id = el.dataset && el.dataset.id;
    if (el.id === 'msel') { ui.month = el.value; ui.sel.clear(); renderMain(); return; }
    if (el.id === 'facct') { ui.acct = el.value; update(); return; }
    if (el.id === 'allm') { ui.allMonths = el.checked; update(); return; }
    if (!act || !S) return;
    const t = id ? S.txns.find(x => x.id === id) : null;
    switch (act) {
      case 'rowcat': if (t) setCategory(t, el.value || null); break;
      case 'bulkcat': if (el.value) { const sel = S.txns.filter(x => ui.sel.has(x.id)); sel.forEach(x => { x.cat = el.value; x.catSrc = 'user'; }); const keys = new Set(sel.map(x => P.merchantKey(x.desc))); if (keys.size === 1) learnCategory(sel[0], el.value); save(); update(); toast(`Set ${sel.length} to ${catMap[el.value].name}.`); } break;
      case 'bulksplit': {
        const apply = ids => { for (const x of S.txns) if (ui.sel.has(x.id) && catKind(x) === 'spend') { x.split = { mode: 'even', parts: ['me', ...ids].map(p => ({ p, v: 1 })) }; x.rev = true; delete x.billed; } save(); update(); toast(`Split ${ui.sel.size} transaction${ui.sel.size === 1 ? '' : 's'} evenly.`); };
        if (el.value === '__new') askPersonName(p => apply([p.id]));
        else if (el.value === '__all') apply(S.people.map(p => p.id));
        else if (el.value) apply([el.value]);
        break;
      }
      case 'impbal': {
        // An export with no balance can still be checked: type the two numbers off the
        // statement and the same gate applies. Nothing is "verified" without them.
        const f = importState.files.find(f => f.id === el.dataset.f);
        f[el.dataset.k === 'open' ? 'balOpen' : 'balClose'] = el.value.trim() ? toCents(el.value) : null;
        if (el.dataset.k === 'open') f.balAuto = false;  // a typed balance is the statement's, covering every row
        computeBalNote(f);
        // update in place: re-rendering the whole list from a blur/change handler
        // tears out the node the browser is still dispatching on
        const pill = $('#imp-pill-' + f.id), note = $('#imp-note-' + f.id);
        if (pill) pill.outerHTML = reconPillHTML(f);
        if (note) note.innerHTML = f.balNote ? `<span class="pill ${f.balNote.ok ? 'good' : 'bad'}">${esc(f.balNote.text)}</span>` : '';
        break;
      }
      case 'impacct': { const f = importState.files.find(f => f.id === el.dataset.f); f.acctChoice = el.value; markDups(f); carryBalance(f); renderImport(); break; }
      case 'impnewname': { const f = importState.files.find(f => f.id === el.dataset.f); f.newName = el.value; break; }
      case 'impcat': { const f = importState.files.find(f => f.id === el.dataset.f); const r = f.rows[+el.dataset.i]; r.cat = el.value || null; r.catSrc = 'user';
        const key = P.merchantKey(r.desc); f.rows.forEach(x => { if (x !== r && x.catSrc !== 'user' && P.merchantKey(x.desc) === key) { x.cat = r.cat; x.catSrc = 'rule'; } }); renderImport(); break; }
      case 'gname': { const g = S.groups.find(g => g.id === id); if (g) { g.name = el.value.trim() || g.name; changed(); } break; }
      case 'pname': { const p = S.people.find(p => p.id === id); p.name = el.value.trim() || p.name; changed(); break; }
      case 'pcolor': S.people.find(p => p.id === id).color = el.value; changed(); break;
      case 'aname': { const a = S.accounts.find(a => a.id === id); a.name = el.value.trim() || a.name; a.short = a.name.length <= 16 ? a.name : a.short; changed(); break; }
      case 'cname': { const c = S.categories.find(c => c.id === id); c.name = el.value.trim() || c.name; changed(); break; }
      case 'ccolor': S.categories.find(c => c.id === id).color = el.value; changed(); break;
      case 'ckind': S.categories.find(c => c.id === id).kind = el.value; changed(); break;
      case 'rcat': S.rules[el.dataset.k].cat = el.value || null; changed(); break;
      case 'autolock': S.settings.autoLock = +el.value; save(); break;
    }
  });
  let qTimer;
  document.addEventListener('input', e => {
    if (e.target.id === 'q') { clearTimeout(qTimer); qTimer = setTimeout(() => { ui.q = e.target.value.trim(); update(); }, 120); }
  });
  document.addEventListener('keydown', e => {
    lastActivity = Date.now();
    const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement && document.activeElement.tagName);
    if (e.key === 'Escape') { if (modalStack) closeModalLayer(); else if ($('#overlay') && $('#overlay').innerHTML) closeOverlay(); return; }
    if (typing) return;
    // inbox triage: one key per charge
    if (S && ui.tab === 'inbox' && !ui.drawer && !modalStack && !($('#overlay') && $('#overlay').innerHTML) && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const i = ui.visible.indexOf(ui.cur), t = S.txns.find(x => x.id === ui.cur), k = e.key.toLowerCase();
      const digit = /^Digit([1-9])$/.exec(e.code || '');
      if (k === 'j' || e.key === 'ArrowDown') { e.preventDefault(); if (ui.visible[i + 1]) { ui.cur = ui.visible[i + 1]; renderInbox(); } return; }
      if (k === 'k' || e.key === 'ArrowUp') { e.preventDefault(); if (ui.visible[i - 1]) { ui.cur = ui.visible[i - 1]; renderInbox(); } return; }
      if (k === 'u') { undoTriage(); return; }
      if (t && k === 'm') { triage(t, null, e.shiftKey); return; }
      if (t && digit) { const g = keyGroups()[+digit[1] - 1]; if (g) { e.preventDefault(); triage(t, groupSplit(g), e.shiftKey); } return; }
      if (t && (k === 's' || e.key === 'Enter')) { e.preventDefault(); openDrawer(t.id, 'split'); return; }
    }
    if (e.key === '/' && $('#q')) { e.preventDefault(); $('#q').focus(); }
    if (ui.drawer && (e.key === 'j' || e.key === 'k' || e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault(); const i = ui.visible.indexOf(ui.drawer) + (e.key === 'j' || e.key === 'ArrowDown' ? 1 : -1); if (ui.visible[i]) openDrawer(ui.visible[i]);
    }
  });
  ['mousemove', 'touchstart', 'scroll'].forEach(ev => document.addEventListener(ev, () => (lastActivity = Date.now()), { passive: true }));
  setInterval(() => { if (Vault.key && S && S.settings.autoLock && Date.now() - lastActivity > S.settings.autoLock * 60000) lockNow(); }, 20000);

  window.__tally = { get state() { return S; }, flush, bill: () => billBuckets().map(b => ({ name: b.name, owed: b.owed, total: b.total, even: b.even, n: b.items.length, text: billText(b) })), inbox: () => inboxList().length }; // for tests / console inspection; local only
  boot();
})();
