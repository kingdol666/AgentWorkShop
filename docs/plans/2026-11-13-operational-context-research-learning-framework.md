# Operational Context & Research Learning Framework 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` or等价的逐任务执行流程实现本计划。每个任务必须在独立 PR 中完成，步骤使用 checkbox (`- [ ]`) 跟踪；本分支本轮只维护计划文档，不实现代码、不提交、不推送。
>
> **范围声明（2026-11-13）：** PVA 只是一个参数化案例，不是本框架的领域定义。注塑、WWTP 以及其他工业场景同样只能作为 fixture / acceptance profile。`line/product/recipe/run` 是现有工业适配器暴露的投影，不属于核心 schema；核心必须同时支持非产线场景、自定义驱动与没有物理设备写入的研究流程。

**Goal:** 建立一个领域无关的 Operational Context & Research Learning Framework，使任意运营场景、业务对象、材料/资源、工艺或工作流都能通过可扩展上下文模型、研究编排、证据适配与 RSI 学习闭环被发现、研究、验证和治理，而不把任何单一行业写入核心模型。

**Architecture:** 核心层只定义 `ContextSubject`、`DomainObject`、`Attribute`、`MaterialAssignment` 以及上下文快照、研究与证据的通用契约；领域语义由 ontology/schema extension 注册，运行时事实由 adapter/plugin 提供。研究编排只依赖抽象的 observe/actuate/simulate/replay/verify 能力，工业产线、PVA、注塑、WWTP 和非产线自定义场景都通过同一套 contract suite 验收。控制写入仍走现有治理咽喉，RSI 只消费受治理的证据并产生可回滚的学习工件。

**Tech Stack:** TypeScript/Zod contracts；SQLite/现有 schema 迁移；REST/MCP/Agent tool surface；AgentWorkShop plugin SDK；Ontology Service / Rule Trace；DAQ/DCW/孪生与自定义 driver adapters；研究编排与 AML/solver/twin adapters；RSI experience/profile/evidence pipeline；隔离 `AW_MODE=home` 验收实例。

**Spec:** 本文件是实施规格；相关现状与复用边界参见 `docs/plans/2026-10-24-ontology-service-plan.md`、`docs/plans/2026-11-02-scientific-exploration-plan.md`、`docs/rsi/STATUS-20261109.md`、`docs/plugins.md`、`.agents/skills/aw-plugin-dev/SKILL.md` 与 `docs/site/guide/line-permissions.md`。

## Global Constraints

- 核心 schema 不得包含 PVA、注塑、WWTP、line、product、recipe、run 等领域专用实体名作为必需字段、闭合枚举或核心关系。
- 核心实体必须以 `ContextSubject`、`DomainObject`、`Attribute`、`MaterialAssignment` 为可扩展基元；领域对象通过 namespace、schema extension 和 adapter projection 表达。
- `line/product/recipe/run` 只能由现有工业适配器提供映射、查询过滤和兼容视图；不能成为通用研究 API 的必填参数。
- 非产线场景必须能在没有 `lineId`、PLC、DAQ 或 DCW 的情况下创建上下文、执行观察/回放/人工研究并产出证据。
- 自定义 driver 必须声明能力（read/observe/actuate/simulate/replay/verify 等）；未声明或能力不匹配时 fail closed，不伪造采样、回读、执行或证据。
- 所有物理写入、业务高风险动作和控制模式切换继续经过既有权限、限界、频控、HITL 与审计链；本框架不创建写入旁路。
- Ontology 只提供语义、证据和约束编译输入，不成为第二个控制权威；编译产物只能收紧现有约束，不能放宽安全边界。
- evidence 与 RSI 工件必须携带 subject/object/attribute/material 的 provenance、时间窗、来源 adapter、内容 hash 和权限 scope；没有证据锚的学习结论只能标记为 `anecdotal`，不得晋级为 validated/control guidance。
- 插件不得将凭据写入源码、KV、日志或 prompt；插件出站使用宿主 API/HTTP 守卫，权限由宿主统一判定。
- PVA、注塑、WWTP acceptance profile 必须通过参数化 fixture 注入，核心 contract suite 不得针对某个 fixture 写专用分支。
- 本次工作只修改本计划文档；后续实施 PR 才允许修改代码、schema、插件和测试。本计划不授权提交或推送。

## Review Focus

- **无产线上下文：** 只提供业务对象、事件流、文档或人工观察时，系统仍可建立 ContextSubject 并完成研究闭环；由 Task 4/8 的 `non_line_context` fixture 覆盖。
- **层级与多归属：** 一个 DomainObject 可属于多个 subject，材料可跨阶段/批次/资产分配且带有效期；由 Task 1/8 的多父级、重叠有效期和撤销测试覆盖。
- **扩展隔离：** 新 ontology/schema extension 不能覆盖核心字段、伪造已注册类型或借扩展放宽控制；由 Task 2/3 的 namespace、版本和 compile negative tests 覆盖。
- **证据与学习质量：** stale、冲突、跨 scope、无 hash、无独立验证的 evidence 不得驱动 RSI 晋级或控制建议；由 Task 5/6 的 evidence/RSI fail-closed tests 覆盖。
- **权限与自定义驱动：** readonly、跨 subject、无 capability、驱动失联和人工审批拒绝都必须返回可审计拒绝而不是空成功；由 Task 3/6/8 的权限矩阵和 driver contract suite 覆盖。

---

## 1. 目标边界与术语

### 1.1 核心职责

框架提供五个相互独立但可组合的能力面：

1. **Operational Context**：把当前研究/运营对象、其属性、材料/资源分配、关系、时间有效性和来源组织成可查询的上下文快照。
2. **Semantic Extension**：用 ontology/schema extension 为领域增加类型、属性、关系、校验器和映射，不把领域知识写进核心代码。
3. **Research Orchestration**：将问题、假设、计划、观察/干预、判读、证据和学习结果编排成可恢复、可审计、可停止的研究运行。
4. **Evidence & RSI Adapters**：把设备、系统、文档、人审、模型、实验和既有 RSI 经验系统接入统一证据契约，并把可信结论回灌为可验证学习工件。
5. **Governance**：按 subject/object/attribute/material/research scope 做数据与动作授权；控制动作保留既有操作级治理。

### 1.2 明确不属于核心模型的内容

| 内容 | 处理方式 |
|---|---|
| 产线、产品、配方、运行批次 | `industrial-line` adapter 的 `ContextSubject`/`DomainObject` 投影；兼容现有 line/product/recipe/run API |
| PVA、注塑、WWTP | acceptance fixture 与 profile；只提供参数、数据、期望结果，不进入 core enum/required field |
| PLC、DAQ、DCW、MES | capability-specific driver/provider；研究编排只调用抽象能力 |
| 材料牌号、树脂、污泥、原料 | `DomainObject` + `MaterialAssignment` 的业务实例/extension type |
| AML、Twin、Solver | `ResearchExecutionAdapter` 或 `LearningAdapter`；不改变通用上下文身份模型 |
| RSI 的 line/product scope | 现有工业 scope 的 adapter projection；通用 scope 使用 subject/object/namespace selector |

### 1.3 关键术语

- **ContextSubject**：研究或运营的可授权主体/范围，例如一条产线、一台设备、一批物料、一个客户案例、一个污水处理单元、一个服务流程或一个模拟场景。它不是“line”的同义词。
- **DomainObject**：主体关联的可识别对象，例如设备、材料、订单、样本、工艺阶段、业务事件、文档或模型对象。
- **Attribute**：对象或主体在给定时间、来源和单位下的可观察/可设定/可计算事实；值可为 scalar/vector/table/file/event/reference。
- **MaterialAssignment**：材料、资源、样本或输入物与 subject/object/阶段之间的带时间和 provenance 的分配关系；不要求材料一定是生产原料。
- **ContextSnapshot**：在明确时间窗、scope、schema/ontology 版本和 adapter 版本下冻结的一组事实引用。
- **ResearchCase / ResearchRun**：与领域无关的研究问题及其一次执行；不强制绑定产线或设备。
- **EvidenceEnvelope**：任何观察、干预、判读、文档、人审或模型输出的统一证据包。
- **AcceptanceProfile**：参数化场景配置和可复用断言集合；不是生产 schema，也不是领域逻辑。

---

## 2. 核心契约（领域无关）

目标文件（后续实现 PR）预计位于 `server/services/workshop/context/`、`server/services/workshop/research/` 与 `shared/context/`。本节先钉死名称、边界和兼容策略。

### 2.1 核心实体

```ts
export type ContextRef = {
  namespace: string                 // 例如 core、industrial-line、customer-case
  id: string
  revision?: string
}

export type ContextSubject = {
  ref: ContextRef
  subjectType: string               // 开放字符串；由 extension 注册语义
  label: string
  scope: ContextScope
  parentRefs?: ContextRef[]
  status: 'draft' | 'active' | 'suspended' | 'retired'
  extensionData?: Record<string, unknown>
  provenance: ProvenanceRef[]
}

export type DomainObject = {
  ref: ContextRef
  objectType: string                // 开放字符串；不得闭合为 line/product/recipe/run
  subjectRefs: ContextRef[]
  role?: string                     // extension-defined role
  attributes: AttributeRef[]
  extensionData?: Record<string, unknown>
  provenance: ProvenanceRef[]
}

export type Attribute = {
  ref: ContextRef
  ownerRef: ContextRef
  key: string                       // namespace-qualified key
  value: Scalar | Vector | Table | FileRef | EventValue | ContextRef[]
  valueKind: 'scalar' | 'vector' | 'table' | 'file' | 'event' | 'reference'
  unit?: string
  semanticType?: string
  accessMode: 'observe' | 'set' | 'derive'
  validFrom?: string
  validTo?: string
  quality: 'raw' | 'normalized' | 'derived' | 'verified' | 'rejected'
  provenance: ProvenanceRef[]
  constraints?: AttributeConstraint[]
}

export type MaterialAssignment = {
  ref: ContextRef
  materialRef: ContextRef
  targetRefs: ContextRef[]          // subject/object/stage 等任意 ContextRef
  assignmentRole: string            // input/feed/sample/resource/lot 等由 extension 定义
  quantity?: Quantity
  validFrom?: string
  validTo?: string
  status: 'planned' | 'active' | 'consumed' | 'released' | 'recalled'
  provenance: ProvenanceRef[]
  extensionData?: Record<string, unknown>
}
```

约束：

- `subjectType`、`objectType`、`assignmentRole`、`semanticType` 为可注册开放字符串；核心只校验 namespace、版本、形态和引用存在性。
- `lineId/productId/recipeId/runId` 不出现在上述类型的必填字段；工业适配器可在 `extensionData` 或 adapter-specific view 中提供它们，但不得让 core service 依赖它们。
- `Attribute` 的单位换算复用现有 shared unit/dimension contract；缺少单位、类型不兼容或来源不明时返回结构化错误，不使用隐式 `?? 1` 等兜底。
- `MaterialAssignment` 不假设线性生产顺序；可用于样本—实验、资源—服务、客户—方案、原料—处理单元等关系。
- 所有引用均可追溯到 `ProvenanceRef`；发布/研究运行冻结的是引用集合及 hash，而不是拷贝外部高频时序数据。

### 2.2 上下文、关系与扩展

```ts
export type ContextScope = {
  tenantId?: string
  workspaceId?: string
  subjectRefs?: ContextRef[]
  objectRefs?: ContextRef[]
  tags?: string[]
  timeWindow?: { from: string; to: string }
}

export type ContextSnapshot = {
  id: string
  scope: ContextScope
  subjects: ContextSubject[]
  objects: DomainObject[]
  attributes: Attribute[]
  materialAssignments: MaterialAssignment[]
  relations: ContextRelation[]
  schemaRefs: ExtensionRef[]
  adapterRefs: AdapterRef[]
  contentHash: string
  createdAt: string
}

export type ContextRelation = {
  id: string
  kind: string
  src: ContextRef
  dst: ContextRef
  attributes?: AttributeRef[]
  evidenceRefs: EvidenceRef[]
  validFrom?: string
  validTo?: string
}
```

核心只提供通用 relation envelope；`influences`、`measures`、`owns`、`precedes` 等语义由 ontology extension 注册。任何 relation 进入 control/learning 侧前必须经过 evidence level、scope 和 freshness 校验。

### 2.3 Extension manifest

```ts
export type ContextSchemaExtension = {
  extensionId: string             // namespace/name
  version: string
  apiVersion: 'context-extension.v1'
  suppliedTypes: string[]
  suppliedAttributes: string[]
  suppliedRelations: string[]
  suppliedRoles: string[]
  validators: string[]
  projections?: string[]
  redactionPolicy?: string
  migration?: { from?: string; to: string; reversible: boolean }
  fixtures?: string[]
}
```

Extension 规则：

1. namespace 唯一，版本不可变；同 namespace 新版本必须显式发布/回滚，不允许静默覆盖。
2. extension 只能添加类型/属性/关系/校验器，不能删除或重定义核心字段，不能降低权限、证据或控制门槛。
3. extension validator 只能给出 `accept | warn | reject`，其中 `reject` 必须带 code、path、source；不允许通过异常吞掉校验失败。
4. 领域 extension 与 adapter 分离：extension 描述“是什么”，adapter 描述“从哪里读取/如何执行/如何映射”。
5. fixture 只能引用 extension manifest 和 adapter manifest；fixture 名称不得被生产服务逻辑 import。

---

## 3. Adapter 与 Plugin 扩展面

### 3.1 Adapter capability contract

定义一个与领域无关的 adapter interface，允许非产线和自定义驱动共存：

```ts
export type OperationalContextAdapter = {
  adapterId: string
  version: string
  subjectTypes: string[]
  capabilities: Array<
    'discover' | 'observe' | 'query' | 'actuate' | 'simulate' |
    'replay' | 'verify' | 'material-trace' | 'export'
  >
  discover(input: DiscoverRequest): Promise<ContextDiscoveryResult>
  snapshot(input: SnapshotRequest): Promise<ContextSnapshot>
  observe?(input: ObserveRequest): Promise<ObservationBatch>
  actuate?(input: ActuationRequest): Promise<ActuationResult>
  simulate?(input: SimulationRequest): Promise<SimulationResult>
  replay?(input: ReplayRequest): Promise<ReplayResult>
  verify?(input: VerifyRequest): Promise<VerificationResult>
}
```

- `actuate` 只能在 adapter capability、subject/object/attribute 权限和现有写治理均通过后调用。
- `simulate`、`replay`、`observe` 可独立工作，不得强制要求物理执行端存在。
- adapter 返回的事实必须规范化为 ContextSnapshot/EvidenceEnvelope；不把设备私有 payload 直接暴露给 core research service。
- industrial adapter 将现有 line/product/recipe/run、DAQ/DCW、MES、孪生对象映射到上述通用契约；其兼容 view 可继续保留原 API。

### 3.2 Plugin manifest 增量

在现有 plugin `index.mjs` 契约上增加可选扩展面，不改变既有 driver/tool/plugin 装载兼容性：

```js
export default {
  name: 'my-context-extension',
  version: '1.0.0',
  auth: 'agent-or-user',
  contextExtensions: ['./context-extension.mjs'],
  contextAdapters: ['./adapter.mjs'],
  evidenceAdapters: ['./evidence-adapter.mjs'],
  researchStrategies: ['./research-strategy.mjs'],
  setup(ctx) { /* 使用 ctx.context / ctx.research / ctx.evidence */ },
}
```

新增宿主能力的边界：

| 扩展面 | 责任 | 不允许做的事 |
|---|---|---|
| `context.registerExtension` | 注册 schema/ontology namespace、类型、关系、校验器 | 直接改核心 schema、绕过版本校验 |
| `context.registerAdapter` | discover/snapshot/observe/actuate/simulate/replay/verify | 绕过权限或直接写 PLC/数据库 |
| `evidence.registerAdapter` | 将外部事实转成 EvidenceEnvelope、hash、provenance | 自报 verified/control 级别 |
| `research.registerStrategy` | 计划生成、采样设计、判读策略 | 隐式执行写入、跳过审批 |
| `rsi.registerAdapter` | recall/reflect/validate/promote/rollback 映射 | 把 candidate/anecdotal 直接升级 |
| `ctx.twin` / `ctx.daq` / `ctx.dcw` | 现有专用能力继续保留 | 强迫所有领域走工业驱动 |

插件验收沿用 `aw-plugin-dev` 的生命周期、热加载、驱动、权限、凭据和失败隔离规则，并新增“同一 contract suite 可替换 fixture/adapter”断言。

### 3.3 Ontology / schema extension 关系

Ontology Service 继续承担版本化、证据级别、编译 trace、发布 HITL 和 scope 校验，但其实体目录改为：

- 核心语义：`ContextSubject`、`DomainObject`、`Attribute`、`MaterialAssignment`、`ContextRelation`。
- 工业语义：由 `industrial-process` extension 注册；`ProductionLine` 等只作为 extension type 和 adapter projection。
- 非工业语义：由 `service-case`、`logistics`、`environmental-unit`、`customer-journey` 等 extension（名称仅为示例，实施时由插件注册）提供。
- 编译目标仍可包括 `process_model`、`problem_ir`、`scene_contract`、`control_guard`，但必须允许 `research_context`、`evidence_policy` 等非控制目标；不能把所有领域强行转成工艺优化。
- 任何 extension compile result 带 `sourceExtensionRefs`、`adapterRefs`、`evidenceRefs` 和 `ruleTrace`；跨 extension 冲突默认拒绝，不以后写覆盖先写。

---

## 4. Research Orchestration

### 4.1 通用研究对象

```ts
export type ResearchCase = {
  id: string
  objective: string
  question: ResearchQuestion
  scope: ContextScope
  contextSnapshotId: string
  hypothesisRefs: string[]
  allowedCapabilities: string[]
  evidencePolicyRef: string
  acceptanceProfileRef?: string
  status: 'draft' | 'planned' | 'approved' | 'running' | 'paused' | 'completed' | 'failed' | 'retired'
}

export type ResearchPlan = {
  id: string
  caseId: string
  steps: ResearchStep[]
  design: 'observational' | 'interventional' | 'simulation' | 'replay' | 'human-review' | 'custom'
  budget?: { maxDurationMs?: number; maxActions?: number; maxCost?: number }
  stopConditions: StopCondition[]
  randomized?: boolean
  approvalRefs: string[]
}

export type ResearchStep = {
  id: string
  operation: 'snapshot' | 'observe' | 'query' | 'intervene' | 'simulate' | 'replay' | 'verify' | 'judge' | 'handoff'
  targetRefs: ContextRef[]
  inputAttributes?: string[]
  outputAttributes?: string[]
  adapterId: string
  requiresApproval: boolean
  evidenceRequired: boolean
}
```

研究状态机：

```text
question → plan_draft → preflight → approval → running
       → observation/intervention → verdict → evidence_commit
       → learning_candidate → validation → promoted/retired
```

状态迁移必须 CAS、幂等和可恢复；停止、超时、预算耗尽、驱动失联、权限撤销和 evidence invalidation 都是显式终态/中断原因。`intervene` 不是“写参数”的同义词，可表示业务动作、人工步骤、模拟动作或零物理写的输入条件；实际是否物理写由 adapter capability 与治理链决定。

### 4.2 非产线与自定义驱动

最低支持的 adapter/profile 类别：

1. **Document/event case**：文档、事件流或工单为事实源，只做 observe/query/replay。
2. **Batch/material study**：材料/样本/资源分配为主，支持 material trace、实验记录和人工判读，不要求 line/run。
3. **Service/business workflow**：客户、订单、服务步骤、SLA、人工动作和业务结果为上下文。
4. **Simulation/twin**：完全虚拟 subject，支持 simulate、observe、verify，可用来校准研究策略。
5. **Industrial process**：现有 line/product/recipe/run adapter，支持 DAQ/DCW/MES/孪生兼容面。
6. **Custom plugin**：用户通过 plugin manifest 自定义 subject/object、属性、驱动和证据映射。

上述名称仅是验收 profile 分类，不构成 core enum。任何新领域只需实现 extension + adapter + fixture contract，不应修改 core research orchestration。

### 4.3 研究编排与既有 AML/Twin/Solver

- AML adapter 消费 ContextSnapshot 中声明为 `observe`/`derive` 的 Attribute 和 MaterialAssignment，不假设控制列名是 SP/MV，也不假设存在 recipe。
- Twin adapter 通过 `sceneContractRef`、provider capability 和 subject/object refs 解析场景；provider 可按 extension 提供 dynamics、constraints、objective 或 uncertainty。
- Solver adapter 只接受经过 extension compiler 和 evidence policy 的 `ResearchProblem`；无法表达的结构必须返回 `REJECTED_UNSUPPORTED_FORM`，不能伪装为简单边界。
- DoE/可辨识性/互审策略作为 research strategy 注册；strategy 输出计划与判据，不直接接触设备写 API。
- 现有科学探索 P1–P6 的可辨识性、干预台账、动作覆盖、双通道互审和本体证据回灌迁移为 adapter hooks；其通用字段不得强绑 `line_id/node_id`。

---

## 5. Evidence 与 RSI Adapters

### 5.1 EvidenceEnvelope

```ts
export type EvidenceEnvelope = {
  id: string
  kind: 'observation' | 'intervention' | 'simulation' | 'replay' | 'document' | 'human-review' | 'model-output' | 'verification'
  subjectRefs: ContextRef[]
  objectRefs?: ContextRef[]
  attributeRefs?: ContextRef[]
  materialAssignmentRefs?: ContextRef[]
  researchCaseId?: string
  researchRunId?: string
  window?: { from: string; to: string }
  source: { adapterId: string; sourceRef: string; sourceRevision?: string }
  payloadRef: string
  payloadHash: string
  quality: 'raw' | 'normalized' | 'verified' | 'rejected' | 'stale'
  claimLevel: 'candidate' | 'observed' | 'supported' | 'validated' | 'anecdotal'
  supports?: string[]
  refutes?: string[]
  verifierRefs?: string[]
  accessScope: ContextScope
  createdAt: string
}
```

规则：

- Evidence adapter 只能声明来源和质量，不能自行宣称 `validated`；validated 由独立验证/研究判读/审批流程产生。
- `payloadHash`、source revision、窗口和 scope 缺一时，证据只能进入 rejected/anecdotal 分支。
- 支持/反驳同一 claim 的证据并存，不能以后写覆盖；冲突必须在研究结果、ontology rule trace 和 RSI recall 中可见。
- stale evidence 显式降级并阻断控制建议，保留原始证据供审计；不静默删除或回滚历史。
- evidence 权限独立于研究对象权限：能看到对象不等于能看到敏感 payload，能提交 evidence 不等于能批准 evidence。

### 5.2 RSI adapter contract

```ts
export type RsiAdapter = {
  adapterId: string
  version: string
  canRead(scope: ContextScope, actor: Actor): boolean
  ingest(input: EvidenceEnvelope): Promise<LearningCandidate>
  recall(input: RecallRequest): Promise<LearningHit[]>
  reflect(input: ReflectionTrigger): Promise<LearningCandidate[]>
  validate(input: ValidationRequest): Promise<ValidationResult>
  promote(input: PromotionRequest): Promise<PromotionResult>
  rollback(input: RollbackRequest): Promise<RollbackResult>
}
```

通用 scope 规则：

- RSI key 使用 `namespace + subjectRefs/objectRefs + optional materialAssignmentRefs + time/tenant scope`；`line/product/global` 只是 industrial adapter 的兼容 selector。
- candidate、anecdotal、validated、retired 等生命周期与现有经验/profile 语义对齐；跨 subject 复用必须有明确 scope 授权和证据匹配，不能仅按文本相似度外泄。
- profile/pin 可以引用任意 validated learning artifact，但研究运行必须记录命中的 artifact id、version、scope 和 provenance；撤权或 rollback 后在飞运行按 fail-closed/人工复核处理。
- RSI 模块不包含任何设备写调用；控制建议必须返回 research/approval payload，实际动作仍由 adapter + 既有治理链执行。

### 5.3 研究结果到 Ontology 的回灌

`EvidenceEnvelope` → `ontology_evidence` / `ontology_rule_traces` 的映射必须保留：

1. 研究事实对应的 ContextRef 集合；
2. extension/ontology 版本和 adapter 版本；
3. 支持/反驳方向、统计判据、MDE/CI/不确定性（如适用）；
4. 可复现的 payload hash 和 research run；
5. 是否允许进入 control/solver/learning 目标。

没有满足 evidence policy 的结论可以作为解释性 candidate 返回，但不得编译为 hard control guard、不得产生 `validated` RSI pin、不得改变 DCW/业务动作。

---

## 6. 权限、隔离与审计

### 6.1 通用权限维度

权限 subject 从“用户 × 产线”提升为“actor × ContextScope × capability”，保留工业 line grant 作为 adapter 兼容视图：

| 能力 | 含义 | 默认 |
|---|---|---|
| `context.read` | 读取 subject/object 的非敏感上下文 | 依 scope 授权 |
| `context.read_sensitive` | 读取敏感属性、材料批次、payload | 显式授予 |
| `context.contribute` | 提交观察、材料分配或候选事实 | 受 scope 限制 |
| `research.propose` | 创建 ResearchCase/Plan | owner/editor |
| `research.execute_observe` | 执行 observe/query/replay/simulate | 受 adapter capability |
| `research.execute_actuate` | 发起有副作用动作 | operate + action policy |
| `research.approve` | 批准研究/证据/发布 | 独立 reviewer/admin |
| `learning.promote` | 将 candidate 晋级 validated/profile | owner/admin，禁止 Agent 自批 |
| `context.admin` | 注册 extension/adapter、撤退版本、处理权限 | admin |

权限检查至少覆盖 actor、tenant/workspace、subject/object refs、attribute sensitivity、material assignment、research case、adapter capability 和 action risk。父 subject 不自动继承子对象写权；继承必须由 policy 显式声明并留下审计事件。

### 6.2 工业兼容

- `lineMode(user, lineId)` 继续支持 `none|readonly|operate`，由 industrial adapter 映射到通用 subject scope；现有 `line-permissions` 行为不回归。
- `line/product/recipe/run` 过滤在 adapter 边界完成；core context/research API 对无 line 的请求不返回“缺少 lineId”错误。
- 设备绑定、配方管理、DCW 写、auto/manual 切换继续复用现有 node/recipe/line grants 和 HITL；通用 `research.execute_actuate` 只能进入同一写咽喉。
- 权限撤销应广播通用 `context.permissions.changed`，同时保留现有 `permissions.changed` 与 plugin `permissions:changed` 兼容事件。

### 6.3 审计与注入安全

所有扩展注册、adapter 调用、研究状态迁移、evidence ingest/verify、RSI promote/rollback、权限拒绝和物理动作都记录 actor、scope、adapter、request hash、result code 和关联 refs。候选文本进入 prompt 前必须经过 sanitizer、来源标记和预算截断；candidate 不能伪装成系统指令或工具调用。

---

## 7. 数据库与兼容迁移策略

本计划只定义实施边界，不在本轮修改 schema。后续实现必须遵循以下顺序：

1. 新增 core 表/仓储：`context_subjects`、`domain_objects`、`attributes`、`material_assignments`、`context_relations`、`context_snapshots`、`context_extensions`、`context_adapters`。
2. 新增 research 表/仓储：`research_cases`、`research_plans`、`research_runs`、`research_steps`、`research_verdicts`；动作/干预表使用通用 `target_refs`/`attribute_refs`/`material_assignment_refs`，不要求 `line_id/node_id`。
3. 新增 evidence/RSI 引用表：`evidence_envelopes`、`evidence_links`、`learning_artifacts`、`learning_scope_refs`；既有 `ontology_evidence`、`ontology_rule_traces`、RSI 表通过 ref/adapter 关联，不复制 payload。
4. 现有工业表和 API 不删除、不强制回填；新增 industrial adapter 负责双向映射。兼容读视图可以暴露 `line/product/recipe/run`，但 core 查询只以 ContextRef 为准。
5. 所有迁移使用幂等 `CREATE TABLE IF NOT EXISTS`/受控 rebuild，列清单与老库升级测试固定；published extension/context snapshot/evidence/learning artifact 不可变。
6. 高频时序/大文件仍外置存储，表中仅保存 payloadRef、hash、window、统计摘要和权限 scope。
7. 删除/退役使用状态迁移与引用检查；已被 evidence、research 或 learning 引用的对象不能物理删除。

---

## 8. PR 拆分与依赖

每个 PR 必须只包含计划中一组相邻职责，带自己的单测/契约测试和 evidence JSON；不得把 PVA fixture 代码与 core contract 混在同一个 PR。推荐拆分如下：

| PR | 主题 | 主要文件/模块 | 交付与门禁 | 依赖 |
|---|---|---|---|---|
| PR-0 | 文档与术语重置 | 本计划；后续 docs/site 术语索引 | grep 确认核心无 PVA/line schema 绑定；评审确认范围 | 无 |
| PR-1 | Core Context contracts | `shared/context/*`、`server/services/workshop/context/contracts.ts`、validator、repo、schema tests | ContextSubject/DomainObject/Attribute/MaterialAssignment CRUD、时间/引用/hash/单位负例全绿 | PR-0 |
| PR-2 | Extension registry + ontology bridge | `context/extensions/*`、Ontology Service contracts/compiler/context injection bridge | namespace/version/validator/compile trace、扩展不能放宽控制、published immutable | PR-1 |
| PR-3 | Adapter/plugin SDK | plugin host context registry、adapter registry、manifest/schema、SDK types、lifecycle tests | 自定义 adapter 可注册/停用/热重载；capability mismatch fail-closed；凭据/SSRF/权限红线全绿 | PR-1/2 |
| PR-4 | Generic research orchestration | `research/*`、REST/MCP/host tool handlers、state machine、scheduler/stop/recovery | non-line case 可完成 question→plan→run→verdict；无设备写；预算/取消/重启恢复通过 | PR-1/3 |
| PR-5 | Evidence adapters + RSI bridge | `evidence/*`、`rsi/*` adapter、ontology evidence/rule trace bridge | hash/provenance/scope/stale/conflict；candidate 不得晋级；promote/rollback 与现有 RSI 兼容 | PR-2/4 |
| PR-6 | Permissions and governance | 通用 scope ACL、adapter permission mapping、HITL/action gateway、audit | context/object/attribute/material/research 矩阵；工业 lineMode 回归；跨 scope、readonly、撤权、Agent 自批全拒 | PR-3/4/5 |
| PR-7 | Industrial adapter compatibility | `industrial-process` extension/adapter、line/product/recipe/run compatibility views、DAQ/DCW/MES/Twin mappings | 现有产线/配方/运行链路无回归；core 不读 line required field；control write 仍单一咽喉 | PR-1/3/4/6 |
| PR-8 | Fixtures and acceptance profiles | `tests/fixtures/context/*`、`tests/profiles/*`、acceptance runner | PVA、注塑、WWTP、非产线、自定义 driver 均用同一 runner；fixture 参数化，无 core 分支 | PR-1–7 |
| PR-9 | UI/docs/release closeout | context/research/evidence/permission UI、site docs、i18n、release evidence | docs/i18n/typecheck/build、权限可见性与审计展示、完整矩阵 evidence | PR-1–8 |

### 8.1 PR 约束

- PR-1/2 不可导入 PVA/注塑/WWTP fixture；PR-8 才引入 fixture 数据。
- PR-3 只提供扩展面和契约，不为某个领域写专用 adapter；工业 adapter 单独在 PR-7。
- PR-4 不直接修改现有 line-specific exploration 工具以“兼容通用”；应先通过 adapter facade，必要的兼容修复放 PR-7。
- PR-5 不修改既有 RSI 的安全红线；新增通用 scope 时提供 line/product selector 的兼容测试。
- PR-6 先复用现有权限/HITL/write gateway，再考虑通用抽象；禁止为通用研究新增第二套设备写路径。
- PR-8 的每个 fixture 必须声明 extension、adapter、capabilities、数据生成方式、预期 evidence 和 profile version；fixture 名称不能进入 shared/server core import。

---

## 9. 参数化 Fixtures 与 Acceptance Profiles

### 9.1 Fixture 统一形状

```ts
export type ContextAcceptanceProfile = {
  profileId: string
  profileVersion: string
  displayName: string
  domainNeutral: true
  extensions: string[]
  adapters: string[]
  subjects: FixtureSubject[]
  objects: FixtureObject[]
  attributes: FixtureAttribute[]
  materialAssignments?: FixtureMaterialAssignment[]
  researchCases: FixtureResearchCase[]
  expectedCapabilities: string[]
  expectedEvidence: EvidenceExpectation[]
  permissionMatrix: PermissionExpectation[]
  negativeCases: NegativeExpectation[]
}
```

Profiles 使用 `domainNeutral: true` 作为元数据自检；它不表示 fixture 没有业务语义，而是表示业务语义完全通过 extension/adapter 参数提供。

### 9.2 必须覆盖的 profiles

| Profile | 仅作为参数 | 验收重点 |
|---|---|---|
| `fixture-pva-process` | 材料/设备/属性/观测窗口/工业 adapter 参数 | 验证 PVA 不被当作核心 schema；材料分配、上下文快照、证据回灌、工业兼容写治理 |
| `fixture-injection-process` | 注塑设备/工艺属性/配方映射参数 | 同一研究编排可复用；AML/Twin/solver adapter 接口；recipe 只在 industrial projection 出现 |
| `fixture-wwtp-process` | 处理单元/水质属性/材料与样本参数 | 多单元关系、材料/样本分配、时窗证据、约束/guard 只收紧 |
| `fixture-non-line-service-case` | 客户/订单/服务步骤/人工事件参数 | 无 line/product/recipe/run、无 PLC/DAQ/DCW，仍能 research→evidence→RSI |
| `fixture-custom-driver` | 用户自定义 subject/object/driver capability 参数 | 插件注册、热加载、权限、capability mismatch、replay/simulate/verify |

PVA、注塑和 WWTP 的名称只出现在 fixture/profile 文件、验收报告和展示文案，不出现在 `shared/context`、通用数据库表、核心工具名、core ontology enum 或 generic REST 必填参数中。

### 9.3 Fixture runner

新增一个参数化 runner（后续实现位置建议 `scripts/acceptance-context-learning.mjs`），输入 profile 路径，固定执行：

1. load extension/adapter/profile 并校验 manifest；
2. create subjects/objects/attributes/material assignments；
3. freeze ContextSnapshot 并核验 hash/provenance；
4. 创建 research case/plan，执行 observe/query/simulate/replay/custom capability；
5. 生成 verdict 和 EvidenceEnvelope；
6. 回灌 ontology/evidence/RSI adapter；
7. 运行 permission matrix 和 negative cases；
8. 输出统一 `report.json`：profile、contract version、adapter versions、断言数、拒绝码、evidence refs、未覆盖面。

同一 runner 必须不包含 `if (profile === 'pva')` 等领域分支；领域差异只能来自 profile 数据和 extension/adapter 实现。

---

## 10. 验收矩阵

### 10.1 Core contract matrix

| Gate | 断言 | 证据 |
|---|---|---|
| C0 Schema neutrality | core schema/contract 无 PVA/注塑/WWTP/line/product/recipe/run 必需字段或闭合 enum | 静态 schema lint + contract snapshot |
| C1 Core entities | 四个核心实体可创建、更新、冻结、查询、退役；refs/provenance/hash 完整 | unit + API report |
| C2 Extension isolation | namespace/version/validator/compile trace；冲突、重定义、放宽约束均拒绝 | extension negative suite |
| C3 Non-line | 无 lineId 的 service/document/material/simulation case 完成 research run | non-line profile report |
| C4 Custom capability | adapter capability 选择正确；不存在 capability 的操作 fail-closed | plugin/adapter contract suite |
| C5 Temporal/material | 多时窗、多材料 assignment、撤销、重叠和跨对象关系可追踪 | context fixture report |

### 10.2 Research/evidence/RSI matrix

| Gate | 断言 | 证据 |
|---|---|---|
| R1 Orchestration | question→plan→approval→run→verdict→evidence→learning 状态可恢复、幂等、可停止 | research e2e |
| R2 Driver safety | observe/simulate/replay 不要求物理写；actuate 只进入既有治理咽喉 | adapter + write audit |
| R3 Evidence integrity | sourceRef/window/hash/scope 缺失拒绝；stale 显式降级；support/refute 冲突可见 | evidence unit/e2e |
| R4 RSI integrity | candidate/anecdotal 不可晋级；validated/pin 带 evidence refs；rollback/revocation 收敛 | RSI adapter e2e |
| R5 Ontology bridge | evidence 回灌保留 ContextRef/extension/adapter/rule trace；只收紧；不可表达结构明确拒绝 | ontology compile report |
| R6 Learning isolation | 不同 scope/tenant/subject 无越权 recall；跨 subject 复用需授权与匹配 | cross-scope matrix |

### 10.3 Permissions/governance matrix

| Actor / scope | context read | sensitive read | contribute | research propose | observe/simulate/replay | actuate | approve/promote |
|---|---:|---:|---:|---:|---:|---:|---:|
| readonly | yes | no | no | no | profile-dependent | no | no |
| contributor | yes | policy | yes | yes | yes | no | no |
| operator | yes | policy | yes | yes | yes | existing action policy | no |
| reviewer | scope | policy | review | review | no implicit action | no | approve |
| admin | all | all | all | all | all | still via gateway | all |
| Agent | inherited channel scope | no by default | candidate only | bounded | registered tool only | never direct | never self-approve |

必须执行：跨 subject 403、跨 tenant 403、readonly actuate 拒绝、撤权中断在飞 run、stale evidence 阻断 promote、Agent 自批拒绝、工业 lineMode 44/44 兼容回归。

### 10.4 Profile matrix

| Profile | C0–C5 | R1–R6 | 权限矩阵 | 工业兼容 | UI/报告 |
|---|---:|---:|---:|---:|---:|
| PVA fixture | 全部 | 全部适用项 | 全部 | 适用 | 必须 |
| Injection fixture | 全部 | 全部适用项 | 全部 | line/product/recipe/run adapter | 必须 |
| WWTP fixture | 全部 | 全部适用项 | 全部 | 适配器可选 | 必须 |
| Non-line service case | 全部 | 全部 | 全部 | 不适用且不得失败 | 必须 |
| Custom driver | 全部 | capability 相关 | 全部 | 不适用 | 必须 |

### 10.5 回归与发布门

在实现 PR-9 前，按变更面执行：

```bash
npm run lint
npm run typecheck
npm run docs:check
npm run i18n:check
npm run test:unit
npm run test:plugin-lifecycle
npm run test:sdk-surface
npm run test:twin-provider
node scripts/acceptance-context-learning.mjs --profile tests/profiles/context/all.json
npm run test:e2e-line
```

判定规则：

- core contract、non-line、custom driver、每个行业 profile 的 report.json 必须同轮生成；不能只跑 PVA 就宣称通用。
- 现有科学探索闭环、ontology、RSI、插件和工业权限基线不得下降；外部依赖缺失必须显式写入报告，不得静默跳过。
- 所有拒绝用例必须断言拒绝码、零越权副作用和恰一条审计事件；“返回空成功”不算通过。
- Mimosa/安全扫描若 inconclusive，只能如实报告，不得把功能验收写成安全通过。

---

## 11. 实施任务清单

### Task 1: Core Context model and neutrality gate

**Files:**
- Create: `shared/context/contracts.ts`
- Create: `shared/context/refs.ts`
- Create: `server/services/workshop/context/contracts.ts`
- Create: `server/services/workshop/context/validator.ts`
- Test: `tests/context-core-contract.test.ts`
- Test: `tests/context-schema-neutrality.test.ts`

**Interfaces:**
- Produces `ContextSubject`、`DomainObject`、`Attribute`、`MaterialAssignment`、`ContextSnapshot`、`ContextRelation`、`ContextScope`。

- [ ] 写四实体及 snapshot 的 Zod/TypeScript contract，验证 namespace-qualified refs、开放类型和 provenance。
- [ ] 写 neutrality test，扫描 core contract、schema 和 generic API 参数，拒绝 PVA/行业实体成为 required/closed core semantics。
- [ ] 写时间有效性、单位失配、悬空引用、重复 assignment、无 provenance 的失败用例。
- [ ] 以隔离数据库运行 contract tests，确认冻结 snapshot 的 canonical hash 稳定。

### Task 2: Schema extension and ontology bridge

**Files:**
- Create: `server/services/workshop/context/extensions/registry.ts`
- Create: `server/services/workshop/context/extensions/contracts.ts`
- Modify: existing Ontology Service bridge only after Task 1 contract is stable
- Test: `tests/context-extension-registry.test.ts`
- Test: `tests/context-ontology-bridge.test.ts`

**Interfaces:**
- Consumes Task 1 refs and snapshots。
- Produces `ContextSchemaExtension`、extension lifecycle、rule trace source refs。

- [ ] 实现 extension registration/validate/publish/retire，固定 namespace/version/immutable 语义。
- [ ] 实现 extension validator 的 accept/warn/reject contract 和结构化 error path。
- [ ] 将 ontology entities/relations/evidence 映射到四个核心实体；禁止 extension 重定义核心字段或放宽控制。
- [ ] 覆盖跨 extension 冲突、未知 extension、版本漂移、unsupported compile form 和 candidate 文本注入负例。

### Task 3: Adapter and plugin SDK

**Files:**
- Modify: plugin host registry and SDK type exports
- Create: adapter registry/permission facade/normalizer modules
- Test: `tests/context-adapter-contract.test.ts`
- Test: `tests/context-plugin-lifecycle.test.ts`

- [ ] 注册 `OperationalContextAdapter`、capability、extension、evidence adapter 和 research strategy。
- [ ] 将 `discover/snapshot/observe/simulate/replay/verify/actuate` 统一为 typed request/result；未声明 capability fail closed。
- [ ] 对 project/user/builtin plugin 做热加载、dispose、失败隔离、凭据和出站安全测试。
- [ ] 保持现有 `ctx.daq`、`ctx.dcw`、`ctx.twin`、`ctx.permissions` 兼容，不为通用框架复制专用 driver。

### Task 4: Generic research orchestration

**Files:**
- Create: `server/services/workshop/research/contracts.ts`
- Create: `server/services/workshop/research/orchestrator.ts`
- Create: REST/MCP/host tool surfaces under existing workshop conventions
- Test: `tests/research-orchestration.test.ts`
- Test: `tests/research-non-line.test.ts`

- [ ] 实现 ResearchCase/Plan/Run/Step/verdict 状态机、CAS、幂等、cancel/pause/resume/recovery。
- [ ] 编排只依赖 adapter capability 和 ContextRef，不读取 line/product/recipe/run 必填字段。
- [ ] 支持 observational/interventional/simulation/replay/human-review/custom 研究模式。
- [ ] 研究执行生成 EvidenceEnvelope refs；actuate 只调用治理后的 gateway，非物理模式不得伪造 readback。
- [ ] 用无产线 service/document/material fixture 完成一次完整研究闭环。

### Task 5: Evidence and RSI adapters

**Files:**
- Create: `server/services/workshop/evidence/contracts.ts`
- Create: `server/services/workshop/evidence/registry.ts`
- Create: `server/services/workshop/rsi-adapter/*`
- Modify: existing ontology evidence and RSI bridge at narrow adapter boundary
- Test: `tests/evidence-integrity.test.ts`
- Test: `tests/rsi-context-scope.test.ts`

- [ ] 实现 EvidenceEnvelope normalization、hash、provenance、quality/freshness、support/refute/conflict。
- [ ] 将现有 intervention/DAQ/MES/twin/document/human/model evidence 映射到通用 refs。
- [ ] 将 RSI recall/reflect/validate/promote/rollback 适配为 generic subject/object/material scopes，保留 industrial selector 兼容。
- [ ] 验证无锚、stale、跨 scope、无独立验证的工件不能 promote/control；回滚和权限撤销可收敛在飞引用。

### Task 6: Permissions, HITL and audit

**Files:**
- Modify: existing permission resolution, tool gate, approval and audit surfaces
- Create: generic scope policy/decision tests
- Test: `tests/context-permissions.test.ts`
- Test: `tests/context-governance-negative.test.ts`

- [ ] 实现 actor × scope × capability × risk 的通用判定，父级不隐式授予子对象写权。
- [ ] 映射现有 lineMode 和工业绑定权限，确认 `line/product/recipe/run` 只在 adapter view。
- [ ] 所有高风险研究/证据/发布动作经过独立审批；Agent 不可自批；物理写仍走单一写咽喉。
- [ ] 覆盖 readonly、跨 tenant/subject、撤权、驱动失联、审批拒绝和恰一条审计事件。

### Task 7: Industrial compatibility adapter

**Files:**
- Create: `server/plugins-builtin/industrial-context-adapter/` or等价 adapter package
- Modify: existing line/recipe/run integration only through adapter facade
- Test: `tests/industrial-context-adapter.test.ts`
- Test: existing line/recipe/permission regression suites

- [ ] 将 line/product/recipe/run 映射为 ContextSubject/DomainObject/Attribute/MaterialAssignment refs。
- [ ] 保留现有 API、driverConfig、DAQ/DCW/MES/Twin、recipe evidence 与权限行为。
- [ ] 证明 core research service 可用同一接口访问 industrial 与 non-line fixture；不存在 lineId 时不走工业兼容分支。
- [ ] 验证控制 guard 只收紧、写频控/HITL/回读证据不被 adapter 绕过。

### Task 8: Parameterized fixtures and acceptance runner

**Files:**
- Create: `tests/fixtures/context/{pva,injection,wwtp,non-line,custom-driver}/`
- Create: `tests/profiles/context/*.json`
- Create: `scripts/acceptance-context-learning.mjs`
- Test: `tests/context-acceptance-profile.test.ts`

- [ ] 用同一 profile schema 定义 PVA、注塑、WWTP、non-line、custom-driver 五类 fixture。
- [ ] 运行 C0–C5、R1–R6、权限 negative cases 并输出 report.json。
- [ ] 静态检查 runner 不含领域条件分支；profile 只提供数据、extension、adapter、能力和期望。
- [ ] 对每个 profile 记录未覆盖面、拒绝码、证据 refs 和 adapter/schema 版本。

### Task 9: UI/docs/release evidence

**Files:**
- Modify: context/research/evidence/permission UI and site docs
- Create: acceptance report/evidence under existing audit convention
- Test: browser/i18n/docs/build/release smoke tests

- [ ] 展示 ContextSubject/object/attribute/material、snapshot、research run、evidence provenance、permission decision 和 adapter health。
- [ ] UI 不把 line/product/recipe/run 作为通用导航前提；工业视图可通过 adapter label 展示。
- [ ] 中文/英文术语 parity，所有 fixture 名称与领域说明放在 profile 文档而不是 core contract 文案。
- [ ] 运行全量回归并保存每个 profile 的 report.json；不提交任何代码变更到本计划分支，除非用户另行授权。

---

## 12. ADR / 设计裁决

- **Decision:** 用 `ContextSubject/DomainObject/Attribute/MaterialAssignment` 作为领域无关核心，extension 描述语义，adapter 描述来源和执行，research orchestration 描述过程，EvidenceEnvelope/RSI adapter 描述学习闭环。
- **Drivers:** 当前系统已有 ontology、工业 line/recipe、AML/Twin、科学探索和 RSI 能力，但它们的共享边界必须上移到可扩展上下文；PVA 不是平台边界，任何硬编码都会阻断非产线复用。
- **Alternatives rejected:**
  - 以 PVA/注塑/WWTP 任一场景作为核心 schema：拒绝，会把案例误当模型。
  - 把 line/product/recipe/run 直接升格为通用实体：拒绝，它们是工业适配器的历史兼容面，非所有运营场景共有。
  - 让每个领域各自实现一套研究/证据/权限链：拒绝，会造成治理、provenance 和 RSI 语义漂移。
  - 通过插件直接写核心数据库/PLC：拒绝，违反扩展隔离和既有安全边界。
  - 只做抽象接口、不做参数化 fixtures：拒绝，没有跨领域 contract suite 就无法证明通用性。
- **Consequences:** 需要增加通用 refs、scope、extension registry 和 adapter facade；工业兼容需单独 PR；短期会同时维护 core context 与 industrial compatibility view，但避免领域逻辑污染核心。
- **Open decisions:** extension 的持久化 namespace 命名规则、通用 scope selector 的 UI 形态、非工业 evidence 的保留期、外部 solver 对 custom attribute 的可表达子集；这些不得通过把 PVA/line 字段硬编码进 core 来“解决”。

## 13. 完成定义（DoD）

- [ ] 核心 contract 仅依赖领域无关基元；静态 neutrality gate 通过。
- [ ] 任意 extension/adapter/plugin 可在不改 core schema 的情况下注册新的 subject/object/attribute/material/driver。
- [ ] 至少一个无产线 profile 完成 research→evidence→RSI 闭环；至少 PVA、注塑、WWTP 三个 profile 用同一 runner 验收。
- [ ] line/product/recipe/run 仅在 industrial adapter/compatibility view 出现；现有工业链路和权限回归全绿。
- [ ] evidence provenance/hash/scope/freshness、ontology trace、RSI lifecycle 和 rollback 均可查询、审计、负例可证伪。
- [ ] readonly/cross-scope/agent-self-approve/unsupported-capability/stale-evidence/driver-failure 等负向测试全部 fail closed，且无越权副作用。
- [ ] 研究编排支持 observe/simulate/replay/human-review/custom，不强制物理写；任何 actuate 仍经过既有治理链。
- [ ] plugin lifecycle、SDK、ontology、AML/Twin、RSI、line permission、科学探索和发布 smoke 无回归。
- [ ] 每个 PR 都有独立测试和 evidence；最终矩阵包含 core、non-line、custom driver、industrial、PVA、注塑、WWTP profile，不能只以单一案例结论代替通用性证明。
