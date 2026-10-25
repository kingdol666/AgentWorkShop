"""Write the content manifest for the currently compiled IEEE TII package."""
from __future__ import annotations

import hashlib
import json
import os
import re
from pathlib import Path

import pymupdf

ROOT = Path(__file__).resolve().parent.parent
os.chdir(ROOT)


def sha(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for chunk in iter(lambda: stream.read(1 << 16), b""):
            digest.update(chunk)
    return digest.hexdigest()


doc = pymupdf.open("main.pdf")
pages = len(doc)
page_size = sorted({(round(p.rect.width, 1), round(p.rect.height, 1)) for p in doc})
fig_pages: dict[str, int] = {}
for index, page in enumerate(doc, start=1):
    # A caption has the form "Fig. 4."; prose references omit the second dot.
    for number in re.findall(r"\bFig\.\s*(\d+)\.\s", page.get_text()):
        fig_pages.setdefault(number, index)

tex = Path("main.tex").read_text(encoding="utf-8")
abstract = tex.split("\\begin{abstract}", 1)[1].split("\\end{abstract}", 1)[0]
abstract = re.sub(r"\\[a-zA-Z]+\*?(?:\[[^]]*\])?(?:\{([^{}]*)\})?", r" \1 ", abstract)
abstract_words = len(re.findall(r"\b[\w]+(?:[-’'][\w]+)*\b", abstract))

files = [
    "main.tex", "main.pdf", "README.md", "REPRODUCIBILITY.md",
    "CLAIM-EVIDENCE-LEDGER.md", "Supplementary-File-S1.zip",
    "resources/refs.bib", "resources/results-macros.tex",
    "resources/fig-architecture-2026-9pt.pdf", "resources/fig-architecture-2026-9pt.svg",
    "resources/fig-runtime-2026-9pt.pdf", "resources/fig-runtime-2026-9pt.svg",
    "resources/fig-admission-hitl-2026.pdf", "resources/fig-admission-hitl-2026.svg",
    "resources/fig-missions-controls.pdf", "resources/fig-missions-controls.svg",
    "resources/fig-missions-controls-preview.png",
    "resources/figure-source-data/source-data-missions.json",
    "resources/figure-source-data/source-data-missions-controls.csv",
    "resources/figure-source-data/source-data-missions-outcomes.csv",
    "resources/figure-source-data/current-route-observations.csv",
    "resources/figure-source-data/current-route-observations.json",
    "figures/make-system-2026.py", "figures/make-evaluation-2026.py",
    "figures/plot-historical-missions.py", "figures/make-manifest.py",
    "tools/audit.py", "tools/audit-figures.py",
]
files.extend(f"sections/{p.name}" for p in sorted(Path("sections").glob("*.tex")))
missing = [name for name in files if not Path(name).is_file()]
if missing:
    raise SystemExit("Manifest inputs missing: " + ", ".join(missing))

log = Path("main.log").read_text(encoding="utf-8", errors="replace") if Path("main.log").exists() else ""
manifest = {
    "schema": "ieee-tii-manuscript-manifest/2.0",
    "revision": "2026-10-26",
    "scope": "Active anonymous IEEE TII manuscript source, compiled PDF, figure sources, source data, and current supplementary evidence package.",
    "entrypoint": "main.tex",
    "output": "main.pdf",
    "output_pages": pages,
    "page_size_points": [f"{w} x {h}" for w, h in page_size],
    "document": {"class": "IEEEtran journal", "body_font_size_pt": 10, "columns": 2, "blind_review": True},
    "compile": "uv run python -B <latex-paper-en>/scripts/compile.py main.tex (pdfLaTeX; shell escape disabled)",
    "abstract_word_count_approx": abstract_words,
    "figure_pages": fig_pages,
    "figures_1_and_2_separate": fig_pages.get("1") != fig_pages.get("2"),
    "pdf_author_metadata_empty": not bool(str(doc.metadata.get("author") or "").strip()),
    "build_log": {
        "overfull_hbox": len(re.findall(r"Overfull \\hbox", log)),
        "overfull_vbox": len(re.findall(r"Overfull \\vbox", log)),
        "underfull_hbox": len(re.findall(r"Underfull \\hbox", log)),
        "underfull_vbox": len(re.findall(r"Underfull \\vbox", log)),
        "unresolved_references": bool(re.search(r"undefined references|Citation .* undefined", log, re.I)),
    },
    "review_notes": [
        "Fig. 1 and Fig. 2 state that scope/channel policy always apply and grant/resource-binding checks are conditional.",
        "Route-study samples use SQLite fallback; separate R24 online MQTT/Timescale evidence is one simulated C01 blueprint replay.",
        "R24 source commit was not pinned; no general portability or process-quality claim is made.",
        "Visual review found no conspicuous nonfinal blank column, clipping, or unusual word spacing; the final page may contain normal end matter whitespace.",
        "ChkTeX reports style heuristics; no global spacing relaxation or mass rewrite was applied.",
    ],
    "files": {name: sha(name) for name in files},
    "self_excluded": "FILE-MANIFEST.json",
}
Path("FILE-MANIFEST.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
print(json.dumps({"pages": pages, "page_size": page_size, "abstract_words": abstract_words,
                  "figure_pages": fig_pages, "manifest_files": len(files)}, indent=2))
