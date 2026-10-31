# 架构评审:模型能力边界 × 组件生命周期管理质量(基于 2026-10-31 两轮实测 + 代码走查)

**评审范围**:本 session 全部测试结果(协议接入/割接演练/DEMO2 goal/前轮十步阶梯)+ 生命周期核心代码逐文件走查(scheduler-loop/task-engine/agent-runtime/daq-controller/line-spawn)。

---

## 一、deepseek-flash 能否正常执行工具调用与 task 管理?——**能,且本轮是决定性证据**

### 1.1 ustc/deepseek-flash 的实测能力面(全部有台账/任务历史为证)

| 能力 | 实测证据 |
| --- | --- |
| 工具调用纪律 | DEMO2 goal 全程真实调用:line_context → my_industrial_nodes → daq_query(带 run_id 过滤/降采样参数)→ recipe_trial(带 hypothesis)→ diag_run(export_id 多文件)→ kb_agent(async)→ **complete_task**;每次调用返回原文被保留并引用 |
| 任务编排 | 根 5dc07bf8 拆 3 子任务(稳定性诊断重跑/经验沉淀/试验),**主动 CANCELED 无谓的九步阶梯**(知识库判 hold-time 非有效杠杆)——负结果诚实处理而非硬跑 |
| 写治理 | 5 次 hold-time 写全部 ACK 1/1;**自查发现陈旧指令重放**(18:18:51 6.0→6.2 标注"非计划")并如实入交付物 |
| 验收语义 | 独立 1Hz 导出自校验(mean 32.1885/sd 0.0414),不依赖自己 site 的查询结论 |
| 收口 | complete_task 正常闭合(前轮 97% 滞留的边界,**本轮同模型正确处理**) |
| 前轮十步阶梯 | 45→63.0 bar 每步 HITL 审批+回读,KB 增益 0.052g/bar 与物理结果吻合;还利用了操作员手动写做"自然试验"估算增益 |

**弱点(同样有实据)**:lead 曾消费 assign 消息后陷入 poll 循环(依赖 D1 兜底复活,两轮各一次);KB sync 回合长(检索 5-10min);首轮 goal 未自动 complete_task。这些都是**节奏问题而非能力缺陷**,且平台有兜底(D1/预算/人工批准器)。

### 1.2 本地 9B 模型为什么不行(与平台的两层防御)

历史实测(多轮记录):9B 在 126 工具全量注入下**上下文爆掉**(81 工具即撑爆 64k)、工具调用格式纪律差、**虚报成功**(称完成但账本无痕迹)。平台对此有两层正确设计:
1. **不信任模型自报**:task 终态以平台台账(dcw journal/审批单/审计)为准,"弱模型虚报"被结构性拦截——本轮 R-1 事件中在飞诊断被中断也如实记 `failed(Server restarted)`,宁可假红不假绿;
2. **治理面兜底**:监控门拦 9B lead 越工具面(P12 实测)、HITL 默认拒、D1 兜底复活。
结论:**平台让弱模型"安全"但不会让弱模型"能干"**;deepseek-flash 是自主工具作业的最低可用档,9B 只适合观察模式或单工具裁剪场景(平台已提供 selected 工具面/执行模式钳位支持这条路)。

## 二、组件生命周期管理质量(逐组件,带代码锚点)

### 2.1 SchedulerLoop(调度循环)—— **A 级**

`runtime/scheduler-loop/{tick,execute,rules,state}.ts`:
- **预算语义正确**:deadline="执行预算"而非"提交后总时长",入场(dispatch SUBMITTED→WORKING)才刷新预算,排队根豁免过期判定(tick.ts:48-64,注释里是 2026-10-05/06 两次实测缺陷的修复记录)
- **HITL 逐根分流**(tick.ts:81-118):预算耗尽遇待批审批 → 每根最多顺延 3 次,达上限照常收口——修掉了"一张悬空审批单让全平台调度停摆"和"决议落在已死树上"两个实测缺陷
- **陈旧决策防御完备**:execute() 每个决策分支都校验终态/ROOT_TIMEOUT/成员存在性/FIFO 队头准入(execute.ts:57-70),LLM 重复 complete 静默幂等(execute.ts:134-140)
- **资源有界**:状态 Map 每 tick 按活跃任务集修剪(tick.ts:130-143);指纹节流+空闲退避(8s 上限)+事件唤醒打断
- **D1 兜底**(runtime-wiring.ts:360-374):滞留 SUBMITTED>90s 的根 → 幂等复活 lead + 领取提示,10 分钟冷却——本轮两次实测生效

### 2.2 TaskEngine(任务状态机)—— **A 级**

`runtime/task-engine/`:**generation+lease** 双字段(lease.ts:7-11,"与当前 lease 不符的事件=旧 worker 迟到事件,一律丢弃")——这正是 DEMO2 里"陈旧指令重放"能被 Agent 与平台双方识别的结构基础;timeoutTree 整树收口;reassign 撤旧 lease+generation+1+task-local abort(不误杀其它任务,execute.ts:102-112)。

### 2.3 AgentRuntime 生命周期 —— **A−(一处已实测的耦合缺陷)**

`runtime/agent-runtime/lifecycle.ts`:
- **stop() 的审批收敛设计是亮点**:挂起 HITL 审批收敛为**拒绝(绝不自动批准)**+平台通告补送(lifecycle.ts:25-40)——悬空 Promise 问题被结构性消灭
- 宽限等待**有界竞争**(10s race,不无限悬挂,注释引实测 30s×8 教训);dispose 容错;进程存活周期校准(reconcileProcess,休眠/强杀后 alive 失真修正)
- **已实测缺陷(R-1)**:卸载路径(stop→dispose 杀 omp 子进程树)可阻塞事件循环 → 健康探针 3 次失联 → stability-guard 判僵死重启。守护自愈正常(秒级、数据零损),但**"卸载一个 agent"与"平台活性"不应共线**——dispose 应下放 worker 线程或纯异步进程树终止。这是本轮唯一 A 级扣分点。

### 2.4 DAQ Controller(元数据→采集实例)—— **A−(一处热重配缺口)**

`daq/daq-controller/`:
- **节点=独立运行时**(私有节拍,单节点慢/停不波及邻居);250ms sweep 用**轮转游标+在飞预算**(防表尾饿死/防积压雪崩,sweep-alarms.ts:48-58);产线门控(无活动批次不采集)
- **删除级联完整**(crud.ts:114-133):运行时注销→像素对象 GC→告警态清理(注释明说是防内存泄漏)→Agent 绑定级联
- **S10 启动屏障**(降级禁采)、暂停/恢复保 enabled 语义、stopAll 回收被动订阅(防暂停期 MQTT 继续入库)
- **已实测缺口(R-2)**:推送订阅对账 syncPushBindings 指纹重建(push.ts:106-133)设计正确,但 **pushRetryAt 退避跨 driverConfig 变更存续**——订阅失败过的 MQTT 节点在修正配置后仍要等退避到期,实测只能重建节点恢复;轮询路径有"PATCH 即 rearm",推送路径缺等价的"元数据变更清退避"。

### 2.5 Harness 实例化(模板→频道→Agent→进程)—— **B+**

模板 instantiate → channel+4 Agent+调度循环幂等装配(ensureLeadSchedulerLoop)+ lead 预算注入;进程面受控(line-spawn 平台密钥**黑名单清洗**后才注入子进程 env,line-spawn.ts:41-44);monitor 进程注册表+存活校准。
扣分点:**工作区挂载与频道创建解耦**(API 作业正常但 UI 观测需手动建 workspace+mount,本轮实测踩到);**模板 toolProfile 语义有隐雷**(aml_optimization 档静默禁 recipe_trial——治理正确但发现成本高,本轮 e2e-injection 撞了三次才定位)。

### 2.6 横切治理 —— **A 级**

插件工具治理单点(governPluginToolCall:入库守卫/引用面/审计双源共用)、工业写 grant/verify 双闸、HITL 全生命周期(超时默认拒/停止时收敛为拒)、ops 台账全覆盖、平台密钥不进子进程、token 20 枚上限淘汰最老。

## 三、总评

**架构成熟度:8.5/10。** 这是一套**以实测缺陷为养料进化**的系统——代码注释里几乎每个关键分支都标着日期和当初踩的坑(排队根饿死/悬空审批单/暂停期 MQTT 漏采/健忘式告警态泄漏),状态机守卫密集、fail-closed 为缺省、账本为准不信任自报。调度循环与任务引擎是我见过的多 Agent 编排实现里相当扎实的档位。

**三个值得排期的改进**(都有本轮实证):
1. **R-1**:runtime dispose 移出事件循环(worker 线程/异步进程树终止)——消除"卸载=全站活性风险"的耦合;
2. **R-2**:DAQ 推送订阅的元数据变更应清 retry 退避(与轮询路径 rearm 语义对齐),免得热修配置必须重建节点;
3. **模板 toolProfile 档位语义显性化**(频道详情/工具拒绝文案里带"当前档位与如何切换"),降低 AML 档静默禁写的发现成本。

**对用户问题的直接回答**:deepseek-flash **能**正常执行工具调用与 task 管理(本轮 goal 全链+正确 complete_task 为证,弱点是节奏性的且有 D1/预算兜底);9B 本地模型确实不能胜任全量工具面(上下文+格式纪律+虚报),平台用"账本为准+治理门"保证了它至少无害;组件生命周期管理总体达到生产档(两处 A− 缺口已定位到行级,均有兜底不致数据损失),scheduleloop 的作业管理与元数据实例化对象(DAQ 采集/harness 频道)的创建-运行-重配-卸载-级联清理设计**足以支撑受控试点投产**。

*证据锚点:docs/audit/evidence/2026-10-31-demo2/、2026-10-31-proto-accept/、平台台账(dcw-writes 29 行/操作流水/审计);代码锚点见文中 file:line。*
