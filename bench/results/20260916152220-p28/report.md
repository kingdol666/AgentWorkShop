# AW-IndustrialBench — Benchmark Report
**Run** `20260916152220-p28`  ·  **Verdict:** ALL CHECKS PASSED  ·  **Overall score 100.0/100 (grade A)**
| Field | Value |
|---|---|
| Tier | `static` |
| Seed | `42` |
| Target | `http://127.0.0.1:3005` |
| Config hash | `3214f90f5b9d795c` |
| Harness hash | `d55894c163e7a2be` (13 sources, SHA-256) |
| Repository commit | `a00c12a` |
| Node / platform | v24.19.0 · win32 x64 |
| Completed at | 2026-09-16T15:22:20.484Z |
**Tally:** 3 pass · 0 warn · 0 fail · 0 skip (skips score nothing, by design).
## Dimension scores
| Dimension | Score | Checks |
|---|---|---|
| D1 Data acquisition | 100.0 | 1 |
| D2 Write-control governance | 100.0 | 2 |
| D3 Agent runtime | 100.0 | 1 |
| D6 Interoperability | 100.0 | 1 |
| D7 Audit & attribution | 100.0 | 1 |
| D0 Paper–code consistency | 100.0 | 1 |
## Check results
| Check | Tier | Status | Score | Key metrics | Note |
|---|---|---|---|---|---|
| `s1-inventory` 能力清单核查（路由/引擎/工具/表/驱动） | static | ✔ PASS | 100 | subchecks=<b>9</b> · ok=<b>9</b> · routes=<b>208</b> · mcpTools=<b>25</b> · engines=<b>14</b> · tables=<b>22</b> · tools=<b>10</b> | 全部能力组件在源码中核实 |
| `s2-paper-consistency` 论文-代码常量一致性 | static | ✔ PASS | 100 | anchors=<b>20</b> · found=<b>20</b> · missing=<b>0</b> | 论文全部常量锚点在源码中核实 |
| `s3-governance-pipeline` 治理管线阶段顺序锚定 | static | ✔ PASS | 100 | chainsOk=<b>2</b> · chainTotal=<b>2</b> | 治理管线六阶段结构与顺序核实（Algorithm 1 的源码对应物） |
## Evidence excerpts
### `s1-inventory` 能力清单核查（路由/引擎/工具/表/驱动）
- ✔ REST 路由文件 ≥ 200 — 实际 208
- ✔ MCP 工具 ≥ 25 — 实际 25
- ✔ Harness 引擎 = 14 — 找到 14/14
- ✔ SQLite 表 ≥ 20 — 实际 22
- ✔ FTS5 记忆索引 — agent_memories_fts
- ✔ 协议驱动 = 5 族 (modbus-tcp/rtu/opcua/mqtt/http) — 找到 modbus, rtu, opcua, mqtt, http
- ✔ 治理工具面 ≥ 10 — 10/10
- ✔ audit_log 14 列 schema — ops.repo.ts
- ✔ 审计 8 类事件枚举 — kind ∈ write/manual/alarm/…
### `s2-paper-consistency` 论文-代码常量一致性
- ✔ sweep 并发配额 64（server/services/workshop/daq/daq-controller.ts · 论文 §III-B2）
- ✔ sweep 周期 250ms（server/services/workshop/daq/daq-controller.ts · 论文 §III-B2）
- ✔ 回退重检周期 30s（server/services/workshop/dcw/recipe-rollback-manager.ts · 论文 §IV-D）
- ✔ 自动回退链上限 K=2（server/services/workshop/dcw/recipe-rollback-manager.ts · 论文 §IV-D / 不变式 I3）
- ✔ 越限判定阈值 B=3（server/services/workshop/dcw/recipe-rollback-manager.ts · 论文 §IV-D）
- ✔ 记忆 RRF k=60（server/services/workshop/runtime/memory.ts · 论文 §V-A）
- ✔ 记忆 MMR λ=0.7（server/services/workshop/runtime/memory.ts · 论文 §V-A）
- ✔ 记忆权重 0.5/0.3/0.2（server/services/workshop/runtime/memory.ts · 论文 §V-A 式(3)）
- ✔ 上下文压缩阈值 70%（app/config/schema.ts · 论文 §V-A）
- ✔ 记录过期接管 30min（app/config/schema.ts · 论文 §IV-B）
- ✔ WS 推送上限 60s（server/services/workshop/daq/daq-runtime.ts · 论文 §III-B1）
- ✔ 报警滞回 2% 量程（server/services/workshop/daq/daq-node.ts · 论文 §III-B3）
- ✔ 报警 warn 带 8% 量程（server/services/workshop/daq/daq-node.ts · 论文 §III-B3）
- ✔ 去抖 3 连续帧（server/services/workshop/daq/daq-node.ts · 论文 §III-B3）
- ✔ 写控账本条目类型（server/services/workshop/dcw/dcw-controller.ts · 论文 §IV-B 阶段5）
- ✔ 回读死区公式（server/services/workshop/dcw/dcw-runtime.ts · 论文 §IV 式(2)）
- ✔ AEP 协议版本 v1（shared/workshop-protocol.ts · 论文 §III-E）
- ✔ 调度空闲退避上限 8s（server/services/workshop/runtime/scheduler-loop.ts · 论文 §V-B）
- ✔ 数控网关扫描周期 500ms（server/services/workshop/dcw/dcw-controller.ts · 论文 §III）
- ✔ 停滞看门狗 300s（server/services/workshop/runtime/scheduler-loop.ts · 论文 §V-B）
### `s3-governance-pipeline` 治理管线阶段顺序锚定
- ✔ write() 编排链顺序成立: beforeWrite(护栏) → param.min(软联锁) → rt.write(执行) → afterWrite(闭环入册) → dcw.write.(审计)
- ✔ executeWrite() 执行链顺序成立: inverseTransform(编码) → readback(回读) → DcwWriteHistoryEntry(账本)
- ✔ 回读死区 writeTolerance() 存在（论文式(2)）
---
**Reproduce:**
```bash
node bench/run.mjs --tier static --seed 42
```
Artifacts: `bench/results/20260916152220-p28/` (run.json · report.md · report.html). Results are append-only — runs are never overwritten, so this report can be cited as experimental evidence. Judge-class metrics are deterministic under a fixed seed; environment-dependent figures (latency, freshness) are reported as measured.