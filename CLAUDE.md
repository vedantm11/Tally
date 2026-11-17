# Tally: notes for Claude Code

Private, local-first expense tracker. Single offline HTML file built from `src/`.
Started in a claude.ai chat; this file is the handoff.

## Status
Working personal tool, used day to day with a handful of Chase and Bilt accounts
(checking and savings via CSV/QFX, cards via QFX/CSV). All work is on `main`;
`npm test` is green (parser fixtures plus an e2e that asserts zero network requests
and zero console messages).

**Open items / unverified:**
- Account matching: Tally takes the account number from the CSV file name or the QFX
  `ACCTID`, never from the rows. If rows land under the wrong account, check the file
  name / `ACCTID` and Settings → Backup & data → Import history first; a bug would be in
  `prepareEntry`/`doImport`. There is no "move transactions to another account" or
  "edit last 4" feature yet, which would be worth adding.
- Rent can appear twice (the bank-side pull to Bilt and the Bilt-side payment). A default
  rule marks the bank side as a transfer so it counts once.
- Whether a Bilt custom-date-range export reconciles against statement balances.
- The Chase card QFX balance sign (see "What the app is for").
- Automatic backup depends on the File System Access API. Some browsers (e.g. Brave)
  disable it by default, leaving only the stale-backup banner, and "clear data on exit"
  settings would wipe Tally's storage.

**Design preferences:**
- Every transaction list is sorted **newest first**.
- Splitwise integration is copy-paste only; no network anywhere, including scripts.
- Keep scope small; sharing with others comes later.

**Working with real financial files:** never open, print or quote a real statement or
export. Only run scripts that output structure and counts (column names, OFX tag names,
row counts, digit-masked format patterns, pass/fail). Do not copy anything from real data
into the repo.

## Product goals
- See every transaction month by month; mark each as "mine" or split it with people.
- Splits are fully customizable (even, %, $, shares) and just *assignments* (no Splitwise-style debts/settle-up).
- Monthly summary: my spending by category + total assigned to each person.
- Auto-categorize; learn merchant rules when the person corrects a category.
- Multiple accounts; payments/transfers between own accounts must not count as spending.
- Starts as a personal tool; later shareable. (The old "works with any bank" goal was
  dropped — see Scope decision below.)

## What the app is for (Nov 2026)
The typical user pays for most shared things, bills friends through Splitwise, and loses
track of what has been billed. Tally is the step *before* Splitwise: statements in,
"who owes me what" out, nothing forgotten. Splitwise stays the place friends see and
settle; Tally never talks to it (copy-paste only — no network at all).

The app is organised as two queues, not a ledger:
- **Inbox** — every imported spend charge starts undecided (`t.rev` false). Decide with
  one key: `M` mine, `1`–`9` split evenly with a saved group (`S.groups`), `S` custom
  split in the drawer, `U` undo, Shift = also remember it for the merchant
  (`rule.mine` / `rule.split`, applied to that merchant's other undecided charges and to
  future imports, which then arrive already decided with `t.auto`). "The rest are mine"
  clears what's left.
- **To bill** — decided, shared, not yet `t.billed`. Grouped by the set of people sharing
  (`billBuckets`), because that is one Splitwise entry: one total, paid by the owner, split
  equally or by exact amounts. Equal buckets quote `total / n` per person (what Splitwise
  will compute), not the sum of per-item roundings. Editing a split after billing clears
  `t.billed` so it comes back.
Month and Trends are the reference views. No settle-up or balances — Splitwise owns that.

Storage durability: where the browser has `showSaveFilePicker` (Chrome/Edge, works from
`file://`), the person picks a backup file once and Tally rewrites it after every save
(`Live*` in app.js; handle kept in IndexedDB, permission may need a click to resume per
visit). Elsewhere a banner nags when the last backup is 14+ days old. The picker itself
is only exercised through a stand-in handle in the e2e; real-browser permission
persistence across restarts has not been verified.

Each import stores the account's closing balance (`account.bal`), which is the next
import's opening balance — so OFX and Bilt CSV, which have no opening balance of their
own, verify automatically from the second import on (`carryBalance`: remembered balance
+ only the non-duplicate rows must land on the new closing balance).
OFX card balances are assumed negative-when-owed and flipped to statement style; this is
untested against a real Chase card QFX.

## Hard constraints
- **Privacy first.** No network at runtime (CSP `connect-src 'none'`, no CDNs, inline everything). No AI/cloud parsing at runtime.
- **Never commit real statements or real personal data.** Test only on fake fixtures in `test/fixtures/` (generated by `test/gen_*.py`). Put real files in `private/` (gitignored) and never paste their contents into commits, tests or docs.
- Money is integer cents. Convention: `amt > 0` = money out (spending), `amt < 0` = money in.
- Keep the deliverable a single self-contained `dist/Tally.html` that works when opened from disk (file://) and in sandboxed viewers (no dynamic `import()` of blob URLs).

## Layout
- `src/parser.js`: PDF text → lines with x/y (`linesFromPdf`), statement metadata (`detectMeta`), transactions (`parseStatement`), `parseCSV`, `parseOFX`, merchant name/key cleanup, default category rules. Works in Node and browser. `parseOFX` returns an **array** of statements (one per account in the file); `parseCSV`/`parseStatement` return a single one — `handleFiles` normalises both to a list of import entries.
- `src/app.js`: UI, state, IndexedDB storage, encryption, import flow, splits, settings, backup. Vanilla JS, event delegation via `data-act`.
- `src/styles.css`, `src/index.html`: template; `build.mjs` inlines CSS, pdf.js (converted to classic scripts), and computes CSP hashes.
- `test/parse_test.mjs`: asserts every fixture against the `<name>.expected.json` ground truth its generator wrote (count, dates, amounts, descriptions, metadata, reconciliation diff 0); exits non-zero on any mismatch. `-v` also prints the rows. `test/e2e.mjs`: Playwright run of the built file (asserts no network requests).

## How parsing works today
1. Rebuild lines from pdf.js text items (group by y, tokens keep x positions).
2. Find column headers (Date/Description/Amount/Credits/Charges/Balance) → assign amounts to columns by x.
3. A transaction line = leading date (`MM/DD`, `MM/DD/YY`, or `Jul 22, 2026`) + description + trailing amount(s).
   Lines under a transaction without date/amount become `detail` (addresses, FX info).
4. Year inferred from statement period. Sign from column type, minus/CR/parentheses, and account kind.
5. **Reconciliation** is the correctness gate: opening/closing balance (or "Total … this period" lines) must equal the sum of parsed rows. Shown in the import preview.

Supported and tested: Chase credit card, Chase checking, Bilt (Wells Fargo-era columns,
Bilt Obsidian / Cardless layout) as PDF; Chase checking and Bilt card as CSV; OFX/QFX/QBO.

**CSV and OFX sign conventions are explicit, never guessed.** In order of preference:
a DEBIT/CREDIT column (Chase checking CSV has one), separate debit/credit columns, the
direction implied by a running balance, then a per-kind default (bank: negative = out;
card: positive = charge). `meta.signSource` records which was used. The old "if most
amounts are negative, flip them all" heuristic silently inverted a whole import on a
month with few charges and one large refund — do not reintroduce it.
OFX `TRNAMT` is negative for money out, the opposite of Tally, so it is flipped.
OFX 1.x is SGML with unclosed leaf tags, so `DOMParser` cannot read it; container tags
*are* closed, so blocks are cut by closing tag and leaves read up to the next `<`.

## Scope decision (Oct 2026)
Personal tool, **Chase + Bilt only** for now — no generic multi-bank ambitions, so no
data-driven "layout profiles" (premature for two issuers). Prefer **structured exports
over PDF**; PDF stays for backfilling old months and as the fallback.

- **Chase** offers QFX / QBO / CSV / QIF via "Download account activity". Use **QFX**
  (QFX and QBO are both OFX underneath, so one parser covers both). Avoid QIF — no
  transaction ids, no balance, ambiguous dates.
- **Bilt** has *no* OFX/QFX. Since the Jan 2026 "Bilt 2.0" move (Column N.A. / Cardless)
  it offers **CSV** per statement period. So Bilt = CSV, with PDF as backup.

## Reconciliation modes (the correctness gate — never weaken these)
A row set counts as correct only when one of these passes. `recon.ok` is `true`,
`false`, or `null` — **`null` means "not yet verifiable", never a pass.**
- `balances` — PDF: opening/closing balances must explain the sum of rows.
- `totals` — PDF with no closing balance: "Total … this period" lines must sum to it.
- `running-balance` — CSV with a Balance column: every adjacent pair must satisfy
  `balance delta == -amt`. Stronger than open-vs-close: it names the offending row, and
  it catches an edited row that leaves the overall total intact.
- `ledger-balance` — OFX: only a closing balance exists, so `ok` is `null` until the
  user supplies an opening balance (or a prior period is imported). Deriving the opening
  balance from the same rows would make the check pass by construction — don't.
- user-entered balances — any export with no balance of its own (Bilt CSV): the import
  screen takes previous/new balance off the statement and applies the same test.

## Known gaps / next work (priority order)
1. **Multiple accounts in one PDF.** Chase statement with a Checking *and* a
   Savings section; today the whole PDF is one account. Split into sections (each
   "CHECKING SUMMARY"/"SAVINGS SUMMARY" block + its account number), parse and reconcile
   each separately, map each to its own account in the import preview, and match the
   internal transfer. Still needed for backfill; lower urgency now that OFX/CSV land.
2. **Backup durability.** Browser storage is the real risk to the data, not privacy.
   IndexedDB works from `file://` in Chromium (the e2e proves it), but behaviour when the
   file moves, or in Safari/Firefox from disk, is unverified. Manual "Download backup" is
   the only defence today.
3. Year-boundary and multi-year statements; foreign-currency rows; pending vs posted.
4. Sharing later: export a person's monthly split summary (exists as copy-text); no server.
