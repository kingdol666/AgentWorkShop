# 全系统验收 × IDD 优化 skill × RAG × omp Channel（模拟产线，2026-11-16）

> 日期：2026-11-16
> 被测源码：`main` @ `c6b42343`（v0.11.3 源码；本轮修复分支另列）
> 环境：隔离 `AW_MODE=home` + 全新 `AW_HOME=D:/tmp/aw-eval-20261116-final/home`；
> 平台 `:3996`；五协议模拟器影子 `:4052`（未连接共享 `4010` / 他人影子）；
> 真实 IDD `:3210`（omp 引擎）；真实 rag-knowledge backend `:8771` / web `:6789`；
> Channel LLM：`ustc/deepseek-flash`（omp lead + 3 omp workers）。
> 边界：**全部设备为模拟协议栈**。本报告是模拟器 + 外部服务集成验收，不是物理 HIL、
> 不是真实 PLC/产线投用批准；Mimosa 仍为 `inconclusive`，不宣称安全通过。

---

## 0. 结论摘要

| 判定项 | 结果 | 说明 |
|---|---|---|
| 代码门禁（修复前） | **通过** | lint / typecheck / build / unit **1787/1787** / docs 101 / skills 176 / MCP 14 / plugin 22 / SDK / twin 5 |
| 代码门禁（修复后） | **通过** | unit **1790/1790**（+3 回归）；其余门禁同前 |
| 产线文档接入 | **通过（模拟）** | sim-twin 7/7；供给 20/20；频道锻造 15/15；V1–V6 **25/25**；4 成员 / 9 绑定 |
| IDD 优化 skill | **通过（真实脚本）** | `industrial-optimizer-loop`：R001 window_seed 3 点 → incumbent 32.557 g；R002 GP-EI 预测 32.423 g / 实测 32.286 g；phase=exploring |
| 平台受治理下发 | **通过（模拟）** | Agent `recipe_propose` 62.5→64 MPa；HITL `ap-0c9a2050`；run `rr-f8c68ba6`；ACK 1/1；readback 64；journal `anc-22979153` |
| 实时复测 | **通过** | 64 MPa 后 60 s 克重 **32.416 g**（+0.11 g），目标窗 32.15–32.85 内；飞边/缺陷率/模温合规 |
| RAG 检索 | **通过（插件直连）** | `/api/plugins/rag-bridge/search` 返回 58 条真实知识；新入库文档检索排名第 1（score 0.716） |
| RAG 入库 | **直接 API 通过 / agent 路径失败** | `/api/v1/search/index-document` 成功 5 chunks；`kb_agent` 同步检索 120 s 超时、写路径报 `fetch failed`（RAG 内部 agent/web 侧） |
| IDD 插件闭环工具 | **不可用（已如实暴露）** | 当前 IDD 已退役 `/api/sentinel` 与 `/api/optimizer`；`/health` 现报 `routesReady=false`；优化改用 skill CLI |
| omp Channel 全链 | **通过（有超时/冷启动缺陷）** | lead 真实调用 `daq_query` / `kb_agent` / 读取 IDD 产物 / `recipe_propose`；最终汇总 3983 字符；知识检索失败被如实披露 |
| 配置重装竞态 | **已修复并复验** | lead busy 时 PATCH scenario → 日志「延迟到空闲后重装」，无 `runtime.stop`/任务取消；短任务返回 32.42 g |
| Mimosa | **不构成安全通过** | deep scan `scan-2026-11-16T06-30-18.388Z-7c8297efdd62`，47 findings，`runStatus=inconclusive`；6 条 server 命中人工复核均为 FP |
| 物理 HIL / 真实产线写控 | **未执行 / 不宣称** | 全部设备为模拟五协议夹具；无真实 PLC 扫描周期、电气安全、急停、量纲/回读校准 |

**总判断：** 当前系统可以作为一个**受治理的工业数据/分析/优化工作台**落地试点：数据采集、历史查询、
节点/产线/配方绑定、HITL 下发、回读/回退、IDD 优化 skill、RAG 检索与入库、omp Channel 协作均有
真实证据。**不能**把它当作自主物理闭环控制器或安全层；物理 HIL、非线性/物理模型优化、RSI 晋升执行、
自动本体学习和无人值守长任务可靠性仍未闭环。

---

## 1. 环境与输入

- 工况文档：`docs/audit/evidence/2026-11-15-doc-to-simulated-plc/work-condition-doc.md`
- 蓝图：`docs/audit/evidence/2026-11-16-line-integration-skill-demo/blueprint-4052.json`
- 接入配置：`docs/audit/evidence/2026-11-16-line-integration-skill-demo/onboard.json`
- 平台：`AW_MODE=home`、全新 `AW_HOME`、`PORT=3996`、`AW_ALLOW_PRIVATE_OUTBOUND=1`
  （仅为本机 IDD/RAG 显式放行）、`BACKUP_DISABLED=1`、`AW_TRIAL_INTERVAL_MS=0`
- 模拟器：`node scripts/onboarding/sim-twin.mjs --blueprint ... --sim-port 4052 --shadow ...`
- IDD：`:3210` 已在运行，使用既有 API token；优化 skill 在 IDD 仓库
  `workspace/aw-exchange/opt-line-20261116` 下执行
- RAG：`:8771` 已在运行，`aw-industrial` KB `3aea5973-1d8a-4db6-b415-6d4432f514bb`
- omp：`omp 18.12.2`；Channel `llmJson={"provider":"ustc","model":"deepseek-flash","effort":"max"}`

落袋 id：

```text
line       ln-95454c2c
product    pd-46de4bc6
recipe     rc-bcdb078b
channel    3e4082d4-124f-4ff0-aa97-ec2882935043 (production_line_integrated, 4 members)
protected  ln-d7e0a2a2 (fixture) / dw-110e77c3 / anc-457b7eca
dcw        保压压力SP dw-19893ba2 · 保压时间SP dw-28869d11 · 料温SP dw-8e1e834a
           冷却流量SP dw-328bdf63 · 保压压力SP（复检） dw-7811d4ea
daq        熔体压力PV dn-4d8801d7 · 制品克重PV dn-fd1e305f · 模具温度PV dn-f04f0b83
           缺陷率PV dn-07f708a6 · 视觉置信度PV dn-e643ab52 · 平均壁厚PV dn-969f37d7
           飞边PV dn-e26d172a · 节拍PV dn-27cdf730 · 厚度轮廓PV dn-4e6c8004
```

---

## 2. 代码门禁与构建

| 门禁 | 修复前 | 修复后 | 证据 |
|---|---|---|---|
| `pnpm lint`（含 RSI 红线） | PASS | PASS | `gates/lint.log` / `gates/lint-after.log` |
| `pnpm typecheck` | PASS | PASS | `gates/typecheck.log` / `-after.log` |
| `pnpm test:unit` | 1787/1787 | **1790/1790** | `gates/unit.log` / `unit-after2.log` |
| `pnpm build` | PASS | PASS | `gates/build.log` / `build-after.log` |
| `pnpm docs:check` | 101/101 | 101/101 | `gates/docs-after.log` |
| `pnpm readme:lint` | PASS | PASS | `gates/readme-after.log` |
| `pnpm test:skills` | 176/176 | 176/176 | `gates/skills-after.log` |
| `pnpm test:mcp` | 14/14 | 14/14 | `gates/mcp-after.log` |
| plugin lifecycle | 22/22 | 22/22 | `gates/plugin-after.log` |
| SDK surface | PASS | PASS | `gates/sdk-after.log` |
| twin provider | 5/5 | 5/5 | `gates/twin-after.log` |

新增回归：`channel-recycle-policy`（有在飞监督/未终态任务时 defer）、`message-requeue-cap`
（requeue 后迟到 `markConsumed` 必须 no-op）、`supervision-decision`（runtime stop 不得归一成
external cancel）。

---

## 3. 文档 → 模拟器 → 产线/Channel

### 3.1 模拟孪生（7/7）

- 6 设备 / 19 信号 / 五协议（Modbus TCP、Modbus RTU、MQTT、OPC UA、HTTP）；
- 每设备 `export` 返回真实 `driverConfig`；平台侧零手抄寄存器；
- tick 活性 6/6；影子私有 MQTT broker `:60830`。

### 3.2 供给与频道锻造

- 供给 **20/20**：1 线、5 DCW、9 DAQ、1 配方（5 参数）、批次开跑、采集总控 running；
- 频道锻造 **15/15**：`production_line_integrated`、4 成员、9 条绑定
  （lead recipe manual；worker DAQ auto；worker DCW manual）；种子任务已派发；
- 种子任务在本轮早期因 Channel 配置 PATCH 被取消（见 §8 根因与修复）；修复后新建任务正常收口。

### 3.3 接入验收 V1–V6（25/25）

- V1：9 个 DAQ 均有真实样本/帧；
- V2：5 个 DCW 越界写全部被拒（量程/配方窗）；
- V3：5 个 DCW 合法写 + 回读一致；
- V4：配方 5 参数逐项映射；
- V5：绑线/4 成员/插件隔离；
- V6：受保护线 `ln-d7e0a2a2` 存在且 baseline=1，本线新增 15 锚点、受保护线新增 **0**
  （fresh home 预置 1 个 mock DCW + 1 条 journal，保证非空可证伪）。

---

## 4. IDD 优化 skill（非根因诊断）

按用户要求**不使用九段根因诊断**，直接执行 IDD 仓库的 `industrial-optimizer-loop`
（纯分析 skill，脚本产出 `authored_by=script`，绝不直接下发）：

- 目标：`制品克重PV` ∈ `[32.15, 32.85] g`
- 因子：保压压力 45–85 MPa、保压时间 2–8 s、料温 180–240 ℃、冷却流量 10–30 L/min
- 预算：6 轮 / 12 trials；`replicates_for_sigma=3`
- 先验：由当前配方 + 文档工程窗构造 `00_input/recommendations.json`（非伪造历史测量）

### R001 `window_seed`（3 点，人工/AWS 直接受治理写）

| trial | 保压压力 | 保压时间 | 料温 | 冷却流量 | 实测克重 |
|---|---|---|---|---|---|
| T03 baseline | 54 | 4.0 | 211 | 16 | **31.712 g** |
| T02 | 60 | 4.5 | 210 | 16 | **32.225 g** |
| T01 | 64 | 4.5 | 211 | 15 | **32.557 g** |

- 所有写均经平台 DCW 治理（量程 ∩ 配方窗 ∩ 单步 ≤2 MPa ∩ 60 s），journal 留痕；
- `ingest`：phase `exploring`；incumbent = 64/4.5/15/211，`in_target=true`，`D=0.836`；
- GP-ARD-RBF 无 fallback，`data_n=3`。

### R002 `gp_ei`（1 点，模型驱动）

- 布点：62.537 MPa / 3.399 s / 208.914 ℃ / 17.951 L/min；
- 预测 32.423 g（CI95 32.173–32.673），实测 **32.286 g**（在 CI 内，残差 -0.137 g）；
- `ingest`：phase 仍 `exploring`，`data_n=4`，incumbent 保持 T01 32.557 g；
- 该轮同时移动 4 个因子，存在混叠；Agent 在 Channel 汇总中明确指出不能分离杠杆。

---

## 5. 平台受治理下发与复测

Channel lead 通过 `recipe_propose` 提交 1 套方案：

- 参数：`dw-19893ba2` 保压压力SP 62.5 → **64.0 MPa**（Δ+1.5 ≤ 步限 2，配方窗 45–85）；
- HITL：审批卡 `ap-0c9a2050`，人工批准（验收自动裁决，模拟线测试语义）；
- 执行：recipe run `rr-f8c68ba6`，ACK 证实 **1/1**，失败 0，`readback=64 MPa`；
- journal：`anc-22979153`（source=agent，runId=`rr-f8c68ba6`，prev 62.5 → 64）；
- 复测（15:10:30–15:12:19，9 点）：**32.416 g**，改前稳态 32.30 g，**+0.11 g**；
  预测 +0.12 g，残差 0.01 g；目标窗内；
- 旁证：飞边 0.213%（≤0.4）、缺陷率 0.400%（≤0.5）、模温 55.93 ℃（50–60）、
  平均壁厚 0.520 mm、节拍 21.92 s、视觉置信度 96.25%；
- 判定：**keep**；未触发回退。

> 注：本轮 Agent 汇总未取得 `anchorId`（工具面不返回），但平台 `/journal` 已独立回读到
> `anc-22979153`；以平台 journal 为准，不采信 Agent 自述的“不可得”作为唯一结论。

---

## 6. RAG 集成

### 6.1 检索（通过）

- 插件健康：backend `ok`、web 52 KB、token accepted、`aw-industrial` 已解析；
- `/api/plugins/rag-bridge/search?q=熔体压力 克重 回归锚点` → **20 条**；
  `保压压力 克重` → **58 条**；返回真实文档内容、doc_path、score、适用范围限制；
- 典型命中：`0.0574 g/bar` 仅适用于登记产线；`0.09 g/bar` 通用锚点带“不适用于
  ln-564c6f86 / PP 家电面板”的适用范围声明。Channel 正确拒绝把通用锚点外推到本线。

### 6.2 入库（直接 API 通过；agent 路径未通过）

- `POST /api/v1/search/index-document`（kb `3aea5973…`）成功：
  `aw-industrial/IDD-OPT-20261116-ln-95454c2c.md`，5 chunks，bge-m3；
- 入库后插件检索：该文档排名 **第 1**（score 0.716），内容包含 64 MPa / 32.557 g /
  32.416 g / 边界声明，证明“结果存储 + 按需检索”闭环；
- **失败如实记录**：
  - `kb_agent(action=query, wait=true, wait_seconds=120)` 返回
    `agent turn timed out after 120000ms`；
  - 另一次同步 `kb_agent` 返回 `fetch failed`，提示 rag-knowledge web 未启动；
    但平台 `/health` 显示 web `ok`（52 KBs），说明是 RAG 内部 agent/web 调用链问题，
    不是平台到 web 的网络不可达；
  - 结论：RAG 的**平台直连检索/索引 API** 可用；RAG 内部 agent 的 `kb_agent` 读写路径
    仍受外部服务实现/超时阻塞，不能宣称生产可用。

### 6.3 IDD 闭环插件

- `idd-closedloop-bridge` 已装载且 9 个工具在册，但当前 IDD 已退役
  `/api/sentinel` 与 `/api/optimizer`（IDD `app/backend/src/index.mjs:326`）；
- 实测 `/api/optimizer/state`、`/api/sentinel/screen` 均 404；
- 本轮已给插件补 `/health` 探针，返回：
  `routesReady=false`、`upstream=404`、hint「改用 industrial-optimizer-loop CLI」；
- `sentinel_status`/`optimizer_state` 不再把 404 当 “status=ok”，而是显式报上游错误；
- 结论：**IDD 优化 skill 可用，IDD 闭环 HTTP 插件对当前 IDD 不可用**；这是版本契约缺口，
  不是本轮新增回归。若要恢复插件路径，需要 IDD 侧重新提供闭环路由或在插件内实现 CLI 适配。

---

## 7. omp Channel 全链

Channel `3e4082d4…`（`production_line_integrated`，绑线 `ln-95454c2c`）：

- 4 个 omp 成员：生产主管（lead）、数据分析师、知识调优工程师、工艺工程师；
- 任务：数据取证 → 知识检索 → 读取 IDD 优化产物 → `recipe_propose` → HITL → 复测收口；
- Lead 真实调用（消息/工具痕迹）：
  `daq_query`、`kb_agent`（超时并如实披露）、本地读取 IDD `trial_design/trial_result/
  optimizer_state`、`recipe_propose`；
- 数据：121 点，均值 32.350 g，min 32.280 / max 32.582；熔体压力 60 点均值 61.252 MPa；
- 知识：`kb_agent` 120 s 超时；Lead 未编造知识，改用任务给定证据并计算本线斜率
  **0.083 g/MPa**，指出 KB `0.0574 g/bar` 不可外推（差 6.9 倍）；
- IDD：正确总结 R001/R002、incumbent、GP-EI 预测与实测、混叠风险；
- 下发：`recipe_propose` + HITL `ap-0c9a2050` + run `rr-f8c68ba6` + readback 64；
- 复测：32.416 g，+0.11 g，目标窗内；旁证合规；判定 keep；
- 收口：3983 字符中文汇总，明确声明“无物理 HIL、所有写入经 HITL 治理”。

**已知缺陷（本轮实测）：**
- 早期 seed task 在 Channel PATCH 后被 cancel（根因：supervise 期间 runtime 状态恒 idle +
  `stopAndWait` 无因 abort 被 omp 归一为 external cancel）；本轮已修复并复验；
- 延迟重装可能因用户回执 `pending` 而暂不执行（不影响任务结果，但会延后配置生效）；
- `kb_agent` 超时/失败仍会消耗 Agent 回合时间；Channel 需要明确的降级策略（本轮由任务
  提示词约束，未形成平台级门）。

---

## 8. 代码审查与修复（本轮）

`review-bugbot` / `review` skill 依赖的 `bugbot`/security-review 子代理类型在当前运行环境
不存在；本轮改用 3 个独立只读审查代理（安全、运行时、工业架构）+ 人工复核，结论如下。

### 8.1 已修复

| 严重度 | 问题 | 修复 | 回归 |
|---|---|---|---|
| High | 测试驱动路由 `delete allowPrivateHost`，HTTP 驱动 `legacyAllowPrivateWhenUnset` 在字段缺失时跳过私网校验 → editor 可 SSRF 到云元数据/环回 | DAQ/DCW/MES 三个 test-driver 路由显式写 `allowPrivateHost='false'`（仅 `AW_TEST_DRIVER_ALLOW_PRIVATE=1` 放行） | 既有 `http-drivers` SSRF 用例 |
| P0 | 消息看门狗 requeue 后，迟到回合的 `markConsumed` 无状态守卫，可把 pending/dead 消息再次标成 consumed（消息丢失/毒消息复活） | `UPDATE ... WHERE id=? AND state='consuming'` | `message-requeue-cap` 新增用例 |
| P0 | Channel 配置 PATCH 在 lead 长监督期间误判 idle → 卸载 → `abortCurrent()` 无因 → omp 归一为 external cancel → 取消在办根任务 | ① `supervise()` 进入即置 busy、落定恢复；② `channelRecycleDecision` 增加 `hasActiveWork`（在飞监督 + 未终态任务）；③ `abortCurrent(reason)` + `normalizeSupervisionAbortReason`：runtime stop 不再产生 cancel | `channel-recycle-policy`、`supervision-decision` 新增用例；实机 PATCH 复验 |
| Low | rag-bridge 只校验 `base_url`，`web_url` 可指向公网并携带 Bearer token | `web_url` 同受 `http(s)://127.0.0.1|localhost` 校验；不合法则禁用全部出站 | 插件 health/出站开关逻辑 |
| P1 | idd-closedloop-bridge 对退役路由仍注册 9 个工具，`sentinel_status` 可能把 404 报成 “status=ok” | 新增 `/health` 探针（`routesReady=false`）；status/optimizer_state 检查 `r.ok` 并显式报 404；README 标注版本边界 | 插件装载/health 实测 |

### 8.2 未修复（已记录，不宣称通过）

- HITL 审批卡未绑定 `(taskId, deliveryId, assignmentGeneration, leaseId)`；任务取消/重派后
  旧卡仍可能被批准并执行。
- 消息看门狗从 claim 起算固定 600 s，不是“回合内无活动”窗口；长任务可能被提前 abort。
- 配方 `applyRecipe` 在 60 s 门/在飞锁之前就占用 300 s trial cadence；失败也会锁 5 min。
- `unloadChannelAgents` 的配置重装仍有窄 TOCTOU 窗口；本轮已用 `hasActiveWork` 收窄。
- SDK `ctx.http` 的私网判定仅字面 host（无 DNS/重定向完整校验）；SSRF 仍有 redirect/DNS
  rebinding 面。
- `idd-closedloop-bridge` 的 9 个工具对当前 IDD 不可用（需 IDD 侧恢复路由或插件 CLI 适配）。
- Mimosa 仍 `inconclusive`，不能宣称安全通过。

---

## 9. Mimosa

- 修复前扫描：`scan-2026-11-16T06-30-18.388Z-7c8297efdd62`；
  seal `sha256:ef781c8dbaa9325f7586869f116d279e045d93bc6c6131eb7f0aa300f270f2ef`；
- 修复后扫描：`scan-2026-11-16T07-35-13.413Z-cc83e55ce50b`；
  seal `sha256:f88a20639b15768cc7256972ede8030f9a3b1977f2714eea5209a33a34dd1913`；
- 两轮均 47 findings；`runStatus=inconclusive`（threatModel/findingDiscovery partial）；
  修复后扫描对本轮 14 个改动文件 **0 命中**；
- 6 条 `server/` 命中人工复核：
  - `candidate-store.ts` 命令注入 → **FP**（纯内存 Map，无 exec/spawn/fs）；
  - `a2a/[agentId]/rpc` path traversal → **FP**（JSON-RPC dispatch/parseParams 无文件路径；
    SQL 参数化 + 同频道 token 校验）；
  - `channel-agent.repo.ts` SQL 注入 → **FP**（静态参数化 UPDATE，env 仅 Number 化）；
  - `bench-approval-only` mongo-sort ×2 → **FP**（仓库无 Mongo，仅 JS Array.sort）；
- 结论：ESLint 全绿；Mimosa 因扫描器覆盖缺口**不给出通过结论**，不能对外宣称安全验收通过。

---

## 10. 架构能力矩阵（面向用户目标）

| 目标能力 | 现有锚点 | 成熟度 | 关键缺口 |
|---|---|---|---|
| 历史 + 实时数据 | DAQ TSDB/tagged/page/frames、五协议驱动 | M3（模拟） | 真实 PLC 时序/网络/HA 未验证 |
| 参数下发 | DCW 单点写、四层限界、60 s、ACK/readback、journal、rollback、HITL | M3（模拟） | 物理执行器/急停/量纲未验证；分钟级节拍 |
| 产线/产品/配方管理 | line/product/recipe/run、绑定、窗口、回退 | M3（模拟） | 无 MES/ERP 生产调度闭环 |
| 自定义驱动 | 驱动注册表 + 插件 `ctx.daq/dcw.registerDriver` | M2 | 协议插件为进程内任意 Node 代码；S7 stub |
| RSI 学习 | ResearchOrchestrator、CandidateEvidenceStore、RSI Beta 只读 | M2 证据 / M0 执行 | **candidate-only**；promotion/actuation 硬拒绝 |
| 自动建模 | AML dataset/job/gates/registry、linear/static/hybrid | M3（模拟） | 仅内置训练器；需激励/工况分段 |
| 虚拟求解/MPC | 优化 manager + Python `linear_mpc_quadratic` / `steady_response` | M3（模拟） | 只接受线性/静态；首步下发；无非线性/物理 MPC |
| 物理知识/孪生 | physics spec/runtime、twin provider、greybox | M2 | 未接入优化 solver；twin MPC 是候选枚举 |
| 闭环调优 | optimization_explore、recipe trial/apply/rollback、IDD optimizer skill | M2/M3 | Agent 编排 + HITL；无人值守可靠性不足 |
| 本体/工况理解 | process-model context、ontology draft/approve/publish | M2 | 手动本体；无自动发现/发布；不生成约束/目标 |
| 数据分析 | EDA/SPC/analysis ledger、IDD quick-screen | M3（EDA）/M2（IDD） | 深诊断慢；外部服务 SLA |
| IDD/RAG 集成 | diag-bridge、rag-bridge、idd-closedloop-bridge | diag M2 / rag M2 / idd M0 | IDD 闭环路由退役；RAG 内部 agent 超时 |
| Channel/Project/Session | 成员/任务/消息/HITL、Project Leader、Session 上下文 | M2/M3 | seed task 冷启动/长任务生命周期 |

**落地判断：** 作为“Agent 辅助的受治理优化工作台”，可以进入**模拟线试点/只读真实线影子**；
作为“Agent 持续自主闭环控制真实产线”，**尚不能落地**。优先级：
1. 物理 HIL / FAT-SAT（真实 PLC、寄存器/字节序、OPC UA 证书、MQTT TLS、急停、独立回读）；
2. 确定性闭环 supervisor（不是纯 LLM 循环）+ 长任务生命周期/消息租约修复；
3. 物理/非线性模型接入优化 solver（当前只支持 linear/static + first move）；
4. RSI promotion/actuation 独立治理门（当前 Beta 只读、candidate-only）；
5. 自动本体/工况发现 + 人工批准后编译为约束/目标；
6. RAG/IDD 外部服务 SLA 与 `kb_agent` 内部 agent 修复；IDD 闭环插件 CLI 适配。

---

## 11. 复现

```bash
# 1) 隔离平台（生产构建）
AW_MODE=home AW_HOME=<fresh> PORT=3996 NUXT_SESSION_PASSWORD=<≥32字符> \
  AW_ALLOW_PRIVATE_OUTBOUND=1 BACKUP_DISABLED=1 node .output/server/index.mjs

# 2) 五协议模拟器（独立影子，勿用 --restart 盲杀）
node scripts/onboarding/sim-twin.mjs \
  --blueprint docs/audit/evidence/2026-11-16-line-integration-skill-demo/blueprint-4052.json \
  --sim-port 4052 --shadow <fresh-shadow>

# 3) 按 export 生成接入配置后一键接入（V2/V3 仅限隔离模拟线）
AW_BASE=http://127.0.0.1:3996 AW_TOKEN=<token> \
  node scripts/onboarding/onboard.mjs <onboard.json> --skip-connectivity --smoke

# 4) IDD 优化 skill（非根因诊断）
uv run --project <IDD>/.claude/shared/scripts python \
  <IDD>/.agents/skills/industrial-optimizer-loop/scripts/optimizer.py init/design/ingest \
  --run-dir <run-dir>
```

> 结论只适用于本次模拟协议栈、本次 commit 与本次外部 IDD/RAG 实例；真实产线须另走停线、
> 维护窗口、只读浸泡、人工批准最小步首验与三方回读，不得把本报告当作物理 HIL 或投用批准。

---

## 12. 证据索引

| 证据 | 路径 |
|---|---|
| 平台 setup / 插件健康 | `D:/tmp/aw-eval-20261116-final/setup-platform.console.log`、`setup-results.json` |
| 模拟孪生 | `D:/tmp/aw-eval-20261116-final/sim-twin.log` |
| 产线供给/锻造/验收 | `D:/tmp/aw-eval-20261116-final/onboard.log`、`verify.log` |
| IDD 优化 run | `D:/codes/myskills/industrial-deep-diagnostic/workspace/aw-exchange/opt-line-20261116/` |
| IDD trial 执行 | `D:/tmp/aw-eval-20261116-final/run-opt-trials.log`、`run-opt-r2.log` |
| Channel 消息/最终汇总 | `D:/tmp/aw-eval-20261116-final/channel-messages.json`、`channel-lead-final.txt` |
| HITL/recipe/journal | 平台 API 回读；`anc-22979153`、`rr-f8c68ba6`、`ap-0c9a2050` |
| RAG 检索/入库 | `D:/tmp/aw-eval-20261116-final/rag-ingest-response.json`、`rag-search-after-ingest.json` |
| 修复后门禁 | `D:/tmp/aw-eval-20261116-final/gates/*-after*.log` |
| Mimosa | `D:/tmp/aw-mimosa-main-20261116/scan-2026-11-16T06-30-18.388Z-7c8297efdd62/` |
| 修复后 Mimosa（如有） | `D:/tmp/aw-mimosa-postfix-20261116/` |
