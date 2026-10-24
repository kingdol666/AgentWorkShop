# Ontology Service 验收报告（2026-10-24）

> 计划依据：`docs/plans/2026-10-24-ontology-service-plan.md` v2（ONT-1..22）
> 结论：**核心交付完成，五门禁全绿**（524 单测 / 44 e2e / 14 MCP / lint·typecheck·unit·i18n·docs 全 0）。
> 范围说明：本轮交付 O1 + O2 全部、O3 的 Profile 耦合与运行时守卫、MCP 只读面、管理界面；O4（文档抽取建本体）与 RDF 导出留作下一轮（见 §7）。

---

## 1. 交付清单（按计划工作流）

| 工作流 | 交付 | 状态 |
|---|---|---|
| OW1 最小核心 | `shared/dimensions.ts`（量纲归一，修 `℃` U+2103 缺口）；9 张 `ontology_*` 表；`contracts/validator/repo/service/semantic-binding` | ✅ |
| OW2 编译器+治理 | `compiler.ts`（四类产物 + Rule Trace + 只收紧）；生命周期状态机；第二人批准；不可变发布；版本 diff；REST 全套 | ✅ |
| OW3 Profile 耦合 | `OptimizationProfile.ontologyRefs` + `optimizer_profiles.ontology_refs_json` 列；`assertOntologyUnchanged`（`ONTOLOGY_PACK_DRIFTED`）；`evaluateOntologyGuardsForNodes` 接入 `createDispatchCard` | ✅ |
| OW4 工具面 | host 原生 **8** 工具 + grant-guard 写族三件 + tool-verify 2 个链式类别 + 档位排除 | ✅ |
| OW5 Agent 上下文 | `sceneSubgraph` / `deriveTrainingPriors`（绑定面实体 1 跳子图 + 训练先验） | ✅（注入挂钩待 O4 落地 prompt） |
| OW6 发布治理 | `ontology_publish_log`（actor_kind/solo_operator/approval_id）+ 审批单 ledger + 全链审计 | ✅ |
| OW7 RDF 导出 | — | ⏳ 下一轮 |
| OW8 MCP 注入 | 外置 `aw mcp` 3 只读工具；桥面零改动自动投影 8 工具 | ✅ |
| UI | `/ontology` 六 tab 管理台 + 侧边栏 + i18n zh/en parity | ✅ |

### 文件清单

**服务层**
- `shared/dimensions.ts`（新，量纲/单位归一唯一共享实现）
- `server/services/workshop/ontology/{contracts,validator,compiler,guards,repo,semantic-binding.service,ontology.service,index}.ts`
- `server/services/workshop/agents/industrial/ontology-tools.ts`（8 工具实现）

**数据层**
- `server/services/workshop/db/database/schema.ts`（尾部 `-- ===== ontology (ONT) =====` 9 表）
- `server/services/workshop/db/database/open.ts`（`optimizer_profiles.ontology_refs_json` 补列）

**接入点（改动既有文件）**
- `server/services/workshop/optimization/{contracts,profile.repo,dispatch.service}.ts`（ontologyRefs / 漂移 / 守卫）
- `server/services/workshop/agents/industrial/{grant-guard,tool-verify}.ts`（写族 + 链式归属 + draft_id→line）
- `server/services/workshop/agents/tool-reference-spec.ts`（`ontology_draft`/`ontology_version`）
- `server/services/workshop/agents/host-tool-bridge/tools/industrial.ts`（8 handler）
- `server/services/workshop/aml/twin/physics-spec.ts`（复用共享量纲表，删除本地副本）
- `.AgentWorkShop/prompts/host-tools.json`（92 → 100 工具）
- `mcp/aw-mcp-server.mjs`（3 只读工具）

**REST**：`server/api/workshop/ontology/` 下 12 个路由文件（清单/草稿 CRUD/校验/编译/发布/证据/规则迁移/批准申请与裁决/版本/比较/溯源/场景/导出）。

**界面**：`app/pages/ontology/{index.vue,api.ts,types.ts}` + `app/components/AppSidebar.vue` + `i18n/locales/{zh-CN,en}.ts`（各 +127 键）。

**测试**：`tests/ontology-{dimensions,schema,validator,compile,guard,binding,service,profile-coupling,tools-surface}.test.ts` + `tests/ontology-fixture.ts` + `scripts/e2e-ontology.mjs`。

---

## 2. 本体模型是怎么设计的

### 2.1 三层结构

1. **草稿（可变工作副本）** —— 一份规范化 JSON 文档（实体/关系/规则/绑定），单活跃、乐观锁 `rev`、属主私有。
2. **发布版本（不可变快照）** —— 发布时物化为 9 张表的行 + `content_hash` + `compiled_json`；同一 `(本体,版本)` 不可二次写入。
3. **运行时语义上下文（不落库）** —— 按产线取「最新 published 版本」，组装绑定面子图与守卫集，供 Agent 上下文 / 求解 / 下发即时消费。

### 2.2 核心对象与语义纪律

- **实体**：10 类（产线/工艺单元/设备/传感器/执行器/工艺变量/质量变量/模型/优化任务/工况）；变量类实体带 `role`（control/target/disturbance/feature/state/guard/observation），决定编译时进 `mvBounds` 还是 `cvBounds`。
- **关系**：8 种封闭枚举（`influences/measures/actuates/hasPart/precedes/observedBy/constrainedBy/basedOn`），**禁止宽泛 relatedTo**。
- **证据三级**：`candidate_influence < observed_correlation < validated_control`。增益/时滞**只能**来自 `validated_control`，且以模型单位存储（展示经 `shared/units.ts`）。
- **生命周期五态**：`proposed → reviewed → validated → approved_for_control → deprecated`；`approved_for_control` = 可以进入控制侧产物的最强档，**不等于执行授权**。

### 2.3 编译器：本体 → 四类产物（这是"本体真正起作用"的地方）

| 规则形态 | 产物 | 运行位置 |
|---|---|---|
| 上下限 bound | `problemIr.cvBounds/mvBounds` | 求解器盒约束（与现行界求交，**只收紧**） |
| 变化率 rate | `problemIr.mvBounds[].maxStep` | 求解步限 + 下发步限复检 |
| 状态条件 / 阈值非线性 | `controlGuard.guards[]` | **运行时守卫**（求解前/下发前求值，可阻断） |
| 安全联锁 / 不可形式化 | 无产物（`explained`） | 归 PLC/DCW 配置层或人工审核 |
| 线性耦合 / 复杂非线性 | 拒绝（`REJECTED_UNSUPPORTED_FORM`） | 当前 IR 无自由 `A_ub`，不伪装成界 |
| 关系 influences | `processModel.featureCandidates/delayPriors/monotonicity` | AML 特征候选、时滞先验（含 τ=D/v） |

每条规则都留一行 **Rule Trace**（`ontology_rule_traces`，含 `row_hash`），前端/工具可回答"这条建议受哪条规则、什么证据、哪个版本限制"。

---

## 3. 自定义创建 / 管理 / 绑定 —— 都支持，且与求解器绑定同一套治理范式

**创建**：`POST /api/workshop/ontology`（或工具 `ontology_draft_create`）→ `{ontologyId, lineId}`；可空白起草或 `cloneFromVersion` 克隆上一版。

**管理**：`PATCH /drafts/:id`（整份文档 + `expectedRev` 乐观锁）→ 服务端先跑结构校验（key 唯一/引用不悬空/证据级别自洽/量纲相容）**与活体绑定校验**，任一失败 422 且不落库；`/validate`、`/compile`、`/versions`、`/versions/compare`、`/export` 覆盖体检、预览、版本史、diff、导出。

**绑定（语义绑定 ≠ 求解器绑定，但机制同构）**：

| 维度 | 求解器绑定（既有） | 本体语义绑定（新增） |
|---|---|---|
| 锚定对象 | Channel 实例 → Profile 版本 | 本体实体 → `daq_node` / `dcw_node` / `recipe_param` |
| 归属校验 | 实例身份 + workspace/channel 归属 | 目标存在性 + 产线锚（`line:<id>`）+ 读写能力 |
| 单位纪律 | `shared/units.ts`（禁 1/0 兜底） | 同一边界；同量纲异字面单位必须显式 `scale/offset`，否则 `UNIT_TRANSFORM_REQUIRED` |
| 冲突 | 同实例同 Profile 唯一 | **一个物理量只能有一个写语义**（`BINDING_TARGET_OWNED`）；多读源允许 |
| 漂移 | `BINDING_STALE`（revision 变） | `drifted`（目标删除/停用/单位变更）+ 发布前阻断 |

因此**自定义本体可以按场景自由创建**（每个场景/产线一份本体），但绑定与发布都要过同一套 fail-closed 校验。

---

## 4. 运行过程中是否真正发挥作用 —— 有可执行证据

1. **求解/下发前置守卫（block 级）**：`evaluateGuards` 在 `when` 成立时禁止指定增量；**状态未知且打算提速 → fail-closed 阻断**。已接入 `createDispatchCard`：命中即 `409 ONTOLOGY_GUARD_BLOCKED`，不用等到 D13。
2. **e2e 实测（ON6 组）**：
   - 温度 150℃（<180）+ 提速 → 阻断；200℃ + 提速 → 放行；150℃ + 降速 → 放行；状态未知 + 提速 → 阻断；跨配方 → 不触发（作用域隔离）。
   - **节点级意图面**：写入真实绑定行后，`from 10 → to 12` 被阻断（`state_unknown`），`10 → 8` 放行。
3. **编译器只收紧**：放宽现行界/步限 → `TIGHTEN_ONLY_VIOLATED` 拒绝；发布路径 `approvedOnly` 下未获批规则 → `ONTOLOGY_NOT_APPROVED` 拒绝发布。
4. **Profile 漂移**：`ontologyRefs` 只进 `profileContentHash`，**不进 `problemIrHash`**——旧 Profile 的 canonicalJson 字节不变（回归断言），本体演进不会把存量 Profile 打成 `PROBLEM_IR_CHANGED`；内容被篡改/版本退役 → `ONTOLOGY_PACK_DRIFTED`。

---

## 5. 验收结果（本轮实测）

| 门 | 命令 | 结果 |
|---|---|---|
| 全量单测 | `npm run test:unit` | **524 / 524 pass**（基线 444 + 本体 80） |
| 本体单元套件 | 9 个 `tests/ontology-*.test.ts` | 80 断言全绿（其中 compilе 12 / guard 9 / binding 12 / service 8 / validator 15） |
| 本体全流程 e2e | `npx tsx … scripts/e2e-ontology.mjs` | **44 / 44 pass**（ON1.x–ON12.x） |
| MCP 离线 | `npm run test:mcp` | 14 / 14 pass（含"外置面不得暴露写工具"结构断言） |
| lint | `npm run lint` | 0 error |
| typecheck | `npm run typecheck` | ✔ 通过 |
| i18n | `node scripts/_i18n-verify-keys.mjs` | PARITY OK（zh/en 各 3075 键，unresolved 0） |
| docs | 五门禁内 | 0 |
| **五门禁总** | `node scripts/run-quality-gates.mjs` | **ALL PASS** |

e2e 报告工件：`docs/audit/e2e-ontology-report.json`；门禁证据：`docs/audit/evidence/2026-10-22-optimizer-process-model/gates.json`。

### e2e 断言索引（节选）

ON1 草稿/乐观锁/越权 · ON2 四产物+Trace+活体绑定拒绝 · ON3 证据登记 · ON4 生命周期（跳级/自审/缺证据/无批准单/自我裁决全部拒绝） · ON5 仅 admin 发布+不可变 · ON6 运行时守卫 7 项（含节点级意图面） · ON7 版本演进+diff · ON8 Profile 漂移 · ON9 退役回退 · ON10 审计全链 · ON11 未获批拒发 · ON12 场景子图。

---

## 6. 与计划的偏差（如实记录）

1. **控制级批准载体**：计划写"必须走 HITL 卡（`ontology-release:` 前缀）"，实现为**本体域专用双人审批账本**（`ontology_publish_log` 的 `rule.approve_request` / `rule.approve|reject` + `approval_id`）。原因：`ToolApprovalService`/HITL 卡是 **agent-channel 作用域**，而规则批准是**用户域治理动作**（无 channel）。不变量保持：REST 无 `approvalId` 直批 → 403；申请人不得自裁；第二人批准后才可 `approved_for_control`；全链审计。**遗留**：接入 HITL 卡 UI 的跨域路由（下一轮）。
2. **工具数 7 → 8**：新增 `ontology_draft_update`（Agent 必须能写入文档内容，否则只能创建空草稿）。已在 host-tools.json、grant-guard 写族、tool-verify 链式面同步登记。
3. **`ontology_rules`/`relations`/`bindings` 主键**改为 `(version_id, version, id)` 复合键：规则 id 只在文档内唯一，多本体发布时全局主键会冲突（实现期发现并修正）。
4. **`publish 仅 admin`**：按计划严格执行（editor 可起草/审查/申请，admin 冻结）。
5. **上下文注入挂钩（OW5）**：`sceneSubgraph`/`deriveTrainingPriors` 已就绪并被工具与 REST 使用，但尚未插入 `prompt-builder` 每回合注入（避免 O1 阶段改动 Agent 上下文预算）；随 O4 一并接入。

---

## 7. 下一轮（未完成，明确列出）

1. **O4 文档抽取建本体**：`kb_agent` 检索 → LLM 抽取候选 → candidate 暂存 → 审批（含注入消毒与批量导入安全面）。
2. **OW7 RDF/OWL/SHACL 导出**（P1，手写 Turtle，仅互操作镜像）。
3. **HITL 卡跨域路由**：`ontology-release:` 前缀接入 dispatcher/decide 双入口，使批准在统一审批面板可见。
4. **真机 HTTP 冒烟**：本轮 REST 由 typecheck + 路由存在性 + 服务层同源覆盖；下一轮加 `scripts/e2e-ontology-http.mjs`（隔离实例 + admin token）。
5. **UI 真机走查**：六 tab 截图与交互（含 PublishDialog、版本 diff 视图）。
6. **AST/语义绑定人工确认面**：`ontology_rule_explain` 已在工具面，前端卡片式展示待补。

---

## 8. 设计自评

**成立的部分**：三层结构 + 三级证据 + 只收紧编译 + Rule Trace 构成一条可审计的"知识→约束"链；hash 域分离避免了本体演进污染既有 Profile 冻结；绑定与求解器绑定共用单位/归属/漂移纪律，语义一致；外置 MCP 只读、写面不外泄的边界可被结构断言钉住。

**风险与诚实边界**：① 本体的价值依赖证据质量——`validated_control` 必须真的来自 run+crosscheck+outcome，否则只是"更正式的假设"；本轮用夹具证据验证机制，未做真实产线的长周期证据积累。② 线性耦合/复杂非线性仍不可编译（IR 无自由 `A_ub`），编译器诚实地拒绝而非近似。③ 单管理员部署的自审豁免由 `AW_ONTOLOGY_SOLO_OPERATOR`/管理员人数决定，是治理强度与可用性的显式权衡。④ 消融实验（A–E）未跑，论文中的"本体是否让优化更好"仍待实测数据。
