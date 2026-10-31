#!/usr/bin/env python3
"""Rebuild Fig. 6 from the archived four-scenario seed-42 record.

Thin entry point kept for the reproduce commands referenced in
REPRODUCIBILITY.md; the drawing implementation lives in
``make-missions-4x2.py`` and reads only the packaged source JSON.
"""
from __future__ import annotations

import importlib.util
from pathlib import Path

HERE = Path(__file__).resolve().parent
GENERATOR = HERE / "make-missions-4x2.py"


def main() -> None:
    spec = importlib.util.spec_from_file_location("missions_figure", GENERATOR)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Cannot load figure generator: {GENERATOR}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.build()
    print(f"Rebuilt {module.RESOURCES / 'fig-missions-controls.pdf'}")


if __name__ == "__main__":
    main()
