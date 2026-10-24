# Ontology Service 规划 v2（核验定稿·执行版）—— 工业本体与语义中枢 · Ontology Compiler · 工具原生与 MCP 注入

> 状态：**已批准并执行（2026-10-24）**。O1 + O2 全部交付，O3 交付 Profile 耦合与运行时守卫（上下文注入挂钩留 O4）；
> OW7 RDF 导出与 O4 文档抽取建本体未做。验收结果见 `docs/audit/2026-10-24-ontology-acceptance.md`
> （524 单测 / 44 e2e / 14 MCP / 五门禁全绿）。偏差与遗留项见该报告 §6-7。
> v1：2026-10-24 五专家意见书合成。v2：2026-10-24 经 V1（锚点核验）/V2（工具原生链）/V3（MCP 面）三路核查 + Architect 复审 + Critic 质量门，裁决记录见 §13-14，变更账见 §16。
> 编号：决策 **ONT-\***（不续编总账本 D 系列）；工作流 **OW1–OW8**；验收 **ON\<期\>.\<n\>**；O1 启动决策集 §10.0。
> 与 `docs/plans/2026-10-23-optimizer-master-plan.md` v4.1 的关系见 §15。所有 file:line 均经 V1 逐条核验（29 条锚点：22 确认 / 5 修正 / 2 更正，承重锚点全部属实）。

---

## 0. 结论（TL;DR）

为平台新增 **Ontology Service** 一等公民层：构建/管理可版本化的**面向控制领域本体**，经 **Ontology Compiler** 编译为四类产物（`process_model` / `problem_ir` / `scene_contract` / `control_guard`）+ Rule Trace 溯源，向下服务求解器、AML、数字孪生，向上服务 Agent 工具与按需上下文，配独立 `/ontology` 管理界面与 REST API。

三条铁律（验收逐条断言，Architect 终审确认核验后仍全部成立）：

1. **本体不是第二个控制权威**。OptimizationProfile 仍是唯一运行权威；编译产物**只收紧不放宽**（`TIGHTEN_ONLY_VIOLATED`）；D13 八项一字不动（`server/services/workshop/optimization/dispatch.service.ts:118-201`）。
2. **本体不复制系统对象，只持 SemanticBinding** 锚回现有 nodeId/recipeId；不建影子表、不发明第二套节点 id。
3. **知识 ≠ 执行授权**。三级证据 × 五态生命周期分离"可读/可参考/可编译"三种能力；approved_for_control 必须走 HITL 卡。

**工具注入结论（v2 核心增量，经 V2/V3 核验）**：
- **工具原生（host 面）**：7 工具登记 = 修正后十步清单（§8.3），真正必需三处是 `host-tools.json` + `INDUSTRIAL_HANDLERS`(+index re-export) + `grant-guard WRITE_TOOLS`；`GROUP_BY_PREFIX` 为近 no-op（回退即 prefix，`tools/registry.ts:129-133`）。publish_propose 的授权判定采用**三件套**（ONT-13）堵住 lineSet 绕空。
- **MCP 面**：平台有三个 MCP 面。**桥面（`server/harness/aw-mcp-bridge.mjs`）零改动自动投影 7 工具且自带全治理链**——这是 MCP 注入的正确主形态；**外置 `mcp/aw-mcp-server.mjs` 只增 3 个只读工具**（REST 投影，同 38 工具先例）；**4 个写/状态工具绝不进外置面**（清单断言测试钉死），外部客户端发起发布走既有 `aw_agent_tool_invoke`（全链+HITL）。外置面是既存的用户身份 REST 投影域（`mcp/aw-mcp-server.mjs:3-9`），只读进入与 38 工具同权不构成新旁路；旁路风险精确闭合于写面三件套（Architect 张力 2 裁决）。

**首期价值锚点**：用户选定真实产线后，系统从已审核知识中自动生成正确绑定数据、带可追溯约束、可交现有 Solver 求解的 Profile 草案，完整复用既有验证/审批/执行链路。首次启用含一次显式开启动作（ONT-12：ontology 族对频道默认停用，频道设置勾选后生效）。

## 0.1 O1 启动前最小决策集（7 项，已全部裁决，见 §10.0）

档位排除矩阵 / grant-guard 三件套 / HIGH_RISK 归属 / SCHEMA_SQL 合并序 / O1 生命周期子集 / MCP 基线改判 / publish_log 列设计一次到位。**这 7 项直接改变 O1 实施内容，已作为 ONT-11~20 写入本计划，批准本计划即批准全部决策。**

---

## 1. 背景与定位

### 1.1 三层理解（不变）

| 层次 | 现状 | 本体补什么 |
|---|---|---|
| 语言理解 | RAG/语义卡已支持 | 不重复建设 |
| 结构理解 | 语义卡自由文本三层合并（`agents/industrial-context.ts:48-51`） | 结构化、可校验的事实 |
| 可执行理解 | 无系统承载 | 编译器+Rule Trace |

**Architect 反命题裁决（为何不用"注记替代"）**：最简替代方案（在 ProblemBounds 加 source 字段+/optimizer 表加列）被驳回——仓库已有五个各自解析归属面的机制（grant-guard 线授权 `grant-guard.ts:63-97`、tool-verify 引用面 `tool-verify.ts:318-332`、industrial-context 三层合并、HITL lineIdOf `tool-approvals.ts:204-218`、bench 场景定义），无共享语义层则每种"来源"要在五处各写一遍且必然漂移；且注记挂在 Profile 上，**起草阶段** Profile 尚不存在，绑定校验（存在性/单位/悬空）无处中立成立。吸收两点：O1/O2 只交付 problem_ir 求交+guard 骨架；O1 生命周期只落子集（ONT-17）。

### 1.2 明确不做（含 V1 措辞修正）

- 不做运行时控制权威、不绕过 D13/D14/PLC 联锁（联锁类→`explained`+`PLC_LAYER_REQUIRED`）。
- 不替代 RAG 与语义卡（P0 不动卡片渲染）。
- 高频时序数据不入本体（只进 TSDB，`daq/storage/sqlite.adapter.ts:38-50`）；Runtime Context 按请求组装不落库。
- P0 不上推理引擎/OWL reasoner/Neo4j；RDF/OWL/SHACL 仅 P1 导出镜像（单一校验真相=Zod+服务层不变量）。
- 求解面精确边界（V1 修正）：当前 QP 约束 = MV 盒/速率行 `l<=Az<=u`（`optimization/python/problems.py:109-115`）+ CV 经固定灵敏度矩阵的输出界（`:135-148`）；scipy 静态 CV 界→SLSQP 不等式（`:298-320`）。**IR 无自由 A_ub 耦合形态**（`optimization/contracts.ts:202` 仅两模板）——线性耦合/通用非线性/MILP 一律显式拒绝并给指引，绝不伪装成界。

### 1.3 文献依据（E5 WebSearch 核验为真）

| 文献 | 出处 | 用途 |
|---|---|---|
| Ontologies in Digital Twins: SLR | FGCS Vol.153 (2024) 442-456, DOI 10.1016/j.future.2023.12.013 | gap 依据："本体多止于建模/互操作，缺运行时控制闭环与治理耦合" |
| A knowledge graph framework for digital twins of chemical processes | Nature Chem Eng, 2026-05-14, DOI 10.1038/s44286-026-00392-1 | 最接近工作；论文逐条差异化（§12.2） |
| OmEGa | AEI Vol.65 (2025) 103001, DOI 10.1016/j.aei.2024.103001（DOI 注册 2024，卷期 2025） | Phase O4 文档抽取组件定位 |

创新定位（弃宽泛主张）：*面向实际工业设备的、本体驱动的控制模型配置与约束编译，结合经过验证的动态代理模型、在线优化和可追溯的 HITL 执行反馈*。

---

## 2. 本体数据模型

### 2.1 实体目录与系统映射（ONT-1）

| 实体 | 现有映射（处置） |
|---|---|
| ProductionLine | 复用 `LineView`（`shared/dcw-protocol/line.ts:19-41`），仅注记 |
| ProcessUnit | **新建**（现无中间层；`DaqNode.chamber/unitPath` 是纯标签，`daq/daq-node.ts:42-44`） |
| Equipment | 复用 DeviceTwin（`assets/device-twin.repo.ts`），仅注记 |
| Sensor | 复用 DaqNode（`daq/daq-node.ts:50-122`），绑定 nodeId |
| Actuator | 复用 DcwNode（`dcw/dcw-node.ts:54-120`），绑定 nodeId |
| ProcessVariable | 复用 `VariableMap`（`process-model/contracts.ts:89-111`，角色词表本体在 `:77` VARIABLE_ROLES）+ `SceneVariable`（`aml/twin/contracts.ts:6-17`） |
| QualityVariable | **新建**（ProcessVariable 子类标记；MES 检测向量消费面 `industrial-context.ts:273-286`） |
| ProcessModel / OptimizationTask / OperatingCondition | 复用 `aml_models`+ArtifactDescriptor（`process-model/contracts.ts:43-51`）/ `optimizer_profiles`（`schema.ts:895-916`）/ `ConditionSpec`（`contracts.ts:121-126`）+ `process_context_segments`（`schema.ts:852-867`），仅引用 |

角色显式映射：`mv→control`、`cv→target`、`md→disturbance`、`feature→feature`；state/guard/observation 沿 `aml/twin/contracts.ts:4` 七角色词表。

### 2.2 关系（封闭枚举）

`influences`（带 sign/gainPerUnit/lagMs——**仅 validated 级可填，模型单位存储，展示经 shared/units.ts**，ONT-2）/ `measures` / `actuates` / `hasPart` / `precedes`（时滞先验语料）/ `observedBy` / `constrainedBy` / `basedOn`。

### 2.3 三级证据（ONT-3）

| 级别 | 写入者 | 证据（只存引用+sourceRefHash，D5/D11 单源） |
|---|---|---|
| candidate_influence | 用户/Agent 提案（经 HITL 建卡）/模板语义结构化抽取（首批语料 `shared/daq-protocol.ts:138`） | `expert_note`/`template_semantics`/`physics_spec_monotonicity` |
| observed_correlation | 系统计算 | `dataset_stats`（dataset_id+sha256+时间窗，D18） |
| validated_control | **系统晋级不可手填** | `optimizer_run`：run_id+problem_ir_hash+artifactHash+最新 crosscheck pass（`schema.ts:1001-1021`）+outcome `improved`（`schema.ts:995`）；legacy ONNX 工件不得产生 |

编译映射：validated_control→可 hard；observed_correlation→soft/guard；candidate_influence→仅 explain/软参考，永不硬约束。

### 2.4 生命周期（ONT-4）

```
proposed ──review──► reviewed ──validate(pass)──► validated ──approve──► approved_for_control
   ▲                     │                            │                        │
   └── reject ───────────┴──► deprecated ◄── invalidate(证据漂移) ────────┘
```

- review→reviewed：editor/admin，**自审禁止**（发起人≠审查人；单管理员实例豁免打标 `solo_operator` 落审计——ONT-20 列设计）；Agent 提案经 HITL 建卡后才落 reviewed（D9）。
- →validated：系统函数（证据可解析且新鲜：dataset `lineage_verified=1`（`schema.ts:310`）/ artifactHash==`aml_models` 现值+最新 crosscheck pass）。
- →approved_for_control：**必须走 HITL 卡**（`ontology-release:` 前缀，§8.2）；REST 直批 403。
- →deprecated：系统失效（工件 hash 变、dataset 撤销传播对齐 `process-model/eligibility.ts:280-284`）或 admin。读侧谓词复用 D17：**approved_for_control 每次消费重验证据 hash**。
- **证据过期 = 降级+显式化，不是静默回滚**（ONT-18，Architect 张力 3）：ONTOLOGY_EVIDENCE_STALE 必须三处可见（solve 拒因 / HITL 卡 rationale / /ontology 总览横幅）；freshDays env 默认 30d。
- 状态转移条件 UPDATE（changes=0→409，D14 纪律）。

### 2.5 三层与版本化（ONT-5）

- `(ontologyId, version)` 不可变发布+单活跃草稿，复刻 `process_model_specs`（`schema.ts:832-848`：content_hash 唯一、published 服务层拒改）。版本号整数自增。scope：`global | line:<id> | recipe:<id>@v<n> | scene:<id>@<ver>`。
- Runtime Context 不落库。diff：发布时 canonicalJson（`aml/twin/contracts.ts:195-201`）→ changelog_json。
- swid `swid:core:<kind>:<slug>` 仅指语义类；平台实例一律 binding 锚现有 id。

### 2.6 单位（ONT-6）

换算唯一边界 `shared/units.ts`（D23），本体零换算函数、零 `?? 1` 兜底。量纲逻辑自 `aml/twin/physics-spec.ts:71-104` 上移为 `shared/dimensions.ts` 共享。**P0 必修**：`℃`(U+2103) 缺口（现仅 `°→deg`，`physics-spec.ts:92-94`；模板单位 `℃` 在 `daq-protocol.ts:137`）。

---

## 3. 核心契约（TS/Zod）

```ts
// server/services/workshop/ontology/contracts.ts
ONTOLOGY_ENTITY_KINDS = ['production_line','process_unit','equipment','sensor','actuator',
  'process_variable','quality_variable','process_model','optimization_task','operating_condition']
ONTOLOGY_RELATION_KINDS = ['influences','measures','actuates','hasPart','precedes',
  'observedBy','constrainedBy','basedOn']
ONTOLOGY_STATES = ['proposed','reviewed','validated','approved_for_control','deprecated']
EVIDENCE_LEVELS = ['candidate_influence','observed_correlation','validated_control']
OntologyTarget = 'process_model' | 'problem_ir' | 'scene_contract' | 'control_guard'
RuleDecision = 'compiled' | 'guard' | 'explained' | 'rejected'

evidenceSourceSchema = discriminatedUnion('type', [
  {type:'expert_note',author,noteId}, {type:'template_semantics',templateKey},
  {type:'physics_spec_monotonicity',modelId}, {type:'dataset_stats',datasetId,sha256},
  {type:'optimizer_run',runId,problemIrHash,modelArtifactHash}])

ontologyRelationSchema = { id,kind,srcSwid,dstSwid,sign?,gainPerUnit?,lagMs?,status,
  evidence[](min1), controlApplicability?{lineId,recipeIds[],conditionIds[]} }

semanticBindingSchema = { id,swid,platformKind:'daq_node'|'dcw_node'|'recipe_param',
  platformId,targetSub?,scope,direction:'read'|'write'|'read_write',unitDeclared,
  status:'active'|'drifted'|'retired',lastVerifiedAt }   // P1 扩 device|spec_variable|scene_variable|condition

ontologyRuleSchema = { id,ruleKey,targetSwid(s),kind:'bound'|'rate'|'linear_coupling'|'nonlinear'
  |'state_condition'|'interlock'|'informal', dsl, constraintLevel:'hard'|'soft',
  severity:'error'|'warn', status, evidence[], ownerRef?/*指向 dcw_node.min/max 等属主层,不复制数值*/, scope }

ontologyVersionSchema = { ontologyId,version:int,name,lineId/*授权锚,空=全局仅admin*/,
  parentVersion?,contentHash,compiledJson,changelogJson,status:'draft'|'published'|'retired',
  ontologyRefs?,publishedBy,createdAt }
```

四类 payload：`ProcessModelDelta`（featureCandidates/delayPriors{variabilityChecked}/monotonicity/physicsConsistency）、`ProblemIrDelta`（mvBounds{min,max,maxStep}——与 `ProblemBounds`（`optimization/contracts.ts:139-144`）同形/cvBounds/softRegularization）、`SceneContractPatch`（variables/constraints 只追加 hard_range|rate|max_delta/inferredRelations）、`ControlGuardSet`（guards[]{expr 白名单算子 `aml/twin/physics-spec.ts:2`,subject,scope,onViolate:'block_recommendation'|'annotate'}）。

---

## 4. 服务层与 DB

### 4.1 目录

```
server/services/workshop/ontology/
  index.ts  contracts.ts  entity.repo.ts  version.repo.ts  draft.repo.ts
  binding.repo.ts  evidence.repo.ts  publish.repo.ts  rule-trace.repo.ts
  ontology.service.ts  version.service.ts  semantic-binding.service.ts
  validator.ts（零DB纯函数）  compiler.ts  context.ts  publish.service.ts  rdf-export.ts(P1)
server/services/workshop/agents/industrial/ontology-tools.ts    # 7 工具 handler
server/api/workshop/ontology/…                                   # REST（§6）
tests/ontology-{schema,evidence,lifecycle,compile,guard,authz,release-hitl,injection-hygiene}.test.ts
```

### 4.2 DB：9 张新表（ONT-7 + v2 修正）

`ontology_versions`（PK(id,version)+content_hash+line_id 授权锚+status）、`ontology_entities`、`ontology_relations`、`ontology_rules`、`ontology_evidence`（append-only）、`ontology_drafts`（UNIQUE(ontology_id,owner)）、`ontology_semantic_bindings`、`ontology_publish_log`（**v2：设计期一次到位含 `actor_kind`('user'|'agent'|'system')+`solo_operator` 标记列**，ONT-20——无 migrateAddColumn 承诺下没有第二次机会）、`ontology_rule_traces`（不可变+rowHash）。

- 建表：`CREATE TABLE IF NOT EXISTS` 大字符串（`db/database/schema.ts:10`）。**v2 合并序（ONT-19，修正 v1 R8 的"git 可自动合并"错误论断）**：SCHEMA_SQL 是 1000+ 行单一模板字符串（schema.ts:10-1021，尾部为 crosschecks 表），O1 在尾部追加注释锚 `-- ===== ontology (ONT) =====` + 9 表并**先行合入 main**；总账本 M 系 SW 一律 rebase 到锚之后——尾冲突是机械拼接，可接受，顺序必须写死。
- daq/dcw 节点 JSON 落盘不在主库（`dcw/dcw-line.repo.ts:14-18`）→ 绑定目标**无 FK，service 层实时存在性+归属校验**（同 tool-verify 做法）。
- 事务体内只同步写（`db/transaction.ts:19-21`）；retention 补 evidence/publish_log/rule_traces 365d 条目；无既有表加列需求。

### 4.3 服务 API（404/409/422/403 语义）

`createDraft`(409 DRAFT_ALREADY_ACTIVE)/`updateDraft`(乐观锁 409)/`validateDraft`(恒200返issues)/`compileDraft`(422 VALIDATION_BLOCKED)/`publishPropose`/`confirmPublish`/`compareVersions`/`retireVersion`/`bindVariable`(422 TARGET_NOT_FOUND|UNIT_MISMATCH|TYPE_MISMATCH|ACCESS_MODE_CONFLICT；409 BINDING_CONFLICT|BINDING_TARGET_OWNED)/`verifyBindings`。

### 4.4 语义绑定校验

目标解析与 tool-verify 同源（`agents/industrial/tool-verify.ts:67-82`）：①存在性+产线归属；②单位可归一（无兜底）；③类型/读写性（daq 只读拒 write）；④同 target 双实体 write→409 BINDING_TARGET_OWNED；发布时 verifyBindings 复跑，悬空→drifted 阻断。

### 4.5 Agent 上下文注入

挂钩 `agents/prompt-builder.ts:94` 之后、`:100` industrialLoopGuide 之前新增 `buildOntologyContext`。输入=agentOpsScope（`agents/industrial/ops-tools.ts:42-71`）∩ versions.line_id；输出=绑定面实体 1 跳子图；无绑定零注入。预算 foldList ≤4k chars。缓存 key=(agentId,version,bindingsMaxUpdatedAt) TTL 30s；失效=`broadcastSceneEvent`（`scene-events.ts:66-80`）。

---

## 5. Ontology Compiler（ONT-8）

### 5.1 管线（不变）

S0 zod 校验(422 ONTOLOGY_INVALID) → S1 RuleIR 规范化 → S2 三面绑定解析(UNKNOWN_VARIABLE/UNIT_MISMATCH) → S3 形态分派(compiled|guard|explained|rejected) → S4 只收紧求交(放宽→TIGHTEN_ONLY_VIOLATED) → S5 冻结 RuleTrace+artifactHash。status: success|warning|rejected；**fail-closed：任何规则必留 trace，禁止静默丢弃**。

### 5.2 规则→编译形态映射（含 v1→v2 措辞修正）

| 规则形态 | 产物 | 现行载体 | 编译语义 | 拒绝路径 |
|---|---|---|---|---|
| 上下限 | problem_ir/scene_contract | `ProblemBounds.min/max`（contracts.ts:139-144）；MV 界源 `spec.effectiveDomain`（`problem-builder.ts:45-49`）；SceneContract hard_range | 求交只收紧；超域→DOMAIN_CONFLICT | 证据<validated→降级 |
| 变化率 | problem_ir | `maxStep`（:143）+下发步限复检（dispatch.service.ts:159-169）+writePolicy.maxDeltaPerAction | 收紧 maxStep（模型单位） | 无 |
| 线性耦合 | **不可编译** | IR 无自由 A_ub（contracts.ts:202）；QP 仅 MV 盒/速率行+CV 固定灵敏度输出界（problems.py:109-148） | rejected `REJECTED_UNSUPPORTED_FORM`+可产 guard 候选；指引"需 IR v2+OSQP A 矩阵，超 v4.1 范围" | 显式 code |
| 非线性 | control_guard | 通用表达式仅 PhysicsSpec 白名单算子（physics-spec.ts:2,306-325） | →guard 标 'nonlinear' | 要求进 QP→rejected |
| 状态条件 | control_guard | 最近似=SceneContract guards 角色+PhysicsSpec.guards+trial constraintResults（trial-service.ts:112） | →guard；constraintReport kind 增 `'guard'`（**运行时产物不在 IR 输入结构（contracts.ts:174-202），不破 IR hash——V1 确认**） | 变量不可观测→OBSERVABLE_UNRESOLVED |
| 安全联锁 | 不编译→归 PLC | controlNodeId+dispatch ④（dispatch.service.ts:143-147） | explained+`PLC_LAYER_REQUIRED` | 绝不产 QP/旁路 |
| 不可形式化 | 不编译 | — | explained：trace.message 进卡 rationale（:375-381） | 无 |

**kind 'guard' 同步面（DoD 断言项）**：constraintReport.kind 消费面 grep 清单——前端按 kind 渲染的映射、tests 中 kind 枚举断言——逐处列入 O3 改动清单。

### 5.3 Rule Trace（不变）

`ontology_rule_traces` 不可变追加：id/ontologyId/version/rulePackHash/ruleId/ruleRevision/sourceRef/ruleKind/evidenceLevel/constraintLevel/decision/decisionCode/message/bindings/artifacts/scope/rowHash。前端展示链：optimizer_runs→rec→Profile.ontologyRefs→rule_traces。

### 5.4 hash 域决策（ONT-9，V1 判定 GO·风险最低）

ontologyRefs 进 `profileContentHash`（`profile.repo.ts:43-46`，stable 集合含它，旧行字节不变）、**不进** `computeProblemIrHash`（`contracts.ts:209-216`）；dispatch 增独立校验 `assertOntologyUnchanged`（复用 D12 工件 hash 独立比对先例 `dispatch.service.ts:97-102`）→409 `ONTOLOGY_PACK_DRIFTED`。存量兼容：缺省=无本体约束域（跳过校验，非放行）；回归测试锁定"旧 Profile canonicalJson 字节不变"。

### 5.5 失败语义（统一拒绝码，每码≥1 单测负例+拒绝零写）

`ONTOLOGY_EVIDENCE_INSUFFICIENT` / `ONTOLOGY_UNKNOWN_ENTITY` / `ONTOLOGY_UNIT_MISMATCH` / `ONTOLOGY_RULE_CONFLICT`（列双方 ruleId，禁后写赢）/ `ONTOLOGY_EVIDENCE_STALE`（三处可见，ONT-18）/ `ONTOLOGY_SCOPE_MISMATCH` / `TIGHTEN_ONLY_VIOLATED` / `REJECTED_UNSUPPORTED_FORM` / `PLC_LAYER_REQUIRED` / `ONTOLOGY_INVALID`。

---

## 6. REST API（envelope `{code,message,data}`，`server/utils/response.ts:5-9`）

`server/api/workshop/ontology/` 方法分文件（同目录不混用两种路由风格）：

| 端点 | 要点 | 权限 |
|---|---|---|
| GET `index.get.ts` | overview+版本横幅 | resolveUser |
| POST `index.post.ts` | 建草稿 | requireRole(['admin','editor']) |
| `entities/` `relations/` `rules/` CRUD | published 改动→409 ONTOLOGY_IMMUTABLE；`rules/[id]/transition.post.ts`（非法转移 409；缺证据 422；approved_for_control 仅 admin 且必须经卡）；`rules/validate.post.ts`；`rules/[id]/evidence.post.ts` | 写 editor/admin |
| `bindings/` CRUD+`verify.post.ts` | 单位预检走 shared/units（422 UNIT_CONTRACT_INVALID）；写面 requireLineMode(operate) | 同上 |
| `drafts/[draftId]/` get/patch/delete/validate/compile/publish | patch 乐观锁；compile 同步返回四产物草案+traces+warnings；**publish 仅 admin** | GET 登录用户 |
| `versions/`+`versions/compare.get.ts` | 版本史+四段 diff | resolveUser |
| `evidence/` `rule-traces/` `export.get.ts` | 溯源查询+导出 | resolveUser |

审计：成功变更 `recordConfigAction`（`optimization/access.ts:186-210`）；授权拒绝恰 1 条 `tool.call.denied`（`access.ts:47-64` 口径）。

---

## 7. 管理界面 `/ontology`

6 tab（总览/实体与关系/约束规则/语义绑定/版本与发布/编译预览），aml 模块化样板（`app/pages/aml/index.vue:1-10`），侧边栏 /optimizer 后（不加 adminOnly），icon `i-tabler-sitemap`。图可视化=ECharts graph（echarts^5.6 已有；AwChart 增补 `GraphChart` 注册；边按三级证据着色对齐 EDITORIAL_PALETTE `AwChart.vue:42-43`；只浏览+drawer，编辑走表单；不上三维/图数据库大屏）。O1 交付表格先行四 tab（总览/实体与关系/语义绑定/版本），规则/编译预览 tab 随 O2。

- WS（REST 为事实源）：`ontology.draft.changed`/`ontology.bindings.changed`/`ontology.published`；AEP_GROUPS 增 `ontology` 组（`shared/workshop-protocol.ts:455-470`）；`useOntologyStream` 仿 useOpsLog；轮询 useVisibleInterval。
- i18n：`menu.ontology`+`ontology.*` 键族，zh/en parity 硬门禁（`scripts/_i18n-verify-keys.mjs`）；键字面量传入。
- 前端陷阱（V1 复核仍成立）：EChartsOption shallowRef（`app/pages/studio/board.vue:257`）；AwChart 须 ClientOnly（`AwChart.vue:20-21`），lazyUpdate 可见性收敛已内置（`:76-92`）；a-table 显式 columns（`app/pages/workshop/schedules.vue:53-55`）；rc-select e2e 完整鼠标序列（`scripts/_e2e-ui-functional.mjs:154-162`）；写操作 30s 超时→compile 同步快返回。

---

## 8. 工具原生注入（host 面，v2 按真实链路重写）

### 8.1 真实闸门顺序（V2 实测）

```
host-tools.json（loader.ts:191-221 fail-fast：缺文件/非空数组/逐条 name+description+parameters）
 → catalog.ts:18 HOST_TOOLS 模块常量加载（改 json 须重启进程）+ :21 声明注册
 → registry.ts:153-236 快照投影 tool_registry（写族未声明 references 拒登记 :157-166+审计；
    未声明读族告警 :168-177；definition_hash :139-150）
 → 注入面 scopeHostToolsForRole（catalog.ts:165-274：LEAD_ONLY 剥离→档位 narrow→writesBlocked）
 → hostToolsForAgent（per-agent.ts:96-137）→ applyChannelToolPolicy（policy.ts:85-90）
 → 出口：omp set_host_tools / MCP 桥 tools/list（≤10s ETag→list_changed） / pi per_turn
执行面 dispatch.ts:113-372：①invocationScope ②channelToolGate ③插件 ④legacyMpcAlias
 ⑤族门+optimizerDispatchGate ⑥硬编码直写 fail-closed ⑦INDUSTRIAL_TOOL_NAMES 分流→
 grant-guard(:256)→tool-verify(:260)→handler ⑧workspace 门 ⑨16k 截断(:98-111)
```

### 8.2 七工具定义（riskClass 与引用面）

| 工具 | riskClass | 引用面声明 | 说明 |
|---|---|---|---|
| ontology_scene_inspect | read | refs:[line_id→line]+readableLineNodes | 只读分页子图（16k 截断纪律） |
| ontology_draft_create | write | noRefs:true | 409 并发草稿；**schema 强制 line_id**（ONT-13 之二） |
| ontology_draft_validate | read | chained:[ontology_draft] | 归属=创建者 |
| ontology_rule_explain | read | chained:[ontology_version]（或关键词 noRefs 分支） | DSL 自然语言解释 |
| ontology_compile_preview | read | chained:[ontology_draft] | 返回 contentHash+payload 全量；不落版本 |
| ontology_publish_propose | write | chained:[ontology_draft]+refs:[line_id→line]；**进 grant-guard WRITE_TOOLS（`grant-guard.ts:23-35`）** | Agent 发起→HITL 卡；不写设备；**不入 HIGH_RISK_TOOL_NAMES**（ONT-16：物理零写，operate+HITL 承担高危语义，避免牵动 `tests/high-risk-tool-scope.test.ts:10-31` 钉死面；conscious-change DoD 声明） |
| ontology_version_compare | read | chained:[ontology_version]×2 | 版本 diff |

tool-verify 扩展 **4 个同步点**（V2 修正，v1 只写 2 处）：`agents/tool-reference-spec.ts:20` 枚举 + `tool-verify.ts:171` 本地 ChainKind 声明（**改 import 消重**）+ `:192-217` chainLineOf 两分支（ontology_draft→owner_user_id；ontology_version→line_id∈readableLines）+ `:375` 拒绝文案 label map。
盲区精确化（v1 修正）：未声明读族的放行点在 `tool-verify.ts:229-251(resolveSpec)→:291-292(verifyToolReferences null 放行)`，带 60s 节流 `tool.call.undeclared` 告警（`:236-249`）；**注册期拦截**在 `registry.ts:157-166`（写族拒登记+审计）。**ONT-14（legacy 回滚 fail-closed）**：`AW_TOOL_VERIFY_LEGACY_SPECS=1` 时 ontology 族工具一律拒绝（无旧代码表→不得 null 放行；`tool-verify-legacy-specs.ts:6` 声称的启动 warn 实未实现，顺带补上）——铁律三的直接漏洞，Architect 强化采纳。

### 8.3 修正后登记清单（十步有序，每步触发测试）

1. `agents/industrial/ontology-tools.ts` 建 7 handler；`agents/industrial/index.ts` 增 re-export。（无测试，纯实现）
2. `.AgentWorkShop/prompts/host-tools.json` 增 7 条（含 riskClass+references/noRefs 全声明）→ 触发 `tests/host-tools-quality.test.ts:30-42`（唯一名/描述≥40/object 参数）与 `tests/tool-references.test.ts:53-63`（全声明+mode；`>=92` floor 与 missing 钉死清单 :49）。**包外 home 副本由 seedHomePrompts 漂移即覆盖自动同步（`loader.ts:76-85`），零手工**（v1"三份手工副本"修正）。
3. `tool-reference-spec.ts:20` 增两枚举值+`tool-verify.ts` 三点同步 → `tests/tool-verify.test.ts` 新增链式归属用例（仿 :51 起模式）。
4. `agents/host-tool-bridge/tools/industrial.ts:23-97` INDUSTRIAL_HANDLERS 增 7 行（INDUSTRIAL_TOOL_NAMES :100 自动并入）→ 建议仿 `scripts/acceptance-optimizer-process-model.ts:723-728` A21 口径增 ontology 面断言。遗漏注册的失败表现=dispatch 分流不命中→grant-guard/tool-verify 全跳过→死标签 switch（`:329-362`）/未知工具（`:364`）。
5. `grant-guard.ts:23-35` WRITE_TOOLS 增 publish_propose + `:51-114` resolveTargetLines 增 draft_id→line 回溯 → 新增 grant-guard 负例（拒绝恰 1 条 denied，仿 `:117-134` 口径）。
6. **档位排除矩阵（ONT-11）**：legacy/aml_training/observer 档位一律不注入 ontology 族（含读工具——legacy 连优化器族都摘，`catalog.ts:227-241` 四族 narrow 不含 ontology 则默认注入，**必须显式加排除**）；hybrid_twin/aml_optimization 档位仅注入 5 个读工具；全量档位 7 工具。写工具经 writesBlocked 双保险（`catalog.ts:247-252` 增 ontology 写族）。
7. **默认停用（ONT-12）**：ontology 族进 channel_tool_settings 的 default-disabled 集（利用 `policy.ts:80-82` `!== false` 语义在同处实现）——selected 模式存量 Channel 与新 Channel 均显式开启后可见，避免"静默出现在所有频道"。
8. `registry.ts:94-127` GROUP_BY_PREFIX 增 `'ontology'`（可选显式化，近 no-op）。
9. HITL 三类型点：`shared/workshop-protocol.ts:149` AepHitlKind + `tool-approvals.ts:22` kind union + `approval_history.kind`（`schema.ts:218`）+ 前端 kind 渲染分支 + dispatcher/decide 双入口分支 → `tests/tool-approvals-choice.test.ts` 回归（fail-closed 归一 `:433-457` 零改动）。
10. 重启进程 → boot sync 入 tool_registry（`registry.ts:290-299`）→ Channel 显式开启 → 桥面 ≤10s 自动 list_changed（omp 存量会话须重开）。

### 8.4 发布治理流（角色矩阵 × HITL 卡，v2 补全类型点）

| 动作 | 允许 | 机制 | 阶段 |
|---|---|---|---|
| 建草稿/证据登记/规则 proposed | Agent（限绑定产线 scope）+editor | 工具面+REST | **O1** |
| 审查 proposed→reviewed | editor/admin 非发起人（solo_operator 豁免打标） | REST transition | **O1**（ONT-17 子集） |
| →validated | 系统晋级 | 服务函数 | **O2** |
| →approved_for_control | 线域 operate 及以上人类，**必须 HITL 卡**；REST 直批 403 | kind 增 `'ontology'`，nodeId `ontology-release:<ontologyId>@<version>`（避开 lineIdOf 配方正则 `tool-approvals.ts:207` 与频控锚 `:239`）；request opts 显式带 lineId | **O2** |
| 发布不可变版本 | editor 提议/admin 冻结（REST publish 仅 admin） | 谱系门+freeze（仿 `optimization/profiles/[id]/publish.post.ts:17-31`） | **O2** |
| 废弃 | editor/admin 或系统失效 | 不回滚历史 release | **O2** |

双入口单咽喉：`agents/hitl-decision/dispatcher.ts:80-92` 与 `server/api/workshop/agent-tools/approvals/[id]/decide.post.ts:66-95` 并列 `isOntologyReleaseCard` → `ontologyReleaseService.decide()`。载荷复用 schemaVersion=1+packages 归一链（`:433-457`）。
生效时机（ONT-10）：收紧层批准后立即生效；结构产物随下一次 Profile 冻结；放宽永远需新 Profile 版本。
归因：recordOps 事件族 `ontology.*`，含 actor 三态/initiatorUserId（Agent 发起落 channel 属主，供撤权收敛类比 `dispatch.service.ts:394`）；行级 row_hash。

### 8.5 安全（注入/scope/导入，不变+Architect 强化）

candidate 级文本永不进 prompt、冻结文本渲染、消毒、发布期 lint 指令式模式阻断；scope 三分类（draft=owner/line-scoped/release=全局只读）；批量导入只进 candidate 暂存区+上限+dry-run+事务 all-or-nothing。

---

## 9. MCP 注入（v2 新增工作流 OW8，V3 核验定稿）

### 9.1 三面现状（全部实测）

| 面 | 文件 | transport | 工具来源 | 身份 |
|---|---|---|---|---|
| 外置 | `mcp/aw-mcp-server.mjs`（799 行零依赖） | stdio JSON-RPC（`runStdio` :769-792） | **静态 buildToolDefs 38 个**（注释/文档写 35，计数漂移，v2 顺带修正 :201 与 `cli/commands/mcp.mjs:30`） | 平台用户（AW_TOKEN/账密懒登录 :73-100），**无 channel 上下文** |
| 内置 | `server/mcp/workshop-server.ts` | Streamable HTTP `/api/mcp/workshop` | 静态 registerTool 23 个 | channel_agents.token |
| 桥 | `server/harness/aw-mcp-bridge.mjs` | stdio（各 harness 拉起） | **动态投影 host 工具**（10s 轮询 agent-tools/list ETag→list_changed :76-89） | agent token 自证（:29-32） |

端口自动发现 `mcp/discovery.mjs:107-177`（env>锁文件>PORT>config>3000/3001）；集成开关 `readMcpEnabled`（:213-227，损坏 fail-closed false）；停用时仅放行 `aw_status`（`aw-mcp-server.mjs:727-730`）。历史两雷已防：junction realpathSync（:794-796）、aw mcp stdio 挂起（`cli/commands/mcp.mjs:153-158`）。

**旁路判定（精确版，Architect 张力 2 裁决）**：外置面调用=REST 直达（`aw_dcw_write`→REST write），治理=REST 侧角色闸+物理限界+manual 审计；不经 dispatchHostTool⇒channelToolGate/tool-verify/grant-guard/HITL 不生效（channelToolGate 对空 channelId 放行 `tools/policy.ts:110`）。这是**有意的"用户身份 REST 投影域"**，与 38 工具同权同险——只读进入不构成新旁路；**旁路风险精确闭合于写面**。

### 9.2 分层设计（ONT-21，采纳 V3+Architect）

1. **桥面 = MCP 注入主形态，零改动**：7 工具完成 §8.3 host 登记后，桥面 tools/list 自动含 7 工具，外部 harness（codex 等）频道 Agent 经桥调用自动过全治理链（含 publish_propose 的 HITL 180s 阻塞——桥超时 200s 已兼容，`aw-mcp-bridge.mjs:26`）。**"桥面零改动"本身是验收断言**。
2. **外置 aw mcp 只增 3 个只读工具**：`ontology_scene_inspect / ontology_rule_explain / ontology_version_compare`，REST 代理实现（复用 resolveUser+角色闸，**不新增旁路 token**），Phase 落地=scene_inspect 随 O1，另两个随 O2。描述注明"只读；写路径请经频道 Agent 治理链或 aw_agent_tool_invoke"。
3. **4 个写/状态工具绝不进外置面**（draft_create/validate/compile_preview/publish_propose）：清单断言测试钉死；外部客户端发起发布走既有 `aw_agent_tool_invoke`（`aw-mcp-server.mjs:554-566`→invoke.post.ts 属主校验 :47-63→全治理链+HITL 卡）。
4. 不改：`server/harness/aw-mcp-bridge.mjs`、`server/mcp/workshop-server.ts`、HIGH_RISK_TOOL_NAMES。

文件改动：`mcp/aw-mcp-server.mjs:208-689` buildToolDefs 增 3 只读工具+修 :201 计数注释；`cli/commands/mcp.mjs:30` 文档计数；`tests/aw-mcp-server.test.ts`（mock 上游 :16-67）增工具存在/无写工具断言；`scripts/_audit/aw-mcp-live-e2e.mjs` S3 关键清单（:154）+S5 后增 ontology 组。

### 9.3 MCP 验收标准（V1-V5，可测）

- **V1 清单**：live e2e `tools/list` 含 3 只读工具，且 `ontology_publish_propose/ontology_draft_create` 不在清单（防写面外泄）。
- **V2 审计口径**：外置面调 scene_inspect 落 REST 审计口径（与 host 面 `tool.call.*` 不同是设计事实，断言不得写成同口径）；**同口径断言只放桥面/invoke 路径**：经 invoke 调 publish_propose → publish_log propose 行 + pending 卡（nodeId `ontology-release:`）+ auditCollabInvocation（`host-tools.ts:116-119`）。
- **V3 HITL 触达**：MCP→aw_agent_tool_invoke(ontology_publish_propose) 建卡双面可见；批准后 200s 内外部客户端收到非 isError 结果；REST 直批该卡 403。
- **V4 未授权拒绝**：无 token→AuthRequiredError（`aw-mcp-server.mjs:96`）；只读工具对 readonly 用户 403；`mcp.enabled=false` 全部工具（除 aw_status）回 MCP_DISABLED_TEXT。
- **V5 桥面零改动投影**：频道 Agent 桥 tools/list 自动含 7 工具；channelToolGate 停用后执行被拒。

---

## 10. 实施路线（四期，执行就绪）

### 10.0 O1 启动前决策集（7 项，全部已裁决=ONT-11~20，批准计划即批准）

| # | 决策 | 裁决值 |
|---|---|---|
| 1 | 档位排除矩阵 | ONT-11：legacy/aml_training/observer 不注入；hybrid/aml_optimization 仅 5 读工具；全量 7 工具 |
| 2 | grant-guard 修法 | ONT-13 三件套：WRITE_TOOLS（挡空 lineSet）+schema 强制 line_id（挡无锚调用）+tool-verify chained 归属（挡跨线草稿）——缺一不可 |
| 3 | HIGH_RISK 归属 | ONT-16：publish_propose 不入 HIGH_RISK（operate+HITL 承担；conscious-change DoD 声明） |
| 4 | SCHEMA_SQL 合并序 | ONT-19：O1 尾部锚先行合 main，M 系 rebase 其后（v1 R8"自动合并"论断删除） |
| 5 | O1 生命周期子集 | ONT-17：O1 仅 proposed/reviewed+candidate/observed 证据；validated/approved_for_control/validated_control 归 O2/O3 |
| 6 | MCP 基线 | test:mcp-live 34/34 → 新基线=34+新增断言数（断言定稿时写入 DoD，预期 40±4） |
| 7 | publish_log 列设计 | ONT-20：actor_kind+solo_operator 设计期一次到位 |

**env 清单（ONT-22，全部 env-only，不动 settings 键与 docs:check 计数）**：
| 变量 | 语义 | 读取位置/默认 |
|---|---|---|
| `AW_ONTOLOGY_V1` | 本体面总开关：`0`=REST 返回 409 `ONTOLOGY_DISABLED`、7 工具 dispatch 拒绝、上下文注入返回空、外置面 tools/list 不含 3 只读工具（独立于 `mcp.enabled`） | `server/services/workshop/ontology/index.ts` 启动时读取；缺省=启用 |
| `AW_ONTOLOGY_EVIDENCE_FRESH_DAYS` | 证据新鲜度阈值（ONT-18） | 编译/读侧谓词；默认 30 |
| `AW_TOOL_VERIFY_LEGACY_SPECS` | 既有回滚开关；与 ONT-14 交互=legacy 模式下 ontology 族工具**一律拒绝**（fail-closed） | tool-verify 回滚路径 |

### Phase O1 — 最小核心+绑定（OW1/OW2/OW3+OW8 前半；可与总账本 M1-M3 并行）

**有序步骤（每步=可独立 commit+测试）**：
1. `shared/dimensions.ts` 上移+`℃` 修复（+单测）。
2. schema.ts 尾部锚+9 表 → `tests/ontology-schema.test.ts`（TABLES 钉表仿 `tests/optimizer-schema.test.ts:24-33`）。
3. contracts.ts(Zod)+validator.ts 纯核 → 单测。
4. repos+ontology.service(draft/version) → 单测（AW_MODE=home+mkdtemp，绕 Nitro 门面）。
5. semantic-binding.service+drift → 单测（422/409 全码负例）。
6. REST：drafts/entities/relations/bindings/versions/export（规则面只开放 proposed/reviewed 子集）。
7. /ontology 页骨架四 tab（表格先行；graph 面后置 O2）。
8. `ontology_scene_inspect` 工具（§8.3 步骤 1-8 的只读子集）+ 外置 MCP 增 scene_inspect（§9.2）。
9. 模板语义→candidate_influence 抽取器（`daq-protocol.ts:138` 首批语料）。
10. e2e 增量+五门禁+evidence JSON。

**验收门 ON1（可测）**：`npm run test:unit` ≥444+新增（schema/evidence 子集/authz 子集）；`npm run test:mcp` 含 scene_inspect 断言；五门禁 0；从真实 Scene 经 scene_inspect 返回带来源语义上下文；单位冲突/重复绑定/悬空绑定各有 ≥1 负例断言；`ontology_scene_inspect` 在 host+桥面可调、外置面可调且只读。

### Phase O2 — Compiler+发布治理（OW4+OW6+OW8 后半）

步骤：compiler 纯核（四 target+RuleTrace+只收紧求交）→ compile preview REST/工具 → 生命周期全量（validated 系统晋级+approved_for_control HITL 卡+双入口单咽喉+publish_log）→ 7 工具全量（§8.3 全十步）→ 档位矩阵/default-off/legacy fail-closed 落地 → /ontology 规则/发布/编译预览 tab+WS+i18n → 外置 MCP 增 rule_explain/version_compare → e2e-ontology.mjs 12 组断言（§11.2）。

**验收门 ON2（可测）**：单测 ontology-compile(18)/guard(20)/lifecycle(16)/release-hitl(14)/injection-hygiene(12) 全绿；`node scripts/e2e-ontology.mjs` 12 组全过（含 REST 直批 403+恰 1 条 denied、双入口并发恰一成功、收紧立即生效、注入 lint 阻断）；**基线不破：104/104、67/67、G0 工具面 10 文件 80/80（62 组与 69 组的去重并集，实测；分跑口径 62/62 与 69/69；含 aw-mcp-server 与 high-risk-tool-scope——正是本计划触碰面；命令须带 `--test-force-exit`；出口实测复核入 DoD）、test:mcp-live 新基线**；写工具外泄断言（外置面 tools/list 不含 4 写工具）通过。

### Phase O3 — Profile 耦合+AML/孪生（OW5+OW7）

步骤：Profile.ontologyRefs+profileContentHash 扩展+assertOntologyUnchanged → guard 运行时三落点（manager.solve 可行性/assertRecommendationUsable 只增拒/createDispatchCard precheck）→ constraintReport kind 'guard'+消费面 grep 清单执行 → AML 接线（featureCandidates→dataset featureNodes 通道 `dataset-builder.ts:34,510`；delayPriors→spec 建议+PhysicsDelaySpec 先验盒，variabilityChecked 未过只 soft；monotonicity 进 gates 附加检查）→ SceneContractPatch→scene-builder 草稿（永不自动冻结，`scene-lifecycle.ts:18-43` 门槛不动）→ RDF/Turtle+SHACL 导出。

**验收门 ON3（可测）**：旧 Profile canonicalJson 字节不变回归通过；本体产物零放宽断言通过；assertOntologyUnchanged 漂移→409 ONTOLOGY_PACK_DRIFTED 断言通过；一个真实场景"知识先验→训练→求解→孪生验证"全链跑通；**对照判据绑定 §12.1 A 组指标（attained/writes/rounds/wallS/RMSE+约束违背计数+绑定错误率金标），方向=约束违背 0、绑定错误率下降、attained 不劣于 A 组；具体阈值于 O3 出口前以 A 组基线定标后钉入 DoD（定稿时记录约定，同 MCP 新基线）**；单测 ≥444+122 全绿；**O3 出口前钉死 O4 消融金标集（应拒/应过用例+绑定金标表+消毒样例）**。

### Phase O4 — Agent 自建+消融

kb_agent 检索→LLM 抽取→candidate 暂存（含消毒+批量导入安全面）→审批流完善；消融 A-E 全跑通（§12.1）；论文材料。

**验收门 ON4（可测）**：Agent 完成草稿构建/引用证据/发现冲突/提交审核；未审批规则不改变求解与 DCW 行为（负例断言）；消融报告落 bench/results；注入拦截率金标集通过。

---

## 11. 测试与验收总表

### 11.1 单测（8 套件 ≈122，O1/O2 按子集切分）

schema(12)/evidence(14)/lifecycle(16，O1 仅子集)/compile(18)/guard(20)/authz(16)/release-hitl(14)/injection-hygiene(12，**含"未声明读族放行"负例与 legacy 回滚 fail-closed 断言**——闭合 §14 风险⑥)。约定：node:test 绕 Nitro 门面（`tests/tool-verify.test.ts:12-14` 明示全路径由 tmp-e2e 覆盖）；TABLES 钉表同步扩展 `tests/optimizer-schema.test.ts`。

### 11.2 e2e：`scripts/e2e-ontology.mjs`（fresh tmp home+AW_MODE=home+check(ON<x>.<n>)+report.json）

12 组：①无证据 validated→422 ②自审禁止 403 ③REST 直批 403+恰 1 denied ④Agent 发起卡双面可见 ⑤批准卡→approved+归因 ⑥双入口并发恰一成功 ⑦冻结同版本改内容 409 ⑧收紧立即生效且求解 optimal（或明确拒因）⑨单位失配 422 零写（对比 DCW 写计数）⑩注入负例 lint 阻断+prompt 不含 candidate 文本 ⑪撤权收敛在飞卡 ⑫重启对账禁自动重放。

### 11.3 回归护栏（V2 修正口径）

| 基线 | 载体 | 当前口径 |
|---|---|---|
| 实机全旅程 | scripts/e2e-optimizer-live.mjs | 104/104（`docs/audit/2026-10-24-release-acceptance-v0.7.71.md:18`） |
| 过程模型验收 | scripts/acceptance-optimizer-process-model.ts | 67/67（同文件 :15） |
| 全量单测 | npm run test:unit | ≥444（`docs/audit/2026-10-24-tool-surface-implementation.md:15`，v2 修正 :84→:15） |
| G0 工具面 | **10 文件 80/80**（62 组与 69 组去重并集，实测；命令须带 `--test-force-exit`；O2 出口实测复核入 DoD） | 62 组=host-tools-quality/tool-references/tool-registry-policy/tool-profile-observer/tool-verify/tool-face-authz/tool-approvals-choice/tool-surface-budget；69 组=tool-surface-metadata-design 八文件（含 aw-mcp-server+high-risk-tool-scope） |
| MCP offline | npm run test:mcp | 现值+N |
| MCP live | npm run test:mcp-live | 34/34 → 新基线（§10.0 决策 6） |
| 五门禁 | scripts/run-quality-gates.mjs | 全 0；**不新增 settings 键**（env-only `AW_ONTOLOGY_V1`，docs:check 计数 126/19/42/84 不动） |
| 钉死清单 | HIGH_RISK_TOOL_NAMES/VERIFY_SPECS→声明面/TABLES/工具 references floor | 变更=conscious-change+DoD 声明 |

---

## 12. 消融与论文

### 12.1 A–E 对照（载体：bench/lib/scenarios.mjs 现 4 场景 injection/wwtp/anneal/biax——v1"三场景"修正；bench/optloop.mjs LLM 闭环；固定 seed+fixture）

A 基线（现成指标 attained/writes/rounds/wallS/cost/throughput/RMSE）→ B +RAG 解释 → C +语义绑定（绑定错误率金标/配置分步计时，需埋点）→ D +规则编译+Twin Gate（约束违背零违反/拒绝准确率金标）→ E 完整+Agent 协同（发布吞吐/注入拦截率/审批时延 approval_history 现成）。统计口径 `bench/lib/metrics.mjs:3,13-14` nearest-rank p50/p95。**泄漏控制**：本体起草文档用留出场景。

### 12.2 论文主张（对 NCE2026 逐条差异化）

ontology-as-compiled-constraints（vs integration-layer）/ 治理闭环（三级证据+control 级 HITL+不可变 release+fail-closed 拒绝码族+审计直至 DCW 写回读）/ 可量化验收（确定性 bench+逐断言 e2e+A-E 消融）。写作纪律：显式引用 NCE2026；FGCS2024 支撑 gap；AEI2025 定位抽取组件。预期诚实结论：本体未必让 OSQP 更快，但减少配置错误/提升约束适用性/降低错绑风险/改善冷启动——由消融数据说话。

---

## 13. ADR（共识定稿必含）

- **Decision**：独立 Ontology Service（控制导向领域本体，三级证据×五态生命周期，SemanticBinding 锚定现有对象）+ 确定性 Ontology Compiler（四 target，只收紧，hash 域分离）+ 分层工具注入（host 原生全治理=主形态；桥面零改动投影=外部 Agent 正道；外置 MCP 仅 3 只读投影；写面绝不外置）+ 四期交付（O1 生命周期子集减税）。
- **Drivers**：①仓库 5 处归属解析面各自为政、必然漂移（反命题被驳回的实证）；②起草阶段 Profile 不存在，绑定校验需中立载体；③论文治理闭环主张；④hash 域分离是风险最低的 Profile 耦合方式（V1 判 GO）。
- **Alternatives considered**：注记替代（驳回，理由 §1.1）；RDF/Neo4j 优先（驳回，P1 导出镜像即可）；MCP 静态全暴露（驳回，写面旁路）；MCP 完全不暴露（驳回，丢外部工作台只读价值）；砍写工具只留读面（驳回，OW6 是论文治理载体，改为"单一治理注册表+参数化钉死测试"降维护）。
- **Why chosen**：五消费面共享语义消除漂移；起草中立性；bridge 零改动投影被 V3 实证为零成本全治理路径；9 处 v1 锚点错误全部为次要转抄、承重裁决全数存活（V1 总判定 GO-WITH-FIXES→v2 已修）。
- **Consequences**：维护面收敛为"1 处声明+1 个参数化钉死测试"（张力 1 消解）；SCHEMA_SQL 尾部追加与 M 系产生机械 rebase 成本（ONT-19）；外置 MCP 审计与频道审计双口径并存（V2 验收已区分）；证据 stale=降级显式化而非静默回滚（ONT-18）。
- **Follow-ups**：IR v2 自由 A_ub/非线性 QP（超 v4.1 范围，编译器已留拒绝指引）；per-condition 规则（对齐 D21，v1 先全域）；独立审查员角色；rule 冲突优先级偏序；RDF reasoner；观察面白名单放行。

## 14. 风险与开放问题

风险：① freshDays 过紧致规则频繁失效（默认 30d+失效频率监控）；② LLM 抽取幻觉（candidate 隔离+人审；审查员负担=催办+批量审查 UI）；③ 基线破坏面（每期 DoD 列触碰的钉死清单；SCHEMA_SQL 尾冲突按 ONT-19 顺序化）；④ 消融泄漏（留出场景）；⑤ channelToolGate fail-open vs tool-verify fail-closed 方向差（工具面计划 F6 已记录；本体工具落 fail-closed 侧；ONT-12 default-off+ONT-14 回滚 fail-closed 双保险）；⑥ 未声明读族放行（精确化后以声明面登记+节流告警+e2e 断言闭合）。
开放问题：① 规则冲突 v1 一律 409，偏序留后；② per-condition v1 先全域；③ solo_operator 豁免落地效果观察；④ 存量 Profile 无 ontologyRefs=无本体约束域，不批量回填；⑤ E 组人工审批自动化 bench 替代（脚本代答+单独人工轮报告）；⑥ retention CASCADE 测试（OW1 内定死）。

## 15. 与总账本关系

编号独立（ONT-\*/OW1-OW8/ON\<期\>.\<n\>）。文件交集与顺序约定：`db/database/schema.ts`（O1 先行尾部锚，M 系 rebase 其后——ONT-19）；`host-tools.json`（seedHomePrompts 自动同步 home 副本，O2 与 SW1.3/SW7.1 排先后）；`hitl-decision/dispatcher.ts`（O2，与 SW5.4 同文件排 SW5 后 rebase）；`prompt-builder.ts`/`industrial-context.ts`（O2/O3，总账本未触碰，安全并行）。依赖：O1 无依赖；O2←O1；O3←O2+M4+M5b；O4←O3。每期 DoD 沿 D30 风格（可 revert commit+单测数+e2e 脚本+五门禁 0+evidence JSON+迁移/回滚注记+独立评审）。

## 16. 变更账（v1→v2）

1. 全文锚点按 V1 核验修正 9 处（tool-verify 盲区定位/grant-guard :23-35/444 口径 :15/OSQP 约束形态精确化/broadcastSceneEvent :66-80/bench 4 场景/seedHomePrompts 自动同步/dcw-line.repo :14-18+VARIABLE_ROLES :77/HITL kind 同步面补全）。
2. 新增 ONT-11~21：档位排除矩阵/默认停用/grant-guard 三件套/legacy 回滚 fail-closed/描述预算上限（7 工具合计 ≤6k chars，纳入 tool-surface-budget）/HIGH_RISK 归属/O1 生命周期子集/stale 降级显式化（freshDays 30d）/SCHEMA_SQL 尾部锚合并序/publish_log 列设计/MCP 分层注入。
3. 新增 §9 MCP 工作流（OW8）与 V1-V5 验收；§8 重写为真实闸门链+十步登记清单+测试连锁表。
4. §10 增 O1 启动决策集与有序步骤；验收门全部改为可测命令+断言。
5. 删除 v1 R8"git 可自动合并"错误论断；v1 tool-verify.ts:326/:84 行号错误不再出现。
6. 新增 §13 ADR；终审记录：V1 GO-WITH-FIXES / V2 十缺口全采纳 / V3 分层方案采纳 / Architect SOUND-WITH-CHANGES（修正全部合入）/ Critic 两轮（首轮 REVISE 三必修+四改进全采纳；复核定稿，G0 基线以实测并集 **80/80** 入文——教训：并集类数字必须单次实测，不得由两组分跑数相加；命令纪律 `--test-force-exit`）。
