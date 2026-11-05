# Project 层（多智能体路由编排核心）设计审计报告

**仓库**: AgentWorkShop-project @ main (3da5771a)。由独立只读代理审计（2026-11-05），所有行号实测。

## ① 总评

这套代码达到了**良好的工程化水准（评级 B+），但尚未到「优秀软件设计」（A）**。亮点是清晰的概念分层：确定性依赖解析被提炼为纯函数（route-dispatcher.ts，38 行无副作用）、Effects 事务内入队/提交后执行/CAS claim/指数退避/dead 升级的完整 outbox、快慢事件双路径分级、`uq_project_attempt_live`/`UNIQUE(project_id,event_key)` 等以部分唯一索引作为并发第一道闸门的自觉、审批决策 CAS+全副作用同事务。但三个结构性缺陷阻止它达到 A：**(1)** `dispatchWorkItemAs` 主链路跨 `await` 五步各自独立事务，存在真实崩溃窗口；**(2)** `service.ts` 2311 行承载 7 类职责；**(3)** 工作项终态不封闭——COMPLETED/FAILED 可被手动重派，SUPERSEDED/REWORK 声明后无任何写路径。并发防护（promise 链）只覆盖 auto 路径，手动派发可绕过并触发裸约束错误。

## ② 设计优点（每条带 file:line）

1. 确定性路由为纯函数：无 LLM、稳定排序 priority DESC/createdAt ASC，依赖缺失不放行 — `route-dispatcher.ts:26-38`
2. 派发错误分类学有显式注释契约：「上方校验=当前不可派（留 DRAFT）；下方环境类=BLOCKED+work.blocked」— `service.ts:557-559`
3. 审计幂等护栏：decision 按 (project, type, argsSha256) 去重 — `service.ts:2126`、`project.repo.ts:690-693`
4. 事件唯一性走 DB 约束：`UNIQUE(project_id,event_key)` + `INSERT OR IGNORE` — `schema.ts:1435`、`project.repo.ts:749,770`
5. attempt 在飞唯一用部分唯一索引兜底；submitProjectRoot 幂等命中后校验归属 — `schema.ts:1352`、`runtime/manager/tasks.ts:181-184`、`task.repo.ts:226-244`
6. 审批决策 CAS + 全副作用同事务 — `service.ts:1063-1109`、`project.repo.ts:848-851`
7. 自批防线：成果提交者不能批准自己的验收 — `service.ts:1056-1059`；提交者身份落 authorUserId — `service.ts:938`
8. write_intent 三重匹配 + 一次性消费 — `service.ts:1851-1899`
9. outbox 语义完整：事务内入队、claim CAS、5s→300s 退避、3 败 dead+升级 — `effects.ts:36,49,61-77`
10. cancelWorkItem 状态迁移+attempt 闭合+审计同事务 — `service.ts:442-454`
11. ingress 未知事件按 fast 兜底；慢路径单飞 mailbox 合并+退避 — `event-ingress.ts:77-108`
12. kernel dead-man sweep；watchdog 告警按小时桶去重 — `kernel.ts:161-167`、`watchdog.ts:95`
13. autoDispatch 链「失败不断链、完成即清理、后到重选」— `service.ts:729-739`
14. 项目完成永不自动：assertCompletionGates + owner 审批双门 — `service.ts:1979-1990`

## ③ 问题 / 风险

| # | Severity | 位置 | 说明 | 建议 |
|---|---|---|---|---|
| 1 | **P1** | `service.ts:574-597` | 派发主链路非原子：attempts.create→await submitProjectRoot→setDispatched→record→wi.update 五步各自独立事务，崩溃中间态→孤儿 live attempt，下次派发撞 `uq_project_attempt_live` 裸约束错并误置 BLOCKED | 先置 DISPATCHING + 预检改查 findLiveByWorkItem + stale attempt 回收 |
| 2 | **P2** | `service.ts:532-537` | 终态不封闭：无终态守卫，COMPLETED/FAILED 可被手动重派；SUPERSEDED/REWORK 声明但全库无写路径 | 入口 state 守卫；删除或实现死声明 |
| 3 | **P2** | `service.ts:510-513,729-739` | 手动派发绕过 autoDispatchChains，与 auto 竞态→裸约束 500/误置 BLOCKED | 手动路径也走链；约束错单独归类 |
| 4 | **P2** | `service.ts:1731-1814` | applyProposal 文档声称 CAS+同事务，实际 markApplied/create/record 无 withTransaction | 包事务；先校验 active 再 markApplied |
| 5 | **P2** | `service.ts:463-503` | createWorkItem 不预检 dedupeKey→裸约束 500 | 与另两路径同口径预检 |
| 6 | **P2** | `route-dispatcher.ts:29` | BLOCKED 无恢复闭环（无 unblock API） | owner unblock API（BLOCKED→DRAFT） |
| 7 | P3 | 7 处 | 「写+record 审计」分离事务，与同事务标准不一致 | 统一 withTransaction |
| 8 | P3 | `kernel.ts:168-171` | setInterval void tick() 无重入守卫 | running 标志或链式 setTimeout |
| 9 | P3 | `reconciler.ts` | 30s Reconciler 不写 HealthBoard 心跳（liveness 盲区） | 补 heartbeat |
| 10 | P3 | `service.ts:607,1160,848` | eventKey 混用固定键与时间戳键；work.blocked 固定键吞同类事件 | eventKey 语义统一 |
| 11 | P3 | `service.ts:840,754-756` | DISPATCHED→RUNNING 无事件；skippedByGate 不可追溯 | 补 work.running 事件 |
| 12 | P3 | `service.ts:747-772` | doAutoDispatch catch 吞错依赖隐式耦合 | 区分已落 BLOCKED 与派发器自身异常 |

## ④ 维度表

| 维度 | 结论 | 关键证据 |
|---|---|---|
| A 单一职责 | 部分 | 外围模块优秀（<190 行单一职责）；service.ts 2311 行混合 7 职责，应拆 agent-surface 与 reconcile-engine |
| B 状态机 | 部分 | 主干封闭；终态可被手动重派击穿；SUPERSEDED/REWORK 不可达；BLOCKED→DRAFT 无路径 |
| C 幂等性 | 部分 | dedupeKey/事件键/attempt 唯一/createOrGetRoot/ensureDraft 幂等；createWorkItem 缺预检、时间戳 eventKey |
| D 事务性 | 部分 | 核心迁移同事务；dispatch 主链路（P1）、applyProposal、7 处写+审计分离为例外 |
| E 并发正确性 | 部分 | promise 链+claim CAS 兜底；kernel tick 无重入守卫；手动/auto 竞态残余窗口 |
| F 错误分类 | 部分 | 显式分界注释+实现一致；attempts.create 约束错被误归环境失败 |
| G 可观测性 | 部分 | 三账本+心跳+退避升级；reconciler 零心跳、RUNNING 无事件 |
| H fail-closed | 符合（主体） | write_intent 三重匹配；未装配即抛；计划未批拒派 |
| I 测试对齐 | 部分 | 7 场景已覆盖；漏并发双 tick/手动+auto 竞态/BLOCKED 恢复/崩溃恢复/幂等重放 |

**最优先修复序**：问题1（P1 原子性）→ 问题2/3（终态守卫+链覆盖）→ 问题4（applyProposal 事务）。
