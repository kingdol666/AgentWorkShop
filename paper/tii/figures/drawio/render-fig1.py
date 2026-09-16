# -*- coding: utf-8 -*-
"""Render fig1-arch-print.svg to figures/pdf/fig-arch.pdf at exact print size.

The SVG is authored on a 1500 px canvas that maps to the IEEE single-column-span
text width (181 mm).  The wrapper pins @page to that width and the matching
height so Chrome's print-to-pdf emits a page whose text is already at final
size -- no LaTeX-side scaling, so the >= 6 pt floor verified by build-fig1.py
holds in the PDF.
"""
import io, os, re, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
SVG = os.path.join(HERE, "fig1-arch-print.svg")
HTML = os.path.join(HERE, "render-fig1.html")
OUT = os.path.abspath(os.path.join(HERE, "..", "pdf", "fig-arch.pdf"))
CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"

WIDTH_MM = 181.0
head = io.open(SVG, encoding="utf-8").read(400)
m = re.search(r'width="(\d+)"\s+height="(\d+)"', head)
if not m:
    sys.exit("cannot read SVG canvas size")
w_px, h_px = int(m.group(1)), int(m.group(2))
height_mm = WIDTH_MM * h_px / w_px

io.open(HTML, "w", encoding="utf-8").write(f"""<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Fig. 1</title>
<style>
  @page {{ size: {WIDTH_MM}mm {height_mm:.4f}mm; margin: 0; }}
  html, body {{ margin: 0; padding: 0; width: {WIDTH_MM}mm; height: {height_mm:.4f}mm; }}
  img {{ width: {WIDTH_MM}mm; height: {height_mm:.4f}mm; display: block; }}
</style></head>
<body><img src="fig1-arch-print.svg"></body></html>
""")

url = "file:///" + HTML.replace("\\", "/")
subprocess.run([CHROME, "--headless=new", "--disable-gpu", "--no-pdf-header-footer",
                "--run-all-compositor-stages-before-draw", "--virtual-time-budget=4000",
                f"--print-to-pdf={OUT}", url], check=True, capture_output=True)
print(f"rendered {OUT}  ({WIDTH_MM} x {height_mm:.2f} mm; canvas {w_px}x{h_px} px)")
