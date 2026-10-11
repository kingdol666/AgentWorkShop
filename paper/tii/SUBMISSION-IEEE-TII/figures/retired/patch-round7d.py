# -*- coding: utf-8 -*-
"""Batch 5: final gap closer (~150pt)."""
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

patch('sections/discussion.tex', [
    (r"""One supervisory path carried four different jobs and a deployment-scale
campaign while keeping command closure, verdict, task state, and attainment
as separate records; relative to the nearest systems of
Section~\ref{sec:related}, the differentiator is not the LLM---a replaceable
strategy slot---but the production-scoped authority and evidence around its
writes: none of the six systems carries versioned production context, graded
acknowledgment, three-way consistency, and reversal through one path.""",
     r"""One supervisory path carried four different jobs and a deployment-scale
campaign with command closure, verdict, task state, and attainment kept as
separate records; against the nearest systems of Section~\ref{sec:related},
the differentiator is not the LLM---a replaceable strategy slot---but the
production-scoped authority and evidence around its writes, which none of
the six systems combines with reversal through one path."""),
])

patch('sections/mechanisms.tex', [
    (r"""Disagreement marks the record even when every grade is
verified.""",
     r"""Disagreement marks the record even when every grade verifies."""),
    (r"""so a scripted keep can coexist with a
missed objective. Verdict integrity therefore rests on attribution,
journaling, and operator review rather than platform enforcement: a
kept-but-marked record stays visible with its disagreement attached, and the
operations log raises parameter severity under alarm-rationalization practice
(Section~\ref{sec:limits}).""",
     r"""so a scripted keep can coexist with a
missed objective---verdict integrity rests on attribution, journaling, and
operator review: a kept-but-marked record stays visible with its
disagreement attached, and the operations log raises parameter severity
under alarm-rationalization practice (Section~\ref{sec:limits})."""),
    (r"""settings plus the typed SDK, so
team topology, bindings, and limits are data rather than code.""",
     r"""settings plus the typed SDK make team topology, bindings, and limits data
rather than code."""),
])

patch('sections/system.tex', [
    (r"""and an \emph{extensibility} plane admits plugins, drivers, agent tools, panels,
and SDK clients through sanctioned registration services. The decomposition makes
the framework reusable: scenario knowledge sits in
blueprints, signal maps, predicates, and driver configuration, not in team
scheduler, approval service, or persistence code;""",
     r"""and an \emph{extensibility} plane admits plugins, drivers, agent tools, panels,
and SDK clients through sanctioned registration services. Scenario knowledge
sits in blueprints, signal maps, predicates, and driver configuration---not
in team scheduler, approval service, or persistence code;"""),
])

patch('sections/evaluation.tex', [
    (r"""melt-temperature and pressure constraints---larger is better); each scenario
contributes one trajectory from
its seed-42 initial state: Q1--Q4 are single-trace case studies (each claim they probe
is checkable in the archived artifacts), and repeat evidence comes from Q5's
consecutive campaigns on the deployment tier---a different tier, not a re-run
of these traces.""",
     r"""melt-temperature and pressure constraints, larger better); each scenario
contributes one seed-42 trajectory: Q1--Q4 are single-trace case studies
(each claim they probe is checkable in the archived artifacts), and repeat
evidence comes from Q5's consecutive campaigns on the deployment tier---a
different tier, not a re-run of these traces."""),
    (r"""The final lens stresses the platform itself: the hardening pass made the
write path's evidence grading, the line master switch, and the
approval-anchored dispatch interval of Section~\ref{sec:mech} the explicit
test surface of the closed-loop, fine-tuning, and write-evidence scenarios
on the live multi-tenant instance of Section~\ref{sec:testbed}.""",
     r"""The final lens stresses the platform itself: the hardening pass made the
evidence grading, the line master switch, and the approval-anchored dispatch
interval of Section~\ref{sec:mech} the explicit test surface of the
closed-loop, fine-tuning, and write-evidence scenarios on the live instance
of Section~\ref{sec:testbed}."""),
    (r"""directly: the master switch refuses an unconfirmed manual-to-automatic
transition; a mock-acknowledged dispatch is promoted to readback-verified by
the verifier; a broker cut marks affected parameters unverified
while healthy siblings verify; a publish-only
endpoint stays unverified after three attempts; and on a manual-mode line an
approval-free binding's dispatch is intercepted into the queue, approval releasing all six parameters
device-verified. An API regression and a documentation-consistency
suite (which fails on any documented-count or version drift) close the
campaign.""",
     r"""directly: the master switch refuses an unconfirmed manual-to-automatic
transition; a mock-acknowledged dispatch is promoted to readback-verified;
a broker cut marks affected parameters unverified while healthy siblings
verify; a publish-only endpoint stays unverified after three attempts; and
on a manual-mode line an approval-free binding's dispatch is intercepted
into the queue, approval releasing all six parameters device-verified. An
API regression and a documentation-consistency suite (fails on any
documented-count or version drift) close the campaign."""),
    (r"""\resGoalFinal\,$\mu$m against a target the agent itself selected
($52.0\pm0.8$\,$\mu$m; proposer-chosen, not the scenario predicate),
saving a recipe with attributed, audit-logged authorship (\resGoalWall); the""",
     r"""\resGoalFinal\,$\mu$m against a proposer-chosen target
($52.0\pm0.8$\,$\mu$m, not the scenario predicate), saving a
recipe with attributed, audit-logged authorship (\resGoalWall); the"""),
    (r"""(green band); the square marks the terminal observation. The index counts
attainment-relevant writes only, not all governed writes (6 plotted of 15 for
the wastewater mission). Simulator observations under scripted policies.}""",
     r"""(green band); the square marks the terminal observation. The index counts
attainment-relevant writes only (6 plotted of 15 for wastewater). Simulator
observations under scripted policies.}"""),
    (r"""\caption{The governed optimization process for one corrective iteration
(harness-adjudicated approval): the trial-cadence window early-rejects the
proposal 69\,s before a human is involved; the re-proposal is raised as a
HITL card and released by structured approval (green segments: approval,
dispatch, verification); dispatch returns
readback-verified and the three-way check reads 65|65|65. Lower lane: the
fine-tuning scenario under the same 60\,s window.}""",
     r"""\caption{One corrective governed iteration (harness-adjudicated approval):
the trial cadence early-rejects the proposal 69\,s before a human is
involved; the re-proposal is raised as a HITL card and released by
structured approval (green segments: approval, dispatch, verification);
dispatch returns readback-verified and the three-way check reads 65|65|65.
Lower lane: fine-tuning under the same 60\,s window.}"""),
])
print("done")
