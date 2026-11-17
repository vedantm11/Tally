# Generates FAKE statements that mimic the layout of Chase / Bilt PDFs.
# Each PDF is written alongside a <name>.expected.json holding the ground truth
# (the rows this generator actually drew), so test/parse_test.mjs can assert the
# parser recovers them exactly instead of just re-blessing its own output.
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import letter
import sys, os, json
OUT = sys.argv[1]
W, H = letter

def money(c):
    s = f"{abs(c)/100:,.2f}"
    return ("-" if c < 0 else "") + s

def iso_md(md, dec_year, jan_year):
    """'12/07' -> '2025-12-07', picking the year from the month."""
    m, d = md.split("/")[:2]
    return f"{dec_year if m == '12' else jan_year}-{int(m):02d}-{int(d):02d}"

def iso_full(s):
    """'01/05/2026' -> '2026-01-05'."""
    m, d, y = s.split("/")
    return f"{y}-{int(m):02d}-{int(d):02d}"

def write_expected(pdf_name, meta, txns):
    """txns: [(iso_date, desc, amt_cents)] in Tally's convention (amt > 0 = money out)."""
    exp = {"file": pdf_name, "meta": meta, "count": len(txns),
           "sum": sum(t[2] for t in txns),
           "txns": [{"date": d, "desc": s, "amt": a} for d, s, a in txns]}
    with open(os.path.join(OUT, pdf_name[:-4] + ".expected.json"), "w") as f:
        json.dump(exp, f, indent=1)
        f.write("\n")

class Doc:
    def __init__(self, name):
        # invariant=1: no timestamp in the output, so regenerating an unchanged
        # fixture produces an identical file and git diffs stay meaningful.
        self.c = canvas.Canvas(os.path.join(OUT, name), pagesize=letter, invariant=1)
        self.y = H - 50
    def t(self, x, s, size=9, font="Helvetica", right=False, y=None):
        self.c.setFont(font, size)
        yy = self.y if y is None else y
        (self.c.drawRightString if right else self.c.drawString)(x, yy, s)
    def nl(self, d=12):
        self.y -= d
        if self.y < 60: self.page()
    def page(self):
        self.c.setFont("Helvetica", 7)
        self.c.drawString(40, 30, "Page footer - Member FDIC - This is a sample statement")
        self.c.showPage(); self.y = H - 50
    def save(self): self.c.save()

# ---------------- Chase credit card ----------------
def chase_card():
    d = Doc("chase_sapphire_2026-01.pdf")
    d.t(40, "CHASE", 16, "Helvetica-Bold"); d.t(400, "Sapphire Preferred", 10); d.nl(22)
    d.t(40, "Manage your account online: www.chase.com/cardhelp"); d.nl(18)
    d.t(40, "ACCOUNT SUMMARY", 10, "Helvetica-Bold"); d.nl()
    d.t(40, "Account Number: XXXX XXXX XXXX 4417"); d.nl()
    pays = [("12/18","Payment Thank You-Mobile",-120355)]
    credits = [("12/22","AMAZON MKTPL*ZX4RT1 Amzn.com/bill WA",-2499)]
    purchases = [
        ("12/07","TRADER JOE S #127 IRVINE CA",6412,None),
        ("12/09","SQ *BLUE BOTTLE COFFEE Los Angeles CA",875,None),
        ("12/11","NETFLIX.COM NETFLIX.COM CA",1549,None),
        ("12/14","SHELL OIL 57444212 RANCHO SANTA MA CA",5288,None),
        ("12/14","SHELL OIL 57444212 RANCHO SANTA MA CA",5288,None),
        ("12/20","DOORDASH*SUSHI ROKU SAN FRANCISCO CA",4630,None),
        ("12/28","UBER *TRIP HELP.UBER.COM NLD",1873,["EURO","17.25 X 1.08579710 (EXCHG RATE)"]),
        ("12/30","AMAZON MKTPL*BB71Q0 Amzn.com/bill WA",8999,None),
        ("01/02","WHOLEFDS LAG 10234 LAGUNA NIGUEL CA",11237,None),
        ("01/03","SOUTHERN CALIFORNIA EDISON 800-655-4555 CA",9811,None),
        ("01/04","IN N OUT BURGER 211 MISSION VIEJO CA",2164,None),
    ]
    prev = 120355
    newb = prev + sum(a for *_ ,a in pays) + sum(a for *_,a in credits) + sum(p[2] for p in purchases)
    rows = [("Previous Balance", money(prev)), ("Payment, Credits", "-$"+money(-(pays[0][2]+credits[0][2]))),
            ("Purchases", "+$"+money(sum(p[2] for p in purchases))), ("Cash Advances","$0.00"),
            ("Balance Transfers","$0.00"), ("Fees Charged","$0.00"), ("Interest Charged","$0.00"),
            ("New Balance", "$"+money(newb))]
    for k,v in rows:
        d.t(40,k); d.t(260,v,right=True); d.nl()
    d.t(40,"Opening/Closing Date 12/06/25 - 01/05/26"); d.nl()
    d.t(40,"Payment Due Date: 02/01/26"); d.nl()
    d.t(40,"Minimum Payment Due: $40.00"); d.nl(20)
    d.t(40,"Your next AutoPay payment for $"+money(newb)+" will be deducted from your Pay From account on 02/01/26"); d.nl(24)
    d.t(40,"ACCOUNT ACTIVITY",10,"Helvetica-Bold"); d.nl(14)
    d.t(40,"Date of"); d.nl(9)
    d.t(40,"Transaction"); d.t(110,"Merchant Name or Transaction Description"); d.t(560,"$ Amount",right=True); d.nl(14)
    d.t(110,"PAYMENTS AND OTHER CREDITS",9,"Helvetica-Bold"); d.nl()
    for dt,desc,a in pays+credits:
        d.t(40,dt); d.t(110,desc); d.t(560,money(a),right=True); d.nl()
    d.t(110,"PURCHASE",9,"Helvetica-Bold"); d.nl()
    for i,(dt,desc,a,extra) in enumerate(purchases):
        if i == 7: d.page(); d.t(40,"ACCOUNT ACTIVITY (CONTINUED)",10,"Helvetica-Bold"); d.nl(14); d.t(40,"Date of Transaction"); d.t(110,"Merchant Name or Transaction Description"); d.t(560,"$ Amount",right=True); d.nl(14)
        d.t(40,dt); d.t(110,desc); d.t(560,money(a),right=True); d.nl()
        for e in (extra or []):
            d.t(110,e); d.nl()
    d.nl(10)
    d.t(40,"2026 Totals Year-to-Date",9,"Helvetica-Bold"); d.nl()
    d.t(40,"Total fees charged in 2026"); d.t(300,"$0.00",right=True); d.nl()
    d.t(40,"Total interest charged in 2026"); d.t(300,"$0.00",right=True); d.nl(16)
    d.t(40,"INTEREST CHARGES",9,"Helvetica-Bold"); d.nl()
    d.t(40,"Purchases 21.49%(v)(d) - 0 - $0.00 $0.00"); d.nl()
    d.page(); d.save()
    write_expected("chase_sapphire_2026-01.pdf",
        {"issuer":"Chase","kind":"card","last4":"4417","start":"2025-12-06","end":"2026-01-05",
         "balances":{"open":prev,"close":newb}},
        [(iso_md(dt,2025,2026), desc, a) for dt,desc,a in pays+credits] +
        [(iso_md(dt,2025,2026), desc, a) for dt,desc,a,_ in purchases])
    return newb

# ---------------- Chase checking ----------------
def chase_checking(card_payment, bilt_payment):
    d = Doc("chase_checking_2026-01.pdf")
    d.t(40,"CHASE",16,"Helvetica-Bold"); d.nl(20)
    d.t(40,"December 06, 2025 through January 05, 2026"); d.nl()
    d.t(40,"Account Number: 000000548293017"); d.nl(20)
    begin = 341208
    tx = [
        ("12/08","Card Purchase 12/07 Trader Joe S #127 Irvine CA Card 9921",-3120,None),
        ("12/15","Payroll Acme Corp PPD ID: 1234567890",212500,None),
        ("12/18","Chase Credit Crd Autopay PPD ID: 4760039224",-card_payment,None),
        ("12/20","Zelle Payment To Sam Rivera Jpm99B7Xq2C1",-95000,None),
        ("12/22","Online Transfer To Sav ...1234 Transaction#: 18822734",-20000,["12/21"]),
        ("12/27","Bilt Card Payment Web ID: 9876543210",-bilt_payment,None),
        ("12/31","Payroll Acme Corp PPD ID: 1234567890",212500,None),
        ("01/02","Card Purchase With Pin 01/02 Costco Whse #0479 Laguna Niguel CA Card 9921",-18744,None),
        ("01/04","Recurring Card Purchase 01/03 Spotify USA 877-778-1161 NY Card 9921",-1199,None),
    ]
    end = begin + sum(a for _,_,a,_ in tx)
    d.t(40,"CHECKING SUMMARY",10,"Helvetica-Bold"); d.nl()
    for k,v in [("Beginning Balance","$"+money(begin)),("Deposits and Additions",money(sum(a for *_,a,_ in tx if a>0))),
                ("Electronic Withdrawals",money(sum(a for *_,a,_ in tx if a<0))),("Ending Balance","$"+money(end))]:
        d.t(40,k); d.t(300,v,right=True); d.nl()
    d.nl(14)
    d.t(40,"TRANSACTION DETAIL",10,"Helvetica-Bold"); d.nl(14)
    d.t(40,"DATE"); d.t(90,"DESCRIPTION"); d.t(470,"AMOUNT",right=True); d.t(560,"BALANCE",right=True); d.nl(14)
    d.t(90,"Beginning Balance"); d.t(560,"$"+money(begin),right=True); d.nl()
    bal = begin
    for dt,desc,a,extra in tx:
        bal += a
        d.t(40,dt); d.t(90,desc); d.t(470,money(a),right=True); d.t(560,money(bal),right=True); d.nl()
        for e in (extra or []): d.t(90,e); d.nl()
    d.t(90,"Ending Balance"); d.t(560,"$"+money(end),right=True); d.nl()
    d.page(); d.save()
    # the generator writes money-out as negative; Tally's convention is the opposite
    write_expected("chase_checking_2026-01.pdf",
        {"issuer":"Chase","kind":"bank","last4":"3017","start":"2025-12-06","end":"2026-01-05",
         "balances":{"open":begin,"close":end}},
        [(iso_md(dt,2025,2026), desc, -a) for dt,desc,a,_ in tx])

# ---------------- Bilt (Wells Fargo style columns) ----------------
def bilt_wf():
    d = Doc("bilt_2026-01.pdf")
    d.t(40,"Bilt World Elite Mastercard",14,"Helvetica-Bold"); d.nl(20)
    d.t(40,"Account ending in 7782"); d.nl()
    d.t(40,"Statement Period 12/03/2025 to 01/02/2026"); d.nl(18)
    prev = 61240
    tx = [  # (card, trans, post, ref, desc, credit, charge)
        ("7782","12/04","12/05","24692165339000123456789","BPS*BILT RENT 888-888-0000 NY",None,245000),
        ("7782","12/06","12/07","24445005340000987654321","SWEETGREEN IRVINE IRVINE CA",None,1695),
        ("7782","12/12","12/13","24692165346000555512345","LYFT *RIDE SUN 12AM SAN FRANCISCO CA",None,2240),
        ("7782","12/27","12/27","24431065361000777700001","ONLINE PAYMENT THANK YOU",61240,None),
        ("7782","12/29","12/30","24164075363000111122223","TARGET 00012345 MISSION VIEJO CA",None,4377),
        ("7782","12/31","01/01","24164075365000333344445","TARGET 00012345 MISSION VIEJO CA",1299,None),
        ("7782","01/01","01/02","24755425001000444455556","DELTA AIR LINES ATLANTA GA",None,38960),
    ]
    charges = sum(t[6] or 0 for t in tx); credits = sum(t[5] or 0 for t in tx)
    newb = prev - credits + charges
    for k,v in [("Previous Balance","$"+money(prev)),("- Payments","$"+money(61240)),("- Other Credits","$"+money(1299)),
                ("+ Purchases, Balance Transfers & Other Charges","$"+money(charges)),("New Balance","$"+money(newb))]:
        d.t(40,k); d.t(400,v,right=True); d.nl()
    d.t(40,"Payment Due Date 01/27/2026"); d.nl(24)
    d.t(40,"Transactions",11,"Helvetica-Bold"); d.nl(14)
    d.t(40,"Card Ending",7); d.t(85,"Trans",7); d.t(115,"Post",7); d.t(145,"Reference Number",7); d.t(270,"Description",7); d.t(500,"Credits",7,right=True); d.t(565,"Charges",7,right=True); d.nl(7)
    d.t(40,"in",7); d.t(85,"Date",7); d.t(115,"Date",7); d.nl(12)
    for card,td,pd,ref,desc,cr,ch in tx:
        d.t(40,card,8); d.t(85,td,8); d.t(115,pd,8); d.t(145,ref,8); d.t(270,desc,8)
        if cr: d.t(500,money(cr),8,right=True)
        if ch: d.t(565,money(ch),8,right=True)
        d.nl(11)
    d.nl(6); d.t(270,"TOTAL PURCHASES, BALANCE TRANSFERS & OTHER CHARGES FOR THIS PERIOD",8); d.t(565,"$"+money(charges),8,right=True); d.nl()
    d.page(); d.save()
    write_expected("bilt_2026-01.pdf",
        {"issuer":"Bilt","kind":"card","last4":"7782","start":"2025-12-03","end":"2026-01-02",
         "balances":{"open":prev,"close":newb}},
        [(iso_md(td,2025,2026), desc, -cr if cr else ch) for _,td,_,_,desc,cr,ch in tx])
    return 61240

# ---------------- Bilt (simple "Date / Description / Amount" style) ----------------
def bilt_simple():
    d = Doc("bilt_cardless_2026-02.pdf")
    d.t(40,"Bilt Card",14,"Helvetica-Bold"); d.nl(20)
    d.t(40,"Card ending in 7782 | Statement closing date: 02/02/2026"); d.nl()
    prev = 0
    tx = [("01/05/2026","Bilt Rent - Example Apartments",245000),("01/09/2026","Payment - Thank you",-61240+0),
          ("01/15/2026","Ralphs #0123 Irvine CA",5321),("01/20/2026","Apple.com/bill",299),("01/28/2026","Refund: Ralphs #0123",-1200)]
    prev = 61240
    newb = prev + sum(a for *_,a in tx)
    d.t(40,"Previous balance $"+money(prev)); d.nl(); d.t(40,"New balance $"+money(newb)); d.nl(20)
    d.t(40,"Date",9,"Helvetica-Bold"); d.t(130,"Description",9,"Helvetica-Bold"); d.t(560,"Amount",9,"Helvetica-Bold",right=True); d.nl(14)
    for dt,desc,a in tx:
        d.t(40,dt); d.t(130,desc); d.t(560,("-$" if a<0 else "$")+money(abs(a)),right=True); d.nl()
    d.page(); d.save()
    write_expected("bilt_cardless_2026-02.pdf",
        {"issuer":"Bilt","kind":"card","last4":"7782","start":None,"end":"2026-02-02",
         "balances":{"open":prev,"close":newb}},
        [(iso_full(dt), desc, a) for dt,desc,a in tx])

newb = chase_card()
bp = bilt_wf()
chase_checking(120355, bp)
bilt_simple()
print("ok")
