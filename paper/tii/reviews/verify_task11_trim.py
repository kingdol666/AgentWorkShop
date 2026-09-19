#!/usr/bin/env python
"""Verify the 11 protected review-panel items and the hard trimming constraints
after the 12-page -> 11-page prose trim.

Matches against whitespace-stripped, hyphen-folded, lowercased text so that hard
line wraps in the .tex sources and hyphenation in the PDF cannot produce false
misses.  Run:  python reviews/verify_task11_trim.py
"""
from __future__ import annotations

import pathlib
import re
import sys

import fitz

TII = pathlib.Path(__file__).resolve().parent.parent
SECTIONS = TII / "sections"

NAMES = ["introduction", "related", "system", "mechanisms", "evaluation", "discussion"]
SOURCES = {n: (SECTIONS / f"{n}.tex").read_text(encoding="utf-8") for n in NAMES}
SOURCES["main"] = (TII / "main.tex").read_text(encoding="utf-8")
PDF_RAW = "\n".join(p.get_text() for p in fitz.open(TII / "main.pdf"))


def norm(text: str) -> str:
    text = text.replace("\u2013", "-").replace("\u2014", "-").replace("\u2212", "-")
    text = text.replace("\u2019", "'").replace("\u201c", '"').replace("\u201d", '"')
    text = text.replace("\\,", "").replace("~", " ").replace("\\%", "%")
    text = re.sub(r"[\s\u00a0\u2000-\u200b\u202f\u205f\u3000\ufeff-]+", "", text)
    return text.lower()


PDF = norm(PDF_RAW)
TEX = {n: norm(b) for n, b in SOURCES.items()}

ITEMS = [
    (1, "V-F film-break guard paragraph", [
        ("evaluation", "A film-break guard that reapplies the recipe baseline is present in the mission harness"),
        ("evaluation", "is not represented in archive $B$, which never entered that branch"),
        ("evaluation", "Three other archives entered it"),
        ("evaluation", "leaving $0.04$, $-0.02$, and $-0.02\\,\\mu$m"),
        ("evaluation", "A fourth archive collapsed without entering the branch"),
        ("evaluation", "a negative thickness indicates that the plant model, not only the governance layer, bounds this result"),
        ("pdf", "A film-break guard that reapplies the recipe baseline is present in the mission harness"),
        ("pdf", "leaving 0.04, -0.02, and -0.02"),
        ("pdf", "a negative thickness indicates that the plant model, not only the governance layer, bounds this result"),
    ]),
    (2, "V-F last-caveat mission-layer paragraph", [
        ("evaluation", "The last caveat concerns the mission layer."),
        ("evaluation", "Its starting thickness is a simulator residue rather than a pinned initial condition"),
        ("evaluation", "two archives sharing one harness hash and one seed, neither of them $B$"),
        ("evaluation", "both mission checks are recorded as warnings, no check failed, and the hard gate stayed green"),
        ("pdf", "The last caveat concerns the mission layer."),
        ("pdf", "two archives sharing one harness hash and one seed"),
        ("pdf", "both mission checks are recorded as warnings, no check failed, and the hard gate stayed green"),
    ]),
    (3, "V-F harness-hash caveats", [
        ("evaluation", "a hash over the nine harness modules"),
        ("evaluation", "The hash covers harness modules in the working tree"),
        ("pdf", "a hash over the nine harness modules"),
        ("pdf", "The hash covers harness modules in the working tree"),
    ]),
    (4, "V-C four-arm ablation + boundary probe", [
        ("evaluation", "A frozen four-arm ablation, archived separately (seed 42, three repetitions, commit \\texttt{d6c824d})"),
        ("evaluation", "The engineering range is therefore structurally enforced"),
        ("evaluation", "rejected where the window check is active, accepted where it is disabled, and no arm records a false block"),
        ("pdf", "A frozen four-arm ablation, archived separately"),
        ("pdf", "The engineering range is therefore structurally enforced"),
        ("pdf", "accepted where it is disabled, and no arm records a false block"),
    ]),
    (5, "V-E ten seed-42 runs sentence", [
        ("evaluation", "Across the ten archived seed-42 runs of the reference command that report a final thickness, seven reached the band and three did not"),
        ("evaluation", "Two of the ten carry unrelated failing checks in other phases."),
        ("pdf", "Across the ten archived seed-42 runs of the reference command that report a final thickness, seven reached the band and three did not"),
        ("pdf", "Two of the ten carry unrelated failing checks in other phases."),
    ]),
    (6, "V-C pointer to the parameter layer (must NOT say 'absent from Section IV')", [
        ("evaluation", "the layer is described in Section~\\ref{sec:paramlayer}."),
        ("pdf", "the layer is described in Section"),
    ]),
    (7, "V-D scoring-bound sentence, gate, 0.38--0.53, seed 44", [
        ("evaluation", "Two features of that scoring bound the ratio."),
        ("evaluation", "The suite's gate is $J/J^{*}\\geq0.8$"),
        ("evaluation", "0.38--0.53"),
        ("evaluation", "Seed~44 shows the largest relative rise in defect rate."),
        ("pdf", "Two features of that scoring bound the ratio."),
        ("pdf", "The suite's gate is J/J"),
        ("pdf", "0.38--0.53"),
        ("pdf", "Seed 44 shows the largest relative rise in defect rate."),
    ]),
    (8, "IV parameter-layer subsection, seven mechanisms, interval list, approval object", [
        ("mechanisms", "\\subsection{Process-Parameter Mapping Layer}"),
        ("mechanisms", "Seven mechanisms carry the integration model"),
        ("mechanisms", "it carries a key, a unit, a baseline interval, a product interval and the active recipe window"),
        ("mechanisms", "bounded by the intersection of node range, baseline interval, product interval and recipe window"),
        ("mechanisms", "The approval object presented to the operator names the requesting member, the node, the requested value, the effective interval after intersecting node range, recipe window, baseline interval and product interval, and the remaining time."),
        ("pdf", "Process-Parameter Mapping Layer"),
        ("pdf", "Seven mechanisms carry the integration model"),
        ("pdf", "The approval object presented to the operator names the requesting member"),
    ]),
    (9, "Fig. 6 caption keeps a working \\ref{sec:writepath}; no caption text changed", [
        ("evaluation", "\\caption{Scripted AgentTeam mission in archive $B$, reconstructed from"),
        ("evaluation", "(Section~\\ref{sec:writepath} sets out the recipe-application and heartbeat paths that bypass the window branch)"),
        ("pdf", "sets out the recipe-application and heartbeat paths that bypass the window branch"),
    ]),
    (10, "main.tex title, running head, abstract skip clause", [
        ("main", "Node-Native Binding and Governed Write Paths for Agent Teams in Industrial Supervision"),
        ("main", "AgentWorkShop: Node-Native Binding and Governed Write Paths"),
        ("main", "three of them carrying write sub-checks skipped because their nodes expose no writable setpoint"),
        ("pdf", "Node-Native Binding and Governed Write Paths for Agent Teams in Industrial Supervision"),
        ("pdf", "three of them carrying write sub-checks skipped because their nodes expose no writable setpoint"),
    ]),
    (11, "limitation / boundary / non-claim sentences", [
        ("main", "establish neither physical safety nor agent performance."),
        ("evaluation", "nothing here comes from physical hardware or human operators"),
        ("evaluation", "not a benchmark with an external oracle"),
        ("evaluation", "The evidence remains simulation-tier, and no"),
        ("evaluation", "we claim none"),
        ("evaluation", "sets no worst-case recovery deadline"),
        ("evaluation", "The suite is therefore not deterministic at the mission layer"),
        ("discussion", "it does not measure the effort to author a scenario"),
        ("discussion", "not a certified safety"),
        ("discussion", "carries prerequisites this paper does not discharge"),
        ("related", "we do not implement the complete procedural models of either standard"),
        ("system", "they do not make storage or physical actuation transactional"),
        ("system", "Fast regulation and protection therefore remain with the plant controller"),
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
        hay = PDF if where == "pdf" else TEX[where]
        ok = norm(fragment) in hay
        print(f"          {'OK  ' if ok else 'MISS'} [{where:>10}] {norm(fragment)[:64]}")
        if not ok:
            failures.append(f"item {number}: {where} miss -> {fragment!r}")

# ---- hard constraints -------------------------------------------------------
print("\nhard constraints")
PROTECTED_NUMBERS = [
    "75", "17", "37", "24/24", "0/4", "9/9", "0/3", "56", "33.135", "0.963", "0.972",
    "87.105", "87.027", "87.366", "86.921", "86.609", "86.975", "36.193",
    "49.883", "49.383", "49.317", "89.894", "204.704", "28.10", "26.62", "25.90",
    "25.68", "0.02", "0.68", "0.38", "0.53", "291.5", "268", "300", "120.161",
    "16", "14", "11", "200", "K=2", "600", "30", "5", "500", "0.04", "-0.02", "26",
    "0.8", "10", "7", "3",
]
number_misses = []
NUM_HAY = re.sub(r"[\s\u00a0\u2000-\u200b\u202f\u205f\u3000\ufeff]+", "", PDF_RAW)
NUM_HAY = NUM_HAY.replace("\u2212", "-").replace("\u2013", "-").replace("\u2014", "-")
for token in PROTECTED_NUMBERS:
    if token not in NUM_HAY:
        number_misses.append(token)
print(f"          {'OK  ' if not number_misses else 'MISS'} protected numerals all present"
      f" ({len(PROTECTED_NUMBERS)} checked)" + (f" missing={number_misses}" if number_misses else ""))

# no label/ref/cite/eqref removed vs the pre-trim snapshot
SNAP = TII / ".bak-task11"
PAT = re.compile(r"\\(label|ref|eqref|cite)\{([^}]*)\}")
def keys(text: str):
    out: list[str] = []
    for kind, body in PAT.findall(text):
        for k in body.split(","):
            out.append(f"{kind}:{k.strip()}")
    return out

removed_refs = []
for name in NAMES + ["main"]:
    snap = (SNAP / (f"{name}.tex" if name != "main" else "main.tex")).read_text(encoding="utf-8")
    before = keys(snap)
    after = keys(SOURCES[name])
    for k in set(before):
        if before.count(k) > after.count(k):
            removed_refs.append(f"{name}: {k} ({before.count(k)}->{after.count(k)})")
print(f"          {'OK  ' if not removed_refs else 'MISS'} no \\label/\\ref/\\cite/\\eqref removed"
      + (f" -> {removed_refs}" if removed_refs else ""))

# no new em-dashes in sources
dash_issues = []
for name in NAMES + ["main"]:
    snap = (SNAP / (f"{name}.tex" if name != "main" else "main.tex")).read_text(encoding="utf-8")
    if SOURCES[name].count("---") > snap.count("---"):
        dash_issues.append(name)
print(f"          {'OK  ' if not dash_issues else 'MISS'} no new em-dashes"
      + (f" -> {dash_issues}" if dash_issues else ""))

# refsec must not appear in the rendered PDF text
print(f"          {'OK  ' if 'refsec' not in PDF_RAW else 'MISS'} 'refsec' absent from PDF text")

# float / caption text unchanged vs snapshot
FLOAT_ENV = re.compile(r"\\begin\{(figure\*?|table\*?|algorithm|equation)\}(.*?)\\end\{\1\}", re.S)
cap_diff = []
for name in NAMES:
    snap = (SNAP / f"{name}.tex").read_text(encoding="utf-8")
    a = [norm(m.group(2)) for m in FLOAT_ENV.finditer(snap)]
    b = [norm(m.group(2)) for m in FLOAT_ENV.finditer(SOURCES[name])]
    if a != b:
        cap_diff.append(name)
print(f"          {'OK  ' if not cap_diff else 'MISS'} float/table/algorithm/equation bodies unchanged"
      + (f" -> {cap_diff}" if cap_diff else ""))

# section / subsection structure and titles unchanged vs snapshot
SEC = re.compile(r"\\(sub)*section\*?\{[^}]*\}|\\section\*?\{[^}]*\}")
sec_diff = []
for name in NAMES:
    snap = (SNAP / f"{name}.tex").read_text(encoding="utf-8")
    a = [norm(m.group(0)) for m in SEC.finditer(snap)]
    b = [norm(m.group(0)) for m in SEC.finditer(SOURCES[name])]
    if a != b:
        sec_diff.append(name)
print(f"          {'OK  ' if not sec_diff else 'MISS'} section/subsection structure and titles unchanged"
      + (f" -> {sec_diff}" if sec_diff else ""))

print()
print(f"checked {checked} protected probes across {len(ITEMS)} items")
hard = number_misses or removed_refs or dash_issues or cap_diff or sec_diff or ("refsec" in PDF_RAW)
if failures or hard:
    print(f"{len(failures)} protected MISSES")
    for f in failures:
        print("  -", f)
    sys.exit(1)
print("all 11 protected items present; all hard constraints satisfied")
