# Tally

A private expense tracker that runs entirely in your browser. Import bank and credit card statements (PDF or CSV), auto-categorize, split transactions with people, and see a monthly summary plus each person's share.

- **No network.** The built page has a Content-Security-Policy with `connect-src 'none'`; pdf.js is inlined.
- **On-device parsing.** PDFs are read in memory and discarded; only extracted rows are stored (IndexedDB).
- **Optional encryption.** AES-256-GCM, key from PBKDF2-SHA256 (600k). Backups use the same format.

## Develop

```bash
npm install
npx playwright install chromium   # once, for the end-to-end test
npm run build                     # -> dist/Tally.html (single offline file)
npm test                          # parser assertions + browser end-to-end test
npm run test:parse -- -v          # same, but also print every parsed row
npm run fixtures                  # regenerate fake statements
```

Regenerating fixtures needs reportlab. `npm run fixtures` uses `.venv/bin/python`
when it exists, else `python3`:

```bash
python3 -m venv .venv && .venv/bin/pip install reportlab
```

Each fixture PDF is generated alongside a `<name>.expected.json` recording the rows
the generator actually drew. `test/parse_test.mjs` asserts the parser recovers them
exactly — count, dates, amounts, descriptions, metadata — and that reconciliation
passes with a zero difference. Fixture PDFs are generated deterministically, so
regenerating an unchanged fixture yields an identical file.

Open `dist/Tally.html` directly from disk in Chrome, Edge or Firefox.
