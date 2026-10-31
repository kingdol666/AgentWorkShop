"""Assemble a clean source package for the current IEEE TII manuscript.

Only the current paper sources, referenced figures, and Supplementary File S6
are included. Historical experiment assets are deliberately excluded.
"""
from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "source-package-current-2026-10-31"

SECTIONS = [
    "introduction", "related", "system", "modules",
    "mechanisms", "evaluation", "discussion",
]
FIGURES = [
    "fig1-nature-A.pdf",
    "fig-architecture-2026-9pt.pdf",
    "fig-runtime-2026-9pt.pdf",
    "fig5-nature-A.pdf",
    "fig-objective-ratios-current-run.pdf",
    "fig-bopet-integration-trace.pdf",
]
COPY_PLAN: list[tuple[str, str]] = (
    [
        ("main.tex", "main.tex"),
        ("main.pdf", "main.pdf"),
        ("main.bbl", "main.bbl"),
        ("REPRODUCIBILITY.md", "REPRODUCIBILITY.md"),
        ("Supplementary-File-S6.tex", "Supplementary-File-S6.tex"),
        ("Supplementary-File-S6.pdf", "Supplementary-File-S6.pdf"),
        ("Supplementary-File-S6-Evidence.zip", "Supplementary-File-S6-Evidence.zip"),
    ]
    + [(f"sections/{name}.tex", f"sections/{name}.tex") for name in SECTIONS]
    + [("resources/refs.bib", "resources/refs.bib")]
    + [(f"resources/{name}", f"resources/{name}") for name in FIGURES]
    + [
        ("figures/build_current_run_figures.py", "figures/build_current_run_figures.py"),
        ("resources/current-run-data/p6-seeds.csv", "resources/current-run-data/p6-seeds.csv"),
        ("resources/current-run-data/bopet-trace.csv", "resources/current-run-data/bopet-trace.csv"),
        ("resources/current-run-data/README.md", "resources/current-run-data/README.md"),
    ]
)

README = """\
# IEEE TII manuscript — current integrated-run package

This clean package contains the current anonymous manuscript, the figures it
references, and Supplementary File S6 for the single integrated simulator run.
Older run data and inactive figure assets are excluded.

## Compile

    latexmk -pdf main.tex

`IEEEtran.cls` is vendored. The included PDFs are the verified manuscript and
supplementary build; `main.bbl` is provided for a single-pass reference build.

## Contents

- `main.tex`, `sections/`, `resources/refs.bib` — manuscript source
- `resources/*.pdf` — the six figures referenced in the paper
- `figures/build_current_run_figures.py` and `resources/current-run-data/` —
  source data and script for regenerating the two current-run result figures
- `Supplementary-File-S6.*` — the current-run supplement and selected evidence
- `REPRODUCIBILITY.md` — run conditions and evidence limits

The evidence bundle contains selected records from the latest integrated run;
it is not a runtime image and includes no physical-plant data.
"""


def vendor_ieeetran(destination: Path) -> None:
    try:
        cls_path = subprocess.run(
            ["kpsewhich", "IEEEtran.cls"], check=True,
            capture_output=True, text=True,
        ).stdout.strip()
    except (OSError, subprocess.CalledProcessError) as exc:
        raise SystemExit("Cannot locate IEEEtran.cls via kpsewhich.") from exc
    if not cls_path:
        raise SystemExit("kpsewhich did not return IEEEtran.cls.")
    shutil.copyfile(cls_path, destination)


def main() -> None:
    missing = [source for source, _ in COPY_PLAN if not (ROOT / source).is_file()]
    if missing:
        raise SystemExit("Missing current-package inputs: " + ", ".join(missing))
    if OUT.exists():
        raise SystemExit(f"Output directory already exists; choose a new path: {OUT}")

    for source, relative in COPY_PLAN:
        target = OUT / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / source, target)
    vendor_ieeetran(OUT / "IEEEtran.cls")
    (OUT / "README.md").write_text(README, encoding="utf-8")
    files = [path for path in OUT.rglob("*") if path.is_file()]
    total_bytes = sum(path.stat().st_size for path in files)
    print(f"package: {OUT}")
    print(f"files: {len(files)}")
    print(f"size: {total_bytes} bytes")


if __name__ == "__main__":
    main()
