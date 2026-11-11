# AgentWorkShop 最新 main 全系统验收报告

- 验收日期：2026-11-12
- 验收基线：两轮。第一轮 `origin/main@f5058744`（PR #165–#179）；第二轮 `origin/main@19d19a4e`（追加 #176/#180/#181/#182/#183 全部合入后）
- 验收工作树：`D:/codes/ABO/aw-accept-main-20261111`（从 origin/main 新建，未改动主工作树 paper 分支）
- 运行形态：生产构建 `.output/server/index.mjs`，隔离 `AW_MODE=home` + 持久 `AW_HOME`（含 28 频道存量数据，真实升级路径），端口 3166
- PLC：隔离模拟孪生影子树 `:4044`（modbus-tcp，未触碰共享 4010 模拟器）
- 最终结论：**软件与模拟孪生范围内 10 个套件全部通过（0 FAIL），unit 1508/1508**；真实物理设备、真实 LLM 引擎、Mimosa 完整安全扫描仍是边界（见 §8）

## 0. 验收期间发现并已收口的真实缺陷（升级阻断级）

第二轮验收启动存量 home 时捕获 **PR #181 引入的真实升级阻断缺陷**：`SCHEMA_SQL` 内联的
`idx_messages_client_idempotency` 唯一索引先于 `migrateSessionContextColumns` 补列执行，
存量库启动即崩（`no such column: client_message_id`，stability-guard fatal exit）。
新库单测全绿也测不出——只有「存量数据 + 新版本」才暴露。已修复并回归：
**PR #182**（移除内联索引，统一由 `ensureSessionIndexes` 在补列后创建 + 存量库迁移回归测试），
合入后存量 home 真实升级启动成功（28 频道恢复）。这正是「拉最新 main 做实机验收」的价值直接体现。


---

## 1. 基线：最近合并的 PR 与修复内容

main 已合入 PR #165–#179，验收期间追加合入 #176/#180/#181/#182/#183：

| PR | 主题 | 修复内容 | 本轮验证 |
| --- | --- | --- | --- |
| #165 | Project 取消/终止硬停 | 开工栅栏 + 派发后 CAS + 任务树 abort | `project-cancel-hard-stop` 5/5；项目负例通过 |
| #166 | AML 数据集网格对齐 | 精确毫秒匹配 → 最近邻 + 容差 | 代码在册；**无独立回归测试（缺口，见 §7）** |
| #167/#168 | real 动作证据收窄 | 按 MV 节点（DCW + DAQ 镜像）收窄，防同批次 ACK 污染 | `process-model-evidence` 通过 |
| #169 | 调度锁外过期收口 | 锁持有顺序回归 | `scheduler-terminal-supervision` 6/6 |
| #170 | agent.block 协议面 | 帧入册/分组/harness 归因/删死字段 | `agent-blocks` 等通过 |
| #171 | Harness 能力声明对齐 | mock supervise / crush bridge / pi / HITL 证据 | `harness-capability-contract`、`harness-construction-contract` 通过 |
| #172 | agent.block 前端硬化 | 渲染防御 / 过滤对称 / 注意力同档 | `agent-block-frontend` 通过 |
| #173 | 频道工具用量 API | `GET /channels/:id/tool-usage` 聚合 | `tool-usage` 通过 |
| #174 | OMP identity 补 harness | 治理审计归因恢复 | `governance-harness-audit` 通过 |
| #175 | HITL 三族桥映射 | 纯函数 + 单测锁定 | `hitl-bridge-mapping` 通过 |
| #177–#179 | UI P0 三批 | 壳层/令牌/聊天节奏/仪表盘告警队列 | 6 页截图：0 横向溢出、0 JS 错误 |

> 追加收口（第二轮验收前合入）：PR #176（孤立实例 fail-closed 清理由独立复审 APPROVE）、#180（RSI 证据完整性，复审通过）、#181（Session 幂等/DAQ provenance/停机屏障，复审 APPROVE）、#182（升级崩溃修复）、#183（RSI live E2E 对齐 pin 属主管控）。全部 PR 关闭，无开放项。

---

## 2. 门禁与构建（T0/T1/T5）

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| Lint（含 RSI 红线） | `pnpm run lint` | ✅ 0 error；RSI 19 文件 0 设备写 |
| 类型 | `pnpm run typecheck` | ✅ 通过 |
| i18n | `pnpm run i18n:check` | ✅ PARITY OK（2883 keys，0 unresolved） |
| 文档一致性 | `pnpm run docs:check` | ✅ 87 通过 / 0 失败 |
| 单元/契约 | `pnpm run test:unit` | ✅ **1508/1508 pass，0 fail，0 skip**（含存量库迁移回归、Session 幂等并发、RSI 证据边界） |
| 生产构建 | `pnpm run build` | ✅ `.output/server/index.mjs` 生成 |
| 发布冒烟 | `GET /`、未鉴权 API、健康门 | ✅ `/`=200，`/api/workshop/aml`=401，health ok |
| 重启持久化 | 杀进程 → 同 home 重启 | ✅ activeChannels=28、wiredAgents=1 恢复 |

---

## 3. 工业基本盘：PLC 数采 / 数控 / 节点绑定 / 配方 / Agent 控制

### 3.1 产线供给（隔离孪生）

`sim-twin --blueprint` 在 `:4044` 影子树生成 `accept-inject`（2×SP + 2×PV，一阶滞后 + 增益耦合），平台 `provision-line` 供给：

- 产线 `ln-1f5733ab`，批次 `rr-49c112a3`
- DCW：保压压力SP `dw-9ef7911c`、保压时间SP `dw-11794c5e`
- DAQ：模腔压力PV `dn-ab31535a`、制品重量PV `dn-dbdd9262`
- 配方 `rc-afd9f92f`（2 参数，窗口 45–70 bar / 6–12 s）
- 采集总控 running，interval 5s
- **供给 10/10 通过**

### 3.2 V1–V6 接入验收（14/14）

| 断言 | 结果 | 证据 |
| --- | --- | --- |
| V1 数采落库（2 节点） | ✅ | 2 分钟窗内有真实样本 |
| V2 越界写拒绝（2 节点） | ✅ | 106 bar / 15 s 被量程联锁拒绝并点名约束层 |
| V3 合法写回环（2 节点） | ✅ | 53→56、9→10 回读一致 |
| V4 配方在册 + 参数映射 | ✅ | v1，2 项逐项一致 |
| V5 绑线/成员/插件（4 项） | ✅ | line 匹配、members=4、2 插件启用且无越权启用 |
| V6 受保护线零扰动 | ✅ | 写锚点全部落新线，受保护线 0 |

### 3.3 Agent 集成控制（8/8）

| 断言 | 结果 | 细节 |
| --- | --- | --- |
| lead token 轮换（Agent 身份） | ✅ | 36 字符 token |
| `recipe_trial` 挂 HITL（manual 绑定） | ✅ | 卡 `dcw-approval`，不静默下发 |
| 审批后整批下发 + 设备证实 | ✅ | 批次 `rr-53773`，保压压力SP→53 bar [证实✓] |
| DCW 回读一致 | ✅ | 53 ± 0.2 |
| 独立 DAQ 因果跟随 | ✅ | 重量 16.021 g，符合 ΔPV=0.34×ΔSP |
| 超量程候选负例 | ✅ | 审批后执行层仍拒绝（200 bar > 100 bar），设备值保持 53 |
| 未绑定 Agent 无写能力 | ✅ | 权限模型 v2 拒绝并给出可写面指引 |

> 观察（P2，非阻断）：超量程候选会先创建 HITL 卡，批准后才在执行层被量程拒绝。安全性成立（设备零变更），但建议在挂卡前做候选值预检，减少无效审批。

---

## 4. Channel 通信与 REST/WS/MCP 端到端（75/75）

`scripts/api-live-e2e.mjs` 对隔离生产实例运行，11 个章节全通过：

- Agent 模板 CRUD + 实例化；Channel CRUD/activate/成员
- Task 生命周期（goal/loop/pipeline）、dispatch/report/complete/cancel、parent/child 聚合
- Bearer 作用域：跨频道列表隔离、读详情 403
- A2A 点对点、mailbox 拉取、频道消息历史（API messageId == 历史 id）
- `agents/subscribe` 订阅
- WebSocket Hub：`task.status`/`task.progress`/`a2a.artifact`/`a2a.message` 广播
- MCP Streamable HTTP initialize + tools/list（≈25 工具）

---

## 5. Project / SuperAgent 任务下发架构（14/14）

场景：Project（mock leader，autoDispatch，planApprovalRequired）+ 双成员频道 A/B + 跨频道依赖链。

| 断言 | 结果 | 证据 |
| --- | --- | --- |
| 计划审批门（planVersion） | ✅ | v1 批准后才允许派发（生产语义，不绕过） |
| W1 自动派发到 A 的**任务实例频道** | ✅ | 实例 `7cbd5acd…` ≠ 模板频道 |
| W2 依赖解除后跨频道接力到 B | ✅ | 实例 `aa2037f1…`，root 完成 200 |
| W3 回到 A 完成 | ✅ | 3 项 COMPLETED，3 个不同实例 |
| Reconciler 生成成果 | ✅ | results=3（draft） |
| 可观测摘要 | ✅ | workItems=3, byState.COMPLETED=3, progress=1 |
| 负例：绑定不存在频道 | ✅ | 404 NOT_FOUND，不静默成功 |

结论：SuperAgent 设计下的「Leader 提案/计划 + 确定性内核派发 + 任务实例隔离 + 跨频道依赖接力」在最新 main 上工作正常。

> 历史 demo `track-d`（2026-11-05）仍假设 root 在模板频道，与 2026-11-07 引入的任务实例架构不一致；属脚本陈旧，不是产品缺陷。

---

## 6. RSI：全链与多轮持续学习

### 6.1 全链实机（32/32）

`acceptance-rsi-live-e2e.mjs`（独立 home + 生产构建 + 真实 SQLite/HTTP + mock 驱动）覆盖：

- 任务终态 → 经验 candidate（taskIds 证据）
- 证据门 fail-closed：单任务拒绝晋级
- 项目任务实例 + write_intent + HITL 双批准 → line_start / recipe_trial 设备证实
- 独立回读 mismatch → L1 review 409 阻断（False-Done 拦截）；match → 通过
- 评审经验 + kb_ingest 候选；合并 2 任务 → validated；同线跨 Channel 读回、异线零命中
- Bench 配对 → Profile shadow→active 门（benchRunId provenance；自报数字被拒）；preview 注入 pinned 经验 + 隔离声明 + advisory
- 回滚单 active；元层成功率；验证台账；RSI 红线 0 设备写

### 6.2 多轮持续学习（10/10）

同一持久环境连续三轮：

1. 第 1 轮：2 个独立任务 → 2 条 candidate；单条晋级被拒
2. 第 2 轮：合并证据 → validated → Profile candidate→shadow→active（benchRunId）→ 注入预览含 pinned 经验
3. 第 3 轮：新任务继续沉淀 candidate；已 validated 经验不回退；注入文本仍含已验证经验

结论：RSI「任务→经验→门→注入→再学习」闭环可重复，经验在后续回合不丢失、不被新候选覆盖。

---

## 7. 近期 PR 定向复现与回归

| 组 | 命令/对象 | 结果 |
| --- | --- | --- |
| PR165/167/168/170/172/173/174/175 | 7 个定向测试文件 | ✅ 66/66 |
| PR169/171 + AML 作业 | 4 个定向测试文件 | ✅ 46/46 |
| PR177–179 | 6 页真实浏览器截图 | ✅ overflowX=0，JS errs=0 |
| PR166 | 代码审查 | ⚠️ 修复在册（`dataset-builder.ts` 最近邻 + maxInterpMs），**未找到独立回归测试**；建议补“双节点异相位网格”用例 |

发现清单（均非阻断）：

1. **P2** recipe_trial 超量程候选先挂卡、后执行层拒绝（建议挂卡前预检）。
2. **P2** PR166 缺独立回归测试（本次未跑真实 AML 数据集构建，属验证缺口而非功能失败）。
3. **P3** health `mode` 字段来自 `config.yml` 标签（显示 dev），不代表运行形态；建议文档澄清。
4. **P3** 历史 demo `track-d` 未适配任务实例架构。
5. **开放** PR #176 未合入 main；其 review 仍 REVISE（孤立实例 runtime 清理失败路径）。

---

## 8. 边界与未覆盖面（如实声明）

- **PLC 为模拟孪生**（modbus-tcp 影子树），非真实物理设备；未执行真实 PLC 割接与三方对照。
- **Agent 引擎为 mock**（确定性 E2E 快进）；真实 OMP/deepseek 模型未在本轮配置与运行。
- **AML/Python 训练链**未在本轮跑真实数据集构建；PR166 仅代码 + 相关单测。
- **Mimosa 完整安全扫描**未在本轮完成，不宣称安全通过。
- 本轮验收对象为 `f5058744`；PR #176/#PR3/PR5 的加固分支均未合入，不属本次结论。

---

## 9. 证据索引

- 截图：`docs/audit/evidence/2026-11-12-main-acceptance/shots/`
- 多轮 RSI：`multi-round-rsi.json`
- Project 下发：`project-multichannel.json`
- Agent 控制：`agent-control.json`
- RSI 全链：`rsi-live-report.md`
- 静态门禁日志：`aw-t0-*.log`

## 10. 一句话结论

最新 main 在**生产构建 + 隔离环境 + 模拟孪生**下，PLC 数采/数控/绑定/配方/Agent 治理、Channel 通信、Project/SuperAgent 任务下发、RSI 全链与多轮持续学习全部通过（9 套件 0 FAIL）；真实设备、真实 LLM 与完整安全扫描仍为后续边界。
