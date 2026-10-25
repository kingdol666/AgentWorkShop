#!/usr/bin/env python3
"""Rebuild Fig. 5 from the archived four-scenario seed-42 record.

This invokes only the multi-scenario plotting routine from
make-evaluation-2026.py. Matplotlib writes the PDF/SVG/PNG and extracted source
data into this submission package; no simulator, service, or external figure
skill is contacted.
"""
from __future__ import annotations

import importlib.util
from pathlib import Path


HERE = Path(__file__).resolve().parent
PAPER = HERE.parent
RESOURCES = PAPER / "resources"
SOURCE_DATA = RESOURCES / "figure-source-data"
GENERATOR = HERE / "make-evaluation-2026.py"


def main() -> None:
    spec = importlib.util.spec_from_file_location("evaluation_figure_source", GENERATOR)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Cannot load figure source: {GENERATOR}")
    source = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(source)
    source.OUT = RESOURCES
    source.REV = SOURCE_DATA
    SOURCE_DATA.mkdir(parents=True, exist_ok=True)
    skill_root = Path.home() / ".codex" / "skills" / "nature-figure"
    source.missions(skill_root)
    print(f"Rebuilt {RESOURCES / 'fig-missions-controls.pdf'}")
    print(f"Preview: {RESOURCES / 'fig-missions-controls-preview.png'}")
    print(f"Source data and panel-alignment audit: {SOURCE_DATA}")


if __name__ == "__main__":
    main()
