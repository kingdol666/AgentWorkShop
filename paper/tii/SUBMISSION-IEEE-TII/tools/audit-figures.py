# -*- coding: utf-8 -*-
"""Figure-specific audit: final-size type, font family, CJK, media height,
and raster DPI for every figure included by the manuscript.

The general audit (tools/audit.py, gate F8) only checks the vector source
type floor (5 pt).  This gate applies the manuscript's own targets:

  Fig. 1 architecture       >= 6.0 pt (full-width dense diagram)
  Fig. 2 runtime            >= 8.0 pt
  Fig. 3(a) admission       >= 6.0 pt (compact interval geometry)
  Fig. 3(b) approval card   >= 8.0 pt
  Fig. 4 process campaign   >= 7.0 pt
  Fig. 5 missions           >= 7.0 pt

Rasters, if any, must be >= 300 dpi at their placed width.  The manuscript
currently includes only PDFs; the raster branch is kept so a future PNG
swap cannot bypass the check.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SECTIONS = sorted((ROOT / "sections").glob("*.tex")) + [ROOT / "main.tex"]

TARGETS = {
    "fig2-architecture.pdf": (8.0, 200.0),
    "fig-runtime.pdf": (8.0, 166.0),
    "fig-admission.pdf": (8.0, 120.0),
    "fig-hitl-card.pdf": (8.0, 100.0),
    "fig-process-campaign.pdf": (8.0, 122.0),
    "fig-missions.pdf": (8.0, 165.0),
}

def included_figures() -> set[str]:
    pat = re.compile(r"\\includegraphics(?:\[[^\]]*\])?\{([^}]+)\}")
    found: set[str] = set()
    for p in SECTIONS:
        for m in pat.finditer(p.read_text(encoding="utf-8")):
            found.add(Path(m.group(1)).name)
    return found

def main() -> int:
    try:
        import pymupdf
    except ImportError:
        print("FAIL: pymupdf is required for the figure audit")
        return 2

    included = included_figures()
    missing = sorted(set(TARGETS) - included)
    unknown = sorted(included - set(TARGETS))
    failures: list[str] = []

    print(f"figures included: {', '.join(sorted(included))}")
    if missing:
        print(f"  note: targets not currently included: {', '.join(missing)}")
    for name in unknown:
        failures.append(f"{name}: no per-figure target registered")

    for name, (min_pt, max_h) in TARGETS.items():
        if name not in included:
            continue
        path = ROOT / "resources" / name
        if not path.exists():
            failures.append(f"{name}: missing file")
            continue
        doc = pymupdf.open(path)
        page = doc[0]
        spans = [s for b in page.get_text("dict")["blocks"] if b["type"] == 0
                 for l in b["lines"] for s in l["spans"] if s["text"].strip()]
        if not spans:
            failures.append(f"{name}: no text spans")
            continue
        sizes = [round(s["size"], 2) for s in spans]
        fonts = sorted({s["font"] for s in spans})
        text = "".join(s["text"] for s in spans)
        if min(sizes) < min_pt - 0.01:
            failures.append(f"{name}: min type {min(sizes)} pt < {min_pt} pt")
        if any("Arial" not in f for f in fonts):
            failures.append(f"{name}: non-Arial font(s) {fonts}")
        if any("\u4e00" <= ch <= "\u9fff" for ch in text):
            failures.append(f"{name}: CJK text present")
        if page.rect.height > max_h + 0.1:
            failures.append(f"{name}: height {page.rect.height:.1f} pt > {max_h} pt")
        print(f"  {name}: min={min(sizes):.2f} pt, h={page.rect.height:.1f} pt, "
              f"fonts={fonts}")

    # Raster guard: any PNG/JPEG include must be >= 300 dpi at 89 mm.
    for name in sorted(included):
        if not name.lower().endswith((".png", ".jpg", ".jpeg")):
            continue
        try:
            from PIL import Image
        except ImportError:
            failures.append(f"{name}: PIL unavailable for raster DPI check")
            continue
        im = Image.open(ROOT / "resources" / name)
        dpi = im.width / (89.0 / 25.4)
        print(f"  {name}: raster {im.width}x{im.height}px -> {dpi:.0f} dpi at 89 mm")
        if dpi < 300:
            failures.append(f"{name}: {dpi:.0f} dpi < 300 dpi")

    if failures:
        print("\nFIGURE AUDIT FAIL")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("\nFIGURE AUDIT PASS")
    return 0

if __name__ == "__main__":
    sys.exit(main())
