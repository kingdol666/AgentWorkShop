# Bench driver v2 migration — 2026-10-26

## What changed

The multi-scenario benchmark no longer writes directly to DCW nodes. Under permission
model v2, direct node writes are rejected; the harness now uses the recipe face:

- `bench/lib/scenarios.mjs`
  - binds the active **recipe** to the tool agent (`kind='recipe'`), then switches that
    binding to `auto` with `confirm:true`;
  - binds DAQ nodes separately for read-only observation;
  - switches the isolated line to `controlMode='auto'` for unattended benchmark runs
    (the line's four-layer write limits and runtime gate still apply);
  - replaces `dcw_control` + `dcw_judge` with `recipe_trial` batch trials and
    post-trial re-measurement;
  - creates benchmark recipes with `opIntervalMs: 0` (deterministic offline run) and
    documents the `AW_TRIAL_INTERVAL_MS=0` platform prerequisite;
  - reads DAQ samples with an explicit recent `from`/`to` window (without it, a reused
    line returns the oldest limit points and the controller appears unresponsive);
  - isolates the biax plant engine by `id` instead of replacing the whole plant config,
    so the four scenarios can run in parallel without stopping each other's engine.
- `bench/lib/biax.mjs`: same recipe_trial migration and recent-window read.
- `bench/lib/closedloop.mjs`: recent-window read for the reusable closed-loop helper.
- `bench/lib/scenario-report.mjs`: report columns now show the trial batch instead of the
  retired optimization-record/judge pair.

## Verification runs

Runs were executed on an isolated platform (`AW_HOME=D:/tmp/aw-bench-home`, port 3001,
`AW_TRIAL_INTERVAL_MS=0`) with the PLC simulator on port 4010.

| Run | Writes (inj/wwtp/anneal/biax) | Attained | Result |
| --- | --- | --- | --- |
| `20261026110116-1cio` | 1 / 1 / 1 / 1 | no | trial cadence still 300 s |
| `20261026110320-gwg` | 5 / 10 / 2 / 6 | no | stale DAQ samples (no window) |
| `20261026110954-ovw` | 8 / 9 / 6 / 6 | no | biax plantWhole replaced other engines |
| `20261026111620-29mg` | 3 / 11 / 2 / 6 | no | engines isolated; simulator PV mapping weak |

The migration is functionally complete: every trial is now accepted through the recipe
gate and produces a batch id. The remaining failure is **attainment**, not write refusal.

## Remaining red (honest)

After fixing the write path and the two harness bugs, the simulator's PV response does not
follow the scenario gain assumptions closely enough for the existing control targets
(for example injection part weight stays near 30 g after hold pressure reaches its 110 bar
ceiling; anneal hardness settles around 140 HV after the zone setpoints saturate). This is a
simulator blueprint/response-mapping calibration issue, not a platform governance defect.
The benchmark correctly exits non-zero and must not be reported as passing until the
simulator model is recalibrated or the scenario targets/gains are re-derived from measured
response curves.

## Reproduce

```bash
AW_HOME=<isolated-home> AW_TRIAL_INTERVAL_MS=0 PORT=3001 node .output/server/index.mjs
NO_PROXY=127.0.0.1,localhost \
  node bench/scenarios.mjs --base http://127.0.0.1:3001 \
  --no-autostart-platform --seed 45 --tool-harness opencode \
  --scenarios injection,wwtp,anneal,biax
```
