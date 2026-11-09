# Author-Side Simulated Review — 2026-11-03

> **2026-11-05 correction:** Statements in this historical review that
> describe all scripted endpoints as first in-band readings or interpret batch
> wall time as per-scene time to target have been superseded. See
> `REVISION-NOTES-2026-11-05.md` for the runner-based correction.

> **Status:** simulated peer review run by the authors to test the manuscript
> against IEEE TII expectations. It is **not** an IEEE decision, not a real
> reviewer report, and not calibrated against adjudicated outcomes. The five
> seats were executed as role-separated prompts; their agreement is a
> consistency signal, not evidence of independent review.

## Panel

| Seat | Perspective | Main concern |
|---|---|---|
| EIC | IEEE TII journal fit | industrial relevance, contribution, evidence level |
| R1 | Methodology | design, controls, statistics, reproducibility |
| R2 | Domain | agents, MCP/OPC UA/AAS, HITL, standards, prior work |
| R3 | Cross-disciplinary | control/safety, human-automation, deployment |
| DA | Devil's Advocate | strongest counter-argument, selective reporting, "so what" |

## Decision

**Major Revision.** The system and the reporting are credible, but the
original draft claimed an industrial-agent integration result while every
positive block used direct or scripted clients and the only live-agent
episodes issued zero governed writes. The statistics also treated clustered
technical repetitions as independent trials, and the E2 control was not
time-matched. These are fixable partly by rewriting and partly only by new
experiments.

## Consensus findings

### CRITICAL

1. **The agent claim was not supported by positive evidence.** The title,
   abstract, and Contribution 2 implied a working harness path. The only
   agent-mediated pilot produced zero governed writes. E5 was retained as a
   negative result; the title and abstract were reframed to governed setpoint
   writing for agent-proposed operations, with simulation in the title.
2. **E2 was not a controlled comparison.** C0 held for 60 s; C1 ran
   150.41–172.90 s with scenario-specific logic and stopped at its first
   in-band reading. The C0 seed-42 control began from residual state. The
   draft's McNemar test and exact intervals treated 15 clustered pairs as
   independent. The revision removes all p-values and intervals, reports the
   12 blueprint-matched pairs and the 15-run totals separately, and labels
   the block descriptive.
3. **E1 was a consistency check, not independent range validation.** The
   admissible and structural values were generated from the same configured
   min/max used by the guard, and simulator readback is an echo. The revision
   states both limits explicitly.
4. **E4 pseudo-replication.** 18 negative probes are six stimulus types ×
   three technical repetitions. Fisher/Holm tests were removed; the revision
   reports counts and names the stimulus type as the inferential unit.

### MAJOR

5. **Provenance contradicted "frozen snapshot."** The platform manifests
   record `da627d21`, but the experiment runners were added later in
   `40533741` and were uncommitted at execution. The revision says so and no
   longer calls the tree hermetic.
6. **C1 route mismatch.** E2 used `recipe_trial`, not the
   `optimization_explore` path described in Section IV. The revision discloses
   the route and does not present E2 as a test of the single-node path.
7. **E3 conflated two lifecycles.** The design table counted seven
   approval/authorization calls plus six production-guard calls as one block.
   The table now lists the seven route calls; the production guards remain in
   the E4 text.
8. **Cast-film exclusion rationale was wrong.** The excluded run failed a
   manifest/endpoint check, not a legal-corpus requirement. The revision
   states the actual reason and keeps its 24/24/20 values out of the totals.
9. **"Interlock" overclaimed safety.** Renamed to "process-window guard" in
   the paper and supplement, with benchmark-mode and mock-driver limits.
10. **HITL was not studied.** The term was removed from the claims; the
    approval pilot is a scripted route check, and the figure caption says so.
11. **"Five protocol families" inflated coverage.** The revision says five
    configured variants across four families (Modbus over TCP/RTU, OPC UA,
    MQTT, HTTP).
12. **Reproducibility note was stale.** `REPRODUCIBILITY.md` now points to the
    current S7 runs, records the uncommitted runner state, and lists the
    inference limits.

### MINOR

13. The related-work comparison table moved to Supplementary Table S7-I to
    keep the 10-page limit; the text points to it.
14. AI disclosure was broadened from "language editing" to language editing,
    code drafting, and figure preparation.
15. The conclusion no longer repeats inferential statistics; it reports the
    matched-pair and all-run counts.

## What was changed in this revision

- Title, abstract, keywords, PDF metadata, and contribution list reframed
  around governed setpoint writing and simulated evaluation.
- Evaluation section restructured into design → execution protocol → mapping
  → target-band → guard ablation → route checks → Agent pilot → scope.
- All invalid inferential statistics removed; descriptive counts and
  denominators retained.
- Five deviations disclosed: missing biaxial structural case, HTTP readback,
  crossed approval labels, cast-film exclusion, warm-started C0 seed 42.
- Goal-completion defect promoted from a one-line pilot note to a Discussion
  requirement: task completion must be a postcondition checked against an
  independent data plane.
- Related work adds runtime-enforcement and industrial security/safety
  standards citations; the comparison table moved to S7.
- Supplement updated with S7-I, the C1 route, the stopping endpoint, the
  warm-start disclosure, and the runner provenance.
- Reproducibility note replaced with the current evidence map.

## Residual gaps that require new experiments

These cannot be fixed by rewriting:

1. A live harness episode that issues at least one governed write and reaches
   its target band.
2. A time-matched C0/C1 comparison with a PID or rule baseline, fixed-horizon
   endpoints, and verified resets.
3. A cold-start deployment with independent onboarding.
4. An operator study for the approval route (decision accuracy, time,
   rationale sufficiency).
5. A context-change/revocation test for the four-layer admission path.

Until these exist, the paper is a simulation-based integration and guard
study. It should not be submitted as evidence of autonomous Agent control.
