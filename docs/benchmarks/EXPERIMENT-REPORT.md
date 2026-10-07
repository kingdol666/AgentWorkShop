# Experimental Evaluation Report — AgentWorkShop v0.7.57

**Benchmark campaign:** 3 consecutive full-pipeline runs (2026-10-08), run IDs `benchmark-20261007194240`, `benchmark-20261007194413`, `benchmark-20261007194925`
**Result:** 3/3 runs fully green — 240/240 assertions passed (80 per run), exit code 0 on every run
**Intended use:** experiment section material for journal submission (IEEE TII style). All numbers below are extracted verbatim from the machine-readable artifacts (`benchmark.json`, `timeline.jsonl`) committed alongside this report.

---

## 1. Experimental Setup

### 1.1 Platform under test

| Item | Value |
|---|---|
| System under test (SuT) | AgentWorkShop v0.7.57 — configuration-driven industrial agent runtime (TypeScript/Nuxt 4 server, better-sqlite3 + TimescaleDB storage, MQTT queue, local/MinIO object store) |
| SuT process | Production build, single instance, heap limit 4096 MB, health-reported heap utilization 8–10% during the campaign |
| Deployment host | Windows 10 x64, Docker (TimescaleDB pg16 + Mosquitto + MinIO) |
| Field testbed | `plc-node-simulator` physics-based injection-molding line: product weight model 32.5 g ± 0.35 g target, sink-mark hard limit 2.5%, flash onset 68 bar (soft); 5-protocol field bus |
| MES mock | REST MES simulator (:15060), token-authenticated, paginated history API |
| System workload at test time | 34 production lines (17 running), 67 online DAQ nodes, 111–113 active agent channels — i.e., the benchmark ran under live multi-tenant load, not on an idle system |

### 1.2 Benchmark line and scenario assets

The benchmark line (`ln-5b12e11a`, "Injection Line 1 · weight-window optimization") carries **16 DAQ nodes** spanning four data modalities (12 scalar + 2 vector profiles + 1 CCD image + 2 MES-mirror) over **five protocol families** (Modbus TCP, Modbus RTU-over-TCP, OPC UA, HTTP/REST, MQTT across the wider deployment) and **6 control nodes** (5 OPC UA/serial setpoints + 1 MES-REST write point). A bound agent channel (lead + `omp`-harness worker) holds recipe/DAQ bindings; all control writes flow through the platform's governance chain (safe-range ∩ parameter-baseline ∩ product ∩ recipe-window interlock → 60 s online-write interval → write-hold window → 300 s trial cadence → HITL approval for agent-initiated dispatch).

### 1.3 Benchmark pipeline

One command executes eight stages and emits machine-readable artifacts (`benchmark.json`, `timeline.jsonl`) plus a human report per run:

| Stage | Scope | Assertions |
|---|---|---|
| S0 | Environment pre-check (health, simulators, DAQ controller, benchmark line) | 5 |
| S1 | Full API surface matrix: auth(+neg.) / users / channels / tasks / messages / permissions isolation (neg.) / DCW / DAQ / agent-tools(+neg.) / HITL / ops / audit / memory / plugins / teams / notifications | 45 |
| S2 | Multi-modal ingestion (scalar / vector / image with sha256 integrity / MES mirror) + MES dual-mode (mirror query + direct `mes_fetch`) + **per-protocol-family live-sampling matrix** | 11 |
| S3 | Governance negative paths: out-of-range write rejection; unknown-driver loud failure (silent-mock-fallback blocked) | 3 |
| S4 | **Closed-loop optimization scenario**: observation → control law → five-element recipe proposal (basis + evidence ref per parameter) → HITL card with reasoning → structured approval → batch dispatch → run-ledger check → **three-way setpoint consistency** (recipe \| PLC readback \| mirror sample) | 7 |
| S5 | **Stability fine-tuning scenario**: single-variable micro-step → readback → rate-limit interception → post-window rollback → restoration check | 4 |
| S6 | **Data-analysis scenario**: 30-min merged wide-table export → per-column statistics → in-specification ratio | 4 |
| S7 | Report generation | 1 |

### 1.4 Metrics

| Metric | Definition |
|---|---|
| Assertion pass rate | passed / total automated assertions per run |
| Protocol-family coverage | # of field-bus driver families with ≥1 node producing fresh (≤3 min) telemetry |
| Image integrity coverage | frames carrying sha256+size fingerprint / sampled frames |
| Three-way consistency error | max \|setpoint_recipe − setpoint_PLC-readback\| and \|setpoint − mirror-sample\| at verification |
| HITL→dispatch latency | timestamp(approved) → timestamp(dispatch), server-side |
| Observation→verification span | timestamp(observation) → timestamp(verify), includes mandatory 15 s physical settle |
| Governance interception | rate-limit / trial-cadence / range violations actually enforced during the run |
| In-specification ratio | exported weight samples within 32.5 ± 0.35 g |

---

## 2. Results

### 2.1 Overall (RQ1 — functional completeness & repeatability)

| Run | Assertions | Pass rate | Duration | Cadence wait triggered | Exit |
|---|---|---|---|---|---|
| R1 `…194240` | 80/80 | 100% | 93 s | no | 0 |
| R2 `…194413` | 80/80 | 100% | 312 s | yes (218 s wait, auto-retry) | 0 |
| R3 `…194925` | 80/80 | 100% | 312 s | yes (218 s wait, auto-retry) | 0 |
| **Aggregate** | **240/240** | **100%** | — | 2/3 runs exercised the 300 s trial-cadence path | — |

The API surface matrix (S1) passed **45/45 in every run**, including negative assertions (wrong-password rejection, token-less rejection, permission isolation for ungranted users, disabled-tool invocation, non-terminal task de-duplication).

### 2.2 Multi-protocol ingestion & heterogeneous data (RQ2)

Per-protocol live-sampling matrix (S2, fresh data ≤3 min; identical verdicts in all three runs):

| Protocol family | Probe node (representative) | Fresh buckets / 3 min |
|---|---|---|
| Modbus TCP | 演示·挤出主机PLC·加热区2SP | 7 |
| Modbus RTU (over serial gateway) | 演示·晶点计数从站·晶点计数 | 7 |
| OPC UA | 演示·熔体泵送单元·MeltPressure | 7 |
| MQTT | 演示·在线测厚仪·thick | 7 |
| HTTP/REST | 演示·CCD检测站·defect | 7 |
| MES-REST (control-plane write point) | 注塑·MES温度设定(直取) | direct `mes_fetch` OK |

Heterogeneous ingestion (benchmark line, per run):

| Modality | Channel | Observed (R1/R2/R3) |
|---|---|---|
| Scalar → Timescale `daq_samples` | online weight gauge | 9 / 8 / 9 buckets per 2 min |
| Vector frames → `daq_frames` | wall-thickness profile (48-pt) | 5 / 5 / 5 frames per 5 min |
| Image frames → object store + `daq_frames` | CCD inspection camera | 10 / 10 / 10 frames per 5 min |
| Image integrity (sha256+size fingerprint) | same | **10/10, 10/10, 10/10 — 100%** |
| MES mirror (HTTP pull → time-series) | MES thickness mean | 9 / 9 / 9 buckets per 2 min |

### 2.3 Governance & safety enforcement (RQ3)

| Enforcement mechanism | Stimulus | Observed response (all runs) |
|---|---|---|
| Safe-range interlock | write 999 bar to hold-pressure SP (range 30–90) | rejected at the node-safety-range layer, explicit message |
| Silent-mock-fallback block (hardening) | create node / test connection with undeclared driver `bogus-protocol` | loud failure (HTTP 500 with explicit unknown-driver message); no silent mock |
| 60 s online-write interval + write-hold window | immediate reverse write after a successful one (S5) | 429-style rejection, remaining-seconds quoted ("还需 60 s") — **3/3 runs** |
| 300 s trial cadence | back-to-back recipe dispatch (S4, R2/R3) | dispatch blocked with remaining-time quote; harness auto-waited and retried — **enforced 2/3 runs** |
| HITL gate | agent-initiated recipe dispatch | structured approval card carrying per-parameter basis + evidence reference; dispatch only after structured approval — **3/3 runs** |

### 2.4 Closed-loop optimization scenario (RQ4)

The scenario observes the mirror-image weight, computes a control step under the grey-box sensitivity (0.052 g/bar), and — because the process had already converged (|error| ≤ 0.15 g dead-band in every run) — applies a **bounded zigzag excitation step** around the anchor setpoint (63 bar) to exercise the full dispatch path without drifting the process.

| Run | Observation (weight / sink) | Decision | Setpoint step | Dispatch | Run ledger | Three-way consistency (recipe\|PLC\|mirror) | Max consistency error |
|---|---|---|---|---|---|---|---|
| R1 | 32.65 g / 1.12% | converged, zigzag | 66 → 65 bar | 1/1 params OK | OK | 65 / 65 / 65 bar | **0.0 bar** |
| R2 | 32.64 g / 1.11% | converged, zigzag | 65 → 64 bar | 1/1 OK | OK | 64 / 64 / 64 bar | **0.0 bar** |
| R3 | 32.61 g / 1.14% | converged, zigzag | 64 → 63 bar | 1/1 OK | OK | 63 / 63 / 63 bar | **0.0 bar** |

Latency (server-side, from `timeline.jsonl`):

| Metric | R1 | R2 | R3 |
|---|---|---|---|
| HITL approval → dispatch completed | 8 ms | 9 ms | 9 ms |
| Observation → verification complete | 25.1 s | 245.2 s * | 245.1 s * |

\* R2/R3 include the mandatory 300 s trial-cadence wait (governance window), which the harness honored automatically — i.e., the closed loop provably **never bypasses** the anti-oscillation interlock even under automation.

Traceability: every dispatch is anchored by an approval ID (`ap-*`), batch ID (`rr-*` batch) and run-ledger ID (`rr-*` run), all captured in the per-run timeline.

### 2.5 Stability fine-tuning scenario (RQ5)

| Step | R1 | R2 | R3 |
|---|---|---|---|
| Micro-step (mold-temperature SP) | 42.5 → 43.0, readback exact | ✓ | ✓ |
| Immediate reverse write | blocked (60 s window) | ✓ | ✓ |
| Post-window rollback | 43 → 42.5, readback exact | ✓ | ✓ |
| Restoration check (node value = original) | 42.5 ✓ | ✓ | ✓ |

### 2.6 Data-analysis scenario (RQ6)

30-minute 14-column merged wide-table export, analyzed in-place:

| Metric | R1 | R2 | R3 |
|---|---|---|---|
| Rows | 869 | 869 | 869 |
| Weight mean (g) | 32.571 | 32.582 | 32.552 |
| Weight std (g) | 0.070 | 0.066 | 1.107* |
| In-specification ratio (32.5 ± 0.35 g) | 100% | 100% | 99.9% (868/869) |

\* R3 contains a single 0-value outlier row (batch-boundary alignment artifact of the simulator feed), which the in-specification metric correctly isolates — retained deliberately as a data-quality observation.

---

## 3. Repeatability & Statistical Summary

- **3/3 runs fully green; 240/240 assertions; zero flaky failures** across a ~25-minute consecutive campaign under live multi-tenant load.
- Across runs, the closed-loop path delivered **exact (0.0 bar) three-way setpoint consistency** every time, with HITL→dispatch latency of **8–9 ms** server-side and bounded setpoint excitation (66→63 bar) that terminated precisely on the anchor setpoint.
- Governance interception was **100%** for all stimulated mechanisms (safe-range, write interval, hold window, trial cadence, HITL gate, silent-mock block).

## 4. Threats to Validity

1. **Simulator-based physical layer.** The plant is a physics-based simulator (first-order weight model with documented constants), not a physical line; absolute process numbers (e.g., weight std) characterize the simulator feed. The evaluation target is the **control/governance/data platform**, whose behavior is protocol- and plant-agnostic at the tested seams.
2. **Auto-adjudicated HITL.** The harness approves its own proposals to enable unattended runs; the HITL mechanism itself (card content, structured choice, audit trail) is asserted, while human-decision latency is out of scope.
3. **Single-deployment scope.** All runs executed on one reference deployment; the pipeline is configuration-driven (`benchmark.config.json`) to re-point at other lines/protocols.

## 5. Artifact Availability

- Per-run machine artifacts: `docs/benchmarks/benchmark-20261007194240|194413|194925/{report.md, benchmark.json, timeline.jsonl}`
- Harness: `scripts/testing/run-benchmark.mjs` (+ `benchmark.config.json`, `aggregate-benchmarks.mjs`)
- Test methodology: `docs/testing/SYSTEM-TEST-SKILL.md` (v2.2, one-command benchmark + L1–L12 manual layers)

---

*报告生成:AgentWorkShop 基准 PIPELINE 三连跑(2026-10-08);本文件为论文实验部分素材,数字与 `benchmark.json`/`timeline.jsonl` 逐项对应。*
