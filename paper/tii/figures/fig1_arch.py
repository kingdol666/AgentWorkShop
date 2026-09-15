#!/usr/bin/env python
"""Generate the AgentWorkShop architecture figure (Fig. 1) as print-grade SVG + PNG.

SIZING MODEL
------------
The design canvas is authored in CSS px with no hidden rescaling, then placed
1:1 into the SVG viewBox.  The figure is intended for a *rotated full-page*
IEEE slot, so it is printed 9.0 in wide.  Every authored length therefore maps
to paper at:

    1 css px  ->  (9.0 * 72) / 1240  =  0.5226 pt

so a 12.6 px card body renders at 6.6 pt and a 16 px card title at 8.4 pt --
both inside the IEEE legibility floor for figure annotation.

Every generation run runs a geometric validator in the browser:
  * no text/text bounding-box overlap
  * no text spilling out of the card that owns it
  * nothing outside the viewBox
The script exits non-zero if any check fails.
"""
from __future__ import annotations
import argparse, os, sys
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))

PRINT_WIDTH_IN = 9.0
BASE_W, BASE_H = 1240.0, 768.0          # design canvas, css px == svg user units
PT_PER_PX = (PRINT_WIDTH_IN * 72.0) / BASE_W        # 0.5226 pt per css px


def pt(px: float) -> float:
    """physical point size on paper for a font authored at `px` css px"""
    return px * PT_PER_PX


# ---------------------------------------------------------------------------
# palette: distinct in colour, and separable in greyscale by luminance
#   agent #2B4C7E (L*32)   bridge #B8860B (L*59)   industrial #1F5C3A (L*33)
# ---------------------------------------------------------------------------
C = dict(
    agent="#2B4C7E", agent_l="#F4F7FC",
    bridge="#B8860B", bridge_l="#FDF6EC",
    ind="#1F5C3A", ind_l="#F1F8F6",
    plant="#2C3E50", plant_l="#E7EEF5",
    neutral="#5B6B7C", neutral_l="#EEF2F6",
    audit_l="#F2F4F3",
    rail="#8C6508",
    ink="#16283F", ink2="#4A5A6A", ink3="#6B5A34",
    dash="#7C8B99",
    card="#FFFFFF", card_emph="#FFFCF4",
)
FONT = "Liberation Sans, Helvetica Neue, Arial, sans-serif"
MONO = "Liberation Mono, DejaVu Sans Mono, Consolas, monospace"


def S(v: float) -> str:
    r = round(v, 2)
    return str(int(r)) if r == int(r) else f"{r:g}"


def esc(t: str) -> str:
    return t.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


class Fig:
    def __init__(self):
        self.p: list[str] = []

    def add(self, s: str):
        self.p.append(s)

    def container(self, x, y, w, h, fill, r=6):
        self.add(f'<rect data-container="1" x="{S(x)}" y="{S(y)}" width="{S(w)}" '
                 f'height="{S(h)}" rx="{S(r)}" fill="{fill}"/>')

    def rect(self, x, y, w, h, fill, stroke=None, sw=1.4, r=4, dash=None):
        s = (f'<rect x="{S(x)}" y="{S(y)}" width="{S(w)}" height="{S(h)}" rx="{S(r)}" '
             f'fill="{fill}"')
        if stroke:
            s += f' stroke="{stroke}" stroke-width="{S(sw)}"'
        if dash:
            s += f' stroke-dasharray="{dash}"'
        self.add(s + "/>")

    def path(self, d, stroke, sw=1.8, marker=None, dash=None):
        s = f'<path d="{d}" fill="none" stroke="{stroke}" stroke-width="{S(sw)}"'
        if dash:
            s += f' stroke-dasharray="{dash}"'
        if marker:
            s += f' marker-end="url(#{marker})"'
        self.add(s + "/>")

    def text(self, x, y, t, size=12.6, fill=None, weight=None, anchor=None,
             mono=False, spacing=None, rotate=None):
        fill = fill or C["ink2"]
        bits = f'font-size="{S(size)}"'
        if mono:
            bits += f' font-family="{MONO}"'
        if weight:
            bits += f' font-weight="{weight}"'
        if spacing:
            bits += f' letter-spacing="{spacing}"'
        if anchor:
            bits += f' text-anchor="{anchor}"'
        if rotate is not None:
            self.add(f'<text transform="translate({S(x)},{S(y)}) rotate({rotate})" '
                     f'{bits} fill="{fill}">{esc(t)}</text>')
        else:
            self.add(f'<text x="{S(x)}" y="{S(y)}" {bits} fill="{fill}">{esc(t)}</text>')

    def card(self, x, y, w, h, title, sub, accent, mono=None, sub_size=12.6):
        self.rect(x, y, w, h, C["card_emph"] if mono else C["card"], accent,
                  2.4 if mono else 1.5, r=4)
        self.rect(x, y, 6, h, accent, r=3)
        self.text(x + 20, y + 19, title, 16, C["ink"], weight=700)
        if mono:
            # one <text> node carrying the whole line so the geometric validator
            # sees the true combined extent rather than two overlapping pieces
            self.add(f'<text x="{S(x+20)}" y="{S(y+34)}" font-size="{S(sub_size)}" '
                     f'fill="{C["ink3"]}"><tspan font-family="{MONO}" '
                     f'font-size="{S(sub_size-0.4)}">{esc(mono)}</tspan>{esc(sub)}</text>')
        else:
            self.text(x + 20, y + 34, sub, sub_size, C["ink3"])


# ---------------------------------------------------------------------------
# layout constants (all css px on the 1240 x 830 canvas)
# ---------------------------------------------------------------------------
GA_X, GA_W = 50, 268          # agent half
GB_X, GB_W = 354, 248         # governed bridge
GC_X, GC_W = 638, 268         # industrial half
G_Y, G_HDR, G_H = 116, 22, 222
CARD_INSET = 10
CRD_H = 42
CARD_YS = [142, 190, 238, 286]
PLANT = (828, 498, 300, 56)
AUDIT_Y, AUDIT_H = 620, 58


def build() -> str:
    f = Fig()
    f.add(f'<svg xmlns="http://www.w3.org/2000/svg" width="{S(BASE_W)}" height="{S(BASE_H)}" '
          f'viewBox="0 0 {S(BASE_W)} {S(BASE_H)}" font-family="{FONT}">')
    f.add("<defs>")
    for mid, col in (("aG", C["ind"]), ("aB", C["agent"]),
                     ("aA", C["rail"]), ("aS", C["plant"])):
        f.add(f'<marker id="{mid}" viewBox="0 0 10 10" refX="9.5" refY="5" markerWidth="6" '
              f'markerHeight="6" orient="auto-start-reverse">'
              f'<path d="M0,0.6 L10,5 L0,9.4 z" fill="{col}"/></marker>')
    f.add("</defs>")
    f.rect(0, 0, BASE_W, BASE_H, "#ffffff", r=0)

    # ---------------- interoperability plane ----------------
    f.container(50, 34, 1140, 50, C["neutral_l"], r=6)
    f.rect(50, 34, 1140, 50, "none", C["neutral"], 1.4, r=6)
    f.rect(50, 34, 7, 50, C["neutral"], r=3.5)
    f.add(f'<text x="{S(74)}" y="{S(65)}" font-size="{S(15.4)}" fill="#243444">'
          f'<tspan font-weight="700">Interoperability plane</tspan>'
          f'<tspan fill="{C["ink2"]}">  |  WebSocket AEP v1 (resumable '
          f'sequence)  ·  MCP server (25 tools)'
          f'  ·  A2A agent card + JSON-RPC'
          f'  ·  208 REST route files</tspan></text>')

    # ---------------- group frames ----------------
    for gx, gw, label, col, light in (
            (GA_X, GA_W, "AGENT HALF", C["agent"], C["agent_l"]),
            (GB_X, GB_W, "GOVERNED BRIDGE", C["bridge"], C["bridge_l"]),
            (GC_X, GC_W, "INDUSTRIAL HALF", C["ind"], C["ind_l"])):
        f.container(gx, G_Y, gw, G_H, light)
        f.add(f'<rect x="{S(gx)}" y="{S(G_Y)}" width="{S(gw)}" height="{S(G_H)}" rx="7" '
              f'fill="none" stroke="{col}" stroke-width="1.7" stroke-dasharray="9 5"/>')
        f.rect(gx, G_Y, gw, G_HDR, col, r=7)
        f.rect(gx, G_Y + G_HDR - 8, gw, 8, col)
        f.text(gx + gw / 2, G_Y + 16, label, 15, "#FFFFFF", weight=700,
               anchor="middle", spacing=0.9)

    # ---------------- cards ----------------
    agent_cards = [
        ("Harness registry", "14 engines · capability matrix"),
        ("Lead scheduler + tasks", "7-state tasks · rule fallback"),
        ("Typed memory", "FTS5-CJK + vector, RRF + MMR"),
        ("Teams, channels, SDK", "operator and developer surfaces"),
    ]
    bridge_cards = [
        ("Semantic cards", "unit, range, recipe window", None),
        ("Governed tool surface", " — sole write path", "dcw_control", 11.2),
        ("HITL approval gate", "manual / auto / unbound", None),
        ("Rollback backstop", "breach count, bounded recovery", None),
    ]
    ind_cards = [
        ("Protocol drivers", "Modbus, OPC UA, MQTT, HTTP"),
        ("Per-node edge runtimes", "quota 64 per 250 ms, 3 rates"),
        ("Alarm chain", "warn band, 2 % hysteresis"),
        ("Time-series store", "TimescaleDB, MinIO, fallback"),
    ]
    gax, gcx = GA_X + CARD_INSET, GC_X + CARD_INSET
    gaw, gcw = GA_W - 2 * CARD_INSET, GC_W - 2 * CARD_INSET
    gbx, gbw = GB_X + CARD_INSET, GB_W - 2 * CARD_INSET
    for (t, s), y in zip(agent_cards, CARD_YS):
        f.card(gax, y, gaw, CRD_H, t, s, C["agent"])
    for row, y in zip(bridge_cards, CARD_YS):
        t, s, mono = row[0], row[1], row[2]
        sub_size = row[3] if len(row) > 3 else 12.6
        f.card(gbx, y, gbw, CRD_H, t, s, C["rail"] if mono else C["bridge"],
               mono=mono, sub_size=sub_size)
    for (t, s), y in zip(ind_cards, CARD_YS):
        f.card(gcx, y, gcw, CRD_H, t, s, C["ind"])

    # ---------------- intra-group arrows ----------------
    f.path("M54,320 L38,320 L38,203 L66,203", C["agent"], 1.8, "aB")
    for y0 in CARD_YS[:2]:
        x0 = round(gax + gaw / 2)
        f.path(f"M{x0},{y0+CRD_H} L{x0},{y0+CRD_H+6}", C["agent"], 1.8, "aB")
    for y0 in CARD_YS[:3]:
        x0 = round(gbx + gbw / 2)
        f.path(f"M{x0},{y0+CRD_H} L{x0},{y0+CRD_H+6}", C["bridge"], 1.8, "aA")
    for y0 in CARD_YS[:3]:
        x0 = round(gcx + gcw / 2)
        f.path(f"M{x0},{y0+CRD_H} L{x0},{y0+CRD_H+6}", C["ind"], 1.8, "aG")

    # ---------------- cross-group connectors ----------------
    y_reg = CARD_YS[0] + CRD_H / 2
    y_lead = CARD_YS[1] + CRD_H / 2
    y_back = CARD_YS[3] + CRD_H / 2
    f.path(f"M{GA_X+GA_W},{y_reg:.0f} L{GB_X},{y_reg:.0f}", C["agent"], 2.0, "aB")
    f.text((GA_X + GA_W + GB_X) / 2, y_reg - 6, "bind", 11.4, "#3A5578", anchor="middle")
    f.path(f"M{GA_X+GA_W},{y_lead:.0f} L{GB_X},{y_lead:.0f}", C["agent"], 2.6, "aB")
    f.text((GA_X + GA_W + GB_X) / 2, y_lead - 6, "propose", 11.4, "#3A5578", anchor="middle")

    # governed-write rail: backstop -> edge tier, then down to the plant
    f.path(f"M{gbx+gbw:.0f},{y_back:.0f} L616,{y_back:.0f} L616,{y_lead:.0f} "
           f"L{gcx},{y_lead:.0f}", C["rail"], 2.8, "aA")
    f.path(f"M616,{y_back:.0f} L616,{PLANT[1]+PLANT[3]/2:.0f} "
           f"L{PLANT[0]},{PLANT[1]+PLANT[3]/2:.0f}", C["rail"], 2.8, "aA")
    f.text(608, 404, "governed write", 13.2, C["rail"], weight=700, anchor="middle",
           spacing=0.6, rotate=-90)

    # ---------------- plant ----------------
    px, py, pw, ph = PLANT
    f.rect(px, py, pw, ph, C["plant_l"], C["plant"], 2.0, r=6)
    f.rect(px, py, 7, ph, C["plant"], r=3.5)
    f.text(px + pw / 2 + 4, py + 26, "PLC / physical plant", 16.4, "#1B2A38",
           weight=700, anchor="middle")
    f.text(px + pw / 2 + 4, py + 44, "hard real-time control + safety functions", 13,
           C["ink2"], anchor="middle")

    # process I/O loop
    f.path(f"M{px+pw},{py+20:.0f} L{px+pw+34},{py+20:.0f} L{px+pw+34},{y_reg:.0f} "
           f"L{GC_X+GC_W},{y_reg:.0f}", C["plant"], 2.2, "aS")
    f.path(f"M{px+pw},{py+ph-18:.0f} L{px+pw+150},{py+ph-18:.0f} L{px+pw+150},376 "
           f"L{px+pw+118},376 L{px+pw+118},{y_lead:.0f} L{GC_X+GC_W},{y_lead:.0f}",
           C["plant"], 2.2, "aS")
    f.text(BASE_W - 18, 424, "process I/O", 13.2, C["plant"], weight=700,
           anchor="middle", spacing=0.6, rotate=-90)

    # ---------------- audit plane ----------------
    f.container(50, AUDIT_Y, 1140, AUDIT_H, C["audit_l"], r=6)
    f.rect(50, AUDIT_Y, 1140, AUDIT_H, "none", C["plant"], 1.6, r=6)
    f.rect(50, AUDIT_Y, 7, AUDIT_H, C["plant"], r=3.5)
    f.add(f'<text x="{S(74)}" y="{S(AUDIT_Y+26)}" font-size="{S(15.4)}" fill="#1B2A38">'
          f'<tspan font-weight="700">Shared audit plane</tspan>'
          f'<tspan fill="{C["ink2"]}">  |  </tspan>'
          f'<tspan font-family="{MONO}" font-size="{S(14)}" fill="#3A4A5A">audit_log</tspan>'
          f'<tspan fill="{C["ink2"]}"> (actor, actor kind user/agent/system, target, 8 event '
          f'kinds)  ·  recipe log + version history'
          f'  ·  signed write-journal anchors</tspan></text>')
    f.text(74, AUDIT_Y + 47, "Every write, alarm, recipe change and rollback is attributed "
                             "here; agent actions carry their channel and member badge",
           13, "#6B7A88")

    for x0 in (round(gax + gaw / 2), round(gbx + gbw / 2), round(gcx + gcw / 2)):
        f.path(f"M{x0},{G_Y+G_H} L{x0},{AUDIT_Y-4}", C["dash"], 1.5, "aS", dash="7 5")

    f.add("</svg>")
    return "\n".join(f.p)


VALIDATE_JS = r"""
() => {
  const svg = document.querySelector('svg');
  const cards = [...svg.querySelectorAll('rect')].filter(r =>
      ['#FFFFFF', '#FFFCF4'].includes(r.getAttribute('fill')));
  const out = {texts: [], overflow: [], overlap: [], oob: []};
  const tb = [];
  for (const t of svg.querySelectorAll('text')) {
    let b; try { b = t.getBBox(); } catch(e) { continue; }
    const m = t.transform.baseVal.consolidate();
    let x=b.x, y=b.y, w=b.width, h=b.height, rot=false;
    if (m) {
      const mx=m.matrix, r=Math.abs(Math.atan2(mx.b,mx.a)*180/Math.PI);
      if (r>1){ rot=true; const cx=mx.e, cy=mx.f; x=cx-h/2; y=cy-w/2; const q=w; w=h; h=q; }
    }
    const rec={t:(t.textContent||'').trim().slice(0,46), x,y,w,h,rot};
    tb.push(rec);
    for (const c of cards) {
      let cb; try { cb=c.getBBox(); } catch(e) { continue; }
      const near = x < cb.x+cb.width+4 && x+w > cb.x-4 && y < cb.y+cb.height+4 && y+h > cb.y-4;
      if (!near) continue;
      const inside = x >= cb.x-1 && x+w <= cb.x+cb.width+1 && y >= cb.y-1 && y+h <= cb.y+cb.height+1;
      if (!inside) {
        const ovx=Math.min(x+w,cb.x+cb.width)-Math.max(x,cb.x);
        const ovy=Math.min(y+h,cb.y+cb.height)-Math.max(y,cb.y);
        if (ovx>2 && ovy>2) out.overflow.push({t:rec.t,
          card:[Math.round(cb.x),Math.round(cb.y),Math.round(cb.width),Math.round(cb.height)]});
      }
    }
  }
  for (let i=0;i<tb.length;i++) for (let j=i+1;j<tb.length;j++){
    const a=tb[i], b=tb[j];
    const ox=Math.min(a.x+a.w,b.x+b.w)-Math.max(a.x,b.x);
    const oy=Math.min(a.y+a.h,b.y+b.h)-Math.max(a.y,b.y);
    if (ox>1 && oy>1) out.overlap.push([a.t,b.t,Math.round(ox*oy)]);
  }
  const vb = svg.getAttribute('viewBox').split(' ').map(Number);
  for (const t of tb) if (t.x<vb[0]-1||t.y<vb[1]-1||t.x+t.w>vb[2]+1||t.y+t.h>vb[3]+1) out.oob.push(t.t);
  out.texts = tb;
  return out;
}
"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--svg", default="arch.svg")
    ap.add_argument("--png", default="arch.png")
    ap.add_argument("--dpi", type=float, default=600.0)
    a = ap.parse_args()

    svg = build()
    with open(os.path.join(HERE, a.svg), "w", encoding="utf-8") as fh:
        fh.write('<?xml version="1.0" encoding="UTF-8"?>\n' + svg)

    px_per_in = BASE_W / PRINT_WIDTH_IN
    scale = a.dpi / px_per_in
    print(f"design canvas : {BASE_W:.0f} x {BASE_H:.0f} css px")
    print(f"paper size    : {PRINT_WIDTH_IN} x {BASE_H/px_per_in:.2f} in "
          f"(rotated full-page IEEE slot)")
    print(f"raster        : {a.dpi:.0f} dpi  ->  {int(BASE_W*scale)} x {int(BASE_H*scale)} px")
    print("type on paper :", "  ".join(
        f"{k} {pt(v):.2f}pt" for k, v in
        (("group", 15), ("title", 16), ("body", 12.6), ("plane", 15.4), ("micro", 11.4))))

    html = ('<!doctype html><meta charset="utf-8">'
            '<style>html,body{margin:0;background:#fff}svg{display:block}</style>' + svg)
    tmp = os.path.join(HERE, "_arch_tmp.html")
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write(html)

    with sync_playwright() as p:
        br = p.chromium.launch(args=["--force-color-profile=srgb",
                                     "--font-render-hinting=none"])
        pg = br.new_page(viewport={"width": int(BASE_W), "height": int(BASE_H)},
                         device_scale_factor=scale)
        pg.goto("file:///" + tmp.replace("\\", "/"), wait_until="networkidle")
        pg.wait_for_timeout(500)
        pg.locator("svg").screenshot(path=os.path.join(HERE, a.png))
        res = pg.evaluate(VALIDATE_JS)
        br.close()

    from PIL import Image
    im = Image.open(os.path.join(HERE, a.png))
    print(f"PNG           : {a.png}  {im.size[0]}x{im.size[1]}")
    print()
    print("=== FIGURE VALIDATION ===")
    print(f"text nodes        : {len(res['texts'])}")
    print(f"text/text overlap : {len(res['overlap'])}")
    for o in res["overlap"]:
        print("    !!", o)
    print(f"card overflow     : {len(res['overflow'])}")
    for o in res["overflow"][:12]:
        print("    !!", o)
    print(f"outside viewBox   : {len(res['oob'])} {res['oob'][:6]}")
    ok = not (res["overlap"] or res["overflow"] or res["oob"])
    print("RESULT            :", "PASS" if ok else "FAIL")
    os.remove(tmp)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
