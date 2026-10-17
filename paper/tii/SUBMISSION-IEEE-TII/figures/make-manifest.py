# -*- coding: utf-8 -*-
"""Regenerate FILE-MANIFEST.json for the current main.pdf state."""
import hashlib
import json
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)

import pymupdf

doc = pymupdf.open("main.pdf")
pages = len(doc)

def sha(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 16), b""):
            h.update(chunk)
    return h.hexdigest()

# Files in the active manuscript package. Retired assets (moved to
# figures/retired/, no longer referenced by main.tex) are listed separately.
active = ["main.tex", "main.pdf", "main.blg", "main.log",
          "resources/refs.bib", "resources/results-macros.tex",
          "resources/fig2-architecture.pdf",
          "resources/fig-runtime.pdf",
          "resources/fig-admission.pdf",
          "resources/fig-hitl-card.pdf",
          "resources/fig-process-campaign.pdf",
          "resources/fig-missions.pdf"]
retired = ["figures/retired/fig-runtime.pdf",
           "figures/retired/fig-lifecycle.pdf",
           "figures/retired/fig-four-missions.pdf",
           "figures/retired/fig-campaign.pdf",
           "figures/retired/fig-multiscenario-optimization.pdf",
           "figures/retired/fig-regression-campaign.pdf",
           "figures/retired/fig-system-evaluation.pdf",
           "figures/retired/fig1-governed-binding-v2.pdf",
           "figures/retired/aw_working-fig4-tall-print.jpg"]

files = {}
for name in active + retired:
    if os.path.exists(name):
        files[name] = sha(name)
review_dir = "review/r14"
for i in range(pages):
    p = "%s/p%02d.png" % (review_dir, i + 1)
    if os.path.exists(p):
        files[p] = sha(p)

# figure -> page map from rendered text
fig_pages = {}
for i in range(pages):
    for n in sorted(set(re.findall(r"Fig\. (\d)\.", doc[i].get_text()))):
        fig_pages.setdefault(n, i + 1)

manifest = {
    "source_root": ".",
    "scope": "self-contained IEEE TII LaTeX package for the compiled manuscript",
    "entrypoint": "main.tex",
    "output": "main.pdf",
    "output_pages": pages,
    "compile": "tectonic main.tex (XeTeX; pdfLaTeX latexmk path also works)",
    "resource_layout": {
        "resources": "figures + refs.bib + results-macros.tex",
        "sections": "manuscript chapters",
        "figures": "matplotlib sources for the generated figures",
        "figures/retired": "assets no longer referenced by main.tex"
    },
    "generated_at": "2026-10-17",
    "files": files,
    "quality_pass": (
        "2026-10-17 final TII revision: regenerated the BOPET archive summary "
        "(attained=yes), added the success-flag baseline (22/22; publish-only "
        "receipt success-flag=true vs graded unverified), rebuilt all figures "
        "at 8 pt (Fig.1 full width; Fig.2 vector runtime; Fig.3(a)/(b) "
        "side-by-side; Fig.4 S4/S5; Fig.5 full-width four panels), anonymized "
        "the system name for double-blind, consolidated to 30 references, "
        "removed all version/commit/run identifiers, corrected boundary "
        "margins/p95/live-load claims and the grade-state mapping, and added "
        "the thesis/falsifiable-contrast/takeaway framing; 10 pages, "
        "0 overfull, audit F1-F8 green, figure audit pass, check-refs 30/30, "
        "abstract 214 words."),
    "figures_note": ("5 figures, all 8 pt at placed width: fig2-architecture "
                     "(Fig.1, \\textwidth), fig-runtime (Fig.2, "
                     "\\columnwidth), fig-admission + fig-hitl-card "
                     "(Fig.3(a)/(b), half-width panels), fig-process-campaign "
                     "(Fig.4, \\columnwidth), fig-missions (Fig.5, "
                     "\\textwidth); 3 tables (nearest systems, ablation, "
                     "campaign); observed page map: "
                     + json.dumps(fig_pages, sort_keys=True))
}

with open("FILE-MANIFEST.json", "w", encoding="utf-8") as f:
    json.dump(manifest, f, indent=2, ensure_ascii=False)
print("manifest written; pages:", pages, "| fig pages:", fig_pages)
