# Paper-study evidence protocol (validator only)

**Implementation status:** the frozen-plan and offline evidence validator exist; a real, isolated AgentWorkShop/PLC-simulator acquisition adapter does not. The files in this directory cannot run an industrial experiment or create paper-ready measurements. The only execution adapter currently implemented is the explicitly non-qualifying synthetic fixture in `bench/paper-runner/`.

## What this component checks

`study.mjs init` freezes a plan and a balanced, deterministic within-scene order before acquisition. `study.mjs seal` hashes the expected episode records and preserves missing files as missing. `study.mjs verify` checks plan binding, file hashes, episode status, reset identity, registered source/configuration fingerprints, paired starting state, write-budget rules, source freshness, timestamps, sample cadence, horizon coverage, endpoint-window sample count, guard observations, and no-write contamination.

The protocol requires a fixed horizon aligned to the sample interval. Each scheduled sample has a registered jitter allowance smaller than half the interval, so two adjacent sample slots cannot be confused. Runner observation times and source acquisition times must both be strictly increasing. Stale or pre-reset samples, incomplete cadence, failed episodes, changed configuration/policy, or unmatched pairs make the study `NOT-QUALIFIED` while retaining the records.

The plan should be independently registered before the first outcome is observed. `registration.sha256` detects accidental changes but is not an immutable timestamp, trusted signature, or tamper-proof pre-registration service. The verifier also cannot authenticate that an originating service, simulator, driver, reset, or ledger actually produced the supplied records. A structurally consistent report therefore remains `STRUCTURALLY-CONSISTENT-SOURCE-UNVERIFIED` and is not a publication or causal-validity certificate.

## Offline software checks

From the repository root:

```powershell
node --test bench/paper-study/study.test.mjs
node --test bench/paper-runner/paired.test.mjs
```

These tests use temporary, synthetic records. They do not exercise the live platform, a PLC simulator, hardware, or the study acquisition pipeline.

## Missing before a paper experiment can run

The production adapter must fail closed unless it can independently verify the isolated platform and simulator process identities, complete source/build/configuration fingerprints, reset and initial-state evidence, a monotonic DAQ source clock, and a server-side write/driver ledger. It must collect both study arms at the same fixed horizon, preserve every planned and attempted episode, and refuse shared-service auto-start or reset. It must then export the exact `paper-study-*` records that this validator consumes and be independently reviewed before the output can be considered for a manuscript.

Until that adapter and source audit are complete, do not use a validator fixture, old unmatched C0/C1 run, or an incomplete live-Agent pilot as a matched process-control experiment.
