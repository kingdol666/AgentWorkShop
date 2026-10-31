# 深度审稿报告

**论文**: `D:\codes\ABO\AgentWorkShop\paper\tii\SUBMISSION-IEEE-TII\main.tex` | **语言**: EN | **模式**: deep-review
**生成时间**: 2026-10-25 01:36
**工件目录**: `D:\codes\ABO\AgentWorkShop\paper\tii\SUBMISSION-IEEE-TII\paper-audit-2026-10-25\agentworkshop-a-configurable-framework-for-multi-scenario-industrial-agent-integration`

## 总体评估

同行评审建议：大修（5.0/10）。

执行方式：native delegated。三名独立子代理分别覆盖编辑/逻辑、理论/相关工作、实验方法；主审复核了论文源文件、证据台账、9 份 Q5 原始 JSON 与当前版本信息，并检查了 PDF。它不是五名模型组成的独立评审团；没有进行外部文献检索或 IEEE TII 当前投稿政策核验。

稿件总体叙事连贯，能清楚介绍 AgentWorkShop 的架构、模块、运行流程与路由证据；Fig. 1 和 Fig. 2 分页呈现，实验的正向与失败边界披露较充分。核心缺口是当前版本的多场景 profile/binding 适配没有直接实验支撑，且 782 项 Q5 回归来自 v0.7.57，当前代码版本为 v0.8.0。稿件应补做当前版本的匹配跨场景测试，或明确把该能力限定为设计目标并标注旧版回归证据。

机械审查：PDF 为 10 页 Letter，使用 IEEEtran journal 模板；摘要约 203–207 词，5 个关键词；图像、表格和伪代码检查通过。当前 PDF SHA-256 与 FILE-MANIFEST.json 一致。页面 2–9 已逐页目视检查，未见用户此前指出的大片留白；PDF 构建日志无 Overfull hbox，存在若干 Underfull 警告但未造成明显版面缺陷。自动审计产生的 388 条低层信号多为模板/解析噪声；其中“摘要缺少结果/结论”“缺少 methods section”“Fig. 1 未引用”与实际英文稿不符，未纳入评审问题。IEEEtran 模板规格脚本因本机缺少其预期的 IEEEtran.md 文件而报错，这属于检查器环境问题。参考文献 DOI/页码未联网核验。

- **主要**: 1
- **中等**: 3
- **次要**: 2

## 学术预审委员会

### 主编（直接拒稿筛查）

## Editor Perspective

**Recommendation: Major Revision.** The manuscript has a coherent architecture-paper pitch and a clearly bounded abstract. The central acceptance risk is evidence-to-version alignment: the paper emphasizes configurable multi-scenario integration, but the historical four-scene traces use a direct-node path, current profile checks use mock I/O, and the 782-check deployment suite is recorded on v0.7.57 while the current repository is v0.8.0. This leaves the current framework's central cross-scene capability unvalidated. The manuscript is candid about several limitations; the remedy is to align the core evidence with the current implementation or narrow the empirical claim.

No desk-reject trigger is supported by this review. The automated fallback report's unquoted abstract concern was not adopted.

### 评审 1（理论贡献）

## Theory and Design Contribution Perspective

The claimed contribution is an integration architecture and implementation rather than a new control or optimization algorithm. Section III makes the design concepts understandable, but the claimed derivation of five requirements and six principles is not traceable to modules, invariants, and evidence. A concise requirement-to-rule-to-module-to-evidence mapping would make the reusable design logic auditable without inventing a theoretical contribution.

### 评审 3（文献对话）

## Literature Perspective

The manuscript correctly limits its research-gap statement to selected comparators and avoids claiming that no prior industrial-agent system exists. However, Table I gives no explicit selection rationale and compares only three of the systems named in the surrounding review. Add a selection criterion or a concise feature-based synthesis. No external literature search was performed, so field-wide novelty is not independently verified.

### 评审 2（方法与透明度）

## Methodology Perspective

Q1–Q6 are mostly reported with appropriate units and boundaries: Q4 is one seed-42 trajectory per simulator scene; Q1 reports five acquisition families, four writable mappings, and bounded probe counts; Q2 has two tasks under one harness/provider/model; Q3 uses three seeds and a finite-grid reference with proxy energy/throughput terms; Q5 reports nine sequential suite runs and 782 software assertions; Q6 is one cadence-overridden recipe trajectory. The paper distinguishes these archives and includes failures R11/R12 rather than presenting task completion as process success.

The main unresolved issue is that the evidence set does not validate the current version's profile/binding adaptation across scenes. We independently inspected all nine Q5 benchmark JSON records: each reports v0.7.57; the current package metadata reports v0.8.0. The manuscript does not state the Q5 version. A current-version matched cross-scene trial and an explicit version label for Q5 are needed. All process experiments are repository-simulator experiments; that boundary is stated honestly but limits evidence of plant-level industrial feasibility.

### 评审 4（逻辑链）

## Logic Perspective

The narrative moves from plant integration constraints to architecture, execution flow, module roles, evidence groups, and limitations. Figures 1 and 2 are distinct and their accompanying prose explains their relation; the system is not presented as only a governance mechanism. Two handoffs can be made more auditable: connect the five requirements/six rules to modules and tests, and make the Q4-first ordering clearer given Q1–Q6 labels. Abstract, discussion, and conclusion consistently state that current cross-scene profile/binding adaptation remains unvalidated.

### 委员会共识

# Committee Consensus

Execution mode: **native delegated** — three independent specialist agents covered editor/logic, theory/literature, and experimental methodology; the root agent consolidated their evidence and separately checked the source, artifacts, and PDF. This is not a five-model panel, and no external literature search was run.

**Overall score: 5.0/10. Recommendation: Major Revision.**

Score formula: 9.0 − 1.5 × 1 major − 0.7 × 3 moderate − 0.2 × 2 minor = 5.0.

## Priorities

1. **Major:** Align evidence with the current implementation and validate the stated cross-scene profile/binding capability, or narrow the central empirical claim. Explicitly identify Q5's v0.7.57 provenance.
2. **Moderate:** Connect requirements and design rules to modules and evidence groups.
3. **Moderate:** Strengthen the bounded related-work comparison with comparator-selection criteria and common dimensions.
4. **Moderate:** Add a physical/HIL/real-interface case or keep the industrial contribution explicitly limited to the tested simulator/software setting.
5. **Minor:** Normalize the evidence-group labels and clarify that the same 65 checks were rerun twice.

## Top Three Issues to Fix First

- Current-version cross-scene adaptation is not directly evaluated.
- Q5's 782 assertions are historical v0.7.57 results, not current v0.8.0 evidence.
- The design rationale is not traceable from requirements through implementation to evaluation.

## 论文摘要

# 论文摘要

## 研究问题
工业现场中的 agent 任务需要同时连接生产上下文、异构设备与不同流程约束；若每个场景独立实现，复用和操作证据追踪会变得困难。

## 核心设计
AgentWorkShop 将协作运行时和可注册 harness 与 line–product–recipe–run 上下文、场景配置、分析/建模服务、语义化采集与写入节点、协议驱动及路线专属证据连接起来。论文把共享调度检查、操作审批、设备回执与过程观测区分为不同边界。

## 论文结构
引言提出问题与贡献；相关工作限定比较对象和研究缺口；第三节阐释设计理念、六层架构与跨模块执行流；第四节拆解模块及其集成；第五节报告 Q1–Q6 证据组；第六、七节讨论边界并总结。

## 证据边界
证据由历史多场景模拟器轨迹、协议/写入检查、模拟器上的 agent 与 controller 任务、软件回归及单条 recipe 轨迹组成。当前 profile/binding 跨场景适配尚无同版本过程级验证；Q5 的 782 项断言来自 v0.7.57，而当前项目版本为 v0.8.0。


## 主要问题

### M1: 核心的当前版本跨场景配置能力缺少直接验证
- **类型**: methodology
- **来源**: [LLM] via `evaluation_fairness_and_reproducibility, claims_vs_evidence`
- **置信度**: high
- **章节**: abstract
- **关联章节**: abstract, introduction, system, modules, evaluation, discussion, conclusion
- **根因键**: `current-version-cross-scene-adaptation-evidence`
- **原文已核对**: 是
- **原文**: `Matched current-version cross-scene trials are still needed`
- **说明**: 这不是措辞过强的问题，稿件已主动限定结论；问题在于该限制正落在题目、引言和系统设计所强调的核心能力上。Q4 的四条场景轨迹来自历史 direct-node 路径；现有 profile/composition 的 65 项检查使用临时存储和 mock I/O。另有 Q5 的 782 项部署断言：九份归档 JSON 均记录 v0.7.57，而当前项目 package.json 为 v0.8.0，正文没有标明此版本差异。当前稿件因此没有展示同一当前版本如何通过配置和 binding 在不同场景之间完成任务。建议补做同一当前版本的匹配跨场景试验，并注明每个场景的 profile、binding、信号映射、成功/拒绝结果及代码版本；若暂不补做，应把多场景配置能力明确定位为架构设计目标，把 Q5 标为历史版本回归证据。

## 中等问题

### M1: 需求、设计规则、模块实现与实验之间缺少可追踪映射
- **类型**: presentation
- **来源**: [LLM] via `section_methods, claims_vs_evidence`
- **置信度**: high
- **章节**: system
- **关联章节**: introduction, system, modules, evaluation
- **根因键**: `design-requirements-principles-evidence-traceability`
- **原文已核对**: 是
- **原文**: `These requirements lead to six design rules`
- **说明**: Introduction item 1 presents deriving five requirements and six principles as a contribution; Section III lists both sets, then Sections III–V describe modules and separate experiments. The manuscript does not show how each requirement motivates a rule, which module enforces it, or which evidence group tests it. As written, this reads as a useful design inventory but not yet a reproducible design argument. Add a compact mapping in prose or a space-neutral matrix: requirement → rule → module/invariant → evidence and uncovered boundary. Keep the contribution framed as an integration architecture and implementation, not as a new control algorithm.

### M2: 工业相关性目前由模拟器和软件夹具支撑
- **类型**: methodology
- **来源**: [LLM] via `evaluation_fairness_and_reproducibility`
- **置信度**: medium
- **章节**: evaluation
- **关联章节**: abstract, evaluation, discussion, conclusion
- **根因键**: `simulator-only-industrial-validation`
- **原文已核对**: 是
- **原文**: `All process experiments use repository`
- **说明**: 论文准确声明所有过程实验均在仓库模拟器中，且没有将其写成实厂验证。对 IEEE TII 的工业读者而言，当前证据仍未展示真实控制器、现场通信链路或生产线上的互操作和运行边界；协议及写入测试也主要是模拟/测试工作流。因此论文可以支持所测软件路径的可行性，但产业部署意义仍有限。建议补充至少一个硬件在环、实验设备或现场只读接入案例，报告连接稳定性、延迟和故障响应；若本稿维持模拟器范围，应在摘要、贡献和结论中继续把结论严格限定为软件/模拟器集成证据。

### M3: 相关工作表的代表性选择标准及功能维度尚未说明
- **类型**: missing_information
- **来源**: [LLM] via `prior_art_and_novelty_grounding`
- **置信度**: medium
- **章节**: related
- **关联章节**: introduction, related
- **根因键**: `related-work-comparator-selection-and-dimensions`
- **原文已核对**: 是
- **原文**: `the research gap is limited to these`
- **说明**: 研究缺口被谨慎限定为 Table I 的对照对象，没有把结论扩写到整个领域，这是优点。但表中只比较 MADE、Köhle et al. 和 Waseem et al.，正文还介绍了其他工业 agent 研究；为何选这三项作为代表，以及它们与 AgentWorkShop 在场景配置、共享运行时、生产上下文、语义 I/O、工作流和证据记录上的差异，目前不够清楚。建议写明选择准则，或用一段紧凑的同维度综合比较补足缺口推导；避免扩大“尚无此类系统”的范围。

## 次要问题

### M1: 证据组编号与叙述顺序不一致
- **类型**: presentation
- **来源**: [LLM] via `section_results`
- **置信度**: high
- **章节**: evaluation
- **关联章节**: abstract, evaluation
- **根因键**: `evidence-group-order-and-labels`
- **原文已核对**: 是
- **原文**: `Q4 first presents the historical four-scene campaign to establish`
- **说明**: Section V 明确说明 Q1–Q6 是证据组而非研究问题，且给出先展示 Q4 的理由；不过后续仍以 Q1、Q2–Q3、Q5、Q6 命名，读者需要在编号和呈现顺序间来回转换。建议按证据组编号排列，或统一改为 E1–E6/描述性小节名称，并在摘要、图表和正文保持相同标签。此项属于可读性优化，不影响结果本身。

### M2: 说明 65 项 profile/composition 检查是否为同一套重复运行
- **类型**: presentation
- **来源**: [LLM] via `notation_and_numeric_consistency, evaluation_fairness_and_reproducibility`
- **置信度**: high
- **章节**: evaluation
- **关联章节**: abstract, evaluation
- **根因键**: `profile-suite-repeated-count-clarity`
- **原文已核对**: 是
- **原文**: `65 channel/profile and composition checks passed in an October`
- **说明**: 复现台账说明这是同一组 65 项检查在两个日期各运行一次，并非 130 个不同断言；正文这句话仍可能被读成累计数量或两次独立套件。建议直接写成“同一套 65 项检查于两个日期各运行一次”，并在摘要保持 65 个独立断言的口径。

## 决策信号

- **审稿推荐**: 大修
- **问题包**: 主要 1 / 中等 3 / 次要 2

## 修订路线图

### 优先级 1 --- 必须处理（阻断）

- [ ] 用同一当前版本补做匹配的跨场景 profile/binding 任务，报告场景配置、信号映射、工具可用性、成功/拒绝结果和过程指标；若暂不补实验，将跨场景适配明确作为架构设计目标，而非已验证结果（[LLM]; abstract, introduction, evaluation, discussion） ([LLM]; unknown)
- [ ] 在正文明确标注 Q5 的 782 项断言来自 v0.7.57；若要支持 v0.8.0 的部署行为，需在当前版本重新运行（[LLM]; evaluation, reproducibility） ([LLM]; unknown)

### 优先级 2 --- 强烈建议

- [ ] 用紧凑映射把五项需求、六条规则、实现模块/不变量、对应实验和未覆盖边界连起来（[LLM]; introduction, system, modules, evaluation） ([LLM]; unknown)
- [ ] 说明 Table I 对照系统的选择标准，或按统一功能维度综合比较（[LLM]; related） ([LLM]; unknown)
- [ ] 增加硬件在环、真实设备或生产接口证据；若本稿保留软件/模拟器范围，继续把工业应用结论限定在已测场景（[LLM]; evaluation, discussion） ([LLM]; unknown)

### 优先级 3 --- 可选改进

- [ ] 调整 Q1–Q6 标签或排序，让 Q4 先行的理由一目了然（[LLM]; evaluation） ([LLM]; unknown)
- [ ] 明确 October 20 与 October 24 是同一套 65 项检查的两次运行，不是 130 个不同断言（[LLM]; evaluation） ([LLM]; unknown)
- [ ] 确认投稿补充材料中包含正文引用的复现说明和匿名证据包（[LLM]; reproducibility） ([LLM]; unknown)
