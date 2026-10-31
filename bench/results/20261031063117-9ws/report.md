# AW-IndustrialBench · Integrated Pipeline Report

> **FAIL** — score **34.1**/100, grade **F**. Hard gate tripped: at least one check/phase failed; the score is informational only.

## Fingerprint

| Field | Value |
|---|---|
| Run ID | `20261031063117-9ws` |
| Seed / preset | 42 / `cast-film-physics` |
| Harness hash | `82daeac2691efc94` (sha256 over 13 checker sources) |
| Git commit | `269640bf` |
| Runtime | v24.19.0 · win32 x64 |
| Platform / simulator | http://127.0.0.1:3001 · http://127.0.0.1:4010 |
| Tool harness | opencode (deterministic) · LLM agent: (none) |
| Reproduce | `node bench/pipeline.mjs --profile integrated --seed 42 --cl-seeds 3` |

## Key indicators

| KPI | Value | Note |
|---|---:|---|
| Provisionable lines | 5 | +0 satellite DAQ · modbus-tcp/opcua/mqtt/http/modbus-rtu |
| DAQ samples total | 0 | 0/5 nodes sampling |
| Governance interception (pooled) | — % | F5 attacks |
| Write p50 (all protocols) | null ms | incl. real protocol transactions |
| Closed-loop J/J* | off | --cl-seeds 3 enables |
| Tool-level loops | 0 | dcw→daq→judge ×3 convergence |
| Param-layer governance | —/4 | semantic surface · 4-layer write limits · agent param_control |
| System backstop | not fired | P8b drill requires scenario 2 |
| Scenario portability | film-line | 2nd scenario: 5 lines + 0 sat · F5 0/0 · 0 code changes |
| Biax line (BOPET) | off | P10 requires P4 fixture |
| LLM agent loop | off | --agent omp enables |
| Verdict | FAIL | 4/32 checks · hard gate tripped |

## Simulated production line profile

> Preset `cast-film-physics` — Cast-film extrusion digital twin (plant-model physics engine). An extrusion cast-film line: resin → screw melting → die → casting → thickness gauge. Six writable setpoints (3 zone temperatures, screw speed, line speed, die gap) act on a physics engine whose observable process quantities are melt temperature, melt pressure, film thickness, defect rate and gels count.

**Physics.** Deterministic plant model (seeded): first-order thermal lag on melt temperature, algebraic thickness h ∝ N/v from mass conservation, pressure/defect couplings — scored by J = 55·J_thick + 25·J_quality + 8·J_energy + 7·J_throughput.
 Plant engine state at report time: phase=`warmup`, seed=`42`.

**Totals.** 5 PLC devices across 5 protocols (modbus-tcp, modbus-rtu, opcua, mqtt, http); **6 writable setpoints (SP → DCW nodes)** and **7 process quantities (PV → DAQ nodes)**; the platform side provisions 0 lines with 0 write nodes and 0 acquisition nodes.

### Devices & fieldbus endpoints

| # | Device | Protocol | Endpoint | Signals (SP+PV) |
|---:|---|---|---|---:|
| 1 | 挤出主机PLC(Modbus TCP) | `modbus-tcp` | `0.0.0.0:16040 unit=1` | 4 |
| 2 | 晶点计数从站(Modbus RTU) | `modbus-rtu` | `0.0.0.0:15041 unit=1` | 1 |
| 3 | 熔体泵送单元(OPC UA) | `opcua` | `opc.tcp://127.0.0.1:5840` | 2 |
| 4 | 在线测厚仪(MQTT) | `mqtt` | `mqtt://127.0.0.1:18830` | 2 |
| 5 | CCD检测站(HTTP) | `http` | `http endpoint` | 4 |

### Signal inventory (writable setpoints first, then process quantities)

| Device | Signal | Kind | Unit | Range | Decimals | Strategy |
|---|---|---|---|---|---:|---|
| 挤出主机PLC(Modbus TCP) | 加热区1SP (`zone1-sp`) | SP (writable setpoint) | ℃ | [120, 260] | 1 | `manual` |
| 挤出主机PLC(Modbus TCP) | 加热区2SP (`zone2-sp`) | SP (writable setpoint) | ℃ | [120, 260] | 1 | `manual` |
| 挤出主机PLC(Modbus TCP) | 加热区3SP (`zone3-sp`) | SP (writable setpoint) | ℃ | [120, 260] | 1 | `manual` |
| 挤出主机PLC(Modbus TCP) | 熔体温度 (`melt-temp`) | PV (process quantity) | ℃ | [0, 400] | 2 | `constant` |
| 晶点计数从站(Modbus RTU) | 晶点计数 (`gels-count`) | PV (process quantity) | 个/m² | [0, 500] | 0 | `constant` |
| 熔体泵送单元(OPC UA) | ScrewSpeedSP (`screw-sp`) | SP (writable setpoint) | rpm | [50, 200] | 0 | `manual` |
| 熔体泵送单元(OPC UA) | MeltPressure (`melt-pressure`) | PV (process quantity) | MPa | [0, 45] | 3 | `constant` |
| 在线测厚仪(MQTT) | lineSpeedSP (`linespeed-sp`) | SP (writable setpoint) | m/min | [20, 120] | 1 | `manual` |
| 在线测厚仪(MQTT) | thick (`film-thickness`) | PV (process quantity) | μm | [0, 400] | 2 | `constant` |
| CCD检测站(HTTP) | dieGapSP (`diegap-sp`) | SP (writable setpoint) | mm | [0.5, 2] | 2 | `manual` |
| CCD检测站(HTTP) | profile (`thickness-profile`) | PV (process quantity) | μm | [0, 400] | 3 | `constant` |
| CCD检测站(HTTP) | ccd (`ccd-image`) | PV (process quantity) | 灰度 | [0, 255] | 2 | `constant` |
| CCD检测站(HTTP) | defect (`defect-rate`) | PV (process quantity) | % | [0, 100] | 3 | `constant` |

## Phase scorecard (weighted)

| Phase | Title | Pass | Warn | Fail | Skip | Score | Weight |
|---|---|---:|---:|---:|---:|---:|---:|
| P0 | Bootstrap · simulator & platform | 0 | 0 | 1 | 0 | 0.0 | 1 |
| P1 | Plant model + offline optimum W* | 3 | 0 | 0 | 0 | 100.0 | 1 |
| P2 | Multi-protocol line provisioning | 0 | 6 | 0 | 0 | 50.0 | 2 |
| P3 | DAQ · governed write · F5 interlock | 0 | 5 | 0 | 0 | 50.0 | 3 |
| P4 | Agent-tool closed loop (3-cycle convergence) | 0 | 0 | 1 | 0 | 0.0 | 3 |
| P4b | Rollback & optimization records | 0 | 0 | 0 | 1 | — | 2 |
| P4c | HITL approval gate | 0 | 0 | 0 | 1 | — | 2 |
| P4d | Audit / ledger read surfaces | 0 | 1 | 0 | 0 | 50.0 | 1 |
| P4e | Recipe lifecycle | 0 | 0 | 0 | 1 | — | 2 |
| P4f | Process-parameter mapping layer (semantic surface · standard conversions · 4-layer write limits) | 0 | 0 | 0 | 1 | — | 3 |
| P4m | AgentTeam optimization mission (task board → governed writes → attainment) | 0 | 0 | 0 | 1 | — | 3 |
| P6 | Closed-loop optimization benchmark (multi-seed) | 0 | 0 | 1 | 0 | 0.0 | 3 |
| P7 | Multimodal acquisition (vector/image) | 0 | 0 | 0 | 1 | — | 1 |
| P8 | Cross-scenario portability | 1 | 10 | 0 | 0 | 54.5 | 3 |
| P8b | System backstop drill (bounded autonomy) | 0 | 0 | 0 | 1 | — | 3 |
| P9 | Platform subsystems (team / memory / registry) | 0 | 3 | 0 | 0 | 50.0 | 1 |
| P10 | Biax (BOPET) full-line mission (probe → provision → multi-node AgentTeam closed loop) | 0 | 0 | 0 | 1 | — | 3 |
| **Overall** | | | | | | **34.1** | 18 |

## AgentTeam closed-loop tuning walkthrough

How an optimization team is assembled and drives the line, end to end: (1) a mission channel is created with a **lead** (dispatcher) and **worker** agents; (2) every industrial node is **bound** to the worker via agent-tool bindings — `my_industrial_nodes` then returns the semantic card of each bound node (physical quantity, unit, safe range, active recipe window); (3) the optimization goal is posted to the task board as a parent task and dispatched by the lead; (4) tuning runs as observe → analyze → **governed write** (`dcw_control`, recipe-window interlocked, every write opens an optimization record) → re-observe → judge (`dcw_judge` keep/rollback) cycles until the target window is met; (5) the closing artifact set is the parameter journal (agent-attributed), optimization records and a versioned recipe update.

_(no AgentTeam trajectory recorded in this run — missions skipped)_

## Execution artifacts (Agent-team trajectory archive)

| Artifact | Size | Contents |
|---|---:|---|
| `line-profile.json` | 5.6 KB | Simulated line profile — devices, protocols, endpoints, SP/PV signal inventory, AW node mapping |
| `metrics.csv` | 0.5 KB | Quantitative metrics registry (flat CSV) |
| `run.json` | 32.1 KB | Full machine-readable results (checks, phases, evidence, KPIs, line profile, agent-team traces) |
| `summary.json` | 8.3 KB | Verdict + KPI + per-line summary (compare/aggregate input) |

## Check details

### P0 — Bootstrap · simulator & platform

- ✘ **platform-reachable** (fail) — platform reachable & authenticated
  - 平台 http://127.0.0.1:3001：already-up
  - 鉴权 failed (login)
  - simulator http://127.0.0.1:4010：already up (reused)
  - 隔离配置根 (未设——共享配置根,复现性弱)

### P1 — Plant model + offline optimum W*

- ✔ **preset-applied** (pass) — 预设 cast-film-physics 已应用
  - devices 5 
  - 协议 modbus-tcp, modbus-rtu, opcua, mqtt, http
- ✔ **field-defaults** (pass) — 现场=蓝图默认值（6 信号核对）
  - 全部信号初始值=蓝图默认值
- ✔ **offline-optimum** (pass) — offline optimum W* (ground truth) available
  - W* = {"zoneTemp":212.5,"screw":55,"lineSpeed":40,"meltTemp":212.5,"pressure":6.961,"thickness":49.18,"defect":0.055,"score":89.894,"computedAt":"2026-10-31T06:31:23.256Z"}

### P10 — Biax (BOPET) full-line mission (probe → provision → multi-node AgentTeam closed loop)

- ↓ **biax-ensure** (skip) — 双拉产线全节点
  - P4 夹具未就绪

### P2 — Multi-protocol line provisioning

- ▲ **gateway** (warn) — gateway controller start (idempotent)
  - POST /api/workshop/daq/controller {action:start}
  - 采样仍受「活动Line批」门控，故每台有 SP 的devices自成一可开跑Line
- ▲ **line-1-modbus-tcp** (warn) — Line1 [modbus-tcp] 供给
  - line=✘ daq=✘ dcw=✘ recipe=—
  - DAQ driver test ✔ 信号「熔体温度」：
  - （该devices无可用 DCW 导出，作为satellite DAQ随宿主批采样）
  - 建线失败: 需要有效的用户 token(Authorization: Bearer <用户token>;经 /api/users/register 或 /api/users/login 获取)
- ▲ **line-2-opcua** (warn) — Line2 [opcua] 供给
  - line=✘ daq=✘ dcw=✘ recipe=—
  - DAQ driver test ✔ 信号「MeltPressure」：
  - （该devices无可用 DCW 导出，作为satellite DAQ随宿主批采样）
  - 建线失败: 需要有效的用户 token(Authorization: Bearer <用户token>;经 /api/users/register 或 /api/users/login 获取)
- ▲ **line-3-mqtt** (warn) — Line3 [mqtt] 供给
  - line=✘ daq=✘ dcw=✘ recipe=—
  - DAQ driver test ✔ 信号「thick」：
  - （该devices无可用 DCW 导出，作为satellite DAQ随宿主批采样）
  - 建线失败: 需要有效的用户 token(Authorization: Bearer <用户token>;经 /api/users/register 或 /api/users/login 获取)
- ▲ **line-4-http** (warn) — Line4 [http] 供给
  - line=✘ daq=✘ dcw=✘ recipe=—
  - DAQ driver test ✔ 信号「defect」：
  - （该devices无可用 DCW 导出，作为satellite DAQ随宿主批采样）
  - 建线失败: 需要有效的用户 token(Authorization: Bearer <用户token>;经 /api/users/register 或 /api/users/login 获取)
- ▲ **line-5-modbus-rtu** (warn) — Line5 [modbus-rtu] 供给
  - line=✘ daq=✘ dcw=✘ recipe=—
  - DAQ driver test ✔ 信号「晶点计数」：
  - （该devices无可用 DCW 导出，作为satellite DAQ随宿主批采样）
  - 建线失败: 需要有效的用户 token(Authorization: Bearer <用户token>;经 /api/users/register 或 /api/users/login 获取)

### P3 — DAQ · governed write · F5 interlock

- ▲ **line-1-io** (warn) — Line1 [modbus-tcp] integration check
  - ✘ DAQ samples stored 0  points (modbus-tcp real driver）
  - no SP write point; write/governance sub-checks skipped
- ▲ **line-2-io** (warn) — Line2 [opcua] integration check
  - ✘ DAQ samples stored 0  points (opcua real driver）
  - no SP write point; write/governance sub-checks skipped
- ▲ **line-3-io** (warn) — Line3 [mqtt] integration check
  - ✘ DAQ samples stored 0  points (mqtt real driver）
  - no SP write point; write/governance sub-checks skipped
- ▲ **line-4-io** (warn) — Line4 [http] integration check
  - ✘ DAQ samples stored 0  points (http real driver）
  - no SP write point; write/governance sub-checks skipped
- ▲ **line-5-io** (warn) — Line5 [modbus-rtu] integration check
  - ✘ DAQ samples stored 0  points (modbus-rtu real driver）
  - no SP write point; write/governance sub-checks skipped

### P4 — Agent-tool closed loop (3-cycle convergence)

- ✘ **tool-loop-setup** (fail) — 闭环夹具（channel+agent）
  - channel=undefined agent=undefined
  - {}

### P4b — Rollback & optimization records

- ↓ **rollback-records** (skip) — 回退与优化记录
  - P4 夹具未就绪

### P4c — HITL approval gate

- ↓ **hitl** (skip) — HITL 审批
  - P4 夹具未就绪

### P4d — Audit / ledger read surfaces

- ▲ **audit-surfaces** (warn) — 治理只读面
  - ✘ 参数变更账本 journal：本产线 0  anchors (source coverage  —）
  - ✘ audit: 0 entries
  - ✘ ops-logs: 0 entries
  - — 报警记录：全局 0 （含历史）

### P4e — Recipe lifecycle

- ↓ **recipe-lifecycle** (skip) — recipe lifecycle
  - 无可开跑Line

### P4f — Process-parameter mapping layer (semantic surface · standard conversions · 4-layer write limits)

- ↓ **param-facade** (skip) — 工艺参数映射层
  - 无可开跑Line或P4夹具未就绪

### P4m — AgentTeam optimization mission (task board → governed writes → attainment)

- ↓ **mission-board** (skip) — AgentTeam 优化任务
  - P4 夹具未就绪

### P6 — Closed-loop optimization benchmark (multi-seed)

- ✘ **twin-nodes** (fail) — cast-film twin node provisioning（执行器 + 传感器）
  - line creation failed

### P7 — Multimodal acquisition (vector/image)

- ↓ **frames** (skip) — 多形态数采
  - 无 http devices或Line

### P8 — Cross-scenario portability

- ✔ **scenario-switch** (pass) — second plant scenario applied: film-line
  - devices 5 · protocols modbus-tcp, modbus-rtu, opcua, mqtt, http
  - 信号域/动力学与第一场景（cast-film-physics）完全不同 —— 框架代码零改动
- ▲ **commission-1-modbus-tcp** (warn) — scenario[film-line] line 1 [modbus-tcp] provisioned
  - line=✘ daq=✘ dcw=✘
  - (no SP export → satellite DAQ)
  - 建线失败: 需要有效的用户 token(Authorization: Bearer <用户token>;经 /api/users/register 或 /api/users/login 获取)
- ▲ **commission-2-opcua** (warn) — scenario[film-line] line 2 [opcua] provisioned
  - line=✘ daq=✘ dcw=✘
  - (no SP export → satellite DAQ)
  - 建线失败: 需要有效的用户 token(Authorization: Bearer <用户token>;经 /api/users/register 或 /api/users/login 获取)
- ▲ **commission-3-mqtt** (warn) — scenario[film-line] line 3 [mqtt] provisioned
  - line=✘ daq=✘ dcw=✘
  - (no SP export → satellite DAQ)
  - 建线失败: 需要有效的用户 token(Authorization: Bearer <用户token>;经 /api/users/register 或 /api/users/login 获取)
- ▲ **commission-4-modbus-rtu** (warn) — scenario[film-line] line 4 [modbus-rtu] provisioned
  - line=✘ daq=✘ dcw=✘
  - (no SP export → satellite DAQ)
  - 建线失败: 需要有效的用户 token(Authorization: Bearer <用户token>;经 /api/users/register 或 /api/users/login 获取)
- ▲ **commission-5-http** (warn) — scenario[film-line] line 5 [http] provisioned
  - line=✘ daq=✘ dcw=✘
  - (no SP export → satellite DAQ)
  - 建线失败: 需要有效的用户 token(Authorization: Bearer <用户token>;经 /api/users/register 或 /api/users/login 获取)
- ▲ **port-1-modbus-tcp** (warn) — scenario[film-line] line 1 [modbus-tcp] integration
  - ✘ DAQ samples 0 pts (modbus-tcp real driver)
  - no SP write point; write/governance sub-checks skipped (satellite DAQ)
- ▲ **port-2-opcua** (warn) — scenario[film-line] line 2 [opcua] integration
  - ✘ DAQ samples 0 pts (opcua real driver)
  - no SP write point; write/governance sub-checks skipped (satellite DAQ)
- ▲ **port-3-mqtt** (warn) — scenario[film-line] line 3 [mqtt] integration
  - ✘ DAQ samples 0 pts (mqtt real driver)
  - no SP write point; write/governance sub-checks skipped (satellite DAQ)
- ▲ **port-4-modbus-rtu** (warn) — scenario[film-line] line 4 [modbus-rtu] integration
  - ✘ DAQ samples 0 pts (modbus-rtu real driver)
  - no SP write point; write/governance sub-checks skipped (satellite DAQ)
- ▲ **port-5-http** (warn) — scenario[film-line] line 5 [http] integration
  - ✘ DAQ samples 0 pts (http real driver)
  - no SP write point; write/governance sub-checks skipped (satellite DAQ)

### P8b — System backstop drill (bounded autonomy)

- ↓ **backstop** (skip) — 系统兜底 drilling
  - P8 场景或 P4 夹具未就绪

### P9 — Platform subsystems (team / memory / registry)

- ▲ **team-dispatch** (warn) — 团队调度（lead 派发 → worker 完成）
  - 终态 (超时) · assignee=—（lead 认领父任务） · 子任务派发给 worker: 未观察到
- ▲ **team-memory** (warn) — 团队记忆写入 + dedupKey 幂等
  - POST×2 status 401/401 → 列表中匹配 0 条（期望 1）
- ▲ **harness-registry** (warn) — 引擎注册表枚举 + 可用性探测
  - 注册 0 引擎（期望 ≥14） · 环境可用 0 · 覆盖 mock/RPC/SDK/CLI 族

## Metric registry

| Group | Metric | Value | Unit | Note |
|---|---|---:|---|---|
| plant | W_star_objective | 89.894 |  | offline grid-search optimum (benchmark ground truth) |
| provision | lines_created | 5 |  | 可开跑Line（另有 0 satellite DAQ） |
| provision | daq_nodes | 0 |  | real-protocol DAQ nodes |
| provision | lines_sampling | 0 |  | real driver produced samples |
| gov | intercept_rate_all | null |  | 全协议合并 |
| audit | journal_anchors | 0 |  | 本Line参数变更账本 |
| audit | audit_entries | 0 |  | 全局审计目 |
| audit | ops_logs | 0 |  | 全局运维日志 |
| portability | scenario2_lines | 5 |  | second preset "film-line" (config-only) |
| portability | scenario2_intercept_rate | null |  | F5 out-of-window interception on second scenario |
| portability | scenario2_false_blocks | 0 |  | legal in-window writes blocked on second scenario |
| team | team_dispatch_ok | 0 |  | lead→worker dispatch closed loop |
| memory | team_memory_idempotent | 0 |  | dedupKey idempotent refresh |
| agent | harness_registry | 0 |  | environment-available 0 |

---
_Machine-generated by `bench/pipeline.mjs` (verdict FAIL, grade F). The styled HTML panel is `report.html` in the same directory. Re-run under the same seed and compare judge-class outcomes with `bench/compare.mjs` against an archived baseline._