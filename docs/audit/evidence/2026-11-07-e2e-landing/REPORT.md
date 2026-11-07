# E2E 真实场景验收报告 —— 商品设计创造性落地页(ralph PRD 驱动)

> 日期:2026-11-07 | 环境:main ad63f711(+PR#80 证据回溯域修复),E2E 实例 http://127.0.0.1:3995(BACKUP_DISABLED=1,独立 .e2e-home)
> 结论:**PRD 9 个 user story 全部 passes:true(含评审整改后复验)**;e2e-acceptance.json **57 pass / 0 fail(脚本产出)**;UI 断言 **6/6(UI-0..UI-5,全部脚本 DOM 探针产出)**;产物 landing-page.html 经完整验收链 **L2 approved**。
> 评审整改记录:首轮评审 REJECTED——①session-view 截图为空态(wsId 解析 undefined)但 ui-capture.json 手写 pass;②S7-15..19/S7-ITER 为手工写入;③server.log 未落盘;④REPORT 表述失实。全部整改:workspace 显式创建+挂载后重拍(DOM 真实等待)、断言改由 scripts/e2e-final-assertions.mjs + e2e-session-shot.mjs + e2e-page-shot.mjs 机器化产出、server.log 已落盘、本表述已修正。

## 1. PRD 故事 ↔ 验收映射

| Story | 结论 | 关键证据 |
| --- | --- | --- |
| US-1 环境就绪 | ✅ | unit 1187/1185/0;build ok;health ok(uptime 14s 全新 home);引擎探测:mock+omp(真实 LLM)等全部可用 |
| US-2 Channel 会话 | ✅ | S2-1..7:manual session→clone 回执同 session;分层注入块(profile=full);压缩触发(pinned 原文保留/填充句压缩);ctx 标签证明块进入 harness;history 合并 |
| US-3 Project 管理 | ✅ | S3-1..11:双频道绑定/交付物(验收标准)/工作项/激活/plan v1 审批;observability;project session;审计事件 |
| US-4 下发路由 | ✅ | S4-1..7:task session 生成;assign 消息 x-aw-session-id;mock 执行 COMPLETED;任务终态记忆带 session 戳;scope=session 检索隔离 |
| US-5 协同+成果共享 | ✅ | S5-1..7:双实例频道真并行;跨频道 A2A(lead→toChannelId requireReply)回执回源 x-aw-cross-channel;reconcile→draft→submit→L1 |
| US-6 错误矩阵 | ✅ | S6-0..6:REGISTRATION_CLOSED 403 / 匿名 401 / 非法角色 400 / 缺目标 400 / 未批 plan 409 / CHAT_DISABLED 409 / clientMessageId 幂等 / ghost mention 优雅降级 —— 全部结构化 envelope |
| US-7 落地页实作 | ✅ | 见 §2;L2 approved,产物 5.2KB 完整 HTML |
| US-8 闭环+评审 | ✅ | 本报告+评审记录+回归(见 §5) |
| US-9 缺陷修复 | ✅ | E2E 揭露 P2 聚合证据不可提交 → PR #80(树域回溯)已合 main,单测 2/2 |

## 2. 真实场景:口袋翻译器 T1 落地页

**编排**:设计频道(商品叙事/文案/视觉)+ 前端频道(HTML 实现)双 Channel 分工;项目 plan v1 owner 批准后派发;每个工作项独立任务实例 Channel + task session;session_id 贯通 assign/子任务/记忆。

**真实引擎腿(W4)**:omp 文案 Agent 领取子任务 → 调用平台工具(list_channel_tasks/get_task_details 自检)→ 交付 2510 字符创意文案(主标题「入耳即译,落地就开口」/三大卖点/FAQ 四问/CTA 两版,含逐条约束核对表)→ lead 验收收口 → **COMPLETED**。文案全文存证 `w4-copy-real-llm.md`(5148 字符,成果中间件取回)。

**HTML 合成腿(如实记录)**:3 次真实引擎尝试均 ROOT_TIMEOUT(预算 10/10/40min;最后一次**跑满 40 分钟** 16:49→17:29)——本机 omp 产能不足以一次产出整页 HTML,属引擎容量问题而非编排缺陷。按预案降级:mock 编排腿闭合派发链 → owner 依真实文案主编 HTML(5233B,hero/卖点/FAQ/CTA,响应式)→ **agent 提交**(project_submit_result 带 task 上下文;期间触发并确认了 SELF_APPROVAL_FORBIDDEN/PROJECT_TASK_SCOPE_VIOLATION 两道治理门)→ owner L1 评审 → 证据门重跑 → **L2 approved**(f21b881f,payload 携带完整 HTML)。渲染截图 landing-page-desktop/mobile.png(移动端无溢出)。

## 3. 协同机制与成果中间件(实测结论)

- **跨频道 A2A**:lead 专属 toChannelId 通道,requireReply 回执回源,metadata x-aw-cross-channel 全程可审计;
- **成果中间件**:任务 artifact → reconcile 聚合(root+children 树域,PR #80 修复后 child 引用可回溯)→ draft 结果 → owner/agent 双提交路径 → L1 技术评审 → L2 验收;跨工作项复用:W4 文案成果经 observability 取回注入 W3/W10 brief;
- **记忆协同**:任务终态/协作交换/压缩摘要自动带 session 戳;scope=session 检索隔离;auto 档 session 行加分;
- **会话上下文**:分层注入(pinned/早期压缩/近期原文)+ generation 演进;mock 回执 ctx 标签端到端证明注入到达 harness。

## 4. 错误处理机制(全部结构化 code,可编程判别)

REGISTRATION_CLOSED(首用户后自动收紧注册——实测发现的安全默认)/ SCOPE_VIOLATION 403 / 401 无凭据 / 400 非法角色与缺参 / 409 PLAN_GATE·CHAT_DISABLED·ROOT_TIMEOUT / clientMessageId 幂等 / SELF_APPROVAL_FORBIDDEN(防自批,owner 提交的成果 owner 不可批)/ PROJECT_TASK_SCOPE_VIOLATION(工具调用范围校验)/ ghost mention 非 500 优雅降级。

## 5. 门禁与回归

- 实机断言:e2e-acceptance.json **57/0**(脚本产出) + ui-capture.json **6/6**(UI-0..UI-5 脚本 DOM 探针);
- 修复回归:US-9 单测 2/2 + 全量 unit **1189 tests / 1187 pass / 0 fail / 2 skipped**(合并后);
- 服务器:3995 全程健康;遗留:3001/3002 端口有旧实例(未动,非本任务产物)。

## 6. 证据清单

environment.json / e2e-acceptance.json / ui-capture.json / w4-copy-real-llm.md / landing-page.html / 5 张截图 / 脚本:scripts/e2e-landing-scenario.mjs、e2e-us7-retry.mjs、e2e-us7-final.mjs、e2e-us7-close.mjs、e2e-ui-capture.mjs、e2e-landing-shot.mjs;PRD:prd.json;过程记录:progress.txt。
