"""Assemble the self-contained IEEE TII manuscript source package.

Copies the exact dependency set verified against the LaTeX source graph
(sections, bibliography, figure PDFs/SVGs, figure source data and generator
scripts, figure audit tool) plus the compiled reference PDF, and vendors
IEEEtran.cls so the folder compiles on a plain TeX installation or Overleaf.

Usage:  python tools/pack-source-package.py [output-dir]
"""
from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "source-package-2026-10-26"

SECTIONS = [
    "introduction", "related", "system", "modules",
    "mechanisms", "evaluation", "discussion",
]
FIGURES = [
    "fig-agent-control.pdf", "fig-agent-control.svg", "fig-agent-control.png",
    "fig-architecture-2026-9pt.pdf", "fig-architecture-2026-9pt.svg",
    "fig-runtime-2026-9pt.pdf", "fig-runtime-2026-9pt.svg",
    "fig-admission-hitl-2026.pdf", "fig-admission-hitl-2026.svg",
    "fig-missions-origin.pdf", "fig-missions-origin.svg",
    "fig-missions-origin.png",
]
SOURCE_DATA = [
    "four-scenario-2026-09-28.json",
    "four-scenario-2026-09-28.csv",
    "four-scenario-2026-09-28-manifest.json",
    "current-route-observations.csv",
    "current-route-observations.json",
]
FIGURE_TOOLS = ["make-system-2026.py", "make-agent-control-figure.py",
                "make-admission-figure.py", "plot-missions-origin.py"]

README = """\
# IEEE TII manuscript — self-contained source package

This package contains the current anonymous review manuscript and its source
dependencies. The author block and PDF metadata are empty; acknowledgments are
held for the journal-approved channel.

## Compile

    pdflatex main && bibtex main && pdflatex main && pdflatex main

or simply `latexmk -pdf main.tex`. `IEEEtran.cls` is vendored so the folder
needs no extra class installation; a system IEEEtran is also fine. `main.bbl`
is included, so even a single `pdflatex main` pass renders the references.

Expected result: a 10-page, US Letter, two-column paper. The bibliography is
included in `main.bbl` for a single-pass reference build.

## Contents

- `main.tex` — manuscript entry point
- `sections/` — Sections I–VII sources (`modules.tex` inputs `mechanisms.tex`)
- `resources/refs.bib` — bibliography (includes the IEEEtranBSTCTL record)
- `resources/fig-*.pdf|svg` — the five vector figures used by the manuscript:
  the introduction control path, architecture, task flow, admission/HITL, and
  four-scenario control sequences
- `resources/figure-source-data/` — CSV/JSON data behind the figures
- `figures/*.py` — figure generators: `make-agent-control-figure.py`,
  `make-system-2026.py`, `make-admission-figure.py`, and
  `plot-missions-origin.py`; the scenario generator reads the included
  four-scenario source data
- `tools/audit-figures.py` — figure QA gate (min font size, Arial-only,
  text-width budget, raster check)
- `main.pdf`, `main.bbl` — compiled reference output

## Notes

- Figures and tables are content-frozen for this manuscript; regenerate only
  via the included scripts if data changes.
- The supplementary evidence unit (Supplementary File S1) is submitted
  separately and is not part of this source package.
"""

COPY_PLAN: list[tuple[str, str]] = (
    [("main.tex", "main.tex"),
     ("main.pdf", "main.pdf"),
     ("main.bbl", "main.bbl")]
    + [(f"sections/{s}.tex", f"sections/{s}.tex") for s in SECTIONS]
    + [("resources/refs.bib", "resources/refs.bib")]
    + [(f"resources/{f}", f"resources/{f}") for f in FIGURES]
    + [(f"resources/figure-source-data/{f}",
        f"resources/figure-source-data/{f}") for f in SOURCE_DATA]
    + [(f"figures/{f}", f"figures/{f}") for f in FIGURE_TOOLS]
    + [("tools/audit-figures.py", "tools/audit-figures.py")]
)


def vendor_ieeetran(dest: Path) -> None:
    try:
        cls = subprocess.run(["kpsewhich", "IEEEtran.cls"], check=True,
                             capture_output=True, text=True).stdout.strip()
    except (OSError, subprocess.CalledProcessError) as exc:
        raise SystemExit("Cannot locate IEEEtran.cls via kpsewhich; "
                         "install TeX Live or copy the class manually.") from exc
    shutil.copyfile(cls, dest)


def main() -> None:
    missing = [src for src, _ in COPY_PLAN if not (ROOT / src).is_file()]
    if missing:
        raise SystemExit("Manifest inputs missing: " + ", ".join(missing))
    if OUT.exists():
        shutil.rmtree(OUT)
    for src, rel in COPY_PLAN:
        target = OUT / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / src, target)
    vendor_ieeetran(OUT / "IEEEtran.cls")
    (OUT / "README.md").write_text(README, encoding="utf-8")
    print(f"package: {OUT}")
    print(f"files: {len(COPY_PLAN) + 2}")  # + IEEEtran.cls + README.md
    print("size: %.1f MB" % (sum(f.stat().st_size for f in OUT.rglob('*') if f.is_file()) / 1e6))


if __name__ == "__main__":
    main()
