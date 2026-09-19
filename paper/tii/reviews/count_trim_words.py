#!/usr/bin/env python
"""Per-file prose word deltas, counting *deleted* and *added* words directly
from the word-level diff, so the numbers reconcile with the printed diff.
"""
from __future__ import annotations

import difflib
import pathlib
import re

TII = pathlib.Path(__file__).resolve().parent.parent
FILES = ["introduction.tex", "related.tex", "system.tex", "mechanisms.tex",
         "evaluation.tex", "discussion.tex", "main.tex"]


def deep(text: str) -> list[str]:
    text = re.sub(r"(?<!\\)%.*", "", text)
    text = re.sub(r"\\[a-zA-Z]+\*?", " ", text)
    text = re.sub(r"[{}~]", " ", text)
    return re.sub(r"\s+", " ", text).split()


print(f"{'file':<18}{'deleted':>9}{'added':>8}{'net':>8}")
cut_total = 0
add_total = 0
for name in FILES:
    before = deep((TII / ".bak-pre11" / name).read_text(encoding="utf-8"))
    path = TII / ("main.tex" if name == "main.tex" else "sections/" + name)
    after = deep(path.read_text(encoding="utf-8"))
    deleted = added = 0
    for tag, i1, i2, j1, j2 in difflib.SequenceMatcher(None, before, after).get_opcodes():
        if tag == "delete":
            deleted += i2 - i1
        elif tag == "insert":
            added += j2 - j1
        elif tag == "replace":
            deleted += i2 - i1
            added += j2 - j1
    cut_total += deleted
    add_total += added
    print(f"{name:<18}{deleted:>9}{added:>8}{added - deleted:>8}")
print(f"{'TOTAL':<18}{cut_total:>9}{add_total:>8}{add_total - cut_total:>8}")
