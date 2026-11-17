/* End-to-end run of the built dist/Tally.html from disk.
   Hard requirements asserted at the end: no network requests, no console messages. */
import { chromium } from 'playwright';
import fs from 'fs';
const problems = [];
const assert = (cond, msg) => { if (!cond) { problems.push(msg); console.log('  ASSERT FAILED: ' + msg); } };
const out = process.argv[2] || 'test/.shots'; fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1380, height: 900 }, acceptDownloads: true });
const page = await ctx.newPage();
const requests = [], errors = [];
page.on('request', r => { if (!/^(file|blob|data):/.test(r.url())) requests.push(r.url()); });
page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.type() + ': ' + m.text().slice(0, 200)); });
page.on('pageerror', e => errors.push('PAGEERROR ' + e.message));
page.on('dialog', d => d.accept());
// Stand-in for the native "save file" picker, which a headless browser cannot drive:
// a handle that records what Tally writes to the automatic backup file.
await page.addInitScript(() => {
  window.__live = [];
  window.showSaveFilePicker = async () => ({
    name: 'mock-backup.tally',
    queryPermission: async () => 'granted', requestPermission: async () => 'granted',
    createWritable: async () => ({ write: async d => { window.__live.push(d); }, close: async () => { } }),
  });
});
const state = fn => page.evaluate(fn);
const url = new URL('../dist/Tally.html', import.meta.url).href;
await page.goto(url);
await page.click('[data-act=ob-pass]');
await page.fill('#ob-p1', 'correct horse battery'); await page.fill('#ob-p2', 'correct horse battery');
await page.click('#ob-form button[type=submit]');
await page.waitForSelector('text=Import your first statement');

// ---------- people and a group ----------
await page.click('.empty [data-act=settings]');
for (const n of ['Sam', 'Alex']) { await page.fill('#padd-name', n); await page.click('#padd button'); }
await page.fill('#gadd-name', 'Roommates'); await page.click('#gadd button');
assert(await state(() => window.__tally.state.groups.length === 1 && window.__tally.state.groups[0].members.length === 2), 'group "Roommates" should hold both people');
await page.click('.modal [data-act=close]');

// ---------- import: PDF + CSV + QFX ----------
await page.click('header [data-act=import]');
const files = fs.readdirSync('test/fixtures').filter(f => /\.(pdf|csv|qfx)$/.test(f) && !f.includes('_next')).map(f => 'test/fixtures/' + f);
await page.setInputFiles('#fileinp', files);
await page.waitForFunction(n => document.querySelectorAll('.imp').length === n && !document.body.innerText.includes('Reading…'), files.length, { timeout: 30000 });
console.log('recon pills:', await page.$$eval('.imp-h .pill[id]', els => els.map(e => e.textContent.trim())));
await page.screenshot({ path: out + '/1-import.png' });

// an export with no balance of its own is "not verified" until the statement's
// balances are typed in — then the same gate applies and must pass.
const biltCsv = page.locator('.imp', { hasText: 'bilt_card_export.csv' });
assert(await biltCsv.locator('.pill.warn', { hasText: 'Not verified' }).count() === 1, 'Bilt CSV should start unverified');
const setBal = async (k, v) => { const i = biltCsv.locator(`[data-act=impbal][data-k=${k}]`); await i.fill(v); await i.dispatchEvent('change'); };
await setBal('open', '1000.00');
await setBal('close', '3049.76');
await biltCsv.locator('.pill.good').first().waitFor({ timeout: 5000 });
// and a wrong closing balance must be rejected, not quietly accepted
await setBal('close', '3000.00');
await biltCsv.locator('.pill.bad').first().waitFor({ timeout: 5000 });
console.log('bilt csv with wrong balance:', (await biltCsv.locator('.pill.bad').first().textContent()).trim());
assert(await biltCsv.locator('.pill.good').count() === 0, 'a wrong balance must not leave a passing mark');
await setBal('close', '3049.76');   // leave it correct for the import below
console.log('import button:', await page.textContent('#impgo'));
await page.click('#impgo');

// ---------- inbox: every new charge starts undecided ----------
await page.waitForSelector('#inbox');
console.log('toast:', await page.textContent('#toast').catch(() => ''));
const total = await state(() => window.__tally.state.txns.length);
const n0 = await state(() => window.__tally.inbox());
console.log('imported', total, '· inbox', n0, '· tab badge:', (await page.textContent('#tab-inbox-n')).trim());
assert(n0 > 10, 'inbox should hold the undecided charges');
assert(await state(() => window.__tally.state.txns.filter(t => !t.rev).every(t => !t.split)), 'nothing undecided should carry a split');
await page.screenshot({ path: out + '/2-inbox.png' });
// every list is newest first: read the row order off the page and look the dates up in state
const rowDates = sel => page.$$eval(sel, els => els.map(e => window.__tally.state.txns.find(t => t.id === e.dataset.id).date));
const sorted = a => a.length > 1 && a.every((v, i) => i === 0 || a[i - 1] >= v);
assert(sorted(await rowDates('#inbox tr.row')), 'inbox should be ordered newest first');
// keyboard: 1 = split with the first group, M = mine, U = undo
await page.keyboard.press('1');
assert(await state(() => window.__tally.inbox()) === n0 - 1, 'pressing 1 should decide one charge');
assert(await state(() => { const t = window.__tally.state.txns.find(t => t.split && t.rev); return t && t.split.mode === 'even' && t.split.parts.length === 3; }), 'pressing 1 should split evenly: you + 2 roommates');
await page.keyboard.press('m');
assert(await state(() => window.__tally.inbox()) === n0 - 2, 'pressing M should decide one more');
await page.keyboard.press('u');
assert(await state(() => window.__tally.inbox()) === n0 - 1, 'U should undo the last decision');
await page.keyboard.press('j'); await page.keyboard.press('k');
// Shift = always: decide every undecided charge from that merchant and remember the rule
const housing = page.locator('#inbox tr.row', { hasText: 'Bilt Housing' });
const nh = await housing.count();
assert(nh >= 2, 'fixture should have a repeating merchant in the inbox');
const before = await state(() => window.__tally.inbox());
await housing.first().locator('[data-act=tri]', { hasText: 'Roommates' }).click({ modifiers: ['Shift'] });
assert(await state(() => window.__tally.inbox()) === before - nh, 'Shift+group should decide all charges from that merchant');
assert(await state(() => Object.values(window.__tally.state.rules).some(r => r.split && r.split.parts.length === 3)), 'Shift+group should remember the split rule');
// everything left is mine
await page.click('[data-act=trirest]');
await page.waitForSelector('text=Inbox zero');
assert(await state(() => window.__tally.inbox()) === 0, 'inbox should be empty');

// ---------- month view (unchanged behaviour) ----------
await page.click('[data-act=tab][data-v=month]');
await page.waitForSelector('#list table');
await page.selectOption('#msel', '2025-12');
await page.screenshot({ path: out + '/3-month.png', fullPage: true });
// December's "Bilt Rent" was left as mine above. Give it a custom split: Sam takes 60%.
await page.click('tr.row:has-text("Bilt Rent")');
await page.click('.drawer [data-act=ptoggle]:has-text("Sam")');
await page.click('.drawer [data-act=smode][data-v=percent]');
await page.locator('.drawer [data-act=splitval]').first().fill('60');
await page.check('#d-remember');
await page.screenshot({ path: out + '/4-drawer-pct.png' });
await page.click('.drawer [data-act=ddone]');
await page.selectOption('tr.row:has-text("Zelle") select.catsel', 'rent');
console.log('stats:', (await page.textContent('#stats')).replace(/\s+/g, ' '));
for (const v of ['all', 'income', 'transfers']) {
  await page.click(`[data-act=view][data-v=${v}]`);
  assert(sorted(await rowDates('#list tr.row')), `month view "${v}" should be ordered newest first`);
}
const transfers = await page.$$eval('tr.row', r => r.map(x => x.innerText));
assert(transfers.filter(x => x.includes('↔ matched')).length >= 4, 'payments between own accounts should be matched and kept out of spending');
await page.click('[data-act=view][data-v=spending]');

// ---------- to bill: one Splitwise entry per set of people ----------
await page.click('[data-act=tab][data-v=bill]');
await page.waitForSelector('.card.bill');
const buckets = await state(() => window.__tally.bill());
console.log('to bill:', buckets.map(b => `${b.name}: ${b.n} items, owed ${(b.owed / 100).toFixed(2)}, ${b.even ? 'equal' : 'exact'}`));
console.log('--- copy text ---\n' + buckets[0].text + '\n-----------------');
const room = buckets.find(b => b.name === 'Roommates');
assert(room && room.even, 'the Roommates bucket should be an equal split');
// rent split three ways: the two roommates owe exactly one third each, as Splitwise will compute it
assert(room && room.owed === 2 * Math.round(room.total / 3), 'each roommate owes exactly a third of the total');
assert(room && /Sam owes (\$[\d,.]+) · Alex owes \1\n/.test(room.text), 'an equal split should quote equal amounts');
const sam = buckets.find(b => b.name === 'Sam');
assert(sam && !sam.even && sam.owed === 147000, 'the 60% rent split with Sam should be an exact-amount bucket of 1470.00');
assert(/Sam owes \$1,470\.00/.test(sam ? sam.text : ''), 'copy text should state what Sam owes');
await page.screenshot({ path: out + '/5-tobill.png', fullPage: true });
await page.click('.card.bill:has-text("Roommates") [data-act=billall]');
assert((await state(() => window.__tally.bill())).every(b => b.name !== 'Roommates'), 'billed items should leave the To bill list');
await page.click('details summary');
await page.locator('[data-act=unbill]').first().click();
assert((await state(() => window.__tally.bill())).some(b => b.name === 'Roommates' && b.n === 1), '"Not billed" should put one item back');
await page.click('.card.bill:has-text("Roommates") [data-act=bill1]');
// changing a split after billing must send it back
await page.click('[data-act=tab][data-v=month]');
await page.selectOption('#msel', '2026-10');
await page.click('tr.row:has-text("Bilt Housing")');
await page.click('.drawer [data-act=mine]');
await page.click('.drawer [data-act=ddone]');
assert(await state(() => window.__tally.state.txns.filter(t => /BILT HOUSING/.test(t.desc) && t.date === '2026-10-01').every(t => !t.billed && !t.split)), 'un-splitting a billed charge should clear its billed mark');
// a wrong decision can be sent back to the Inbox, then decided again
await page.click('tr.row:has-text("Bilt Housing")');
await page.click('.drawer [data-act=redo]');
assert(await state(() => window.__tally.inbox()) === 1, '"Back to Inbox" should make the charge undecided again');
await page.click('[data-act=tab][data-v=inbox]');
await page.keyboard.press('m');
assert(await state(() => window.__tally.inbox()) === 0, 'and it can be decided again');
await page.click('[data-act=tab][data-v=month]');

// ---------- a follow-up download: exact dedup + verified by the carried balance ----------
await page.click('header [data-act=import]');
await page.setInputFiles('#fileinp', ['test/fixtures/chase_savings_next.qfx']);
await page.waitForSelector('.imp .imp-h select');
const nextPill = (await page.textContent('.imp-h .pill[id]')).trim();
console.log('follow-up qfx:', nextPill, '|', (await page.textContent('.imp .faint:last-child')).trim(), '|', await page.textContent('#impgo'));
assert(/Continues exactly/.test(nextPill), 'a follow-up OFX should verify against the balance carried from the last import');
assert(/Import 3 transactions/.test(await page.textContent('#impgo')), 'the two overlapping rows should be recognised by FITID and skipped');
await page.click('#impgo');
await page.waitForFunction(() => !document.querySelector('.modal'));
// re-importing a whole file adds nothing
await page.click('header [data-act=import]');
await page.setInputFiles('#fileinp', ['test/fixtures/chase_sapphire_2026-01.pdf']);
await page.waitForSelector('.imp .imp-h select');
assert(/0 will be imported/.test(await page.textContent('.imp .faint:last-child')), 're-importing a statement should add nothing');
await page.keyboard.press('Escape');

// ---------- trends, backup, automatic backup file ----------
await page.click('[data-act=tab][data-v=trends]');
await page.screenshot({ path: out + '/6-trends.png', fullPage: true });
await page.click('[data-act=tab][data-v=month]');
assert(await page.locator('#banner .banner').count() === 1, 'with no backup yet, the banner should say so');
await page.click('header [data-act=settings]'); await page.click('[data-act=stab][data-v=data]');
const [dl] = await Promise.all([page.waitForEvent('download'), page.click('.settings [data-act=backup]')]);
const bpath = out + '/backup.tally'; await dl.saveAs(bpath);
const b = JSON.parse(fs.readFileSync(bpath, 'utf8'));
assert(b.enc === true && !fs.readFileSync(bpath, 'utf8').includes('Trader'), 'the backup must be encrypted');
await page.click('.settings [data-act=livepick]');
await page.waitForFunction(() => window.__live.length >= 1);
const live1 = JSON.parse(await state(() => window.__live[0]));
assert(live1.app === 'tally' && live1.enc === true && !JSON.stringify(live1).includes('Trader'), 'the automatic backup file must be a valid encrypted backup');
await page.keyboard.press('Escape');
await page.selectOption('#msel', '2026-10');
await page.selectOption('tr.row >> nth=0 >> select.catsel', 'other');   // any change...
await page.waitForFunction(() => window.__live.length >= 2, null, { timeout: 8000 });   // ...is written out on its own
console.log('automatic backup writes:', await state(() => window.__live.length));
assert(await page.locator('#banner .banner').count() === 0, 'the backup banner should clear once backups are automatic');

// ---------- persisted state is encrypted; lock screen ----------
await state(() => window.__tally.flush());
await page.reload();
await page.waitForSelector('#lock-p');
await page.fill('#lock-p', 'nope'); await page.click('#lock-form .primary'); await page.waitForSelector('#lock-err:not(.hidden)');
await page.fill('#lock-p', 'correct horse battery'); await page.click('#lock-form .primary');
await page.waitForSelector('#stats, #inbox');
console.log('after unlock: txns', await state(() => window.__tally.state.txns.length), '· inbox', await state(() => window.__tally.inbox()), '· groups', await state(() => window.__tally.state.groups.length));
assert(await state(() => window.__tally.state.txns.length) === total + 3, 'all transactions should survive a reload');
const raw = await page.evaluate(() => new Promise(res => { const r = indexedDB.open('tally'); r.onsuccess = () => { const q = r.result.transaction('kv').objectStore('kv').get('state'); q.onsuccess = () => res({ enc: q.result.enc, keys: Object.keys(q.result) }); }; }));
assert(raw.enc === true && !raw.keys.includes('data'), 'state at rest must be encrypted');
await page.setViewportSize({ width: 390, height: 844 });
await page.screenshot({ path: out + '/7-mobile.png', fullPage: false });

console.log('NETWORK REQUESTS:', requests);
console.log('CONSOLE:', errors.slice(0, 20));
// the privacy guarantee and a clean console are hard requirements, not notes
assert(requests.length === 0, `made ${requests.length} network request(s): ${requests.join(', ')}`);
assert(errors.length === 0, `${errors.length} console error/warning(s): ${errors.slice(0, 5).join(' | ')}`);
await browser.close();
if (problems.length) { console.error(`\ne2e FAILED (${problems.length}):\n` + problems.map(p => '  ✗ ' + p).join('\n')); process.exit(1); }
console.log('\ne2e ok — no network requests, no console errors.');
