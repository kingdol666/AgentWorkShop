# Reproducibility Notes: Integrated Simulator Run

This note records the integrated execution reported in the current manuscript:
`bench/results/20261031034253-1dbo`.

## Run conditions

- Command: `node bench/pipeline.mjs --profile integrated --seed 42 --cl-seeds 3`
- Recorded source commit: `60fa983e`
- Reported measurements refer to this recorded source snapshot; they do not
  freshly validate the repository's current HEAD.
- Runtime: Node.js 24.19.0, Windows x64
- Simulator: deterministic local cast-film model
- Tool execution: deterministic adapter; language-model loop disabled
- Platform and simulator were already running; the run reused shared platform
  data and was not a cold-start commissioning test.

## Reported evidence

The machine-readable records are `run.json`, `summary.json`, `metrics.csv`,
`report.md`, and the two task logs in the run directory. Supplementary File S6
contains selected copies, the source data for the manuscript figure, and a
delivery-time hash manifest. The evidence ZIP is not a complete runtime image.

The run reports 76 passed checks, one warning, and no failed checks. All 17
phase gates passed; the warning is a check-level BOPET semantic-card warning
within P10. Five simulated protocol adapters in the primary cast-film
configuration yielded 54 acquisition samples. The four writable paths rejected
24/24 negative probes. Modbus RTU provided acquisition only and is excluded
from the write-probe denominator. Within the same run, a second scene
configuration returned 51 samples across five endpoints and rejected 9/9
probes across three writable paths; each writable route also logged one
accepted legal write, with no false block or code change recorded. This was an
in-run configuration check, not an independent deployment or repetition, and
it does not estimate a general false-block rate.

The simulator objective cases used fixed seeds 42, 43, and 44. Seed 43's
initial observation was inside the stopping region, so the run terminated at
zero iterations and writes; this is a zero-update case and provides no
iterative-convergence evidence. These are cases within one
pipeline execution, not independent deployments. The BOPET task reached its
configured target band after three scripted writes and the task board marked
it COMPLETED, but its associated parameter-change/optimization record remained open and
unjudged.

For the seeded objective benchmark, the runner defines $J_{end}$ as the mean
of the final two valid per-iteration scores, or the sole valid score when a
seed stops before a second score is available. The stored $J_{end}$ values
therefore differ from the final individual trajectory scores for seeds 42 and
44; both fields are retained in the evidence record and source table.

The run summary's 31.649 ms latency field is the unweighted arithmetic mean
of the four stored protocol-level p50 values, rather than a pooled median. The
manuscript and Supplementary File S6 report the protocol-specific summaries
separately. The run log does not retain exact per-protocol latency sample
counts or event-level timing observations, so latency comparisons are
descriptive only.

## Provenance and inference limits

The original run directory did not contain a run-time `SHA256SUMS` file. The
Supplementary File S6 manifest verifies the delivered copies and records
redactions; it does not prove that the runtime configuration was frozen at
execution. Asset counts in the captured platform profile include previously
existing shared state and are not counts provisioned by this run.

The evidence is limited to one deterministic simulator execution. It does not
test an active language-model loop, a conventional controller baseline, an
independent system-level repeat, or physical production equipment. It
therefore supports only the bounded integration and software-guard claims
stated in the manuscript.
