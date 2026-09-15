#!/usr/bin/env python
"""Rasterise paper/tii/main.pdf -> paper/tii/render/page-NN.png for visual review."""
import os, sys, glob
import fitz  # PyMuPDF

HERE = os.path.dirname(os.path.abspath(__file__))
PDF = os.path.join(HERE, "main.pdf")
OUT = os.path.join(HERE, "render")

os.makedirs(OUT, exist_ok=True)
for f in glob.glob(os.path.join(OUT, "page-*.png")):
    os.remove(f)

doc = fitz.open(PDF)
print(f"pages: {doc.page_count}")
for i, page in enumerate(doc):
    # ~200 dpi rasterisation of a 8.5x11in page
    pix = page.get_pixmap(dpi=170)
    p = os.path.join(OUT, f"page-{i+1:02d}.png")
    pix.save(p)
    print(f"  {p}  {pix.width}x{pix.height}")
doc.close()
