import pymupdf, sys, os
RES = r"D:\codes\AgentWorkShop\paper\tii\SUBMISSION-IEEE-TII\resources"

def overlap(a, b, tol=0.0):
    ix = min(a.x1,b.x1) - max(a.x0,b.x0)
    iy = min(a.y1,b.y1) - max(a.y0,b.y0)
    if ix <= tol or iy <= tol: return 0.0
    inter = ix*iy
    return inter / min(a.get_area(), b.get_area())

def qa(path):
    d = pymupdf.open(path)
    pg = d[0]
    print(f"\n=== {os.path.basename(path)}  mediabox={pg.rect.width:.1f}x{pg.rect.height:.1f}pt "
          f"({pg.rect.width/72:.2f}x{pg.rect.height/72:.2f}in)  pages={d.page_count}")
    spans = []
    for blk in pg.get_text("dict")["blocks"]:
        for line in blk.get("lines", []):
            for sp in line["spans"]:
                if sp["text"].strip():
                    spans.append((pymupdf.Rect(sp["bbox"]), sp["text"], sp["size"], sp["font"]))
    sizes = sorted({round(s[2],1) for s in spans})
    print(f"  text spans={len(spans)}  font sizes used={sizes}")
    if spans:
        allb = pymupdf.Rect(spans[0][0])
        for r,_,_,_ in spans: allb |= r
        print(f"  text bbox x[{allb.x0:.1f},{allb.x1:.1f}] y[{allb.y0:.1f},{allb.y1:.1f}]")
        m = pg.rect
        clip = []
        if allb.x0 < 0.5: clip.append("left")
        if allb.y0 < 0.5: clip.append("top")
        if allb.x1 > m.width-0.5: clip.append("right")
        if allb.y1 > m.height-0.5: clip.append("bottom")
        print(f"  clipping: {clip if clip else 'none'}")
    # collisions
    coll = []
    for i in range(len(spans)):
        for j in range(i+1, len(spans)):
            o = overlap(spans[i][0], spans[j][0])
            if o > 0.12:
                coll.append((o, spans[i][1][:26], spans[j][1][:26]))
    coll.sort(reverse=True)
    print(f"  text collisions (IoU>0.12 of smaller): {len(coll)}")
    for o,a,b in coll[:12]:
        print(f"     {o:.2f}  '{a}'  <->  '{b}'")
    fonts = sorted({s[3] for s in spans})
    print(f"  fonts: {fonts}")

import sys
targets = sys.argv[1:] or ["fig-process-campaign.pdf", "fig-missions.pdf",
                           "fig-admission.pdf", "fig2-architecture.pdf"]
for f in targets:
    p = os.path.join(RES, f)
    qa(p) if os.path.exists(p) else print("MISSING", p)