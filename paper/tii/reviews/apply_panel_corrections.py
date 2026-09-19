"""Apply the verified corrections from the five-seat blind review panel.

Each patch is a literal replacement with an assertion, so a silently missed
edit is impossible. Whitespace is normalised before matching because the LaTeX
source is hard-wrapped and a phrase may straddle a line break.

Only findings that were independently verified against the archive, the
harness source at the archived commit, or the figure scripts are applied here.
Suggestions that would require new experiments are recorded in the revision
note instead of being simulated in text.
"""
from __future__ import annotations

import pathlib
import re

TII = pathlib.Path(__file__).resolve().parent.parent
SECTIONS = TII / "sections"


def load(name: str) -> str:
    return (SECTIONS / name).read_text(encoding="utf-8")


def store(name: str, text: str) -> None:
    (SECTIONS / name).write_text(text, encoding="utf-8")


def squash(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def patch(text: str, old: str, new: str, tag: str) -> str:
    """Replace `old` (whitespace-insensitive) with `new`, exactly once."""
    flat = squash(text)
    needle = squash(old)
    assert needle in flat, f"MISS: {tag}"
    assert flat.count(needle) == 1, f"AMBIGUOUS: {tag} ({flat.count(needle)} hits)"
    # Rebuild the file with the replacement applied to the flattened region by
    # locating the original span through a whitespace-tolerant regex.
    pattern = re.compile(r"\s+".join(re.escape(w) for w in needle.split(" ")))
    match = pattern.search(text)
    assert match, f"REGEX MISS: {tag}"
    return text[:match.start()] + new + text[match.end():]


ev = load("evaluation.tex")

# ---------------------------------------------------------------- correctness
ev = patch(
    ev,
    r"it raises defect rate from 0.50--0.53\,\% to 0.62--0.72\,\% and lowers the composite objective.",
    r"it raises defect rate from 0.38--0.53\,\% to 0.62--0.72\,\% and lowers the composite "
    r"objective. Seed~44 degrades most in relative terms.",
    "defect range",
)

ev = patch(
    ev,
    r"$J$ is maximized. The plotted final point declines in all three seeds, because the "
    r"archived score $J_{\rm end}$ is the mean of the last two evaluations rather than the last one.",
    r"$J$ is maximized. Each marker is one measured evaluation, so the third is the last one "
    r"taken; it lies below the second because the second write raises defect rate. The archived "
    r"$J_{\rm end}$ is a separate statistic, the mean of the last two evaluations, and is not plotted.",
    "fig5 caption",
)

ev = patch(
    ev,
    r"The biaxial mission now carries a film-break guard that reapplies the recipe baseline in "
    r"that situation; archive $B$ never entered that branch.",
    r"A film-break guard that reapplies the recipe baseline was added to the mission after "
    r"archive $B$, which contains no such branch; the guard's trigger and its relation to the "
    r"rollback manager are not part of the evaluated revision. In a later run the guard fired "
    r"and the re-application did not restore thickness, so it detects and aborts rather than "
    r"recovers.",
    "film-break guard",
)

ev = patch(
    ev,
    r"Its nine hard-range probes are all rejected, its three legal writes accepted, and the "
    r"switch required no code change.",
    r"Its nine out-of-constraint probes, three node-range probes per writable line, are all "
    r"rejected and its three legal writes accepted, with no code change. That set exercises no "
    r"recipe-window branch, and the window branch is therefore covered by the first scenario only.",
    "scenario-2 probe set",
)

ev = patch(
    ev,
    r"measured at 16\,ms against an 800\,ms polling granularity, which times the polling path "
    r"rather than a human decision.",
    r"measured at 16\,ms, which times the approval polling path rather than a human decision.",
    "approval latency",
)

ev = patch(
    ev,
    r"Four properties bound the table's meaning.",
    r"Three properties bound the table's meaning.",
    "table caveat count",
)

ev = patch(
    ev,
    r"the seeds give up about $1.8$ points on defect quality and $4.4$ on screw-speed energy, "
    r"but gain about $3.2$ on line throughput,",
    r"at seed~42's final point the seeds give up about $1.8$ points on defect quality and $4.4$ "
    r"on screw-speed energy, but gain about $3.2$ on line throughput,",
    "J decomposition scope",
)

ev = patch(
    ev,
    r"An energy-for-throughput trade therefore dominates the gap, not a failure to reach thickness.",
    r"The gap therefore reflects the controller's restricted action set, which holds line speed "
    r"fixed, rather than a failure to reach thickness.",
    "trade wording",
)

ev = patch(
    ev,
    r"The shrinking gains ($1.48$, $0.72$, and $0.22\,\mu$m) and the three-write length are "
    r"properties of that configuration, not emergent behaviour.",
    r"The gains are $0.5$, $0.35$, and $0.3$, and both the shrinking response "
    r"($1.48$, $0.72$, and $0.22\,\mu$m) and the three-write length are properties of that "
    r"configuration, not emergent behaviour.",
    "gains vs deltas",
)

# ------------------------------------------------- reproducibility disclosure
ev = patch(
    ev,
    r"It is not independent replication and we claim no bit-identical repetition: check verdicts "
    r"and record states are deterministic, protocol latencies are not, and the two should not be "
    r"read as interchangeable.",
    r"A fifth caveat concerns the mission layer. Its starting thickness is a simulator residue "
    r"rather than a pinned initial condition, and later runs of the same command on the same host "
    r"reached different outcomes: two archives sharing one harness hash and one seed ended at "
    r"$25.68\,\mu$m and at $-0.02\,\mu$m$, the second with two warnings and the mission check "
    r"failed. The suite is therefore not deterministic at the mission layer, and the 75/75 gate "
    r"describes archive $B$ rather than a property of the system. Verdicts and record states are "
    r"deterministic within a run, protocol latencies are not, and the two should not be read as "
    r"interchangeable.",
    "reproducibility disclosure",
)

# ------------------------------------------- attribution claim reconciliation
ev = patch(
    ev,
    r"Ledger attribution was queried on the cast-speed node and returned the record with an "
    r"agent source.",
    r"The journal query for the cast-speed node returned the record with an agent source, which "
    r"is the parameter-ledger surface of Section~\ref{sec:port}; the separate mission check that "
    r"asserts journal attribution is the one recorded with an empty evidence array in "
    r"Section~\ref{sec:repro}.",
    "attribution reconciliation",
)

# ------------------------------------------------- the ablation the paper owes
ev = patch(
    ev,
    r"The process-parameter layer passes 4/4 checks:",
    r"A frozen four-arm ablation on the same API surface, archived separately in the "
    r"repository, shows what the write path contributes. With the full path, all six "
    r"window-class attacks are rejected; with the interlock disabled, or with the path ungated, "
    r"four of six are rejected and the remaining two execute at the driver while still being "
    r"journaled; disabling readback alone changes nothing in this arm. The batch-window "
    r"interlock, not the engineering range, is therefore the load-bearing governance check, and "
    r"attribution records what happened without preventing it. The ablation is a separate "
    r"archive with its own fingerprint and is not part of the 75 checks above. "
    r"The process-parameter layer passes 4/4 checks:",
    "governance ablation",
)

store("evaluation.tex", ev)

# ------------------------------------------------------------------- abstract
main = (TII / "main.tex").read_text(encoding="utf-8")
main = patch(
    main,
    r"The run passes 75\nof 75 checks with no warnings or failures.",
    r"The run passes 75 of 75 checks with no warnings or failures, three of them carrying write "
    r"sub-checks skipped because their nodes expose no writable setpoint.",
    "abstract 75/75 qualifier",
)
main = patch(
    main,
    r"a second scenario rejects 9 of 9 hard-range probes\nwithout false blocks.",
    r"a second scenario rejects 9 of 9 out-of-constraint probes without false blocks.",
    "abstract probe wording",
)
main = patch(
    main,
    r"AgentWorkShop: Node-Native Integration of Multi-Agent Teams\nfor Industrial Supervisory Control",
    r"AgentWorkShop: Node-Native Binding and Governed Write Paths\nfor Agent Teams in Industrial Supervision",
    "title",
)
(TII / "main.tex").write_text(main, encoding="utf-8")

# ------------------------------------------------------------------ related
rel = load("related.tex")
rel = patch(
    rel,
    r"natural-language interfaces have controlled machines over OPC UA\n\cite{iec62541,hofmann2025nlc},",
    r"natural-language interfaces have controlled machines over OPC UA \cite{hofmann2025nlc},",
    "mis-citation",
)
store("related.tex", rel)

print("all patches applied")
