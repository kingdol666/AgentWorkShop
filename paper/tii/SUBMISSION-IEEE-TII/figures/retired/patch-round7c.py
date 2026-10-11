# -*- coding: utf-8 -*-
"""Batch 4: final compression pass to close the last ~330pt."""
import io

def patch(path, pairs):
    s = io.open(path, encoding='utf-8').read()
    for old, new in pairs:
        if old in s:
            s = s.replace(old, new, 1)
            print("OK  ", path, "|", old[:48].replace("\n", " "))
        else:
            print("MISS", path, "|", old[:48].replace("\n", " "))
    io.open(path, 'w', encoding='utf-8', newline='\n').write(s)

patch('sections/mechanisms.tex', [
    # Fig.2 caption defusal (actual current text)
    (r"""every step is journaled with actor attribution. The block labeled
``Governance Agent'' denotes these deterministic platform stages of
Section~\ref{sec:mech}---not a model-bearing agent---and the judge annotation
denotes the caller's verdict-tool invocation.}""",
     r"""every step is journaled with actor attribution. The block labeled
``Governance Agent'' denotes these deterministic platform stages, not a
model-bearing agent; the judge annotation is the caller's verdict-tool
invocation.}"""),
    # IV-A closing bounds sentence
    (r"""It bounds one parameter at a time; joint,
cross-variable windows live in the scenario guards. It is not a
physical safety certificate, and it bounds magnitude, not
intent: availability, binding state, and approval policy are checked
separately, and in-window but adverse sequences surface at judgment and
compensation (Section~\ref{sec:scenarios} reports two).""",
     r"""It bounds one parameter at a time; joint,
cross-variable windows live in scenario guards. It is not a
physical safety certificate, and bounds magnitude, not
intent: availability, binding state, and approval policy are checked
separately, and in-window but adverse sequences surface at judgment and
compensation (Section~\ref{sec:scenarios} reports two)."""),
    # IV-B interval params
    (r"""at the \emph{approval} instant of the preceding dispatched
write---pending, refused, or expired requests do not start the clock---keyed
by recipe identity across agents and persisted across restarts, so
alternating agent identities cannot reset the spacing; a coarser per-line
trial-cadence interval (default 300\,s), also restart-persistent, damps
back-to-back same-line trials from any origin.""",
     r"""at the \emph{approval} instant of the preceding dispatch---pending,
refused, or expired requests do not start the clock---keyed by recipe
identity and restart-persistent, so alternating agent identities cannot
reset it; a coarser per-line trial cadence (default 300\,s), also
restart-persistent, damps same-line trials from any origin."""),
    # IV-B hold-window qualifiers
    (r"""The hold installs only after
driver success, recipe-dispatch and rollback writes are exempt, zero disables
it, and both spacing windows are agent-origin only. \texttt{AW\_BENCH\_MODE=1} admits
harness-declared ablation arms on the manual route that relax the soft window
(the Stage-1 admission gate), the readback check, or the hold---the hard
engineering range is never bypassable.""",
     r"""The hold installs only after
driver success, recipe-dispatch and rollback writes are exempt, and both
windows are agent-origin only (zero disables). \texttt{AW\_BENCH\_MODE=1} admits
harness-declared ablation arms that relax the soft window, the readback
check, or the hold---the hard engineering range is never bypassable."""),
    # IV-C receipts
    (r"""Batch receipts carry a
per-parameter grade plus a summary, the
write journal stores the per-write grade, and the operations log records the
judgment at a severity that follows the worst parameter state.""",
     r"""Batch receipts carry a
per-parameter grade plus a summary; the write journal stores the per-write
grade, and the operations log records the judgment at worst-state
severity."""),
    # IV-E line master switch (small)
    (r"""to automatic requires an explicit, audited user-side
confirmation---agent identities hold no
binding-administration capability---so an agent cannot reclassify its own
writes as approval-free.""",
     r"""to automatic requires an explicit, audited user-side
confirmation---agent identities hold no
binding-administration capability, so an agent cannot reclassify its own
writes as approval-free."""),
])

patch('sections/system.tex', [
    (r"""Scenario reuse is bounded by an onboarding contract: the engineer declares a
blueprint of devices, signals, units, roles, and setpoints; a differential
``ensure'' pass creates missing devices, repairs drift, verifies connectivity,
and projects the blueprint into semantic nodes and a recipe; a channel is
built from the team template, and a mission supplies objective, guards,
response windows, and policy.""",
     r"""Scenario reuse is bounded by an onboarding contract: the engineer declares a
blueprint (devices, signals, units, roles, setpoints); a differential
``ensure'' pass creates missing devices, repairs drift, verifies
connectivity, and projects it into semantic nodes and a recipe; a channel is
built from the team template, and a mission supplies objective, guards,
response windows, and policy."""),
])

patch('sections/discussion.tex', [
    (r"""The threat model is a misbehaving or manipulated agent (wrong or hallucinated
proposals) inside an otherwise trusted platform and plant; the approval dialog,
admission re-checks, and journaling are the containment surfaces, and no
adversarial injection campaign is reported---that evaluation remains future
work; stolen credentials and compromised endpoints are the domain of
IEC~62443 \cite{iec62443-3-3,nist80082}.""",
     r"""The threat model is a misbehaving or manipulated agent (wrong or hallucinated
proposals) inside an otherwise trusted platform and plant; the approval dialog,
admission re-checks, and journaling are the containment surfaces, and no
adversarial injection campaign is reported (future work); stolen credentials
and compromised endpoints are the domain of IEC~62443
\cite{iec62443-3-3,nist80082}."""),
])

patch('main.tex', [
    (r"""\begingroup
\linespread{0.93}\scriptsize""",
     r"""\begingroup
\linespread{0.9}\scriptsize"""),
    (r"\enlargethispage{10\baselineskip}",
     r"\enlargethispage{11\baselineskip}"),
])
print("done")
