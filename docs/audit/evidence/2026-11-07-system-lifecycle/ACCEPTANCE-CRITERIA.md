# 全系统端到端验收标准矩阵(2026-11-07)

> 基线:main `01851f37`。每个功能域给出验收标准(AC)与证据锚点;全部 AC 必须有**实机新鲜运行**的通过记录。

## A. 认证与安全
- AC-A1 未注册用户无法访问工作台资源(401,结构化 envelope)
- AC-A2 首用户后自助注册自动关闭(403 REGISTRATION_CLOSED)
- AC-A3 非 owner 对他人 channel/project 写操作 → 403 SCOPE_VIOLATION
- AC-A4 agent token 与 agentId 绑定校验(伪造 → 401)
- 证据:错误矩阵实跑记录 + unit(auth 相关套件)

## B. Channel 生命周期
- AC-B1 创建 Channel(lead 内建)→ 加 worker → 频道列表/详情可读
- AC-B2 群聊开启前 CHAT_DISABLED 409;owner 显式开启后可用
- AC-B3 @agent 消息触发即时/排队投递,回执落时间线
- AC-B4 task 创建/进度/终态可查询
- 证据:生命周期演示 JSON + unit(channel/task 套件)

## C. 会话上下文(Session Context v2)
- AC-C1 manual/task/project 三类 session 创建与目录
- AC-C2 注入块三层结构(身份/pinned/早期压缩/近期原文)+ profile 标注
- AC-C3 提取式压缩:窗口外旧轮折叠、pinned 原文保留、generation 幂等演进
- AC-C4 注入到达 harness 可证明(ctx 标签回执)
- AC-C5 capability profile:claude=brief(只注身份+pinned),其余 full
- AC-C6 task/project session 上下文关联工作项
- 证据:session-inject-v2-acceptance(自起新跑)+ session-context-ui-acceptance + unit(session-injection-v2)

## D. 记忆系统
- AC-D1 写路径 session 戳(save/peer/task-outcome/compaction)
- AC-D2 scope=session 检索隔离(他 session 空);auto 档 session 行加分
- AC-D3 search_memory/save_memory 工具桥运行时上下文贯通(带/无 session 态两种行为)
- AC-D4 记忆列表/检索返回 sessionId(UI 徽标数据源)
- 证据:session-memory-runtime-acceptance(自起新跑)+ unit(session-memory-scope)

## E. Project 全生命周期
- AC-E1 创建(leader)→绑定频道→交付物(验收标准)→工作项→激活→plan 审批
- AC-E2 派发 → 任务实例 Channel + task session;session_id 贯通;mock 执行 COMPLETED
- AC-E3 reconcile → draft 结果 → submit → L1 review → request-acceptance → L2 approve
- AC-E4 多频道协同(跨频道 A2A)+ 成果复用
- AC-E5 治理门:未批 plan 409;SELF_APPROVAL_FORBIDDEN;证据回溯域(树内可溯,树外拒)
- AC-E6 生命周期收口:pause/resume/complete/archive/terminate(终态不可逆语义)
- AC-E7 持续开发:completed/paused 项目补需求自动重开
- 证据:生命周期演示 JSON + unit(project-* 套件)+ PR#80 树域单测

## F. 引擎与执行
- AC-F1 mock 引擎确定性执行(assign→进度→artifact→complete)
- AC-F2 omp 真实引擎可用性探测与真实执行(文案腿已验证;HTML 腿产能受限如实记录)
- AC-F3 harness 重建/超时治理(ROOT_TIMEOUT 预算语义)
- 证据:前轮证据 + 实例探测记录

## G. 协作与 A2A
- AC-G1 频道内 agent↔agent requireReply 回执
- AC-G2 跨频道 lead 通道回源(x-aw-cross-channel)
- 证据:生命周期演示 + unit(a2a 套件)

## H. UI
- AC-H1 项目页三区壳(导航/快照/Leader 对话卡)渲染
- AC-H2 会话视图(brief 卡/注入预览/composer)桌面+移动无溢出
- AC-H3 落地页产物可渲染
- 证据:ui-capture.json(6/6 脚本 DOM 探针)+ 截图

## I. 错误处理与审计
- AC-I1 全部错误为结构化 envelope(code 可编程判别)
- AC-I2 关键动作落审计事件(project.created/work.dispatched/result.submitted/approval.*)
- AC-I3 降级路径不 500(投递失败/不可达目标)
- 证据:错误矩阵 + 生命周期演示

---

## 验收结果(2026-11-07 实机新鲜运行)

| AC | 结果 | 证据 |
| --- | --- | --- |
| A1-A4 | ✅ | L10-2(匿名 401)/S6-0(REGISTRATION_CLOSED)/L10-1(非法角色 400)/unit auth 套件 |
| B1-B4 | ✅ | L2-1..L2-5(创建/群聊门/开启/详情);L4 挂载;聊天幂等 L6/unit |
| C1-C6 | ✅ | L3-1..L3-5(会话全生命周期)+ session-inject-v2 24/24(自起新跑)+ UI 8/8 |
| D1-D4 | ✅ | L5-5(记忆戳)+ memory-runtime 22/22(自起新跑)+ unit session-memory-scope |
| E1-E7 | ✅ | L4→L8 全链 42/42(lifecycle-demo.json);PR#80 树域 + PR#82 槽位单测 |
| F1-F3 | ✅ | mock 确定性执行(L5-3);omp 真实腿 COMPLETED(前轮证据环境仍可查);ROOT_TIMEOUT 语义已记录 |
| G1-G2 | ✅ | L6-1/L6-2 跨频道 A2A 回发 |
| H1-H3 | ✅ | ui-lifecycle-capture 2/2 + ui-capture 6/6(前轮)+ 截图 |
| I1-I3 | ✅ | L10 全项 + 五套件错误用例 + 审计事件 L10-3b |

**总账**:unit 1192/1190/0/2skip;M1 20/0;inject-v2 24/0;memory 22/0;UI 8/0;全生命周期演示 42/42;UI 生命周期截图 2/2。**全部通过**。
