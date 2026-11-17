# Generates FAKE machine-readable exports (CSV / QFX) mirroring the real shapes
# Tally has to handle, plus a <name>.expected.json ground truth for each.
#
# Shapes are copied from structure-only inspection of real files (no real data here):
#   Chase checking CSV : Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #
#                        MM/DD/YYYY, negative = money out, rows NEWEST FIRST,
#                        and a trailing comma on every data row (8 fields vs 7 headers).
#   Bilt card CSV      : Transaction Date,Posted Date,Description,Amount,Card Last 4,
#                        Name on Card,Raw Merchant Name — ISO dates, positive = charge, CRLF.
#   Chase savings QFX  : OFX 1.x SGML, VERSION 102, leaf tags left UNCLOSED,
#                        DTPOSTED YYYYMMDDHHMMSS[-5:EST], TRNAMT negative = debit.
import sys, os, json

OUT = sys.argv[1] if len(sys.argv) > 1 else "test/fixtures"

def write_expected(name, meta, txns):
    """txns: [(iso_date, desc, amt_cents)] in Tally's convention (amt > 0 = money out)."""
    exp = {"file": name, "meta": meta, "count": len(txns),
           "sum": sum(t[2] for t in txns),
           "txns": [{"date": d, "desc": s, "amt": a} for d, s, a in txns]}
    with open(os.path.join(OUT, os.path.splitext(name)[0] + ".expected.json"), "w") as f:
        json.dump(exp, f, indent=1); f.write("\n")

def d2(c):
    return f"{c/100:.2f}"

# ---------------- Chase checking CSV ----------------
def chase_checking_csv():
    name = "chase_checking_export.csv"
    open_bal = 341208
    # (iso, details, description, native_cents (neg = money out), type)
    tx = [
        ("2026-08-05", "DEBIT",  "ACH Debit TRADER JOE S #127 IRVINE CA",            -4218,  "ACH_DEBIT"),
        ("2026-08-14", "CREDIT", "PAYROLL ACME CORP PPD ID: 1234567890",            212500,  "ACH_CREDIT"),
        ("2026-08-22", "DEBIT",  "Online Transfer To Sav ...1234",                  -20000,  "ACCT_XFER"),
        ("2026-09-03", "DEBIT",  "CHASE CREDIT CRD AUTOPAY PPD ID: 4760039224",     -61240,  "ACH_DEBIT"),
        ("2026-09-15", "CREDIT", "PAYROLL ACME CORP PPD ID: 1234567890",            212500,  "ACH_CREDIT"),
        ("2026-09-28", "DEBIT",  "Zelle Payment To Sam Rivera Jpm99B7Xq2C1",          -7500,  "QUICKPAY_DEBIT"),
        ("2026-10-02", "DEBIT",  "COSTCO WHSE #0479 LAGUNA NIGUEL CA",              -18744,  "DEBIT_CARD"),
        ("2026-10-09", "DEBIT",  "Recurring Card Purchase SPOTIFY USA 877-778-1161", -1199,  "DEBIT_CARD"),
    ]
    bal, running = open_bal, []
    for _, _, _, amt, _ in tx:
        bal += amt
        running.append(bal)
    close_bal = bal

    lines = ["Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #"]
    # Chase exports newest first; the parser must not assume ascending order
    for (iso, det, desc, amt, typ), run in reversed(list(zip(tx, running))):
        y, m, d = iso.split("-")
        lines.append(f'{det},{m}/{d}/{y},"{desc}",{d2(amt)},{typ},{d2(run)},,')  # note trailing comma
    with open(os.path.join(OUT, name), "w") as f:
        f.write("\n".join(lines) + "\n")

    write_expected(name,
        {"issuer": "Chase", "kind": "bank", "last4": None,
         "start": "2026-08-05", "end": "2026-10-09",
         "balances": {"open": open_bal, "close": close_bal}},
        # Tally convention flips Chase's sign: money out becomes positive
        [(iso, desc, -amt) for iso, _, desc, amt, _ in tx])

# ---------------- Bilt card CSV ----------------
def bilt_card_csv():
    name = "bilt_card_export.csv"
    # (trans_iso, posted_iso, description, cents (positive = charge), card4, name, raw)
    tx = [
        ("2026-07-28", "2026-07-29", "BPS*BILT HOUSING 1 Main St New York", 200000, "7782", "ALEX EXAMPLE", "BILT HOUSING"),
        ("2026-08-03", "2026-08-04", "RALPHS #0080 17605 HARVARD AVE IRVINE",  688, "7782", "ALEX EXAMPLE", "RALPHS"),
        ("2026-08-07", "2026-08-08", "TST*SHAKE SHACK CRYSTA7703 East Coast", 9712, "7782", "ALEX EXAMPLE", "SHAKE SHACK"),
        ("2026-08-15", "2026-08-15", "PAYMENT - THANK YOU",                -210400,     "",             "",            ""),
        ("2026-09-02", "2026-09-03", "TRADER JOE S #113 3329 S BRISTOL ST",  2218, "7782", "ALEX EXAMPLE", "TRADER JOES"),
        ("2026-09-11", "2026-09-12", "CLOUDFLARE 101 Townsend Street SAN",   3446, "4461", "JAMIE EXAMPLE", "CLOUDFLARE"),
        ("2026-09-20", "2026-09-21", "Refund: RALPHS #0080",                 -688, "7782", "ALEX EXAMPLE", "RALPHS"),
        ("2026-10-01", "2026-10-02", "BPS*BILT HOUSING 1 Main St New York", 200000, "7782", "ALEX EXAMPLE", "BILT HOUSING"),
    ]
    lines = ["Transaction Date,Posted Date,Description,Amount,Card Last 4,Name on Card,Raw Merchant Name"]
    for td, pd, desc, amt, c4, nm, raw in tx:
        lines.append(f'{td},{pd},"{desc}",{d2(amt)},{c4},{nm},{raw}')
    with open(os.path.join(OUT, name), "w", newline="") as f:
        f.write("\r\n".join(lines) + "\r\n")   # Bilt exports CRLF

    write_expected(name,
        {"issuer": "Bilt", "kind": "card", "last4": "7782",
         "start": "2026-07-28", "end": "2026-10-01", "balances": {"open": None, "close": None}},
        [(td, desc, amt) for td, _, desc, amt, _, _, _ in tx])   # already Tally's convention

# ---------------- Chase savings QFX (OFX 1.x SGML) ----------------
SAVINGS_TX = [
    # (iso, TRNTYPE, native_cents (neg = debit = money out), NAME, MEMO)
    ("2026-08-22", "CREDIT",  20000, "Online Transfer From Chk ...3017", "ACCT_XFER"),
    ("2026-08-31", "CREDIT",    124, "Interest Payment",                 ""),
    ("2026-09-15", "DEBIT",  -50000, "Online Transfer To Chk ...3017",   "ACCT_XFER"),
    ("2026-09-30", "CREDIT",    131, "Interest Payment",                 ""),
    ("2026-10-15", "CREDIT",  30000, "Online Transfer From Chk ...3017", "ACCT_XFER"),
    ("2026-10-31", "CREDIT",     98, "Interest Payment",                 ""),
    # --- only in the follow-up download ---
    ("2026-11-12", "DEBIT",  -10000, "Online Transfer To Chk ...3017",   "ACCT_XFER"),
    ("2026-11-20", "CREDIT",  25000, "Online Transfer From Chk ...3017", "ACCT_XFER"),
    ("2026-11-30", "CREDIT",    117, "Interest Payment",                 ""),
]

def chase_savings_qfx(name="chase_savings.qfx", lo=0, hi=6, start="2026-08-01", end="2026-10-31"):
    """Rows lo..hi of SAVINGS_TX. The follow-up file overlaps the first one by two rows,
    the way a real re-download does, so FITID dedup and balance carry-over get exercised."""
    open_bal = 150000 + sum(t[2] for t in SAVINGS_TX[:lo])
    tx = SAVINGS_TX[lo:hi]
    close_bal = open_bal + sum(t[2] for t in tx)
    stamp = lambda iso: iso.replace("-", "") + "120000[-5:EST]"

    L = []
    for k, v in [("OFXHEADER","100"),("DATA","OFXSGML"),("VERSION","102"),("SECURITY","NONE"),
                 ("ENCODING","USASCII"),("CHARSET","1252"),("COMPRESSION","NONE"),
                 ("OLDFILEUID","NONE"),("NEWFILEUID","NONE")]:
        L.append(f"{k}:{v}")
    L.append("")
    L.append("<OFX>")
    L.append("<SIGNONMSGSRSV1><SONRS><STATUS><CODE>0<SEVERITY>INFO</STATUS>")
    L.append(f"<DTSERVER>{stamp('2026-11-01')}<LANGUAGE>ENG<FI><ORG>B1<FID>10898</FI></SONRS></SIGNONMSGSRSV1>")
    L.append("<BANKMSGSRSV1><STMTTRNRS><TRNUID>0<STATUS><CODE>0<SEVERITY>INFO</STATUS>")
    L.append("<STMTRS><CURDEF>USD<BANKACCTFROM><BANKID>102000076<ACCTID>000000541234<ACCTTYPE>SAVINGS</BANKACCTFROM>")
    L.append(f"<BANKTRANLIST><DTSTART>{stamp(start)}<DTEND>{stamp(end)}")
    for i, (iso, typ, amt, nm, memo) in enumerate(tx):
        L.append("<STMTTRN>")
        L.append(f"<TRNTYPE>{typ}")
        L.append(f"<DTPOSTED>{stamp(iso)}")
        L.append(f"<TRNAMT>{d2(amt)}")
        L.append(f"<FITID>{400000001 + lo + i}")
        L.append(f"<NAME>{nm}")
        if memo: L.append(f"<MEMO>{memo}")
        L.append("</STMTTRN>")
    L.append("</BANKTRANLIST>")
    L.append(f"<LEDGERBAL><BALAMT>{d2(close_bal)}<DTASOF>{stamp(end)}</LEDGERBAL>")
    L.append(f"<AVAILBAL><BALAMT>{d2(close_bal)}<DTASOF>{stamp(end)}</AVAILBAL>")
    L.append("</STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>")
    with open(os.path.join(OUT, name), "w") as f:
        f.write("\n".join(L) + "\n")

    # OFX carries only a closing balance, so `open` is genuinely unknowable from one
    # file. The parser must report it as null rather than back-deriving it from the
    # rows, which would make reconciliation pass by construction.
    write_expected(name,
        {"issuer": "Chase", "kind": "bank", "last4": "1234",
         "start": start, "end": end,
         "balances": {"open": None, "close": close_bal}},
        # OFX TRNAMT is negative for money out; Tally is the opposite
        [(iso, nm, -amt) for iso, _, amt, nm, _ in tx])

chase_checking_csv()
bilt_card_csv()
chase_savings_qfx()
chase_savings_qfx("chase_savings_next.qfx", lo=4, hi=9, start="2026-10-10", end="2026-11-30")
print("ok")
