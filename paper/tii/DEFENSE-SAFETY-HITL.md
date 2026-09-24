# Defense: Safety Boundary / HITL / Agent Direct Operation of Plants

> **⚠️ 2026-09-24 红队裁决（REVIEW-ATTACK-SURFACE-20260924.md）：未经修订不得原样入文。**
> 五处可被反杀的让步：① "advisory" 与评测原文 "the write takes effect at the device" 直接矛盾；
> ② prompt-injection 句声称了无机制无实验的缓解（应改为 bounded-blast-radius 主张）；
> ③ HMI 对比句自认未测（应降为 hypothesis）；④ "staged, revocable trust tier" 实际只有
> manual/auto 二元标志（应改为 per-binding policy choice）；⑤ "the receiving device is an
> independent check" 超出驱动契约证据（Table I no-readback 臂 18/18 无差）。
> 另：de-arm 条款引用 Section sec:limits 但该局限清单并无此条，须先补入再引。
> 红队确认站得住的部分：无形式化保证自认、approval 非主要防线、approval 不预留区间/设备状态的复检机制。

Paper-ready LaTeX subsection + rebuttal crib sheet. All `\cite` keys verified to exist in
`SUBMISSION-IEEE-TII/resources/refs.bib`; all `\ref` labels verified
(`sec:limits`, `sec:writepath`, `sec:hitl`). Suggested placement: new subsection in
`sections/discussion.tex`, between "Validity and Reproducibility" and "Deployment
Boundaries" (the last paragraph deliberately hands off to Deployment Boundaries'
obligation list, so trim any resulting overlap there).

---

## LaTeX (insert as-is)

```latex
\subsection{Safety Positioning and Human Oversight}
\label{sec:safety-positioning}

The recurring objection to agent operation of plants---that a language-model
team should not ``take over'' production---targets a design \system{} does not
propose. Supervisory control above fast local regulation is an established
paradigm \cite{sheridan1978}, and autonomous experimentation systems have
already coupled language-model agents to physical equipment under programmatic
guardrails \cite{boiko2023autonomous}. In \system{}, fast regulation,
interlocks, and safety functions remain in the PLC; agent-originated setpoints
are advisory at the supervisory layer, the receiving device is an independent
check, and driver acceptance is recorded as its own evidence state rather than
implied by a successful call. What an agent team replaces is not the
controller but the hand at the engineering station: the same
propose--authorize--verify--record path a process engineer's setpoint change
already travels, made explicit and mandatory. The question raised by language
models in plants is therefore not whether proposals originate from a model,
but whether those proposals travel an engineered, bounded, and recorded path
or an ad-hoc one; the framework's contribution is the path.

Three properties bound what an agent can change. First, physical-write
authority is granted per member--node binding and is distinct from task
membership: joining a team confers no write capability by itself. Second,
every proposal is admitted against the intersection of the hard engineering
range with the baseline, active-product, and active-recipe limits
(Section~\ref{sec:writepath}), while driver availability, binding state, and
approval policy are checked separately, so no accepted value rests on a
single check. Third, an admitted value is not a completed action: actuation,
readback, process observation, a submitted verdict, and any compensation are
recorded as separate evidence states, and a verdict is never rewritten. A
write that travels this path is thus more constrained and more auditable
than the same change made through an HMI credential, which typically
enforces none of the per-action limits, readbacks, or attributed judgments.

None of this is a formal protection guarantee, and no such guarantee is
claimed: shielding, control-barrier functions, and simplex architectures
offer stronger specified properties where suitable models exist
\cite{alshiekh2018shielding,ames2017cbf,sha2001simplex} and remain compatible
overlays, whereas \system{} implements source-dependent checks and a
rule-based backstop in the spirit of ISA-18.2 and EEMUA-191
\cite{isa182,eemua191}. The design goal is not the elimination of failure but
its bounded, attributed recovery: the stored-policy backstop waits at least
120\,s before acting, evaluates at most every 30\,s, triggers only after
three returned points or averages leave the window, and runs recovery only
while fewer than two retained records are already rolled back, while
non-atomic execution and partially successful multi-node compensation are
treated as expected states rather than faults (Section~\ref{sec:limits}).
The residual safety case rests on the union of the governed layer with the
protections it explicitly does not replace: independent interlocks and any
required IEC~61511 safety instrumented functions stay in place
\cite{iec61511}, and least privilege, endpoint security, and IT/OT separation
remain deployment requirements \cite{iec62443-3-3,nist80082}.

Human oversight follows the same logic. The framework does not lean on the
approval dialog as its primary safeguard: binding scope, admission limits,
readback, and the backstop operate identically whether or not a human
approves, which bounds the damage that approval fatigue, automation bias, and
over-reliance can cause
\cite{bainbridge1983ironies,parasuraman2000model,leesee2004trust,parasuramanmanzey2010complacency}.
Approval is instead a policy variable set per binding---manual bindings
insert a timed approval wait, automatic bindings omit the wait but retain
every check (Section~\ref{sec:hitl})---so autonomy is a staged, revocable
trust tier rather than a default. An approval reserves neither the interval
nor the device state: binding validity and admission are re-checked at
execution, so a stale or manipulated approval cannot carry an out-of-scope
value to the device, and manipulation of the proposing source, including
prompt injection, is met with source-dependent checks at admission rather
than trust in message content
\cite{greshake2023injection,liu2024pinjection}. Oversight therefore consumes
not an alarm stream but the evidence record itself---proposal, limits in
force, readback, observation, and immutable verdict---which is the object an
approver, a reviewer, or an incident investigation inspects. The present
endpoint still lacks line-scoped approver authorization, and a production
deployment would additionally require fail-closed approval decisions,
segregation of duties, and alarm-path failure tests \cite{eemua191}; these
are deployment obligations on a stated path, not open questions about whether
agents may operate at all.
```

---

## Rebuttal crib sheet (response letters)

**Q1 "LLM agents must not directly operate production systems."**
Category error: nothing in the framework places a model in the control loop.
Fast regulation, interlocks, and safety functions remain in the PLC, and
agent-originated setpoints are advisory with device acceptance recorded as an
independent state. What the agent replaces is the hand at the engineering
station, and the path its proposal travels is strictly narrower than a
human's: per-binding write authority, range-intersection admission with
separate limit sources, mandatory readback, observation, immutable verdict,
and compensation. Supervisory optimization above regulatory control is
standard industrial practice; the new element is the proposer's identity,
which is precisely why the contribution is the governed path.

**Q2 "There is no formal safety guarantee."**
Correct, and claimed nowhere. Shielding, CBFs, and simplex architectures
provide stronger properties where models exist and remain compatible
overlays; this framework implements source-dependent checks and an ISA-18.2 /
EEMUA-191-style backstop with bounded cadence and capped concurrent
recoveries, treating non-atomic execution and partial compensation as
expected states. The safety case is the union: the governed layer plus
independent interlocks and any required IEC 61511 SIS, which the framework
explicitly does not replace.

**Q3 "An approval dialog is weak oversight (rubber-stamping)."**
Agreed, which is why approval is not the primary safeguard: binding scope,
admission limits, readback, and the backstop operate whether or not a human
approves, bounding the damage of fatigue and automation bias. Approval is a
per-binding policy variable (staged, revocable trust tier), an approval
reserves neither interval nor device state so it is re-validated at
execution, and oversight consumes a complete evidence record rather than an
alarm stream. Known gaps (line-scoped approver authorization, fail-closed
decisions, segregation of duties) are stated as deployment obligations.

---

## One claim to be ready to defend

The comparative sentence "more constrained and more auditable than the same
change made through an HMI credential" is the passage's strongest line. It is
phrased as a statement about typical HMI practice ("typically enforces none
of..."), not a measured benchmark; if pressed, defend it as a characterization
of conventional practice, and note the evaluation's probe results (every
configured out-of-window probe intercepted without blocking admissible writes)
as the framework-side evidence.
