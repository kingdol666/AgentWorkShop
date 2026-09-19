#!/usr/bin/env python
"""Print exactly which prose sentences differ between .bak-pre11/ and now."""
from __future__ import annotations

import difflib
import pathlib
import re

TII = pathlib.Path(__file__).resolve().parent.parent
FILES = ["introduction.tex", "related.tex", "system.tex", "mechanisms.tex",
         "evaluation.tex", "discussion.tex", "main.tex"]


def deep(t: str) -> str:
    """Strip LaTeX markup so we diff prose, not line wrapping."""
    t = re.sub(r"(?<!\\)%.*", "", t)
    t = re.sub(r"\\(begin|end)\{[^}]*\}", " ", t)
    t = re.sub(r"\\label\{[^}]*\}|\\caption\{", " ", t)
    t = re.sub(r"\\[a-zA-Z]+\*?", " ", t)
    t = t.replace("{", " ").replace("}", " ").replace("~", " ")
    return re.sub(r"\s+", " ", t).strip()


for name in FILES:
    before = deep((TII / ".bak-pre11" / name).read_text(encoding="utf-8"))
    path = TII / ("main.tex" if name == "main.tex" else "sections/" + name)
    after = deep(path.read_text(encoding="utf-8"))
    if before == after:
        continue
    print("=" * 100)
    print(name)
    print("=" * 100)
    sm = difflib.SequenceMatcher(None, before.split(), after.split())
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == "equal":
            continue
        old_txt = " ".join(before.split()[i1:i2])
        new_txt = " ".join(after.split()[j1:j2])
        print(f"[{tag}]")
        if old_txt:
            print(f"  - {old_txt}")
        if new_txt:
            print(f"  + {new_txt}")
    print()
