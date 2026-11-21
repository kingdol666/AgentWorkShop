# AgentWorkShop 受治理的产品经验复用与真实产线就绪 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **状态：计划文档，尚未实施。** 当前交付仅更新 Markdown；下述执行、提交、合并、部署及现场操作各以对应授权为准。第 6 节规定实施前复审、分 PR 门禁和合并后主干审计；独立评审未返回完整结论的场次不计通过。源码阅读基线是工作区 `HEAD cf9dfab3`，开始每批前须在远端 `main` 上重新锚定；历史实测不视为对该 HEAD 的重验。本文件不是变更单、现场作业票或产品安全结论。

**Goal:** 让 AgentWorkShop 稳定完成产品设计与受治理的产线作业，使后续任务能主动获取或自动使用适用、可追溯、可撤回的经验，并验证使用经验是否改善实际交付。

**Architecture:** 在现有 Channel/Project、Session、DAQ/DCW、HITL、Ontology 和 AML 之上增量建设：宿主冻结上下文，将事实、主张、证据、验证与部署分开，以同一个经验解析器服务检索、注入和运营界面。经验治理与运行韧性独立施工，在隔离的软件和模拟线验收汇合；真实现场准入另行负责和签核。

**Tech Stack:** TypeScript、Zod、Nuxt/Nitro REST、Workshop WebSocket、Node `node:sqlite` 与现有事务/租约、FTS/sqlite-vec、Node test + `tsx`、OMP RPC、IDD/RAG bridge、DAQ/DCW、Ontology compiler、AML/ONNX。

**Spec:** [RSI 证据驱动晋升与产品经验闭环](../../plans/2026-11-17-rsi-evidence-promotion-product-memory-plan.md) §§全局约束、3–7；[Operational Context & Research Learning Framework](../../plans/2026-11-13-operational-context-research-learning-framework.md) §§1、5、6；[RSI Beta Boundary ADR](../../architecture/2026-11-13-adr-rsi-beta-boundary-contract.md)；[既有生产就绪加固计划](2026-11-13-production-readiness-hardening.md)。本计划落实其中与真实运行直接相关的子集，不替代全领域框架计划，不改写 Beta ADR。

## Global Constraints

- 经验可作为低可信参考数据，永不成为系统指令、工具授权、设备写入或安全限值的权威。所有物理动作继续由现有 DCW、权限、HITL、设备限界和审计链控制。
- 不复制新的 SchedulerLoop、HITL 机制、设备网关或审批权威；采用宿主单一策略及显式生命周期调用，所有外部候选经边界校验后进入相同核心权威。
- `line/product/recipe/run` 只能由现有工业适配器提供映射、查询过滤和兼容视图；不能成为通用研究 API 的必填参数。
- Ontology 只提供语义、证据和约束编译输入，不成为第二个控制权威；编译产物只能收紧现有约束，不能放宽安全边界。
- Beta 默认关闭、只读、candidate-only；Beta 派生物继承来源限制，当前 ADR 下不得晋升。首版自动晋升关闭；未来只读低风险类别的自动晋升须单独 ADR、授权和评测，不是本计划默认交付项。
- 现场实时控制、联锁、急停和手动接管仍由 PLC/SIS 与现场人员负责。LLM 只在监督层分析、解释和提议。未知效果不得自动重发；不通过延长超时、换模型或回滚经验绕开写控治理。
- 来源、身份、授权、环境、版本或适用性未知时，对相关经验拒用，不回退宽域。模拟、物理 HIL、生产、离线与人工证据分开；哈希证明内容完整性而非事实真实。不得把凭据或敏感全文复制到提示、日志或公开证据。
- 新功能不自动部署。版本迁移、旧写入口防护、所有经验读取入口白名单为同一可回退发布单元。普通会话记忆的用途和受权可见性保持兼容；工业作业中未分类历史知识默认不自动注入。不得通过直接降级旧程序恢复有缺陷的行为。
- 不放宽出站安全守卫，不把历史隔离环境例外当生产默认。不将不完整的 Mimosa 结果、模拟控制或源码合同测试当安全认证、现场准入或浏览器验收。

## Review Focus

1. **旧批准或未知设备效果：** 重启、换代或网络中断后不复用旧许可、不盲重发；Task 8 `old_approval_and_unknown_effect`。
2. **同线换产品且 harness 仍保留旧提示：** 自动、主动、管理读取与旧会话恢复都不得携带 A 的经验到 B；Task 4 `product_switch_revokes_all_read_paths`。
3. **不同 task ID 同源或不同工艺变量：** 重试和不相容主张不能冒充独立证据；Task 3 `rejects_retries_and_incompatible_claims`。
4. **同键重放、证据失效或审计故障：** 已审正文不得变；撤销、过期和缺审计确认版本不得上线；Tasks 2、6 `replay_does_not_rewrite_validated_claim`、`release_stays_off_until_durable_audit`。
5. **模型看似正常但采样/关键约束不可观测：** 缺数可见，未知不是通过；Tasks 11、12 `critical_sample_gap_blocks_use`、`unknown_coupling_and_unobservable_guard`。

---

## 1. 源码、前后端与历史实测对账

### 1.1 用户真正要解决的问题

从产品经验、通用运营上下文、生产加固计划和近期两轮实测可以归纳出一个目标：**把一次作业的判据、工况、结果和失败条件保留下来，让下一次作业在正确上下文中用对它；任务遇到模型、设备或服务故障时，系统能安全暂停、解释并恢复。** 三个概念必须分开：工业 **product** 是品种及其配方/工况；非产线**设计产品**是有版本的业务对象；**Project** 是计划、工作项和交付物容器。同 Project handoff 不是跨项目复用，同产线也不等于同产品。

| 能力 | 证据支持 | 不能据此宣布 |
|---|---|---|
| 产线集成与数采数控 | [11-15 闭环与割接](../../audit/2026-11-15-doc-to-simulated-plc-closed-loop-acceptance.md) 记录闭环 8/8、割接 12/12。11-19 三端轮有 [独立回读 53=53](../../audit/evidence/2026-11-19-three-system-acceptance/phase-c-c2-readback.json) 与 [journal 关联](../../audit/evidence/2026-11-19-three-system-acceptance/phase-c-c2-journal.json)；[另一轮](../../audit/evidence/2026-11-19-integrated-live-round/REPORT.md) 又观察到 55=55、4=4 和越界/跨用户拒绝。 | 这些设备是带归属证明的影子孪生；真实模型调用、网络协议和工具回合不等于物理 PLC/HIL。读回相等不等于克重进目标带或长期优化收益。S7 当前显式未实现，MQTT broker ACK 不等于设备证实。 |
| Channel / Project | [三端轮](../../audit/evidence/2026-11-19-three-system-acceptance/REPORT.md) 一条 Project 第一次失败、第二次完成，经 L1/L2；另一次集成轮验证了派工、跨频道消息与 handoff 门；落地页设计简报和文案落盘。 | 后一轮产线 Project 尾项及落地页 HTML 实现未收口；设计稿不等于可运行交付，消息送达不等于已采用。 |
| RSI 与产品知识 | [11-16 记忆工具](../../audit/2026-11-16-line-integration-memory-tools-acceptance.md) 支持线索自动注入、主动检索和跨频道用例。11-19 三端轮候选、单样本拒绝、合并、人审、Agent 401 均实测，模型召回未完成。另一次集成轮 [班中回报](../../audit/evidence/2026-11-19-integrated-live-round/phase-c2-c5-reply.json) 记录了主动检索命中，包含共享 semantic 与 line experience。 | 不能只凭回报里的 dedupKey 字符串把 semantic 写入定为治理后的 line 经验。不能将 API 命中或人审 `validated` 当作同产品新任务获益、持续自动学习或可扩散到别的产品。 |
| IDD/RAG/AML | [选定矩阵 16/16](../../audit/evidence/2026-11-19-three-system-acceptance/final-verification.json) 和 [761 个真实模型回合](../../audit/evidence/2026-11-19-three-system-acceptance/model-provenance.json) 有盘上来源；IDD 一次 quick-screen 完成入库，RAG 文档面可用。本轮 AML 训练网格过稀，质量门按设计拒绝。 | 不是完整故障矩阵、外部服务 SLA、真实 MES、全量前端或物理安全验收。`kb_agent` 内部链和 IDD 长窗要单独验收。 |

### 1.2 当前前后端的真实路径

| 作业 | 路径和权威 | 可见性短板 |
|---|---|---|
| 产线点位与操作 | [`useTownNodeBindings`](../../../app/composables/workshop/town/useTownNodeBindings.ts) 管设备/场景表现；Agent 成员绑定独立授权。DAQ/DCW 页面由 [`useDaqStream`](../../../app/composables/workshop/useDaqStream.ts)、[`useDcwStream`](../../../app/composables/workshop/useDcwStream.ts) 消费 REST 快照与 WS。Agent 提议/HITL 后由 DCW 验证范围、节拍与回读，详见 [`write.ts`](../../../server/services/workshop/dcw/dcw-controller/write.ts) 和 [`actuation.ts`](../../../server/services/workshop/dcw/dcw-controller/actuation.ts)。 | UI 和方案不能替代服务端授权；要分别显示已申请、已批准、已发送、已回读及效果判定。 |
| Project | [Project 页](../../../app/pages/projects/[id].vue) 读取审批、工作项、成果等；[`service.ts`](../../../server/services/workshop/projects/service.ts) 执行计划审批、事务物化、依赖门、实例派发、评审。 | 同一计划状态分散在审批和观测投影，前端难解释“等批准/已物化/为何不能建项”。 |
| 经验 | [`reflect-collector`](../../../server/services/workshop/runtime/memory/reflect-collector.ts) / [`reflector`](../../../server/services/workshop/runtime/memory/reflector.ts) 将终态、评审和干预判读变为记录；[`recall`](../../../server/services/workshop/runtime/memory/recall.ts) 自动简报/引子，另有主动 `search_memory`、跨频道、Profile pin/advisory。 | [MemoryPanel](../../../app/components/workshop/MemoryPanel.vue) 主要是普通记忆；经验版本、产品适用性、可用状态、被哪些回合使用没有统一人审面。`auto` 的会话相关性加分不是严格 session 隔离。 |
| 本体与模型 | [`ontology.service.ts`](../../../server/services/workshop/ontology/ontology.service.ts) 有草稿、绑定、人工审核和版本；[`ontology-learning.ts`](../../../server/services/workshop/aml/ontology-learning.ts) 把干预证据回灌，不自动修改本体。[`model-backed-provider.ts`](../../../server/services/workshop/aml/twin/model-backed-provider.ts) 可使用训练产物驱动孪生 rollout，通过谱系守卫约束复用。 | 文档/任务经验到可审核本体候选仍缺链路。工件可推演不等于可执行，本体也不是控制授权。 |

### 1.3 真问题、根因与优先级

P0 指**阻断相关功能放量**，并不表示已经发生生产事故。按“实际复现”“源码确认”和“验证未覆盖”分开。

| 级别 / 类型 | 根因与证据 | 影响与处置 |
|---|---|---|
| P0 · 源码确认，未证实生产改写 | [`memory.repo.ts:178–197`](../../../server/services/workshop/db/memory.repo.ts#L178) 同键更新保留 `validated/retired` 与旧证据，仍替换正文、scope、结论等字段；普通与经验 upsert 共用键空间。 | 已审标签可能随旧证据留在新主张上；Task 2。 |
| P0 · 实际触发 + 源码确认 | [R1/R2 候选](../../audit/evidence/2026-11-19-integrated-live-round/phase-c2-c4-candidates.json) 分别为保压压力和保压时间，[合并返回](../../audit/evidence/2026-11-19-integrated-live-round/phase-c2-c4-merge.json) 却以同一基行合并两任务。 [`promote.ts:43–105`](../../../server/services/workshop/experience/promote.ts#L43) 未检查产品、变量或极性相容；[`gates.ts:75–123`](../../../server/services/workshop/experience/gates.ts#L75) 计不同 task ID，不验证独立数据来源。 | 当前通过实例是治理入口实证，不是同一假设的复验；Task 3。 |
| P0 · 源码确认，未观察到生产泄漏 | [`reflect-collector.ts:77–123`](../../../server/services/workshop/runtime/memory/reflect-collector.ts#L77) 任务事实只解析 line，未绑定产品/配方版本/批次和已使用经验。 [`reflector.ts:123–181`](../../../server/services/workshop/runtime/memory/reflector.ts#L123) 频道反思可以 `active`，包含 `[anecdotal]` 内容；[`state.ts:36–63`](../../../server/services/workshop/runtime/memory/state.ts#L36) 自动召回没有排除这类 active 条目；L0、Profile 和 advisory 有独立装配。 | 未验证内容有资格进入提示，且无法事后准确回答“回合用了哪版经验”；Tasks 3–4。 |
| P1 · 源码确认，近期漏记未证实 | 反射失败不阻塞主线，但现有经验反射没有覆盖三类来源的持久 outbox；[`reflector.ts:285–334`](../../../server/services/workshop/runtime/memory/reflector.ts#L285)。[`bench-run.ts:1–13`](../../../server/services/workshop/experience/bench-run.ts#L1) 仍信任客户端逐样本来源，复算不能证明宿主真实跑过。 | 崩溃可能漏学，评测不能作为自动生产授权；Tasks 5–7。 |
| P0 · 运行中断实测；精确外部归因待证实 | [独立集成轮](../../audit/evidence/2026-11-19-integrated-live-round/REPORT.md) 记录慢回合、硬超时、RPC ready 超时、`PROCESS_EXIT` 重建及隔离 AW 停止监听；[配置证据](../../audit/evidence/2026-11-19-integrated-live-round/phase-s-settings-patch.json) 支持 900000 ms root/supervise 窗。串行和重复尝试放大故障，缺可观测且有界的降级策略。 | 不能仅凭报错证明 USTC 整体停机或 AW 退出的因果，也不把报告中约 70% 估算当测量；Task 10 拆分提供方/RPC/进程/预算/排队。 |
| P1 · 重复、待批不可见均实测 | 当前 [`createWorkItem`](../../../server/services/workshop/projects/service.ts#L735) 缺待批计划冲突检查，观测投影不能对齐 pending 卡。现行源码[在批准事务调用物化](../../../server/services/workshop/projects/service.ts#L2487)。 | 历史约 15 分钟是提案到观测物化的区间，不等于物化事务耗时；保留现有事务，补互斥和时间戳；Task 9。 |
| P0（现场前） · 源码确认，未观察到越权写 | [`tool-approvals.ts:438–449`](../../../server/services/workshop/agents/tool-approvals.ts#L438) 以 task/代次/lease 关联进程内审批；[`hitl-request.repo.ts:17–22`](../../../server/services/workshop/db/hitl-request.repo.ts#L17) 持久行没有这些关联。启动对账可以关闭旧等待，不足以还原旧请求所属 attempt 和可能的设备效果。 | 保持重启 fail-closed，增加关联和明确对账理由，不尝试“恢复旧批准”；Task 8。 |
| P1 · 运行复现，责任分层 | [IDD/RAG 契约轮](../../audit/evidence/2026-11-18-idd-rag-plugin-v1-contract/REPORT.md) 有 2312 行长窗 30–40 分钟未达终态；RAG 文档绿但内部 Agent 超时。DAQ 有界缓冲可丢项，网格不足已在三端轮触发门拒。 | 不能靠增加 timeout 或只看 health 200；分别跟踪外部终态和平台证据质量；Task 11。 |
| P1 · 设计缺口 / 源码确认 | [`ontology-learning.ts:94–141`](../../../server/services/workshop/aml/ontology-learning.ts#L94) 已发布图无匹配边返回 `false`，未声明不等于已否证；[`model-backed-provider.ts:290–325`](../../../server/services/workshop/aml/twin/model-backed-provider.ts#L290) 建议模式下部分缺测项为 `passed:true` 加文字说明。 | 不能外推为物理验证；本体“缺边”“否证”及模型“缺测”“已验证”须结构化区分；Task 12。 |

**非现存缺陷的证据：** 首捕错把派工当最终回报、查团队记忆而非 lead 私有经验、journal 形状解析误判均是取证脚本问题，不是存储丢数据。历史配置更新误回收活跃 runtime、看门狗误终止有[修复记录](../../audit/2026-11-15-gap-closure-final-acceptance.md)和[复测](../../audit/2026-11-16-round2-fixes-full-acceptance.md)，只保留回归，不冒充本轮新缺陷。其他未覆盖面参见[完整度报告](../../audit/2026-11-19-system-completeness-final-report.md)。

## 2. 文件结构、契约与发布顺序

路径相对仓库根。标为 Create 的文件只在后续授权后创建。模块缩写：`SW=server/services/workshop`，`API=server/api/workshop`。

| 子项目 | 边界与主要复用点 | 独立交付物 |
|---|---|---|
| E · 产品经验治理（Tasks 2–7） | `SW/experience/` 的版本、证据、解析、评测、发布与反射模块；复用记忆数据库、架构中的 ContextRef、Session 快照、FTS/向量、现有权限、outbox、记忆 REST 和 MemoryPanel。 | 先封堵错用，再接入可信发布和人审运营；不要求先上现场。 |
| R · 运行韧性（Tasks 8–11） | `SW/agents` 的 HITL/OMP、`SW/projects` 批准/派发、`SW/runtime` 监督、`SW/daq`、现有 IDD/RAG bridge。 | PoC 即可验守卫、队列和故障恢复；不依赖新 RSI 自动功能。 |
| A · 模型与验收（Tasks 12–14） | 复用本体人工发布、AML registry/lineage、隔离 onboarding/孪生、现场 runbook；只增加模型候选/评测适配和验收取证。 | 本体/工件各自证据；联合演示；现场清单与真实放行分开。 |

**术语与持久契约：** Task 2 在 `SW/experience/types.ts` 定义：`TrustedLearningContext`（宿主构造，actor、channel/session、授权版本 `epoch`、`subjectRef`、环境；工业投影可选 `{lineId, productId, recipeRevision, runId}`）；`VersionDraft`（结构化主张、范围、证据快照、幂等键）；`ExperienceVersion`（`experienceId`, `versionId`, `claimOriginId`, `scope`, `contentHash`, `evidenceSnapshotHash`）；`EvidenceRef`（来源/版本/哈希、环境、时间窗、attempt/run、输入及注入血缘、支持/反证/未知、授权范围）；`ArtifactUseDecision`（`decisionId`, `versionIds`, `contextEpoch`, `policyVersion`, `reason`）。通用对象只需有权威 `subjectRef` 和版本，兼容[既有 ContextRef 契约](../../../server/services/workshop/rsi-adapter/contracts.ts)。生命周期 `candidate → evaluating → validated` 和部署 `shadow → canary → active` 独立；`legacy-unverified/contested/quarantined/retired/expired/superseded` 不用于自动注入。

**顺序与门：** Task 1 先做；经验支线 `2 → 3 → 4 → 5 → 6 → 7`，其中 2–4 同一合并单元，5–6 默认关闭新路径直至门禁满足。运行支线 `8 → 10 → 11`，Task 9 可在 §6.3 文件所有权约束下并行。Task 12 依赖 3、6；Task 13 依赖 7–12；Task 14 的软件交接文档依赖 13，真实现场授权独立；Task 15 只针对所有纳入 PR 合并后重新从远端取得的主干。每项 Step 5 是独立评审/提交点，按 §6 执行；文档、软件提交、远端合并、部署和现场权限互不替代。

**验证惯例：** 下面的断言是测试最小规格，测试夹具在该测试内构造；环境准备须由获准的既有开发流程完成。红灯必须命中行为，不接受依赖缺失当复现。使用 `pnpm exec tsx --tsconfig .nuxt/tsconfig.server.json --test <files>`；每任务列出精确文件。下文未执行任何命令或步骤。

## 3. Implementation Tasks

### Task 1: 冻结证据口径与当前基线

**Files:** Create `scripts/_audit/governed-learning-evidence.mjs`、`tests/governed-learning-evidence-baseline.test.ts`、`docs/audit/governed-learning-baseline-schema.md`。现有报告和 JSON 仅读。

**Interfaces:** Consumes 两个独立验收 run 和各自环境声明。Produces `BaselineManifest`（`revision`, `runId`, `environment`, `modelProvenance`, `checks`, `missing`, `captureHashes`）及 `classifyEvidenceCheck(input: CheckInput): CheckStatus`（`scripts/_audit/governed-learning-evidence.mjs`，由 Task 13 复用）。`CheckInput` 包含 `execution: 'not_started' | 'incomplete' | 'terminal'`、`blockedReason?: string`、`passed?: boolean`；`CheckStatus = 'PASS' | 'FAIL' | 'PARTIAL' | 'BLOCKED' | 'NOT_RUN'`。独立检查有明确阻断原因优先判 `BLOCKED`；否则未执行为 `NOT_RUN`，未完为 `PARTIAL`，终态按真实判据判 `PASS/FAIL`；缺判据不得通过。

- [ ] **Step 1: 写失败测试。** `missing_or_unfinished_is_not_pass`：`assert.equal(classifyEvidenceCheck(nonTerminalWith16SelectedChecks), 'PARTIAL')`；`assert.equal(classifyEvidenceCheck(physicalNotRun), 'NOT_RUN')`。
- [ ] **Step 2: 确认红灯。** Run `pnpm exec tsx --tsconfig .nuxt/tsconfig.server.json --test tests/governed-learning-evidence-baseline.test.ts`；预期缺少分类契约或上述断言失败。
- [ ] **Step 3: 实现基线分类与清单。** 将机制、收益、韧性、现场准入的分母单列；区分真实模型/模拟/历史构建；记证据路径、哈希、未完成项及原因。盘点旧记忆类别、无来源/无上下文条数及重复 active Profile，仅保留脱敏计数。将排队、活跃执行、等待 HITL、恢复和 DAQ 质量定义为独立测量项；数值 SLO 由负责人依据后续获准的影子基线事前冻结，未冻结不判达标。
- [ ] **Step 4: 确认绿灯。** 重跑 Step 2；预期 PASS、未终态不计交付、历史或模拟不能被计入物理准入。
- [ ] **Step 5: 独立评审。** 获准后提交 `test: fix governed learning evidence baseline`。

### Task 2: 不可变经验版本与迁移

**Files:** Create `SW/experience/{types,versions}.ts`、`tests/governed-experience-versions.test.ts`；Modify `SW/db/memory.repo.ts`、`SW/db/database/migrations-experience.ts`、`SW/runtime/memory/write.ts` 和现有删除/频道清理入口。

**Interfaces:** Consumes Task 1。Produces `createExperienceVersion(input: VersionDraft, expectedPreviousVersionId: string | null): ExperienceVersion` 与 §2 类型；新增版本和证据绑定同一事务，错误码 `EXPERIENCE_VERSION_CONFLICT`。

- [ ] **Step 1: 写失败测试。** `replay_does_not_rewrite_validated_claim`：`assert.equal(after.contentHash, before.contentHash)`、`assert.equal(after.evidenceSnapshotHash, before.evidenceSnapshotHash)`、`assert.notEqual(changedClaim.versionId, before.versionId)`；跨 kind 同键记忆不能覆盖经验，并发前版本只允许一次推进。
- [ ] **Step 2: 确认红灯。** Run `pnpm exec tsx --tsconfig .nuxt/tsconfig.server.json --test tests/governed-experience-versions.test.ts`；预期原地更新、共享键冲突或缺版本契约导致 FAIL。
- [ ] **Step 3: 实现版本存储。** DB 级 kind 隔离，重放同幂等键/同内容返回原版本，正文、证据或范围变化创建 candidate。在迁移事务内记录旧 ID→新版本映射及旧状态供审计；普通记忆不重分型，旧经验保留 `validated/retired` 等历史事实，但没有可解析且与原主张绑定的来源、环境和产品上下文就标 `legacy-unverified`，即使历史状态为 `validated` 也不继承部署许可；`retired` 保持不可用。启动开放读取前须完成回填并启用 Task 4 全入口白名单；回填失败则不启用新治理读写，不允许旧程序读取新治理数据。验证备份恢复和迁移幂等；不兼容旧二进制不能直接回退，改走恢复备份及事件对账。授权删除/撤销传播至部署、派生索引、缓存；按保留政策留最小审计，不永存敏感全文。
- [ ] **Step 4: 确认绿灯。** Run `pnpm exec tsx --tsconfig .nuxt/tsconfig.server.json --test tests/governed-experience-versions.test.ts tests/rsi-experience-lifecycle.test.ts tests/rsi-evidence-integrity.test.ts`；预期旧版不改写、旧引用可对账、重复迁移和恢复通过。
- [ ] **Step 5: 独立评审迁移。** 获准后提交 `fix: protect immutable experience versions`。

### Task 3: 绑定可信上下文与独立证据

**Files:** Create `SW/experience/{evidence-ledger,claim-cluster,trusted-context}.ts`、`tests/governed-experience-lineage.test.ts`；Modify `SW/agents/session-snapshot.ts`、`SW/runtime/memory/{reflect-collector,reflector}.ts`、`SW/experience/{gates,promote}.ts`。

**Interfaces:** Consumes Task 2 类型与 [`trustedSessionBindingIdentity`](../../../server/services/workshop/agents/session-snapshot.ts#L39)。Produces `buildTrustedLearningContext(input: HostExecutionRefs): ContextResolution`，`HostExecutionRefs` 是宿主认证主体与已持久化的任务/会话引用，`ContextResolution = { ok: true; context: TrustedLearningContext } | { ok: false; reason: 'TRUSTED_CONTEXT_UNAVAILABLE' }`；`classifyEvidence(refs: readonly EvidenceRef[], context: TrustedLearningContext): EvidenceDecision`（`supportUnitIds`, `refuteUnitIds`, `excludedReasons`）；`proposeClaimCluster(versions: readonly ExperienceVersion[]): ClaimClusterProposal`（`compatible`, `reasons`, `versionIds`）。

- [ ] **Step 1: 写失败测试。** `rejects_retries_and_incompatible_claims`：`assert.equal(sameInputDifferentAttempt.supportUnitIds.length, 1)`、`assert.equal(pressureVersusTime.compatible, false)`、`assert.equal(productAVersusB.compatible, false)`；复述曾注入的主张不算新增外部证据。
- [ ] **Step 2: 确认红灯。** Run `pnpm exec tsx --tsconfig .nuxt/tsconfig.server.json --test tests/governed-experience-lineage.test.ts`；预期当前按不同任务 ID 或同频道合并无法通过。
- [ ] **Step 3: 实现宿主证据门。** `actor` 从宿主认证或任务执行主体解析，`epoch` 来自可撤销的持久授权版本，不能用绑定修订代替。工业 subject/line/product 取已校验的会话快照；承诺配方约束或执行效果时，须从实际批次/干预事实解析 runId 和唯一 recipe ID+version+hash，并与快照版本匹配，不取列表第一项；环境取原始事件的宿主来源记录，不信 prompt。通用 `subjectRef` 来自授权的 Project/设计对象引用；构造失败不授予复用资格，原观察可保留待审，不降级到宽域。绑定 attempt、时间窗、源数据和实际注入版本；不按同线/时间猜因果。按产品、变量、量纲、方向、工况和版本判定主张兼容，语义相似只供提议。量化 E2 需要首观察后至少两个相同主张的独立支持单元；同源、重放、不同参数、模型自述不计。保留负例、混杂、欠功效和未知；Beta 经摘要/handoff 仍保留限制。merge 通过时建新候选，不改已审基行。
- [ ] **Step 4: 确认绿灯。** Run `pnpm exec tsx --tsconfig .nuxt/tsconfig.server.json --test tests/governed-experience-lineage.test.ts tests/rsi-evidence-integrity.test.ts`；预期两条独立且相容的支持可计，R1/R2 类异主张和同源重试不得晋升。
- [ ] **Step 5: 独立评审证据语义。** 获准后提交 `fix: require compatible independent experience evidence`。

### Task 4: 统一自动注入、主动获取与撤权

**Files:** Create `SW/experience/resolve.ts`、`tests/governed-experience-resolver.test.ts`；Modify `SW/runtime/memory/{recall,state}.ts`、`SW/experience/{overlay,advisory}.ts`、`SW/agents/host-tool-bridge/tools/memory.ts`、`SW/runtime/agent-runtime/{message,supervise}.ts`、`SW/runtime/manager/{a2a,admin-agents}.ts`、`SW/rsi-adapter/{experience,contracts}.ts`、`API/channels/[id]/agents/[agentId]/memories/{index.get,search.post}.ts` 及 `API/channels/[id]/memories/{index.get,experience-stats.get}.ts`。

**Interfaces:** Consumes Tasks 2–3。Produces `resolveExperience(context: TrustedLearningContext, query: ExperienceQuery): Promise<ExperienceResolution>`；`ExperienceQuery = { text: string; purpose: 'automatic' | 'explicit' | 'review'; limit: number }`；返回 `items` 和 `ArtifactUseDecision`。`review` 仅授权审阅者可见候选，普通主动工具默认只返回适用已验证参考。

- [ ] **Step 1: 写失败测试。** `product_switch_revokes_all_read_paths`：对 L0/L1、工具、REST/计数、跨频道、pin/advisory 和 RSI experience adapter 逐一断言 `assert.equal(response.versionIds.includes(productAVersion), false)`；`assert.equal(nativeSession.reused, false)`；旧 `validated` 无部署、`shadow` 和未分类 legacy 经验不得自动进入。
- [ ] **Step 2: 确认红灯。** Run `pnpm exec tsx --tsconfig .nuxt/tsconfig.server.json --test tests/governed-experience-resolver.test.ts`；预期读取分叉或 active 自动入词不能通过。
- [ ] **Step 3: 统一入口。** 先授权、再按当前产品/配方/环境硬过滤、最后检索排序和裁剪；自动仅 `validated` + 当前上下文获准的 `canary/active` 部署 + 有效版本，`shadow` 仅供隔离评估。显式获取未部署的 validated 时标明参考而非执行；候选仅人审。RSI experience reader/adapter 也必须经过同一解析器，保留独立 `lifecycle` 与 `deployment` 字段；未接入或没有可信主体时，不提供可复用经验；Beta 的候选交换不获得读用许可。产品未知不扩域，索引故障可降级到无经验。每轮按 epoch 重新校验；撤权、切产品和退休后停止旧内容注入，持久化 native session 无法去掉旧上下文就用干净会话或关闭该注入。记录版本、匹配/拒绝和截断原因，不存敏感正文；独立校验外发接收权限。
- [ ] **Step 4: 确认绿灯。** Run `pnpm exec tsx --tsconfig .nuxt/tsconfig.server.json --test tests/governed-experience-resolver.test.ts tests/session-memory-scope.test.ts tests/memory-experience-shared.test.ts`；预期双产品/会话/频道、过期、撤权、不可信内容及普通泛化会话回归通过。
- [ ] **Step 5: 独立评审所有读取面。** 获准后提交 `feat: unify governed product experience retrieval`。

### Task 5: 可归因的宿主评测

**Files:** Create `SW/experience/evaluation-run.ts`、`tests/governed-learning-evaluation.test.ts`、`docs/audit/governed-learning-evaluation-protocol.md`；Modify `SW/experience/bench-run.ts`，保留历史结果阅读。

**Interfaces:** Consumes Tasks 3–4。Produces `runExperienceEvaluation(spec: FrozenEvaluationSpec): Promise<EvaluationRunRef>`；`FrozenEvaluationSpec` 固定数据/模型/策略版本、臂分配、主终点、分母、样本量、最小效应、非劣界、成本界、统计和停止/缺失处理；`EvaluationRunRef` 带不可变结果及宿主原始证据地址/哈希。

- [ ] **Step 1: 写失败测试。** `evaluation_requires_independent_holdout`：`assert.equal(sameRunInHoldout.status, 'BLOCKED')`、`assert.equal(denominator, success + failed + timedOut + interrupted)`、`assert.equal(clientOnlyBench.releaseEligible, false)`；一臂更新不能被另一臂看到。
- [ ] **Step 2: 确认红灯。** Run `pnpm exec tsx --tsconfig .nuxt/tsconfig.server.json --test tests/governed-learning-evaluation.test.ts`；预期现有客户端台账不能证明宿主执行、独立划分或完整分母。
- [ ] **Step 3: 实现冻结评测。** 逐版本放行前，先在隔离 shadow 用该版本的独立验证窗口生成 Task 6 所需的评测记录；不向生产 Agent 注入，不消耗最终留出集。策略效果由 Task 13 对冻结策略运行四臂：A 无经验、B 历史召回（只限隔离回放）、C 新解析不发布新经验、D C 加人工审核部署；主比较 C–B、D–C。先预测后学习，各臂独立事件流、索引、缓存；按任务族/批次及来源血缘隔离开发、逐版本晋升与最终留出。预注册区间、最小收益/非劣、费用和硬安全规则。工业用独立观测及判据；设计用可运行产物、设计约束、独立评审与重做次数。不以命中、自评或点估计代替收益。
- [ ] **Step 4: 确认绿灯。** 重跑 Step 2；预期数据泄漏、样本不足、缺失版本与伪造来源被拒；真实模型/业务样本未验时保留 `BLOCKED/NOT_RUN`。
- [ ] **Step 5: 独立评审统计设计。** 获准后提交 `feat: evaluate experience with independent holdouts`。

### Task 6: 人工晋升、部署与撤销

**Files:** Create `SW/experience/release.ts`、`tests/governed-experience-release.test.ts`；Modify `SW/experience/{gates,promote,harness-profile}.ts`、现有经验/Profile 晋升路由及对应数据库迁移。

**Interfaces:** Consumes Tasks 2–5。Produces `commitExperienceRelease(input: ReleaseRequest, actor: HostActor): ReleaseResult`；请求绑定 `versionId`, `evidenceSnapshotHash`, `policyVersion`, `evaluationRunId`, `expectedEpoch`, `reviewDecisionId`；结果 `pending | deployed | rejected`，不要用验证状态代替部署状态。

- [ ] **Step 1: 写失败测试。** `release_stays_off_until_durable_audit`：`assert.notEqual(noAuditAck.deployment, 'active')`、`assert.equal(concurrent.activations, 1)`、`assert.equal(selfApproval.allowed, false)`、`assert.equal(clientOnlyBench.allowed, false)`；撤销后缓存命中也不得释放旧版本。
- [ ] **Step 2: 确认红灯。** Run `pnpm exec tsx --tsconfig .nuxt/tsconfig.server.json --test tests/governed-experience-release.test.ts`；预期缺统一提交门、持久确认或历史台账兼容防线而 FAIL。
- [ ] **Step 3: 接入唯一提交门。** 事务写待发布与审计 outbox，可确认送达后复查授权、政策、证据、epoch、审批及有效期，再 CAS 发布。Profile 作用域内单 active，经验每主张/部署域最多一版 active；启用前按产品/频道 allowlist 进行 shadow/canary。旧 REST 不旁路；旧客户端评测仅展示。回归/撤销先停注入，回退内容需新候选和重新评估、人审；首版自动晋升关闭。
- [ ] **Step 4: 确认绿灯。** Run `pnpm exec tsx --tsconfig .nuxt/tsconfig.server.json --test tests/governed-experience-release.test.ts tests/experience-gates.test.ts`；预期并发、审计断开、重复确认、过期与撤销均无假发布。
- [ ] **Step 5: 独立评审权限与回退。** 获准后提交 `feat: gate experience release on durable evidence and review`。

### Task 7: 持久化反射与产品经验管理面

**Files:** Create `SW/experience/reflection-effects.ts`、`tests/governed-reflection-recovery.test.ts`、`tests/governed-experience-ui-contract.test.ts`；Modify `SW/runtime/manager/state.ts`、`SW/projects/service.ts`、`SW/aml/intervention-ledger.ts`、`app/components/workshop/MemoryPanel.vue`、`app/composables/workshop/useWorkshopApi.ts` 和现有记忆治理 REST/i18n。

**Interfaces:** Consumes Tasks 3、4、6。Produces `enqueueReflection(event: ReflectionEvent): void`（来源版本与幂等 key），`drainReflectionEffects(options: DrainOptions): Promise<ReflectionDrainReport>`；界面状态 `pending | reflected | failed | quarantined`，使用审计返回 `ArtifactUseDecision`。

- [ ] **Step 1: 写失败测试。** `reflection_survives_commit_then_process_exit`：`assert.equal(afterRestart.versionIds.length, 1)`、`assert.equal(unrecoverable.status, 'failed')`；`operator_follows_use_to_evidence`：`assert.equal(panel.detail.versionId, usedVersionId)`，未授权 DTO 无正文或候选计数。
- [ ] **Step 2: 确认红灯。** Run `pnpm exec tsx --tsconfig .nuxt/tsconfig.server.json --test tests/governed-reflection-recovery.test.ts tests/governed-experience-ui-contract.test.ts`；预期缺经验 outbox、使用关联或产品视图。
- [ ] **Step 3: 接入既有持久化模式。** terminal、L1/L2 与干预判读随来源事务登记，不能同事务的入口用持久游标补扫。有界重试、租约、死信与告警；向量失败只影响索引状态，不丢事实。现有工作台按产品/设计对象呈现适用域、冲突、版本、谁审核/使用、何时停用；以用户身份调用治理 API，不新增浏览器持有 Agent 凭据路径。仅有授权的监控数据可推送。
- [ ] **Step 4: 确认绿灯。** 重跑 Step 2；预期重启后只生成一个候选，能够追溯版本生效与失效，权限测试通过。真实浏览器的快照与 WS 对账留 Task 13，源码契约测试不代替浏览器实测。
- [ ] **Step 5: 独立评审运维与隐私。** 获准后提交 `feat: recover experience reflection and expose lineage`。

### Task 8: HITL 持久关联和未知效果对账

**Files:** Create `tests/industrial-approval-recovery.test.ts`；Modify `SW/agents/tool-approvals.ts`、`SW/db/hitl-request.repo.ts` 及 HITL 迁移、`SW/agents/hitl-decision/reconcile.ts`、`SW/dcw/dcw-controller/{recipes,actuation}.ts`、`app/stores/workshop/hitl.ts`。

**Interfaces:** Consumes 现有 `ExecutionScope`、`decideHitlRequest`、DCW 执行与读回。Produces `HITLExecutionRef`（`taskId`, `deliveryId`, `attemptId`, `assignmentGeneration`, `executionLeaseId`, `contextHash`, `payloadHash`, `expiresAt`）与 `WriteReconcileOutcome = 'not_sent' | 'verified' | 'rejected' | 'unknown'`。

- [ ] **Step 1: 写失败测试。** `old_approval_and_unknown_effect`：`assert.equal(newAttempt.oldApprovalAccepted, false)`、`assert.equal(afterRestart.driverCalls, initialDriverCalls)`、`assert.equal(afterRestart.outcome, 'unknown')`；区分审批前退出、发出后无回执、读回后落账中断。
- [ ] **Step 2: 确认红灯。** Run `pnpm exec tsx --tsconfig .nuxt/tsconfig.server.json --test tests/industrial-approval-recovery.test.ts`；预期持久状态缺代次/载荷关联或未明确 `unknown`。
- [ ] **Step 3: 增加恢复对账。** 记录批准载荷与 task/批次/lease 关联，决策和发出前重查权限、期限、工况及租约；未发送的旧请求取消并提示重提，未知效果先独立观察/人工复核、不自动重发。过早预占的试验节拍仅在证明无效果时按政策释放；不变更现有四层限界、HITL、保持窗、独立回读判据。
- [ ] **Step 4: 确认绿灯。** Run `pnpm exec tsx --tsconfig .nuxt/tsconfig.server.json --test tests/industrial-approval-recovery.test.ts tests/hitl-persistence.test.ts tests/dcw-write-attempt.test.ts`；预期旧审批无效、未知与验证分开、重复事件不触发第二动作。
- [ ] **Step 5: 独立评审控制边界。** 获准后提交 `fix: preserve fenced industrial approval correlation`。

### Task 9: Project 待批状态与冲突防重

**Files:** Create `tests/project-plan-lifecycle-observability.test.ts`；Modify `SW/projects/{service,plan-materialization}.ts`、`API/projects/[id]/observability.get.ts`、`app/pages/projects/[id].vue`。

**Interfaces:** Consumes 批准事务、plan version、`createWorkItem` 与 Project 事件。Produces `PlanProgress`（`pendingApprovalId`, `proposedAt`, `decidedAt`, `materializedAt`, `approvedVersion`, `state`）；`state = none | pending_approval | applied | rejected | attention_required`，保留旧 `plan` 兼容。

- [ ] **Step 1: 写失败测试。** `pending_plan_blocks_conflicting_manual_item`：`assert.equal(snapshot.planProgress.state, 'pending_approval')`、`assert.equal(conflictingCreate.code, 'PLAN_CHANGE_PENDING')`、`assert.equal(repeatedApply.createdCount, 0)`；保留批准前无冲突的明确手工模式。
- [ ] **Step 2: 确认红灯。** Run `pnpm exec tsx --tsconfig .nuxt/tsconfig.server.json --test tests/project-plan-lifecycle-observability.test.ts`；预期待批状态缺失或同计划产生冲突工作项。
- [ ] **Step 3: 统一投影和幂等。** 关联批准卡、不可变版本和 `plan.applied`；同事务以 `(projectId, planVersion, itemKey)` 识别物化项，在待批期间对冲突或语义不确定的临时建项给出明确拒绝；批准/拒绝/撤销后按新状态重新判断。UI 使用同一投影，不改变 handoff/L1/L2 与派发 CAS。记录提案、待批、批准、物化和首次观测时间，用于区分人为等待与物化耗时。
- [ ] **Step 4: 确认绿灯。** Run `pnpm exec tsx --tsconfig .nuxt/tsconfig.server.json --test tests/project-plan-lifecycle-observability.test.ts tests/project-dispatch-atomicity.test.ts tests/project-router-p0.test.ts`；预期竞态不重复、待批可见、手工合法路径和技术评审门保持。
- [ ] **Step 5: 独立评审批次与事务。** 获准后提交 `fix: expose plan progress and prevent conflicting work items`。

### Task 10: OMP/模型故障分类与有界恢复

**Files:** Create `SW/runtime/manager/dependency-health.ts`、`tests/workshop-dependency-health.test.ts`；Modify `SW/agents/adapters/omp-rpc-client/start.ts`、`SW/runtime/agent-runtime/{message,supervise}.ts`、`SW/runtime/manager/runtime-wiring.ts`。

**Interfaces:** Consumes Task 8 的未知效果规则。Produces `decideDependencyAction(state: DependencyHealth, job: JobCapability): DependencyDecision`；动作 `continue | wait | retry | fallback_readonly | attention_required | failed`，结构化原因至少区分 queue、ready、RPC、process、预算/限流与未见进展。

- [ ] **Step 1: 写失败测试。** `unknown_write_does_not_use_model_fallback`：`assert.equal(decision.action, 'attention_required')`；`assert.equal(recovery.driverCalls, originalDriverCalls)`。冷启动已受理不等于运行；活动进展与等待审批不得被同一个无活动时钟误杀。
- [ ] **Step 2: 确认红灯。** Run `pnpm exec tsx --tsconfig .nuxt/tsconfig.server.json --test tests/workshop-dependency-health.test.ts`；预期无有界健康策略，或失败归因不精确。
- [ ] **Step 3: 接入健康和恢复策略。** 对 provider/model/harness 分开计健康，共用退避/熔断冷却防重建风暴；仅批准的能力等价 allowlist 可在只读检查点降级，记录实际模型与回退原因。记录接受、就绪、实质进展、等待人审、结束时间；任务/模型硬预算保留上限。执行过或结果不明的副作用步骤必须先对账，重新入场前查租约。
- [ ] **Step 4: 确认绿灯。** Run `pnpm exec tsx --tsconfig .nuxt/tsconfig.server.json --test tests/workshop-dependency-health.test.ts tests/runtime-resilience.test.ts tests/channel-recycle-policy.test.ts`；预期 RPC 超时、限流、配额、退出、慢但有进度与冷启动能分别观察，任务终止或续跑有唯一结果。
- [ ] **Step 5: 独立评审恢复预算。** 获准后提交 `feat: bound harness retries and make dependency health explicit`。

### Task 11: DAQ 批次质量与 IDD/RAG 外部终态

**Files:** Create `tests/daq-batch-evidence-quality.test.ts`、`tests/workshop-external-job-terminal.test.ts`；Modify `SW/daq/infra.ts`、`SW/daq/daq-controller/ingest.ts`、`.AgentWorkShop/plugins/diag-bridge/host/{diagnosis,deposit}.mjs`、`.AgentWorkShop/plugins/rag-bridge/{index,client}.mjs` 及现有 UI/DTO 的状态投影。

**Interfaces:** Consumes Task 10 依赖状态约定及现有 202/status/stop。Produces `BatchQuality`（`expectedCount`, `validCount`, `droppedCount`, `gapWindows`, `state`）与 `ExternalJobOutcome`（`accepted | running | completed | overdue | failed | stopped | unknown`；产物、索引与只读降级另列）。

- [ ] **Step 1: 写失败测试。** `critical_sample_gap_blocks_use`：`assert.equal(gap.eligibleForControlEvidence, false)`、`assert.equal(gap.eligibleForTraining, false)`；`accepted_or_missing_artifact_is_not_completed`：`assert.notEqual(missingArtifact.outcome, 'completed')`、`assert.equal(kbAgentTimeout.documentFallbackMode, 'readonly')`。
- [ ] **Step 2: 确认红灯。** Run `pnpm exec tsx --tsconfig .nuxt/tsconfig.server.json --test tests/daq-batch-evidence-quality.test.ts tests/workshop-external-job-terminal.test.ts`；预期缺批次质量或外部产物/终态口径。
- [ ] **Step 3: 接入质量及结果投影。** 每批记录 drop、陈旧、断点、降级、后端来源；实时 UI 可降采样但证据流显式保留缺口，阻断受缺口影响的训练/判读。以插件能力协商记录 IDD 短/长窗、超预算、报告缺失及沉库校验；长诊断引擎改动由外部负责人负责。RAG 文档检索与 `kb_agent` 分别统计时延、鉴权与终态，只在授权只读情境降级到文档检索，不把它记成 agent 入库完成。
- [ ] **Step 4: 确认绿灯。** Run `pnpm exec tsx --tsconfig .nuxt/tsconfig.server.json --test tests/daq-batch-evidence-quality.test.ts tests/workshop-external-job-terminal.test.ts tests/daq-runtime-tsdb-recovery.test.ts`；预期队列满、掉线恢复、外部 401/超时/缺产物均不变成控制证据或假成功；实际外部稳定性另由 Task 13 复测。
- [ ] **Step 5: 独立评审限界与告警。** 获准后提交 `fix: surface batch quality and external job outcomes`。

### Task 12: 本体证据候选与 AML 工件分轨复用

**Files:** Create `SW/experience/ontology-proposals.ts`、`tests/governed-ontology-model-reuse.test.ts`；Modify `SW/ontology/{ontology.service,semantic-binding.service,compiler}.ts`、`SW/aml/{ontology-learning,model-registry}.ts`、`SW/aml/twin/model-backed-provider.ts` 及现有约束结果消费点。

**Interfaces:** Consumes Tasks 3、6 的证据与人工审核规则；复用 `createDraft/updateDraft`、现有本体发布和 `assertModelSceneLineage`。Produces `proposeOntologyDiff(context: TrustedLearningContext, evidence: readonly EvidenceRef[]): OntologyProposal`（`baseVersion`, `diff`, `support`, `conflicts`, `blockedReasons`）；约束结果区分 `verified | violated | unobservable`。

- [ ] **Step 1: 写失败测试。** `unknown_coupling_and_unobservable_guard`：`assert.equal(noDeclaredEdge.verdict, 'unknown')`、`assert.equal(missingCriticalGuard.eligibleForExecution, false)`、`assert.equal(wrongRecipe.modelUsable, false)`；无审批候选不能改变已发布本体和 DCW 限制。
- [ ] **Step 2: 确认红灯。** Run `pnpm exec tsx --tsconfig .nuxt/tsconfig.server.json --test tests/governed-ontology-model-reuse.test.ts`；预期无匹配边或缺观测未能区分于否证/通过。
- [ ] **Step 3: 生成可审差异、约束模型选择。** 文档、交付或干预证据只生成带来源的实体/关系/单位候选；检查命名空间、量纲、实际绑定、冲突、回放及编译约束，现有独立人工门发布。缺边是未知，显式否证须有证据且带适用窗。AML 用上游数据/工件 hash、真实训练环境、产品/配方版本、IO 量纲、校准、漂移和关键约束可观测性判定，缺关键 ensemble 成员不当作原模型。缺测可展示为建议，但非有权执行的验证。撤销沿血缘阻止未来采用，不虚称能撤回已实施动作。
- [ ] **Step 4: 确认绿灯。** Run `pnpm exec tsx --tsconfig .nuxt/tsconfig.server.json --test tests/governed-ontology-model-reuse.test.ts tests/ontology-learning-p6.test.ts`；预期相容工件保留复用、跨配方明确拒绝、未观测不被机器消费为已验证。
- [ ] **Step 5: 独立评审语义及模型约束。** 获准后提交 `feat: propose evidence-backed ontology and bound model reuse`。

### Task 13: 真实模型 + 隔离模拟 + 浏览器验收

**Files:** Create `scripts/acceptance-governed-product-learning.mjs`、`tests/governed-product-learning-acceptance.test.ts`、`docs/audit/governed-product-learning-acceptance.md`、`docs/audit/evidence/<unique-run-id>/`；复用 `scripts/onboarding/{onboard,sim-twin}.mjs`、现有隔离环境及技能。

**Interfaces:** Consumes Tasks 7–12。Produces 可追加的 `BaselineManifest` 兼容报告（增加 `evidenceFiles`, `approvalIds`, `decisionIds`, `terminalOutcome`, `recoveryOutcomes`）。runner 入参 `SimulationRunManifest` 记录 `environment: 'simulation'`、`revision`、`runId`、隔离 `awHome`、允许的模拟目标与驱动类型、孪生归属证明引用、各实验臂的数据根/索引命名空间、凭据引用（不含值）及证据输出根。启动前验证实际配置、驱动与可验证的归属证明均一致；任一目标未知、非模拟、未证明归属、资源被共享或版本不匹配时，在启动任务或发出任何写操作前返回 `BLOCKED`。环境标签、feature flag 和仅使用本地地址都不能单独证明归属。严禁裸 SQL 制造状态或复用旧 run 当新证据。

- [ ] **Step 1: 写失败测试。** `acceptance_never_counts_nonterminal_as_delivered`：`assert.notEqual(htmlWithoutArtifact.status, 'PASS')`、`assert.notEqual(recallWithoutDecisionId.status, 'PASS')`、`assert.equal(physicalNotRun.status, 'NOT_RUN')`。`rejects_unknown_or_unowned_simulation_target`：对实际驱动与清单不一致、证明缺失、目标不在许可集合、跨实验臂数据根复用等夹具分别断言 `assert.equal(result.status, 'BLOCKED')`、`assert.equal(runStarted, false)`、`assert.equal(writeCalls, 0)`。
- [ ] **Step 2: 确认红灯。** Run `pnpm exec tsx --tsconfig .nuxt/tsconfig.server.json --test tests/governed-product-learning-acceptance.test.ts`；预期现有验收不能强制三类结论分离。
- [ ] **Step 3: 编排两条真实模型链。** ① 隔离影子孪生、同线双产品和不同配方版本：巡检→模拟端受控写/独立回读→效果判读→记录支持与反证→后续同产品新任务；检查另一产品不被注入。② 非产线设计对象：设计→实现→可运行交付→新 Project 按产品版本及独立判据复用。两条均覆盖主动获取/自动注入、使用归因、审批/评审、暂不可用的明确收口。对照 Task 5 四臂；故障恢复验证许可失效、未知写不重发、WS 重连快照不倒退、产品切换和 pending 计划可见。短/长 IDD、RAG 文档/agent、真实模型和故障夹具各自归档，不合并覆盖率。
- [ ] **Step 4: 软件及隔离验收。** 取得对应授权后，按 §6.1 先运行 `pnpm run typecheck` 准备生成配置，再串行执行 `pnpm run lint`、`pnpm run test:unit`、`pnpm run test:acceptance-context`、`pnpm run build`；再运行 `node scripts/acceptance-governed-product-learning.mjs --manifest <已签核的隔离清单>` 并检查浏览器。记录实际模型 ID、硬件类型、证据哈希、分母、超时与退出码；两条业务链都须有最终工件。真实效果按冻结门判定；未验为 `NOT_RUN`，样本不足为 `BLOCKED`，执行中断保留实际终态或 `PARTIAL`。此处是候选分支验收，不代替 Task 15 的远端主干重跑。
- [ ] **Step 5: 独立对账。** 核对成果、代码、实际运行和异常退出，不从单项绿灯推出整体通过；获准后提交 `test: verify governed learning in industrial and generic projects`。

### Task 14: 现场准入交接包（文档；不执行现场步骤）

**Files:** Create `docs/operations/governed-industrial-pilot-admission.md`；复用[生产部署 runbook](../../operations/production-deploy-runbook.md)；现场专属资料由授权方维护，不纳入本仓库凭据。

**Interfaces:** Consumes Task 13。Produces `PilotAdmissionRecord`（`siteScope`, `equipmentOwnerRef`, `safetyReviewerRef`, `manualTakeoverEvidenceRef`, `physicalVerificationRefs`, `expiresAt`, `status`）。缺现场签核、实物证据或韧性门，状态保持 `BLOCKED`。

- [ ] **Step 1: 写文档反例。** 列出 `physicalVerificationRefs=[]`、没有独立现场验证、无人负责回退、安全覆盖缺结论四例，逐项期望 `BLOCKED`。
- [ ] **Step 2: 核对待补项。** 对照现有模拟验收与 runbook；预期历史材料不能代替这些物理证据。
- [ ] **Step 3: 编制独立准入清单。** 由设备 owner/现场安全人员决定只读影子、离线 HIL/FAT、现场 SAT 与下一阶段许可；检查点位/版本、单位/字节序、证书网络、时钟/覆盖、失联/急停/手动接管、独立观察与回退证据、MES 边界及恢复负责人。未实现协议不纳入。软件计划不产生控制指令，不代批或批准无人值守。
- [ ] **Step 4: 核对证据编号与签核责任。** 预期未现场执行项标 `NOT_RUN/BLOCKED`；即使包编制完成也不称现场已准入。
- [ ] **Step 5: 独立评审交接。** 获准后提交 `docs: define independent industrial pilot admission`。

### Task 15: 从远端合并后的 `main` 重建并统一审计

**Files:** Create `tests/governed-merged-main-audit.test.ts`、`docs/audit/governed-product-learning-main-audit.md`；Modify `scripts/_audit/governed-learning-evidence.mjs`；原始日志保留在隔离目录，仅将脱敏的证据索引和报告交付仓库。

**Interfaces:** 检查器开发依赖 Task 1，随 PR-E3 提交；最终审计依赖 Tasks 13、14 与 §6.3 的已合并 PR 清单。Produces `checkMainAudit(input: MainAuditInput): MainAuditResult`。`MainAuditInput` 含 `mainSha`、`checkoutSha`、`buildSha`、`allMergeCommitsReachable`，以及本次 `checkResults`（每项 `id`、`revision`、`status`、`exitCode`、`evidenceRef`）。检查器的必需软件检查 ID 由 §6.4 的固定矩阵定义，不接受调用者删减；缺项、重复项或版本不一致不得判 PASS。`MainAuditResult` 含 `status: CheckStatus` 和 `blockingChecks`。软件、外部真实依赖、收益与现场准入分别出账。

- [ ] **Step 1: 写失败测试。** `audit_requires_exact_merged_main_and_fresh_evidence`：`assert.notEqual(checkMainAudit(wrongCheckoutSha).status, 'PASS')`、`assert.notEqual(checkMainAudit(missingMergeCommit).status, 'PASS')`、`assert.notEqual(checkMainAudit(requiredCheckNotRun).status, 'PASS')`。旧 SHA 构建、来源未固定、必验项无证据也不得通过。
- [ ] **Step 2: 确认红灯。** Run `pnpm exec tsx --tsconfig .nuxt/tsconfig.server.json --test tests/governed-merged-main-audit.test.ts`；预期现状缺少主干来源与证据完整性检查。
- [ ] **Step 3: 实现主干证据检查器。** 随 PR-E3 接入 §6.4 的固定检查矩阵；校验清单完整性、来源和 PR 合并覆盖，并将每项测试、构建及运行证据绑定同一 SHA。本步骤在分支用合成清单验证，不产出主干通过结论；真正的远端重跑在 Step 4。修复验收发现的问题须走新 PR，并重新取得远端 SHA 重验。
- [ ] **Step 4: 确认绿灯。** 重跑 Step 2；随后按 §6.4 对最终合并 SHA 实际验收。预期检查器拒绝缺失/错版证据；只有必验项都有本次证据且 PASS 才能报主干通过，否则给出具体阻断项。现场 `NOT_RUN` 不会变成软件失败，也不会被软件绿灯覆盖。
- [ ] **Step 5: 独立审计并归档。** 由非实施者核对 PR、远端 SHA、失败分母和审计证据；获准后提交 `docs: record merged main verification and coverage`。若此归档作为后续纯文档 PR 合并，报告明确保留被测试的 SHA；若新增行为差异则重新审计，不把文档提交号冒充运行 SHA。

## 4. 推荐运营方式与验收判定

**在实现前的最佳可用做法：** 把当前 RSI 限定为“可检索的作业参考”，不要把旧 `validated` 当作充分复验，不把线级参数经验泛化成产品知识。按产品和配方版本分离作业，先核验任务实际绑定；关键结论主动检索后回查批次、独立回读与原始判据，人工决定是否采用。设计交付先冻结可验收工件与设计约束，移交后要求成品终态，不以消息回执判成功。模型不可用时暂停涉及潜在副作用的步骤，优先让操作员核对审批、写入和读回记录。现行系统若无法保证历史经验误入，不开放面向真实写控的自动复用。

| 责任 | 落地后的日常操作 | 证据 / 指标 |
|---|---|---|
| 产品/工艺 owner | 开作业时确认设计对象或产品、配方/工况和版本；变更生成新上下文。按决定、原始证据、适用因素和排除条件审经验。 | 从新任务查看命中版本、decisionId、何时采用或未采用、效果及交付结果。 |
| 经验审阅/评测人 | 审支持、反证、证据独立与来源；仅同域灰度；性能退化或污染时先停用，不能用人审标签或命中数冒充有效性。 | 产品分层收益、配对区间、错误复用率、审阅积压与回退时间。 |
| 平台值班与外部服务负责人 | 监控任务卡点与年龄、provider/RPC/进程、审批逾时、批次数据缺口、外部非终态；异常有负责人和下一步动作。 | p50/p95 排队及执行分开；重试与终态分母，数据覆盖、降级和未知动作对账。 |
| 现场设备、安全和运维负责人 | 决定只读窗口、现场试点与停止/接管，不把 LLM、经验工件、软件 PASS 当现场授权。 | 独立签字、现场安全验证、真实环境回退与责任交接。 |

**硬停止规则：** 发现跨产品越权读/注入；撤销或未批准版本仍可自动使用；审计不确立却发布；旧卡落到新 lease；未知效果自动重放；无独立验证却报写入成功；关键采样缺口静默作为完整证据。停止相关范围的新注入/写入、保留事实并对账。外部服务故障若不是必要依赖可带状态降级只读，否则标阻塞。命中次数不得替代效果指标。

**四档完成定义：**

1. **机制通过：** 版本与证据不被篡改、误用；授权/失效/重启/并发/采集故障测试通过。没有现场结论。
2. **复用可运营：** 工业和非产线产品新任务都有实际交付，主动与自动路径都能追溯准确版本与采用行为；错误域无自动注入，撤销后新回合可验证停止使用。
3. **收益被验证：** 独立前瞻任务或可信离线回放达到事前冻结的效应/非劣、成本和硬安全门，并明确不同环境与产品样本；不足时只报机制或探索。自动晋升/物理自治不从此档自动开放。
4. **真实现场试点：** Task 14 所需权限、现场证据和独立签核由授权人员完成。通过也只覆盖批准范围，不等于安全认证、自治生产或 SLA。

## 5. 规格交叉索引

| 规格要求 | 对应任务 |
|---|---|
| 不可变版本、scope、迁移与撤销 | 2、3、4、6、7 |
| 独立证据、冲突、产品与 Beta 来源 | 3、4、5、6、12 |
| 统一主动/自动、人审与使用归因 | 4–7、13 |
| HITL、Project、防重、运行与服务韧性 | 8–11、13 |
| 本体候选、人工发布、模型工件 | 12、13 |
| 机制/效用/物理分层验收 | 1、5、13、14 |
| 独立评审、PR 准入、合并后重新构建与审计 | 15；§6 |

## 6. 开发规范、专家复审、PR 合并与最终审计

### 6.1 以仓库现行规则为准

- **工具链：** 以 [`package.json`](../../../package.json#L71) 和 [`pnpm-lock.yaml`](../../../pnpm-lock.yaml) 为准；当前声明 Node `>=23.4.0`、pnpm `11.9.0`，复验按 [CI](../../../.github/workflows/ci.yml#L18) 使用 Node 24。执行 `pnpm install --frozen-lockfile`，除明确依赖变更不改锁文件。先 `pnpm run typecheck`（[仓库脚本](../../../scripts/typecheck.mjs) 会生成 `.nuxt`），再运行依赖生成配置的 lint/测试；同一检出目录不并行 typecheck、unit 与 build。不继承旧 `.nuxt`、`.output` 或 `node_modules`。
- **代码与测试：** 跟随相邻模块、[`eslint.config.mjs`](../../../eslint.config.mjs) 与 RSI redline；新单测放 `tests/*.test.ts` 进入 unit glob；`.test.mjs` 走已声明专项命令或在 PR 中显式列出。先证明缺口、再最小变更、最后测实际调用链，不能只测新 helper 就宣称旧入口受保护。接口/迁移更新契约与兼容说明；涉及 UI 时同批中英 i18n、主题变量、订阅清理及实际浏览器影响。不得通过放松断言、扩大 lint 例外、跳过权限或编辑历史证据换绿灯。
- **提交纪律：** 从最新 `origin/main` 单独建分支，用隔离工作树或新克隆，不改动有 WIP 的主目录。按 [pre-commit](../../../.husky/pre-commit) 的 `lint-staged` 与 [commit-msg](../../../.husky/commit-msg) 的 commitlint 检查，遵循 [Conventional Commits](../../../commitlint.config.mjs)，不跳过钩子。暂存前核对 `git diff --check` 和文件清单，按路径暂存；禁止顺带提交用户改动、本地数据、凑合用的日志、令牌、自动生成物或整个证据目录。
- **双重门禁：** 现有 GitHub 快测覆盖 `typecheck`、`lint`、`test:unit`、`i18n:check`、`check:cssvars`、`frontend-lifecycle-contract`，不等于托管端这些检查已配置为 required，也不含完整 build/live。每个实现 PR 将 `build` 与任务专项检查纳入本计划的合并前验收，影响文档契约时加 `pnpm run docs:check`；改 VitePress 站点或双语指南时按 [Deploy Docs](../../../.github/workflows/deploy-docs.yml) 验证站点构建。必要时在 PR 贴绑定到最新 SHA 的验收记录；本计划不自行修改分支保护或 CI 配置。

### 6.2 实施前专家准入

本轮三路只读复核的发现已纳入计划：开发规范组指出 CI 快测不等于构建/文档/运行验收，已在 §6.1、§6.3、§6.4 分层；技术依赖组指出旧经验迁移发布顺序、可信字段来源和 RSI adapter 读取边界未钉死，已补到 Tasks 2–4；验收组指出迁移 PR 原子性、模拟环境拒绝条件和最终主干来源不足，已补到 Task 13、Task 15 与 §6.3–6.4。以上是计划修订，不是实现复核通过，也不是迁移、测试、远端分支保护或现场验收结论。

- [ ] **冻结可复核输入。** 在新检出的远端基线记下 SHA、计划版本以及每个证据的路径、来源环境、哈希与可获取状态。本地未跟踪的近期报告与运行材料不假定远端可见；首个文档 PR 只提交审阅过的脱敏证据索引或经批准的最小摘录，保留原始记录的受权获取方式。不可共享、未来新克隆无法取得的材料标 `historical-local / unavailable`，不得用来满足可复现必验项；不将全量本地证据作为依赖打包。
- [ ] **独立复审。** 以同一份固定计划和基线开展三路审阅：① 架构/迁移与规范；② Spec/经验授权、证据治理与控制边界；③ 运行恢复、统计/验收与可追溯性。每路交付 `reviewer / baselineSha / planRevision / findings / disposition`，每条发现附文件与失败场景、改法及可验证的回归项。审查中断、未完成或缺结论记 `PENDING`，不得当作同意；已有报告遗漏的视角再补审，不需要重复已具证的结论。
- [ ] **关闭阻断项后才实施。** P0/P1 必须修订或明确移出该批、记录原因并获有权审阅者确认；守卫、权限、可恢复性缺口不允许用临时放行延期。若方案涉及产品体验取舍、兼容语义改变、自动晋升或现场动作，由用户决定而不是审阅者替批。保存 disposition 后再切第一个实现分支。

### 6.3 分批、分 PR、合并

批次定义可入主干的最小安全单元，Task 内仍逐步红/绿和复审；非必要不让两个 PR 同时改 `projects/service.ts`、`memory.repo.ts` 或公用迁移入口。技术准备分支可并行，不可跳跃合并顺序。批准工作流不得直接推 `main`、绕过审查或擅自发布。

| 批次 | PR 范围 | 准入证据 |
|---|---|---|
| A · 基线 | PR-A：计划及可共享证据索引、Task 1。 | 复审清单齐全；本地历史与远端复现证据分开；不改行为。 |
| B · 经验正确性 | PR-B：Tasks 2–4 同一合并单元；可内部拆成三个逻辑 commit，不开放半迁移的旧读写混合路径。 | 同一候选 SHA 覆盖迁移备份/恢复、旧写入口、全读入口、双产品隔离，发布策略默认关闭。 |
| C · 经验运营 | PR-C1：Task 5；PR-C2：Task 6；PR-C3：Task 7。 | 宿主评测契约先于真实发布；有审计确认才生效。Task 7 的 outbox 和 UI 可各自评审，但合并前对应接口契约和重启/权限测试均通过。 |
| D · 运行韧性 | PR-D1：Task 8；PR-D2：Task 9；PR-D3：Task 10；Task 11 拆 PR-D4（DAQ）、PR-D5（IDD/RAG），分别提交和复验。D1 先于 D3，D3 先于 D4/D5；D2 与 C3 不并行写共享文件。 | 恢复不重放未知效果，待批计划不重复，模型/服务超时可解释，采集缺口可定位，不改变设备权限。 |
| E · 工件与验收 | Task 12 拆 PR-E1（本体候选）、PR-E2（AML 可观测性和工件谱系）；PR-E3：Task 13 软件/模拟验收；PR-E4：Task 14 现场交接文档。Task 15 的检查器/单测先随 E3 落到主干，最终执行只在所有实现 PR 合并后。 | 两类工件各自验收；模拟工业与非产线均有真实交付或诚实阻断；现场与软件结论分开。 |

每个 PR 的执行记录：

1. 开工时固定 `baseSha`，对照本计划任务与仓库差异，执行红→绿测试；取证记录实际命令、退出码、跳过数和运行环境。提交标题和 PR 内容说明改动、范围、迁移/回退及测试结果，并带本批对应验收标准。
2. 对最新候选 `headSha` 做两轴独立代码审查：以该 PR 固定基线的 `git diff <baseSha>...<headSha>` 审 **Standards** 与 **Spec**，分别出具结论；控制、授权、持久化改动追加独立边界/回归复核。实现者不能给自己的改动记“独立通过”。
3. 获远端执行授权后用 `gh pr create`、`gh pr checks` 等 GitHub CLI 管理 PR；按 §6.1 查快测、专项验收、托管端必需状态及评论处置。受环境影响的非必验现场项单列，必验项 `BLOCKED/NOT_RUN` 不准合并。基线或提交变更导致检查失效时重跑，不以过期结果加速。
4. 只在门通过且该批有合并授权时用仓库允许方式合并。记录 PR 号、基线、审阅 SHA、合并结果 SHA（squash/rebase 后不是原 head 时用服务器记录的结果）与检查证据；下一依赖 PR 从已合并结果重新取基线。无需提权、改保护或绕过 GitHub；远端限制为阻塞原因，交给有权人员处理。

### 6.4 合并后的洁净主干审计矩阵

1. **确认来源。** 另建空目录并用 `gh repo clone <仓库> <空目录>` 取得远端；在该克隆 `git fetch origin main`，以 `git rev-parse origin/main` 固化远端 SHA，`git switch --detach <该 SHA>`。记录远端标识、时间、`git rev-parse HEAD`、锁文件指纹与空的 `git status --porcelain`；检查每个 GitHub 合并结果 SHA 都是该构建 SHA 的祖先。不使用原目录、PR 工作树、未提交的夹具或旧构建替代。
2. **执行软件门。** 记录 Node/pnpm 版本，运行 `pnpm install --frozen-lockfile`；串行运行 `pnpm run typecheck`、`pnpm run lint`、`pnpm run test:unit`、`pnpm run i18n:check`、`pnpm run check:cssvars`、`pnpm run frontend-lifecycle-contract`、`pnpm run test:acceptance-context`、`pnpm run test:onboarding-v6`、`pnpm run test:sdk-surface`、`pnpm run test:plugin-lifecycle`、`pnpm run test:mcp`、`pnpm run docs:check`、`pnpm run build`。影响站点则另验站点构建。生成产物保留来源元数据，不改源码凑绿；后台任务或日志管道不得掩盖真实退出码。
3. **执行隔离系统验收。** 只运行该 SHA 的构建；使用独立 `AW_MODE=home`、全新 `AW_HOME`、独占端口和安全注入的临时会话密钥；模拟器验归属后才运行 Job。运行 Task 13 业务、浏览器和恢复矩阵，覆盖权限/只读边界、协调、产品隔离及撤权、Project 重启去重、外部诊断和检索、DAQ 失联恢复与不确定结果，另在副本演练迁移备份/恢复。禁用共享或生产设备和凭据；没有真实模型额度、外部服务或浏览器时分别 `BLOCKED/NOT_RUN`，模拟结果不得填这些格。
4. **独立安全与结论复核。** 对固定 SHA 做经批准的防御性代码审查与覆盖核对；Mimosa 记录结论、覆盖、封印、未完成项，不把单有封印或 `inconclusive` 写成安全通过。附验收矩阵、原始证据引用、变更范围、回滚检查和未覆盖项；软件门、外部依赖、真实收益、物理准入分开出 verdict。所需检查未运行、未留证或失败则不给该层 PASS；修复必须新 PR 并重新锚定 `main`，不能沿用旧报告。

**文档终止点：** 本轮只写、复审和校验此计划，不执行任何 Task、不运行项目测试、不启动或停止实例、不连接现场、不提交/推送/合并。后续执行的权限和专项准入不由本文本产生。
