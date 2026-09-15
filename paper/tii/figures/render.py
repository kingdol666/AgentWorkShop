#!/usr/bin/env python
"""Render paper/tii/figures/*.html -> SVG + high-DPI PNG, and audit text/line collisions.

Usage:
  python paper/tii/figures/render.py arch.html --width 1600 --height 940
  python paper/tii/figures/render.py arch.html --svg arch.svg --png arch.png --scale 2.687
"""
from __future__ import annotations
import argparse, json, os, re, sys
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))

AUDIT_JS = r"""
() => {
  const svg = document.querySelector('svg');
  if (!svg) return {error: 'no svg'};
  // Text boxes via getBBox in user space
  const texts = [...svg.querySelectorAll('text')].map((t, i) => {
    let b; try { b = t.getBBox(); } catch (e) { return null; }
    const m = t.transform.baseVal.consolidate();
    let x = b.x, y = b.y, w = b.width, h = b.height;
    let rotated = false;
    if (m) {
      const mx = m.matrix;
      // rotation magnitude
      const rot = Math.abs(Math.atan2(mx.b, mx.a) * 180 / Math.PI);
      rotated = rot > 1;
      if (rotated) {
        // bounding box of rotated text: approximate by swapping extents around anchor
        const cx = mx.e - 0, cy = mx.f;
        // after rotate(-90) translate then rotate: text drawn along -y
        x = cx - h / 2; y = cy - w / 2; const t2 = w; w = h; h = t2;
      }
    }
    return {i, text: (t.textContent || '').trim().slice(0, 46), x, y, w, h, rotated};
  }).filter(Boolean);
  // Shape boxes
  const shapes = [...svg.querySelectorAll('rect,path,line,circle,ellipse,polygon,polyline')].map((s, i) => {
    if (s.closest('defs')) return null;
    let b; try { b = s.getBBox(); } catch (e) { return null; }
    return {i, tag: s.tagName, cls: s.getAttribute('class') || '',
            isContainer: s.hasAttribute('data-container'),
            fill: s.getAttribute('fill'), stroke: s.getAttribute('stroke'),
            fillOpacity: s.getAttribute('fill-opacity'),
            x: b.x, y: b.y, w: b.width, h: b.height};
  }).filter(Boolean);
  return {texts, shapes, vb: svg.getAttribute('viewBox')};
}
"""


def overlap(a, b, tol=0.5):
    x = max(0.0, min(a["x"] + a["w"], b["x"] + b["w"]) - max(a["x"], b["x"]))
    y = max(0.0, min(a["y"] + a["h"], b["y"] + b["h"]) - max(a["y"], b["y"]))
    return x * y if x > tol and y > tol else 0.0


def norm(s):
    return re.sub(r"\s+", " ", (s or "").strip())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("html")
    ap.add_argument("--svg", default=None)
    ap.add_argument("--png", default=None)
    ap.add_argument("--scale", type=float, default=2.687, help="device scale factor")
    ap.add_argument("--audit", action="store_true")
    a = ap.parse_args()

    src = os.path.join(HERE, a.html)
    stem = os.path.splitext(a.html)[0]
    url = "file:///" + src.replace("\\", "/")

    with sync_playwright() as p:
        br = p.chromium.launch(args=["--force-color-profile=srgb", "--font-render-hinting=none"])
        pg = br.new_page(viewport={"width": 1600, "height": 940}, device_scale_factor=a.scale)
        errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.goto(url, wait_until="networkidle")
        pg.wait_for_timeout(700)

        svg_out = a.svg or f"{stem}.svg"
        svg_out = svg_out if os.path.isabs(svg_out) else os.path.join(HERE, svg_out)
        markup = pg.evaluate("() => document.querySelector('svg').outerHTML")
        with open(svg_out, "w", encoding="utf-8") as f:
            f.write('<?xml version="1.0" encoding="UTF-8"?>\n' + markup)
        print("SVG ->", svg_out)

        if a.png:
            png_out = a.png if os.path.isabs(a.png) else os.path.join(HERE, a.png)
            pg.locator("#wrap").screenshot(path=png_out)
            print("PNG ->", png_out)

        if a.audit:
            data = pg.evaluate(AUDIT_JS)
            ts = data["texts"]
            filled = [s for s in data["shapes"]
                      if s["fill"] and s["fill"] not in ("none", "#ffffff", "white", "#fff", "#FFFFFF")
                      and not s["isContainer"]]
            print(f"\n=== AUDIT  ({len(ts)} text nodes, {len(filled)} filled shapes)  viewBox={data['vb']} ===")

            bad = []
            for i in range(len(ts)):
                for j in range(i + 1, len(ts)):
                    ov = overlap(ts[i], ts[j])
                    if ov > 1.0:
                        bad.append(("TEXT/TEXT", ts[i]["text"], ts[j]["text"], round(ov, 1)))
            for t in ts:
                for s in filled:
                    ov = overlap(t, s)
                    if ov > 1.0:
                        # a card's own left accent bar / plate legitimately hosts its label
                        inter_w = min(t["x"] + t["w"], s["x"] + s["w"]) - max(t["x"], s["x"])
                        inter_h = min(t["y"] + t["h"], s["y"] + s["h"]) - max(t["y"], s["y"])
                        # ignore if text is fully inside shape (normal label-on-plate)
                        inside = (t["x"] >= s["x"] - 1 and t["y"] >= s["y"] - 1 and
                                  t["x"] + t["w"] <= s["x"] + s["w"] + 1 and
                                  t["y"] + t["h"] <= s["y"] + s["h"] + 1)
                        if inside:
                            continue
                        # ignore thin accent strips (<=8 px)
                        if s["w"] <= 8 or s["h"] <= 8:
                            continue
                        frac = ov / max(1e-6, t["w"] * t["h"])
                        if frac > 0.06:
                            bad.append(("TEXT/FILL", t["text"], f'{s["tag"]}:{s["fill"]}',
                                        f"{round(frac*100,1)}% of label buried"))
            if bad:
                print(f"!! {len(bad)} COLLISION(S):")
                for k, u, v, w in bad:
                    print(f"   [{k}] {u!r}  x  {v!r}  -> {w}")
            else:
                print("OK: no text/text overlap, no label buried by a filled shape")

            # out-of-canvas check
            vb = [float(x) for x in data["vb"].split()]
            oob = [t["text"] for t in ts if t["x"] < vb[0] - 1 or t["y"] < vb[1] - 1
                   or t["x"] + t["w"] > vb[2] + 1 or t["y"] + t["h"] > vb[3] + 1]
            print("out-of-canvas text:", oob if oob else "none")

        if errs:
            print("PAGE ERRORS:", errs)
        br.close()


if __name__ == "__main__":
    main()
