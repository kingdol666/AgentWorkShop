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
          "resources/aws_fig3-flat.png",
          "resources/fig-admission.pdf",
          "resources/hitl-card-crop.png",
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
    "generated_at": "2026-10-10",
    "files": files,
    "quality_pass": ("2026-10-10 compression + figure-consistency pass: 11p -> 10p "
                     "(redundancy cuts in Q1/Q4/Q5/VI/intro; no architecture or "
                     "mechanism content removed); fig2-architecture rebuilt as "
                     "reproducible matplotlib source (make-architecture-figure.py) "
                     "replacing the Calibri HTML->PDF, unifying all generated "
                     "figures on Arial/muted palette; Fig.4/Fig.5 heights reduced; "
                     "stale resources moved to figures/retired/. Prior: 2026-10-09 "
                     "page-budget pass; four-reviewer TII loop converged Accept x4 "
                     "(R1 control/safety, R2 LLM-agents, R3 methodology, R4 format)"),
    "figures_note": ("5 figures, all IEEE-width compliant: fig2-architecture "
                     "(Fig.1, 0.92\\textwidth, Arial rebuild), aws_fig3-flat.png "
                     "(Fig.2, 0.70\\textwidth, user-supplied runtime diagram), "
                     "fig-admission + hitl-card-crop (Fig.3 combined admission "
                     "geometry + live HITL card, \\columnwidth), "
                     "fig-process-campaign (Fig.4, \\columnwidth), fig-missions "
                     "(Fig.5, \\columnwidth); 1 table (Table I nearest-systems); "
                     "30 references (\\scriptsize); observed page map: "
                     + json.dumps(fig_pages, sort_keys=True))
}

with open("FILE-MANIFEST.json", "w", encoding="utf-8") as f:
    json.dump(manifest, f, indent=2, ensure_ascii=False)
print("manifest written; pages:", pages, "| fig pages:", fig_pages)
