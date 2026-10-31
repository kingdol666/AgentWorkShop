"""Portable row/column panel alignment check for these Matplotlib figures.

Used only when the optional nature-figure alignment auditor is unavailable.
Checks plot rectangles after draw for shared grid edges and overlaps in pt;
the published QA files were produced with the full auditor.
"""
from __future__ import annotations

import json
from itertools import combinations
from pathlib import Path


def require_matplotlib_panel_alignment(fig, *, json_out, overlay_svg,
                                       tolerance_pt=1.5, gutter_tolerance_pt=1.5,
                                       strict=True):
    fig.canvas.draw()
    w, h = fig.get_size_inches() * 72
    panels = []
    for i, ax in enumerate(fig.axes):
        spec = ax.get_subplotspec()
        box = ax.get_position()
        panels.append({"id": chr(97 + i), "row": spec.rowspan.start,
                       "col": spec.colspan.start, "bbox_pt": [box.x0*w, box.y0*h,
                                                               box.x1*w, box.y1*h]})
    failures = []
    for a, b in combinations(panels, 2):
        a0, a1, a2, a3 = a["bbox_pt"]
        b0, b1, b2, b3 = b["bbox_pt"]
        if a["row"] == b["row"] and max(abs(a1-b1), abs(a3-b3)) > tolerance_pt:
            failures.append(f"row edge mismatch: {a['id']}, {b['id']}")
        if a["col"] == b["col"] and max(abs(a0-b0), abs(a2-b2)) > tolerance_pt:
            failures.append(f"column edge mismatch: {a['id']}, {b['id']}")
        if min(a2, b2) > max(a0, b0) and min(a3, b3) > max(a1, b1):
            failures.append(f"plot areas overlap: {a['id']}, {b['id']}")
    report = {"backend": "python-matplotlib", "auditor": "portable-grid-check",
              "verdict": "FAIL" if failures else "PASS", "tolerance_pt": tolerance_pt,
              "panels": panels, "failures": failures}
    Path(json_out).write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    # SVG is a diagnostic geometry map, not a rendering of the data figure.
    boxes = []
    for panel in panels:
        x0, y0, x1, y1 = panel["bbox_pt"]
        boxes.append(f'<rect x="{x0:.2f}" y="{h-y1:.2f}" width="{x1-x0:.2f}" '
                     f'height="{y1-y0:.2f}" fill="none" stroke="red"/>')
    Path(overlay_svg).write_text(f'<svg xmlns="http://www.w3.org/2000/svg" '
                                 f'viewBox="0 0 {w:.2f} {h:.2f}">' +
                                 "".join(boxes) + "</svg>\n", encoding="utf-8")
    if failures and strict:
        raise ValueError("Panel alignment failed: " + "; ".join(failures))
