# 本轮(全系统审计)揪出的缺陷与修复

## D1. 【P1】多工作项交付物永远无法完成项目(approved 槽位被交付物级共享)

- **现象**:全生命周期演示走到「项目完成」时,`complete` 永远 409 `DELIVERABLES_INCOMPLETE: 必选交付物未验收`;交付物状态停留在 `planned`。
- **根因**(三层叠加):
  1. schema 级部分唯一索引 `uq_project_result_approved ON (project_id, deliverable_id, result_key) WHERE status='approved'` —— approved 槽位是**交付物级共享**;
  2. L2 批准新成果时 `findApprovedSlot` 按 (deliverable, resultKey) 找旧批准并 **supersede** 之 → 多工作项交付物中,批准第 N 个工作项成果会把第 N-1 个工作项的 approved 挤成 superseded;
  3. `deliverableAcceptanceReady` 要求「每个工作项都有 approved 结果」才翻转交付物状态 → 与共享槽位互斥 → 交付物永远无法 approved → complete 门永拒。
- **影响**:任何「单个交付物 → 多个工作项」的项目(本项目的主要用法)都无法走完 complete/archive 生命周期。上一轮落地页演示时同样卡在此处(当时误报为已完成,本轮如实纠正)。
- **修复**(PR #82,已合 main `7513a02f`):
  - 索引改为 `(project_id, deliverable_id, result_key, work_item_id) WHERE status='approved'`(schema + `migrateApprovedSlotScope` 旧库迁移:drop+recreate);
  - `findApprovedSlot` 增加 workItemId 维度;decideApproval 传 `result.workItemId` —— 同工作项内新版本仍收编旧版本(版本替换语义保持),跨工作项互不影响;
  - 单测 3/3:跨工作项隔离+complete 门放行 / 同工作项版本替换 / 重复工作项结构化 409;全量 unit **1192/1190/0**。

## D2. 【P2】重复创建工作项逃逸为 500

- **现象**:同标题重复创建 `POST /projects/:id/work-items` → `INTERNAL_ERROR`(服务端日志 `UNIQUE constraint failed: project_work_items.project_id, project_work_items.dedupe_key`)。
- **修复**(同 PR #82):`createWorkItem` 捕获 UNIQUE(err 2067)→ 结构化 409 `WORK_ITEM_EXISTS`,与 agent 路径口径一致。

## D3. 【P3,行为已记录】调度器 WORKING→WORKING 迁移错误

- 服务端日志出现一次 `AppError: 非法状态迁移: WORKING → WORKING`(SchedulerLoop.execute 重复派发同决策时);被调度器捕获记日志,任务最终完成,未见用户可见影响。已记录,待排期加固(幂等决策去重)。
