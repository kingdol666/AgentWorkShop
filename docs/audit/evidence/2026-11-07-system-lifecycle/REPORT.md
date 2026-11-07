# 全系统端到端验收 + 全生命周期实机演示报告

> 日期:2026-11-07 | 基线:main `7513a02f`(含本轮修复 PR #82)| 实例:3995(独立 .e2e-home)
> 结论:**验收标准矩阵全部达成;五套测试新鲜运行全绿;全生命周期演示 42/42 实机通过;新增功能完整(附缺口清单);本轮揪出 2 个真缺陷并已修复合入。**

## 0. 本轮定位

对「Session Context M1 + 注入 v2 + 记忆运行时 + Project 持续对话」全部新增功能做一次**不预设结论的全系统审计**:先定义验收标准,再全量新鲜跑测试,再以确定性引擎走完整生命周期实机演示,最后回答两个问题——新增功能是否完整?系统运行的全生命周期是什么样?

## 1. 测试结果总账(全部新鲜运行,非复用历史)

| 套件 | 结果 |
| --- | --- |
| 全量 unit(40 suites) | **1192 tests / 1190 pass / 0 fail / 2 skipped** |
| M1 Session Context 验收(自起隔离实例) | **20/20** |
| 注入 v2 验收(自起隔离实例) | **24/24**(修正一处断言竞态后) |
| 记忆运行时验收(自起隔离实例) | **22/22** |
| Session UI 验收(puppeteer 自起) | **8/8** |
| 全生命周期演示(3995 实机) | **42/42** |
| 生命周期 UI 截图断言 | **2/2** |

## 2. 全生命周期演示(L1→L10,42 断言)

| 阶段 | 内容 | 断言 |
| --- | --- | --- |
| L1 身份与工作区 | health/me/workspace | 3/3 |
| L2 Channel 生命周期 | 建频道/加员/群聊门(409)→开启/详情 | 5/5 |
| L3 会话生命周期 | manual session→对话(分层注入+压缩+pinned)→ctx 标签→关闭→目录 closed | 5/5 |
| L4 项目计划期 | 建项目→双频道绑定→交付物→工作项×2→激活→plan 提交/批准 | 7/7 |
| L5 执行期 | 双派发→实例频道+task session→真并行 COMPLETED→记忆 session 戳 | 5/5 |
| L6 协作期 | 跨频道 A2A requireReply→回执回源 | 2/2 |
| L7 交付期 | reconcile→全部 draft 走 **agent 提交链**(authorAgent 持证→L1→证据门→L2)→**交付物级 approved** | 3/3 |
| L8 收口期 | complete(门禁通过)→审批→**completed**→归档→**archived**→continue 409(终态治理)→运行中项目 terminate→**canceled** | 6/6 |
| L9 治理幂等 | 归档终态重复 continue 仍 409 | 1/1 |
| L10 治理与审计 | 非法角色 400/匿名 401/未批 plan 409/全链事件齐备/终止审计 | 5/5 |

截图:project-completed-desktop.png(归档态:工作项 100%/交付物签核 100%/周报 22 事件)、project-events-desktop.png。

## 3. 本轮揪出的真缺陷(2 个,均已修复并合入 main)

### D1【P1】多工作项交付物永远无法完成项目
- approved 槽位唯一索引是**交付物级共享** `(project, deliverable, result_key) WHERE approved`;批准新工作项成果会 supersede 其他工作项的 approved → `deliverableAcceptanceReady`(每工作项需 approved)永不可满足 → complete 门永拒。
- 修复(PR #82,`7513a02f`):槽位索引改为含 `work_item_id`(schema+旧库迁移);同工作项内版本替换语义保持;单测 3/3(含 complete 门放行)。
- 说明:实测演示中该缺陷曾使 complete/archive 永远 409;修复后 L7-3/L8-1..L8-4 全绿。

### D2【P2】重复创建工作项逃逸为 500
- 同 dedupe 键重复创建 → UNIQUE 约束未捕获 → INTERNAL_ERROR;修复为结构化 409 `WORK_ITEM_EXISTS`(同 PR #82)。

### D3【P3,记录待排期】调度器 WORKING→WORKING 迁移错误
- 重复派发同决策时调度器记一次 `非法状态迁移: WORKING → WORKING`;被捕获不影响终态,待幂等加固。

## 4. 新增功能完整性评估

| 功能 | 状态 | 依据 | 缺口(如实) |
| --- | --- | --- | --- |
| Session Context M1(会话实体/brief/history/catalog/三类型) | ✅ 完整 | M1 20/20;L3;unit 40 suites | — |
| 注入 v2(三层装配/pinned/压缩世代/profile) | ✅ 完整 | inject-v2 24/24;L3-2/3;unit | LLM 摘要式压缩留作开关 |
| 记忆运行时(session 作用域/写路径戳/工具贯通) | ✅ 完整 | memory 22/22;L5-5;unit | 会话结束记忆降级钩子待排期 |
| Project 持续对话(continue/reopen) | ✅ 完整 | unit project-continue;L8-4/L9 治理;单测 reopen | — |
| Project 全生命周期(计划→派发→协同→交付→验收→完成→归档→终止) | ✅ **本轮修复后完整** | lifecycle 42/42;D1 修复 | — |
| 多 Channel 协同(跨频道 A2A/成果复用/真并行实例频道) | ✅ 完整 | L5/L6/L7;E2E 前轮证据 | — |
| 错误处理与治理(结构化 envelope/审计) | ✅ 完整 | L10;S6 矩阵;PR#80/#82 | D3 幂等加固待排期 |
| 引擎无关(profile/harness 探测/真实引擎) | ✅ 完整 | 环境探测 14 引擎可用;omp 真实腿 COMPLETED | omp 整页 HTML 产能受限(如实记录) |

## 5. 系统运行的全生命周期(实机验证的语义)

**实体状态机**(全部由 L1-L10 演示与单测实证):
- **Channel**: 创建(lead 内建) → 加成员/开群聊(chatEnabled 显式) → 会话/消息/任务 → 归档(工作区挂载可移)
- **Session**: manual/task/project 三类型 → active 对话(每回合分层注入:身份+pinned+早期压缩+近期原文)→ 压缩世代演进 → close(目录 closed,brief 可读)
- **Project**: draft → active(绑定频道/交付物/工作项/plan 审批)→ 派发(每工作项独立任务实例 Channel+task session)→ 执行/协同(跨频道 A2A)→ 交付(reconcile→draft→agent/owner 提交→证据门→L1 评审→L2 验收)→ **全部工作项各持 approved → 交付物 approved → complete 门通过 → completed → archived**;旁路:paused/resume、terminate(级联终结→canceled)、continue(completed 补需求 reopen;archived 409)
- **Task**: SUBMITTED→ASSIGNED→WORKING→COMPLETED/FAILED/CANCELED;budget=deadline 从入场起算(ROOT_TIMEOUT 语义);父任务收口需子任务终态+lead 验收总结
- **Memory**: 写路径自动戳 session(peer/task-outcome/compaction/save)→ 检索 auto/session 分档 → 任务终态/协作交换持久化
- **Approval**: plan_approval / deliverable_acceptance / project_complete 三类;owner/admin/approver 分权;SELF_APPROVAL_FORBIDDEN(owner 不能批自己提交的成果);acceptance 门重跑证据 provenance(树域可回溯)

**一次真实任务的全链**(落地页前轮 + 本轮):建频道(分工)→ 建项目(目标/交付物/验收标准)→ 绑频道 → 建工作项(跨频道)→ plan 审批 → 逐个派发(实例频道+task session,记忆/注入全生效)→ 执行(真实引擎或 mock)→ 跨频道协同/成果取回 → reconcile 物化 → 证据门核验(树内 artifact 可溯)→ L1 技术评审 → L2 业务验收(agent 作者持证,owner 批)→ 交付物 approved → 项目 complete 审批 → completed → archived(终态);运行中可 terminate 级联终结。

## 6. 证据清单

ACCEPTANCE-CRITERIA.md(标准+结果映射)/ FINDINGS.md(D1-D3)/ lifecycle-demo.json(42/42)/ ui-lifecycle-capture.json(2/2)/ project-completed-desktop.png / project-events-desktop.png / 四套 fresh 结果 txt / server 日志(3995)。修复 PR:#80(证据树域)、#82(槽位+结构化 409)。
