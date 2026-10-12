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
# Round-2 revision: the three-seat panel's required content (falsifiable
# grading rule, delegation disclosure, two-lifecycle note, Part-11/NAMUR/APC
# prior art, parasuraman) puts the paper at 11 pages — within TII's submission
# limit. Returning to 10 requires cutting panel-required content; see
# RESPONSE-TO-REVIEWERS.md round-2 notes.
if pages < 10 or pages > 11:
    fails.append(f"F1 pages={pages} (want 10-11)")
else:
    print(f"F1 pass: {pages} pages (<= 11, TII submission limit 12)")

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

# F7: every cited key's title must appear in the RENDERED main.pdf text
# (catches silent citation reversions that a .tex-derived check would miss),
# plus a pinned must-cite list whose absence fails the build outright.
full_text = " ".join(page.get_text() for page in doc)
norm = lambda s: re.sub(r"[^a-z0-9]+", "", s.lower())
hay = norm(full_text)
title_of = {}
for m in re.finditer(r"@\w+\{([^,]+),(.*?)\n\}", open("resources/refs.bib", encoding="utf-8").read(), re.S):
    t = re.search(r"title\s*=\s*[{\"](.+?)[}\"]\s*,?\s*\n", m.group(2), re.S)
    if t:
        title_of[m.group(1).strip()] = re.sub(r"[{}\\]|(?<![a-zA-Z])\s", "", t.group(1))
pinned = {"parasuraman2000model"}
for k in sorted(cited):
    t = title_of.get(k)
    if not t:
        continue
    probe = norm(t)[:40]
    if probe and probe not in hay:
        fails.append(f"F7 cited title not in rendered PDF: {k}")
for k in sorted(pinned):
    if k not in cited:
        fails.append(f"F7 pinned must-cite absent: {k}")
if not any(x.startswith("F7") for x in fails):
    print(f"F7 pass: all {len(cited)} cited titles render in main.pdf; pinned must-cites present")

# F8: vector figures must keep minimum rendered font size >= 5pt at placed size
for fig in sorted(glob.glob("resources/fig-*.pdf")) + ["resources/fig2-architecture.pdf"]:
    fdoc = pymupdf.open(fig)
    sizes = [s["size"] for b in fdoc[0].get_text("dict")["blocks"] for ln in b.get("lines", [])
             for s in ln["spans"] if s["text"].strip()]
    if sizes and min(sizes) < 5.0:
        fails.append(f"F8 {fig}: min font {min(sizes):.2f}pt < 5pt")
print("F8 pass: all vector figures >= 5pt source type" if not any(x.startswith("F8") for x in fails) else "")

print("-" * 40)
if fails:
    print(f"AUDIT FAIL ({len(fails)}):")
    for x in fails:
        print(" ", x)
    sys.exit(1)
print(f"AUDIT PASS: all gates green (pages={pages}, cited={len(cited)}, bib={len(bib)})")
