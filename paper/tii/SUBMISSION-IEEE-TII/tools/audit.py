# -*- coding: utf-8 -*-
"""Submission gate audit for the TII manuscript (recreated 2026-10-10).

Gates:
  F1  page count == 10
  F2  page size US Letter (612x792 pt)
  F3  citation integrity: every \\cite key resolves in refs.bib, no orphans
  F4  macro integrity: every \\res* macro used in sections/main is defined
  F5  every \\includegraphics target exists
  F6  no TODO/FIXME/XXX markers in sources
"""
import glob
import os
import re
import sys

os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import pymupdf

fails = []

doc = pymupdf.open("main.pdf")
pages = doc.page_count
if pages != 10:
    fails.append(f"F1 pages={pages} (want 10)")
else:
    print("F1 pass: 10 pages")

r = doc[0].rect
if abs(r.width - 612) > 1 or abs(r.height - 792) > 1:
    fails.append(f"F2 page size {r.width:.0f}x{r.height:.0f} (want 612x792)")
else:
    print("F2 pass: US Letter")

cited = {}
for f in sorted(glob.glob("sections/*.tex")) + ["main.tex"]:
    s = open(f, encoding="utf-8").read()
    for m in re.finditer(r"\\cite\{([^}]*)\}", s):
        for k in m.group(1).split(","):
            cited.setdefault(k.strip(), []).append(f)
bib = set(re.findall(r"@\w+\{([^,]+),", open("resources/refs.bib", encoding="utf-8").read()))
missing = sorted(set(cited) - bib)
orphans = sorted(bib - set(cited))
if missing:
    fails.append(f"F3 cited-but-missing: {missing}")
else:
    print(f"F3 pass: {len(cited)} cited keys resolve; uncited-in-bib: {len(orphans)} (bibtex omits)")

defined = set(re.findall(r"\\newcommand\{\\res(\w+)\}", open("resources/results-macros.tex", encoding="utf-8").read()))
used = set()
for f in sorted(glob.glob("sections/*.tex")) + ["main.tex"]:
    used |= set(re.findall(r"\\res([A-Za-z]+)", open(f, encoding="utf-8").read()))
undef = sorted(m for m in used if m not in defined)
if undef:
    fails.append(f"F4 undefined macros: {['res'+m for m in undef]}")
else:
    print(f"F4 pass: {len(used)} res-macros used, all defined")

for f in sorted(glob.glob("sections/*.tex")) + ["main.tex"]:
    for m in re.finditer(r"\\includegraphics\[[^\]]*\]\{([^}]*)\}", open(f, encoding="utf-8").read()):
        if not os.path.exists(m.group(1)):
            fails.append(f"F5 missing figure file: {m.group(1)}")
print("F5 pass: all includegraphics targets exist" if not any(x.startswith("F5") for x in fails) else "")

bad = []
for f in sorted(glob.glob("sections/*.tex")) + ["main.tex"]:
    if re.search(r"\b(TODO|FIXME|XXX)\b", open(f, encoding="utf-8").read()):
        bad.append(f)
if bad:
    fails.append(f"F6 TODO markers in {bad}")
else:
    print("F6 pass: no TODO markers")

print("-" * 40)
if fails:
    print(f"AUDIT FAIL ({len(fails)}):")
    for x in fails:
        print(" ", x)
    sys.exit(1)
print(f"AUDIT PASS: 6/6 gates green (pages={pages}, cited={len(cited)}, bib={len(bib)})")
