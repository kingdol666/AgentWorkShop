# 模型管理面验收规范：描述字段 + 校验自动修复（2026-10-24 · MD1–MD14）

> 目标：本体 / AML 模型 / 求解器 Profile 三类模型都**有可读描述**、都能被 Agent 管理与修正；
> 本体草稿的校验问题可以**自动修复可安全修复的部分**，且证据永不伪造。
> 状态：**已实现并验收**（单测 538 / 服务层 50 / 模型闭环真机 54 / 本体真机 72，见 §3）。

## 1. 功能规约

| 编号 | 验收点 | 判定 |
|---|---|---|
| MD1 | 本体文档有 `description`（人类可读：这段本体约束什么工况/目标） | 草稿文档字段 + PATCH 保留 + 详情可读 |
| MD2 | 本体实体/规则描述：缺省由 autofix 补齐（实体←名称，规则←DSL 语义） | fixes 含 `ENTITY_DESCRIPTION` / `RULE_DESCRIPTION` |
| MD3 | 自动修复：量纲跟随单位；复合/未知单位（如 `mm/s`）清空量纲不强行主张相容 | 审计 + 幂等 |
| MD4 | 自动修复：规则/绑定作用域回填文档产线；绑定单位回填实体单位；scale 非法归一为 1 | 审计 + 幂等 |
| MD5 | 自动修复：悬空关系/绑定确定性移除；重复 id 去重或改 `-dupN` 保留两份 | 审计 + 幂等 |
| MD6 | **证据不伪造**：硬约束证据不足仍报错；停在 `approved_for_control` 的自动回退 `validated` | 修复后 `validation.ok=false` 且状态已回退 |
| MD7 | 自动修复**部分修复可落库**（残余错误随回执返回），且走乐观锁 + 审计 | rev 前进、审计 `draft.autofix` |
| MD8 | Agent 工具 `ontology_draft_autofix`：写族、链式 `draft_id→产线`、WVO 引用复核 | host-tools / handler / grant-guard / surface test |
| MD9 | UI 自动修复入口：`/ontology` 有「自动修复」按钮，仅在存在问题时可用；修复清单在页面可见 | 真机 UI 断言 |
| MD10 | AML 模型有 `label` + `description`；Agent 工具 `aml_model_annotate` 可改；REST PATCH 同源；`/aml` 台账可见 | 真机 tool + UI 断言 |
| MD11 | 求解器 Profile 有 `name` + `description`；创建/采纳可写；版本台账与 `/optimizer` 可见 | 单测 + 真机 UI |
| MD12 | 三类模型的描述均**不影响门禁**（不能通过改描述绕过阶段/发布/绑定限制） | 代码路径只改元数据列 |
| MD13 | 前端渲染：`/ontology`（描述+修复清单）、`/optimizer`（名称/描述列）、`/aml`（描述副行）零 pageerror | 真机截图 |
| MD14 | 全量回归不破坏既有行为：单测 / 服务层 e2e / 本体 live / 模型闭环 live | 见 §3 |

## 2. 设计约束

- 自动修复只做**安全、确定、幂等**的规范化；`RULE_STATUS_DOWNGRADE` 只回退、不升级。
- 证据（`validated_control`）不可由修复器生成；残余错误必须由人或 Agent 补真实证据。
- 修复与普通写入共用乐观锁 `rev`；冲突返回 409。
- 描述字段是元数据：不进 `ProblemIR` 哈希，不影响求解与下发。
- 三类模型的描述字段仅通过各自受治理的入口写（本体=草稿/PATCH/工具；AML=annotate/PATCH；Profile=创建/采纳）。

## 3. 测试矩阵（本轮实测）

| 套件 | 断言 | 结果 |
|---|---|---|
| 单元测试（新增 `tests/ontology-autofix.test.ts` 8 例 + 采纳描述断言） | 538 | 538/538 |
| 服务层本体 e2e（ON13 自动修复 6 断言） | 50 | 50/50 |
| 模型闭环真机（新增 M1.1b/M1.5/M1.6/M3.0/M3.10b/M6.3-M6.5） | 54 | 54/54 |
| 文档一致性 / 构建 | 91 / build | 通过 |
| 类型检查（server tsconfig） | — | 0 error |
