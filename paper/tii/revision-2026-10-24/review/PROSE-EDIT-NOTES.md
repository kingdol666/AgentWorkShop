# Prose revision — 2026-10-24

## Scope

The active manuscript is `SUBMISSION-IEEE-TII/main.tex`, identified by its
README and source/package history. Original assigned sources are preserved
under `../before/`. Changes cover Introduction, Related Work, System
Architecture, the mechanisms overview, Engineering Interpretation, and
Conclusion. No numerical result, equation, citation key, label, figure path,
float size, or experimental limitation was changed. `main.tex` is unchanged.

## Argument and paragraph roles

1. Introduction: industrial need → injection-molding example → three
   distinctions that an execution handoff must preserve → systems question
   → proposed contract → three contributions.
2. Related Work: plant-facing strategies → closest systems and overlapping
   mechanisms → execution/automation precedents → remaining integration
   problem. Undefined forward Q1/Q5 identifiers were removed here.
3. Architecture: task/observation inputs and candidate operations →
   production-scoped governance → semantic I/O → linked state/evidence.
   Analysis/modeling is identified as evidence for a proposer, with its
   unevaluated control-response scope retained.
4. Mechanisms: authority → command evidence → observation and decision.
5. Interpretation/Conclusion: profile/admission evidence → confirmation
   evidence → paired trajectories and retained recipe → bounded claim.

## Claim-to-evidence map

| Claim | Existing evidence | Status |
|---|---|---|
| Production-scoped authority is resolved by platform services | Inspected capabilities/profiles; current mock composition tests | Supported within implementation/test scope |
| Admission and readback serve different roles | Four-arm mock-driver ablation | Supported for exercised classes; no plant failure-rate estimate |
| Transport acceptance does not imply endpoint confirmation | Publish-only confirmation challenge | Supported for exercised route |
| Node and recipe routes retain distinct execution/observation records | Architecture/code inspection; Q4/Q6 archives | Supported within their separately stated interface eras |
| Recipe interventions can be linked to observed quality and retention | Q6 single scripted simulator trajectory | Supported as evidence linkage; comparative optimization is untested |
| Full current model-assisted plant control loop | No complete archived trajectory | Not claimed; limitation retained |

## Checks and limitations

`analyze_logic.py main.tex --motivation-thread --cross-section` ran with
exit 0. Its keyword rules still emit three warnings about missing gap,
conclusion response, and alignment. Manual reading finds an explicit
remaining integration problem and corresponding conclusion response; the
same script's motivation-thread map reports matched evidence and closed
claims. These warnings are heuristic observations, not failed IEEE rules.

`analyze_abstract.py main.tex` ran with exit 0 and reported 209 words within
its 150–250-word rule. Its sentence-pattern classification reports FAIL
despite the abstract's explicit method, numerical results and bounded
conclusion. The abstract was not rewritten merely to satisfy phrase
matching.

`prose-preservation-check.json` records line changes and anchor/math checks.
All mathematical expressions and citation keys are preserved. The
architecture overview's second redundant `fig:arch` callout was removed;
the first callout and the figure/label are retained. This accounts for that
file's unequal exact callout sequence. There are no removed citation keys
or labels.

Compilation and page count are intentionally delegated to the primary
agent, along with independent review after figure integration. This author
pass does not approve publication readiness.

## Second pass: page-budget concision

After Figure 1–2 integration, the primary agent's compile produced an
11th page containing only the final references. A second authorized author
pass removed 281 whitespace-delimited words from the five section files:
Introduction 67, Related Work 34, System Architecture 127, Mechanisms 25,
and Discussion/Conclusion 28. Repeated context/evidence summaries and
duplicated mechanism lists were compressed. Technical workflow steps,
three state roles, operator/protection boundaries, limitations, AI
disclosure, and all experimental evidence were retained.

The immediate pre-concision sources are in `before/pre-concision/sections`.
`prose-concision-check.json` compares that exact checkpoint to the second
pass. All numbers, mathematical expressions, cite/ref/eqref/label paths,
and complete figure blocks (including the primary agent's updated
captions) are unchanged. The primary agent owns the new compile and page
count; this file does not infer the result from word reduction.
