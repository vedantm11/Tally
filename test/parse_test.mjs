/* Parser assertions. Every fixture PDF has a <name>.expected.json written by the
   generator (test/gen_*.py) holding the rows it actually drew. We assert the parser
   recovers them exactly — count, dates, amounts, descriptions, metadata — and that
   reconciliation passes. Run with -v to also print the parsed rows.

   Reconciliation is the correctness gate: it must pass with diff 0. Never relax it. */
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import fs from 'fs'; import path from 'path'; import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const P = require('../src/parser.js');

const dir = process.argv.find(a => !a.startsWith('-') && a !== process.argv[0] && a !== process.argv[1])
  || new URL('./fixtures', import.meta.url).pathname;
const verbose = process.argv.includes('-v') || process.argv.includes('--verbose');

const norm = s => String(s).toUpperCase().replace(/[^A-Z0-9]/g, '');
const cents = c => (c / 100).toFixed(2);

let failures = 0, checks = 0;
const results = [];

for (const ef of fs.readdirSync(dir).filter(f => f.endsWith('.expected.json')).sort()) {
  const exp = JSON.parse(fs.readFileSync(path.join(dir, ef), 'utf8'));
  const pdfPath = path.join(dir, exp.file);
  const errs = [];
  const fail = m => { errs.push(m); failures++; };
  const eq = (label, got, want) => { checks++; if (got !== want) fail(`${label}: got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`); };

  if (!fs.existsSync(pdfPath)) { fail(`missing source file ${exp.file}`); results.push([exp.file, errs]); continue; }

  let meta, txns, recon;
  if (/\.csv$/i.test(exp.file)) {
    ({ meta, txns, recon } = P.parseCSV(fs.readFileSync(pdfPath, 'utf8'), exp.file));
  } else if (/\.(qfx|ofx|qbo)$/i.test(exp.file)) {
    const stmts = P.parseOFX(fs.readFileSync(pdfPath, 'latin1'), exp.file);
    eq('statements in file', stmts.length, exp.statements || 1);
    ({ meta, txns, recon } = stmts[0]);
  } else {
    const pdf = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(pdfPath)), isEvalSupported: false }).promise;
    ({ meta, txns, recon } = P.parseStatement(await P.linesFromPdf(pdf)));
  }

  // --- metadata ---
  for (const k of ['issuer', 'kind', 'last4', 'start', 'end']) eq(`meta.${k}`, meta[k] ?? null, exp.meta[k] ?? null);
  eq('meta.balances.open', meta.balances.open ?? null, exp.meta.balances.open ?? null);
  eq('meta.balances.close', meta.balances.close ?? null, exp.meta.balances.close ?? null);

  // --- transactions ---
  eq('transaction count', txns.length, exp.count);
  const sum = txns.reduce((s, t) => s + t.amt, 0);
  eq('sum of amounts', sum, exp.sum);

  for (let i = 0; i < Math.max(txns.length, exp.txns.length); i++) {
    const got = txns[i], want = exp.txns[i];
    if (!want) { fail(`row ${i}: unexpected extra row ${got.date} ${cents(got.amt)} "${got.desc}"`); continue; }
    if (!got) { fail(`row ${i}: missing row, expected ${want.date} ${cents(want.amt)} "${want.desc}"`); continue; }
    checks += 3;
    if (got.date !== want.date) fail(`row ${i} date: got ${got.date}, expected ${want.date} ("${want.desc}")`);
    if (got.amt !== want.amt) fail(`row ${i} amount: got ${cents(got.amt)}, expected ${cents(want.amt)} ("${want.desc}")`);
    if (norm(got.desc) !== norm(want.desc)) fail(`row ${i} description:\n      got      "${got.desc}"\n      expected "${want.desc}"`);
  }

  // --- reconciliation: the correctness gate ---
  // What the source can prove differs by format, so assert the strongest check the
  // file actually supports — never less, and never a green tick it hasn't earned.
  // An opening balance means the file can be fully checked — either against its closing
  // balance, or (Bilt Obsidian) against its "Total ... this period" lines.
  const haveOpen = exp.meta.balances.open != null, haveClose = exp.meta.balances.close != null;
  checks++;
  if (haveOpen) {                                    // full check: rows must explain the balance change
    if (!recon) fail('no reconciliation performed, but the file states opening and closing balances');
    else {
      eq('recon.ok', recon.ok, true);
      eq('recon.diff', recon.diff, 0);
      eq('recon.parsed', recon.parsed, exp.sum);
      eq('recon.expected', recon.expected, exp.sum);
      if (recon.via === 'running-balance') eq('recon.bad (rows whose balance delta disagrees)', recon.bad.length, 0);
    }
  } else if (haveClose) {                            // OFX: closing balance only, not yet verifiable
    if (!recon) fail('no reconciliation performed, but the file states a closing balance');
    else {
      eq('recon.via', recon.via, 'ledger-balance');
      eq('recon.closing', recon.closing, exp.meta.balances.close);
      eq('recon.parsed', recon.parsed, exp.sum);
      eq('recon.ok (must be null, not a green tick it has not earned)', recon.ok, null);
    }
  } else {                                           // no balance in the file at all
    if (recon && recon.ok === true) fail('claims a passing reconciliation, but the file carries no balance to check against');
  }

  results.push([exp.file, errs, { meta, txns, recon }]);
}

// --- report ---
for (const [file, errs, parsed] of results) {
  const ok = !errs.length;
  const r = parsed && parsed.recon;
  const reconLabel = !r ? 'NOT VERIFIABLE (no balance in file)'
    : r.ok === true ? `ok via ${r.via || 'balances'}${r.checked ? ` (${r.checked} row deltas)` : ''}`
      : r.ok === null ? `closing balance recorded, unverified (${r.via})`
        : `OFF BY ${cents(r.diff)}`;
  console.log(`${ok ? '  ok' : 'FAIL'}  ${file.padEnd(30)}${parsed ? `${String(parsed.txns.length).padStart(3)} rows  ${reconLabel}` : ''}`);
  for (const e of errs) console.log(`      ✗ ${e}`);
  if (verbose && parsed) for (const t of parsed.txns)
    console.log(`        ${t.date} ${cents(t.amt).padStart(10)} | ${P.merchantName(t.desc).padEnd(26)} | ${P.merchantKey(t.desc).padEnd(22)} | ${P.guessCategory(t.desc) || '-'}${t.detail ? '  [+' + t.detail + ']' : ''}`);
}

if (!results.length) { console.error('No .expected.json fixtures found in ' + dir); process.exit(1); }
console.log(`\n${results.length} fixtures, ${checks} assertions, ${failures} failure${failures === 1 ? '' : 's'}.`);
process.exit(failures ? 1 : 0);
