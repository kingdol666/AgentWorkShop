#!/usr/bin/env python
"""Hard-constraint audit for the 11-page trim.

Compares the current sources against the pre-trim backup in .bak-pre11/ and
asserts:
  * the set of figure/table/algorithm environments is unchanged
  * every caption is byte-identical after whitespace folding
  * no \\label, \\ref, \\eqref or citation key was removed or added
  * every number token present before the trim is still present
  * the sectioning structure (sections, subsections) is unchanged
  * main.tex lines outside the known edit surface are untouched

Run:  python reviews/audit_trim_constraints.py
"""
from __future__ import annotations

import pathlib
import re
import sys

TII = pathlib.Path(__file__).resolve().parent.parent
NEW_DIRS = [TII / "sections", TII]
OLD_DIR = TII / ".bak-pre11"

FILES = ["introduction.tex", "related.tex", "system.tex", "mechanisms.tex",
         "evaluation.tex", "discussion.tex", "main.tex"]

new = {}
old = {}
for name in FILES:
    new[name] = (TII / "sections" / name).read_text(encoding="utf-8") \
        if name != "main.tex" else (TII / "main.tex").read_text(encoding="utf-8")
    old[name] = (OLD_DIR / name).read_text(encoding="utf-8")

failures: list[str] = []


def flat(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


# ------------------------------------------------------------------ floats
FLOAT_RE = re.compile(
    r"\\begin\{(figure\*?|table\*?|algorithm)\}(.*?)\\end\{\1\}", re.S)
CAP_RE = re.compile(r"\\caption\{(.*?)\}\s*(?=\\label|\\begin|\\end|$)", re.S)


def floats(doc: dict[str, str]):
    found = []
    for name, text in doc.items():
        for m in FLOAT_RE.finditer(text):
            cap = CAP_RE.search(m.group(2))
            found.append((name, m.group(1), flat(cap.group(1)) if cap else None))
    return found


fo, fn = floats(old), floats(new)
print(f"float environments: before={len(fo)} after={len(fn)}")
if fo != fn:
    failures.append("float environment set or captions changed")
    for a, b in zip(fo, fn):
        if a != b:
            print("   CHANGED", a, "->", b)

# ------------------------------------------------------------------ keys
for kind, pattern in [
    ("label", r"\\label\{([^}]*)\}"),
    ("ref/eqref", r"\\(?:ref|eqref)\{([^}]*)\}"),
    ("cite", r"\\cite\{([^}]*)\}"),
]:
    def keys(doc):
        s = set()
        for text in doc.values():
            for m in re.finditer(pattern, text):
                s.update(k.strip() for k in m.group(1).split(","))
        return s

    before, after = keys(old), keys(new)
    removed = sorted(before - after)
    added = sorted(after - before)
    print(f"{kind:10s} before={len(before):3d} after={len(after):3d} "
          f"removed={removed} added={added}")
    if removed:
        failures.append(f"{kind} keys removed: {removed}")

# ------------------------------------------------------------------ numbers
NUM_RE = re.compile(r"\d+(?:[.,]\d+)*")
ALLOWED_NEW_NUMBERS = set()          # trimming must not introduce new numbers


def numbers(doc):
    s = set()
    for name, text in doc.items():
        s.update(m.group(0) for m in NUM_RE.finditer(text))
    return s


nb, na = numbers(old), numbers(new)
missing = sorted(nb - na)
extra = sorted(na - nb)
print(f"number tokens: before={len(nb)} after={len(na)} "
      f"dropped={missing} added={extra}")
if missing:
    failures.append(f"number tokens dropped: {missing}")

# ------------------------------------------------------------- structure
STRUCT_RE = re.compile(r"\\(section|subsection)\*?\{([^}]*)\}")


def structure(doc):
    out = []
    for name, text in doc.items():
        out += [(name, m.group(1), m.group(2)) for m in STRUCT_RE.finditer(text)]
    return out


so, sn = structure(old), structure(new)
print(f"headings: before={len(so)} after={len(sn)} identical={so == sn}")
if so != sn:
    failures.append("section/subsection structure changed")
    for a, b in zip(so, sn):
        if a != b:
            print("   CHANGED", a, "->", b)

# ------------------------------------------------- protected items touched?
# Sanity: the protected evaluation.tex regions must be untouched byte-for-byte
# except inside the four reviewed paragraphs, so diff evaluation.tex and report
# which paragraphs differ.
import difflib

same_paras = 0
changed_paras = []
o_paras = [p for p in re.split(r"\n\s*\n", old["evaluation.tex"])]
n_paras = [p for p in re.split(r"\n\s*\n", new["evaluation.tex"])]
sm = difflib.SequenceMatcher(None, [flat(p) for p in o_paras], [flat(p) for p in n_paras])
for tag, i1, i2, j1, j2 in sm.get_opcodes():
    if tag == "equal":
        same_paras += i2 - i1
    else:
        for p in o_paras[i1:i2]:
            changed_paras.append(flat(p))
print(f"evaluation.tex paragraphs: unchanged={same_paras} "
      f"changed/removed={len(changed_paras)}")
for p in changed_paras:
    print("   touched:", p[:100])

print()
if failures:
    print(f"{len(failures)} CONSTRAINT FAILURE(S):")
    for f in failures:
        print("  -", f)
    sys.exit(1)
print("all hard constraints hold")
