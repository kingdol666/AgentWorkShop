# AW-IndustrialBench · Consolidated Benchmark Report

> **Overall: ALL LAYERS PASS** · seed 42 · git `e14645a` · AgentWorkShop v0.7.39
> Generated 2026-09-17T04:27:33.245Z · platform http://127.0.0.1:3001 · simulator http://127.0.0.1:4010

## 1. Results by layer

| Layer | Run ID | Pass | Warn | Fail | Skip | Score | Verdict |
|---|---|---|---|---|---|---|---|
| Static audit (paper–code consistency) | `20260917031435-i10` | 3 | 0 | 0 | 0 | 100.0 / 100 | **PASS** |
| Integrated pipeline (15 phases, real nodes) | `20260917041804-1ahw` | 61 | 0 | 0 | 0 | 100 / 100 | **PASS** |
| Real-protocol layer (PLC simulator) | `20260917042326-1fe4` | 13 | 0 | 0 | 0 | 100.0 / 100 | **PASS** |
| E1a 4-arm governance ablation | `20260917042424-e1lite` | 4 | 0 | 0 | 0 | — | **PASS** |
| Full-system API survey (api-live-e2e) | `console` | 60 | 0 | 0 | 0 | — | **PASS** |

## 2. Real PLC node verification (plc-node-simulator, five protocols)

| Check | Result | Evidence |
|---|---|---|
| plc-0-simulator — Simulator ready + film-line preset | PASS | five-protocol devices: modbus-tcp, modbus-rtu, opcua, mqtt, http |
| plc-1-realpath — Five-protocol real connectivity (exported config → test-driver) | PASS | ✔ modbus-tcp live connect ok (31 ms) · ✔ modbus-rtu live connect ok (17 ms) · ✔ opcua live connect ok (18 ms) · ✔ mqtt live connect ok (16 ms) · ✔ http live connect ok (17 ms) |
| plc-2-closedloop — Real sampling + SP→PV physical closed loop + governed write on the live link | PASS | ✔ real Modbus TCP sampling: 6 points (~895 ms cadence) · ✔ real SP write 182℃ → HTTP 200 (25 ms, incl. Modbus transaction) · ✔ governance on the live link: 5/5 attacks rejected (200/400/150/188.1/175.9), legal 180 accepted · ✔ SP→PV physical closed loop converged to |PV−182|≤3℃ in 21 s (first-order inertia) · governed write 185℃ (read-back verified, register accepted) while PV frozen at 150℃ (out of window)  · ✔ independent monitoring layer raised the recipe-window alarm within 2 s (defense-in-depth: read-back closure does not cover process response) · time-series DB kept sampling during the loop: 25 points total |
| plc-4-fault — Link-fault & recovery drill (real TCP) | PASS | ✔ after the link break the driver failure was sensed by the main app (test-driver ok=false) · ✔ reconnected successfully after simulator restart (test-driver ok=true) |

All traffic in this layer runs over the real protocol stacks of the PLC node simulator (Modbus TCP :16040, Modbus RTU, OPC UA, MQTT, HTTP). The governed write path (SP write → interlock → physical model → DAQ read-back → F5 interdiction → F2 frozen-alarm) is exercised on the live link, not on mocks.

## 3. Closed-loop optimization on the cast-film twin (governed writes)

Offline optimum W* = 89.894 · 3/3 seeds converged · 5 governed writes · 0 rejected · ratio J/J* ∈ [0.968, 0.969] (mean 0.969)

- seed 42: J0 70.417 → Jend 87.105 · J/J* 0.969 · iters 2 · writes 2 · rejected 0
- seed 43: J0 70.258 → Jend 87.028 · J/J* 0.968 · iters 2 · writes 1 · rejected 0
- seed 44: J0 65.792 → Jend 87.131 · J/J* 0.969 · iters 2 · writes 2 · rejected 0

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

Mission outcome: target 204.704 · final PV 204.6999969482422 · governed writes 1 (≤3) · verdict **ATTAINED**

## 4. Cross-scenario portability (film-line, zero code changes)

Devices 5 · own lines 3/5 · sampling 5/5 · F5 interdicted 9/9 · false blocks 0 · **code changes 0**

## 5. E1a · 4-arm governance ablation (attribution evidence)

| Arm | Interception (per rep) | Window breaches executed | False blocks | Boundary | Write p50 (ms) |
|---|---|---|---|---|---|
| Full (interlock + readback + gate) | 6/6 / 6/6 / 6/6 | 0 | 0 | 9/9 | 138.7 / 125.2 / 126.2 |
| No interlock | 4/6 / 4/6 / 4/6 | 6 | 0 | 9/9 | 124.5 / 139.1 / 123.3 |
| No readback | 6/6 / 6/6 / 6/6 | 0 | 0 | 9/9 | 111.3 / 124.5 / 127.5 |
| Ungated (no approval gate) | 4/6 / 4/6 / 4/6 | 6 | 0 | 9/9 | 118.2 / 122.9 / 124.2 |

Reading: interception is provided by the batch-window interlock (Full and No-readback interdict all 6 attacks; removing the interlock lets the two window-class attacks execute and be journaled — attribution ≠ prevention). The hard range is structural: false blocks are 0 in every arm. Latency is statistically indistinguishable across arms.

## 6. Reproducibility matrix (machine verdicts)

| Comparison | Verdict |
|---|---|
| 20260914-baseline-run-e1lite-4arm vs 20260916150036-e1lite | **REPRODUCIBLE** |
| 20260914-baseline-run-plc-fx0 vs 20260916145922-xac | **REPRODUCIBLE** |
| 20260914152838-fwg vs 20260916150300-15ns | **REPRODUCIBLE** |
| 20260914-baseline-run-e1lite-4arm vs 20260916153350-e1lite | **REPRODUCIBLE** |
| 20260914-baseline-run-plc-fx0 vs 20260916153223-vzo | **REPRODUCIBLE** |
| 20260914152838-fwg vs 20260916152242-51c | **REPRODUCIBLE** |
| 20260916150300-15ns vs 20260916152242-51c | **REPRODUCIBLE** |
| 20260914-baseline-run-e1lite-4arm vs 20260917033142-e1lite | **REPRODUCIBLE** |
| 20260914-baseline-run-plc-fx0 vs 20260917033030-wkk | **REPRODUCIBLE** |
| 20260916152242-51c vs 20260917032459-u8o | **REPRODUCIBLE** |
| 20260914-baseline-run-e1lite-4arm vs 20260917042424-e1lite | **REPRODUCIBLE** |
| 20260914-baseline-run-plc-fx0 vs 20260917042326-1fe4 | **REPRODUCIBLE** |
| 20260917041225-1bjc vs 20260917041804-1ahw | **REPRODUCIBLE** |
| Gate selftest (tampered intercept must be rejected) | **PASS** |

Judge-class metrics (interdiction/false-block rates, boundaries, attribution, SP read-back, static anchors, portability composition, ablation outcomes) must be **bit-identical** for a REPRODUCIBLE verdict; environment-class metrics (latencies, sample counts, wall time) are recorded but never gated. See `bench/compare.mjs` for the judge contract.

## 7. Method & environment

- Executed strictly per `bench/PIPELINE.md` §0 execution card: cold boot — the pipeline auto-started both the platform and the PLC simulator from a wiped data root (first-boot self-registration).
- Determinism: all randomness from `--seed 42` (mulberry32); fixtures carry randomized tags; every run lands in `bench/results/<runId>` and is never overwritten.
- Environment caveat: a local proxy client (Clash/mihomo) intermittently saturates the Windows ephemeral port range (~16k TIME_WAIT), causing transient loopback connect failures; the harness absorbs these with bounded exponential-backoff retries. Retries re-read true server state and cannot fabricate results.

## 8. Reproduce

```bash
export NO_PROXY=127.0.0.1,localhost AW_BASE=http://127.0.0.1:3001 AW_BENCH_MODE=1
node bench/pipeline.mjs --profile integrated --seed 42 --cl-seeds 3   # integrated main battle
node bench/run.mjs --tier plc --seed 42                              # real-protocol layer
node bench/e1-lite.mjs --seed 42 --repeats 3                         # 4-arm ablation
node scripts/api-live-e2e.mjs                                        # full API survey
```
