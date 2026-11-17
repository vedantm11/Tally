from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import letter
import sys, os, json
c = canvas.Canvas(sys.argv[1], pagesize=letter, invariant=1)  # deterministic output
MONTHS = {"Jan":1,"Feb":2,"Mar":3,"Apr":4,"May":5,"Jun":6,"Jul":7,"Aug":8,"Sep":9,"Oct":10,"Nov":11,"Dec":12}
def iso_words(s):  # "Jul 22, 2026" -> "2026-07-22"
    mo, d, y = s.replace(",", "").split()
    return f"{y}-{MONTHS[mo]:02d}-{int(d):02d}"
def hdr():
    c.setFont("Helvetica",9); c.drawString(40,715,"Alex Example"); c.drawRightString(570,715,"Bilt Obsidian Card"); c.drawRightString(570,699,"Jul 21 – Aug 20, 2026")
def foot(n): c.setFont("Helvetica",7); c.drawString(40,35,"Cardless Inc. is the servicer of the Bilt Cards."); c.drawRightString(570,35,f"Page {n} of 3")
pays=[("Jul 22, 2026","PAYMENT",-10000),("Jul 28, 2026","BILT RENT CHARGE ADJUSTMENT",-200000)]
buys=[("Jul 26, 2026","GOJUMP OCEANSIDE 480 AIRPORT ROAD",21630,"OCEANSIDE 92058 CA USA"),("Jul 28, 2026","BPS*BILT HOUSING 1 Main St New York",200000,"10014 NY USA"),
      ("Aug 3, 2026","RALPHS #0080 17605 HARVARD AVE IRVINE 92614",688,"CA USA"),("Aug 7, 2026","TST*SHAKE SHACK CRYSTA7703 East Coast Hwy",9712,"Newport Beach92657 CA USA"),
      ("Aug 10, 2026","TRADER JOE S #113 3329 S BRISTOL ST SANTA ANA",2218,"92704 CA USA"),("Aug 14, 2026","CLOUDFLARE 101 Townsend Street SAN",-3446,"FRANCISCO94107 CA USA"),
      ("Jul 30, 2026","CLOUDFLARE 101 Townsend Street SAN",3446,"FRANCISCO94107 CA USA")]
m=lambda x:("-$" if x<0 else "$")+f"{abs(x)/100:,.2f}"
prev=10000; pt=sum(a for *_,a in pays); bt=sum(b[2] for b in buys)
hdr(); c.setFont("Helvetica",9)
c.drawString(40,649,"New balance as of Aug 20, 2026"); c.drawString(223,649,"Balance breakdown")
c.drawString(223,625,"Previous balance"); c.drawRightString(570,625,m(prev)); c.setFont("Helvetica-Bold",14); c.drawString(40,615,m(prev+pt+bt)); c.setFont("Helvetica",9)
c.drawString(223,609,"Payments and credits"); c.drawRightString(570,609,m(pt)); c.drawString(223,592,"Purchases (Including New Card Purchases)"); c.drawRightString(570,592,m(bt))
c.drawString(40,540,"Minimum payment due"); c.drawString(40,451,"Payment due by"); c.drawString(40,421,"Sep 15, 2026"); foot(1); c.showPage()
hdr(); c.setFont("Helvetica-Bold",11); c.drawString(40,644,"Payments and credits"); c.setFont("Helvetica",9)
c.drawString(40,610,"Date"); c.drawString(223,610,"Description"); c.drawRightString(570,610,"Amount"); y=577
for d,desc,a in pays: c.drawString(40,y,d); c.drawString(223,y,desc); c.drawRightString(570,y,m(a)); y-=33
c.drawString(40,y,"Total payments and credits in this period"); c.drawRightString(570,y,m(pt)); y-=50
c.setFont("Helvetica-Bold",11); c.drawString(40,y,"Transactions"); c.setFont("Helvetica",9); y-=34
c.drawString(40,y,"Date"); c.drawString(223,y,"Description"); c.drawRightString(570,y,"Amount"); y-=33
for i,(d,desc,a,det) in enumerate(buys):
    if y<90: foot(2); c.showPage(); hdr(); c.setFont("Helvetica",9); y=659
    c.drawString(40,y,d); c.drawString(223,y,desc); c.drawRightString(570,y,m(a)); c.drawString(223,y-12,det); y-=45
c.drawString(40,y,"Total new charges in this period"); c.drawRightString(570,y,m(bt)); foot(3); c.save()
# ground truth alongside the PDF (see gen_statements.write_expected)
gt = [(iso_words(d), desc, a) for d,desc,a in pays] + [(iso_words(d), desc, a) for d,desc,a,_ in buys]
exp = {"file": os.path.basename(sys.argv[1]),
       "meta": {"issuer":"Bilt","kind":"card","last4":None,"start":"2026-07-21","end":"2026-08-20",
                "balances":{"open":prev,"close":None}},
       "count": len(gt), "sum": sum(t[2] for t in gt),
       "txns": [{"date":d,"desc":s,"amt":a} for d,s,a in gt]}
with open(sys.argv[1][:-4] + ".expected.json", "w") as f:
    json.dump(exp, f, indent=1); f.write("\n")
