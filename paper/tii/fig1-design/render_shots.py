# -*- coding: utf-8 -*-
"""Render the three Fig. 1 directions to PNG at review scale, plus greyscale
proofs, and build the comparison gallery HTML."""
import base64
import os
import pathlib

from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent
DEMOS = ROOT / "design-demos"
SHOTS = ROOT / "shots"
SHOTS.mkdir(exist_ok=True)

NAMES = [
    ("A-magazine-pop", "Direction A · Magazine Pop Data (Businessweek)",
     "秒数轮盘 #4 · 杂志撞色数据页 —— 结论式大标题压顶、撞色双主色（墨蓝 × 信号红）、"
     "极端字号对比、1px 细线与纸白留白。把 (a) 的重复集成画成被红框圈住的堆叠块，"
     "把 (b) 的受治理路径画成一条有闸门、有回路的通径。"),
    ("B-distill-axis", "Direction B · Shared-Axis Dataflow (Distill.pub grammar)",
     "现实参照标杆 · Distill 的技术解释图语法 —— 不喊口号，把 (a)(b) 放在同一套列坐标上"
     "上下对照，让「同一根轴、两种结构」自己说话；低饱和概念色各绑一个语义"
     "（灰=未治理 / 琥珀=准入 / 绿=证据），发丝级细线，大量负空间做分组。"),
    ("C-aicher-grid", "Direction C · Otl Aicher / Ulm system grid",
     "最佳设计师逻辑 · Otl Aicher（1972 慕尼黑奥运视觉系统、Ulm 栅格方法）—— 可见 12 栏栅格、"
     "只走 0/90° 的正交布线、全大写宽字距标签、同模数组件；底部一条贯穿全幅的 PLANT 带，"
     "左半是三次无闸门直落、右半是一条带闸门与证据回路的受治理路径。"),
]

PAGE = """<!doctype html><html><head><meta charset="utf-8"><style>
html,body{{margin:0;padding:0;background:#fff}}
.wrap{{padding:0}} img{{display:block;width:{w}px;height:auto}}
.gs img{{filter:grayscale(1) contrast(1.02)}}
</style></head><body><div class="wrap {cls}"><img src="{src}"></div></body></html>"""


def shot(page, svg, out, width_css, cls=""):
    tmp = DEMOS / f"_tmp_{out.stem}.html"
    tmp.write_text(PAGE.format(w=width_css, cls=cls,
                               src=svg.name), encoding="utf-8")
    page.goto(tmp.as_uri())
    page.wait_for_timeout(180)
    el = page.query_selector("img")
    el.screenshot(path=str(out))
    tmp.unlink()
    return out


def b64(p):
    return base64.b64encode(p.read_bytes()).decode()


def main():
    with sync_playwright() as p:
        br = p.chromium.launch()
        page = br.new_page(viewport={"width": 1600, "height": 900},
                           device_scale_factor=2)
        for name, _t, _d in NAMES:
            svg = DEMOS / f"{name}.svg"
            shot(page, svg, SHOTS / f"{name}.png", 1432)
            shot(page, svg, SHOTS / f"{name}-gray.png", 1432, cls="gs")
            shot(page, svg, SHOTS / f"{name}-print.png", 516)  # 7.16in @72dpi
        br.close()

    cards = []
    for name, title, desc in NAMES:
        cards.append(f"""
    <section class="card">
      <h2>{title}</h2>
      <p class="why">{desc}</p>
      <div class="row">
        <figure><img src="shots/{name}.png"><figcaption>review scale (2× final)</figcaption></figure>
      </div>
      <div class="row small">
        <figure><img src="shots/{name}-print.png">
          <figcaption>true print size · 7.16 in wide (this is what a reviewer sees on the page)</figcaption></figure>
        <figure class="gs"><img src="shots/{name}-gray.png">
          <figcaption>greyscale proof · must survive print-on-demand</figcaption></figure>
      </div>
    </section>""")

    html = f"""<!doctype html><html><head><meta charset="utf-8">
<title>Fig. 1 — three directions</title>
<style>
 body{{margin:0;background:#EDEEF0;font:15px/1.6 -apple-system,'Segoe UI',Arial,sans-serif;color:#15181C}}
 header{{padding:34px 40px 22px;background:#fff;border-bottom:1px solid #D8DBDF}}
 h1{{margin:0 0 6px;font-size:24px;letter-spacing:-.2px}}
 header p{{margin:0;color:#5A636E;max-width:960px}}
 .card{{background:#fff;margin:26px 40px;padding:26px 30px 32px;border:1px solid #D8DBDF}}
 h2{{margin:0 0 10px;font-size:18px}}
 .why{{margin:0 0 20px;color:#3D444C;max-width:1000px;background:#F7F8F9;
      border-left:3px solid #9AA3AC;padding:10px 14px;font-size:14px}}
 .row{{display:flex;gap:26px;align-items:flex-start;flex-wrap:wrap}}
 .row.small img{{box-shadow:0 1px 6px rgba(0,0,0,.14)}}
 figure{{margin:0}}
 figcaption{{margin-top:8px;font-size:12px;color:#6B7178}}
 img{{max-width:100%;display:block}}
 .gs img{{filter:grayscale(1)}}
</style></head><body>
<header>
  <h1>Fig. 1 — three directions</h1>
  <p>Same content, same canvas (716 × 270 units → 7.16 × 2.70 in in IEEEtran two-column),
  three different structural grammars. Every version carries the full content inventory:
  duplicated per-application integration with its three open questions, the governed
  member–node path, the admission gate, shared production context, and the evidence return.</p>
</header>
{''.join(cards)}
</body></html>"""
    (ROOT / "gallery.html").write_text(html, encoding="utf-8")
    print("wrote gallery.html and", len(NAMES) * 3, "shots")


if __name__ == "__main__":
    main()
