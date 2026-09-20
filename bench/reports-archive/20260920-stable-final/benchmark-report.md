# AW-IndustrialBench · Consolidated Benchmark Report

> **Overall: ALL LAYERS PASS** · seed 42 · git `1585948` · AgentWorkShop v0.7.43
> Generated 2026-09-20T10:10:39.728Z · platform http://127.0.0.1:3005 · simulator http://127.0.0.1:4011

## 1. Results by layer

| Layer | Run ID | Pass | Warn | Fail | Skip | Score | Verdict |
|---|---|---|---|---|---|---|---|
| Static audit (paper–code consistency) | `20260920095700-1e3s` | 3 | 0 | 0 | 0 | 100.0 / 100 | **PASS** |
| Integrated pipeline (17 phases, real nodes) | `20260920094610-to4` | 75 | 0 | 0 | 0 | 100 / 100 | **PASS** |
| Real-protocol layer (PLC simulator) | `20260920094335-1b5g` | 13 | 0 | 0 | 0 | 100.0 / 100 | **PASS** |
| E1a 4-arm governance ablation | `20260920094442-e1lite` | 4 | 0 | 0 | 0 | — | **PASS** |
| Full-system API survey (api-live-e2e) | `console` | 60 | 0 | 0 | 0 | — | **PASS** |

## 2. Real PLC node verification (plc-node-simulator, five protocols)

| Check | Result | Evidence |
|---|---|---|
| plc-0-simulator — Simulator ready + film-line preset | PASS | five-protocol devices: modbus-tcp, modbus-rtu, opcua, mqtt, http |
| plc-1-realpath — Five-protocol real connectivity (exported config → test-driver) | PASS | ✔ modbus-tcp live connect ok (30 ms) · ✔ modbus-rtu live connect ok (16 ms) · ✔ opcua live connect ok (17 ms) · ✔ mqtt live connect ok (16 ms) · ✔ http live connect ok (17 ms) |
| plc-2-closedloop — Real sampling + SP→PV physical closed loop + governed write on the live link | PASS | ✔ real Modbus TCP sampling: 9 points (~895 ms cadence) · ✔ real SP write 182℃ → HTTP 200 (25 ms, incl. Modbus transaction) · ✔ governance on the live link: 5/5 attacks rejected (200/400/150/188.1/175.9), legal 180 accepted · ✔ SP→PV physical closed loop converged to \|PV−182\|≤3℃ in 30 s (first-order inertia) · governed write 185℃ (read-back verified, register accepted) while PV frozen at 150℃ (out of window)  · ✔ independent monitoring layer raised the recipe-window alarm within 2 s (defense-in-depth: read-back closure does not cover process response) · time-series DB kept sampling during the loop: 40 points total |
| plc-4-fault — Link-fault & recovery drill (real TCP) | PASS | ✔ after the link break the driver failure was sensed by the main app (test-driver ok=false) · ✔ reconnected successfully after simulator restart (test-driver ok=true) |

All traffic in this layer runs over the real protocol stacks of the PLC node simulator (Modbus TCP and Modbus RTU, OPC UA, MQTT, HTTP; per-instance transport ports). The governed write path (SP write → interlock → physical model → DAQ read-back → F5 interdiction → F2 frozen-alarm) is exercised on the live link, not on mocks.

## 3. Closed-loop optimization on the cast-film twin (governed writes)

Offline optimum W* = 89.894 · 3/3 seeds converged · 6 governed writes · 0 rejected · ratio J/J* ∈ [0.966, 0.97] (mean 0.968)

- seed 42: J0 70.167 → Jend 86.845 · J/J* 0.966 · iters 2 · writes 2 · rejected 0
- seed 43: J0 68.608 → Jend 87.236 · J/J* 0.97 · iters 2 · writes 2 · rejected 0
- seed 44: J0 65.74 → Jend 87.08 · J/J* 0.969 · iters 2 · writes 2 · rejected 0

## 3b. AgentTeam optimization mission (task board → time-range data → governed writes → target attained)

A complete agent-team mission runs against a live line: the optimization goal is filed on the team task board and dispatched to the worker; the worker reads the recent acquisition window through its industrial tool surface (`daq_query` with `from/to/bucket` — time-series/Timescale semantics), computes the corrected setpoint, issues governed writes (`dcw_control`, each opening an auditable optimization record that is then judged), waits for the physical process to follow, verifies attainment against the target, and closes the task with a report artifact. The decision policy is deterministic (no LLM credentials required; the LLM variant is the optional P5), but every path it exercises — task board state machine, host tool bridge, governed write path, physical plant, parameter journal — is the production path.

| Mission check | Result |
|---|---|
| Goal filed on the task board and dispatched to the worker | PASS |
| Time-range data read via daq_query (from/to/bucket) | PASS |
| Governed parameter writes, each with an opened and judged record | PASS |
| Parameter journal shows Agent attribution for the writes | PASS |
| Final process value within tolerance of the optimization target | PASS |
| Task closed (lead dispatch → worker scripted completion → parent aggregation) | PASS |

Mission outcome: target 204.704 · final PV 204.700 · governed writes 1 (≤3) · verdict **ATTAINED**

## 3c. Biaxial (BOPET) full-line mission — nine devices, five protocols, multi-node tuning

The suite's most plant-realistic layer provisions the biaxially oriented film line by differential probe-and-provision (missing devices rebuilt, drifted signals repaired — never a bulk reset), commissions one whole line from real driver configs (9 devices, 49 signals: 30 writable setpoints + 19 acquisition points with process semantics exposed to the agent cards), and dispatches an AgentTeam objective of 25.0 ± 0.7 µm thickness. The worker rotates governed writes across 3 actuation nodes (cast-roll speed / MDO fast-roll / TDO rail over Modbus TCP + OPC UA), the physics follows through transport delay and first-order lag, and the mission closes with journal attribution on every write.

Mission outcome: governed writes 4 · distinct actuation nodes 3 · final thickness 25.48 µm vs target 25.0 ± 0.7 µm · verdict **ATTAINED** (hard gate green). Line profile and per-round trajectory: `Simulated production line profile` / `AgentTeam closed-loop tuning walkthrough` chapters in `bench/results/20260920094610-to4/report.md`; raw trail in `agentteam-biax.log`.

## 3d. Real-LLM agent closed loops — execution traces

_No real-LLM loop log in this run (P5/P5b run only with `--agent <harness>`). The deterministic AgentTeam mission trace is in `agentteam-mission.log`._

## 4. Cross-scenario portability (film-line, zero code changes)

Devices 5 · own lines 3/5 · sampling 5/5 · F5 interdicted 9/9 · false blocks 0 · **code changes 0**

## 5. E1a · 4-arm governance ablation (attribution evidence)

| Arm | Interception (per rep) | Window breaches executed | False blocks | Boundary | Write p50 (ms) |
|---|---|---|---|---|---|
| Full (interlock + readback + gate) | 6/6 / 6/6 / 6/6 | 0 | 0 | 9/9 | 140.7 / 110.6 / 141 |
| No interlock | 4/6 / 4/6 / 4/6 | 6 | 0 | 9/9 | 114.8 / 125.2 / 127.2 |
| No readback | 6/6 / 6/6 / 6/6 | 0 | 0 | 9/9 | 111.9 / 125.1 / 127.1 |
| Ungated (no approval gate) | 4/6 / 4/6 / 4/6 | 6 | 0 | 9/9 | 125.4 / 139.9 / 124.8 |

Reading: interception is provided by the batch-window interlock (Full and No-readback interdict all 6 attacks; removing the interlock lets the two window-class attacks execute and be journaled — attribution ≠ prevention). The hard range is structural: false blocks are 0 in every arm. Latency is statistically indistinguishable across arms.

## 6. Reproducibility matrix (machine verdicts)

### 6.1 This execution

| Comparison | Verdict |
|---|---|
| 20260914-baseline-run-e1lite-4arm vs 20260920094442-e1lite | **REPRODUCIBLE** |
| 20260914-baseline-run-plc-fx0 vs 20260920094335-1b5g | **REPRODUCIBLE** |
| pipeline: 20260920093330-md4 vs 20260920094610-to4 | **REPRODUCIBLE** |
| Gate selftest (tampered intercept must be rejected) | **PASS** |

### 6.2 Historical archive

Layer comparisons against the frozen 20260914 baseline and cross-run pairs: **43/46 REPRODUCIBLE**. The exceptions are disclosed, evidence-tagged, and none is a governance failure:

| Historical comparison | Verdict | Evidence-derived cause |
|---|---|---|
| 20260914-baseline-run-plc-fx0 vs 20260917100825-12ew | NOT REPRODUCIBLE | F2 freeze-alarm timing under heavy load (documented load jitter) |
| 20260914-baseline-run-plc-fx0 vs 20260918044645-1930 | NOT REPRODUCIBLE | F2 freeze-alarm timing under heavy load (documented load jitter) |
| 20260914-baseline-run-plc-fx0 vs bench-results-20260918045044-xi8 | NOT REPRODUCIBLE | F2 freeze-alarm timing under heavy load (documented load jitter) |

Note on comparators: `bench/compare.mjs` judges the layer tiers (plc / static / e1-lite) against the frozen baseline; applied to an integrated-pipeline `run.json` it yields an empty per-check table — 54 such vacuous files were excluded from the counts above (the manuscript's reproducibility section discloses this). Pipeline pairs are judged only by `bench/tools/compare-pipeline.mjs` (§6.1).

Judge-class metrics (interdiction/false-block rates, boundaries, attribution, SP read-back, static anchors, portability composition, ablation outcomes) must be **bit-identical** for a REPRODUCIBLE verdict; environment-class metrics (latencies, sample counts, wall time, biaxial write counts and final thickness) are recorded but never gated. See `bench/compare.mjs` and `bench/tools/compare-pipeline.mjs` for the judge contracts.

## 7. Method & environment

- Executed strictly per `bench/PIPELINE.md` §0 execution card: cold boot on an **isolated config root** (`AW_HOME`) — the pipeline auto-started both the platform and the PLC simulator; first-boot admin self-registration; resident instances on other ports were never touched (no single-instance contention).
- Determinism: all randomness from `--seed 42` (mulberry32); fixtures carry randomized tags; every run lands in `bench/results/<runId>` and is never overwritten.
- Environment caveat: a local proxy client (Clash/mihomo) intermittently saturates the Windows ephemeral port range (~16k TIME_WAIT), causing transient loopback connect failures; the harness absorbs these with bounded exponential-backoff retries. Retries re-read true server state and cannot fabricate results.

## 8. Reproduce

```bash
# isolated bench instance (own config root — resident instances untouched)
export NO_PROXY=127.0.0.1,localhost AW_BASE=http://127.0.0.1:3005
export AW_HOME="$PWD/../aw-bench-home" AW_MODE=home AW_BENCH_MODE=1 NUXT_SESSION_PASSWORD=aw-bench-isolated-2026
node bench/pipeline.mjs --profile integrated --seed 42 --cl-seeds 3   # integrated main battle
node bench/run.mjs --tier plc --seed 42                              # real-protocol layer
node bench/e1-lite.mjs --seed 42 --repeats 3                         # 4-arm ablation
node scripts/api-live-e2e.mjs                                        # full API survey
node bench/compare.mjs --baseline 20260914-baseline/run-plc-fx0 --b <plc-runId>
node bench/tools/compare-pipeline.mjs --a <pipeline-runId-A> --b <pipeline-runId-B>
```
