# 剩余缺口修复 × 最终验收报告

> 日期：2026-11-15
> 基线：`main@1e6471f5`（上一轮测评报告）
> 本轮：缺口修复轮（工作树改动，尚未提交时本轮报告先落盘）
> 环境：隔离 `AW_MODE=home` + 独立 `AW_HOME=D:/tmp/aw-eval-20261115/home`；平台 `:3995`；
> 5 协议模拟器 `:4050`（注入线 `ln-7efcf83a`）；IDD 两套：
> `:3210`（industrial-deep-diagnostic，无 §16 结果库）、`:3211`（idd-doe-impl，含结果库）；
> RAG backend `:8771` / web `:6789`；执行模型 omp + `ustc/deepseek-flash`。
> 边界：设备为模拟五协议产线，**不是物理 HIL**；RAG 入库仍受外部服务 600s 回合超时阻塞；
> Mimosa 结论以本轮扫描输出为准，未完成前不宣称安全通过。

---

## 0. 结论摘要

| 缺口 | 状态 | 证据 |
|---|---|---|
| P0-2 runtime 生命周期/消息投递 | **已修复** | 配置变更忙/待消费时延迟重装；首轮空监督不再抢 `execLock`；实机首回合 **82s 完成**（旧路径 10min 看门狗），延迟重装日志命中 |
| P0-3 RAG 入库 SLA | **平台侧增强 / 外部阻塞仍在** | 异步超时 540s→600s（RAG 硬上限）；新增 `agent_harness` 可选引擎并实测 omp；RAG 侧仍 `agent turn timed out after 600000ms`。直连 `/search` 正常（本轮 20 条） |
| P0-4 IDD 结果库 | **已闭环（需结果库版本 IDD）** | 切到 idd-doe-impl:3211：结果库 98 条可读；新快筛 run `39044855` **completed**（164 行、23 告警），结构化结果 `result_id=39044855` 可经 `/results` 与 Agent 工具读取，报告 15,750B / HTML 118,107B |
| P1-5 插件设置启动竞态 | **已修复** | 服务端等待宿主就绪；启动后首个插件 PATCH **863ms / 200**，163 个描述符；回归测试 6 条 |
| P1-6 RSI promotion 治理 | **已核实** | 既有 REST-only 晋升门 + 证据门 + CAS + 审计；`rsi-evidence-integrity`/`rsi-channel-mode-scope`/`experience-gates` 回归通过；Agent 工具面无 promote |
| P1-7 节点元数据校验 | **已修复** | `node-metadata.ts` 在 create/patch 入口校验单位/量程/预警带/小数位/语义；`daq_query` 改为节点 semantics 覆盖模板；单测 + 实机文案验证 |
| P1-8 `projects/service.ts` 拆分 | **部分完成（plan 域）** | 抽出 `plan-schema.ts`（587 行纯函数/证据校验）与 `plan-materialization.ts`（217 行 preflight/物化），公开导出面不变；service 5.5k→4.8k；42 条 focused 全绿 |
| P2 帧 meta 递归净化 | **已修复** | 递归限深/限键/限数组/限字符串，丢弃危险键与非有限数字/循环引用；5 条回归 |
| 物理 HIL / 真实产线写控 | **未执行** | 无硬件/独占窗口，不宣称 |
| Mimosa | **以扫描输出为准** | 本轮 deep scan 结果见 §6；不完整时不宣称安全通过 |

**总判断：** 上一轮报告中的**可代码修复项**已全部落地并有负向/行为回归；IDD 结果库缺口通过
切换到含 §16 的 IDD 构建完成端到端闭环。剩余阻塞是**外部服务能力**（RAG 入库 Agent 回合）、
**外部部署选择**（结果库版 IDD）、**物理 HIL 授权**与**扫描器覆盖**，不是平台主链缺失。

---

## 1. 本轮代码修复

### 1.1 P0-2：配置变更不再打断运行中的回合

问题链（实测复现）：
1. `updateChannel` 对 workspace/scenario/LLM 变更直接 `unloadChannelAgents`，回合并发时被拆；
2. 卸载闸门只查 `messages.state='pending'`；消息被 `claim` 成 `consuming` 后到回合真正开始前
   runtime 仍可能是 `idle`，窗口内卸载会把消息留成孤儿（旧路径要等 10min 停滞看门狗重投）；
3. 新频道激活后调度器**首轮无条件** `supervise`，空频道也启动一次监督回合，与 lead 信箱消费
   共享 `execLock`，首条群聊消息被压住。

修复：
- `runtime/manager/recycle-policy.ts`：纯函数判定 `now/defer/skip`（忙、待消费、挂起 HITL → defer；
  未装配 → skip，避免额外冷启动）。
- `runtime/manager/runtime-wiring.ts`：
  - `recycleChannelAgents` / `flushDeferredChannelRecycles`：忙/有消息/审批 → 入队，idle sweeper
    空闲后统一卸载并按新配置重装；
  - `unloadChannelAgents` 上移复用，返回是否真的卸载；
  - 卸载前置闸门与 await 后复查改用 `hasUnconsumedByChannelAgent`（pending+consuming）。
- `runtime/manager/admin-channel.ts`：先落库再回收；停用/换线/执行模式变更立即收敛，配置类
  变更走延迟重装。
- `runtime/manager/state.ts`：新增延迟重装队列。
- `db/message.repo.ts`：`hasUnconsumedByChannelAgent`（pending+consuming）。
- `runtime/scheduler-loop/tick.ts`：首轮仅在存在**非终态任务**或成员忙/排队时监督；纯邮件由
  AgentRuntime 消费循环处理。

实机证据（`runtime-safe-results.json`）：8/8 PASS；首回合 82s 完成；忙时 PATCH 16ms 返回；
日志出现 `配置变更(llm)但仍有在途/待消费工作,延迟到空闲后重装`；`aw stop` 464ms 无重启。

### 1.2 P1-5：插件设置启动竞态

- `plugins/host/init.mjs`：`host.ready` 在装载/同步落定（成功或失败）后置位；失败也快速放行。
- `plugins/host/api.mjs` / `index.mjs`：导出 `pluginHostReady`。
- `system-config/readiness.ts`：`awaitPluginSettings` 区分 `not-plugin/ready/pending/unknown`，
  服务端最多等待 15s；设置 PATCH 在 `pending` 时返回 503 可重试，而不是误报“未知设置项”。
- `api/system/settings/index.patch.ts`：入口接入等待闸门。

实机：重启后首个插件 PATCH 863ms/200（描述符 163）；单测 6 条覆盖 pending/unknown/ready。

### 1.3 P1-7：节点元数据校验 + 语义覆盖

- `daq/node-metadata.ts`：create/patch 按**合并后的有效值**校验 name/unit/decimals/min/max/
  warnLow/warnHigh/semantics；拒绝 min≥max、预警带反转、预警越量程、非整数小数位、空白单位、
  控制字符。
- `daq/daq-controller/crud.ts`：两入口接入，落库前 fail-closed。
- `agents/industrial/daq-tools.ts`：`daq_query` 表头/物理意义优先节点 `semantics`，避免场景复用
  温度模板承载克重时把信号误标成“熔体/箱体温度”；帧查询同口径。

实机：最终构建 `daq_query` 输出
`■ ...part-weight(...)(制品克重(采集,g)... )单位 g ... 样本 8 点 | 均值 31.262`，语义正确。

### 1.4 P2：帧 meta/metrics 递归净化

- `daq/frame-meta.ts`：限深 4/键 64/数组 256/字符串 512，丢弃 `__proto__`/`constructor`/
  `prototype`、非有限数字、循环引用；metrics 仅保留有限数值。
- `daq-controller/ingest.ts`：帧 meta/metrics 入库前净化，防止 JSON.stringify 失败/前端空洞/
  原型污染。

### 1.5 P1-8：Project 域拆分

- `projects/plan-schema.ts`：计划 schema、DAG/契约校验、证据/验收判定（587 行纯函数）。
- `projects/plan-materialization.ts`：`preflightApprovedPlan` / `materializeApprovedPlan`（217 行），
  以 `PlanMaterializationContext` 注入仓储；事务边界仍由 service 负责。
- `projects/service.ts`：保留 façade 与原有公开 export；42 条 focused（调度内核/leader 工具/
  证据树/router/handoff/core）全绿。
- 未拆 dispatch/deliverable 大段：本轮以行为冻结优先，避免为拆文件引入状态机回归。

### 1.6 RAG 平台侧增强

- `rag-bridge/index.mjs`：异步入库超时 540s→600s（RAG `MAX_TIMEOUT_MS`）；新增
  `plugins.rag-bridge.agent_harness`（可选 omp/claude，空=RAG 默认），权限档仍固定 `default`；
  `i18n.json` 双语文案。
- 复测：claude 与 omp 均仍 `agent turn timed out after 600000ms`，说明阻塞在 RAG 内部 Agent/
  kb-mcp 链，不在平台桥接层。

---

## 2. IDD 结果库端到端（P0-4）

1. `industrial-deep-diagnostic:3210`：`GET /api/external/v1/results` → **404**，无 §16；插件
   `probeResults` 按“版本不含结果库”fail-closed。
2. 启动 `idd-doe-impl`（结果库版本）`:3211`：启动 backfill 报告 **204 条已存在**；当前 token
   可见面 **98 条**。
3. 通过平台 `diag_run`（Agent 工具，omp）提交注入线 15min 窗口快筛：
   - run `39044855`，166 行 × 14 节点快照；
   - 22:31 完成：**164 行、23 告警（high 15 / warn 8）**，报告 15,750B，HTML 118,107B；
   - 结果库新增 `result_id=39044855`，`/api/plugins/diag-bridge/results?q=ln-7efcf83a` 命中 1 条，
     `summary_json` 含 `status=alert,n_alerts=23,top_parameter`，artifacts 指向
     `sentinel/alert.json`、`quick_screen_report.html`、`watch_report.md`；
   - Agent 工具 `diag_results` 实机返回同一结果（total=1）。
4. 结论：**“数据抓取 → IDD 分析 → 结果结构化存储 → 平台/Agent 读取”已闭环**；前提是部署含
   §16 结果库的 IDD 构建。

---

## 3. Channel 全链复测

- 同一 integrated Channel（omp lead + omp worker，绑定 `ln-7efcf83a`）：
  - 首任务（DAQ+IDD 结果库）：82s 完成，配置变更未丢消息；
  - 数采恢复后任务：24 点、均值 31.258g；`diag_results` total=98；
  - 最终构建直调 `daq_query`：8 点、均值 31.262g、活动批次 `rr-5bd49fb7`/`rc-b85c6d3e`；
  - Agent 明确声明“未执行设备写入”，仅调用只读工具。
- RAG `/search` 直连正常（本轮 20 条，含适用范围限制与 0.09g/0.0574g 证据）；RAG 入库写链仍
  外部超时。

---

## 4. 门禁

| 门禁 | 结果 |
|---|---|
| `pnpm lint`（含 RSI 红线） | PASS（21 个学习环 0 设备写） |
| `pnpm typecheck` | PASS |
| `pnpm test:unit` | **1787 / 1787 PASS**（新增/更新 8 个测试文件） |
| `pnpm build` | PASS（prompts/schema/aml-python 资产齐全） |
| `pnpm test:mcp` | 14 / 14 PASS |
| plugin lifecycle | 22 / 22 PASS |
| skills | 167 / 167 PASS |
| 最终启动 smoke | health ready、插件设置 PATCH 200、DAQ 非降级、`aw stop` 464ms 不重启 |
| 实机回归 | runtime-safe 8/8；Channel DAQ+IDD 只读作业；IDD 结果库新 run 闭环 |

---

## 5. 仍未闭环（如实）

1. **物理 HIL / 真实产线写控**：本轮全部设备为模拟五协议夹具；无 ACK/回读/步限/急停的物理证据。
2. **RAG 入库**：平台侧已给满 600s 与可选 omp 引擎，RAG 侧仍超时；需 RAG 团队修内部
   Agent/kb-mcp 权限与索引链。平台读链（`/search`）正常。
3. **IDD 结果库部署**：需使用含 §16 的 IDD 构建（本轮的 idd-doe-impl）；旧构建会被能力探测
   正确拒绝，不会伪造空结果。
4. **Mimosa**：扫描器覆盖缺口仍可能导致 `inconclusive`；见 §6。
5. **projects/service.ts 完全拆分**：仅完成 plan 域；dispatch/deliverable 仍保留，后续行为冻结
   后再拆。
6. **IDD 旧结果标题乱码**：历史数据 GBK/UTF-8 混用，属外部数据质量问题；新 run 标题正常。

---

## 6. Mimosa（本轮）

- 扫描 1：`scan-job-mwhxwc4g-1691b21b86d49cef` → scanId `scan-2026-11-15T14-38-50.782Z-eb5719d9193f`，
  seal `sha256:5d2893b5d106ff0e943d65032169510e048e6dffaeb0de6c2b3d58ab571c0fc3`。
- 扫描 2（复核）：`scan-job-mwhy44bm-bd82c0d63ab869c2` → scanId
  `scan-2026-11-15T14-44-53.385Z-7695a275fa77`，seal
  `sha256:38a4cf28784ae0ecbc0aaebc8e7f006a24cb0107a8a3f7a0db66048ed32936aa`。
- 两轮均为 **47 findings**、354 包依赖扫描（offline advisory 0 命中）；扫描器
  **coverage `partial` / runStatus `inconclusive`**（威胁模型/覆盖阶段不完整）。
- 对提交 `1e6471f5..9d404f0c` 的 **31 个改动文件：0 命中**（findings 集中在
  `data/workspaces` 下历史训练脚本等存量路径）。
- 结论：**不宣称安全通过**；Mimosa 覆盖完整化前，只能作为“本轮改动面未新增静态命中”的
  辅助证据。扫描器自身在提交/推送钩子报告 `scanner_enobufs`，同样不构成通过结论。

---

## 7. 证据索引

| 证据 | 路径 |
|---|---|
| 本轮 gap-check（插件设置/结果库/节点校验） | `D:/tmp/aw-eval-20261115/gap-check-results.json` |
| runtime-safe 实机 | `D:/tmp/aw-eval-20261115/runtime-safe-results.json` |
| Channel DAQ+IDD | `D:/tmp/aw-eval-20261115/channel-data-results-2.json` |
| RAG 入库（claude/omp 两轮） | `D:/tmp/aw-eval-20261115/rag-ingest-query.json`、`rag-ingest-console-4/5.log` |
| IDD 新 run 结果 | idd-doe-impl `results` 表 `result_id=39044855`；workspace `202611151405144_ln-7efcf83a_diag/` |
| 最终平台日志 | `D:/tmp/aw-eval-20261115/platform-20261115f.log` |
| 单元/门禁日志 | `D:/tmp/unit-20261115c.log` |
