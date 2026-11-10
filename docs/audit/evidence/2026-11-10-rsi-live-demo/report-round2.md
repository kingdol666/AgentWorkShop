# 全系统设计检查 + RSI/AML/本体/求解器 端到端验收报告（2026-11-10 第二轮）

> 代码版本：`main@89e5f2ba`（v0.11.0）｜ 实例：生产构建 :4201（隔离 AW_HOME）+ 共享 PLC 模拟器 :4010（WWTP 5 协议产线）
> 模型：ustc/deepseek-flash（omp RPC）｜ 证据：`docs/audit/evidence/2026-11-10-rsi-live-demo/`（11 张截图 + 本报告）

---

## 1. 整体执行流程（一条消息的完整生命周期）

```
人类/任务入口
  → POST /channels/:id/tasks ｜ chat/messages（群聊 @）｜ project dispatch
    → submitChannelTask / deliverChatToAgent          （manager/tasks.ts、chat.ts）
    → Mailbox.enqueue（落库 pending + wake）            （mailbox.ts:74-102）
      → ChannelRuntime.route（守卫四类放行）            （channel-runtime.ts:77-118）
        → AgentRuntime.consumeLoop.dequeue（FIFO 阻塞 + 原子 claim）
          → withExecLock(processMessage)              （supervise.ts:157-188 单回合互斥）
            → Session Context 装配（briefOf/formatBriefText，runtime-wiring.ts:99-109）
            → contextPrefix = 场景+身份+工业简报+名册+RSI overlay（base-agent.ts:260-274）
            → memory recall（三层，同产线 +0.2 加分）    （message.ts:89-95）
            → impl.run() = omp RPC prompt              （tools-steer.ts:415-）
              → 事件流 delta/status/artifact/error/done
                → bus.emit → WS agent.delta/block/message（前端聚类渲染）
                → host_tool_call → dispatch 十道防线（身份盖章→write_intent→grant→…）
            → 交付兜底/隐式完成 → taskEngine 终态
              → reflectTaskTerminal（RSI 反射）+ verifyPendingInterventions（C1 补扫）
```

## 2. Mailbox 与 Task 设计（合理性判定：合理，且有实测依据）

**Mailbox**（mailbox.ts）：
- 阻塞 FIFO（dequeue 挂门闩 + 15s 兜底），原子 claim 三方竞争唯一所有权（消费循环/steer/poll_messages）；
- 闭箱不吞信（enqueue false → route 如实报未投递，C-P1-1）；确定性消息 id（崩溃重投幂等）；
- 持久化 pending/consumed + attempts；重启 resetConsuming + outbox 补偿（30s 定时器，5 次死信）；
- 到信回调 onArrival 驱动长轮询毫秒级返回；人类群聊投递不交给 poll（必须回写群聊）。

**Task**（task-engine/）：状态机终态封闭、generation/lease 栅栏、完成闸（父全子终态+交付物+lead 总结）、retry 刷预算、reassignRunning 租约交接、supersede、ROOT_TIMEOUT。容量闸：FIFO 单活跃根/预算四闸/空闲池消费制/空闲卸载五条件。

**已知缺陷（本轮第 2 次实机复现，P1）**：task3 的 deadline 22:13:53 已过 30+ 分钟仍 WORKING——当 lead 监督回合被反复外部取消（本生命周期 2 次 `supervise external cancel`）时，ROOT_TIMEOUT 过期收口不生效。运维面（assignee REST complete）可收口。建议：把过期判定从 lead 监督回合解耦到 tick 本地（不依赖 supervise 返回）。

## 3. 元数据 → 工具注入 / 认证 → 产线业务调用（全链成立）

- **注入**：channels.scenario_prompt/llm_json/workspace/line_id → wireMember configWithCtx → `set_host_tools`（omp）或 MCP 桥 env（CLI 家族，AW_AGENT_ID/TOKEN 注入）。**本轮实测 S2**：频道 A（有 Profile v3）preview=245c 经验+隔离声明；频道 B（同产线无 profile）preview=""=prompt 逐字节零改动。
- **认证**：token 常量时间校验 + 人类作用域（@Agent 不放大权限）+ 过期 client/turn 拒绝 + grant-guard 节点授权 + write_intent 闸。上轮三道闸实机拦截仍然有效。
- **产线调用**：recipe_trial → 三轨授权 → 运行门 → 频控 → HITL → 批准后四元组复核 → 四层限界 → 60s 间隔 → 三级 ACK → 干预台账（invocation 盖章归因）。本轮任务 1/2 的真实 daq_query/line_status 调用返回**真实批次数据**（rr-68953、8184→55083 样本）。

## 4. RSI 越用越聪明（本轮实测：成立）

**S1 持久性 PASS**：平台重启后 Profile v3 active + 全部经验仍在（SQLite 落盘）。
**S2 注入对照 PASS**：A=245c 经验注入 / B=""（零改动）。
**S4 自动沉淀 PASS**：任务 3 终态 → 第 4 条经验（exp:task:738a88f9，candidate，带 taskId）；运维取消任务 4 → **第 5 条 negative 教训**（"未完成：WWTP compliance check l6xq"）——正负两类经验都自动沉淀。
**S3 部分 FAIL（如实）**：任务 3 的真实 LLM 回合本身完成极慢（40+ 分钟未收口，见 §2 缺陷），由运维面收口；这不影响"终态→经验"反射的正确性（反射挂在终态上，与收口方式无关）。
**生命周期全景**（11-rsi-board-final.png）：5 条经验 = 3 任务 + 1 评审 + 1 取消；1 条 validated（人工合并证据）→ pin → Profile v3 active → 注入下一轮。

## 5. AML / 本体 / 求解器 复用架构（审计结论：分层清晰，复用真实存在）

**共享底座（真实复用）**：
- **Python 运行时**：AML `.venv`（uv）被训练作业与求解器 worker **共用**（worker-client.ts:22-25 "复用 AML 共享 .venv,不建第二套环境"；env-lease 读租约防互踩）；
- **进程受控面**：求解器 worker 用 `spawnLineProcess + killHarnessProcess`（与 harness 同一受控 spawn/杀进程面，worker-client.ts:12-13）；
- **数据血缘三元组**：line/product/recipe/run 四元组打标贯穿 TSDB（dataset-builder.ts:157-169 fetchNodeSeries queryTagged）→ 训练数据集 → 模型注册 → 资格报告 → 优化器上下文（context.ts 三元组过滤 + context-segments 按 run 开段/闭段）——**同一份采样数据服务训练、资格判定、优化上下文三条线**；
- ** DCW 运行台账**：`getActiveLineRun` 同时服务写审计、数采打标、优化运行门。

**AML 流水线**：dataset → job（train.py，AMLKit）→ model（ONNX 不可变 + io_spec）→ eligibility（可辨识性/作用域 simulation|real）→ predictor。治理：双审批、模型晋升独立工具（lead-only）。

**本体（ontology/）**：draft→approve→publish 治理链（自审禁止/第二人批准硬约束/发布=不可变快照/乐观锁/发布日志五不变量，ontology.service.ts:1-10）；**本体学习闭环**（ontology-learning.ts）：干预台账 verdict 自动回灌 ontology_evidence（幂等 source_ref=干预 id），三值耦合查询（true/false/null=unknown 不拦）；证据只追加，**版本变更仍走人工链**——学习不越权。

**求解器（optimization/）**：G3 编排 resolve→build→solve→verify→persist→recommend（manager.ts:1-25）：
- ProblemIR 编译带稳定 hash（problem-builder.ts），发布时冻结 hash，求解时比对不符 409（manager.ts:139-141）；
- **资格作用域隔离**：simulation 资格不能解真实线、反之亦然（manager.ts:115-123）；
- 工况漂移拦截：配方版本/工况变化 → CONDITION_CHANGED 409 + 自动失效旧 Profile 计划（:134-137）；
- **独立复算**（A4）：solver 成功后服务端以同一 ProblemIR 独立重算约束与代价——不信任 worker 自述；
- Worker 池：1-4 进程、NDJSON、硬超时、协作取消、崩溃标 interrupted 指数退避补位；
- **首版只产建议不开写权限**（recommendation.service）——建议要落地仍走 recipe_update HITL。
- Agent 工具面（optimizer_solve 等）按绑定裁剪（无优化器绑定的 Agent 该族直接不注入）。

## 6. 端到端测试结果汇总（本轮 + 上轮合并）

| 域 | 结果 |
|---|---|
| RSI 持久性/注入对照/自动沉淀（正+负） | PASS（S1/S2/S4；S3 收口慢系 §2 缺陷） |
| 越用越多 | 经验 1→5 条（3 任务+1 评审+1 取消），1 条 validated→注入 |
| 元层成效 | experience_promote 1/1、profile_promote 6/6、profile_rollback 1（计入 0 成功=回滚语义如实） |
| 三道治理闸（上轮） | PROJECT_WRITE_INTENT_REQUIRED / PROJECT_TASK_SCOPE_VIOLATION / SELF_APPROVAL_FORBIDDEN 全拦截 |
| AML/本体/求解器 | 静态审计通过（复用点/治理不变量/隔离语义均有代码证据）；本轮未跑训练+求解全链（需 eligibility real 报告，列入后续） |

## 7. 遗留与建议

1. **P1（升级证据）**：ROOT_TIMEOUT 不生效复现 + deadline 证据 → 建议将过期判定从 lead 监督回合解耦；
2. 群聊空闲回合唤醒（上轮发现，本轮未复测）；
3. AML 训练+求解 real 全链实机（需造 real 资格报告）列入后续验收；
4. Mimosa 扫描仍 inconclusive → 不宣称项目安全。

**运行现场**：:4201 仍在运行（`.rsi-demo-home`），WWTP 产线继续采样，可直接打开 UI 复核。
