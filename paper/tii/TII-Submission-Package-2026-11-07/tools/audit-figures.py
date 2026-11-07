# -*- coding: utf-8 -*-
"""Audit active composite, vector, and raster figures used by the manuscript.

Figure 1 is a composite PDF with a GPT Image illustration and vector labels;
Figures 4 and 5 are vector PDFs. Their text size, font family, CJK text, and
page height are checked. Figures 2 and 3 are full-width raster diagrams and
are checked at the 182-mm (7.16-in) two-column placement width. The raster
minimum is 600 dpi to provide margin above IEEE's color/grayscale threshold.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MANUSCRIPT = ROOT / "manuscript"
SECTIONS = sorted((MANUSCRIPT / "sections").glob("*.tex")) + [MANUSCRIPT / "main.tex"]

VECTOR_TARGETS = {
    "fig1.pdf": (9.3, 150.0, "TimesNewRoman"),
    "fig4.pdf": (9.0, 290.0, "TimesNewRoman"),
    "fig5.pdf": (9.0, 320.0, "TimesNewRoman"),
}
# Figure 1 is placed at 0.98\columnwidth in the manuscript. Its PDF canvas is
# one-column width (3.5 in); check the final-size type against IEEE guidance.
PLACEMENT_SCALE = {"fig1.pdf": 0.98}
MIN_FINAL_TYPE_PT = 9.0
RASTER_TARGETS = {
    "fig2.png": {"min_dpi": 600, "width_mm": 182.0, "aspect": 2.0},
    "fig3.png": {"min_dpi": 600, "width_mm": 182.0, "aspect": 2.0},
}


def included_figures() -> set[str]:
    pattern = re.compile(r"\\includegraphics(?:\[[^\]]*\])?\{([^}]+)\}")
    found: set[str] = set()
    for path in SECTIONS:
        for match in pattern.finditer(path.read_text(encoding="utf-8")):
            found.add(Path(match.group(1)).name)
    return found


def main() -> int:
    try:
        import pymupdf
    except ImportError:
        print("FAIL: pymupdf is required for the figure audit")
        return 2

    included = included_figures()
    targets = set(VECTOR_TARGETS) | set(RASTER_TARGETS)
    missing = sorted(targets - included)
    unknown = sorted(included - targets)
    failures: list[str] = []

    print(f"figures included: {', '.join(sorted(included))}")
    if missing:
        print(f"  note: targets not currently included: {', '.join(missing)}")
    for name in unknown:
        failures.append(f"{name}: no per-figure target registered")

    for name, (min_pt, max_height, expected_font) in VECTOR_TARGETS.items():
        if name not in included:
            continue
        path = ROOT / "figures" / name
        if not path.exists():
            failures.append(f"{name}: missing file")
            continue
        document = pymupdf.open(path)
        page = document[0]
        spans = [span for block in page.get_text("dict")["blocks"] if block["type"] == 0
                 for line in block["lines"] for span in line["spans"]
                 if span["text"].strip()]
        if not spans:
            failures.append(f"{name}: no text spans")
            continue
        sizes = [round(span["size"], 2) for span in spans]
        scale = PLACEMENT_SCALE.get(name, 1.0)
        final_min = min(sizes) * scale
        fonts = sorted({span["font"] for span in spans})
        text = "".join(span["text"] for span in spans)
        if min(sizes) < min_pt - 0.01:
            failures.append(f"{name}: min type {min(sizes)} pt < {min_pt} pt")
        if final_min < MIN_FINAL_TYPE_PT - 0.01:
            failures.append(f"{name}: final-size type {final_min:.2f} pt < {MIN_FINAL_TYPE_PT} pt")
        if any(expected_font not in font for font in fonts):
            failures.append(f"{name}: expected {expected_font} font(s), found {fonts}")
        if any("\u4e00" <= char <= "\u9fff" for char in text):
            failures.append(f"{name}: CJK text present")
        if page.rect.height > max_height + 0.1:
            failures.append(f"{name}: height {page.rect.height:.1f} pt > {max_height} pt")
        print(f"  {name}: min={min(sizes):.2f} pt, final min={final_min:.2f} pt, "
              f"h={page.rect.height:.1f} pt, fonts={fonts}")

    try:
        from PIL import Image
    except ImportError:
        Image = None

    for name, spec in RASTER_TARGETS.items():
        if name not in included:
            continue
        path = ROOT / "figures" / name
        if not path.exists():
            failures.append(f"{name}: missing file")
            continue
        if Image is None:
            failures.append(f"{name}: PIL unavailable for raster check")
            continue
        with Image.open(path) as image:
            width, height = image.size
            dpi = width / (spec["width_mm"] / 25.4)
            aspect = width / height
            print(f"  {name}: {width}x{height}px -> {dpi:.0f} effective dpi at {spec['width_mm']:.0f} mm")
            if image.format != "PNG":
                failures.append(f"{name}: expected PNG, got {image.format}")
            if dpi < spec["min_dpi"]:
                failures.append(f"{name}: {dpi:.0f} effective dpi < {spec['min_dpi']} dpi")
            if abs(aspect - spec["aspect"]) > 0.02:
                failures.append(f"{name}: aspect ratio {aspect:.3f} differs from {spec['aspect']}")

    if failures:
        print("\nFIGURE AUDIT FAIL")
        for failure in failures:
            print(f"  - {failure}")
        return 1
    print("\nFIGURE AUDIT PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
