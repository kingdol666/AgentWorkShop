# 系统自产软件与过程记录盘点（2026-11-05，独立只读代理产出）

「使用 Project→Channel 模式开发的软件」= AgentWorkShop 系统自己通过该模式构建出来的软件工件。
`docs/audit/evidence/` 共约 110 个轮次目录，其中**真正由系统（真 LLM 全链）开发的软件仅 2 件**，
其余均为验收证据/演示报告（约 288 张截图、report.html、结果 JSON、bench 实验）。

## ① 系统自产软件清单

| 路径 | 大小 | 是什么 | 构建方式 | 验证状态 |
|---|---|---|---|---|
| `docs/audit/evidence/2026-11-05-route-demo/landing-page.html` | 12,177 B（R1 版 57,959 B） | 「智塑云·智能注塑云平台」产品落地页 | **Track B 真 LLM Route 闭环**（omp+qwen3.5-9B）：leader 提案→批准→`dispatch_auto` W1(设计)→W2(落地页)，零手动派发 | 浏览器实测桌面 1440+移动 390；人工复核专业级 |
| `docs/audit/evidence/2026-11-03-project-layer/track-b/inventory-system.html` | 3,344 B | 「简易库存管理」单页工具（增删改/localStorage/统计） | **Track B 真 LLM 全链 run7**（leader 真提案→派发→lead 自主执行→成果→验收→completed），`scripts/demo/track-b-mgmt-system.mjs` | 浏览器实测 5/5；过程中发现并修复 3 个真实产品缺陷（PR16/PR18/交付通道） |

未入库/缺口的自产记录：2026-11-04 贪吃蛇落地页工件未落盘（目录仅剩规范）；`.omc/ultragoal/goals.json` 账本不在本 worktree。

## ② 过程记录清单

| 类型 | 位置 | 说明 |
|---|---|---|
| 计划账本 | `docs/plans/` ×30 | 2026-10-21→11-05 全程计划（project-layer v3.0/route-dispatch/live-demo-acceptance/optimizer/security 等） |
| 验收规范+报告 | `2026-11-03-project-layer/ACCEPTANCE.md+SIGNOFF.md`、`2026-11-05-route-demo/ACCEPTANCE.md`、`2026-11-04-project-live-demo/`、`2026-11-03-prod-verify/`、`2026-11-02-e2e-optimization-demo/` | PR1–PR20 验收、R1/R2 演示三轨、生产复验、注塑优化 15/15 |
| 执行事件证据 | route-demo: `track-c-acceptance.json`(25/26)、`track-c-ui-walkthrough.json`(14/14)、`track-d-coordination.json`(10/10)、`track-e-simple-vs-complex.json`(10/10) | 每断言 id/pass/detail + 事件 timeline（dispatch_auto/completed 交错） |
| 内核门禁证据 | `2026-11-03-project-layer/gates/G0–G7` | 5 门 evidence.md + route E2E 70 PASS |
| 实机链路报告 | `2026-11-03-full-acceptance/REPORT.html`(21.6KB)+final-state.json | 注塑实机作业链（孪生→HITL→写穿入带） |
| 论文级实验 | `bench/results/` ×30+ run 目录 | 77/0 流水线、E1–E4 消融、injection-pressure-loop ×3 |
| 展示材料（人工/管线制作，非智能体自产） | `docs/site/public/demo/*.mp4`(×2)、`docs/demo/agentteam-flow/index.html`、`deliverables/BOPET闭环优化架构-最终版.pptx` | 宣传与汇报 |

## 小结

可展示的「系统自己开发的软件」= 落地页 + 库存管理工具（均为真 LLM 全治理链产物、浏览器实测）；
这两个工件的开发过程记录 = track-c-acceptance.json / project-layer track-b 证据 + 对应事件账本与 git 历史（9f93fe04、d452e3b9、36c098fa 等）。
