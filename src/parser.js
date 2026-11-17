/* Tally statement parser — runs entirely on-device. No network. */
(function (root) {
  'use strict';

  // ---------- 1. Rebuild text lines (with x positions) from pdf.js text content ----------
  async function linesFromPdf(pdf) {
    const pages = [];
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const tc = await page.getTextContent();
      pages.push(tc.items);
      page.cleanup();
    }
    return linesFromItems(pages);
  }

  function linesFromItems(pages) {
    const out = [];
    pages.forEach((items, pi) => {
      const pieces = [];
      for (const it of items) {
        if (!it.str || !it.str.trim()) continue;
        const x = it.transform[4], y = it.transform[5];
        const h = Math.abs(it.transform[3]) || it.height || 8;
        pieces.push({ str: it.str, x, y, w: it.width || it.str.length * h * 0.5, h });
      }
      pieces.sort((a, b) => b.y - a.y || a.x - b.x);
      const rows = [];
      for (const pc of pieces) {
        const r = rows.find(r => Math.abs(r.y - pc.y) <= Math.max(2, Math.min(r.h, pc.h) * 0.45));
        if (r) { r.items.push(pc); r.h = Math.max(r.h, pc.h); } else rows.push({ y: pc.y, h: pc.h, items: [pc] });
      }
      rows.sort((a, b) => b.y - a.y);
      for (const r of rows) {
        r.items.sort((a, b) => a.x - b.x);
        const tokens = [];
        for (const it of r.items) {
          const cw = it.w / Math.max(1, it.str.length);
          const re = /\S+/g; let m;
          while ((m = re.exec(it.str))) {
            const x0 = it.x + m.index * cw;
            tokens.push({ t: m[0], x0, x1: x0 + m[0].length * cw });
          }
        }
        // merge tokens that were split by the PDF without a visual gap (e.g. "1,2" + "34.00")
        const merged = [];
        for (const tk of tokens) {
          const prev = merged[merged.length - 1];
          if (prev && tk.x0 - prev.x1 < r.h * 0.12) { prev.t += tk.t; prev.x1 = tk.x1; }
          else merged.push({ ...tk });
        }
        out.push({ page: pi, y: r.y, h: r.h, tokens: merged, text: merged.map(t => t.t).join(' ') });
      }
    });
    return out;
  }

  // ---------- 2. Helpers ----------
  const DATE_RE = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?$/;
  const AMT_RE = /^[-−–]?\(?[-−]?\$?[-−]?(?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2}\)?(?:CR|DR)?$/i;
  const SECTION_RE = /^(purchases?|payments?( and other credits)?|(other )?credits|fees( charged)?|interest( charged)?|cash advances?|balance transfers?|account activity.*|transactions?( continued)?|deposits.*|withdrawals.*|checks paid.*|electronic withdrawals|atm.*debit.*|transaction detail)$/i;
  const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };

  function parseAmt(s) {
    let neg = /^[-−–]|\(|[-−]\$|\$[-−]/.test(s) || /CR$/i.test(s);
    const n = s.replace(/[^\d.]/g, '');
    const cents = Math.round(parseFloat(n) * 100);
    return { cents: neg ? -cents : cents, explicitNeg: /^[-−–]|\(|[-−]\$|\$[-−]/.test(s), cr: /CR$/i.test(s) };
  }
  function fullYear(y) { y = +y; return y < 100 ? 2000 + y : y; }
  function mkDate(y, m, d) { return new Date(Date.UTC(y, m - 1, d)); }
  function iso(dt) { return dt.toISOString().slice(0, 10); }
  function parseSlash(s) { const m = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/); return m ? mkDate(fullYear(m[3]), +m[1], +m[2]) : null; }
  function parseWords(s) {
    const m = s.match(/([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})/); if (!m) return null;
    const mo = MONTHS[m[1].toLowerCase().slice(0, 4)] || MONTHS[m[1].toLowerCase().slice(0, 3)];
    return mo ? mkDate(+m[3], mo, +m[2]) : null;
  }
  function moneyAfter(text, labelRe) {
    const m = text.match(new RegExp(labelRe.source + String.raw`[^\d$\-(]{0,30}([-−]?\(?\$?[-−]?(?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2}\)?)`, 'i'));
    return m ? parseAmt(m[1]).cents : null;
  }

  // ---------- 3. Statement metadata ----------
  function detectMeta(lines) {
    const all = lines.map(l => l.text).join('\n');
    const first = lines.filter(l => l.page === 0).map(l => l.text).join('\n');
    const head = first.slice(0, 4000);

    // issuer = whichever known bank name appears first in the document (statement header wins)
    const ISSUERS = [['Bilt', /\bbilt\b/i], ['Chase', /\bchase\b|jpmorgan/i], ['Wells Fargo', /wells\s*fargo/i], ['Amex', /american express|\bamex\b/i],
      ['Capital One', /capital\s*one/i], ['Citi', /\bciti\b|citibank/i], ['Discover', /\bdiscover\b/i], ['Bank of America', /bank of america/i]];
    let issuer = 'Other', firstIdx = Infinity;
    for (const [name, re] of ISSUERS) { const m = re.exec(all); if (m && m.index < firstIdx) { firstIdx = m.index; issuer = name; } }

    const bankScore = (/beginning balance/i.test(all) ? 2 : 0) + (/ending balance/i.test(all) ? 2 : 0) +
      (/checking|savings/i.test(head) ? 1 : 0) + (/deposits and additions|deposits\/credits/i.test(all) ? 1 : 0);
    const cardScore = (/new balance/i.test(all) ? 2 : 0) + (/minimum payment/i.test(all) ? 2 : 0) +
      (/payment due date/i.test(all) ? 1 : 0) + (/credit limit|mastercard|visa|card/i.test(head) ? 1 : 0);
    const kind = bankScore > cardScore ? 'bank' : 'card';

    let last4 = null;
    let m = head.match(/(?:ending|ends)\s+in\s*:?\s*(\d{4})\b/i);
    if (m) last4 = m[1];
    if (!last4) { m = head.match(/account\s*(?:number|no\.?|#)\s*:?\s*([X*•\-\s\d]{4,34})/i); if (m) { const d = m[1].replace(/\D/g, ''); if (d.length >= 4) last4 = d.slice(-4); } }

    let start = null, end = null;
    const range = head.match(/(\d{1,2}\/\d{1,2}\/\d{2,4})\s*(?:-|–|—|to|through|thru)\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i);
    if (range) { start = parseSlash(range[1]); end = parseSlash(range[2]); }
    if (!end) {
      const wr = head.match(/([A-Z][a-z]{2,8}\.? \d{1,2},? \d{4})\s*(?:-|–|—|to|through|thru)\s*([A-Z][a-z]{2,8}\.? \d{1,2},? \d{4})/);
      if (wr) { start = parseWords(wr[1]); end = parseWords(wr[2]); }
    }
    if (!end) {
      const pr = head.match(/([A-Z][a-z]{2,8})\.? (\d{1,2})\s*(?:-|–|—|to|through)\s*([A-Z][a-z]{2,8})\.? (\d{1,2}),? (\d{4})/);
      if (pr && MONTHS[pr[1].toLowerCase().slice(0, 3)] && MONTHS[pr[3].toLowerCase().slice(0, 3)]) {
        end = mkDate(+pr[5], MONTHS[pr[3].toLowerCase().slice(0, 3)], +pr[4]);
        const sm = MONTHS[pr[1].toLowerCase().slice(0, 3)];
        start = mkDate(sm > end.getUTCMonth() + 1 ? +pr[5] - 1 : +pr[5], sm, +pr[2]);
      }
    }
    if (!end) { const c = head.match(/closing\s*date\s*:?\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i); if (c) end = parseSlash(c[1]); }
    if (!end) { // fall back to latest full date anywhere in the document that isn't a due date
      let best = null; const re = /(\d{1,2}\/\d{1,2}\/\d{2,4})/g; let mm;
      while ((mm = re.exec(head))) { const pre = head.slice(Math.max(0, mm.index - 25), mm.index); if (/due/i.test(pre)) continue; const d = parseSlash(mm[1]); if (d && (!best || d > best)) best = d; }
      end = best;
    }

    const bal = kind === 'bank'
      ? { open: moneyAfter(all, /beginning\s+balance/), close: moneyAfter(all, /ending\s+balance/) }
      : { open: moneyAfter(all, /previous\s+balance/), close: moneyAfter(all, /new\s+balance/) };

    return { issuer, kind, last4, start: start && iso(start), end: end && iso(end), balances: bal };
  }

  // ---------- 4. Column headers ----------
  const COL_WORDS = [
    [/^(credits?|deposits?|additions|payments?)(\/.*)?$/i, 'in'],
    [/^(charges?|debits?|withdrawals?|purchases?)(\/.*)?$/i, 'out'],
    [/^amount$/i, 'amount'],
    [/^balance$/i, 'balance'],
  ];
  function headerCols(line) {
    if (line.tokens.some(t => AMT_RE.test(t.t))) return null;
    if (!/\b(date|description|transaction)\b/i.test(line.text)) return null;
    const cols = [];
    for (const tk of line.tokens) {
      for (const [re, type] of COL_WORDS) if (re.test(tk.t.replace(/[^A-Za-z/]/g, ''))) cols.push({ type, x0: tk.x0, x1: tk.x1 });
    }
    return cols.length ? cols : null;
  }
  function nearestCol(cols, tk) {
    let best = null, bd = Infinity;
    for (const c of cols) {
      const d = Math.min(Math.abs(tk.x1 - c.x1), Math.abs((tk.x0 + tk.x1) / 2 - (c.x0 + c.x1) / 2));
      if (d < bd) { bd = d; best = c; }
    }
    return bd < 90 ? best : null;
  }

  // "Jul 22, 2026" / "Jul 22" written as separate tokens -> one "7/22/2026" token
  function normalizeDates(tokens) {
    const out = [];
    for (let k = 0; k < tokens.length; k++) {
      const a = tokens[k], b = tokens[k + 1], c = tokens[k + 2];
      const mo = a && MONTHS[a.t.replace(/\.$/, '').toLowerCase()];
      if (mo && b && /^\d{1,2},?$/.test(b.t)) {
        const d = parseInt(b.t, 10);
        if (c && /^\d{4}$/.test(c.t)) { out.push({ t: `${mo}/${d}/${c.t}`, x0: a.x0, x1: c.x1 }); k += 2; continue; }
        out.push({ t: `${mo}/${d}`, x0: a.x0, x1: b.x1 }); k += 1; continue;
      }
      out.push(a);
    }
    return out;
  }

  // ---------- 5. Transactions ----------
  function parseStatement(lines, opts = {}) {
    const meta = detectMeta(lines);
    const endDate = meta.end ? new Date(meta.end + 'T00:00:00Z') : null;
    const txns = [];
    let cols = null, last = null;

    const resolveDate = (m) => {
      const mo = +m[1], d = +m[2];
      if (m[3]) return iso(mkDate(fullYear(m[3]), mo, d));
      let y = endDate ? endDate.getUTCFullYear() : (opts.year || new Date().getFullYear());
      let dt = mkDate(y, mo, d);
      if (endDate && dt - endDate > 10 * 864e5) dt = mkDate(y - 1, mo, d);
      return iso(dt);
    };

    for (const line of lines) {
      const hc = headerCols(line);
      if (hc) { cols = hc; last = null; continue; }
      const tk = normalizeDates(line.tokens);
      let i = 0;
      if (tk.length > 2 && /^\d{4}$/.test(tk[0].t) && DATE_RE.test(tk[1].t)) i = 1; // leading card last-4 column
      const dm = tk[i] && tk[i].t.match(DATE_RE);
      // trailing amount tokens
      let j = tk.length; const amts = [];
      while (j - 1 > i && (AMT_RE.test(tk[j - 1].t) || /^(CR|DR)$/i.test(tk[j - 1].t))) {
        if (/^(CR|DR)$/i.test(tk[j - 1].t)) { if (j - 2 > i && AMT_RE.test(tk[j - 2].t)) { tk[j - 2] = { ...tk[j - 2], t: tk[j - 2].t + tk[j - 1].t.toUpperCase() }; } j--; continue; }
        amts.unshift(tk[j - 1]); j--;
      }
      if (SECTION_RE.test(line.text)) { last = null; continue; }
      if (!dm || !amts.length) {
        // continuation detail line (e.g. foreign currency, wrapped reference)
        if (last && line.page === last.page && last.y - line.y < line.h * 2.2 && !dm && !amts.length &&
            line.tokens[0].x0 >= last.descX - 3 && line.text.length < 90 && !/balance|total|page|summary/i.test(line.text)) {
          last.txn.detail = (last.txn.detail ? last.txn.detail + ' · ' : '') + line.text;
          last.y = line.y;
        } else if (dm || amts.length || line.y < (last ? last.y - line.h * 2.2 : 0)) last = null;
        continue;
      }
      i++;
      if (tk[i] && DATE_RE.test(tk[i].t) && i < j) i++;            // post date
      if (tk[i] && /^[A-Z0-9]{12,}$/i.test(tk[i].t) && /\d{8}/.test(tk[i].t) && i < j) i++; // reference number
      const descTokens = tk.slice(i, j);
      if (!descTokens.length) continue;
      const desc = descTokens.map(t => t.t).join(' ');
      if (/^(total|subtotal|beginning balance|ending balance|new balance|previous balance)\b/i.test(desc)) continue;

      // choose the amount and sign
      let cents = null;
      if (cols) {
        let picked = null;
        for (const a of amts) {
          const c = nearestCol(cols, a); if (!c || c.type === 'balance') continue;
          const v = parseAmt(a.t);
          if (c.type === 'in') picked = -Math.abs(v.cents);
          else if (c.type === 'out') picked = Math.abs(v.cents);
          else picked = meta.kind === 'bank' ? -v.cents : v.cents;
          break;
        }
        cents = picked;
      }
      if (cents === null) {
        const a = (meta.kind === 'bank' && amts.length >= 2) ? amts[amts.length - 2] : amts[amts.length - 1];
        const v = parseAmt(a.t);
        cents = meta.kind === 'bank' ? -v.cents : v.cents;
      }
      if (!cents) continue;
      const txn = { date: resolveDate(dm), desc: desc.replace(/\s+/g, ' ').trim(), amt: cents };
      txns.push(txn);
      last = { txn, page: line.page, y: line.y, descX: descTokens[0].x0 };
    }

    // reconciliation: does the sum of parsed rows explain the statement balance change?
    let recon = null;
    const { open, close } = meta.balances;
    const periodTotals = lines.filter(l => /^total\b.*\bthis\s+(billing\s+)?(period|cycle)\b/i.test(l.text) && AMT_RE.test(l.tokens[l.tokens.length - 1].t))
      .map(l => parseAmt(l.tokens[l.tokens.length - 1].t).cents);
    if ((open == null || close == null) && meta.kind === 'card' && periodTotals.length >= 2) {
      const sum = txns.reduce((x, t) => x + t.amt, 0), expected = periodTotals.reduce((a, b) => a + b, 0);
      recon = { expected, parsed: sum, diff: sum - expected, ok: Math.abs(sum - expected) < 1, via: 'totals' };
    } else if (open != null && close != null) {
      const sum = txns.reduce((s, t) => s + t.amt, 0);
      const expected = meta.kind === 'bank' ? open - close : close - open;
      recon = { expected, parsed: sum, diff: sum - expected, ok: Math.abs(sum - expected) < 1 };
    }
    return { meta, txns, recon };
  }

  // ---------- 6. Merchant cleanup ----------
  const PREFIX_RE = /^(recurring card purchase|card purchase with pin|card purchase|purchase authorized on|pos (?:debit|purchase)|debit card purchase|checkcard)\s+(\d{1,2}\/\d{1,2}\s+)?/i;
  const PROC_RE = /^(sq|tst|py|sp|pp|dd|bps|ic|toast|paypal|pos|cke|par|lev|fs|pmnt)\s*\*\s*/i;
  const STOP_RE = /^(PPD|CCD|WEB|ID:?|TEL|ACH|POS|INST|XFER)$/i;
  const DOMAIN_RE = /\.(com|net|org|io|co)(?![a-z])|www\.|https?:/i;
  function merchantTokens(desc) {
    let s = desc.replace(PREFIX_RE, '').replace(PROC_RE, '');
    s = s.replace(/\bcard\s+\d{4}\b.*$/i, '').replace(/\*/g, ' ').replace(/#\s*\d+/g, ' ');
    let raw = s.split(/\s+/).filter(Boolean);
    if (raw[0] && DOMAIN_RE.test(raw[0])) return [raw[0].replace(/^https?:\/\//i, '').replace(/^www\./i, '').split(/[./]/)[0]];
    const cut = raw.findIndex((x, k) => k > 0 && /^\d+$/.test(x) && (x.length >= 3 || k >= 2)); // e.g. "CHIPOTLE 1492 3966 B BARRANCA" -> stop at the store/street number
    if (cut > 0) raw = raw.slice(0, cut);
    let t = raw.filter((x, k) => (k === 0 || (!/#/.test(x) && !(/[A-Za-z]/.test(x) && (x.match(/\d/g) || []).length >= 2))) && !/^\d{3,}$/.test(x) && !DOMAIN_RE.test(x) && !/^[^A-Za-z0-9&']+$/.test(x) && !STOP_RE.test(x));
    if (t.length > 1 && /^([A-Z]{2}|USA)$/.test(t[t.length - 1])) t = t.slice(0, -1); // trailing state / country code
    if (!t.length || (t.length === 1 && /^[A-Z]{2,3}$/.test(t[0]))) {
      const d = desc.split(/\s+/).find(x => DOMAIN_RE.test(x));
      if (d) t = [d.replace(/^https?:\/\//i, '').replace(/^www\./i, '').split(/[./]/)[0]];
    }
    const dedup = []; for (const x of t) if (!dedup.length || dedup[dedup.length - 1].toUpperCase() !== x.toUpperCase()) dedup.push(x);
    return dedup;
  }
  const P2P_RE = /^(ZELLE|VENMO|PAYPAL|ONLINE|TRANSFER|CASH)$/;
  function merchantKey(desc) {
    const t = merchantTokens(desc).map(x => x.toUpperCase().replace(/[^A-Z0-9&']/g, '')).filter(Boolean);
    if (P2P_RE.test(t[0] || '')) return t.slice(0, 5).join(' ');
    const out = []; let long = 0;
    for (const x of t) { out.push(x); if (x.length >= 3) long++; if (long >= 2 || out.length >= 4) break; }
    return out.join(' ') || desc.toUpperCase().slice(0, 20);
  }
  function merchantName(desc) {
    let t = merchantTokens(desc);
    const cap = P2P_RE.test((t[0] || '').toUpperCase()) ? 5 : 3;
    if (t.length > cap) t = t.slice(0, cap);
    const name = (t.join(' ') || desc).replace(/\b([A-Za-z]{2,}) S\b/g, "$1'S"); // TRADER JOE S -> Trader Joe's
    return name.toLowerCase().replace(/(^|[\s\-/&(])([a-z])/g, (m, a, b) => a + b.toUpperCase()).replace(/\bUsa\b/, 'USA');
  }

  // ---------- 7. Default category rules ----------
  const RULES = [
    ['transfers', /PAYMENT[\s-]*THANK|AUTOPAY|AUTO[\s-]PAY|AUTOMATIC PAYMENT|ONLINE PAYMENT|CREDIT CRD|CARD PAYMENT|\bEPAY\b|ONLINE TRANSFER|TRANSFER (TO|FROM)|^PAYMENT\b|PAYMENT RECEIVED|CARDLESS|BILT CARD|WEALTHFRONT|FID BKG|FIDELITY|VANGUARD|SCHWAB|ROBINHOOD|BROKERAGE|MONEYLINE/],  // incl. money moved to the user's own investment accounts, and the bank-side pull that funds a Bilt rent payment
    ['income', /PAYROLL|DIRECT DEP|DIR DEP|SALARY|INTEREST PAYMENT|IRS TREAS|TAX REF|\bDEPOSIT\b/],
    ['fees', /INTEREST CHARGE|LATE FEE|ANNUAL (MEMBERSHIP )?FEE|FOREIGN TRANSACTION FEE|SERVICE (CHARGE|FEE)|OVERDRAFT|ATM FEE|\bFEE\b/],
    ['rent', /\bRENT\b|BILT HOUSING|APARTMENT|PROPERTY M|\bHOA\b|MORTGAGE|LEASING/],
    ['utilities', /EDISON|SDG&E|SOCALGAS|SO CAL GAS|PG&E|\bWATER\b|ELECTRIC|COMCAST|XFINITY|SPECTRUM|COX COMM|AT&T|VERIZON|T-MOBILE|TMOBILE|GOOGLE FI|\bINTERNET\b/],
    ['travel', /AIRLINE|AIR LINES|AIRWAYS|\bDELTA\b|UNITED AIR|SOUTHWEST|ALASKA AIR|JETBLUE|AMERICAN AIR|\bHOTEL|MARRIOTT|HILTON|HYATT|AIRBNB|EXPEDIA|BOOKING\.COM|\bVRBO\b|HERTZ|ENTERPRISE RENT|\bAVIS\b|\bTSA\b/],
    ['dining', /DOORDASH|UBER\s*\*?\s*EATS|GRUBHUB|POSTMATES|STARBUCKS|COFFEE|\bCAFE|RESTAURANT|PIZZA|CHIPOTLE|SWEETGREEN|MCDONALD|TACO|SUSHI|GRILL|KITCHEN|BREWING|BAKERY|IN[\s-]N[\s-]OUT|BURGER|CHICK-FIL|PANERA|BOBA|TEA HOUSE|\bTST\s*\*|\bBAR\b|DINER|RAMEN|THAI|PHO\b/],
    ['groceries', /TRADER JOE|WHOLESOME CHOICE|WHOLEFDS|WHOLE FOODS|SAFEWAY|\bVONS\b|RALPHS|ALBERTSONS|SPROUTS|COSTCO|\bALDI\b|KROGER|PAVILIONS|H MART|99 RANCH|STATER BROS|INSTACART|GROCER|SMART & FINAL|GELSON/],
    ['transport', /UBER\s*\*?\s*TRIP|^UBER\b|\bLYFT\b|\bSHELL\b|CHEVRON|\bARCO\b|EXXON|MOBIL\b|\b76\b|CIRCLE K|PARKING|CITY OF .* (PARKING|METER)|\bTOLL|FASTRAK|METRO|CLIPPER|\bDMV\b|SUPERCHARGER|CHARGEPOINT|EVGO|GAS STATION/],
    ['subscriptions', /NETFLIX|SPOTIFY|\bHULU\b|DISNEY\s*PLUS|DISNEYPLUS|APPLE\.COM\/BILL|YOUTUBE|AMAZON PRIME|PRIME VIDEO|\bHBO|MAX\.COM|PARAMOUNT|PEACOCK|ICLOUD|DROPBOX|OPENAI|CHATGPT|ANTHROPIC|CLAUDE\.AI|CLOUDFLARE|GITHUB|VERCEL|\bAWS\b|GOOGLE \*?CLOUD|NYTIMES|PATREON|\bGYM\b|EQUINOX|PLANET FIT|SUBSCRIPTION/],
    ['entertainment', /\bDLR\b|TICKETMASTER|\bAMC\b|CINEMA|THEAT(RE|ER)|\bSTEAM\b|PLAYSTATION|XBOX|NINTENDO|DISNEYLAND|LIVE NATION|STUBHUB|BOWL|CONCERT|MUSEUM/],
    ['health', /\bCVS\b|WALGREENS|RITE AID|PHARMACY|KAISER|MEDICAL|DENTAL|DOCTOR|CLINIC|HOSPITAL|LABCORP|QUEST DIAG|OPTOMET|URGENT CARE/],
    ['personal', /SALON|BARBER|\bSPA\b|SEPHORA|\bULTA\b|NAIL/],
    ['shopping', /AMAZON|\bAMZN|TARGET|WALMART|WM SUPERCENTER|FEDEX OFFICE|BEST BUY|IKEA|HOME DEPOT|LOWE'?S|\bETSY\b|\bEBAY\b|NORDSTROM|UNIQLO|\bZARA\b|\bNIKE\b|APPLE STORE|MACY|TJ ?MAXX|MARSHALLS|ROSS STORES/],
  ];
  function guessCategory(desc) {
    const u = desc.toUpperCase();
    for (const [cat, re] of RULES) if (re.test(u)) return cat;
    return null;
  }

  // ---------- 8. CSV exports (Chase "Download account activity", most banks) ----------
  function csvRows(text) {
    const rows = []; let row = [], cell = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
      else if (c === '"') q = true;
      else if (c === ',') { row.push(cell); cell = ''; }
      else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
      else cell += c;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    return rows.filter(r => r.some(c => c.trim()));
  }
  function csvDate(s) {
    let m = String(s).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
    if (m) return mkDate(fullYear(m[3]), +m[1], +m[2]);
    if ((m = String(s).trim().match(/^(\d{4})-(\d{2})-(\d{2})/))) return mkDate(+m[1], +m[2], +m[3]);
    return null;
  }
  // Direction of a row, decided from evidence in the file rather than guessed.
  // The old rule ("if most amounts are negative, flip them all") inverts an entire
  // import on a month with few charges and one large refund, so it is a last resort.
  function parseCSV(text, fileName = '') {
    const rows = csvRows(text);
    const hi = rows.findIndex(r => r.some(c => /date/i.test(c)) && r.some(c => /amount|debit|credit/i.test(c)));
    if (hi < 0) throw new Error('Could not find a header row with Date and Amount columns.');
    const h = rows[hi].map(c => c.trim().toLowerCase());
    const find = (...res) => { for (const re of res) { const i = h.findIndex(c => re.test(c)); if (i >= 0) return i; } return -1; };
    const di = find(/^transaction date$/, /^(trans\.? )?date$/, /posting date/, /date/);
    const desci = find(/^description$/, /description|merchant|payee|name|details?$/);
    const ai = find(/^amount$/, /amount/);
    const debit = find(/^debit/, /withdrawal/), credit = find(/^credit/, /deposit/);
    const memo = find(/^memo$/), bali = find(/^balance$/, /balance/);
    const c4i = find(/card last ?4/, /last ?4/), rawi = find(/raw merchant/);
    // rows may carry a trailing empty field (Chase appends a comma to every data row)
    const data = rows.slice(hi + 1).filter(r => r.some(c => c.trim()));

    // a column of nothing but DEBIT / CREDIT labels is authoritative about direction
    let diri = -1;
    for (const i of [find(/^details$/), find(/^type$/), find(/^transaction type$/)]) {
      if (i < 0) continue;
      const vals = data.map(r => (r[i] || '').trim()).filter(Boolean);
      if (vals.length && vals.every(v => /^(debit|credit)$/i.test(v))) { diri = i; break; }
    }

    const out = [];
    for (const r of data) {
      const dt = csvDate(r[di] || '');
      if (!dt) continue;
      let native;
      if (ai >= 0 && (r[ai] || '').trim()) native = parseAmt(r[ai].trim()).cents;
      else if (debit >= 0 || credit >= 0) {
        const d = debit >= 0 && r[debit] ? Math.abs(parseAmt(r[debit].trim()).cents) : 0;
        const c = credit >= 0 && r[credit] ? Math.abs(parseAmt(r[credit].trim()).cents) : 0;
        native = c - d;                               // statement-style: credits positive
      } else continue;
      if (!native || isNaN(native)) continue;
      const bal = bali >= 0 && (r[bali] || '').trim() ? parseAmt(r[bali].trim()).cents : null;
      out.push({
        date: iso(dt), desc: (r[desci] || '').replace(/\s+/g, ' ').trim(), native, bal,
        dir: diri >= 0 ? (r[diri] || '').trim().toLowerCase() : null,
        card4: c4i >= 0 && (r[c4i] || '').trim() ? (r[c4i] || '').trim() : null,
        raw: rawi >= 0 && (r[rawi] || '').trim() ? (r[rawi] || '').trim() : null,
        detail: memo >= 0 && r[memo] ? r[memo].trim() : undefined,
      });
    }
    if (!out.length) return { meta: { issuer: 'Other', kind: 'card', last4: null, start: null, end: null, balances: {} }, txns: [], recon: null };

    // put rows in chronological order (Chase exports newest first)
    if (out.length > 1 && out[0].date > out[out.length - 1].date) out.reverse();

    const isBank = bali >= 0 || /checking|savings/i.test(fileName);
    let signSource, outSign = null;
    if (diri >= 0) signSource = 'DEBIT/CREDIT column';
    else if (ai < 0 && (debit >= 0 || credit >= 0)) { outSign = -1; signSource = 'separate debit and credit columns'; }
    else {
      if (bali >= 0) {                                 // let the running balance say which way is out
        let same = 0, flip = 0;
        for (let i = 1; i < out.length; i++) {
          const a = out[i - 1], b = out[i];
          if (a.bal == null || b.bal == null) continue;
          const d = b.bal - a.bal;
          if (d === b.native) same++; else if (d === -b.native) flip++;
        }
        if (same || flip) { outSign = same >= flip ? -1 : 1; signSource = 'running balance column'; }
      }
      if (outSign == null) { outSign = isBank ? -1 : 1; signSource = isBank ? 'bank default (negative = money out)' : 'card default (positive = charge)'; }
    }
    for (const r of out) r.amt = r.dir ? (r.dir === 'debit' ? Math.abs(r.native) : -Math.abs(r.native)) : outSign * r.native;

    // reconciliation: in a deposit account every row must move the balance by exactly
    // -amt. Checking each adjacent pair says *which* row is wrong, not just the total.
    let recon = null, balances = {};
    if (bali >= 0) {
      const withBal = out.filter(r => r.bal != null);
      if (withBal.length >= 2) {
        let bad = [], checked = 0;
        for (let i = 1; i < out.length; i++) {
          const a = out[i - 1], b = out[i];
          if (a.bal == null || b.bal == null) continue;
          checked++;
          if ((b.bal - a.bal) !== -b.amt) bad.push(i);
        }
        const first = withBal[0], last = withBal[withBal.length - 1];
        const open = first.bal + first.amt, close = last.bal;
        balances = { open, close };
        const sum = out.reduce((s, r) => s + r.amt, 0);
        const expected = open - close;
        recon = { expected, parsed: sum, diff: sum - expected, ok: Math.abs(sum - expected) < 1 && !bad.length, via: 'running-balance', checked, bad };
      }
    }

    const lm = fileName.match(/(\d{4})(?!\d)/);        // e.g. "Chase4417_Activity20260105.CSV"
    const cards = out.map(r => r.card4).filter(Boolean);
    const last4 = cards.length ? tally1(cards) : (lm ? lm[1] : null);
    const issuer = /bilt/i.test(fileName) ? 'Bilt' : /chase/i.test(fileName) ? 'Chase' : 'Other';
    const txns = out.map(r => { const t = { date: r.date, desc: r.desc, amt: r.amt }; if (r.detail) t.detail = r.detail; if (r.raw) t.raw = r.raw; return t; });
    return {
      meta: { issuer, kind: isBank ? 'bank' : 'card', last4, start: out[0].date, end: out[out.length - 1].date, balances, signSource },
      txns, recon,
    };
  }
  function tally1(arr) { const m = {}; let best = null; for (const x of arr) { m[x] = (m[x] || 0) + 1; if (!best || m[x] > m[best]) best = x; } return best; }

  // ---------- 9. OFX / QFX / QBO ----------
  // OFX 1.x is SGML, not XML: leaf tags are left unclosed (`<TRNAMT>-12.34` with no
  // `</TRNAMT>`), so an XML parser cannot read it. Container tags *are* closed in both
  // 1.x and 2.x, so blocks are extracted by their closing tags and leaves are read as
  // "everything up to the next < or line break", which works for either flavour.
  function ofxLeaf(block, tag) {
    const m = block.match(new RegExp('<' + tag + '>([^<\\r\\n]*)', 'i'));
    return m ? m[1].trim() : null;
  }
  function ofxBlocks(text, tag) {
    const out = [], re = new RegExp('<' + tag + '>([\\s\\S]*?)</' + tag + '>', 'gi');
    let m; while ((m = re.exec(text))) out.push(m[1]);
    return out;
  }
  function ofxDate(s) {                                  // 20260822120000[-5:EST] -> 2026-08-22
    const m = String(s || '').match(/^\s*(\d{4})(\d{2})(\d{2})/);
    return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
  }
  function ofxAmt(s) {
    if (s == null || s === '') return null;
    const v = parseFloat(String(s).replace(/,/g, ''));
    return isNaN(v) ? null : Math.round(v * 100);
  }
  function parseOFX(text, fileName = '') {
    if (!/<OFX>/i.test(text)) throw new Error('This file is not an OFX/QFX export (no <OFX> section found).');
    const issuer = /bilt/i.test(fileName) ? 'Bilt' : /chase/i.test(fileName) ? 'Chase' : /<ORG>CHASE/i.test(text) ? 'Chase' : 'Other';
    const stmts = [];
    for (const [tag, kind] of [['STMTRS', 'bank'], ['CCSTMTRS', 'card']]) {
      for (const block of ofxBlocks(text, tag)) {
        const acctId = ofxLeaf(block, 'ACCTID');
        const acctType = ofxLeaf(block, 'ACCTTYPE');
        const txns = [];
        for (const tr of ofxBlocks(block, 'STMTTRN')) {
          const date = ofxDate(ofxLeaf(tr, 'DTPOSTED'));
          const native = ofxAmt(ofxLeaf(tr, 'TRNAMT'));
          if (!date || native == null || native === 0) continue;
          const name = (ofxLeaf(tr, 'NAME') || '').trim(), memo = (ofxLeaf(tr, 'MEMO') || '').trim();
          const t = {
            date, amt: -native,                          // OFX: negative = money out. Tally: positive = money out.
            desc: name.replace(/\s+/g, ' ').trim(),      // MEMO goes to `detail`, not the merchant name
            fitid: ofxLeaf(tr, 'FITID') || null,
            trntype: (ofxLeaf(tr, 'TRNTYPE') || '').toUpperCase() || null,
          };
          if (memo && memo !== name) t.detail = memo;
          txns.push(t);
        }
        txns.sort((a, b) => a.date.localeCompare(b.date));
        const isCard = tag === 'CCSTMTRS' || /credit ?line|creditcard/i.test(acctType || '');
        const ledger = ofxBlocks(block, 'LEDGERBAL')[0];
        let close = ledger ? ofxAmt(ofxLeaf(ledger, 'BALAMT')) : null;
        // OFX reports a card balance from the account's side (negative = you owe). Tally
        // keeps card balances the way a statement prints them: what you owe, as positive.
        if (close != null && isCard) close = -close;
        const sum = txns.reduce((s, t) => s + t.amt, 0);
        // OFX states only a closing balance. Deriving the opening one from these same
        // rows would make reconciliation pass by construction, so it stays unverified
        // until a prior period gives us an independent opening balance.
        const recon = close == null ? null
          : { expected: null, parsed: sum, diff: null, ok: null, closing: close, via: 'ledger-balance' };
        stmts.push({
          meta: {
            issuer, kind: isCard ? 'card' : kind,
            last4: acctId ? String(acctId).replace(/\D/g, '').slice(-4) || null : null,
            start: ofxDate(ofxLeaf(block, 'DTSTART')) || (txns[0] || {}).date || null,
            end: ofxDate(ofxLeaf(block, 'DTEND')) || (txns[txns.length - 1] || {}).date || null,
            balances: { open: null, close }, acctType: acctType || null,
          },
          txns, recon,
        });
      }
    }
    if (!stmts.length) throw new Error('No account statements found in this OFX/QFX file.');
    return stmts;
  }

  const api = { parseCSV, parseOFX, linesFromPdf, linesFromItems, parseStatement, detectMeta, merchantKey, merchantName, guessCategory, parseAmt };
  root.TallyParser = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
