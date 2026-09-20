"""Rebuild the paper working tree after an accidental delete.

Two halves survived and are complementary:

  * `paper/tii` in git HEAD   -> the figure assets (publication/, gpt/) and the earlier draft
  * `paper/tii/SUBMISSION-IEEE-TII` -> this session's edited sources (main.tex + sections/)

This script takes the session sources as the base and pulls in only the figure assets the
sources actually reference, so the result is a clean, self-consistent tree.
"""
from __future__ import annotations

import hashlib
import json
import shutil
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

TII = Path(__file__).resolve().parent
SUB = TII / "SUBMISSION-IEEE-TII"

DOC = ["main.tex", "results-macros.tex", "refs.bib"]
SECTIONS = ["introduction", "related", "system", "mechanisms", "evaluation", "discussion"]

# assets live here after the git restore
FIGURES = [
    "publication/fig3-channel-loop.png",
    "publication/fig-agentteam-demo.png",
    "publication/fig2-architecture.pdf",
    "gpt/fig1-intro-tii.png",
]

copied: dict[str, str] = {}


def put(src: Path, rel: str) -> None:
    dst = TII / rel
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(src, dst)
    copied[rel] = hashlib.sha256(dst.read_bytes()).hexdigest()


def main() -> int:
    missing: list[str] = []
    for name in DOC:
        src = SUB / name
        if not src.is_file():
            missing.append(str(src))
            continue
        put(src, name)
    for name in SECTIONS:
        src = SUB / "sections" / f"{name}.tex"
        if not src.is_file():
            missing.append(str(src))
            continue
        put(src, f"sections/{name}.tex")
    for rel in FIGURES:
        src = TII / "figures" / rel
        if not src.is_file():
            missing.append(str(src))
            continue
        copied[f"figures/{rel}"] = hashlib.sha256(src.read_bytes()).hexdigest()

    if missing:
        print("MISSING:")
        for m in missing:
            print("  ", m)
        return 1

    (TII / "SOURCE-MANIFEST.json").write_text(
        json.dumps({"files": copied, "count": len(copied)}, indent=2) + "\n",
        encoding="utf-8")
    print(f"rebuilt working tree with {len(copied)} sources")
    for rel in sorted(copied):
        print("  ", rel)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
