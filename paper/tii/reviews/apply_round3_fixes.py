"""Round-3 fixes: the text-only items both verification seats still demand.

R3 (systems) said it would move to Reject unless the next version (i) scopes the
Fig. 6 gate, (ii) specifies the HITL object, (iii) adds check-id traceability,
(iv) describes the process-parameter layer in Section IV, and (v) aligns the
summary layers with the body. (i) is done (figure regenerated, caption scoped).
This script does (ii)-(v) plus the residual items R1, R2 and the adversarial
seat listed as text-only.

Every archive fact asserted here was read directly from
bench/results/20260918043504-bdo/{run.json,report.md} or from the harness source.
"""
from __future__ import annotations

import pathlib
import re

TII = pathlib.Path(__file__).resolve().parent.parent
SECTIONS = TII / "sections"


def patch(text: str, old: str, new: str, tag: str) -> str:
    flat = re.sub(r"\s+", " ", text)
    needle = re.sub(r"\s+", " ", old).strip()
    assert flat.count(needle) == 1, f"MISS/AMBIGUOUS: {tag}"
    pattern = re.compile(r"\s+".join(re.escape(w) for w in needle.split(" ")))
    match = pattern.search(text)
    assert match, f"REGEX MISS: {tag}"
    return text[:match.start()] + new + text[match.end():]


mech = (SECTIONS / "mechanisms.tex").read_text(encoding="utf-8")

# (iv) The evaluated system has seven surfaces; Section IV described six.
mech = patch(
    mech,
    r"Six mechanisms carry the integration model: node connection and creation",
    r"Seven mechanisms carry the integration model: node connection and creation",
    "mechanism count",
)
mech = patch(
    mech,
    r"and recipe management and rollback (Section~\ref{sec:recipe}), plus the "
    r"cross-cutting HITL boundary (Section~\ref{sec:hitl}).",
    r"recipe management and rollback (Section~\ref{sec:recipe}), and the process-parameter "
    r"mapping layer (Section~\ref{sec:paramlayer}), plus the cross-cutting HITL boundary "
    r"(Section~\ref{sec:hitl}).",
    "mechanism list",
)

# (ii) The HITL object was the only mechanism without a specification. The fields
# and the timeout value are taken from the archived approval item.
mech = patch(
    mech,
    r"\subsection{Human-in-the-Loop Control}"
    r"\label{sec:hitl}"
    r"Human intervention attaches to concrete bindings and operations.",
    r"\subsection{Process-Parameter Mapping Layer}"
    r"\label{sec:paramlayer}"
    r"A parameter object projects a control node onto process meaning: it carries a key, a "
    r"unit, a baseline interval, a product interval and the active recipe window, and it "
    r"exposes no register, data type or driver-configuration field. A write through this "
    r"surface is bounded by the intersection of those four intervals, so an agent can reason "
    r"about a process quantity without seeing a transport address. The layer is an interface "
    r"over the control path of Section~\ref{sec:writepath} rather than a second gate: it "
    r"narrows the permitted interval and then enters the same admission checks."

    r"\subsection{Human-in-the-Loop Control}"
    r"\label{sec:hitl}"
    r"Human intervention attaches to concrete bindings and operations.",
    "parameter layer subsection",
)

# (ii) specify the approval object and the timeout, which the archive shows.
mech = patch(
    mech,
    r"An unbound member is rejected, and after approval the tool verifies that the binding "
    r"still exists before the request enters the controller.",
    r"The approval object presented to the operator names the requesting member, the node, the "
    r"requested value, the effective interval after intersecting node range, recipe window, "
    r"baseline interval and product interval, and the remaining time. An approval expires on "
    r"its timer, and an unanswered request resolves as denied.",
    "approval specification",
)

(SECTIONS / "mechanisms.tex").write_text(mech, encoding="utf-8")
print("mechanisms.tex: parameter layer + HITL specification")

ev = (SECTIONS / "evaluation.tex").read_text(encoding="utf-8")

# (v) The section and table are named "benchmark" while Section V-F denies that
# the suite has an external oracle.
ev = patch(ev, r"\section{Benchmark Evaluation}", r"\section{Integrated Evaluation}",
           "section title")
ev = patch(ev, r"\caption{Integrated benchmark results in archive $B$",
           r"\caption{Integrated evaluation results in archive $B$", "table caption")
ev = patch(ev, r"Closed-loop benchmark and portability & P6, P8, P8b & 9 & 22/22 &",
           r"Closed-loop benchmark and scenario reuse & P6, P8, P8b & 9 & 22/22 &",
           "layer name")

# (iii) name the archive checks instead of leaving them anonymous.
ev = patch(
    ev,
    r"Each writable stack rejects four engineering-range violations and two",
    r"The checks behind these numbers are the per-line integration checks "
    r"\texttt{line-$n$-io} in phase P3 and \texttt{port-$n$-*} in phase P8. "
    r"Each writable stack rejects four engineering-range violations and two",
    "check ids for protocol results",
)
ev = patch(
    ev,
    r"Every write cleared the gate shown in the figure,",
    r"Every write cleared the gate shown in the figure (checks \texttt{biax-mission-multinode} "
    r"and \texttt{biax-mission-attained}),",
    "check ids for the mission",
)

# Adversarial seat A3: three disclosed circularity residuals.
ev = patch(
    ev,
    r"The objective, the control law, and the reference $J^{*}$ are fixed properties of the "
    r"harness and the separately maintained simulator; the benchmark run does not derive them.",
    r"The objective, the control law, and the reference $J^{*}$ are fixed properties of the "
    r"harness and the separately maintained simulator; the run does not derive them. Two "
    r"features of that scoring bound the ratio. Its throughput and energy terms are evaluated "
    r"from the setpoints the controller issued rather than from measured values, because the "
    r"twin returns no independent reading for them, and the control law inverts the model's own "
    r"$h\propto N/v$ relation, so the plateau is structural. The suite's own gate is "
    r"$J/J^{*}\geq0.8$, so the reported value is not near a threshold.",
    "circularity residuals",
)

(SECTIONS / "evaluation.tex").write_text(ev, encoding="utf-8")
print("evaluation.tex: section rename, check ids, circularity residuals")
