# 多 Channel 协同与验收机制增强计划（Project 层）

**状态：pending approval**（评审产物，未经批准不实施）
**日期**：2026-11-06
**评审输入**：四专家并行评审（协同架构 / 验收机制 / 会话上下文 / 多智能体编排对标）+ 三项事实核验
**用户目标**：真实产线多团队（工艺/质量/AML/本体）协作完成优化任务；Project Leader 负责路由、交付、审查；Project 模式可选、可模板化新建、持续会话达到 Codex 级 session 体验

---

## 0. 事实核验结论（先行，避免重复建设）

| # | 问题 | 结论 | 锚点 |
|---|---|---|---|
| F1 | Project 模板→新开会话 | **原生不存在**（projects 服务/API 零 template 概念）；现状=手动三步（create→channel-template 实例化→bind）。Channel 模板已可实例化成员 | `server/services/workshop/projects/service.ts`（grep template 零命中） |
| F2 | readiness=technical 建议 | **REST 层已默认实现**：`routingPolicy: body.routingPolicy ?? 'technical'`；但 **service 层默认仍 `'legacy'`（双轨不一致）**，且创建后不可改（updateProject 无此字段） | `server/api/workshop/projects/index.post.ts`；`service.ts:569`；`project.repo.ts:278` |
| F3 | 重开自对账建议 | 状态对账**已多余**：kernel 每 tick（10s）无条件 reconcile+自动派发（延迟上界 ≈1 tick）；但 **Leader 认知对齐仍有价值**——重开后 LLM 上下文不自动刷新，`project_get_status` 应作为 Leader 对话首句惯例 | `projects/kernel.ts` 头注；`tool-surface.ts:25` |
| F4 | 单 Channel 隔离性 | 无 project 上下文时 execution-gate mode=none 仅拦项目工具，普通链路零泄漏（两专家独立确认） | `execution-gate.ts:27-33`；`service.ts:2454-2469` |

**激活硬前提**（模板化的具体形状）：office channel + leadAgentId + ≥1 绑定 Channel + ≥1 必选交付物（`service.ts:617-644`）。

---

## 1. 需求摘要

1. **正确性优先**：先修 8 个已被两专家独立锚点的正确性缺陷（P0），再谈增强
2. **模板化新建**：Project 蓝图一键实例化（对齐"构建好模板→新开会话直接用"）
3. **Codex 级持续会话**：重开即续聊（delta 摘要/resume）、可干预压缩、会话索引
4. **superagent 级协同**：对标 Claude Code subagents / OpenAI Swarm handoff / AutoGen group chat / LangGraph checkpoint·Plan-Execute 的五项缺失能力
5. **验收水密**：对标 IATF/ISO 9001 的不合格品处置闭环与验收人独立性

## 2. P0 —— 正确性修复（8 项，全部带锚点，先做）

| # | 缺陷 | 锚点 | 修复方向 | 验收标准（可测） |
|---|---|---|---|---|
| P0-1 | 提案两段式无补偿：`markApplied` 先于执行体，apply 抛错后 decision 恒 applied、动作丢失 | `service.ts:2828-2831,3230-3234,3289-3312` | 失败回写 `apply_failed` 状态+事件，支持 owner 重放 | 单测：apply 中途抛错 → decision 状态=`apply_failed` → 重放成功后 applied；事件表含 apply_failed 行 |
| P0-2 | legacy 取消传播断链：上游 CANCELED/SUPERSEDED 即放行下游，handoff 只带 reviewed 成果 → 下游空输入盲跑 | `readiness.ts:41`；`service.ts:823-836` | legacy 口径亦要求上游存在 reviewed 成果（无则 BLOCKED+escalate） | 单测：上游 CANCELED+无成果 → 下游 BLOCKED 而非 DISPATCHED |
| P0-3 | 解绑语义未定义：unbind 仅置 detached，在飞项悬挂（worker 403 无法提交、root 仍收敛 COMPLETED） | `service.ts:3760-3767,955-959,2465-2469` | 解绑时：在飞工作项取消/迁移 + root task 取消 + 明确事件 | 单测：解绑后在飞项→CANCELED、root→CANCELED、无 draft 成果残留 |
| P0-4 | 交付物门 `.some` 放行：任一辅助槽 reviewed 即放行下游，主成果可仍 submitted | `readiness.ts:127` | 必选槽（主成果）必须 reviewed/approved 才满足 gateOk | 单测：主成果 submitted+辅助 reviewed → gateOk=false |
| P0-5 | write_intent 消费不绑申请者：同频道其他 lead 可消费他人意图；终态 root 仍可在 24h 内消费 | `service.ts:3373-3392,3479-3495` | 消费端校验 agentId/channelId 匹配 + root 必须 live | 单测：异 agent 消费 → 403；终态 root 消费 → 拒绝 |
| P0-6 | FAST/SLOW 同列竞争：`result.submitted` 先命中 FAST 致慢路径永不触发 | `event-ingress.ts:16,24` | SLOW 类型从 FAST 集合移除或优先级仲裁 | 单测：result.submitted → 恰好一条路径处理 |
| P0-7 | routingPolicy 创建后不可改 + service 默认 legacy（双轨） | `project.repo.ts:278`；`service.ts:569` | updateProject 增加 routingPolicy（走 decision 审批）；service 默认统一 `technical` | 单测：REST/service 两入口创建均默认 technical；变更需 decision 且留痕 |
| P0-8 | 审计脏信号：rework_required 永不清零；L1/L2 决策不复验 sha256；route-dispatcher 遗留 legacy shim 可绕 technical 门 | `project.repo.ts:747,763-765`；`route-dispatcher.ts:22` | pass 时清零+计 reworkCount；决策时重算哈希比对+append events；删除 shim | 单测：返工 pass 后 rework_required=0；哈希不符 → 决策拒绝 |

## 3. P1 —— 功能增强（8 项）

| # | 增强 | 对标来源 | 方案 | 锚点/复用 |
|---|---|---|---|---|
| P1-1 | **Project 蓝图（模板）一键实例化**：plan 骨架 + channel 组合（channel-template 引用）+ routingPolicy + deliverables + office/leader 约定打包为 blueprint JSON；`POST /projects/instantiate` | 用户直接需求；复用 `materializeApprovedPlan` 幂等物化（`service.ts:3552`） | blueprint 存 config_json 或独立 repo 表；实例化=create+按序实例化频道+绑定+激活前校验 | `service.ts:3552`；`channel-templates.ts` |
| P1-2 | **session-resume（Codex resume 对标）**：重开项目/频道时注入 delta 摘要段——consume 未消费事件→LLM 摘要 + 最近 planVersion diff + 中断点；omp sessionId/transcript 持久化 | Codex resume；`client.ts:24` 进程死即丢上下文 | prompt-context 增加 `session-resume` 区块；kernel 慢路径已有事件账本可消费 | `prompt-context.ts:15`；`kernel.ts:86-87` |
| P1-3 | **失败自动 replan 回合**：CONTRACT 失败/BLOCKED 升级时，mailbox 效果改为"强制 leader 结构化 replan 判定回合"；mode=auto 白名单内计划微调免批 | LangGraph Plan-Execute | 不动状态机核心：只改 leader 回合提示词 + route gate 判定 | `kernel.ts` effects；`watchdog.ts` |
| P1-4 | **Worker 澄清回路**：新增 `project_ask_leader`（绑 workItemId + requireReply），回复自动注入该 attempt 下一回合 | Swarm handoff 双向 | worker 现被 `MESSAGE_FORBIDDEN` 禁言——新增单工具白名单豁免 | `tools-steer.ts`；tool-surface |
| P1-5 | **慢路径批次摘要**：mailbox 合并时做批次级摘要替代 200 字截断罗列；修复 `dedupeKey` 含 `Date.now()` 的重复刷屏 | 本项目会话专家 | `lastAssessedSeq` 记录 + 摘要入库 | `service.ts:2854`；`kernel.ts:86-87` |
| P1-6 | **watchdog no_progress 误报修正**：长任务（60min 预算）30min 必误报 → 阈值按预算比例（如 50% 预算无事件才报） | 架构专家 P2 | `watchdog.ts:35,40,58-67` | 单测：60min 预算 45min 无事件才告警 |
| P1-7 | **mailbox 投递吞错修复**：`void` 不 await → await + 失败写 HealthBoard/事件 | 架构专家 P2 | `plugins/workshop.ts:226-232` | 单测：投递失败 → health 心跳降级 |
| P1-8 | **Leader 重开对账惯例固化**：项目页 Leader 对话模板首句 = `project_get_status` 对账指令（零代码，模板改动） | 建议 (b) 保留的"认知对齐"半边 | `prompt-context.ts` leader 模板 | 模板 diff |

## 4. P2 —— superagent 级增值（8 项，按性价比排序）

| # | 增强 | 对标 | 说明 |
|---|---|---|---|
| P2-1 | **trace 合并时间线视图**（一天级收益）：decision/event/approval/message 按 traceId 合并渲染为树 + 回放；API 已有 `projectActivity/traceLookup` | LangSmith | 纯前端聚合 `app/pages/projects/[id].vue`（1515 行五 tab 已有雏形） |
| P2-2 | **多评审辩论协议**：L1 支持多评审员多 verdict + 反驳轮（correlation 串接），全 pass 或 leader 仲裁才置 reviewed；禁止互验对（A 验 B 且 B 验 A 告警）+ leader 验收占比上限 | AutoGen group chat；IATF 审核独立性 | `project.repo.ts` technical_reviews 表已有 correlation 基础 |
| P2-3 | **任务内 checkpoint/续跑**：Channel 回合与 artifact 增量落 attempt 级快照，重试注入"已完成+失败点" | LangGraph checkpointer | 依赖任务引擎改造，随 Router v4 |
| P2-4 | **项目级预算账户 + 跨项目资源锁**：execBudgetMinutes 仅单项 → 项目预算熔断；"一 Channel 仅属一 active 项目"隐式互斥显式化 + 共享资源锁 | 编排对标 | `project.repo.ts:323` |
| P2-5 | **不合格品处置闭环（IATF 8.7）**：返工再提交须引用驳回原因 + 复审冷却；waiver 改带期限让步接收（concession）记录 | ISO 9001 | `service.ts` rework 链 |
| P2-6 | **会话级索引**：自动命名（首回合起题）/按周归档/全文检索 UI | Codex session 列表 | agent_memories FTS 底座已有，缺会话级索引 |
| P2-7 | **手动压缩入口 + 降级告警**：/compact 工具暴露 + 摘要版本入库；context-governance 降级写 HealthBoard | Claude Code /compact | `context-governance.ts:16-17` |
| P2-8 | **write_intent 绑定收紧**（若 P0-5 修复后仍需）：意图与 attemptNo/nonce 全链绑定 | — | 视 P0-5 落地效果 |

## 5. 实施批次建议

- **批次 1（P0，~2-3 天）**：8 项正确性修复，每项一个回归单测；全绿后才进批次 2
- **批次 2（P1，~1 周）**：蓝图模板 + session-resume + replan 回合 + 澄清回路 + watchdog/ingress 修正
- **批次 3（P2，按需排期）**：trace 视图先行（一天级收益）→ 辩论协议 → 其余随 Router v4

## 6. 风险与缓解

| 风险 | 缓解 |
|---|---|
| P0-2/P0-7 收紧 legacy 口径可能破坏存量项目 | 迁移开关：存量项目保持 legacy + 升级公告；新项目强制 technical |
| P1-3 自动 replan 给 leader 放权 | 白名单微调免批（改依赖顺序/参数），结构性变更（增删工作项/换频道）仍需 owner |
| P2-2 多评审增加延迟 | 仅关键交付物（required=1）启用多评审；辅助槽单评审 |
| 蓝图 schema 设计过早起锁 | blueprint 先以 JSON 文档落地（不入表），跑通三个真实场景后再定 schema |

## 7. 总体验证方式

1. **单测**：P0 每项一个回归测试（上表验收标准列全部可测）
2. **api-live**：project 全生命周期脚本（create(technical)→blueprint 实例化→dispatch→submit→L1→waive/返工→L2→complete）71 断言级别扩展
3. **实机试点**：四频道（本体→AML→工艺→质量）technical 全链协作一轮，项目页五 tab + trace 视图人工核验轨迹完整
4. **回归底线**：typecheck ✔ + unit 1140+ 不降 + 无 project 的普通单 Channel 链路（F4 隔离性）零变化
