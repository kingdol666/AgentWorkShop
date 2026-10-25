# AI-first 闭环作业验收规范（2026-10-24 定稿 · CL1–CL6）

> 目标：Agent 拥有求解器/AML/本体/孪生全族工具，作业过程中可**动态迭代模型**（不止参数优化），人类作为管理者在治理点批准/查看/更新；"AI 先行、人类把关、全程可审计"。
> 状态：**已实现并验收**（验收证据见 §4；回归 531 单测 / 44 服务层 e2e / **72/72 真机 e2e** / 14 MCP / 五门禁 ALL PASS）。

## 0. 职责分工（人机交互契约）

| 动作 | Agent（AI 先行） | 人类（管理者） |
|---|---|---|
| 参数优化 | solve→互校→建议→**发起下发卡** | HITL 批准 → D13 重验 → 设备写入 |
| 模型迭代 | 建数据集→训练→过门→登记→**发起采纳提议**（含理由+指标） | HITL 批准 → 自动发布+重绑（或拒绝，意见回流） |
| 本体迭代 | 起草/校验/编译预览/**提议发布** | 审查→验证→第二人批准→管理员发布 |
| 孪生迭代 | 场景发现/编译/**物理规格起草**/试验/贝叶斯寻优 | 场景冻结(approvedBy)、校准 HITL |
| 管理面 | — | /ontology /aml /optimizer 三管理台：查看全部版本/台账、retire、rebind、发布 |

铁律：**Agent 无任何绕过 HITL 的写路径**（工具面 grant-guard + dispatch 咽喉 + 本体审批账本三层收口）；每次 AI 动作落 audit_log（actor 三态）。

## 1. CL1 参数优化闭环（已有，本轮回归）

- CL1.1 `optimizer_solve` optimal，candidates 带 UQ 证据（verified/unverified）→ `e2e-ontology-live.mjs L5.5`
- CL1.2 crosscheck 双实现互校 pass（dev ≤ 1e-6）→ `L5.7`
- CL1.3 求解零 DCW 写入（治理红线）→ `L5.6`
- CL1.4 下发卡 → HITL → D13 八项 → DCW 写回读 → 对账 → `e2e-optimizer-live.mjs` W 系列（104/104 基线）

## 2. CL2 模型迭代闭环（本轮新增 ★）

- CL2.1 Agent 训练新模型：`aml_dataset_build → aml_job_submit → done → aml_models 登记`（真机 L4.3-L4.8）
- CL2.2 **采纳提议**：`optimizer_profile_propose` 复制已发布配置+换新模型工件+草稿新版本+挂卡 `optimizer-profile:<id>@<v>` → 真机 `L5.10`
- CL2.3 **单一咽喉裁决**：dispatcher 与 decide 端点双入口同路由 `decideProfileAdoption` → 批准=发布冻结+**自动重绑**（绑定 revision+1，在飞求解 BINDING_STALE 收敛）→ 真机 `L5.11-L5.13`（published v3，rebindCount=1，versions=[1,3]）
- CL2.4 新模型即刻生效：重绑后 `optimizer_solve` optimal → `L5.14`
- CL2.5 拒绝/超时 = 零写（草稿保留，意见回流）→ 单测 `optimizer-profile-adopt.test.ts` reject 用例
- CL2.6 D21 兼容性守门：ONNX 工件+OSQP 提议 → 422 UNSUPPORTED_MODEL_SOLVER，不产生草稿 → 单测
- CL2.7 越权拒绝：Agent 只能对**自己绑定面内**的 Profile 发起采纳 → 工具内 binding 校验
- CL2.8 诚实汇报：批准但发布未由咽喉完成 → 工具显式报"未完成"（fail-closed 汇报）→ 单测+真机

## 3. CL3 本体迭代闭环（上轮交付，本轮回归）

- CL3.1 起草→校验→编译预览→证据→生命周期→第二人批准→发布 → 服务层 e2e 44 断言 + 真机 L2（20 断言）
- CL3.2 运行时守卫（低温禁提速/状态未知 fail-closed）→ 真机 L3（7 断言）
- CL3.3 Agent 工具 8 件全注册（host-tools/INDUSTRIAL_HANDLERS/grant-guard/tool-verify）

## 4. CL4 孪生闭环 / CL5 注入差异化 / CL6 管理面

- CL4 孪生：`twin_scene_discover/compile/freeze`（冻结需人 approvedBy）、`twin_physics_spec_draft/validate/compile`、`twin_trial_run`（违例试验不可 write-eligible）、`twin_calibration_request`（HITL）、`twin_bayes_optimize` —— 工具全注册，闭环语义由既有 twin 套件覆盖
- CL5 注入差异化：Channel 档位（legacy/hybrid_twin/aml_training/aml_optimization/观察面）× 逐 Channel 工具开关 × 逐调用归属复核（tool-verify 实时重算 agentOpsScope）—— 真机 L5.1 用 `chtpl-aml-optimization-default` 模板实例化（优化档位），optimizer 族工具才开放
- CL6 管理面：/ontology（六 tab+版本 diff+retire）、/aml（模型台账/promote）、/optimizer（Profile/runs/绑定）+ HITL 审批面板双入口（/monitor 与 agent-tools approvals）

## 5. 测试矩阵（本轮实测）

| 测试 | 断言 | 结果 |
|---|---|---|
| `tests/optimizer-profile-adopt.test.ts`（新增） | 7：propose 草稿+卡 / decide 批准→发布+重绑+审计 / 采纳即解 / 拒绝零写 / D21 拒绝 / 404 双例 / 工具面登记 | 7/7 |
| `scripts/e2e-ontology-live.mjs`（扩展 L5.10-5.14） | 72：+采纳卡挂出/咽喉裁决/工具回执/自动重绑/新模型 solve | **72/72** |
| `scripts/e2e-model-loop-live.mjs`（模型层闭环，2026-10-24 第四轮新增） | 46：M0 档位面 / M1 本体含管理者修正 / M2 孪生创建链（全工具） / M3-M4 两轮模型进化（训练→工具采纳→HITL→发布重绑→新模型 solve） / M5 管理者面 / M6 前端 | **46/46** |
| 全量单测 | 531（524+7） | 531/531 |
| 服务层 e2e / MCP / 五门禁 | 44 / 14 / ALL PASS | ✅ |

## 6. 本轮修复的真实缺陷

1. **采纳卡咽喉未接管**（设计缺陷，测试抓出）：decide 分支把审批单 id（`ap-…`）误当 nodeId 传给 `decideProfileAdoption` → `isProfileAdoptCard` 恒 false → 落到 generic decide「批准但零发布」。修复：分支显式传 `nodeId: pending.nodeId` + 服务端审批单反查兜底。
2. **工具回执诚实化**：approved 但未发布 → 工具显式报"未完成"（原实现会误报"采纳完成"）。
3. `binding.repo.rebindVersion` / `profile.repo.latestPublished` 两个仓储方法补齐。

## 7. 遗留（明确不做/下一轮）

- 求解器本体优化（solver 自身超参/算法族扩展）仍在总账本"明确不做"边界内；Agent 可经 propose 切换 `solver_ref/template_ref`（工具参数已支持）。
- `ProblemIrDelta` 进 solve 可行域、outcome 回路写入端、本体逐回合 prompt 注入 —— 沿用 ontology 计划遗留清单。
