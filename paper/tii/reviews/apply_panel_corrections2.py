"""Finish the panel corrections: main.tex and related.tex (evaluation.tex already patched)."""
from __future__ import annotations

import pathlib
import re

TII = pathlib.Path(__file__).resolve().parent.parent


def squash(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def patch(text: str, old: str, new: str, tag: str) -> str:
    needle = squash(old)
    assert squash(text).count(needle) == 1, f"MISS/AMBIGUOUS: {tag}"
    pattern = re.compile(r"\s+".join(re.escape(w) for w in needle.split(" ")))
    match = pattern.search(text)
    assert match, f"REGEX MISS: {tag}"
    return text[:match.start()] + new + text[match.end():]


main = (TII / "main.tex").read_text(encoding="utf-8")
main = patch(
    main,
    r"The run passes 75 of 75 checks with no warnings or failures.",
    r"The run passes 75 of 75 checks with no warnings or failures, three of them carrying write "
    r"sub-checks skipped because their nodes expose no writable setpoint.",
    "abstract 75/75 qualifier",
)
main = patch(
    main,
    r"a second scenario rejects 9 of 9 hard-range probes without false blocks.",
    r"a second scenario rejects 9 of 9 out-of-constraint probes without false blocks.",
    "abstract probe wording",
)
main = patch(
    main,
    r"AgentWorkShop: Node-Native Integration of Multi-Agent Teams for Industrial Supervisory Control",
    r"AgentWorkShop: Node-Native Binding and Governed Write Paths for Agent Teams in Industrial "
    r"Supervision",
    "title",
)
main = patch(
    main,
    r"\markboth{Working Manuscript --- IEEE Transactions on Industrial Informatics Format}"
    r"{AgentWorkShop: Multi-Agent Industrial Supervisory Control}",
    r"\markboth{IEEE Transactions on Industrial Informatics, Submitted Manuscript}"
    r"{AgentWorkShop: Node-Native Binding and Governed Write Paths}",
    "running head",
)
(TII / "main.tex").write_text(main, encoding="utf-8")

rel = (TII / "sections" / "related.tex").read_text(encoding="utf-8")
rel = patch(
    rel,
    r"natural-language interfaces have controlled machines over OPC UA \cite{iec62541,hofmann2025nlc},",
    r"natural-language interfaces have controlled machines over OPC UA \cite{hofmann2025nlc},",
    "mis-citation",
)
(TII / "sections" / "related.tex").write_text(rel, encoding="utf-8")

print("main.tex and related.tex patched")
