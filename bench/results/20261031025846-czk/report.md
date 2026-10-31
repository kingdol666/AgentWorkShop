# AW-IndustrialBench · Integrated Pipeline Report

> **FAIL** — score **0.0**/100, grade **F**. Hard gate tripped: at least one check/phase failed; the score is informational only.

## Fingerprint

| Field | Value |
|---|---|
| Run ID | `20261031025846-czk` |
| Seed / preset | 42 / `cast-film-physics` |
| Harness hash | `f1b50e757e309bc6` (sha256 over 13 checker sources) |
| Git commit | `60fa983e` |
| Runtime | v24.19.0 · win32 x64 |
| Platform / simulator | http://127.0.0.1:3005 · http://127.0.0.1:4011 |
| Tool harness | opencode (deterministic) · LLM agent: (none) |
| Reproduce | `node bench/pipeline.mjs --profile integrated --seed 42 --cl-seeds 3` |

## Key indicators

| KPI | Value | Note |
|---|---:|---|
| Provisionable lines | 0 | +0 satellite DAQ ·  |
| DAQ samples total | 0 | 0/0 nodes sampling |
| Governance interception (pooled) | — % | F5 attacks |
| Write p50 (all protocols) | null ms | incl. real protocol transactions |
| Closed-loop J/J* | off | --cl-seeds 3 enables |
| Tool-level loops | 0 | dcw→daq→judge ×3 convergence |
| Param-layer governance | —/4 | semantic surface · 4-layer write limits · agent param_control |
| System backstop | not fired | P8b drill requires scenario 2 |
| Scenario portability | off | P8 runs in integrated profile |
| Biax line (BOPET) | off | P10 requires P4 fixture |
| LLM agent loop | off | --agent omp enables |
| Verdict | FAIL | 0/1 checks · hard gate tripped |

## Simulated production line profile

> Preset `cast-film-physics` — Cast-film extrusion digital twin (plant-model physics engine). An extrusion cast-film line: resin → screw melting → die → casting → thickness gauge. Six writable setpoints (3 zone temperatures, screw speed, line speed, die gap) act on a physics engine whose observable process quantities are melt temperature, melt pressure, film thickness, defect rate and gels count.

**Physics.** Deterministic plant model (seeded): first-order thermal lag on melt temperature, algebraic thickness h ∝ N/v from mass conservation, pressure/defect couplings — scored by J = 55·J_thick + 25·J_quality + 8·J_energy + 7·J_throughput.
 Plant engine state at report time: phase=`steady`, seed=`—`.

**Totals.** 0 PLC devices across 0 protocols (); **0 writable setpoints (SP → DCW nodes)** and **0 process quantities (PV → DAQ nodes)**; the platform side provisions 0 lines with 0 write nodes and 0 acquisition nodes.

### Devices & fieldbus endpoints

| # | Device | Protocol | Endpoint | Signals (SP+PV) |
|---:|---|---|---|---:|

### Signal inventory (writable setpoints first, then process quantities)

| Device | Signal | Kind | Unit | Range | Decimals | Strategy |
|---|---|---|---|---|---:|---|

## Phase scorecard (weighted)

| Phase | Title | Pass | Warn | Fail | Skip | Score | Weight |
|---|---|---:|---:|---:|---:|---:|---:|
| P0 | Bootstrap · simulator & platform | 0 | 0 | 1 | 0 | 0.0 | 1 |
| P4b | Rollback & optimization records | 0 | 0 | 0 | 1 | — | 2 |
| P4c | HITL approval gate | 0 | 0 | 0 | 1 | — | 2 |
| P4e | Recipe lifecycle | 0 | 0 | 0 | 1 | — | 2 |
| P4f | Process-parameter mapping layer (semantic surface · standard conversions · 4-layer write limits) | 0 | 0 | 0 | 1 | — | 3 |
| P4m | AgentTeam optimization mission (task board → governed writes → attainment) | 0 | 0 | 0 | 1 | — | 3 |
| P8b | System backstop drill (bounded autonomy) | 0 | 0 | 0 | 1 | — | 3 |
| P10 | Biax (BOPET) full-line mission (probe → provision → multi-node AgentTeam closed loop) | 0 | 0 | 0 | 1 | — | 3 |
| **Overall** | | | | | | **0.0** | 1 |

## AgentTeam closed-loop tuning walkthrough

How an optimization team is assembled and drives the line, end to end: (1) a mission channel is created with a **lead** (dispatcher) and **worker** agents; (2) every industrial node is **bound** to the worker via agent-tool bindings — `my_industrial_nodes` then returns the semantic card of each bound node (physical quantity, unit, safe range, active recipe window); (3) the optimization goal is posted to the task board as a parent task and dispatched by the lead; (4) tuning runs as observe → analyze → **governed write** (`dcw_control`, recipe-window interlocked, every write opens an optimization record) → re-observe → judge (`dcw_judge` keep/rollback) cycles until the target window is met; (5) the closing artifact set is the parameter journal (agent-attributed), optimization records and a versioned recipe update.

_(no AgentTeam trajectory recorded in this run — missions skipped)_

## Execution artifacts (Agent-team trajectory archive)

| Artifact | Size | Contents |
|---|---:|---|
| `line-profile.json` | 1.0 KB | Simulated line profile — devices, protocols, endpoints, SP/PV signal inventory, AW node mapping |
| `metrics.csv` | 0.0 KB | Quantitative metrics registry (flat CSV) |
| `run.json` | 10.3 KB | Full machine-readable results (checks, phases, evidence, KPIs, line profile, agent-team traces) |
| `summary.json` | 3.4 KB | Verdict + KPI + per-line summary (compare/aggregate input) |

## Check details

### P0 — Bootstrap · simulator & platform

- ✘ **simulator-reachable** (fail) — simulator reachable
  - simulator http://127.0.0.1:4011 自动启动失败: private simulator prelaunch isolation check failed: spawnSync powershell.exe ETIMEDOUT
  - 处置: cd D:\codes\ABO\AgentWorkShop\plc-node-simulator && npm install && npm run dev

### P10 — Biax (BOPET) full-line mission (probe → provision → multi-node AgentTeam closed loop)

- ↓ **biax-ensure** (skip) — 双拉产线全节点
  - P4 夹具未就绪

### P4b — Rollback & optimization records

- ↓ **rollback-records** (skip) — 回退与优化记录
  - P4 夹具未就绪

### P4c — HITL approval gate

- ↓ **hitl** (skip) — HITL 审批
  - P4 夹具未就绪

### P4e — Recipe lifecycle

- ↓ **recipe-lifecycle** (skip) — recipe lifecycle
  - 无可开跑Line

### P4f — Process-parameter mapping layer (semantic surface · standard conversions · 4-layer write limits)

- ↓ **param-facade** (skip) — 工艺参数映射层
  - 无可开跑Line或P4夹具未就绪

### P4m — AgentTeam optimization mission (task board → governed writes → attainment)

- ↓ **mission-board** (skip) — AgentTeam 优化任务
  - P4 夹具未就绪

### P8b — System backstop drill (bounded autonomy)

- ↓ **backstop** (skip) — 系统兜底 drilling
  - P8 场景或 P4 夹具未就绪

## Metric registry

| Group | Metric | Value | Unit | Note |
|---|---|---:|---|---|
| provision | lines_sampling | 0 |  | real driver produced samples |
| gov | intercept_rate_all | null |  | 全协议合并 |

---
_Machine-generated by `bench/pipeline.mjs` (verdict FAIL, grade F). The styled HTML panel is `report.html` in the same directory. Re-run under the same seed and compare judge-class outcomes with `bench/compare.mjs` against an archived baseline._