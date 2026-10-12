# -*- coding: utf-8 -*-
"""Apply the review-driven revision batch as exact literal replacements.

Every replacement is verified to have matched exactly once; the script fails
loudly otherwise so a silent no-op cannot masquerade as a fix.
"""
import io, os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

EDITS = [
    # ---- evaluation.tex -------------------------------------------------
    ("sections/evaluation.tex",
     "identical counts and no false blocks); it isolates the window",
     "identical counts); it isolates the window"),

    ("sections/evaluation.tex",
     "phase, from preset loading against the offline optimum ($J^{*}=\\resJstar$)",
     "phase, from preset loading against the best grid point ($J^{*}=\\resJstar$)"),

    ("sections/evaluation.tex",
     "against\nthe offline reference $J^{*}=\\resJstar$---an exhaustive grid search over the",
     "against\nthe best grid point $J^{*}=\\resJstar$---an exhaustive grid search over the"),

    ("sections/evaluation.tex",
     "same simulator. The gap to unity is expected,\nas $J^{*}$ is an oracle with full\nmodel knowledge.",
     "same simulator, so $J^{*}$ is a lower\nbound on the true optimum and the gap to unity is expected."),

    ("sections/evaluation.tex",
     "compliance-cost index down from \\resWwtpCostStart{} to \\resWwtpCostFinal.",
     "effluent-guard compliance margin improving over the run."),

    ("sections/evaluation.tex",
     "\\emph{Write-evidence legs.} A dedicated suite verifies Sections~\\ref{sec:ack}",
     "\\emph{Write-evidence legs.} A dedicated seven-leg suite verifies Sections~\\ref{sec:ack}"),

    # ---- mechanisms.tex -------------------------------------------------
    ("sections/mechanisms.tex",
     "\\looseness=-1 The backstop is the platform's safety net for writes that no\nverdict has closed: it evaluates only open records---a caller's keep or\nrollback closes the record and stands the backstop down.",
     "\\looseness=-1 The backstop is a record-integrity check for writes that no\nverdict has closed---not an independent protection layer: it evaluates only\nopen records, and a caller's keep or rollback closes the record and stands it\ndown, so its availability is contingent on a verdict being recorded and on\nobservations continuing to arrive."),

    ("sections/mechanisms.tex",
     "and restores the record's baseline (the value preceding the write), the",
     "and restores the value preceding that write (one step; the admitted\nbaseline is not restored), the"),

    # C1 narrows the learned-feasibility claim and cites the safe-optimization class
    ("sections/mechanisms.tex",
     "(Fig.~\\ref{fig:hitl}a).",
     "(Fig.~\\ref{fig:hitl}a). The claim is only that a declared, versioned bound set\nis decidable and replayable by an audit, not that a learned feasibility model\ncannot be safe \\cite{garcia2015safe,sui2015safe}."),

    # ---- system.tex: cite A2A where it is named -------------------------
    ("sections/system.tex",
     "deployed through WebSocket, MCP, A2A, REST, CLI, or TUI entry points;",
     "deployed through WebSocket, MCP, A2A \\cite{a2a2025}, REST, CLI, or TUI entry points;"),

    # ---- related.tex: cite OPC UA where it is discussed -----------------
    ("sections/related.tex",
     "smart-factory plant of per-module LLM agents and tool servers",
     "smart-factory plant of per-module LLM agents and tool servers over OPC~UA \\cite{iec62541}"),
]

changed = []
for rel, old, new in EDITS:
    path = os.path.join(ROOT, rel)
    src = io.open(path, encoding="utf-8").read()
    n = src.count(old)
    if n != 1:
        print(f"ABORT  {rel}: pattern occurs {n} times, expected 1")
        print("       pattern:", old[:90].replace("\n", "\\n"))
        sys.exit(1)
    io.open(path, "w", encoding="utf-8", newline="").write(src.replace(old, new, 1))
    changed.append((rel, len(old.split()), len(new.split())))

print("applied %d edits" % len(changed))
tot_old = sum(a for _, a, _ in changed)
tot_new = sum(b for _, _, b in changed)
for rel, a, b in changed:
    print(f"  {rel:28} {a:4d} -> {b:4d} words")
print(f"  {'TOTAL':28} {tot_old:4d} -> {tot_new:4d} words")
