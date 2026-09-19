#!/usr/bin/env python
"""Confirm the ten protected revision items survive in both the LaTeX sources
and the rendered PDF text of the 11-page manuscript.

Each probe is matched against whitespace-stripped, unicode-folded, lowercased
text, so hard line wraps in the .tex sources and non-breaking spaces or
hyphenation in the PDF cannot produce a false miss.

Run:  python reviews/verify_protected_11pages.py
"""
from __future__ import annotations

import pathlib
import re
import sys

import fitz

TII = pathlib.Path(__file__).resolve().parent.parent
SECTIONS = TII / "sections"

SOURCES = {
    name: (SECTIONS / f"{name}.tex").read_text(encoding="utf-8")
    for name in ["introduction", "related", "system", "mechanisms", "evaluation", "discussion"]
}
SOURCES["main"] = (TII / "main.tex").read_text(encoding="utf-8")

PDF_RAW = "\n".join(page.get_text() for page in fitz.open(TII / "main.pdf"))


def norm(text: str) -> str:
    # Fold typography to ASCII, then drop whitespace *and* hyphens so that the
    # PDF's line-break hyphenation ("gover-nance") and the sources' hard wraps
    # cannot produce a false miss.  En/em dashes are folded to a single hyphen
    # first so that a range ("0.38--0.53" in LaTeX, "0.38-0.53" in the PDF)
    # normalises to the same string.
    text = text.replace("\u2013", "-").replace("\u2014", "-").replace("\u2212", "-")
    text = text.replace("\u2019", "'").replace("\u201c", '"').replace("\u201d", '"')
    text = text.replace("\\,", "").replace("~", " ")
    text = re.sub(r"[\s\u00a0\u2000-\u200b\u202f\u205f\u3000\ufeff-]+", "", text)
    return text.lower()


PDF = norm(PDF_RAW)
TEX = {name: norm(body) for name, body in SOURCES.items()}

# (item number, label, [(haystack, fragment), ...])
#   haystack is "pdf" or a .tex source name.
ITEMS: list[tuple[int, str, list[tuple[str, str]]]] = [
    (1, "Sec. IV Process-Parameter Mapping Layer subsection (sec:paramlayer) "
        "and the 'Seven mechanisms carry the integration model' preamble", [
        ("mechanisms", r"\subsection{Process-Parameter Mapping Layer}"),
        ("mechanisms", r"\label{sec:paramlayer}"),
        ("mechanisms", "Seven mechanisms carry the integration model"),
        ("pdf", "Process-Parameter Mapping Layer"),
        ("pdf", "Seven mechanisms carry the integration model"),
    ]),
    (2, "Sec. IV-G approval-object sentence", [
        ("mechanisms",
         "The approval object presented to the operator names the requesting "
         "member, the node, the requested value, the effective interval after "
         "intersecting node range, recipe window, baseline interval and product "
         "interval, and the remaining time."),
        ("pdf",
         "The approval object presented to the operator names the requesting "
         "member, the node, the requested value, the effective interval after "
         "intersecting node range, recipe window, baseline interval and product "
         "interval, and the remaining time."),
    ]),
    (3, "Sec. V-F film-break guard sentences and the 'fifth caveat' paragraph", [
        ("evaluation", "present in the mission harness"),
        ("evaluation", "leaving final readings of $0.04$, $-0.02$, and $-0.02\\,\\mu$m."),
        ("evaluation",
         "a negative thickness indicates that the plant model, not only the "
         "governance layer, bounds this result."),
        ("evaluation", "A fifth caveat concerns the mission layer."),
        ("pdf", "present in the mission harness"),
        ("pdf", "leaving final readings of 0.04, -0.02, and -0.02"),
        ("pdf",
         "a negative thickness indicates that the plant model, not only the "
         "governance layer, bounds this result."),
        ("pdf", "A fifth caveat concerns the mission layer."),
    ]),
    (4, "Sec. V-C frozen four-arm ablation paragraph and boundary-probe sentence", [
        ("evaluation", "A frozen four-arm ablation"),
        ("evaluation",
         "The same archive carries boundary probes one tenth of a unit either "
         "side of the window edge"),
        ("pdf", "A frozen four-arm ablation"),
        ("pdf",
         "The same archive carries boundary probes one tenth of a unit either "
         "side of the window edge"),
    ]),
    (5, "Sec. V-D scoring-bound sentence, gate, 0.38--0.53 defect range, seed 44", [
        ("evaluation", "Two features of that scoring bound the ratio."),
        ("evaluation", "The suite's gate is $J/J^{*}\\geq0.8$"),
        ("evaluation", "0.38--0.53"),
        ("evaluation", "Seed~44 shows the largest relative rise in defect rate."),
        ("pdf", "Two features of that scoring bound the ratio."),
        ("pdf", "The suite's gate is J/J"),
        ("pdf", "0.38--0.53"),
        ("pdf", "Seed 44 shows the largest relative rise in defect rate."),
    ]),
    (6, "Sec. V-E attainment caveat, mission check names, journal-query "
        "reconciliation", [
        ("evaluation", "This attainment is one archived observation"),
        ("evaluation", "biax-mission-multinode"),
        ("evaluation", "biax-mission-attained"),
        ("evaluation", "The journal query for the cast-speed node"),
        ("pdf", "This attainment is one archived observation"),
        ("pdf", "biax-mission-multinode"),
        ("pdf", "biax-mission-attained"),
        ("pdf", "The journal query for the cast-speed node"),
    ]),
    (7, "Sec. V-C check names line-$n$-io and port-$n$-*", [
        ("evaluation", "line-$n$-io"),
        ("evaluation", "port-$n$-*"),
        ("pdf", "line-n-io"),
        ("pdf", "port-n-*"),
    ]),
    (8, "Sec. V title, Table I caption, Table I layer 6", [
        ("evaluation", r"\section{Integrated Evaluation}"),
        ("evaluation", "Integrated evaluation results in archive $B$"),
        ("evaluation", "Closed-loop benchmark and scenario reuse"),
        ("pdf", "Integrated Evaluation"),
        ("pdf", "Integrated evaluation results in archive"),
        ("pdf", "Closed-loop benchmark and scenario reuse"),
    ]),
    (9, "main.tex title, running head, abstract skip clause", [
        ("main",
         "Node-Native Binding and Governed Write Paths for Agent Teams in "
         "Industrial Supervision"),
        ("main", "AgentWorkShop: Node-Native Binding and Governed Write Paths"),
        ("main",
         "three of them carrying write sub-checks skipped because their nodes "
         "expose no writable setpoint"),
        ("pdf",
         "Node-Native Binding and Governed Write Paths for Agent Teams in "
         "Industrial Supervision"),
        ("pdf",
         "three of them carrying write sub-checks skipped because their nodes "
         "expose no writable setpoint"),
    ]),
    (10, "limitation, boundary, and non-claim sentences across the manuscript", [
        ("main", "establish neither physical safety nor agent performance."),
        ("evaluation", "nothing here comes from physical hardware or human operators"),
        ("evaluation", "not a benchmark with an external oracle"),
        ("evaluation", "The evidence remains simulation-tier"),
        ("evaluation", "we claim none"),
        ("evaluation", "sets no worst-case recovery deadline"),
        ("discussion", "remain open"),
        ("discussion", "not a certified safety"),
        ("discussion", "carries prerequisites this paper does not discharge"),
        ("system", "they do not make storage or physical actuation transactional"),
        ("system",
         "Fast regulation and protection therefore remain with the plant controller"),
        ("mechanisms", "not a PLC emergency stop"),
        ("mechanisms", "an executable safety specification"),
        ("introduction", "claims reusable supervisory integration within the tested settings"),
        ("pdf", "establish neither physical safety nor agent performance"),
        ("pdf", "not a benchmark with an external oracle"),
        ("pdf", "The evidence remains simulation-tier"),
        ("pdf", "carries prerequisites this paper does not discharge"),
    ]),
]

failures: list[str] = []
checked = 0

for number, label, probes in ITEMS:
    print(f"item {number:>2}: {label}")
    for where, fragment in probes:
        checked += 1
        haystack = PDF if where == "pdf" else TEX[where]
        needle = norm(fragment)
        found = needle in haystack
        print(f"          {'OK  ' if found else 'MISS'} [{where:>10}] {norm(fragment)[:66]}")
        if not found:
            failures.append(f"item {number} ({label}): {where} miss -> {fragment!r}")

print()
print(f"checked {checked} protected probes across {len(ITEMS)} items")
if failures:
    print(f"{len(failures)} MISSING:")
    for item in failures:
        print("  -", item)
    sys.exit(1)
print("all 10 protected items present in sources and PDF")
