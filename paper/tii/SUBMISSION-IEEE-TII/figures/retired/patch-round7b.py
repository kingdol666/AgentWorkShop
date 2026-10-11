# -*- coding: utf-8 -*-
"""Batch 3 compression patches (review round). Reports OK/MISS per pair."""
import io

def patch(path, pairs):
    s = io.open(path, encoding='utf-8').read()
    for old, new in pairs:
        if old in s:
            s = s.replace(old, new, 1)
            print("OK  ", path, "|", old[:50].replace("\n", " "))
        else:
            print("MISS", path, "|", old[:50].replace("\n", " "))
    io.open(path, 'w', encoding='utf-8', newline='\n').write(s)

# ---------- related.tex: II-A compact -----------------------------------
patch('sections/related.tex', [
    (r"""\looseness=-1 Agent-based manufacturing has long linked organizational roles to plant
capabilities \cite{leitao2009agentbased}; LLM-oriented industrial work now
spans PLC generation and verification
\cite{liu2026agents4plc}. The closest
systems, summarized in Table~\ref{tab:nearest}, target the control action
itself. MADE couples multi-modal perception to control generation with a
safety layer and human-in-the-loop (HITL) verification and scores the task
success of its generated updates; a persistent production-scoped write-evidence
path is not part of its reported design \cite{huang2026made}. K{\"o}hle et al.\ report
task resolution over a six-module smart-factory plant whose modules each run
an LLM agent and tool server \cite{koehle2026llmdriven}---an
architecture-feasibility result in which writes carry module-scoped skills;
versioned production context and a write-evidence chain are not reported.
Waseem et al.\ place pretrained LLMs \emph{inside} the control loop as
real-time controllers of a robotic serial line \cite{waseem2026pretrained};
\system{} occupies a deliberately different layer, above fast regulation, so
the roles are complementary. Lim and Kovalenko explore
resource capabilities in multi-agent manufacturing
\cite{lim2025llmenabled}, and Zhao et al.\ coordinate shop-floor task dispatch
\cite{zhao2026shopfloor}---both allocate
work among agents, whereas the present layer governs how an allocated proposal
reaches the plant and what evidence it leaves. A recent review frames agentic
AI's industrial value as safety-aware, explainable, HITL decision
support rather than autonomous control authority \cite{jiang2026agentic}; the
contribution here is the mechanism set and benchmark that make that
positioning concrete. Table~\ref{tab:nearest} characterizes each system as
reported in its publication.""",
     r"""\looseness=-1 Agent-based manufacturing has long linked organizational roles to plant
capabilities \cite{leitao2009agentbased}; LLM-oriented industrial work now
spans PLC generation and verification \cite{liu2026agents4plc}. The closest
systems, characterized in Table~\ref{tab:nearest}, target the control action
itself: MADE couples multi-modal perception to control generation with a
safety layer and HITL verification, scoring its own task success, with no
persistent production-scoped write-evidence path reported
\cite{huang2026made}; K{\"o}hle et al.\ resolve tasks over a six-module
smart-factory plant of per-module LLM agents and tool servers---writes carry
module-scoped skills, with no versioned production context or write-evidence
chain reported \cite{koehle2026llmdriven}; Waseem et al.\ place pretrained
LLMs \emph{inside} the control loop as real-time controllers of a robotic
line \cite{waseem2026pretrained}---\system{} occupies a deliberately
different layer, above fast regulation, so the roles are complementary; Lim
and Kovalenko explore resource capabilities across manufacturing agents
\cite{lim2025llmenabled} and Zhao et al.\ dispatch shop-floor tasks
\cite{zhao2026shopfloor}---both allocate work among agents, whereas this
layer governs how an allocated proposal reaches the plant and what evidence
it leaves. A recent review frames agentic AI's industrial value as
safety-aware, explainable, HITL decision support rather than autonomous
control authority \cite{jiang2026agentic}; the contribution here is the
mechanism set and benchmark that make that positioning concrete, and
Table~\ref{tab:nearest} characterizes each system as reported in its
publication."""),
])

# ---------- mechanisms: Fig.2 caption defusal (find actual text) --------
patch('sections/mechanisms.tex', [
    (r"""every step journaled with actor attribution. The block labeled
``Governance Agent'' denotes these deterministic platform stages of
Section~\ref{sec:mech}---not a model-bearing agent---and the judge annotation
denotes the caller's verdict-tool invocation.}""",
     r"""every step journaled with actor attribution. The block labeled
``Governance Agent'' denotes these deterministic platform stages, not a
model-bearing agent; the judge annotation is the caller's verdict-tool
invocation.}"""),
    (r"""members are interchangeable
across 14 engine adapters under preserved identity, and the runtime exposes
118 hot-reloadable settings plus the typed SDK, so team topology, bindings, and limits are data rather than code.""",
     r"""members are interchangeable
across 14 engine adapters under preserved identity, and 118 hot-reloadable
settings plus the typed SDK make team topology, bindings, and limits data
rather than code."""),
])

# ---------- evaluation: testbed + Q5 trims ------------------------------
patch('sections/evaluation.tex', [
    (r"""numbers come from committed per-run reports, ledgers, and timelines (October
7--8 campaign with hardened variant \texttt{-20261008045434}; October 9 runs
\resNovRuns; the Q1--Q4 snapshot is commit \resCommit{} of the same code
line---the Section~\ref{sec:mech} mechanisms are unchanged except the
acknowledgment grading and master switch, completed by the October hardening
pass), gathered under live load, not an idle system.""",
     r"""numbers come from committed per-run reports, ledgers, and timelines
(October 7--8 campaign on hardened variant \texttt{-20261008045434};
October 9 runs \resNovRuns); the Q1--Q4 snapshot is commit \resCommit{} of
the same code line, its Section~\ref{sec:mech} mechanisms unchanged except
the acknowledgment grading and master switch, completed by the October
hardening pass, gathered under live load, not an idle system."""),
    (r"""tight check, not equality by construction). The pacing window acts before
the human: in two runs the proposal is early-rejected by the trial cadence
and re-proposed \resNovCadenceReject{} later; only then is it raised as a
HITL card (named scheme, e.g., \resNovScheme; proposer reasoning;
per-parameter basis) and structured approval releases the dispatch, which
returns readback-verified (Fig.~\ref{fig:loop}).""",
     r"""tight check, not equality by construction). The pacing window acts before
the human: in two runs the proposal is early-rejected by the trial cadence
and re-proposed \resNovCadenceReject{} later; only then is the HITL card
raised (scheme, e.g., \resNovScheme; proposer reasoning; per-parameter
basis) and structured approval releases the readback-verified dispatch
(Fig.~\ref{fig:loop})."""),
    (r"""regimes: the October 7--8 runs descend the setpoint
ladder $66\!\rightarrow\!63$\,bar one governed step per run under converged
dead-band excitation; the October 9 runs answer a sagging mirror weight
(\resNovWeights) with a bounded zigzag step at dead-band
(\resNovZigzagFrom$\!\rightarrow\!$\resNovZigzagTo\,bar, verdict converged)
and corrective steps (\resNovCorrFrom$\!\rightarrow\!$\resNovCorrTo\,bar).""",
     r"""regimes: October 7--8 descends $66\!\rightarrow\!63$\,bar one governed
step per run under converged dead-band excitation; October 9 answers a
sagging mirror weight (\resNovWeights) with a bounded zigzag
(\resNovZigzagFrom$\!\rightarrow\!$\resNovZigzagTo\,bar, verdict converged)
and corrective steps (\resNovCorrFrom$\!\rightarrow\!$\resNovCorrTo\,bar)."""),
])

# ---------- discussion: VI-B + data availability ------------------------
patch('sections/discussion.tex', [
    (r"""and harness-adjudicated
approval---the HITL mechanism is asserted, but human decision latency and
quality are out of scope.""",
     r"""and harness-adjudicated
approval (human decision latency and quality out of scope)."""),
    (r"""and released with the code upon publication (the harness fingerprint in the
run headers is a truncated SHA-256 over the benchmark sources). AI assistants supported editing""",
     r"""and released with the code upon publication (run-header harness
fingerprints are truncated SHA-256 over the benchmark sources). AI
assistants supported editing"""),
])

# ---------- introduction trims ------------------------------------------
patch('sections/introduction.tex', [
    (r"""they are rebuilt for every new process, protocol, or agent framework, and the
rebuild is where duplicated drivers, ad-hoc permission checks, and logs that
cannot be tied back to a decision accumulate; a task state such as
\texttt{COMPLETED} can then coexist with a missed process objective.""",
     r"""they are rebuilt per process, protocol, and agent framework---duplicated
drivers, ad-hoc permission checks, logs untied to decisions---and a task
state such as \texttt{COMPLETED} can coexist with a missed process
objective."""),
    (r"""separate evidence records, so a completed task never stands in for a verified
process outcome. Nodes expose engineering quantities rather than register
addresses; one governed member--node binding path serves every client,
returning outcome, observation, and verdict as separate records, where
application-specific integration would duplicate drivers, permissions, and
logging per application. Fast regulation, certified protection, and the
choice of optimization algorithm remain outside the framework.""",
     r"""separate evidence records. Nodes expose engineering quantities rather than
register addresses; one governed member--node binding path serves every
client---outcome, observation, and verdict as separate records---where
application-specific integration would duplicate drivers, permissions, and
logging. Fast regulation, certified protection, and the choice of
optimization algorithm remain outside the framework."""),
    (r"""(Section~\ref{sec:eval}), with task state and objective attainment reported
separately throughout.""",
     r"""(Section~\ref{sec:eval}), task state and attainment reported separately
throughout."""),
])

# ---------- figures: last height pass -----------------------------------
patch('figures/make-admission-figure.py', [
    ("fig, ax = plt.subplots(figsize=(3.5, 1.64))",
     "fig, ax = plt.subplots(figsize=(3.5, 1.58))"),
])
patch('figures/make-missions-figure.py', [
    ("fig, axes = plt.subplots(2, 2, figsize=(3.5, 1.82))",
     "fig, axes = plt.subplots(2, 2, figsize=(3.5, 1.74))"),
])
patch('figures/make-process-figure.py', [
    ("fig = plt.figure(figsize=(3.5, 1.84))",
     "fig = plt.figure(figsize=(3.5, 1.76))"),
])
patch('sections/mechanisms.tex', [
    (r"\includegraphics[width=0.66\textwidth]{resources/aws_fig3-flat.png}",
     r"\includegraphics[width=0.6\textwidth]{resources/aws_fig3-flat.png}"),
])
print("done")
