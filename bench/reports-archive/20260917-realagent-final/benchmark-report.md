# AW-IndustrialBench · Consolidated Benchmark Report

> **Overall: ALL LAYERS PASS** · seed 42 · git `2b569a7` · AgentWorkShop v0.7.39
> Generated 2026-09-17T04:54:16.834Z · platform http://127.0.0.1:3001 · simulator http://127.0.0.1:4010

## 1. Results by layer

| Layer | Run ID | Pass | Warn | Fail | Skip | Score | Verdict |
|---|---|---|---|---|---|---|---|
| Static audit (paper–code consistency) | `20260917045341-186k` | 3 | 0 | 0 | 0 | 100.0 / 100 | **PASS** |
| Integrated pipeline (15 phases, real nodes) | `20260917044223-17ho` | 62 | 0 | 0 | 0 | 100 / 100 | **PASS** |
| Real-protocol layer (PLC simulator) | `20260917045058-105w` | 13 | 0 | 0 | 0 | 100.0 / 100 | **PASS** |
| E1a 4-arm governance ablation | `20260917045202-e1lite` | 4 | 0 | 0 | 0 | — | **PASS** |
| Full-system API survey (api-live-e2e) | `console` | 60 | 0 | 0 | 0 | — | **PASS** |

## 2. Real PLC node verification (plc-node-simulator, five protocols)

| Check | Result | Evidence |
|---|---|---|
| plc-0-simulator — Simulator ready + film-line preset | PASS | five-protocol devices: modbus-tcp, modbus-rtu, opcua, mqtt, http |
| plc-1-realpath — Five-protocol real connectivity (exported config → test-driver) | PASS | ✔ modbus-tcp live connect ok (25 ms) · ✔ modbus-rtu live connect ok (19 ms) · ✔ opcua live connect ok (17 ms) · ✔ mqtt live connect ok (16 ms) · ✔ http live connect ok (31 ms) |
| plc-2-closedloop — Real sampling + SP→PV physical closed loop + governed write on the live link | PASS | ✔ real Modbus TCP sampling: 7 points (~895 ms cadence) · ✔ real SP write 182℃ → HTTP 200 (79 ms, incl. Modbus transaction) · ✔ governance on the live link: 5/5 attacks rejected (200/400/150/188.1/175.9), legal 180 accepted · ✔ SP→PV physical closed loop converged to |PV−182|≤3℃ in 27 s (first-order inertia) · governed write 185℃ (read-back verified, register accepted) while PV frozen at 150℃ (out of window)  · ✔ independent monitoring layer raised the recipe-window alarm within 2 s (defense-in-depth: read-back closure does not cover process response) · time-series DB kept sampling during the loop: 27 points total |
| plc-4-fault — Link-fault & recovery drill (real TCP) | PASS | ✔ after the link break the driver failure was sensed by the main app (test-driver ok=false) · ✔ reconnected successfully after simulator restart (test-driver ok=true) |

All traffic in this layer runs over the real protocol stacks of the PLC node simulator (Modbus TCP :16040, Modbus RTU, OPC UA, MQTT, HTTP). The governed write path (SP write → interlock → physical model → DAQ read-back → F5 interdiction → F2 frozen-alarm) is exercised on the live link, not on mocks.

## 3. Closed-loop optimization on the cast-film twin (governed writes)

Offline optimum W* = 89.894 · 3/3 seeds converged · 5 governed writes · 0 rejected · ratio J/J* ∈ [0.968, 0.972] (mean 0.970)

- seed 42: J0 70.023 → Jend 87.105 · J/J* 0.969 · iters 2 · writes 2 · rejected 0
- seed 43: J0 67.81 → Jend 87.366 · J/J* 0.972 · iters 2 · writes 2 · rejected 0
- seed 44: J0 71.185 → Jend 87.002 · J/J* 0.968 · iters 2 · writes 1 · rejected 0

## 3b. AgentTeam optimization mission (task board → time-range data → governed writes → target attained)

A complete agent-team mission runs against a live line: the optimization goal is filed on the team task board and dispatched to the worker; the worker reads the recent acquisition window through its industrial tool surface (`daq_query` with `from/to/bucket` — time-series/Timescale semantics), computes the corrected setpoint, issues governed writes (`dcw_control`, each opening an auditable optimization record that is then judged), waits for the physical process to follow, verifies attainment against the target, and closes the task with a report artifact. The decision policy is deterministic (no LLM credentials required; the LLM variant is the optional P5), but every path it exercises — task board state machine, host tool bridge, governed write path, physical plant, parameter journal — is the production path.

| Mission check | Result |
|---|---|
| Goal filed on the task board and dispatched to the worker | PASS |
| Time-range data read via daq_query (from/to/bucket) | PASS |
| Governed parameter writes, each with an opened and judged record | PASS |
| Parameter journal shows Agent attribution for the writes | PASS |
| Final process value within tolerance of the optimization target | PASS |
| Task closed (lead dispatch → worker scripted completion → parent aggregation) | PASS |

Mission outcome: target 204.704 · final PV 204.6999969482422 · governed writes 1 (≤3) · verdict **ATTAINED**

## 3c. Real-LLM agent closed loop — execution trace (omp)

````
AW-IndustrialBench · P5 real-LLM agent closed loop — execution trace
run: 20260917044223-17ho  harness: omp  provider: zhipu-coding-plan  model: glm-5.3-flash
task: ca5683a0-8e86-4944-872c-43ad373f69f2  line: L1 (modbus-tcp)  dcw: dw-1bd1a976  daq: dn-7a5aa47e  target SP: 197.48
started: 2026-09-17T04:43:09.689Z  wall: 132.344s  final state: COMPLETED  oracle INTEGRATED-CLOSEDLOOP-OK: yes

== task assignment ==
{"id":"ca5683a0-8e86-4944-872c-43ad373f69f2","channelId":"31849153-ecbb-4f63-856c-caee5225b32e","assigneeId":"db66878d-3ab6-431d-aa3e-0145f62a5708","creatorId":"","title":"agentloop-ip16mmpu","state":"COMPLETED","progress":100,"retryCount":0,"artifacts":[{"artifactId":"ab5d1c0b-45a3-4967-92a0-a5716d36a39b","name":"input","parts":[{"text":"Line闭环调优任务（严格按步骤执行）：\n1. 调用 daq_query(node_id=\"dn-7a5aa47e

== channel transcript (chronological) ==
[2026-09-17T12:43:09.705+08:00] ROLE_USER: Line闭环调优任务（严格按步骤执行）：
1. 调用 daq_query(node_id="dn-7a5aa47e") 读取当前过程量;
2. 调用 dcw_control(node_id="dw-1bd1a976", value=197.48, hypothesis="integrated pipeline闭环验证") 下发设定值;
3. 等待 3 秒后再 daq_query(node_id="dn-7a5aa47e") 观察响应;
4. 调用 dcw_judge 落判定 keep 并附一句证据;
5. 交付中必须原样包含标记 INTEGRATED-CLOSEDLOOP-OK，然后调用 complete_task。

== task history ==
[] event: # Default Scenario Brief

(No user scenario is configured for this channel — the platform's general operating rules below apply. A channel owner can override this at any time by setting a custom scenario prompt.)

General operating rules for all team members:

1. Focus on the task objective. Deliver exactly what the task asks; keep outputs concise unless a specific format is requested.
2. Plan before acting: for non-trivial work, decide the steps first, then execute them one by one.
3. Report progress (`report_progress`) at meaningful milestones, and state uncertainties or blockers honestly — never fabricate results.
4. Every deliverable ends with a brief conclusion (2-3 sentences) stating the result and its value.
5. Reuse existing work: check memory and prior deliverables before starting similar work again.

## Your Profile (agent-specific)
你是Line操作员：严格按步骤执行，完成后立即调用 complete_task。

## 产线工况简报(实时;每次回合自动注入)
### 产线「Integrated线1 ip16mmpu」(id=ln-5028f904,光晕色 #41c8f4)
- 工况:**运行中**,批次 rr-38441,产品「Integrated产品1 ip16mmpu」× 配方「Integrated工艺1 ip16mmpu」,已运行 1 分钟,已采集 31 打标样本
- 配方工艺参数: L1-DCW-modbus-tcp ip16mmpu=200℃ 窗口 191.6~208.4℃
- 数采监控窗口(越限即报警): L1-DAQ-modbus-tcp ip16mmpu ∈ [191.6, 208.4]℃
- **当前报警**: L1-DAQ-modbus-tcp ip16mmpu 实时 190℃ 处于报警态(越量程或越配方监控窗口),应优先判读(设定-响应滞后 vs 真实异常)并处置

## 工业调控作业环(你的节点操作方法论,每回合生效)
1. 观察:daq_query 获取绑定节点的真实时序数据(支持按产品/配方/时间窗过滤),结合返回的工况判读理解当前状态。
2. 理解:my_industrial_nodes 读取节点语义卡 —— 物理量含义/单位/安全量程/活动配方工艺窗口/单次调幅步进,以及调控闭环状态(进行中的优化记录/上次良好值/最近判定)。
3. 假设:调参前先声明假设(写入 dcw_control 的 hypothesis 参数)—— 目标值 + 预期效果 + 观察计划;目标必须落在「安全量程 ∩ 活动配方工艺窗口」内,优先小步幅(≤量程 2%)、单向逼近。
4. 设定:dcw_control 下发(自动开优化记录);等待工艺响应(热惯性/传动惯量),勿连续大幅调整。
5. 判定:daq_query 复测窗口数据后,dcw_judge 落判定 —— keep(已验证经验)/ rollback(判应回退)/ uncertain(证据不足)。未判定前再下发,旧记录会被标记 superseded;判定必须引用具体数值与时间窗证据。
6. 回退/保持:判 rollback 后用 dcw_rollback(record_id) 执行回退(判定不自动改 PLC),回退后 daq_query 复测确认恢复;回退冷却期内禁止同向重写。收敛异常时分析根因或上报,而非盲目加码。
7. 复盘:dcw_journal 查看该节点参数变更史与判定结论;keep 的记录是已验证经验,rollback 的记录写进结论修正下次假设 —— 禁止重复已失败的调参方向。
8. 数值口径:工具返回的采集/设定值均为经标定钩子处理后的真实物理量纲;引用数值时带上单位与时间,便于人工复核。

## 优化经验台账(你绑定节点的近期调控结论;避免重复已失败方向)
- L1-DCW-modbus-tcp ip16mmpu:近 9 次调控(keep 6/rollback 1),最近判定 keep(P4b: undo-stack 回退已验证,关闭本记录)

## Team Roster — Channel 成员名册(同 Channel 信箱互通,按 id 直达)
- id: ced8906f-4d39-44b1-917e-98cc8da27b44 | lead-ip16mmpu | role=lead | harness=mock
- id: db66878d-3ab6-431d-aa3e-0145f62a5708 | agent-ip16mmpu ← 你 | role=worker | harness=omp | 擅长: 你是Line操作员：严格按步骤执行，完成后立即调用 complete_task。
协作通信规范:
- 需要某位成员的产出 → send_message_to_agent(to_agent_id=对方id, message=自包含请求(背景+所需+期望格式), require_reply=true, priority=immediate)
- 对方处理后回复会实时注入你的会话;若你正等待回复 → poll_messages(wait_seconds=90) 一次阻塞等待即可,不要反复空轮询
- 回复他人 → send_message_to_agent(to_agent_id=发送者id, message=结果+对方所需内容, in_reply_to=原消息id)
- 寻址:to_agent_id 接受 id 或名字(如 "李四");id 优先,名字同样精确直达。不确定谁擅长什么时,按"擅长"字段选择最合适的成员
- 若发送报"目标成员未命中":错误信息里附有当前最新名册,请改用其中的 id 或名字立即重发一次(名册可能已更新)
- 你的信箱按 FIFO 消费:空闲时下一项自动开始;任务积压情况可用 my_queue 查看

## Workshop System Manual (how this platform works)

- You run INSIDE AgentWorkShop, a multi-agent workshop. You are NOT talking to a human directly — a lead agent coordinates the team; humans observe via a live timeline and may inject messages or answer your `ask` dialogs at any time.
- Task lifecycle: SUBMITTED → ASSIGNED → WORKING → (WAITING) → COMPLETED/FAILED/CANCELED. Use host tools (complete_task etc.) — never claim completion in prose only.
- Anti-duplicate: before re-dispatching work, check Recent Team Mail and completed tasks' deliverables. The platform also REJECTS duplicate child-task titles on the same parent.

### Communication & Your Mailbox (the collaboration medium)

- Every message to you lands in YOUR mailbox, consumed strictly FIFO (oldest first). Task assignments arrive as mailbox messages too.
- When you are idle, your next queued item starts AUTOMATICALLY — never busy-poll for tasks; check `my_queue` to see what is pending.
- Real-time delivery: teammate messages (including replies with in_reply_to) land in your mailbox. If you are inside `poll_messages`, the waiting call returns them within milliseconds (already marked read, with inline reply instructions). If not polling, they start automatically as your next turn. Only urgent HUMAN messages may inject into your running session as `[实时消息 from X]` — handle those inline.
- Waiting for someone's reply? ONE call: `poll_messages(wait_seconds=90)` blocks until it arrives. Do NOT loop empty polls.
- The mail log is the team's shared record: write messages factually and self-contained (the lead reads the full log to judge progress).

### Memory & Modes

- Memory is LAYERED — each injection level has a different purpose:
  - **Session brief (auto-injected, top of every turn)**: a one-glance recap of your recent completions and active team conventions. Maintained by the platform; never re-save it.
  - **Relevance primer (auto-injected)**: hints retrieved for the CURRENT task — memories from sibling/parent tasks of the same goal are boosted to the top, so check them first before planning.
  - **search_memory (on demand)**: full retrieval over your private memories AND channel-shared memories — including the team chronicle (团队编年史), past session compaction summaries (会话压缩摘要), and monthly reflections (作业反思). Search BEFORE starting work that might already have history.
- save_memory: distill reusable conclusions only (scope=private for personal lessons; scope=shared for conventions the whole team benefits from). Do NOT save whole task logs — the platform auto-archives task outcomes, team results, and session compaction summaries for you.
- Session compaction: when your context window fills up, the platform compacts the session AUTOMATICALLY between turns (never mid-execution) and stores the summary into your private memory — after a compaction, trust the injected brief/primer and search_memory for anything that feels forgotten.
- Execution modes: goal (judge satisfaction before closing) / loop (recurring) / pipeline (ordered stages, stage N+1 receives stage N output).
You are "agent-ip16mmpu", a worker agent in a multi-agent team led by a lead coordinator (Channel: 31849153-ecbb-4f63-856c-caee5225b32e).

## Your Assignment

Task ID: ca5683a0-8e86-4944-872c-43ad373f69f2

Line闭环调优任务（严格按步骤执行）：
1. 调用 daq_query(node_id="dn-7a5aa47e") 读取当前过程量;
2. 调用 dcw_control(node_id="dw-1bd1a976", value=197.48, hypothesis="integrated pipeline闭环验证") 下发设定值;
3. 等待 3 秒后再 daq_query(node_id="dn-7a5aa47e") 观察响应;
4. 调用 dcw_judge 落判定 keep 并附一句证据;
5. 交付中必须原样包含标记 INTEGRATED-CLOSEDLOOP-OK，然后调用 complete_task。

## Working Workflow

1. RECALL FIRST: the "相关记忆" block above is only an auto-recalled primer of hints. Before writing anything, call search_memory with focused queries about the task domain (past conclusions, team conventions, similar task outcomes — it searches both your private memory and the channel's shared memory). Reuse proven approaches instead of rediscovering them.
2. SCOPE CHECK before executing: if the task is clearly OUTSIDE your capability or work scope (wrong recipient, unrelated domain, missing prerequisites you cannot obtain), call refuse_task(task_id, reason) immediately — it returns the task to the dispatcher with your reason; do not silently ignore it and do not attempt unrelated work.
3. EXECUTE: use your native tools (read, write, edit, bash, grep, glob, etc.) to accomplish the task. Call report_progress whenever you make meaningful progress. If the task is ambiguous or blocked for long, ASK EARLY — send_message_to_agent to the lead (require_reply=true) instead of guessing or stalling.
4. COLLABORATE: consult the Team Roster above to pick the right specialist by 擅长 (specialty), then send_message_to_agent with a self-contained request (context + what you need + expected format). Waiting for their reply? ONE call: poll_messages(wait_seconds=90) — the reply arrives as that call's result (marked read, with inline reply instructions); reply via send_message_to_agent and include the requested content. Only urgent HUMAN messages appear mid-task as "[实时消息 from ...]" — handle inline and reply the same way.
5. DISTILL: whenever you discover a reusable insight — a working solution, a project convention, a pitfall to avoid — call save_memory IMMEDIATELY (don't wait for task end): scope="private" for personal notes, scope="shared" to publish to the channel's shared memory so teammates benefit. Title = short topic; content = the distilled conclusion. Same dedup_key overwrites instead of duplicating.
6. DELIVER & CONTINUE: call complete_task when done, providing a summary and the deliverable of your work — NEVER declare completion in prose only; the tool result will tell you what remains in your queue. If it reports remaining items, proceed to the next one immediately (it arrives as a task assignment message; execute it with this same workflow). After delivery, your next queued task (if any) starts automatically — FIFO; if idle with an empty queue, stand by: new assignments and realtime messages will reach you on their own.
7. ADDRESSING: when messaging teammates, to_agent_id accepts the roster id OR the teammate's name. If a send fails with "目标成员未命中", the error carries the CURRENT roster — retry immediately using one of those ids/names. Never give up after one addressing failure.

Begin working on the task now.
[] event: 🔧 read(xd://daq_query)
[] event: 🔧 read(xd://dcw_control)
[] event: 🔧 read(xd://dcw_judge)
[] event: 🔧 read(xd://complete_task)
[] event: # daq_query — DAQ Query

从时序数据库检索你绑定的数采节点的历史/实时数据。支持按产线/产品/配方/时间窗/降采样多维过滤(产品/配方过滤基于逐样本打标,可精确取某批次数据);返回结果携带物理含义(参数语义/单位/量程/统计摘要/最近序列)。

## Schema
```ts
type Args = {
  /** 限定单个数采节点 id(缺省 = 全部绑定节点) */
  node_id?: string;
  /** 按产线过滤(数据归属产线) */
  line_id?: string;
  /** 按产品过滤(逐样本打标) */
  product_id?: string;
  /** 按配方/批次过滤(逐样本打标) */
  recipe_id?: string;
  /** 最近 N 分钟(缺省 30) */
  last_minutes?: number;
  /** 起始 epoch ms(与 to_ms 配合,优先于 last_minutes) */
  from_ms?: number;
  /** 结束 epoch ms */
  to_ms?: number;
  /** 时间间隔(降采样桶宽 ms):缺省 15000(15s);可调,下限 1000。不传即用缺省;系统配置变更后以新值为准 */
  bucket_ms?: number;
  /** 返回点数上限(缺省 500) */
  limit?: number;
};
```
Execute by writing JSON to xd://daq_query.
[] event: # dcw_control — DCW Control

对绑定的数控节点下发工艺设定值(真实物理量纲)。仅限你有权控制的节点;设定值会被安全量程与活动配方工艺窗口联锁校验,越窗直接拒绝。手动确认模式下需等待用户批准,用户备注会随结果返回。下发前先调用 my_industrial_nodes 理解节点物理含义。

## Schema
```ts
type Args = {
  /** 数控节点 id(见 my_industrial_nodes) */
  node_id: string;
  /** 目标设定值(真实物理量纲,如 ℃) */
  value: number;
  /** 本次调参假设(入优化记录档案):目标 + 预期效果 + 观察计划,如「提温 1℃ 预期张力上升 2%,5 分钟后复测」 */
  hypothesis?: string;
  /** 关联的优化任务 id(可选,入优化记录档案) */
  task_id?: string;
};
```
Execute by writing JSON to xd://dcw_control.
[] event: # dcw_judge — DCW Judge

对你发起的优化记录(调控 step)落判定。keep=已验证经验(配方可标 lastGood);rollback=判定应回退(判定入册后必须再调 dcw_rollback 执行,判定不自动改 PLC);uncertain=证据不足保持观察。判定必须引用数采证据(daq_query 窗口数据),禁止无证据判定。

## Schema
```ts
type Args = {
  /** 优化记录 id(dcw_control 下发成功后返回) */
  record_id: string;
  /** 判定结论:keep / rollback / uncertain */
  verdict: "keep" | "rollback" | "uncertain";
  /** 判定理由(必须引用具体数值/时间窗证据) */
  reason: string;
};
```
Execute by writing JSON to xd://dcw_judge.
[] event: # complete_task — Complete Task

Mark a task as completed with final deliverables. Workers call this when their assigned task is done. Lead calls this for parent tasks when all children are done.

## Schema
```ts
type Args = {
  /** Summary of what was accomplished */
  summary: string;
  /** Final deliverable: code, analysis result, document content, etc. */
  deliverable?: string;
  /** Task ID to complete. If omitted, completes your current assigned task. */
  task_id?: string;
};
```
Execute by writing JSON to xd://complete_task.
[] event: 工具文档已读。开始执行步骤1：读取当前过程量。
[] event: 🔧 write(xd://daq_query)
[] event: 数采数据查询结果(1 个节点):

■ L1-DAQ-modbus-tcp ip16mmpu(熔体/箱体温度)单位 ℃,正常量程 0~400℃,当前状态 ok,时间窗 2026-09-17T12:13 ~ 2026-09-17T12:43(降采样 15000ms)
  样本 7 点 | 最新 44.65℃ | 均值 157.937 | 最小 44.65 | 最大 199.325
  最近序列: 12:43:45=avg 199.32; 12:43:30=avg 198.36; 12:43:15=avg 195.74; 12:43:00=avg 188.4; 12:42:45=avg 167.23; 12:42:30=avg 111.86; 12:42:15=avg 44.65
  工况判读: 活动配方「Integrated工艺1 ip16mmpu」监控窗口 [191.6, 208.4]:当前 44.65℃ **越限(该节点应已报警)** | 同产线数控设定: L1-DCW-modbus-tcp ip16mmpu=200℃(判读时考虑设定↔实际量的耦合与滞后)

数值均为经标定钩子处理后的真实物理量纲;调整工艺前请结合 my_industrial_nodes 的节点判读方法与操作守则。
[] event: 步骤1完成：12:42:15→12:43:45 序列为 44.65→111.86→167.23→188.4→195.74→198.36→199.32℃，属启动升温爬坡，正向设定值 200℃ 收敛，最近3点均已入窗 [191.6, 208.4]℃。

步骤2：下发设定值 197.48℃。
[] event: 🔧 write(xd://dcw_control)
[] event: 下发成功:L1-DCW-modbus-tcp ip16mmpu(烘箱温度设定)设定 197.48℃ → PLC 原始值 197.48;回读 197.5℃一致。当前活动配方「Integrated工艺1 ip16mmpu」。写入并回读一致:197.48 → raw 197.48,回读 197.5(标定后物理值 197.5)
[调控闭环] 优化记录 opt-419b36e1 已开窗(观察数采后 dcw_judge 落判定);上一稳定锚:200℃(可 dcw_rollback 回退);本节点为自动模式:越配方监控窗将触发系统自动回退
[] event: 下发成功，优化记录 opt-419b36e1 已开窗，回读 197.5℃ 与设定一致。

步骤3：等待 3 秒后复测。
[] event: 🔧 bash(sleep 3)
[] event: (no output)

Wall time: 3.13 seconds
[] event: 🔧 write(xd://daq_query)
[] event: 数采数据查询结果(1 个节点):

■ L1-DAQ-modbus-tcp ip16mmpu(熔体/箱体温度)单位 ℃,正常量程 0~400℃,当前状态 ok,时间窗 2026-09-17T12:39 ~ 2026-09-17T12:44(降采样 1000ms)
  样本 83 点 | 最新 36.8℃ | 均值 176.775 | 最小 36.8 | 最大 200.5
  最近序列: 12:42:41=avg 135.1; 12:42:39=avg 128.2; 12:42:38=avg 123.1; 12:42:37=avg 116.5; 12:42:36=avg 107.8; 12:42:35=avg 102.3; 12:42:34=avg 91; 12:42:32=avg 84; 12:42:31=avg 75.4; 12:42:30=avg 62.4; 12:42:29=avg 52.5; 12:42:27=avg 36.8
  工况判读: 活动配方「Integrated工艺1 ip16mmpu」监控窗口 [191.6, 208.4]:当前 36.8℃ **越限(该节点应已报警)** | 同产线数控设定: L1-DCW-modbus-tcp ip16mmpu=197.5℃(判读时考虑设定↔实际量的耦合与滞后)

数值均为经标定钩子处理后的真实物理量纲;调整工艺前请结合 my_industrial_nodes 的节点判读方法与操作守则。
[] event: 1 秒桶查询返回的序列停在 12:42:41（仍在爬坡段），未见下发后的新样本。换默认 15s 桶、收窄到最近 3 分钟复查最新数据。
[] event: 🔧 write(xd://daq_query)
[] event: 数采数据查询结果(1 个节点):

■ L1-DAQ-modbus-tcp ip16mmpu(熔体/箱体温度)单位 ℃,正常量程 0~400℃,当前状态 ok,时间窗 2026-09-17T12:41 ~ 2026-09-17T12:44(降采样 15000ms)
  样本 10 点 | 最新 44.65℃ | 均值 170.542 | 最小 44.65 | 最大 200.1
  最近序列: 12:44:30=avg 200.1; 12:44:15=avg 200.02; 12:44:00=avg 199.65; 12:43:45=avg 199.41; 12:43:30=avg 198.36; 12:43:15=avg 195.74; 12:43:00=avg 188.4; 12:42:45=avg 167.23; 12:42:30=avg 111.86; 12:42:15=avg 44.65
  工况判读: 活动配方「Integrated工艺1 ip16mmpu」监控窗口 [191.6, 208.4]:当前 44.65℃ **越限(该节点应已报警)** | 同产线数控设定: L1-DCW-modbus-tcp ip16mmpu=197.5℃(判读时考虑设定↔实际量的耦合与滞后)

数值均为经标定钩子处理后的真实物理量纲;调整工艺前请结合 my_industrial_nodes 的节点判读方法与操作守则。
[] event: 复测取得下发后数据：12:43:45=199.41 → 12:44:00=199.65 → 12:44:15=200.02 → 12:44:30=200.1℃，全部落在配方窗口 [191.6, 208.4]℃ 内；工况判读行已确认数控设定=197.5℃（写入生效）。启动爬坡段（12:42:15=44.65℃）已收敛至设定区附近，步幅仅 −1.26℃，热滞后下保持窗口内稳定属预期响应。

步骤4：对 opt-419b36e1 落判定 keep。
[] event: 🔧 write(xd://dcw_judge)
[] event: 判定已入册:记录 opt-419b36e1 → keep(闭环验证通过: 下发 197.48℃ 写入并回读一致(197.5), 下发后 12:43:45~12:44:30 窗口 DAQ 实测 199.41→200.1℃ 全程位于配方监控窗 [191.6, 208.4]℃ 内且无振荡越限, 启动爬坡(12:42:15=44.65℃)已收敛至设定区附近, 小步幅(-1.26℃)下过程保持窗口内稳定, 判 keep)。已定档为已验证经验(配方已标记 lastGood)。
[] event: 🔧 read(xd://report_progress)
[] event: # report_progress — Report Progress

Report your current task progress as a percentage (0-100). Call this whenever you make meaningful progress on your task.

## Schema
```ts
type Args = {
  /** Progress percentage 0-100 */
  progress: number;
  /** Brief status message describing what you are doing */
  message?: string;
};
```
Execute by writing JSON to xd://report_progress.
[] event: Line闭环调优全部步骤完成: daq观察→dcw_control下发197.48→3s后复测→judge keep(opt-419b36e1)
[] event: 🔧 write(xd://report_progress)

````

## 4. Cross-scenario portability (film-line, zero code changes)

Devices 5 · own lines 3/5 · sampling 5/5 · F5 interdicted 9/9 · false blocks 0 · **code changes 0**

## 5. E1a · 4-arm governance ablation (attribution evidence)

| Arm | Interception (per rep) | Window breaches executed | False blocks | Boundary | Write p50 (ms) |
|---|---|---|---|---|---|
| Full (interlock + readback + gate) | 6/6 / 6/6 / 6/6 | 0 | 0 | 9/9 | 125.8 / 125 / 124.8 |
| No interlock | 4/6 / 4/6 / 4/6 | 6 | 0 | 9/9 | 111 / 129.9 / 124.9 |
| No readback | 6/6 / 6/6 / 6/6 | 0 | 0 | 9/9 | 139.7 / 124.8 / 126.1 |
| Ungated (no approval gate) | 4/6 / 4/6 / 4/6 | 6 | 0 | 9/9 | 126.9 / 125.9 / 124.6 |

Reading: interception is provided by the batch-window interlock (Full and No-readback interdict all 6 attacks; removing the interlock lets the two window-class attacks execute and be journaled — attribution ≠ prevention). The hard range is structural: false blocks are 0 in every arm. Latency is statistically indistinguishable across arms.

## 6. Reproducibility matrix (machine verdicts)

| Comparison | Verdict |
|---|---|
| 20260914-baseline-run-e1lite-4arm vs 20260916150036-e1lite | **REPRODUCIBLE** |
| 20260914-baseline-run-plc-fx0 vs 20260916145922-xac | **REPRODUCIBLE** |
| 20260914152838-fwg vs 20260916150300-15ns | **REPRODUCIBLE** |
| 20260914-baseline-run-e1lite-4arm vs 20260916153350-e1lite | **REPRODUCIBLE** |
| 20260914-baseline-run-plc-fx0 vs 20260916153223-vzo | **REPRODUCIBLE** |
| 20260914152838-fwg vs 20260916152242-51c | **REPRODUCIBLE** |
| 20260916150300-15ns vs 20260916152242-51c | **REPRODUCIBLE** |
| 20260914-baseline-run-e1lite-4arm vs 20260917033142-e1lite | **REPRODUCIBLE** |
| 20260914-baseline-run-plc-fx0 vs 20260917033030-wkk | **REPRODUCIBLE** |
| 20260916152242-51c vs 20260917032459-u8o | **REPRODUCIBLE** |
| 20260914-baseline-run-e1lite-4arm vs 20260917042424-e1lite | **REPRODUCIBLE** |
| 20260914-baseline-run-plc-fx0 vs 20260917042326-1fe4 | **REPRODUCIBLE** |
| 20260917041225-1bjc vs 20260917041804-1ahw | **REPRODUCIBLE** |
| 20260914-baseline-run-e1lite-4arm vs 20260917045202-e1lite | **REPRODUCIBLE** |
| 20260914-baseline-run-plc-fx0 vs 20260917045058-105w | **REPRODUCIBLE** |
| 20260917041225-1bjc vs 20260917044223-17ho | **REPRODUCIBLE** |
| Gate selftest (tampered intercept must be rejected) | **PASS** |

Judge-class metrics (interdiction/false-block rates, boundaries, attribution, SP read-back, static anchors, portability composition, ablation outcomes) must be **bit-identical** for a REPRODUCIBLE verdict; environment-class metrics (latencies, sample counts, wall time) are recorded but never gated. See `bench/compare.mjs` for the judge contract.

## 7. Method & environment

- Executed strictly per `bench/PIPELINE.md` §0 execution card: cold boot — the pipeline auto-started both the platform and the PLC simulator from a wiped data root (first-boot self-registration).
- Determinism: all randomness from `--seed 42` (mulberry32); fixtures carry randomized tags; every run lands in `bench/results/<runId>` and is never overwritten.
- Environment caveat: a local proxy client (Clash/mihomo) intermittently saturates the Windows ephemeral port range (~16k TIME_WAIT), causing transient loopback connect failures; the harness absorbs these with bounded exponential-backoff retries. Retries re-read true server state and cannot fabricate results.

## 8. Reproduce

```bash
export NO_PROXY=127.0.0.1,localhost AW_BASE=http://127.0.0.1:3001 AW_BENCH_MODE=1
node bench/pipeline.mjs --profile integrated --seed 42 --cl-seeds 3   # integrated main battle
node bench/run.mjs --tier plc --seed 42                              # real-protocol layer
node bench/e1-lite.mjs --seed 42 --repeats 3                         # 4-arm ablation
node scripts/api-live-e2e.mjs                                        # full API survey
```
