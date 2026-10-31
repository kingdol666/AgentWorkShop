# IEEE TII Manuscript Package

Use the root `main.tex` as the active anonymous review source. The editor's
preview reflects the saved source; `main.pdf` may be an earlier export. The
paper presents AgentWorkShop as a modular task-to-device framework that
connects task adapters, production context, named operations, semantic I/O,
runtime checks, configured protocol drivers, and service-owned records. Its
central execution contract lets registered tasks and direct operation calls
share a dispatcher while retaining the evidence appropriate to each route.
Command receipts and later process observations are recorded as distinct
outcomes.

## Evaluation scope

The paper reports distinct evidence units rather than one pooled benchmark.
The latest deterministic protocol check uses five local simulator endpoints,
52 acquisition samples, and four write-capable protocol families; its
out-of-window probes were rejected. A separate model-backed OMP channel test
queried data and completed two bounded Modbus TCP writes on a cast-film twin.
Approval was issued by the test script, and process samples do not establish
optimization benefit. The paper also retains the September 28, 2026 simulator
missions for injection molding, A2O wastewater treatment, continuous annealing,
and BOPET film. Each is one deterministic, non-LLM trajectory; the BOPET line
was provisioned in a separate sub-run. These trajectories are not pooled into
a shared score. A separate October 26 onboarding replay checks one configured
simulated line, and an independent mock-driver test exercises stale
approval-context rejection.
Two further isolated simulator checks exercise a registered task and a direct
operation entry in two scenes, with synthetic approvals and single explicit
post-trial probes. Their records do not establish route equivalence or directly
trace both calls to the same handler.

All process readings are from configured local simulators, not physical plant
measurements. Each scenario has one trajectory; sequential observations are
not independent replications. The figure-data manifest records hashes of the
available logs and code, but a complete frozen run configuration is unavailable,
so exact replay is not established. Terminal tensile-strength and surface-defect
readings were not archived for annealing, and the complete terminal effluent
vector is unavailable for wastewater. The reported terminal hardness and
dissolved-oxygen values are separate from the last structured trajectory points.
The onboarding replay used a working-tree build that was not fully pinned.
The approval tests use simulated decisions and mock drivers; neither they nor
the four-scene logs measure human-review effectiveness. Other route checks are
retained only in the internal audit record.

- `sections/`: introduction, related work, system design, module functions,
  experimental evaluation, and discussion/conclusion.
- `resources/`: figures, figure data, and bibliography used by the paper.
- `figures/`: editable figure sources and generation scripts.
- `resources/figure-source-data/four-scenario-2026-09-28.json`: audited
  trajectory data and evidence boundaries; the companion CSV and manifest
  record plotted data and source hashes.
- `bench/results/20260928020612-1juc/` at the repository root: source
  mission logs. The contemporaneous consolidated report is at
  `bench/reports-archive/20260928-extended-final/benchmark-report.md`.
- `qa/onboarding-repro-2026-10-26-v083-online/`: the separate onboarding
  replay logs and service status. `tests/recipe-approval-snapshot.test.ts` and
  `tests/recipe-approval-context-ablation.test.ts` at the repository root
  provide the mock approval tests.
- `paper/tii/revision-2026-10-26/s1-staging/revision-2026-10-25/R21/` and
  `R22/` at the repository root: the separate registered-task and direct-entry
  logs, respectively; these use different isolated environments.
- `bench/results/20261029180436-1lo0/`: deterministic protocol and integrated
  simulator report used only for the protocol-provisioning and write-admission
  results in the paper.
- `docs/audit/evidence/2026-10-30-real-channel-mission/report.json` and
  `scripts/e2e-real-channel-mission.mjs`: assertion-level record and runner for
  the model-backed channel test; the runner scripted the approval decision.
- `Supplementary-File-S1.zip`: a separate historical evidence archive. It has
  not been updated to contain the September 28 mission logs and should not be
  treated as the evidence package for the current manuscript.

The active manuscript uses the two-column IEEEtran format.
Other historical software-integration records remain available for audit
traceability and are not additional findings in the manuscript.
