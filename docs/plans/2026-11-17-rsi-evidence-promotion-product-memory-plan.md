# RSI 证据驱动晋升与产品经验闭环实施计划

> **For agentic workers:** 使用 `executing-plans` 或等价的逐任务、独立评审流程。本文为研究、设计与实施计划，不授权本轮修改运行代码、提交、推送、访问生产系统或物理设备。

**Goal:** 在现有 AgentWorkShop 内建立按产品及可信上下文隔离、可追溯、可验证、可自动晋升低风险经验并可回滚的持续学习闭环，让 Channel Agent 既能按需工具检索，也能在适当时机自动获得相关经验。

**Architecture:** 在现有反射器、记忆仓库、经验门、Profile、Session 和 host-tool 之上建立宿主拥有的不可变经验版本、证据图、统一策略及评测记录；将提议、验证、发布和行为生效分开。工业产品、产线、配方和批次由既有 industrial projection 提供，通用核心依旧不依赖产线。Beta 保持 candidate-only，不创造第二套审批、执行或物理写入权威。

**Tech Stack:** TypeScript、Zod、SQLite/node:sqlite、Nuxt/REST、现有 Agent 工具、FTS/sqlite-vec、插件宿主、现有 DAQ/DCW/HITL/审计；评测采用受控模拟器、固定数据集、隔离实例及现有真实 LLM harness。

**Spec:** 本文同时作为设计规格和主实施计划；已有约束见 [Beta ADR](../architecture/2026-11-13-adr-rsi-beta-boundary-contract.md)、[领域无关框架计划](2026-11-13-operational-context-research-learning-framework.md)、[Beta/Core 闭环计划](../plan/2026-11-14-rsi-beta-core-closure.md)。基线 `0b5051d006dc7c252814af1b3106d29ffd826b76`；2026-11-17 只读源码核查和文献检索，不是对该基线的重新实测。

## 全局约束

- 本计划的 RSI 指**受证据、授权和评测约束的系统层持续改进**，包括经验、检索和经授权的配置变化；不声称模型权重变化、通用自主递归智能或必然单调提升。
- 经验可作为低可信参考数据，永不成为系统指令、工具授权、设备写入或安全限值的权威。所有物理动作继续由现有 DCW、权限、HITL、设备限界和审计链控制。
- Beta 插件默认关闭、只读、candidate-only；现行 ADR 禁止 Beta 直接晋升或激活。宿主核心可在独立 ADR 批准后建立受约束的自动晋升；不得通过修改 Beta flag 暗中绕过 ADR。Beta 产物及其派生物带不可剥离来源血缘，现行 ADR 下所有提交门禁止其直接或间接触发晋升；如需改变这一限制须先通过明确修订 Beta ADR 的独立决定，不能把导入宿主当作洗白。
- 真实 PLC HIL、生产写入、知识自动转换为安全约束及在线参数训练不包含在本计划的默认交付；任何物理实验另行审批窗口、操作员、隔离和安全方案。
- 未知身份、产品、权限、证据、版本、审批、来源或交付状态一律 fail closed；拒绝有结构化原因和不泄密的审计。不得把 `line`、`global` 或普通 shared 当作产品保密边界。
- 不复制新的 SchedulerLoop、HITL 机制、设备网关或审批权威；采用宿主单一策略及显式生命周期调用，所有外部候选经边界校验后进入相同核心权威。
- 原始证据与已发布版本不可变；派生摘要/FTS/向量可重建，撤销、过期、权限变更和污染处置必须同步使所有缓存与引用失效。频道删除和法定删除可能与长期保留冲突：实施前定义数据分类、授权保留期、最小化审计、可删除密钥/脱敏及保全例外；迁移需覆盖 `runtime/manager/admin-channel.ts` 的级联删除，不能无条件承诺永久保存敏感内容。
- 本计划默认所有新行为 feature flag 关闭；开启前需完成数据迁移、兼容测试、逐 scope 灰度及回退演练；独立可上线 PR，不在此计划中要求自动 commit/push。

## Review Focus

1. 同 dedup key 的已验证条目被改写正文或 scope 后仍携带旧验证：任务 1 的不可变性与并发测试必须拒绝或生成新版本。
2. 不同产品、结论、任务重试/同源数据合并成“独立样本”：任务 2 的作用域、证据谱系与聚类反例必须拒绝晋升。
3. 同频道不同产品/session 通过 shared、L0、FTS、向量、缓存和优化台账串入：任务 3、4 进行多入口负测；对未分类旧数据隔离。
4. LLM 自评、回放泄漏、重复任务、审计失败或并发部署制造虚假成功：任务 5、8 要求宿主持久化评测、holdout、CAS、outbox 和失败注入。
5. 知识污染、产品切换和回滚时旧引用仍被使用：任务 4、7 的 revocation epoch、在途运行和派生物级联测试覆盖。

## 1. 现状与证据

| 项目 | 当前确认事实 | 影响 |
|---|---|---|
| 核心经验 | [反射器](../../server/services/workshop/runtime/memory/reflector.ts) 产生任务级 candidate；[晋升门](../../server/services/workshop/experience/gates.ts) 和 [晋升服务](../../server/services/workshop/experience/promote.ts#L65) 要求至少两个去重、同频道且已完成的任务。owner/admin 可合并再人工晋升，未发现生产自动合并和自动晋升调用。 | 自动积累不会自行形成 validated；任务 ID 不同也不保证统计独立或真实效用。 |
| 完整性 | [upsert](../../server/services/workshop/db/memory.repo.ts#L182) 对 validated/retired 保留状态及证据，却覆盖正文、结论和 scope；[merge](../../server/services/workshop/experience/promote.ts#L65) 未校验产品、语义和极性一致。 | 已验证结论可被新内容替换；不相容证据可能混入。静态确认代码路径，实际泄漏未证实。 |
| E0–E3 | 外部 [IDD bridge](../../.AgentWorkShop/plugins/idd-closedloop-bridge/host/plugin.mjs) 含经验等级投影，非内部经验状态权威；其上游独立佐证实现本次不可核验。 | 不可声称内部已拥有可靠 E0–E3 自动晋升。 |
| 版本 | 内部经验主要为原地 upsert，尚非不可变版本链；[Harness Profile](../../server/services/workshop/experience/harness-profile.ts) 有版本及人工激活/回滚，但 Profile 生效竞争与单 active 约束需专项验证。 | 经验与 Profile 是不同工件，不应把 Profile 版本化误报为经验版本化。 |
| 自动和手动注入 | [自动召回](../../server/services/workshop/runtime/memory/state.ts#L38) 排除 candidate；[工具桥](../../server/services/workshop/agents/host-tool-bridge/tools/memory.ts) 能检索，但本地和跨频道路径、候选语义不一致。`auto` 不保证 session 严格隔离；产品键受可信快照约束。 | 必须统一授权、可见性及来源标记，不改变现有工作流的安全语义。 |
| IDD | [11-16 报告](../audit/2026-11-16-round2-fixes-full-acceptance.md) 的 R001/R002 确有 GP 设计及模拟器测量，但状态仍 exploring；真实 LLM 代理链未完成最终收口，PARTIAL。 | 不是收敛证明，不是物理 HIL；应单独预约模拟独占 campaign。 |
| RAG | 历史报告称直连检索成功、内部写入不稳定；所引本地一份 `rag-search-after-ingest.json` 实际 `Not Found`，不能独立证明排名第一。 | 重跑时必须固化响应正文、索引版本、查询、排名及 hash；不继承无证据结论。 |

旧 live 脚本曾通过直接 SQL 合并经验，不能据此宣称 merge REST 已真实验收；历史报告多针对旧 SHA、外部临时路径，需在当前提交重建并归档证据。本次未运行测试、模型或设备。

## 2. 前沿研究与设计取舍

检索于 2026-11-17，使用 arXiv/NIST 原始页面及论文；不是穷尽性系统综述。新论文尤其预印本仅说明实验设置内的结果，不当作工业效用保证。研究由 AI 辅助检索及整理。

| 来源 | 核实结论及适用边界 | 本项目决策 |
|---|---|---|
| [Reflexion](https://arxiv.org/abs/2303.11366), 2023 | 使用外部反馈生成语言反思、供后续使用；不更新权重。 | 复用任务反射，但必须与独立结果验证分离。 |
| [Voyager](https://arxiv.org/abs/2305.16291), 2023 | Minecraft 中通过环境反馈和可组合技能库持续探索；任务域有限。 | 可把技能作为后续工件，不因检索命中就授权执行。 |
| [Large Language Models Cannot Self-Correct Reasoning Yet](https://arxiv.org/abs/2310.01798), 2023/2024 | 无外部反馈时，自纠在受测任务中可能无益甚至退化。 | 模型自评不得充当独立证据或裁决者。 |
| [StepLearn](https://arxiv.org/abs/2609.35911), 2026 预印本 | 先形成临时经验，再用后续任务支持跨任务持久化；阈值为论文设定，非通用安全保证。 | 候选、验证、信任分层；本项目不照搬其阈值。 |
| [ASCENT](https://arxiv.org/abs/2610.05303), 2026 预印本 | 对已验证轨迹进行自蒸馏并更新 LoRA；依赖验证反馈和教师分布。 | 说明参数学习是另一条路线；目前不引入在线权重更新。 |
| [Evo-Memory](https://arxiv.org/abs/2511.20857), 2025 | 按有序任务流评估记忆的检索、更新与复用。 | 先预测后学习，验证集按时间和任务族隔离。 |
| [Task-Conditioned Memory Utility](https://arxiv.org/abs/2611.03930), 2026 预印本 | 受测事实问答可受益，但所测代码任务无可测收益；摘要不总优于原文。 | 测量实际任务增益与成本，保留原始证据引用，不能只优化命中率。 |
| [LoCoMo score sensitivity](https://arxiv.org/abs/2611.19199), 2026 预印本 | 回答提示和裁判可明显改变评测分数；配置在 LoCoMo 上开发，没有独立留出集。 | 固定并版本化裁判、提示与指标，增加确定性判据和裁判敏感性分析。 |
| [MemoryDojo](https://arxiv.org/abs/2611.09721), 2026 预印本；[AgentDojo](https://arxiv.org/abs/2406.13352), 2024 | 不可信工具结果/持久记忆可传播提示注入；沙箱基准不证明防御完全有效。 | 经验视为不可信数据，测试写入污染、跨任务传播和执行边界。 |
| [NIST AI RMF](https://www.nist.gov/itl/ai-risk-management-framework) 与 [GenAI Profile](https://doi.org/10.6028/NIST.AI.600-1) | 自愿性风险管理框架，非 agent 晋升具体技术规范。 | 为每次晋升记录责任、风险、测量、处置；不声称因此合规。 |

## 3. 定义与状态机

### 3.1 正交维度

- `ExperienceVersion`：一个具体主张和其不可变正文、适用条件及范围，`experienceId` 稳定，`versionId` 不可变；一次内容、证据集合、范围或适用条件变化建立新版本，不覆盖历史。每条主张保留不可变 `claimOriginId/claimOriginTime`；仅当正文、方向和适用域相同且通过确定性校验时，新证据快照的派生版本继承起点，新主张必须新建起点。每个版本绑定不可变 `evidenceSnapshotId/hash` 和父版本，晋升/发布仅对该版本及快照的评测有效；并发新增证据生成新版本并重新评测，不能套用先前审批。状态与评测事件为追加记录。
- `EvidenceRef`：宿主生成、可解析、带来源哈希及来源版本的证据引用，含可信 scope、事件时间、采样窗口、任务/attempt/run、环境 `simulation|physical-hil|production|offline|human`、证据类型、质量、授权快照与 lineage。哈希证明完整性而非真实性；来源的授权、签名/服务端验证及数据有效性另行判断。
- `EvidenceGrade`：E0 单次观察/未经外部验证；E1 有可追溯的单次验证；E2 至少两个通过独立性审查的后续证据单元及负例检查；E3 在声明范围完成预注册 holdout 评测、可靠性及人工治理。等级是**证据强度**，不是数据库生命周期或授权；现有 IDD E0–E3 不自动映射，经过适配验证才映射。
- `lifecycle`：`candidate -> evaluating -> validated -> retired`，另有 `contested`、`quarantined`、`superseded`、`expired`；失败回 `candidate` 或进入 contested，记录原因；已发布版本不得被就地复活，恢复通过新版本和审批。评级、使用授权和生命周期独立存储。
- `deployment` 是每次部署记录而非版本状态：`not_deployed -> shadow -> canary -> active -> rolled_back`，只描述可引用的经验/配置发布，不授予控制权限。版本可 validated 但尚未部署；`retired/quarantined` 必须立即停止新注入。`superseded`、`retired`、`expired`、`quarantined` 均不得重新激活；回滚创建引用旧内容和来源的新 candidate 版本，重新检查现时授权、适用范围、证据与评测时效并经独立审批，然后新建部署记录、CAS 切换及审计；旧版本从不复活。目标证据无效、撤销或审批过期时拒绝回滚，维持安全隔离状态。

### 3.2 经验内容和证据聚合

每个主张包含主体/对象、观察或建议、方向/极性、单位、工况区间、产品/配方版本、适用及禁用条件、产生方式、来源引用、有效期、风险类别和冲突关系。自然语言相似度只用于生成候选聚类，不得决定相同主张；由结构化键及确定性约束进行硬过滤，不确定进入人工队列。定量比较必须兼容量纲、基线与时间窗。

证据独立单元由宿主根据源系统、真实任务/run/attempt、批次、时间段、共同输入/数据集、模拟器随机种子及血缘生成；任务重试、重复导入、同一实验拆分、来源派生和相同回放均不自动计作独立。注入版本及其上游血缘必须记录到每个任务：模型读了经验后在结果里复述，或后续结果仅源于该经验及其派生输出，不是独立外部佐证；必须有不依赖待验证主张的可信工具、人工或环境判据。只有 ID 不同不够；无法确定独立性则不计数。E2 的两个独立支持单元均发生在原始主张形成之后，并计入反证；shadow 只能在隔离评估环境试用候选，不能向生产 Agent 自动注入。首次观察和支持/反证均记录；负面、无效及缺失样本不能被有选择地丢弃。

### 3.3 自动晋升范围

| 变化 | 默认决策者及门 | 示例 |
|---|---|---|
| 原始事件 -> candidate/E0 | 宿主规则自动，证据来源可追溯，默认仅当前受权作用域可见 | 某任务的失败模式 |
| candidate -> validated、只读经验 | 先 shadow；仅明确配置的低风险类别可由宿主策略自动决定，要求 E2、足够的新鲜独立证据、适用域匹配、无未决冲突、确定性验证、隔离回放和审计事务成功。样本数/时间窗由版本化策略预先设定并经评测校准；默认为人工 | 同产品文档检索经验 |
| 修改已有 validated 内容、扩大作用域、跨产品迁移、发布本体、激活 Profile/可执行技能 | 新版本 + 独立评测 + 现有 owner/admin 或指定责任人批准；申请者不能自批；默认关闭自动行为 | 配方关联推断、Agent 行为模板 |
| 修改安全约束、设备参数、控制权限、物理行为 | 不在 RSI 晋升面自动执行；沿既有 DCW/HITL 等治理路径单独决策 | PLC 写入 |

任何等级不是概率置信度或真实效果保证。模拟证据仅支持模拟域，不能变成物理验证。低风险自动晋升和风险分类策略需单独 ADR 与运行负责人批准，不能默默改变当前审批语义。

### 3.4 自动本体学习

经验可提出带证据的实体/关系/单位/冲突候选和本体 diff；先在隔离草稿进行 schema、类型、约束、来源、冲突及回归校验，再经过人工批准和现有 ontology 版本发布。不得自动放宽限制或写入控制规则。阶段性“自动构建”只指候选发现与草稿，不等于自动发布可信本体；发布自动化需后续单独 ADR。

## 4. 产品作用域与注入

可信上下文来自服务端认证主体、Channel 授权和工业 Session 绑定快照，不接受 Agent 自报的 productId 作为授权依据。服务端以 tenant/workspace（若部署支持）、owner、channel、session、subject、line、product、recipe 版本、run/批次、环境与时间窗口组成请求上下文；不支持的维度明确拒绝或标为不可用，不凭空声称已有多租户实现。产品切换创建新可信上下文并增加 revocation epoch；未绑定产品时不自动降级到宽域。

访问范围与**适用范围**分离：有权限读取 line/global 不代表适用于所有产品。缺省产品经验仅精确产品和配方条件命中；宽域共享必须标记为产品无关或列出明确适用产品，且发布时通过数据分类审核。历史 shared/L0、优化台账和旧全局条目未经分类仅由原受权人工检查，不自动灌入产品上下文。对敏感历史数据提供盘点、重分类和不可自动迁移报告。

新增统一宿主查询契约（下列为设计接口，实施时按仓库模块约定适配）：

```ts
type ExperienceQuery = { query: string; purpose: 'auto' | 'manual'; limit: number; includeCandidates?: boolean }
type RecallItem = { experienceId: string; versionId: string; content: string; scope: string; grade: 'E0'|'E1'|'E2'|'E3'; status: string; evidenceRefs: string[]; applicability: string; expiresAt?: string }
resolveExperience(actor: HostActor, context: TrustedContext, query: ExperienceQuery): Promise<{ items: RecallItem[]; decisionId: string }>
```

`HostActor`/`TrustedContext` 由宿主从实际 session 和权限服务构造，Agent 不可传入；实现前在共享契约文件定义可序列化字段和不可伪造的构造边界。统一查询先授权和适用性硬过滤，再进行 FTS/向量召回、时效和任务相关性排序、去重与预算裁剪；不得先向未经授权调用者暴露候选或计数。自动注入只使用有效、已批准部署的版本，默认 validated；显式工具检索可以在同范围内返回 candidate，附不可信/未验证标签且不可放宽安全决策。产品 scope_key 省略时取服务端可信值，显式值只校验相等。

触发时机：每条用户消息和必要的监督回合按当前上下文检索；产品/配方变更、任务阶段变更和已有版本被撤销时使缓存失效并在下一次模型调用重算；长任务步骤间按变化事件刷新，不能对已经生成的模型输出声称撤回。每次记录模型回合、decisionId、版本 ID、策略版本、token 估算及截断原因；仅供有权审计者查询，不记录敏感全文。工具查询复用同一个 resolver，只变 purpose 与候选可见性。

提示词包装必须标注“外部记忆/不可信数据”，且不得覆盖 system/developer 指令；工具执行时重新检验当前授权、设备权限和参数，而非信任经验文本。跨频道消息、文件导出及外发须独立校验用户意图、数据标签、接收方权限和当前 scope，工具调用本身合法不等于允许泄露检索内容；无法可靠标注或判断时拒绝。撤权、污染或产品切换时不仅校验下一次工具，还要在下一次模型外发前检查 epoch：对会持久保留旧上下文的原生 harness session 停止恢复并建立干净会话，否则禁用该 harness 的相关注入并审计。不能保证撤回模型供应方已接收内容。统一预算覆盖 L0、session、工业台账、经验及包装文字，按模型上下文窗口预留输出与工具空间；目前估算若不是 tokenizer 精确计数，必须保留余量，并在超限时优先保障系统约束和当前任务。召回缺失或检索器失败可回退到无经验执行；权限或 scope 未知不能回退至更宽范围。

## 5. 评测与发布设计

### 5.1 先评估再学习

将历史任务按发生时间及产品/工况分组；对每个任务先冻结候选和上下文，在未见任务结果前记录预测与注入版本，再计算指标，最后才允许把该任务结果用于后续训练/晋升。禁止同批次重试、数据派生、同一 run 和同一任务改写分到训练/验证两边。最终 holdout 的内容、hash、访问角色和解封条件预注册；时间漂移和跨产品迁移分别报告，任何自适应调参均用另一个最终留出集复核。

四臂最小实验：A 无经验、B 现有只读召回、C 新检索但不晋升、D 新检索加受治理晋升；相同任务、工具权限和模型版本，按产品/任务族分层随机配对，固定种子或记录实际模型随机性。主要比较 C 相对 B 的检索效应、D 相对 C 的晋升策略效应，A 仅供整体参考。四臂各自维护独立的记忆库、候选、索引、缓存和晋升事件流，从同一经审计初始快照派生；每个时间步冻结四臂状态与输入，全部完成评测后各自更新，记录状态 hash 和运行顺序，测试跨臂写入不可见。对于真实 LLM 需要重复运行、记录失败/超时/未完成，不得仅分析成功任务；mock、模拟器与真实模型分别报告。阶段 1 先固定可复现基准，不把模拟任务收益外推物理产线。

主指标：预定义任务成功率和独立工具/设备模拟结果；安全硬指标：越权读取、未经授权动作、跨产品污染、无证据晋升与停用后再注入均必须为零（在声明的测试集合内）。次指标：负面/冲突召回、证据可追溯率、人工审核负载、p50/p95 延迟、token/费用、过期率、回滚恢复时间、跨产品迁移及各产品/任务族的退化。报告每组样本数、失败分母、配对差、区间估计及预算；例如 Wilson 区间仅用于独立二项样本，配对差用配对 bootstrap 或精确方法，以批次而不是重复任务为聚类单元。样本不足只能报告探索性结果，不得以“无显著差异”证明不劣。

实施前由责任人基于基线预注册样本量、最小有意义效应、非劣界、置信水平、停止规则和可接受成本；若无法获得足够独立样本，则自动晋升保持关闭而不是凭阈值凑数。开发集、晋升校准集、最终验收集彼此隔离任务文本、输入、轨迹、标签及派生物，按血缘而非只隐藏标签划分；逐次登记校准集查询并设次数、反馈粒度与多重比较预算，最终集只对冻结策略一次性解封，任何重复调参须用全新留出集。隔离失效则结果仅为探索性。裁判 LLM 的提示、模型和版本固定并做敏感性分析；硬安全/设备结果不能只依赖 LLM 裁判。

验收前冻结机器可检查的统计分析方案：两个主比较、主终点、随机化与批次聚类单位、样本量、置信区间、最小效应/非劣界、成本界、多重比较、提前停止、缺失和违规处理；所有进入随机分配的任务计入分母，超时/中断按未完成计失败并单列，其他缺失按预注册保守规则处理。示例仅说明判定逻辑：若预注册 D-C 非劣界为 -0.05、95% 配对区间下限为 -0.08，则 FAIL；下限为 -0.02、成本及安全门通过且样本满足预注册时才通过非劣门。无冻结阈值、有效样本不足、留出集不独立或真实 LLM 未运行均为 BLOCKED，不把未显著差异称为非劣。分产品样本不足时只能描述，不作该产品有效性宣称。

安全矩阵至少覆盖跨产品读取、伪造上下文、证据重放、污染传播、撤权后召回和并发晋升六类，覆盖每类的自动与手动入口及相关状态；每格的独立试验数量须在看结果前预注册，漏格为 BLOCKED。零违规仅代表指定测试样本内零事件；对独立伯努利试验报告单侧置信上界，对相关样本按批次聚类并注明无法直接套用独立上界。真实 LLM 最低覆盖自动注入、工具检索、后续证据收集和晋升后复用至少各一条完整受治理链，并按预注册重复；未运行则真实模型验收 NOT RUN，模拟机制通过不能替代真实模型或真实业务效果。真实任务流须使用经授权的前瞻业务任务或可信且有独立标签的离线回放，说明来源、观察窗口和分配方式；只用模拟任务时 M3 保持未完成。

### 5.2 晋升、回滚与可观测性

逐版本晋升评测与策略级最终验收分开：前者使用预注册、按产品/批次和血缘隔离的前瞻验证窗口；为每个版本登记分配的数据、访问次数、预算和新鲜度，避免同一数据跨版本反复调参，耗尽后等待新窗口，无新鲜独立样本则自动晋升 BLOCKED。最终集只评价冻结的整体策略，不能作为每个版本的晋升数据；耗尽后必须取得新的独立终验集，无法取得则效果结论保持探索性。对复用窗口、泄漏派生标签和相邻版本自适应查询写拒绝测试。

晋升决策以不可变 `versionId`、证据集合 hash、策略版本、授权快照、评测 run 与有效期限绑定。自动触发器幂等，事务内重查版本、证据撤销和评测有效性、scope/权限、策略、审批、冲突、kill switch、租约 fencing token 与过期状态，并使用 compare-and-set。先原子写入 `pending` 决策和审计 outbox，再由独立投递器以幂等键写入可确认的持久审计；仅在收到可验证确认且重新检查全部门后原子发布。现有 `recordOps` 吞错行为不是确认凭据；审计不可用时停留 pending，不可报告发布成功。启动恢复时重放 outbox 并再次核验，不得依赖进程内状态。所有人工 REST、bench、插件及后台入口均委托同一个宿主提交门，调用者、服务主体和委托关系由宿主认证，确保申请者与审批者分离；旧晋升端点不得保留旁路。Profile 激活使用数据库事务和单 active 唯一约束，迁移前扫描重复并输出人工处置清单。

灰度按产品和 Channel 显式 allowlist，由 shadow 到 canary；下游实际使用和对照组均记录。检测到质量或安全回归时立即停止新注入、冻结版本、进入人工处置；自动执行的只是安全侧隔离/kill switch，不自动修改 Profile 或回写设备。对已有运行中的 Agent 标记上下文过期，下一工具调用重新授权；不可保证撤回已交付的模型上下文或逆转已执行动作。回退旧内容必须按 §3.1 创建新 candidate、重新验证并审批，而不是复活旧版本；撤销证据时对衍生摘要、向量、缓存、候选技能/本体建立血缘级联隔离。

## 6. 文件和实施任务

以下新增文件名为建议的明确实施边界；调用点为当前存在的仓库路径。每项先写失败测试并运行确认失败，再实现最小更改、运行对应测试及 lint/typecheck；若调查发现约定不同，先更新设计与评审，不得悄然更改语义。各任务通过独立 PR 和评审，先后依赖见末尾。

### 任务 0：现状复现、ADR 与基准固定

**文件：** 修改本文；新增 `docs/architecture/2026-11-17-rsi-promotion-authority-adr.md`；新增 `tests/rsi-promotion-baseline.test.ts`。读取 `server/services/workshop/experience/{promote,gates,harness-profile}.ts`、`server/services/workshop/db/memory.repo.ts` 及 `tests/rsi-experience-lifecycle.test.ts`。

- [ ] 写回归测试：同键重放已验证条目时检查正文/scope/evidence；合并不同产品、方向、已验证基行；两任务但同源重试；并发 Profile 激活。先证实现有行为与失败点，不能通过改断言掩盖。
- [ ] 建立快照：当前 SHA、配置与测试命令、legacy `active`/`candidate`/`validated` 数量、冲突 scope、缺证据、重复 active Profile；不输出敏感正文。
- [ ] ADR 决定宿主自动化的决策人、可自动处理的低风险类别、拒绝/审计/回退；注明 Beta ADR 不被覆盖。ADR 未批准前不启用自动晋升。
- [ ] 运行 `pnpm exec tsx --tsconfig .nuxt/tsconfig.server.json --test tests/rsi-promotion-baseline.test.ts`；归档复现结果及风险清单。基准测试中已知失败不得作为通过宣称。

### 任务 1：不可变版本与迁移

**文件：** 修改 `server/services/workshop/db/memory.repo.ts`、现有数据库迁移入口和 `server/services/workshop/runtime/memory/reflector.ts`；新增 `server/services/workshop/experience/versions.ts` 与 `tests/rsi-experience-versions.test.ts`。

**接口：** `createExperienceVersion(input: VersionDraft, expectedPreviousVersionId: string | null): VersionResult`；返回不可变 `experienceId/versionId/contentHash`，重试以幂等键命中同版本，冲突明确失败。版本与关联证据一次事务写入。

- [ ] 测试同 dedup 的 validated/retired 无法改正文、scope、证据；内容变化建立 candidate 新版本，旧 FTS/向量不被错误复用；并发更新最多一个成功；migration 重跑幂等。
- [ ] 保留旧记录 ID 到版本的映射、旧 audit 可查；无法可靠溯源的旧 validated 标记 `legacy-unverified` 并阻止新自动注入，进入人工复核。迁移、新状态读取白名单和全部检索路径拦截必须同一可部署单元上线，禁止旧版黑名单误注入；迁移前备份、校验恢复并检查磁盘容量。旧版程序会直接建表和 UPSERT，禁止简单回滚旧二进制或依赖只读视图；仅允许经双向兼容测试的回滚版本，或停机恢复备份并对迁移后事件做审计对账，明确恢复点与数据损失边界。
- [ ] 普通记忆和经验共用去重键空间的所有写入，包括 `memory.repo.ts` 普通 upsert、`runtime/memory/write.ts`、管理 API，均须使用数据库级 kind 隔离/不可跨 kind 覆盖；旧写入口不能更改、复活或覆盖经验版本，覆盖保存与 API 的并发回归。
- [ ] 私有/团队记忆删除 API、`admin-agents.ts`、仓储直接删除及频道级级联删除均纳入迁移：经验只能经统一撤销或受授权法定删除流程，原子传播到部署引用、派生项和缓存并留存允许的最小审计；测试已发布版本、恢复备份和法律删除情形。
- [ ] 运行 `pnpm exec tsx --tsconfig .nuxt/tsconfig.server.json --test tests/rsi-experience-versions.test.ts tests/rsi-experience-lifecycle.test.ts tests/rsi-evidence-integrity.test.ts`。

### 任务 2：证据模型、聚合和冲突

**文件：** 修改 `server/services/workshop/experience/{promote,gates}.ts`；新增 `server/services/workshop/experience/evidence-ledger.ts`、`server/services/workshop/experience/claim-cluster.ts`、`tests/rsi-evidence-lineage.test.ts`。

**接口：** `classifyEvidence(refs: EvidenceRef[], context: TrustedContext): EvidenceDecision` 返回支持/反对/未知、独立单元及原因；`proposeClaimCluster(versions: ExperienceVersion[]): ClusterProposal[]` 只能提议，确认由确定性结构化比较及授权者完成。

- [ ] 为跨产品、配方版本、单位、极性、冲突结论、重试/重复导入/同源派生写负测；缺来源或权限拒绝合并；对 validated 基行合并必须新建版本且结果与实际持久化一致。
- [ ] 记录证据类别、版本、scope、因果关联而非仅 taskIds；在 `runtime/memory/reflect-collector.ts` 的事件发生时捕获并验证可信 product/recipe/session 快照与注入版本血缘，未知或不匹配的历史数据不计 E2；无可靠源适配器的外部 IDD E0–E3 只显示原始自报，不提升宿主等级。
- [ ] 在工具/插件结果、任务交付、模型摘要、反射输入、人工合并与证据快照之间由宿主传播不可剥离的来源标签；来源缺失或不可证明时禁止晋升，模型自行声称的来源不可信。测试 Beta 结果经摘要、任务交付、人工合并的直接和间接晋升均被现行 ADR 阻断。
- [ ] 验证同一任务的多次自评、相关重试和虚假/删除任务都不满足 E2，独立后续任务与明确反证均可追溯；测试主张起点稳定、原始观察加两个后续独立支持单元、并发追加证据触发新版本重评。
- [ ] 运行 `pnpm exec tsx --tsconfig .nuxt/tsconfig.server.json --test tests/rsi-evidence-lineage.test.ts tests/rsi-evidence-integrity.test.ts`。

### 任务 3：宿主统一授权与产品策略

**文件：** 修改 `server/services/workshop/agents/session-snapshot.ts`、`server/services/workshop/runtime/manager/{runtime-wiring,a2a}.ts`、`server/services/workshop/runtime/memory/state.ts`；新增 `server/services/workshop/experience/access-policy.ts` 和 `tests/rsi-product-access.test.ts`。

**接口：** `authorizeExperienceRead(actor: HostActor, context: TrustedContext, version: ExperienceVersion): AccessDecision`；产品值来自可信 session，调用者自报只允许相等校验；跨 channel 继续执行现有成员/owner/工业模式权限。

- [ ] 以两个产品、同线、同频道多 session 和跨频道矩阵测试：FTS/向量、candidate、legacy shared/L0、行级工具、宽域访问、配方变更、撤权及无 product fail-closed；列出优化台账的独立调用并同样覆盖。
- [ ] 完整盘点并接入统一策略：`experience/overlay.ts` 与 `agents/base-agent.ts` 的 Profile pin、`experience/advisory.ts` 的审批原因/HITL/节点 advisory 及其缓存、`runtime/manager/admin-agents.ts`、`runtime/manager/a2a.ts` 的跨团队检索及 `server/api/workshop/channels/[id]/memories/index.get.ts` 列表与计数；无法验证产品适用性的历史 advisory 默认不注入并纳入预算，测试同频道双产品切换。未分类内容和计数都不得旁路。跨进程缓存用持久化版本/epoch 失效并测试。
- [ ] 在 `runtime/agent-runtime/message.ts` 等每回合入口，以真实 session 重新校验可信快照并绑定到工具调用的执行上下文；不得只信任 `runtime-wiring.ts` 装配时冻结的 scope，缺少可信 session 的直调拒绝产品经验。
- [ ] 默认将旧宽域内容设为未分类；经授权人工显式重分类后才能参与自动注入，默认不改变普通非工业对话记忆的既有隐私语义。
- [ ] 运行 `pnpm exec tsx --tsconfig .nuxt/tsconfig.server.json --test tests/rsi-product-access.test.ts tests/memory-experience-shared.test.ts`。

### 任务 4：统一自动召回与工具获取

**文件：** 修改 `server/services/workshop/runtime/memory/{recall,score,state}.ts`、`server/services/workshop/agents/host-tool-bridge/tools/memory.ts`、`server/services/workshop/agents/prompt-builder.ts`、`server/services/workshop/runtime/agent-runtime/{message,supervise}.ts`；新增 `server/services/workshop/experience/resolve.ts`、`tests/rsi-unified-recall.test.ts`。

**接口：** 使用第 4 节 `resolveExperience`；自动/手动仅由宿主决定 purpose，两者复用任务 3 的权限及适用性，返回 decisionId、版本和证据来源。

- [ ] 测试模型对自动注入、`search_memory` 显式请求、无 scope_key、伪造 scope_key 的结果；自动不含 candidate、手动同域 candidate 有标签；不同 agent/harness、session 克隆、产品切换、权限撤销和 in-flight 重新校验。
- [ ] 测试提示注入作为数据、召回失败、空结果、预算极小、L0-only 额外标题、超过上下文窗口、FTS/向量落后及版本过期；自动和工具不得泄露禁止内容及敏感计数。
- [ ] 运行 `pnpm exec tsx --tsconfig .nuxt/tsconfig.server.json --test tests/rsi-unified-recall.test.ts tests/memory-experience-shared.test.ts`，再执行与各 harness 的集成契约测试。

### 任务 5：可信评测及自动晋升

**文件：** 修改 `server/services/workshop/experience/{gates,promote,bench-run}.ts`、`server/services/workshop/experience/harness-profile.ts` 与相应数据库迁移；新增 `server/services/workshop/experience/promotion-policy.ts`、`server/services/workshop/experience/evaluation-run.ts`、`tests/rsi-auto-promotion.test.ts`。

**接口：** `evaluatePromotion(versionId: string, policyVersion: string, evaluationRunId: string): PromotionDecision`；`commitPromotion(decisionId: string, expectedVersionId: string, actor: HostActor): PromotionResult`。评测由宿主生成并持久化输入、逐样本原始结果、工具/模拟器判据、版本与签名/hash；不直接信任 Agent 或客户端提交的通过数字。

- [ ] 增加缺证据、无授权、虚假 completed、非独立证据、冲突、过期、评测泄漏、篡改、跨域和自动审批高风险的拒绝测试；测试审计失败、崩溃重试、两执行器并发及回滚。
- [ ] 自动晋升触发以任务完成/证据更新为事件，合并去重、异步、有限重试、有租约和幂等键；不能阻塞对话，也不自行执行 Beta promotion。不能依赖 `runtime/manager/state.ts` fire-and-forget 或反射器吞错：候选提交与任务事件建立可恢复事务 outbox，并提供幂等补扫、死信和故障告警；测试崩溃于各提交点、顺序颠倒与重复投递。所有状态迁移、决策和审计 outbox 绑定。
- [ ] 将 Profile 的 bench 真实性、并发 CAS、事务和数据库单 active 一并加固；人审与申请主体独立，回滚目标必须仍授权、有效。旧客户端提交的 perSeed bench 仅保留历史展示，不得用于新激活；只接受宿主受控执行、绑定版本及逐样本证据的新评测。
- [ ] 禁用旧的点估计 `primaryDelta >= 0` 及 `minPairs=3` 直接通过分支：新门必须满足预注册配对/聚类置信区间非劣界、独立成本上限与安全门，所有通过路径均同样约束。新增三对全平、区间跨越非劣界、主指标改善但成本超限的拒绝测试；旧端点不得旁路。
- [ ] 运行 `pnpm exec tsx --tsconfig .nuxt/tsconfig.server.json --test tests/rsi-auto-promotion.test.ts tests/rsi-experience-lifecycle.test.ts tests/rsi-evidence-integrity.test.ts`。

### 任务 6：管理界面、审计和产品运营

**文件：** 在现有 `server/api/workshop/channels/` 经验/Profile 路由及现有 RSI 页面内扩展；新增 `tests/rsi-governance-api.test.ts`。具体页面文件由执行前依据路由与现有 UI 定位后在 PR 中锁定，不新增平行管理台。

- [ ] API 和页面展示产品、主张、版本、来源、有效范围、证据支持/反证、评测样本数、当前部署、权限和审计链；提供人工审核、拒绝、撤销、恢复提案、灰度与 kill switch；默认敏感信息只对授权人可见。
- [ ] 测试 owner/admin 与普通用户、申请者自审拒绝、并发审核、过期批准、下线缓存失效和禁用开关；中英文 i18n 同步。
- [ ] 运行 `pnpm exec tsx --tsconfig .nuxt/tsconfig.server.json --test tests/rsi-governance-api.test.ts`，并执行现有 UI/REST 权限回归。

### 任务 7：受治理本体候选与污染处置

**文件：** 扩展现有 ontology service、候选版本路由与经验血缘；新增 `server/services/workshop/experience/ontology-proposals.ts`、`tests/rsi-ontology-proposals.test.ts`。实际 ontology 文件路径以执行前代码定位和 PR 文件清单确认。

- [ ] 生成实体/关系/单位候选及 diff；验证证据、产品适用、命名空间、类型、约束方向、冲突和拒绝自批；未经批准无法发布或改变控制约束。
- [ ] 测试有毒来源的撤销沿证据图隔离派生经验、摘要、向量、候选本体和技能；对已使用的历史记录保留审计，不伪称撤回已执行动作。
- [ ] 运行 `pnpm exec tsx --tsconfig .nuxt/tsconfig.server.json --test tests/rsi-ontology-proposals.test.ts` 和既有 ontology suite。

### 任务 8：评测、模拟独占 campaign 与交付

**文件：** 新增 `scripts/acceptance-rsi-learning-campaign.mjs`、`docs/audit/2026-11-XX-rsi-learning-acceptance.md` 和 `docs/audit/evidence/<run-id>/`；复用 `scripts/acceptance-rsi-compatibility-matrix.mjs` 与现有 IDD runner。

- [ ] 固定第 5 节预注册分组、holdout、样本量及口径；在隔离 home 执行 A/B/C/D，持久化 SHA、模型/harness、产品、数据集 hash、随机种子、任务数、成功与超时、成本、证据和权限决策。
- [ ] 通过 API 正式执行：一次原始观察加至少两个后续独立同产品支持单元 -> 不可变 candidate 和证据快照 -> 证据聚合 -> shadow/确定性验证 -> 允许的低风险自动晋升 -> 自动及手动召回 -> 按版本溯源 -> 冲突/失效隔离 -> 新候选、重评测、审批与回滚。不得靠裸 SQL 模拟晋升。
- [ ] 同线双产品、跨 session/频道、伪造 scope、证据重放、恶意工具输出、数据漂移、撤权和审计不可用均做负测；真实 LLM 和 mock 结果分开；记录至少一次任务中断/重启恢复。
- [ ] IDD campaign 仅在模拟器独占窗口运行，明确端口、资源/预算、准入和退出；记录 R001 起所有布点、决策、停止准则、状态、模拟写入的授权及回读。若超时/无收敛或 Agent 未收口，标记 PARTIAL；无独占或未运行则 BLOCKED/NOT RUN。不能把模拟收敛叫真实 PLC HIL。
- [ ] 单独重做 RAG 入库与检索，留存实际 HTTP 状态、原始响应、索引 revision、查询、名次、hash；内部代理写入与直接索引分别统计。
- [ ] 串行执行 `pnpm lint`、`pnpm typecheck`、`pnpm test:unit`、`pnpm test:acceptance-context`、`pnpm build` 及 RSI/兼容矩阵；build 与 test:unit 不共享生成目录并发。记录每条命令、SHA、时间和结果，真实无法运行的门标 BLOCKED。
- [ ] 独立架构/安全/实测审查；若仍有 P0/P1，阻止放量。评测不足时保持自动晋升关闭，但可交付只读候选与人工治理能力。

## 7. 依赖、里程碑与完成定义

依赖：0 -> 1 -> 2 -> 3 -> 4；2/3 完成后推进 5；4/5 后推进 6；2/3 完成后推进 7；8 汇总 1–7。任务 7 的本体候选可以延后，但不能把它排除后仍宣称本体自动发布完成。任务 8 必须在可测的软件阶段进行阶段验收，最终验收覆盖所有承诺范围。

| 里程碑 | 可交付结果 | 不可宣称 |
|---|---|---|
| M0 安全止血 | 两个完整性缺陷复现并修复、迁移与回归通过 | 已实现自动学习 |
| M1 产品经验闭环 | 产品隔离、不可变版本、证据聚合、手动/自动检索与人工晋升可用 | 自动晋升已获批准 |
| M2 有限自动晋升 | 仅授权低风险类别经独立证据和评测自动晋升；灰度、隔离、审计、回滚通过 | 任何任务/产品均有效或可以物理自治 |
| M3 系统层 RSI | 真实任务流对照评估满足预注册收益与安全门，持续监控可复现 | 模型权重持续自我改进、无限递归或全面安全 |
| M4 本体学习 | 自动候选、可追溯验证与人工发布闭环 | 未经批准的本体自动发布或设备写入 |

最终完成需同时满足：① 产品双向隔离和撤权全入口实证；② 真正独立后续证据触发自动候选聚合及授权范围内自动 validated，不使用裸 SQL；③ 自动注入和 `search_memory` 均引用同一有效版本并可追溯；④ 污染/冲突/失效可停用且派生物清理有证据；⑤ 独立、时间隔离的评测证明预注册条件内相对基线有价值，安全硬门为零违规；⑥ Profile、可执行技能、本体和设备行为不越过既有授权；⑦ 审计可重放、崩溃可恢复、结果按 mock/模拟/真实 LLM/物理 HIL 分类。若样本不够或外部依赖不稳定，则只能宣称已完成机制，效果仍未证实。

## 8. 独立审查与处置

2026-11-17 基于初稿并行进行了三项只读独立审查；未运行测试，审查不构成实现验证。以下为初稿问题及本版设计处置，不代表相关代码已修复。

| 审查 | 结论及主要 P1 | 本版处置 |
|---|---|---|
| 架构与迁移 | 未确认 P0；指出跨 kind 覆盖、旧版回滚、迁移黑名单、Profile pin、列表旁路、可信快照、反射事件丢失和审计确认等 9 项 P1、2 项 P2。 | 任务 1/2/3/5 增加数据库隔离、同批白名单、兼容回滚、全入口和每回合 scope、事件 outbox 与持久确认；增加删除保留政策。 |
| 安全与权限 | 未确认 P0；指出全入口策略、Beta 来源传递限制、经验回声、事务重查、原生 session 撤销、数据外发及旧审批/bench 等 9 项 P1、2 项 P2。 | §3–5 与任务 1–5 增加来源血缘、独立外部判据、提交门、主体委托、干净会话、接收方授权和禁用旧评测门。 |
| 文献与评估 | 未确认 P0；指出四臂状态串扰、重复使用 holdout、不可计算验收、旧 Profile 点估计、零违规解释和真实业务未定义等 6 项 P1、2 项 P2。 | §2/5 与任务 5/8 增加独立事件流、冻结统计方案、置信区间与成本门、安全覆盖矩阵以及真实业务单独声明；修正文献边界。 |

第二轮独立复审未发现有充分证据的 P0，提出 6 项计划级 P1：主张起点/证据快照、Beta 来源跨任务传播、回滚状态机、advisory 旁路、旧删除入口和持续评测数据供给。本版已在 §3/5 和任务 1–3/8 补充明确契约与测试；这些修订尚未再由独立审查者验证。

这些条目属于计划层处置；需后续实现、负测和复审证明有效。执行前仍须基于当前 HEAD 重新确认文件、授权政策和待批准 ADR。尤其自动晋升阈值、风险分类、样本量与真实业务窗口尚未批准，缺失时保持关闭。
