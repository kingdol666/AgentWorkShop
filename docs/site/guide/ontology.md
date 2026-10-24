# 本体与 AI 先行模型闭环

> 平台有三个建模层：**本体**（约束与知识）、**孪生**（虚拟被控对象）、**求解器 Profile**（优化执行配置）。
> 三者都能由 Agent 用工具创建与迭代，人类在治理点批准与修正。本文是完整操作面与不变量说明。

## 为什么需要本体

产线自动化从来不缺数据，缺的是**可执行的共识**：压力与克重是什么关系、证据到什么级别、哪条工艺窗现在生效、状态未知时该不该放行。AgentWorkShop 把这份共识做成第一对象：

- **Agent 可读可写**（经审批），而不是埋在工程师的脑子和文档里；
- **能编译**成过程模型先验、场景契约与运行时守卫，真正参与作业；
- **有生命周期**：候选影响 → 观测相关 → 已验证控制，硬约束必须携带 `validated_control` 证据才能进控制面；
- **可回滚**：版本不可变，四段 diff 可查，引用可钉住。

## 数据模型

| 维度 | 取值 |
|---|---|
| 实体种类（10） | `process_variable` · `quality_variable` · `equipment` · `material` · `product` · `recipe` · `batch_run` · `defect_mode` · `sensor` · `actuator` |
| 关系种类（8，封闭集） | `influences` · `measures` · `actuates` · `hasPart` · `precedes` · `observedBy` · `constrainedBy` · `basedOn` |
| 证据级别（3） | `candidate_influence`（专家假设）→ `observed_correlation`（数据相关）→ `validated_control`（对照实验/优化运行） |
| 生命周期（5 态） | `proposed → reviewed → validated → approved_for_control → deprecated` |

规则种类：`bound`（量程/工艺窗）· `rate`（变化率）· `state_condition`（状态未知 fail-closed）· `interlock`（安全联锁，编译为 PLC 层决策）· `nonlinear`（编译期拒绝当前求解器不支持的形态）。

## 创建与发布

```bash
# 1) 开草稿
curl -X POST $BASE/api/workshop/ontology \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"ontologyId":"ont-line01","lineId":"ln-xxx","name":"一线本体"}'

# 2) 保存整份文档（乐观锁 rev；活体校验 schema/量纲/绑定）
curl -X PATCH $BASE/api/workshop/ontology/drafts/$DRAFT \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"doc":{...},"expectedRev":1}'

# 3) 规则生命周期（硬规则需批准单 + 第二人裁决）
curl -X POST $BASE/api/workshop/ontology/drafts/$DRAFT/rules/R-BOUND/transition \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"to":"reviewed"}'

# 4) 发布（admin；不可变版本）
curl -X POST $BASE/api/workshop/ontology/drafts/$DRAFT/publish \
  -H "authorization: Bearer $TOKEN"
```

管理台 `/ontology` 六 tab：**概览 · 关系图 · 规则 · 绑定 · 版本 · 编译预览**。版本 tab 提供四段 diff（`entities / relations / rules / bindings`）；编译预览展示四类产物与逐规则 Rule Trace。

## 编译产物与不变量

| 产物 | 用途 |
|---|---|
| `ProcessModelDelta` | 训练特征候选、τ = D/v 时滞先验、单调性约束（供数据集/训练规划） |
| `ProblemIrDelta` | 求解问题域增量的可审形态（当前**已编译、未消费**为求解约束） |
| `SceneContractPatch` | 孪生场景/守卫补丁 |
| `ControlGuardSet` | 下发时 **节点意图守卫**（`block_recommendation` / `annotate`） |

不变量（违反即编译/发布失败）：

1. **只收紧**：规则只能收窄、不能放宽已有边界；
2. **控制级证据**：`bound / rate / nonlinear` 硬约束必须带 `validated_control` 证据；
3. **PLC 层隔离**：联锁编译为 `PLC_LAYER_REQUIRED` 决策，不被软件当成可执行守卫；
4. **哈希域分离**：`ontologyRefs` 进 Profile 内容哈希，**永不进** `ProblemIR` 哈希——本体漂移是 `409 ONTOLOGY_PACK_DRIFTED`，不会伪造 IR 变更；
5. **fail-closed**：守卫评估时状态未知 → 阻断并给出原因码 `state_unknown`。

## 描述字段与自动修复

三类模型都有面向人的描述，Agent 可读写、人类在管理台可见：

| 模型 | 描述字段 | Agent 入口 | 人类入口 |
|---|---|---|---|
| 本体 | 文档 `description` + 实体/规则描述 | `ontology_draft_update`（整份文档）/ autofix 补齐 | `/ontology` 头部与详情；PATCH 草稿 |
| AML 模型 | `label` + `description` | `aml_model_annotate` | `/aml` 模型台账（描述副行）；PATCH 元数据 |
| 求解器 Profile | `name` + `description` | `optimizer_profile_propose`（`profile_name/profile_description`） | `/optimizer` 表单与版本列表 |

**自动修复**（`POST /ontology/drafts/:id/autofix`、工具 `ontology_draft_autofix`、页面「自动修复」按钮）
只做安全、确定、幂等的规范化：

- 补文档/实体/规则描述；量纲跟随单位（复合单位如 `mm/s` 不强行声明）；
- 规则/绑定作用域回填产线；绑定单位回填、`scale` 非法归一；
- 悬空关系/绑定移除；重复 id 去重或改 `-dupN`；
- 证据不足却停在 `approved_for_control` 的硬规则回退 `validated`。

**部分修复可以落库**（乐观锁 + 审计），残余错误随回执返回；`validated_control` 证据不会被伪造。

## 运行时真正生效的四处

1. **下发守卫**：`dispatch.service` 建卡前调 `evaluateOntologyGuardsForNodes`，命中 → `409 ONTOLOGY_GUARD_BLOCKED`；
2. **训练先验**：`deriveTrainingPriors(lineId)` 供数据集与训练编排选择特征/时滞；
3. **孪生补丁**：场景编译消费 `SceneContractPatch` 与守卫集；
4. **谱系校验**：Profile 的 `ontologyRefs` 钉住发布版本哈希，下发时 `assertOntologyUnchanged` 复核。

除此之外的全部内容都是**可审阅元数据**——不参与执行，这是刻意设计。

## Agent 工具（9 件）

| 工具 | 作用 | 写类 |
|---|---|---|
| `ontology_scene_inspect` | 读当前活跃本体场景子图（实体/规则/守卫/绑定） | 读 |
| `ontology_rule_explain` | 解释单条规则（DSL、证据、决策） | 读 |
| `ontology_version_compare` | 版本四段 diff | 读 |
| `ontology_draft_create` | 起草（归属 Agent 绑定面内的产线） | 写 |
| `ontology_draft_update` | 整份文档更新（乐观锁） | 写 |
| `ontology_draft_validate` | 活体校验（schema/量纲/绑定） | 写 |
| `ontology_compile_preview` | 编译预览 + Rule Trace（不发布） | 写 |
| `ontology_draft_autofix` | **自动修复**可安全修复项并落库（证据不伪造） | 写 |
| `ontology_publish_propose` | 提议发布（挂 HITL 卡，管理员批准后发布） | 写 |

外部 MCP 服务镜像其中三件只读工具（`scene_inspect / rule_explain / version_compare`）。

## 模型采纳环——进化的是模型，不只是参数

参数优化闭环（求解 → 建议 → 下发）已覆盖「在既定模型上找最优点」。本体与采纳环覆盖的是**模型本身怎么长**：

```
数据集构建（谱系 verified + 资格门）
        ↓
AML 训练（linear_arx / 状态空间 / hybrid_residual）
        ↓  模型登记（artifactKind + artifactHash）
optimizer_profile_propose（Agent 工具：复制已发布配置 + 换新工件 + 草稿 v(n+1) + HITL 卡）
        ↓
HITL 批准（单一咽喉）→ 发布 v(n+1)（冻结哈希）+ 自动重绑全部旧绑定（revision+1）
        ↓
下一次 optimizer_solve 使用新模型（在飞求解按 BINDING_STALE 收敛）
```

治理不变量：

- 提议 = 草稿 + 卡，**本身不改运行行为**；
- 发布只发生在人类批准之后（dispatcher / decide 双入口同路由）；
- 兼容性（工件种类 × 求解器族）在提议时校验，不兼容 422；
- Agent 只能在自身绑定面内提议 Profile；
- 拒绝 / 超时 = **零写**；每轮留 `adopt_propose(agent)` + `adopt(user)` 审计行；
- 旧版本保留，可回退。

孪生侧同样由 Agent 创建：`twin_scene_discover → twin_scene_compile → twin_scene_freeze`（人批准）`→ twin_physics_spec_draft / validate / compile → twin_snapshot_create`（服务端采数）`→ twin_trial_run`（recommendation-only）。

## 管理者表面

| 页面 | 能看到什么 |
|---|---|
| `/ontology` | 六 tab 全量：图、规则(+生命周期操作)、绑定、版本(+diff)、编译预览 |
| `/optimizer` | Profile 全版本台账（含每版模型工件）、绑定与重绑记录、求解运行与推荐 |
| `/aml` | 模型台账（stage / metrics / artifactHash）、训练作业、晋升 |
| `/analysis` | 分析台账（本体×诊断联动结论可回查） |

## 验证

| 套件 | 结果 |
|---|---|
| 单元测试（含本体 10 个文件 + 采纳 7 例） | 531/531 |
| 服务层本体 e2e | 44/44 |
| 本体真机 e2e（PLC 场景 + REST + 运行时守卫 + AML + 求解 + UI） | 72/72 |
| 模型闭环真机 e2e（孪生创建链 + 两轮采纳 + 零设备写入） | 46/46 |
| MCP 工具面 | 14/14 |

证据与报告：`docs/audit/2026-10-24-ontology-acceptance.md`、`docs/audit/2026-10-24-ontology-live-report.md`、`docs/audit/2026-10-24-model-loop-acceptance.md`。

## 边界（显式）

- `ProblemIrDelta` 已编译但尚未作为求解约束消费；
- 执行结果回写推荐台账（outcome 回路）与逐回合本体 prompt 注入属下一轮；
- RDF / OWL / SHACL 导出未交付；
- 求解器族扩展仍在既有模板矩阵内（`linear_mpc_quadratic@1` 等），不支持的形式编译期拒绝。
