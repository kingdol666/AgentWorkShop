# -*- coding: utf-8 -*-
"""Extend \\looseness=-1 to the longest paragraphs in the sections that do not
yet use it.

This is the one page-budget lever that cannot change what the paper claims: it
only asks IEEEtran to set a paragraph one line shorter. Capped so the text does
not become visibly loose, and skipped on any paragraph that already carries it.
"""
import io, os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TARGETS = ["sections/evaluation.tex"]
CAP = 4          # paragraphs to touch, total
MIN_CHARS = 600  # only long paragraphs

cands = []
for rel in TARGETS:
    src = io.open(os.path.join(ROOT, rel), encoding="utf-8").read()
    # paragraphs = blank-line separated blocks that begin with prose
    for blk in re.split(r"\n\s*\n", src):
        b = blk.strip()
        if len(b) < MIN_CHARS:
            continue
        if b.startswith(("\\begin", "\\end", "\\[", "\\caption", "%", "\\section", "\\subsection")):
            continue
        if "\\looseness" in b:
            continue
        if "\\includegraphics" in b or "\\toprule" in b:
            continue
        cands.append((rel, b))

cands.sort(key=lambda t: -len(t[1]))
chosen = cands[:CAP]
if not chosen:
    print("no candidates")
    sys.exit(0)

byfile = {}
for rel, b in chosen:
    byfile.setdefault(rel, []).append(b)

for rel, blocks in byfile.items():
    path = os.path.join(ROOT, rel)
    src = io.open(path, encoding="utf-8").read()
    for b in blocks:
        if src.count(b) != 1:
            print("ABORT: block not unique in", rel)
            sys.exit(1)
    for b in blocks:
        src = src.replace(b, "\\looseness=-1 " + b, 1)
    io.open(path, "w", encoding="utf-8", newline="").write(src)
    print(f"{rel}: +{len(blocks)} \\looseness=-1")
    for b in blocks:
        print("     ", b[:64].replace("\n", " "))
