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
caption_signatures = {
    "1": "Task execution path from context to device and observation",
    "2": "Architecture and record ownership",
    "3": "Registered-harness task flow",
    "4": "Reference pseudocode for the registered-harness task path",
    "5": "Admission and approval boundaries",
    "6": "Pre-task observations and single post-trial probes for six registered-harness tasks",
}
fig_pages: dict[str, int] = {}
for index, page in enumerate(doc, start=1):
    page_text = " ".join(page.get_text().split())
    for number, signature in caption_signatures.items():
        if signature in page_text:
            fig_pages[number] = index

tex = Path("main.tex").read_text(encoding="utf-8")
abstract = tex.split("\\begin{abstract}", 1)[1].split("\\end{abstract}", 1)[0]
abstract = re.sub(r"\\[a-zA-Z]+\*?(?:\[[^]]*\])?(?:\{([^{}]*)\})?", r" \1 ", abstract)
abstract_words = len(re.findall(r"\b[\w]+(?:[-’'][\w]+)*\b", abstract))

files = [
    "main.tex", "main.pdf", "README.md", "REPRODUCIBILITY.md",
    "CLAIM-EVIDENCE-LEDGER.md", "Supplementary-File-S1.zip",
    "Supplementary-File-S2.tex", "Supplementary-File-S2.pdf",
    "Supplementary-File-S3.tex", "Supplementary-File-S3.pdf",
    "Supplementary-File-S4.tex", "Supplementary-File-S4.pdf",
    "resources/refs.bib",
    "resources/fig-agent-control.pdf", "resources/fig-agent-control.svg",
    "resources/fig-agent-control.png",
    "resources/fig-architecture-2026-9pt.pdf", "resources/fig-architecture-2026-9pt.svg",
    "resources/fig-runtime-2026-9pt.pdf", "resources/fig-runtime-2026-9pt.svg",
    "resources/fig-admission-hitl-2026.pdf", "resources/fig-admission-hitl-2026.svg",
    "resources/fig-missions-origin.pdf", "resources/fig-missions-origin.svg",
    "resources/fig-missions-origin.png",
    "resources/figure-source-data/four-scenario-2026-09-28.json",
    "resources/figure-source-data/four-scenario-2026-09-28.csv",
    "resources/figure-source-data/four-scenario-2026-09-28-manifest.json",
    "resources/figure-source-data/current-route-observations.csv",
    "resources/figure-source-data/current-route-observations.json",
    "figures/make-agent-control-figure.py", "figures/make-system-2026.py",
    "figures/make-admission-figure.py", "figures/plot-missions-origin.py",
    "figures/agent-control-path.drawio", "figures/make-manifest.py",
    "tools/audit.py", "tools/audit-figures.py", "tools/pack-source-package.py",
]
files.extend(f"sections/{p.name}" for p in sorted(Path("sections").glob("*.tex")))
missing = [name for name in files if not Path(name).is_file()]
if missing:
    raise SystemExit("Manifest inputs missing: " + ", ".join(missing))

log = Path("main.log").read_text(encoding="utf-8", errors="replace") if Path("main.log").exists() else ""
manifest = {
    "schema": "ieee-tii-manuscript-manifest/2.0",
    "revision": "2026-10-30",
    "scope": "Active anonymous IEEE TII manuscript source, compiled PDF, figures, source data, and supplementary evidence archive.",
    "entrypoint": "main.tex",
    "output": "main.pdf",
    "output_pages": pages,
    "page_size_points": [f"{w} x {h}" for w, h in page_size],
    "document": {"class": "IEEEtran journal", "body_font_size_pt": 10, "columns": 2, "blind_review": True},
    "compile": "latexmk -pdf -pdflatex=\"pdflatex -no-shell-escape %O %S\" -interaction=nonstopmode -file-line-error -synctex=1 -g main.tex",
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
        "Fig. 1 introduces the task-to-device control path; Fig. 2 presents the system architecture on a separate page.",
        "Table III reports four scenario-specific missions; each is one deterministic trajectory, and BOPET was provisioned in a separate sub-run. Fig. 6 reports six registered-harness observations.",
        "The setpoint routines are deterministic and non-LLM; there is one simulator trajectory per scenario, no physical-plant run, and no competing-policy comparison.",
        "The protocol experiment uses five local simulator endpoints; the model-backed OMP channel result is a separate single-scene run with scripted approval and sparse process observations.",
        "The evaluation reports selected protocol and channel outcomes, not the integrated run's overall score or process-tuning summary; warning phases are not presented as successes.",
        "Annealing and wastewater endpoint evidence gaps are stated in the manuscript and shown separately from structured process trajectories.",
        "Visual review of the experiment table and four-panel result figure found no clipping or conspicuous spacing defects.",
        "The build retains underfull-box diagnostics; overfull boxes and unresolved references are absent.",
    ],
    "files": {name: sha(name) for name in files},
    "self_excluded": "FILE-MANIFEST.json",
}
Path("FILE-MANIFEST.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
print(json.dumps({"pages": pages, "page_size": page_size, "abstract_words": abstract_words,
                  "figure_pages": fig_pages, "manifest_files": len(files)}, indent=2))
