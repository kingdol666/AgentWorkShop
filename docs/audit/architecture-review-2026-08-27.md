# AgentWorkShop 全链路架构审计报告(性能 × 鲁棒性)

- 审计日期:2026-08-27
- 审计方式:三路并行深审(后端运行时 / 前端实时渲染 / 数字孪生+数采)+ 核心文件独立精读交叉验证;所有 [高] 级结论均经二次源码抽查确认属实。
- 用途:作为后续优化实施的总纲,按 F 节路线图逐项落地。

---

## 0. 总体评价

先说做得好的 —— 这些设计应保留,不要在优化中破坏:

- **WS Hub 设计成熟**(server/api/workshop/ws.ts):per-channel 单调 seq + 5000 环形缓冲 + lastSeq 断线续传 + 缓冲窗外快照兜底;HMR 自愈重绑(ensureHubBound)考虑周到。
- **调度器有工程深度**(scheduler-loop.ts):LLM supervise 指纹节流省 token、规则引擎兜底防停滞、HITL 竞态守卫、终态幂等收口、goal 收口宽限窗。
- **数采分层清晰**(server/services/workshop/daq/*):驱动→队列→消费者→TSDB/WS/回写三路分发;单一调度器(非 per-node timer);Timescale 批量 INSERT 是正确范例。
- **协议先行**(shared/workshop-protocol.ts):AEP v1 事件即实体、服务端驱动快照、前后端语义同源。

问题集中在四类**系统性模式**(而非零散 bug),优化时应按模式治理而非逐条打补丁:

| 系统性模式 | 典型位置 | 后果 |
|---|---|---|
| 同步 SQLite 阻塞事件循环 | 全部 repo、ws.publish、调度快照、遥测回写 | 热路径串行化,高频事件时整体卡顿 |
| 无界缓冲遍地 | history_json、tsdbBuffer、WS ring、stderrBuf/stdout/chunk、gltfCache、dbgBubbles、两张时序表 | 长会话内存/磁盘无限增长 → OOM 或磁盘写满 |
| 轮询替代推送 | 调度器 1s 快照、前端 1.5s 设备轮询、150ms HUD 定时器 | 恒定 CPU/DB 底噪,规模线性恶化 |
| 背压缺失 | WS 逐 peer 发送、写库失败静默丢批、MQTT QoS0 | 故障时数据静默丢失且不可见 |

---

## A. 后端:Agent 团队作业与任务下发

### A1 [高] 调度器每秒全量快照,空闲也扫库

- 证据:runtime/scheduler-loop.ts:94 tickMs=1000;:103 setInterval(wake,1000);collectSnapshot(:256-310) 每 tick 执行 taskEngine.list(全渠道任务 :258)+ listChannelAgents(:263)+ **每个成员一次** queueViewOf→listByChannelAssignee(:264)+ 最近邮件查询(:308)。零变化也每秒全量跑。
- 影响:空闲 lead 造成持续 DB/CPU 压力;同步查询阻塞事件循环;频道/成员增多线性恶化。
- 方案:
  1. 快照采集挂事件驱动:任务/成员状态变化即 wake()(决策层已有指纹节流,采集层补同一机制);
  2. 空闲(指纹不变)时 tick 自动退避到 5-10s,有事件立即恢复 1s;
  3. queueViewOf 批量化:一条 SQL 按 channel 聚合全部成员队列视图,消除 O(M) 次查询;
  4. 预计算 parent→children 映射(见 A6)。

### A2 [高] task history/artifacts 每事件整列重写,O(n²) 累积

- 证据:runtime/task-engine.ts:279-342,每个 status 事件 read-modify-write 整个 history_json(:319-321),每个 artifact 重写 artifacts_json(:309);omp-agent.ts 每个 tool_execution_start 都产出 status 事件 → 工具调用越多,每次序列化体积越大。
- 影响:长任务会话 DB 写放大呈平方级;history_json 单行膨胀拖慢所有相关查询。
- 方案:
  1. history/artifacts 拆独立追加表(task_history(task_id, seq, parts_json, at)),只 append 不重写;
  2. 最小改动版:history 设条数上限(如 200 条,超出丢弃最旧,完整流已有 channel_events 承载 —— 它本来就是 append-only);
  3. artifacts 同理改事件流追加,避免整列覆写。

### A3 [高] harness 进程与流式缓冲泄漏(已验证)

- 证据:
  - agents/harness-process.ts:126 用 **spawnSync(taskkill)** 同步阻塞事件循环杀进程树(:11 import,:126 调用);
  - agents/adapters/omp-rpc-client.ts:122-123 stderrBuf 只追加(:205)从不截断;stdout 大行无上限(:331-347);缺失 chunk 的重组缓冲(:139,:443-464)永不清理,base64 大 payload 永久驻留 Map;
  - agents/omp-agent.ts:426-469 supervise 60s 超时后**只 resolve([]) 从不 send abort** —— omp 回合仍在跑,下一个 prompt 与残留回合在同一 client 混流;runtime/agent-runtime.ts:412-420 传入全新 AbortController,外部取消无法传导。
- 方案:
  1. 全部流式缓冲设上限(如 1MB,超限截断并计数);chunk 重组缓冲加 TTL(如 30s)清理;
  2. spawnSync 改异步 spawn + close 回调;
  3. supervise 超时改为真正 send abort 并等 agent_end 再收口;supervise 接口接受 AbortSignal,调度器 cancel 路径能打断 LLM 回合;
  4. 同一 client 保证单 in-flight prompt(排队或拒绝)。

### A4 [中] 调度锁阻塞 lead 信箱消费

- 证据:scheduler-loop.ts:139 runRound 持 lead.execLock 执行 tickRound,内含 supervise 最长 60s;期间 lead 的 processMessage 消费循环停摆,worker 的 child-completed/回执无人处理。
- 方案:分离「调度锁」与「邮箱消费锁」;或 supervise 超时降至 15-20s 并在等待间隙穿插信箱处理;supervise 移出 execLock(决策落地时再拿锁)。

### A5 [中] 重复派发守卫不全

- 证据:manager.ts:1952-1971 有同父同标题判重,但 SchedulerLoop.execute 的 dispatch 分支(:486-509)直通 taskEngine.dispatch 不查重 —— 快照滞后时 LLM 决策与 REST 可各派一个同标题子任务,重复执行烧 token。
- 方案:判重下沉到 TaskEngine.dispatch(parentId+title 唯一性检查或部分唯一索引),所有入口统一遵守。

### A6 [中] 规则引擎 O(N²) 扫描

- 证据:scheduler-loop.ts:324 外层循环内 tasks.some 找子任务;:418/:467 每任务 tasks.filter 全量。
- 方案:每轮 tick 开头构建 Map(parentId → Task[])一次,后续 O(1) 查询。

### A7 [低] 进程退出后 ring/注册表清理滞后

- 证据:agents/harness-terminal.ts:400-410、harness-process.ts:89-96 sweep 要求退出超 10min 且无订阅者才删。
- 方案:进程退出事件即触发清理(无订阅者立即删;有订阅者保留只读视图)。

---

## B. 通信层:WS Hub / 信箱 / 事件协议

### B1 [高] 发布路径:同步落库 + 逐 peer 序列化 + 事件回查

- 证据(api/workshop/ws.ts,已全文精读):
  - publish(:193-238) 对每个非 delta 事件**同步 insert** 阻塞广播;delta 批刷也是逐帧 insert(:181-185);
  - sendEnvelope(:158-166) 对每个 peer **各自 JSON.stringify** 同一信封;无背压、无 per-peer 有界队列;死连接靠 send 抛错兜底;
  - task 事件回调(:324-325) 每个事件再同步 getTaskEngine().get(taskId) 查库,而 assignee/title 完全可在事件源头携带。
- 方案:
  1. 信封一次性 stringify 复用给全部 peer;
  2. task.status 事件携带完整任务字段,删掉 getTaskEngine().get;
  3. 落库统一走「批量事务 + 防抖刷盘」(把现有 delta 400ms 缓冲模式推广到全部事件类型);
  4. 慢 peer 加有界发送队列(如 256 帧),超限断开并由客户端重连快照对齐。

### B2 [高] 常驻录制 + channel_events 无限增长

- 证据:ws.ts:538-542 启动时为全部 channel 建流(无 peer 也常驻 5000 帧 ring,含大 artifact payload);db/channel-event.repo.ts 只有 insert/查询,**无任何保留期清理**(已验证)。
- 方案:
  1. stream 引用计数:首个 peer 订阅才建流订总线,末个退订延时销毁(60s 防抖);
  2. ring 按字节上限(如 4MB/channel);
  3. channel_events 保留期任务(保留 7 天,分批 DELETE,与 D2 共用同一清理设施)。

### B3 [中] 信箱全量扫描(已验证)

- 证据:runtime/mailbox.ts:98 dequeue 用 listPendingByChannelAgent 拉全部 pending 取 rows[0];peek(:121)全量后 slice。
- 方案:WHERE state='pending' ORDER BY created_at LIMIT 1 直接 SQL;idx_messages_queue(channel_id,to_agent_id,state,created_at) 索引已存在,只差查询写法。

### B4 [中] 热查询缺索引

- 证据:db/task.repo.ts:52-54 listByChannelAssignee(channel_id, assignee_id ORDER BY created_at) 无覆盖索引;database.ts:98-99 仅有 (channel_id,state) 与 (assignee_id,state)。
- 方案:加复合索引 (channel_id, assignee_id, state, created_at);按需补 channel_events(channel_id, type)。

### B5 [中] 事件重复消费

- 证据:stores/workshop/entities.ts:260-269 a2a.artifact 收到重放帧会 artifacts+1 —— 断线续传同帧重复计数(events store 有 seq 去重,entities/场景/会话台各自直采没有)。
- 方案:在 useWorkshopWs ingest 一处统一按 seq 去重后分发(单点收口,所有消费方受益);a2a.artifact 计数改为服务端权威值下发而非客户端累加。

### B6 [低] 重连恢复语义

- 证据:stores/workshop/connection.ts:81,89-91 open 时带 lastSeq 重订、首帧即清 pendingReplay;ring 已冲刷时未显式等 channel.snapshot。
- 方案:pendingReplay 清零改为「收到 channel.snapshot 或 seq 连续性确认」后执行。

---

## C. 前端:实时渲染(Three.js 场景 + Vue 壳)

### C1 [高] 渲染循环不知疲倦(已验证)

- 证据:town/TownScene3D.ts 的 this.dirty 被 39 处置位,但 loop() 的 renderer.render()(:3949)**从不读它** —— 静态场景也 60fps 全量渲染;PCFSoft 2048² 阴影每帧重绘(:795-796,959);几乎所有 GLB castShadow(:1429-1431,2624-2626);阴影相机范围大(:3940-3948)。
- 方案:
  1. renderer.shadowMap.autoUpdate = false,仅 dirty 时 needsUpdate = true;mapSize 降至 1024;castShadow 限定关键设备/主角,地面只 receiveShadow;
  2. loop() 读 dirty:dirty || rafAnims.length || 有持续动画(beacon/DAQ LED/脉冲) || autoOrbit 才渲染,否则跳帧(行为 FSM 仍以 5-10Hz 低频跑)。

### C2 [高] GPU 内存持续泄漏(缺乏统一 dispose)

- 证据:resetAll(:3963-3992)/removeChannel(:1694-1724)/removeDeviceNode(:3731-3743)/换装 asp.model.clear()(:1433)/改名重建名牌(:1580-1585)/气泡清理(:2093-2107)只 remove 不 dispose geometry/material/CanvasTexture;gltfCache(:698)与 agentAnimClips(:1452)无界;rebuild() 在每次 channel.snapshot 与布局保存时触发(TownView.vue:942-947,保存一次 rev++ 两次 → 重入两遍全量 GLB 重载)。
- 影响:长会话 GPU 内存只涨不跌,最终渲染崩溃。
- 方案:
  1. 封装 disposeObject3D(root)(遍历释放 geometry + material.map + material,含 CanvasTexture),所有移除路径强制走它;
  2. GLTF/clip 缓存设 LRU 上限(如 20 个),dispose 时清空;
  3. 布局保存改「差异收敛」:只对变化的实体做局部更新,不做整场 resetAll+重载(见 C6)。

### C3 [高] HUD 最大 CPU 热点:150ms 全设备 Box3

- 证据:TownView.vue:2081-2104 miniTimer 每 150ms 调 getDeviceNodes();内部对**每个设备** Box3.setFromObject(dev.holder) 遍历整个 GLB 子树算顶面高度(TownScene3D.ts:3750-3753,2772-2782);callouts computed(:1641)同样调用。
- 方案:topY 在模型加载完成/变换提交时缓存进 DeviceNode 字段,HUD 直接读缓存;全部 HUD 定时器挂 document.visibilitychange,后台标签页暂停。

### C4 [高] 卸载后 window 监听器存活(已验证)

- 证据:TownView.vue:771/784/853/867 用匿名函数注册 window pointermove/pointerup,无法移除;onBeforeUnmount(:2117-2141)只清 interval 与 keydown(:2077/2118 有清理)。离开 /town 后监听仍持有已 dispose 的场景 —— 悬空引用 + 内存泄漏。
- 方案:handler 提为具名引用存组件字段,卸载统一 removeEventListener;scene 内部 canvas 监听在 dispose() 显式移除。

### C5 [中] 每帧无效重建

- 证据:每帧 refreshDaqLinks()(:3886-3888,内部 new Vector3×3 + getPoints(28) + setFromPoints,:3788-3804);每帧 rebuildFilmWeb()(:3893)且签名每帧 map/filter/sort 全设备(:3813-3819);每帧全 Agent mixer 更新无离屏剔除(:3856-3876);screenToWorld/worldToScreen 每调用 new Raycaster/Vector(:2295-2305,2277-2291)。
- 方案:曲线/薄膜网改脏标记重建(端点位移超阈值或设备集 epoch 变化才重建);mixer 按视锥+距离分帧更新;Raycaster 与 Vector 改单例复用。

### C6 [中] Vue 响应式热路径

- 证据:
  1. useSceneLayouts.save 乐观 rev++ 且成功回调又 rev++,一次保存触发两次整场 hydrate(TownView.vue:942-947);
  2. stores/workshop/events.ts:84-110 timeline getter 每次访问过滤整个 5000 项 ring,每 WS 事件全量重算;
  3. daqSim(TownView.vue:1355-1363)每读数帧重建 Map,被 callouts/daqLive/drawTrend 多个 computed 依赖;
  4. watch(characterAssets.models, deep)(:495)深度监听模型数组,任何字段变化触发 syncSceneModels。
- 方案:布局保存走差异收敛 + 节流合并 rev;timeline 按 filter/focus 分桶缓存;daqSim 改单点更新;模型监听改签名对比(id+file)。

### C7 [低] 杂项

- dbgBubbles 无上限(TownScene3D.ts:2033)→ 30 条裁剪;
- historyCache TTL 过期不删(TownView.vue:1134)→ 用 Map 并按时清理;
- 设备 GLB 加载失败静默空 Group(:2629-2631)→ fallback 网格兜底或提示;
- /town 多频道汇聚时 resolveTaskAssignee(:515-518)只按当前 channelId 查 → 改全 channel 查表;未挂载频道不进场景。

---

## D. 数字孪生可视化与数采

### D1 [高] TSDB 链路无背压(已验证)

- 证据:daq/daq-controller.ts:191 tsdbBuffer 裸数组**无上限**;flushTsdb(:201-211)写库失败仅 console.error **整批丢弃**,无重试无计数;队列 10000 上限只管消息队列,不管最终写库侧。
- 方案:
  1. 缓冲上限(如 5000)+ 丢最旧 + 丢弃计数;
  2. 单 in-flight 写(promise 链),写库中不叠写;
  3. 失败保留批做有限重试(3 次);
  4. dropped 改为消费侧真实丢弃数(当前 produced-consumed 在 MQTT 模式下是虚拟值,可能为负)。

### D2 [高] SQLite 逐行写放大 + 无保留期 + latest() 慢查询

- 证据:daq/storage/sqlite.adapter.ts:40-46 每条样本单独 run()(每行一次 WAL fsync);保留期只在启动清一次(:36-38);latest()(:75-78)相关子查询无 ts_ms 索引,随表线性退化。
- 方案:
  1. 批内 BEGIN/COMMIT 单事务 + PRAGMA synchronous=NORMAL(Timescale 侧批量 INSERT 已是正确范例,保留);
  2. 后台 30-60min 周期保留期清理(SQLite 分批 DELETE;Timescale drop_chunks / retention policy);
  3. latest() 改 SELECT node_id, MAX(ts_ms) GROUP BY node_id + (node_id, ts_ms DESC) 索引。

### D3 [高] 设备孪生:全量轮询 + 每帧全文件写盘

- 证据:前端 1.5s 轮询全量 twins 列表(TownView.vue:1264-1275 → useDeviceTwins.load splice 全量替换);applyTelemetry **每次同步写整个 device-twins.json**(device-twin.repo.ts:126-127),采样回写每帧触发(daq-controller.ts:188)→ 每帧一次全文件序列化+fsync;遥测/状态**不走 WS 推送**(仅 device.deleted 广播);useDeviceTwins() 每次调用无条件 load()(:151)。
- 方案:
  1. 遥测回写防抖合并(复用现成的 daq-node.repo.flushDebounced 模式 —— 它已定义但**全仓从未调用**,已验证);
  2. 孪生状态/遥测增 WS 推送(device.updated 增量 patch,走 scene-events 广播通道),前端 1.5s 轮询降级为断线兜底;
  3. store 加 in-flight 去重;GET 支持 ETag/增量。

### D4 [高] 慢驱动叠采 + 串口并发读

- 证据:单调度器 setInterval(sweep, 250)(daq-controller.ts:118)不等待上一轮 async 完成;Modbus 超时 3s(drivers.ts:139)/ OPC UA 4s(:296),一个慢节点即造成并发 sweep;ModbusConn.busy(:115)声明了**从未检测**,并发读同一串行链路易协议错误;lastSampleAt 用扫轮起始时刻(:144)导致慢节点反复叠采。
- 方案:sweep 加 in-flight 互斥(上一轮未完成跳过本轮);连接级启用 busy 互斥;lastSampleAt 改为采样完成时刻。

### D5 [中] 报警与控制健壮性

- deriveState(daq-node.ts:93-99)纯瞬时阈值,无滞回/去抖 → 告警刷屏 → 加滞回带 + 最小驻留(连续 N 帧才切换),alarm 首次触发时间/恢复去抖;
- control.post.ts:18-19 任意 command 直传,未知命令静默成功(device-twin.repo.ts:132-144),无 ack/超时 → 按 twin.controls 白名单校验 + 命令 ack/超时状态机(5s 超时+重试);
- 删除设备不级联解绑 DAQ 节点(device-twins/[id].delete.ts:12-19,靠下次回写失败自愈)→ 删除 handler 遍历解绑 + 广播 daq.node.changed + 清 pendingBackfill;
- rebuildTsdb(storage/index.ts:58-69)换池不关旧 pg Pool → 交换时 old.pool?.end()(给 TsdbPort 加可选 close);MQTT 切换同理 old.client.end();
- MQTT 断连窗口静默丢消息(mqtt.adapter.ts:56-62,QoS0)→ 维护 lost 计数,关键数据 QoS1 + 离线队列(带上限)。

---

## E. 跨领域架构级优化(最高杠杆)

1. **统一异步持久化门面(支点)**:把 DatabaseSync 的同步调用收敛到单一仓储门面后面,热路径(事件/任务/样本)走「批量事务 + 防抖刷盘」。这一项同时缓解 A1/A2/B1/B2/D2 五个高危项,是整个系统性能的支点。
2. **缓冲规约**:一切内存/磁盘缓冲必须有「上限 + 丢弃计数 + 指标暴露」。现存无界点清单:history_json、tsdbBuffer、WS ring、stderrBuf/stdoutBuf/chunkBuffers、gltfCache/agentAnimClips、dbgBubbles、channel_events 表、daq_samples 表、historyCache。
3. **推送优先,轮询兜底**:调度快照(A1)与设备孪生(D3)改事件驱动;前端全部定时器挂 visibilitychange;轮询仅作断线兜底。
4. **可观测性**:dropped/lost/flush-fail/dispose-count 等指标进 /api/system/monitor,让静默丢失变成可见信号。
5. **不变量下沉**:判重(A5)、seq 去重(B5)等一致性守卫收敛到单一入口(TaskEngine.dispatch / useWorkshopWs.ingest),而非散在各调用方。

---

## F. 实施路线图

| 优先级 | 事项 | 对应问题 | 预估工作量 |
|---|---|---|---|
| P0 | 统一 dispose 路径(止住 GPU 泄漏) | C2 | 1 天 |
| P0 | window 监听器清理 | C4 | 0.5 天 |
| P0 | TSDB 背压 + 真实丢弃计数 | D1 | 0.5-1 天 |
| P0 | WS 信封单次序列化 + 删事件回查 | B1 | 0.5 天 |
| P0 | omp 缓冲上限 + supervise 真 abort + spawnSync 异步化 | A3 | 1 天 |
| P1 | 异步持久化门面 + 批量事务(联动 A1/B1/D2) | E1 | 3-5 天,需回归 |
| P1 | history/artifacts 追加表化 + 上限 | A2 | 1-2 天 |
| P1 | 遥测回写防抖 + 孪生 WS 推送 + flushDebounced 接线 | D3 | 2 天 |
| P1 | topY 缓存 + HUD visibilitychange | C3 | 1 天 |
| P1 | sweep 互斥 + 连接互斥 + lastSampleAt 修正 | D4 | 1 天 |
| P1 | dirty 渲染 + 阴影优化 | C1 | 1 天 |
| P1 | 调度快照事件驱动 + tick 退避 + queueView 批量化 | A1 | 2 天 |
| P2 | 索引补齐(B4)、信箱 SQL 化(B3)、判重下沉(A5)、seq 去重收口(B5)、报警滞回(D5)、保留期任务(B2/D2)、LRU 缓存、O(N²)→Map(A6)、心跳单例化、监督锁分离(A4)、C5/C6/C7 | 各项 | 3-4 天 |

**验证基线**:每项完成后必须通过 pnpm lint(0 错误)+ pnpm build(生产构建成功);涉及运行时行为的改动需人工在 /town 与 /workshop 走查「任务下发 → 执行 → 交付」全链路。