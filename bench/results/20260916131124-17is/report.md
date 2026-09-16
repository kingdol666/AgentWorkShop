# AW-IndustrialBench — Benchmark Report
**Run** `20260916131124-17is`  ·  **Verdict:** FAILED — do not cite  ·  **Overall score 93.8/100 (grade A)**
| Field | Value |
|---|---|
| Tier | `plc` |
| Seed | `42` |
| Target | `http://127.0.0.1:3005` |
| Config hash | `61e1a1119d6f3ff2` |
| Harness hash | `21dccc7dc4867af4` (13 sources, SHA-256) |
| Repository commit | `2806e05` |
| Node / platform | v24.19.0 · win32 x64 |
| Completed at | 2026-09-16T13:11:48.254Z |
**Tally:** 8 pass · 0 warn · 1 fail · 4 skip (skips score nothing, by design).
## Dimension scores
| Dimension | Score | Checks |
|---|---|---|
| D1 Data acquisition | 80.0 | 3 |
| D2 Write-control governance | 100.0 | 6 |
| D3 Agent runtime | 100.0 | 1 |
| D6 Interoperability | 100.0 | 1 |
| D7 Audit & attribution | 100.0 | 3 |
| D8 Performance & scale | 0.0 | 1 |
| D0 Paper–code consistency | 100.0 | 1 |
## Check results
| Check | Tier | Status | Score | Key metrics | Note |
|---|---|---|---|---|---|
| `s1-inventory` 能力清单核查（路由/引擎/工具/表/驱动） | static | ✔ PASS | 100 | subchecks=<b>9</b> · ok=<b>9</b> · routes=<b>208</b> · mcpTools=<b>25</b> · engines=<b>14</b> · tables=<b>22</b> · tools=<b>10</b> | 全部能力组件在源码中核实 |
| `s2-paper-consistency` 论文-代码常量一致性 | static | ✔ PASS | 100 | anchors=<b>20</b> · found=<b>20</b> · missing=<b>0</b> | 论文全部常量锚点在源码中核实 |
| `s3-governance-pipeline` 治理管线阶段顺序锚定 | static | ✔ PASS | 100 | chainsOk=<b>2</b> · chainTotal=<b>2</b> | 治理管线六阶段结构与顺序核实（Algorithm 1 的源码对应物） |
| `api-0-preflight` 实例连通与鉴权 | api | ✔ PASS | 100 | how=<b>login</b> · role=<b>admin</b> | 实例 http://127.0.0.1:3005 可用 |
| `api-1-fixture` 基准夹具（产线+配方窗+数采） | api | ✔ PASS | 100 | created=<b>8</b> · steps=<b>8</b> · lineId=<b>ln-e81b1304</b> · window=<b>175-205℃</b> | 夹具就绪，软联锁窗口已激活 |
| `api-2-semantic-card` 语义卡字段与账本面 | api | ✔ PASS | 100 | ok=<b>6</b> · total=<b>6</b> | 语义卡=Agent 的物理语义地基（论文 §III-D），缺失即治理失效 |
| `api-3-interlock-f5` F5 越界写攻击（联锁拦截率） | api | ✔ PASS | 100 | intercept_rate=<b>1</b> · false_block_rate=<b>0</b> · attacks=<b>6</b> · intercepted=<b>6</b> · legit=<b>3</b> · legit_ok=<b>3</b> · boundary_cases=<b>3</b> · boundary_ok=<b>3</b> · eq1_branch_coverage=<b>pass</b> | I1 动态成立 + 决策边界覆盖 + Eq.(1) 双分支覆盖 |
| `api-4-attribution-readback` 回读闭环与写入归因 | api | ✔ PASS | 100 | writes=<b>3</b> · readback_ok=<b>3</b> · readback_rate=<b>1</b> · new_anchors=<b>3</b> · attribution_rate=<b>1</b> · tolerance=<b>0.7</b> | 回读闭环与全链路归因成立（I2 + 可追溯性） |
| `api-5-daq-freshness` 数采新鲜度与查询时延 | api | ✘ FAIL | 0 | — | 检查器异常 |
| `plc-0-simulator` PLC 模拟器就绪+薄膜产线预设 | plc | ↓ SKIP | 0 | — | PLC 模拟器 http://127.0.0.1:4010 不可达(EADDRINUSE)——请先启动: cd plc-node-simulator &amp;&amp; npm run dev |
| `plc-1-realpath` 五协议真实连通(导出配置→test-driver) | plc | ↓ SKIP | 0 | — | 需要 PLC 模拟器（plc-0 未通过）——本层诚实跳过 |
| `plc-2-closedloop` 真实采样+SP→PV 物理闭环+真实链路治理 | plc | ↓ SKIP | 0 | — | 需要 PLC 模拟器（plc-0 未通过）——本层诚实跳过 |
| `plc-4-fault` 断链-恢复演练 | plc | ↓ SKIP | 0 | — | 需要 PLC 模拟器（plc-0 未通过）——本层诚实跳过 |
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
### `api-0-preflight` 实例连通与鉴权
- 登录成功（login，role=admin）
### `api-1-fixture` 基准夹具（产线+配方窗+数采）
- ✔ 产线 — ok
- ✔ 产品 — ok
- ✔ 数控模板 — ok
- ✔ 数控节点 ×2 — dw-1079f2db/dw-9442137b
- ✔ 配方（软联锁窗） — ok
- ✔ 数采节点 — ok
- ✔ 采集已启动 — gateway+node start
- ✔ 批次开跑（软联锁激活） — ok
### `api-2-semantic-card` 语义卡字段与账本面
- ✔ 数控节点可列出 — found
- ✔ 硬联锁量程字段 — min=120 max=260
- ✔ 显示精度字段 — decimals=1
- ✔ 产线归属（五维打标） — ln-e81b1304
- ✔ 写控账本可查询 — anchors=2
- ✔ 数采节点可列出 — found
### `api-3-interlock-f5` F5 越界写攻击（联锁拦截率）
- 拦截 below-global(v=107) → HTTP 400 VALIDATION_ERROR 设定值 107℃ 低于当前配方「Bench工艺 awb161dbph」的工艺下限 175℃(节点全局量程 120~260
- 拦截 above-global(v=269) → HTTP 400 VALIDATION_ERROR 设定值 269℃ 超出当前配方「Bench工艺 awb161dbph」的工艺上限 205℃(节点全局量程 120~260
- 拦截 above-window(v=219) → HTTP 400 VALIDATION_ERROR 设定值 219℃ 超出当前配方「Bench工艺 awb161dbph」的工艺上限 205℃(节点全局量程 120~260
- 拦截 below-window(v=163) → HTTP 400 VALIDATION_ERROR 设定值 163℃ 低于当前配方「Bench工艺 awb161dbph」的工艺下限 175℃(节点全局量程 120~260
- 拦截 extreme(v=1000000) → HTTP 400 VALIDATION_ERROR 设定值 1000000℃ 超出当前配方「Bench工艺 awb161dbph」的工艺上限 205℃(节点全局量程 120
- 拦截 negative(v=-25) → HTTP 400 VALIDATION_ERROR 设定值 -25℃ 低于当前配方「Bench工艺 awb161dbph」的工艺下限 175℃(节点全局量程 120~260
- 成功 in-window-low(v=180) → HTTP 200 ok
- 成功 in-window-mid(v=190) → HTTP 200 ok
- 成功 in-window-high(v=200) → HTTP 200 ok
- 符合 边界 edge-max-accept(v=205) 期望accept → HTTP 200
- 符合 边界 above-edge-reject(v=205.1) 期望reject → HTTP 400
- 符合 边界 below-edge-reject(v=174.9) 期望reject → HTTP 400
- 符合 无批次分支: 越全局 300 → HTTP 400（应拒）
- 符合 无批次分支: 窗外全局内 130 → HTTP 200（应受理,全局量程接管）
### `api-4-attribution-readback` 回读闭环与写入归因
- ✔ 写 v=182 回读(outcome)=182 → read=182 (τ=0.7)
- ✔ 写 v=191 回读(outcome)=191 → read=191 (τ=0.7)
- ✔ 写 v=197 回读(outcome)=197 → read=197 (τ=0.7)
- 账本新增锚点 3 条（四项判据齐全 3）
### `api-5-daq-freshness` 数采新鲜度与查询时延
- TypeError: fetch failed
## Skipped checks (with reasons)

- **plc-0-simulator** PLC 模拟器 http://127.0.0.1:4010 不可达(EADDRINUSE)——请先启动: cd plc-node-simulator &amp;&amp; npm run dev
- **plc-1-realpath** 需要 PLC 模拟器（plc-0 未通过）——本层诚实跳过
- **plc-2-closedloop** 需要 PLC 模拟器（plc-0 未通过）——本层诚实跳过
- **plc-4-fault** 需要 PLC 模拟器（plc-0 未通过）——本层诚实跳过
---
**Reproduce:**
```bash
node bench/run.mjs --tier plc --seed 42 --base http://127.0.0.1:3005
```
Artifacts: `bench/results/20260916131124-17is/` (run.json · report.md · report.html). Results are append-only — runs are never overwritten, so this report can be cited as experimental evidence. Judge-class metrics are deterministic under a fixed seed; environment-dependent figures (latency, freshness) are reported as measured.