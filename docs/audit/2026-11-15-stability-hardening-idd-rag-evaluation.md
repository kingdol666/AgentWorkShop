# 稳定性加固 × IDD/RAG/Channel 全系统测评报告

> 日期：2026-11-15
> 被测代码：`main@203cefe9`（含 `375e1ece` 稳定性加固与 `203cefe9` 复审修复），已推送 `origin/main`
> 环境：隔离 `AW_MODE=home` + 独立 `AW_HOME`；真实 IDD `:3210`、RAG backend `:8771` / web `:6789`；
> 5 协议 PLC 模拟器 `:4050`（ModbusTCP / ModbusRTU / OPC UA / MQTT / HTTP）；隔离平台 `:3995`
> 执行模型：omp + `ustc/deepseek-flash`（Channel 级 LLM，effort=max）
> 边界：**模拟产线（mock 五协议设备）**，不是物理 HIL；所有设备写入均未在本次 Channel 作业中发生；
> Mimosa 仍为 `inconclusive`，不构成安全通过结论。

---

## 0. 结论摘要

| 判定项 | 结果 | 说明 |
|---|---|---|
| 代码合并 / PR | **通过** | `gh pr list --state open` 为空；#215–#222 均已合并；本轮 `375e1ece` + `203cefe9` 已推送 origin/main |
| ESLint + RSI 红线 | **通过** | 21 个学习环文件 0 处设备写调用 |
| typecheck | **通过** | `vue-tsc -b --noEmit` |
| unit | **通过** | **1760/1760**（新增 10 条回归） |
| production build | **通过** | `.output` + prompts/schema.json/aml-python 资产齐全 |
| 新构建启动 smoke | **通过** | health `workshop=ready`、`daq.degraded=false`、未授权 401、Channel/Project 创建、`aw stop` 505ms 不重启 |
| Mimosa | **不构成安全通过** | 2 轮 deep scan，均 47 findings、**改动文件 0 命中**；扫描器 `inconclusive`（覆盖缺口） |
| IDD 集成 | **通过（有数据量边界）** | quick-screen（omp）完成报告回读；第二轮 349 行 completed 并产出真实结论（41 条告警=受控期望，无漂移/离群）；IDD 结果库总开关关闭 |
| RAG 检索 | **通过** | 插件 `/search` 命中 58 条真实知识（含 0.09g 锚点与适用范围限制、DOE R²/MDE） |
| RAG 入库 | **部分通过 / 外部容量阻塞** | HITL 审批→异步任务受理通过；RAG 侧 agent 540s 硬超时（`agent turn timed out`），索引未完成 |
| Channel 全链 | **通过（有编排/外部依赖缺陷）** | omp lead+worker 真实任务；lead 实际调用 `daq_query`/`diag_status`/`diag_results`/`kb_agent`/`kb_search_two_stage`；明确声明 0 设备写入；首回合曾被运行时卸载导致 10min 停滞 |
| 物理 HIL / 真实产线写控 | **未执行 / 不宣称** | 本轮全部设备为模拟五协议夹具 |

**总判断：** 架构上“数据→证据→分析→知识→决策→治理写控→回读→学习”的主干完整且写控单点收敛；
本轮实测证明 **只读诊断 + 知识检索 + omp Channel 协作**可落地。**全自主深度诊断、RAG 大规模入库、
物理闭环写控**仍不具备无条件生产证据。

---

## 1. 合并与门禁

### 1.1 分支/PR
- `main`：`203cefe9`（本轮复审修复）← `375e1ece`（稳定性加固合并）← `8bd7b646`（会话 scope 修复）← `79723a85`。
- 远端：`origin/main` 已同步至 `203cefe9`；`fix/stability-hardening-20261115` 分支已推送。
- 开放 PR：0；#215/#216/#217/#218/#219/#220/#221/#222 均 MERGED。
- 主工作树保持 `main`，论文未跟踪目录 `paper/tii/TII-SUBMISSION-PACKAGE-20261112/` 未触碰。

### 1.2 门禁
| 门禁 | 结果 |
|---|---|
| `pnpm lint`（含 `check-rsi-redline`） | PASS |
| `pnpm typecheck` | PASS |
| `pnpm test:unit` | **1760 / 1760 PASS** |
| `pnpm build` | PASS（prompts / schema.json / aml-python 已随产物分发） |
| `pnpm test:mcp` | 14 / 14 PASS |
| plugin lifecycle | 22 / 22 PASS |
| skills | 167 / 167 PASS |
| 新构建 fresh-home smoke | health ready / 401 / Channel+Project 创建 / stop 505ms |

### 1.3 Mimosa（如实）
- 两轮 deep scan：
  - `scan-2026-11-15T07-59-49.019Z-24798ef1eddc`，seal `sha256:7810c260…`，47 findings。
  - `scan-2026-11-15T08-48-28.409Z-146c3045934e`，seal `sha256:788c2bf1…`，47 findings。
- 两轮均为 **Run status: inconclusive**（部分分析阶段覆盖不足）；47 条为仓库存量（`data/workspaces`、
  `paper/`、测试脚本、i18n 文案等），**本轮 29 个改动文件 0 命中**。
- 结论：**ESLint 全绿；Mimosa 不具备“通过”结论，不能对外宣称安全验收通过。**

---

## 2. 复审发现与修复（203cefe9）

独立只读评审覆盖 `79723a85..375e1ece`，共 17 项。处理结果：

| 严重度 | 问题 | 修复 | 回归 |
|---|---|---|---|
| High | 派发失败补偿可把提交期间已取消（CANCELED）的工作项回写成 DRAFT/BLOCKED | `updateOwnedAttempt`/新增 `updateIfStates` 状态 CAS；取消时保持终态 | `project-cancel-hard-stop`：cancel+submit 失败仍 CANCELED |
| High | 驳回计划后 `planVersion` 不前进 → 项目永久无法再次提交计划 | `nextPlanVersion` 跳过 rejected；批准门允许跳过已拒绝版本；`planVersion` 仍只在批准时推进 | `project-scheduling-kernel`：reject v1 → v2 可提交/批准 |
| High | Session 历史窗口（raw/mixed）绕过产品/产线标签 | SQL 内强制 product/recipe/run/line 过滤；无 rollup 的降级分支改用 tagged 查询，缺能力 fail-closed | `daq-product-scope`：历史查询不泄漏 prod-other |
| High | 构建锁回收条件错误（死 holder 仍等 24h）＋空锁抢占竞态 | 死 holder 立即回收、空锁 60s 宽限、锁龄 2h、nonce 校验释放 | `build-lock`：死 pid/空锁/超时 |
| High | `aw init` 不复制 prompts；半产物 `.output` 可被直接启动 | init 复制 `.AgentWorkShop/prompts`；`outputAssetsReady` 校验入口+全部资产，缺失重建/补资产 | `post-build-artifacts`：资产齐全性 |
| High | `recipe_propose`/`optimization_explore` 绕过 Session 冻结产品/产线 | 两者接收 `sessionScope`，校验配方冻结版本/哈希与节点产线 | `recipe-propose`：越界产品/过期快照拒绝 |
| Medium | 默认 Session 导出因存在跨线历史绑定而整体拒绝 | 未显式指定 node_ids 时导出“Session 线 ∩ 授权”安全子集；显式越界才拒绝 | 复用 `daq-product-scope` |
| Medium | 会话关闭对账不取消 clone 任务、且会误停 project office | 对账先取消未终态任务；`instanceKind='project'` 跳过 | `session-close-recovery` |
| Medium | `migrateMissingForeignKeys` 未事务化 | BEGIN/COMMIT/ROLLBACK | `migration-contract-recovery`：注入失败整体回滚 |
| Medium | replan 复用 DRAFT 工作项仍执行旧 brief/验收标准 | 物化时刷新 brief/acceptance/budget/contract/planVersion | `project-scheduling-kernel`：v2 内容生效 |
| Medium | 升级前 pending 审批的插入序 JSON 与 canonical 比较失败 | `samePlanPayload` 语义比较；复用不可变文本 | 同上 |
| Medium | close 钩子超时强退可能留下 harness 孙进程 | 强退前按注册表杀存活 harness 进程树 + 2s 兜底 | 代码审查/类型检查 |
| Low | Session status 类型缺 `closing` | 类型补全（服务端 + 前端 composable） | typecheck |
| Low | owner-FK 重建丢失 `channel_mode` | 有列则保留；无列则按 `line_id` 推导，避免 integrated→generic 静默降级 | `migration-contract-recovery` |
| Low | 不可达分支 / warnings 恒空 | 移除不可达 `if (!attempt) continue` | lint |
| Low | `CHANNEL_PRODUCT_BINDINGS_SQL` 未纳入契约指纹 | 未改（会改变已记录 v2 指纹）；记录为已知缺口 | — |
| Medium | 历史字符串计划（`deliverables:['x']`）现在提前 400 | **有意 fail-closed**：历史宽松计划过去“批准但物化失败”；现要求 V1 对象 schema | 文档披露 |

---

## 3. 实测环境与案例

- 隔离平台 `:3995`，`AW_HOME=D:/tmp/aw-eval-20261115/home`；`AW_ALLOW_PRIVATE_OUTBOUND=1` 允许本机 IDD/RAG。
- 真实 IDD `:3210`（omp 引擎）、RAG `:8771` + web `:6789`（`aw-industrial` KB `3aea5973…`）。
- 模拟器 `:4050` 五协议注入线：`ln-7efcf83a`，14 个 DAQ 节点，配方 `rc-b85c6d3e`，活动批次 `rr-5bd49fb7`。
- 平台：12 个插件 0 failures、148 个工具；AML runtime Python 3.12.7 + venvReady + uv 0.11.29。
- 数据：16:14–16:48（+08），5s 采样，349 行 × 15 列。

---

## 4. IDD 集成实测

### 4.1 第一轮（23 行窗口，quick-screen / omp）
- run `3e233b35`：**completed**（08:42:21Z），报告 5,371 字符，经 `/api/plugins/diag-bridge/report` 代理回读成功。
- 报告结论：**UNDETERMINED / NEEDS_DATA**。
  - CP-0 输入合规：要求 ≥60 行，实际 23 行 → 不通过；
  - 基线可行：要求 ≥100 稳态行/组，实际 23–31 行 → 不通过；
  - `watch`/`build_baseline.py` 以退出码 2 拒跑，未产出 alert.json。
- 判定：这是**正确的 fail-closed**——IDD 拒绝在数据不足时编造越限/漂移结论。

### 4.2 第二轮（349 行窗口，quick-screen / omp）
- run `d6b36ac4`；`workspace/diagnostic-runs/202611150848534_ln-7efcf83a_eval2/report.md` 已生成：
  - 349 行、跨度 0.569h、11 个可用参数；
  - **41 条告警（29 high / 12 warn / 0 critical）= 3839 参数行的 1.068%**，与受控 Nelson 期望（ARL0≈90 → ~42.7 条）同量级；
  - C3：349/349 steady，变点 0；C4 稳健 z 峰值 3.15 < 3.5，补充马氏 `max_d2=18.14 < 31.43`，0 越限 episode；
  - 结论：**统计受控，无越规格/变点/均值漂移/波动放大**；仅 `dn-ac004898` 轻微上漂（0.288σ/0.569h）建议下一窗复核；
  - 同时披露数据质量：2 个节点全窗缺测、1 个节点恒值、C2 因无 DOE 操作窗而明确跳过。
- 任务状态：**completed**（2026-11-15 09:04:41Z / 17:04 +08），报告与告警工件均为终局产物（非中途快照）。

### 4.3 结果库
- `/api/plugins/diag-bridge/results` 返回 `结果库未启用(results_enabled)`：IDD 服务的**可选结果库总开关关闭**。
- 报告本身已持久化在 IDD run 目录并可经代理回读；但“分析结果结构化入库/检索”本轮**不可用**（外部配置项，不是平台缺陷）。

---

## 5. RAG 集成实测

| 步骤 | 结果 | 证据 |
|---|---|---|
| 插件健康 | PASS | backend `ok`、web 52 KB、token accepted、`aw-industrial` id `3aea5973…` |
| 直接检索 | PASS | `/api/plugins/rag-bridge/search?q=0.09g` → **58 条**，含多条「回归锚点 0.09g」、DOE R²=0.919876 / MDE=0.017482g / 保压主效应 +0.05241g/bar，并带“不适用于某些产线”的适用范围限制 |
| 入库 HITL | PASS | `kb_agent action=ingest` 生成审批 `ap-d3ebac42`，admin 批准 200 |
| 异步入库受理 | PASS | 返回 `task_id=kbt_mwhlbv6c_76ee0329` |
| 后台索引 | **FAIL（外部）** | 540s 后 `agent turn timed out after 540000ms before a final result frame` |
| Agent 检索 | **部分** | `kb_agent` 返回了真实知识摘要，但其内部 `kb_search_vector/kb_doc_read` 被 RAG 服务权限墙拦截；平台直连 `/search` 不受影响 |

判定：**平台侧 RAG 读链可用且返回真实知识**；写链（入库）受 RAG 服务内 agent 540s 硬超时与内部权限配置限制，
需要 RAG 侧修复后才可作为生产知识沉淀通道。

---

## 6. Channel 全链实测

- Channel `6cc8f225…`：`production_line_integrated`，绑定 `ln-7efcf83a`，omp lead `f9bd4b43…` + omp worker `19539a87…`，
  `llmJson={"provider":"ustc","model":"deepseek-flash","effort":"max"}`，启用 `diag-bridge` + `rag-bridge`。
- 任务下发成功；lead 实际调用：
  `daq_query`、`line_context`、`diag_status`、`diag_results`、`kb_agent(action=query)`、`kb_search_two_stage`、`kb_backend_status`。
- lead 最终汇总（2,969 字符）覆盖：数据读取、IDD 状态/结果读取、知识库检索、写入声明。
- **写入声明**：未调用 `dcw_*` / `recipe_*` / `line_start|stop` / `recipe_propose`；PLC 11 项设定值与配方目标一致且未被触碰。
- **如实缺口**（lead 自述）：① 当时 IDD run `3e233b35` 仍 running；② diag-bridge 结果库总开关关闭。
- 关于 0.09g 锚点：lead 明确回答「库内无对应锚点」，并引用更高质量证据（`ln-dd4d6163` DOE R²=0.919876、
  MDE=0.017482g、斜率 +0.05241g/bar），同时指出 0.09 不适用于当前线。**这是正确的“拒绝误用通用锚点”行为**；
  本轮的脚本断言 C7 以正则匹配到否定句中的 “0.09”，属于**测试断言缺陷**，不能据此宣称 Channel 引用了该锚点。

### 6.1 编排实测发现
- 首回合在 Channel 配置变更（PATCH llm / 加入 worker）后被 idle/runtime 生命周期停止，
  消息直到 10min 停滞看门狗 abort 后才重建 harness 重投并最终完成。
- 建议：配置变更不得卸载有待消费消息的 runtime；或消息投递后强制拉起 scheduler/重置 lastUsedAt。
  这是本轮实测的**真实编排风险**（不影响只读结论，但影响长任务可靠性）。

---

## 7. 面向用户目标的架构映射

| 产业需求 | 现有机制（代码锚点） | 本轮/既有证据 | 成熟度 |
|---|---|---|---|
| Agent 操控实际工况 | Channel/Session/Project；DCW `write()` 单点咽喉；HITL/审计；observe/manual/auto | 本轮 Channel 只读作业；既有 line 44/44、optimizer 105/105 | M2（模拟）/M3（治理） |
| 历史 + 实时数据 | 五协议驱动、TSDB（Timescale/SQLite）、tagged/page/frames、保留期 | 本轮 349 行×15 列真实采集；IDD 数据集 609 点历史 | M3 |
| 参数调控下发 | 配方/参数/节点写控；四层限界、步长、60s、活动配方窗、ACK/回读 | 既有 optimizer/line 实机（模拟） | M3（模拟） |
| 自定义驱动/多产线 | 驱动注册表 + 插件 `ctx.daq/dcw.registerDriver`；模板/节点/产品/配方/绑线 | 本轮五协议 14 节点供给、驱动实测 0 失败 | M3 |
| RSI 学习 | ResearchOrchestrator + CandidateEvidenceStore + ContextRuntime scope | 既有矩阵 31/31；candidate-only、只读、无 promotion | M2 |
| 自动建模/虚拟求解 | AML dataset/job/gates/models；ProcessModel；OSQP MPC；twin/scene | 既有 scientific 21/21、optimizer 105/105；本轮 AML venv ready | M3（模拟标定） |
| 闭环优化/数据分析 | 干预台账、判读、回退/调优；EDA/DoE；IDD 快筛 | 本轮 IDD 349 行真实快筛；既有 optimizer 闭环 | M2/M3 |
| 本体/工况理解 | Ontology draft/validate/publish；IDD ontology builder | 既有 offline 57/57；deep-run 曾卡 ontology wait | M2 |
| 物理规律/多维驱动 | ProcessModel/物理 spec、twin physics、证据门 | 既有 scientific（注入响应）；physical HIL 未跑 | M1/M2 |
| IDD 深度诊断 | diag-bridge：task/status/report/results + snapshot | 本轮 quick-screen 完成；deep 40min 预算风险仍在 | M2 |
| RAG 知识沉淀 | rag-bridge：ensureKB/kb_agent/search/experience | 本轮检索 58 条；入库 540s 超时 | M2 |
| Channel/Project/Session | 成员/任务/消息/HITL；Project Leader/工作项；Session 上下文 | 本轮 omp lead/worker + 工具调用；既有 Project 全链 | M2/M3 |

**架构判断**：主链完整且单点收敛（写控走 DCW write、证据走 CandidateEvidenceStore、授权走 ContextRuntime）。
短板不在“模块有没有”，而在**长时任务可靠性、外部服务 SLA、物理标定与本体自动闭环**。

---

## 8. 风险与优先级

### P0（生产前必须）
1. **物理 HIL**：真实 PLC/DCW/DAQ 的 ACK、回读、步限、量程、60s、急停/回退；当前全部设备证据为模拟。
2. **runtime 生命周期与消息投递**：配置变更/空闲卸载不得丢消息；长回合需按 Channel 可配置 stall/心跳。
3. **RAG 入库 SLA**：540s 硬超时、内部 kb-mcp 权限墙、索引队列与读面隔离。
4. **IDD 结果库**：开启并验证结构化结果存储；deep-run 预算/阶段化断点续跑。

### P1（试点前）
5. 插件设置/路由启动就绪竞态（本轮 PATCH 需轮询等待插件 host）。
6. RSI promotion/actuation 独立治理门与审计（当前 candidate-only）。
7. 节点元数据校验（unit/range/warn/semantics 一致性）纳入上线门。
8. `projects/service.ts`（~5.2k 行）按 plan/dispatch/deliverable 拆分，配组件级测试。

### P2
9. 帧 meta 递归净化、更多协议故障注入、Mimosa 扫描器覆盖完整化。

---

## 9. 最终判定

- **可以宣称**：`main@203cefe9` 已合并并推送；ESLint/typecheck/unit/build 全绿；稳定性复审的 6 项 High 与
  5/6 Medium 已修复并有回归；隔离实机完成 IDD 快筛（含 349 行真实结论）、RAG 检索、omp Channel 只读作业；
  最终构建启动/停机 smoke 通过。
- **不可以宣称**：物理 HIL 通过；真实产线闭环写控安全；Mimosa 安全通过；RAG 入库生产可用；
  IDD 深度诊断可靠；全自主优化闭环无需人工治理。

---

## 10. 证据索引

| 证据 | 路径 |
|---|---|
| 本轮 setup/通道/节点 | `D:/tmp/aw-eval-20261115/context.json`（含临时 token，勿外传） |
| IDD/RAG 断言 | `D:/tmp/aw-eval-20261115/idd-rag-results.json` |
| RAG 入库/审批 | `D:/tmp/aw-eval-20261115/rag-ingest-query.json` |
| Channel omp | `D:/tmp/aw-eval-20261115/channel-omp-results.json` |
| IDD run1 报告 | IDD `workspace/diagnostic-runs/202611150823305_ln-7efcf83a_eval/report.md` |
| IDD run2 报告 | IDD `workspace/diagnostic-runs/202611150848534_ln-7efcf83a_eval2/report.md` |
| Mimosa scan #1 | `D:/tmp/aw-mimosa-main-20261115/scan-2026-11-15T07-59-49.019Z-24798ef1eddc/` |
| Mimosa scan #2 | `D:/tmp/aw-mimosa-main-20261115b/scan-2026-11-15T08-48-28.409Z-146c3045934e/` |
| 最终构建 smoke | `/tmp/aw-final-smoke.log`（运行实例 `:3996`，`aw stop` 505ms） |
