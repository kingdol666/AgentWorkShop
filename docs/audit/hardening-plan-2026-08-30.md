# 系统加固计划:硬编码清理 / omp 进程稳定 / 状态驱动 / 资源效率

> 日期:2026-08-30 · 方法:四路并行代码审计(硬编码/omp 生命周期/状态机/资源) → 本计划 → 执行
> 状态标记:✅ 已执行 · 🔜 Phase 2(记录待办)

## 0. 审计总结论

- **主链路合规**:节点语义(节点覆盖>模板>结构化合成)、配方窗口联锁、量程校验、模板注册表全部数据驱动;`database.ts` DEFAULT_* 确认为 INSERT OR IGNORE 幂等种子。
- **omp 稳定性存在 1 个真实泄漏 + 3 个可靠性缺口**(下 A 组),与"进程常驻稳定运行"目标直接冲突。
- **状态机防重基础扎实**(消息原子认领/任务终态封闭/complete 四层幂等),缺口集中在**终态写入不设防**与**入口幂等键缺失**(下 B 组)。
- **资源卫生高于平均**(环形缓冲双封顶/批量落库/空闲退避),真实问题在四个边界(下 C 组)。
- **硬编码残留集中在设备孪生旁路**(下 D 组)。

## A. omp 进程稳定性(用户核心诉求:作业期间不断开/断开重连/团队作业正常)

| # | 问题 | 位置 | 修法 | 状态 |
|---|------|------|------|------|
| A1 | **promptAndStream 事件监听器泄漏**:finally 只解 unsubState,unsub(mapOmpEvent)正常路径不解除 → 每回合泄漏一个闭包+孤儿队列,常驻进程逐回合劣化 | omp-agent.ts(try/finally 与 PROMPT_FAILED 分支) | finally 并列调用 unsub();abort listener 一并移除 | ✅ |
| A2 | **僵死进程(alive-but-wedged)无回收**:PROMPT_FAILED 后 client 不清理,消息重试(≤2 次)复用同一僵死 stdio,每次 60s 超时空转 | omp-agent.ts PROMPT_FAILED 分支 | prompt send 失败(超时形态)→ kill 进程 + 置空 client,下回合 ensureClient 全新重生(host tools/模型/tap 重建链已存在) | ✅ |
| A3 | **peerMessageRun 吞 spawn 失败**:catch{return} 不产出 error 事件 → 消息被 markConsumed,实时消息一次性丢失 | omp-agent.ts peerMessageRun | 对齐 workerRun:spawn 失败 yield OMP_SPAWN_FAILED error → 走消息 requeue(≤2 次) | ✅ |
| A4 | **stopAndDetach 假 ack 丢消息窄窗**:stop() 先关 mailbox 后 detach,窗口内 route 的 enqueue 被静默吞掉但 delivered.push 照常 → 发送方收到成功假象 | manager.ts stopAndDetach | 把成员摘除(detach)提到 runtime.stop() 之前:route 找不到成员 → 返回明确失败 | ✅ |
| A5 | **idle sweeper 120s 卸载杀 omp 进程,且硬编码不可调** | plugins/workshop.ts:121 | intervalMs/graceMs 改由 env(WORKSHOP_IDLE_SWEEP_MS / WORKSHOP_IDLE_GRACE_MS)可调,默认维持 120s;文档说明(busy 成员有 idle+pending+lead 三重守卫,作业期间不会被卸载——"作业期间不断开"由守卫保证,空闲回收可调) | ✅ |
| A6 | supervise 150s 超时仅发 abort 即 finish,残留回合理论上可与下一 prompt 混流 | omp-agent.ts supervise | Phase 2:abort 后等待 agent_end 再收口(带二次超时);当前有 execLock 串行兜底,风险低 | 🔜 |
| A7 | set_model 仅 provider+model 同时配置才生效,只配其一被静默忽略 | omp-agent.ts ensureClient | 任一存在即尝试设置,失败不致命 | ✅ |
| A8 | superviseTimeoutMs 默认注释漂移(写 60000 实为 150s) | omp-agent.ts config 注释 | 修注释 | ✅ |

## B. 状态驱动加固(用户核心诉求:无重复执行,所有执行标记 state)

| # | 问题 | 位置 | 修法 | 状态 |
|---|------|------|------|------|
| B1 | **终态任务被继续写**:report_progress 不校验任务状态,可对 CANCELED/COMPLETED 任务写进度/历史 | manager.ts reportTask | TERMINAL 状态拒绝(409,与 completeTask 同口径);history 封顶 | ✅ |
| B2 | **迟到事件污染终态任务**:applyEvent 的 artifact/status 分支无终态守卫,cancel 后队列里已映射的事件继续追加进 CANCELED 任务 | task-engine.ts applyEvent | artifact/status 分支对终态任务直接忽略 | ✅ |
| B3 | **loop 模式重启后多跑一轮**:loopCompletedTaskIds 纯内存,重启后把重启前已完成的主任务再识别一次并 resubmit | scheduler-loop.ts | checkLoopCompletion 只把 completedAt ≥ 调度器启动时刻的 loop 主任务视为新完成信号 | ✅ |
| B4 | **channel 级任务提交无幂等**:HITL 提交双击/重试 = 两个任务都执行 | manager.ts submitChannelTask | 同 channel 同标题存在非终态任务 → 409(复用 dispatch 判重口径) | ✅ |
| B5 | A2A RPC 30s 超时客户端重试 → 双任务 | a2a rpc | Phase 2:外部提交 idempotency key(messageId dedup);B4 已挡住同标题在途的大部分场景 | 🔜 |
| B6 | assign 已 consuming 时 updateTask/reassign 的双投递窗口 | task-engine | 理论性(同步 sqlite + execLock),仅 lead 且 lead assign 为 no-op;hasPendingAssign 扩展含 consuming 可作 Phase 2 | 🔜 |
| B7 | markConsumed 无状态守卫(依赖 claim 所有权约定) | message.repo | 现有调用点全部持有所有权;加守卫属防御性,Phase 2 | 🔜 |

## C. 资源与效率(按 收益/成本 排序)

| # | 问题 | 位置 | 修法 | 状态 |
|---|------|------|------|------|
| C1 | **WS hub streams 不随 channel 删除回收**:死 stream 的 4MB 环形缓冲永久驻留 + 3s rebind sweep 永远遍历 | ws.ts + manager.removeChannel | hub 导出 closeStream(channelId);removeChannel 回调清理 | ✅ |
| C2 | **OPC UA 会话池无空闲回收**(对照 modbus 池有 sweep) | daq/drivers.ts opcuaPool | 复制 modbus 池 sweep(120s 周期/10min 空闲) | ✅ |
| C3 | **queueViewOf 全历史 JSON 解析**:每次 agent 状态广播把该成员全部历史任务(含大 JSON 列)整行取回,只为计数 | task-engine.ts | 换 META 投影(listByChannelAssigneeMeta + completed 计数) | ✅ |
| C4 | **broadcastSceneEvent per-peer 循环内重复 JSON.stringify**:daq 遥测 N 节点×P 页面/秒 | scene-events.ts | 序列化一次循环外复用 | ✅ |
| C5 | **DCW 保写心跳写放大**:每次 executeWrite(含心跳重下发)全量重写 dcws.json + dcw-writes.json(≤3000 条) | dcw-node.repo / dcw-recipe.repo | 两文件落盘改短窗防抖(崩溃丢失 ≤2s 状态,值可从 PLC 回读恢复,写历史防抖同理) | ✅ |
| C6 | monitor.stop() 漏退订 2/3 事件源 | runtime/monitor.ts | 补退订 | ✅ |
| C7 | scheduler idleSince 不随成员删除修剪 | scheduler-loop.ts | refreshIdle 按在册成员集合修剪 | ✅ |
| C8 | scheduler tick 快照合并(listLite+queueViewsOfLite 双全表扫描)/ a2a waitTerminal 50ms 轮询 / tasks 表终态归档 / ws ring shift O(n) | 多处 | Phase 2(收益温和或有依赖,记录待办) | 🔜 |

## D. 硬编码清理(配置/数据驱动)

| # | 问题 | 位置 | 修法 | 状态 |
|---|------|------|------|------|
| D1 | **TELEMETRY_KEY_OF 查表**:按内置模板 key 映射英文遥测键(与当年 DAQ_SEMANTICS 同构) | daq-controller.ts | DaqTemplateDef 增加可选 `telemetryKey` 数据字段(内置模板声明,自定义模板可配),回写键 = 数据;删除查表 | ✅ |
| D2 | **孪生报警阈值硬编码**:85℃/2.0MPa + temperature/pressure 英文键焊死在 applyTelemetry | device-twin.repo.ts | 回写方向反转:DAQ 回写时透传**节点派生态**(deriveState 已由用户量程/预警带数据驱动);无 state 的直写路径保留 legacy 规则兜底 | ✅ |
| D3 | 设备控制指令 switch(power_on/set_speed…)语义焊死 | device-twin.repo.ts applyControl | Phase 2:controls 升级自描述结构 `{name,argType,desiredKey}` | 🔜 |
| D4 | 内置 DCW/DAQ 模板常量打进前端 bundle + 前端 `?? DAQ_TEMPLATES` 常驻回退 | shared/*, daq/[id].vue, daq/index.vue | 删除两处常驻回退(模板缺失显示 key 原文降级);模板 JSON 种子化 + builtin overlay 为 Phase 2 | 回退删除 ✅ / JSON 化 🔜 |
| D5 | 工业调控作业环文本内嵌 TS(项目已有 prompts 外置机制) | industrial-context.ts | Phase 2:迁 `.AgentWorkShop/prompts/industrial-loop.md`(模板变量已支持);2% 步进系数提常量 | 🔜 |
| D6 | 调参魔法数散落(stallMs/approval 180s/modbus 阈值/tsdb 攒批…) | 多处 | Phase 2:config.yml `workshop:` 调参节接线既有 options 通道(env 先行:DAQ_* 已有先例) | 🔜 |
| D7 | dcw 写回读死区容差公式(0.5×10^-decimals vs 量程 0.5%)为工艺语义缺省 | dcw-runtime.ts | Phase 2:节点级 `writeTolerance` 可覆盖字段 | 🔜 |
| D8 | 3D 传感头形态按模板 key 的 if/else(表现层) | TownScene3D.ts | Phase 2:模板 `visual` 字段 + shape builder 注册表 | 🔜 |

## 执行与验证

- Phase 1 全项(A1-A5/A7/A8,B1-B4,C1-C7,D1/D2/D4 回退)本轮执行。
- 回归矩阵:line-control / agent-tools-audit / agent-workflow-audit / final-line(真实 Modbus) / line-scenario / dcw-audit / transform-audit 全部须 ALL PASS;omp 系(fullchain/final-agent)受 LLM 供应商可用性影响,供应商健康时跑。
- 新增针对性探针:终态写入拒绝 / 同标题幂等 409 / reportTask 终态守卫。
- 每项修复以 文件:行号 落点最小化改动,不做顺带重构。
