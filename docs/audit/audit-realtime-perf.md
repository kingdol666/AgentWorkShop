# 实时数据链路 · 算法与架构审计

> 审计范围:DAQ 采集 → 队列 → TSDB → WS → 前端渲染;DCW 写控制与回退账本;跨切面架构。
> 方法:静态通读 + 定点 grep 验证 + 少量 `node -e` 量化实验(载荷/序列化字节数与耗时)。
> 未运行应用、未做浏览器 profile。所有结论均给出 `文件:行号` 与代码引用;无法确证的条目集中在 §5。
> 现场规模取代码自述值:数采节点 282 个(`server/services/workshop/daq/daq-controller.ts:127-130`)、
> 场景条目 227 个(`app/components/workshop/town/TownView.vue:1578`);实际部署可能不同。

## 0. 结论摘要(3-5 条最重要的)

| ID | 级别 | 一句话 |
|----|------|--------|
| F1-1 | **P0** | 控制台每个 WS 帧对整条 ring(≤5000)做全量过滤,且**每条 lane 各做一遍**:`O(L×R)`/帧,随会话时长线性劣化 |
| F2-1 | **P0** | `DaqController.frames()` 对攒批缓冲做「过滤后再逐行全扫」的双重扫描:缓冲满时单次 REST 请求 ≈ 4×10⁶ 次迭代 |
| F1-3 | P1 | 前端 5s 全量快照轮询:DAQ 单次响应实测 **166.5 KB/282 节点**;仪表盘还以 5s 拉取 DCW 全量并**整体替换**全部节点对象 |
| F1-2 | P1 | `AwChart` 每次更新都产生新 option 引用 → vue-echarts 以 `notMerge: true` **整图重建**(且 watcher `deep: true`) |
| F3-1 | P1 | DCW 回退账本每次防抖落盘是**整库 pretty-print 序列化**:实测 20000 锚 + 2000 记录 = **8.57 MB / 23 ms** 同步 CPU,跑在控制链路的同一事件循环上 |

其余 P1:F1-4(150ms HUD 节拍内 `O(节点数×场景数)` 两处 `find`)、F1-5(空载产线导致 WS 每 ~90s 强制重连)、F2-2(队列/离线缓冲按**条数**封顶,而单封套可达 37 KB)、F3-2(回退仓库若干按次全扫)。P2 见各节。

---

## 1. 前端实时渲染

### F1-1 [P0] 时间线/lane 每帧全量重过滤:`O(L×R)` per frame

**位置**:`app/composables/workshop/useClusteredBlocks.ts:67-75`、`app/stores/workshop/events.ts:115-128`、`app/components/workshop/lanes/LaneBlocks.vue:28-35`、`app/components/workshop/AgentLanesView.vue:331,450-453`

**现状**:`ring.items` 是数组原地 `push`(`app/stores/workshop/events.ts:160`),因此任何 `push` 都会让下面两个 computed 失效并**整段重算**:

```ts
// useClusteredBlocks.ts:67-75
const list = computed(() => {
  if (opts.raw) return cid.value ? events.ring(cid.value).items : []   // raw lane:原数组
  return cid.value ? events.timeline(cid.value) : []                    // 时间线:全量过滤
})
const source = computed(() => {
  void resetKeyVal.value
  return predRaw.value ? list.value.filter(predRaw.value) : list.value  // 又一次全量遍历
})
```

`events.timeline` 的记忆化**每帧必然失效**——key 含 `ring.lastSeq`,而 `lastSeq` 每帧递增(`useClusteredBlocks.ts:137` 的 `watch(source, …)` 因此每帧触发):

```ts
// events.ts:121
const memoKey = `${filter}:${focus ?? ''}:${ring.lastSeq}:${ring.items.length}`
```

关键是 lane:`AgentLanesView.vue:331` 用 `v-for="a in agents"` 为**每个成员**挂一个 `LaneBlocks`(无 `v-if` 收敛),每个实例各自持有一个 `BlockClusterer`,并以 `raw: true` + `agentId` 谓词消费同一个 ring(`LaneBlocks.vue:31-33`)。

**规模代价**:设成员数 L、ring 长度 R(上限 `RING_CAP = 5000`,`events.ts:10`)。每来一个帧(lane 场景 `agent.delta` 可达数十帧/秒):
- `LaneBlocks`:L × R 次谓词调用 + L 个新数组;
- `TranscriptTimeline`(`TranscriptTimeline.vue:32`):再 +1 × R 次过滤 + 1 个 ≤R 的新数组。

取 L=8、R=2000、30 帧/s:≈ 8×2000×30 = **4.8×10⁵ 次谓词调用/秒**,外加 ~240 次数组分配/秒;R 逼近 5000 时线性再翻 2.5 倍。这条路径的耗时**随会话时长增长**(ring 是滚动窗口,越久越满),是典型的「越看越卡」。

**修复**:ring 是 append-only(仅头部淘汰),把过滤结果做成增量缓存:ingest 时对每个活跃消费者(或按 `agentId` 分桶)判定一次并 `push` 进已授权的结果数组,头部淘汰时同拍出队 → **每帧 O(1) 摊销**,仅在 ring 重新对齐/过滤切换时 O(R) 重建。lane 用 `Map<agentId, AepEnvelope[]>` 索引替代谓词扫描。

### F1-2 [P1] `AwChart` 每次更新走 `notMerge: true` 整图重建

**位置**:`app/components/AwChart.vue:45-56`、`node_modules/vue-echarts/dist/index.js:302-319`(7.0.3)

**现状**:`AwChart` 把外部 option 包一层 computed,**每次求值都是新对象**:

```ts
// AwChart.vue:45-48
const merged = computed<EChartsOption>(() => ({ color: EDITORIAL_PALETTE, ...props.option }))
```

vue-echarts 7.0.3 的语义恰好把「新引用」判为全量替换:

```js
// vue-echarts/dist/index.js:310-318
chart.value.setOption(option, { notMerge: option !== oldOption, ...realUpdateOptions.value })
}, { deep: true })
```

即 `merged` 引用变化 → `notMerge: true` → ECharts 丢弃并重建 series/axis/legend;且 `deep: true` 让 Vue 在每次 option 变化时**深遍历整棵 option 树**(含各 series 的 `data` 数组)收集依赖。

**规模代价**:仪表盘 `trendOpt`(`app/pages/index.vue:101-138`)依赖 `trendNodes`(`index.vue:74-77` 读取每个节点的 `value/min/max/lineId`),因此**每次读数合批(≈2 次/秒)就重建一次趋势图**;`pipelineOpt/nodeStateOpt/lineStateOpt` 随 5s 快照轮询重建。当前 series 仅 4×36 点,单次重建约 1–3 ms,总量可控;但 `notMerge: true` 使「追加窗口/加大点数」的任何后续改动直接线性放大代价。

**修复**:使 option 引用语义与更新语义一致——在页面侧用 `shallowRef` + 原地改 `series[i].data`(mutation 会被 vue-echarts 判为 `notMerge: false`,走增量合并),或给 `<VChart>` 传 `:update-options="{ notMerge: false, lazyUpdate: true }"`;`AwChart` 的包装 computed 应改为不产生新引用的实现(如 `toRaw` 复用 / `markRaw`)。趋势窗口拉长时改用 ECharts `appendData`。

### F1-3 [P1] 5s 全量快照轮询:daq 166.5 KB/次,dcw 全量对象整体替换

**位置**:`app/pages/daq/index.vue:76-82`、`app/pages/index.vue:39-44`、`app/composables/workshop/useDaqStream.ts:267-302`、`app/composables/workshop/useDcwStream.ts:113-134`

**现状**:DAQ 页每 5s 调 `daq.load()`(另加 15s `dcw.load()`);仪表盘每 5s **同时** `daq.load() + dcw.load() + loadHarnesses()`,后台降频到 30s。

```ts
// useDaqStream.ts:286-290 — 无论是否变化,整表重排 + 索引重建 + 帧缓冲清理
nodes.splice(0, nodes.length, ...next)
rebuildIndex()
for (const k of Object.keys(frames)) { if (!nodeIndex.has(k)) Reflect.deleteProperty(frames, k) }
```

```ts
// useDcwStream.ts:116-127 — DCW 侧不做身份合并,每个节点对象每次轮询都被替换
nodes.splice(0, nodes.length, ...data.nodes)
nodeIndex.clear()
for (const n of nodes) nodeIndex.set(n.id, n)
…
for (const k of Object.keys(lineStates)) Reflect.deleteProperty(lineStates, k)
for (const st of data.lineStates ?? []) lineStates[st.lineId] = st
```

**规模代价**(实测):按 `DaqNodeView` 24 字段合成 282 节点,`GET /api/workshop/daq` 响应体 = **166.5 KB** → 5s 一次 = **33 KB/s / 2.9 GB·天**·每个打开的页签;另有一次 `/alarms` 轮询。`GET /api/workshop/dcw` 返回全部 lines/recipes/runs/products/history/lineStates(代码自述「95+ 线/配方/历史 是重载荷」),`dcw.load()` 每次重新分配全部节点对象:所有持有节点引用的组件、`dcw.lineStateOf` 的 `lineStates` 键全量失效 → 一次「全表 patch」。DAQ 侧因为保留对象身份(`useDaqStream.ts:272-284`)只触发字段级 patch,但仍整表重排数组并清理 `frames`。

**修复**:轮询改为条件拉取/增量拉取——带 `If-None-Match`/版本号或 `?since=` 只回传变更节点;`nodes.splice` 改为按键 diff(复用身份,不触碰未变节点);`lineStates` 键值就地合并而非 delete+set;5s 节拍在无活动产线时可放宽到 30s。

### F1-4 [P1] 150ms HUD 节拍内的 `O(数采节点 × 场景节点)` 两处 `find`

**位置**:`app/components/workshop/town/TownView.vue:2749-2772`、`app/components/workshop/town/TownView.vue:2263-2280`

**现状**:`miniTick`(150ms 定时器,`TownView.vue:2822`)对每个数采孪生做一次线性 `find`:

```ts
// TownView.vue:2762-2766
for (const t of daqTwins.value) {
  const boundDev = boundDeviceOf(t.id)
  const anchor = boundDev ? nodes.find(n => n.twinId === boundDev) : nodes.find(n => n.twinId === t.id)
```

`nodes = s3.getDeviceNodes()`(`TownScene3D.ts:3059-3069`)每次调用都**复制并映射**整个场景设备表;`callouts` computed(`TownView.vue:2263-2280`)内是同一段 `O(T×S)` 模式,而它的依赖含 `camPose`/`calloutPos`(均在 `miniTick` 内每 150ms 更新)→ 同一代价每拍再付一次。

**规模代价**:T=282 数采孪生、S≈300 场景节点 → 单次 ≈ 8.5×10⁴ 次比较,6.7 拍/s → **≈ 1.1×10⁶ 次比较/秒**,外加每拍 `getDeviceNodes()` 的一次 300 元素数组分配。

**修复**:每拍(或每变更)构建一次 `Map<twinId, {x,z,topY,name}>`,两处 `find` 降为 `Map.get` → 每拍 `O(T+S)`,比较次数降 2 个数量级。

### F1-5 [P1] 空载产线时 WS 每 ~90s 强制重连一次

**位置**:`app/stores/workshop/connection.ts:18,76,116-121`、`app/composables/workshop/useWorkshopWs.ts:66-77`

**现状**:连接建立时把两个时钟都置为当前(`connection.ts:75-76`),随后只要有 pong 但**没有数据帧**超过 `DATA_STALE_MS = 90_000` 就主动断开:

```ts
// connection.ts:119-120
if (Date.now() - this.lastFrameAt > STALE_MS) ws.close()
else if (Date.now() - this.lastDataAt > DATA_STALE_MS) ws.close()
```

而服务端在**没有任何产线开跑**时根本不产生读数帧——采集 sweep 第一道门就是活动批次:

```ts
// server/services/workshop/daq/daq-controller.ts:481-482
const host = getDaqHostPorts()
if (!host || !host.lineRun.hasAnyActiveRun()) return
```

停线是工业现场的常态(且 DAQ/DCW 页面本身只订阅场景帧)。

**后果**:每个打开的页签在停线期间每 ~90–100s(90s 阈值 + ≤10s 退避)被强制关闭并重连;重连触发 `onPendingReplay`(`useWorkshopWs.ts:72` → `conn.pendingReplay = true`),AppHeader 的连接点由「实时」翻转成「同步中」(`app/components/AppHeader.vue:151-155`),同时服务端对已订阅 channel 重发快照/重放(`server/api/workshop/ws.ts:625-643`)。代码注释本身写明该阈值是为了「避免健康空闲连接被反复重连」(`connection.ts:15-16`),但 90s 并不能区分「空闲」与「停线」。

**修复**:把数据级失联检测限定在「**曾经有过数据流** 且现在断了」的语义上——例如记录 `hadDataSinceOpen`,或由服务端在 `daq.controller` 帧里下发 `expectingData`(有活动批次/有订阅的活跃 channel)后再启用该判据;空载期间只保留 `STALE_MS` 的 pong 级检测。

### F1-6 [P2] WS 帧逐帧 `JSON.parse` + 同步分发,无 rAF/可见性合批

**位置**:`app/stores/workshop/connection.ts:83-95`、`app/composables/workshop/useDaqStream.ts:140-171`、`app/composables/workshop/useVisibleInterval.ts:1-42`

**现状**:`ws.onmessage` 每帧一次 `JSON.parse` 并**同步**走完整条 ingest 链(`events.ingest → entities.applyEvent → conn.cursors 写 → townBus.emit`);只有 DAQ 读数在 store 层用 500ms `setTimeout` 合批(`useDaqStream.ts:142-171`),`useVisibleInterval` 只管 REST 轮询,WS 在后台标签页仍全速消费。

**规模代价**:282 节点 × 1 Hz = 282 帧/s,每帧 ≈ 228 字节(实测 `daq.reading` 封套),≈ 64 KB/s/页签;解析+分发的量级是每帧几微秒,合批后失效频率被压到 2 Hz,当前可接受。风险在隐藏页签:后台定时器被浏览器钳制(Chrome 密集节流可到 1 次/分钟),500ms 合批窗会退化成分钟级批,单批最多 ~17k 条读数(有界但会造成一次大抖动)。

**修复**:`applyReading` 在 `document.hidden` 时只保留每节点最新值(丢弃中间帧,趋势允许缺口)或直接跳过入批;`visibilitychange` 回前台时补一拍。取帧链路可顺带做一次 rAF 合批,让解析与渲染同拍。

### F1-7 [P2] `deviceTwins.byId()` 读的是原始数组:模板内既无响应性又是 `O(T)`

**位置**:`app/composables/workshop/useDeviceTwins.ts:66-107,141-146`、`app/components/workshop/town/TownView.vue:3077,3162`

**现状**:store 的 `twins` 是 `reactive()` 包装后的数组,但 `byId` 闭包捕获的是**原始**数组:

```ts
const twins: DeviceTwinView[] = []
const store: DeviceTwinStore = reactive({ twins, … })
…
byId(id) { return twins.find(t => t.id === id) },   // 原始数组:不追踪、非代理
```

模板里直接调用(`TownView.vue:3077`、`3162`,`v-for` 行内),即渲染副作用里读原始数组 → 既不在依赖里,也不随设备改名/新增而更新(只在别的依赖把子树弄脏时被动「自愈」);同时每行一次 `O(T)` 线性查找。

**修复**:`byId` 改为读 `store.twins`(保持响应式追踪)并在 store 内部维护 `Map<id, twin>` 索引;模板改为消费预计算的 `Map`/computed。

### F1-8 [P2] `timelineCache` 是模块级 Map,`clear()` 不清理

**位置**:`app/stores/workshop/events.ts:59-60,124-126,287-290`

`timelineCache.set(channelId, { key, result })` 保存的是过滤后的**数组引用**(最多 5000 项);`clear(channelId)` 只删 `rings/laneLoaded`,不删该缓存 → 访问过的每个 channel 都长期驻留一份 ≤5000 引用的数组(约 40 KB/频道),且这些 envelope 因此无法随 ring 回收。修复:`clear()` 内一并 `timelineCache.delete(channelId)`,或把缓存收敛进 ring 生命周期。

---

## 2. 后端管线

### F2-1 [P0] `DaqController.frames()`:攒批缓冲上的双重扫描 `O(k·n)`

**位置**:`server/services/workshop/daq/daq-controller.ts:860-876` + `832-850`

```ts
// 860-875
const rows = await getTsdb().queryFrames(id, opts)
const seen = new Set(rows.map(r => r.at))
const pending = this.frameBuffer.filter(r => r.nodeId === id && …)      // ① 全缓冲扫描(≤2000)
  .filter(r => !seen.has(r.tsMs))
  .sort((a, b) => b.tsMs - a.tsMs)
  .map(r => this.framesFromBuffer(id, r.tsMs)[0] ?? null)                // ② 每个待补帧再全扫一遍
  .filter((r): r is DaqFrameRecord => r != null)
```

`framesFromBuffer` 自身是整缓冲线性扫描并**为每次命中构造一个完整 `DaqFrameRecord`**:

```ts
// 832-848
for (const r of this.frameBuffer) {
  if (r.nodeId !== id || r.tsMs !== tsMs) continue
  out.push({ at: r.tsMs, kind: r.kind, points: …, metrics: r.metrics, meta: r.meta, … })
}
```

**规模代价**:`FRAME_BUFFER_CAP = 2000`(`daq-controller.ts:114`)。当 TSDB 写入变慢(正是这些上限被设计出来应对的场景:SQLite 写锁/保留期清理/备份),缓冲被填满后,单次 `GET /:id/frames` 的 ② 步是 2000 × 2000 = **4×10⁶ 次迭代** + 最多 2000 个记录对象分配,全部同步阻塞在跑着 250ms 采样 sweep(`:202`)与 500ms 写控制 sweep(`dcw-controller.ts:92`)的同一事件循环上。

**修复**:一次遍历建索引 `Map<tsMs, DaqFrameRow>`(只对目标 nodeId 的 pending 行),再按 key 取值补齐 → `O(n)`;顺带可把 `FRAME_BUFFER_CAP` 改成按字节(见 F2-2)。

### F2-2 [P1] 队列/离线缓冲按「条数」封顶,而单个封套可达 37 KB

**位置**:`server/services/workshop/daq/bus/inproc.adapter.ts:11,33-39`、`server/services/workshop/daq/bus/mqtt.adapter.ts:26,91-103`、`server/services/workshop/daq/daq-runtime.ts:118-124`

**现状**:vector 模板的完整点列(≤4096,`daq-controller.ts:280` 的 `slice(0, 4096)`)随封套一起进队列;两个缓冲都只按条数封顶:

```ts
// inproc.adapter.ts:33-39   QUEUE_CAP = 10_000
if (this.queue.length >= QUEUE_CAP) { this.queue.shift(); this.dropped++ }
this.queue.push(env)
```

```ts
// mqtt.adapter.ts:94-98   OFFLINE_CAP = 2000
if (this.offline.length >= OFFLINE_CAP) { this.offline.shift(); this.lostCount++ }
```

**规模代价**(实测):4096 点 vector 封套 = **36 988 字节**。理论上限:进程内队列 10000 × 37 KB ≈ **370 MB**;MQTT 离线缓冲 2000 × 37 KB ≈ **74 MB**。触发条件是事件循环被长时间阻塞(与 MQTT 断连窗口),50 个 vector 节点 × 1 Hz 时约 200s 即可填满。另外队列饱和时 `shift()` 是 `O(n)` 搬移(10000 元素/次发布)。

**修复**:改为**字节预算**(如 32 MB)+ 计数双封顶;或封套只带降采样预览(WS 已用 `previewOf` 截到 64 点,`:468-475`),完整点列走对象存储/REST 引用——这样单封套从 37 KB 降到 ~1 KB,缓冲上限的物理意义才成立。

### F2-3 [P1] 场景广播绕过慢消费者字节预算

**位置**:`server/api/workshop/ws.ts:187-214`(有预算)vs `server/services/workshop/scene-events.ts:66-81`(无预算)

```ts
// scene-events.ts:71-80 —— 序列化只做一次(好),但没有任何 per-peer 预算判定
const frame = JSON.stringify({ v: AEP_VERSION, type, seq: 0, at: …, channelId: '', payload })
for (const peer of peers()) {
  if (lineId !== undefined && !peerSeesLine(peer, lineId)) continue
  try { peer.send(frame) } catch { peers().delete(peer) }
}
```

`PEER_SEND_BUDGET_BYTES = 8 MB/s` 的判定只存在于 `sendFrame()`(`ws.ts:190-206`),而**最高速率的帧流恰恰走 scene 路径**(`daq.reading` 282 帧/s、`daq.frame`、`dcw.written`)。一个卡住的客户端在 scene 路径上不会触发 `close(1013, 'slow consumer')`,只能靠内核/`send` 缓冲区堆积;`send()` 的异常分支只处理同步抛错,不覆盖「写入成功但积压」的情形。

**修复**:把预算判定抽成 `peerBudget(peer, bytes)` 复用给两条路径(或让 `broadcastSceneEvent` 走同一个 `sendFrame` 门面);对 `daq.reading` 这类可丢帧再快照对齐的帧,超预算时优先**跳帧**而非断开。

### F2-4 [P2] 每样本 `O(recipes)` 查表 + 逐样本对象分配

**位置**:`server/services/workshop/daq/host-bindings.ts:45-55`、`server/services/workshop/dcw/dcw-recipe.repo.ts:153-155`、`server/services/workshop/daq/daq-runtime.ts:184`

```ts
// host-bindings.ts:52-55
recipeWindow(recipeId, nodeId) {
  const w = getDcwRecipeRepo().byId(recipeId)?.daqWindows?.find(x => x.nodeId === nodeId)
```

`byId` 是线性扫描(`dcw-recipe.repo.ts:154 return this.recipes.find(r => r.id === id)`),而 `recipeWindow` 在**每个标量样本**的消费路径上被调用一次(`daq-runtime.ts:184`),`activeRun` 每次还新建一个快照对象(`host-bindings.ts:47`)。

**规模代价**:282 样本/s × 95 配方 ≈ 2.7×10⁴ 次字符串比较/s(绝对量不大,但属于可 O(1) 化的热路径查表)。**修复**:配方仓库维护 `Map<id, RecipeView>`,窗口再建 `Map<recipeId, Map<nodeId, window>>`;`activeRun` 直接返回缓存快照引用。

### F2-5 [P2] 插件事件桥无背压(条件性)

**位置**:`server/services/workshop/plugins/host.mjs:778-790`、`sdk/hooks.mjs:57-73`

`emitPluginEvent`/`emitDaqSample` 每帧调用一次,`HookBus.emit` 是 `async` 且对同类型监听器**串行 await**;调用方 `void …bus.emit(...)` 不等待。若某个插件注册了 `'*'` 或 `event:daq.reading`,帧率(282/s)会以「每帧一个悬挂 Promise」的形式排队,慢处理器无界积压(无 coalesce、无丢弃策略)。当前无插件时是纯 no-op(两次 Map 查找 + 一个 Promise 分配),故为条件性问题。

**修复**:桥接层加「同 tick 合并 + 队列上限 + 溢出丢弃计数」,或在 `emit` 前判定 `bus.size === 0` 短路(可省掉每帧的 Promise 分配)。

### F2-6 已核实**不是**问题(采样公平性/扇出/有界性)

- **sweep 只采前缀节点**:已修复。`daq-controller.ts:496-507` 用 `sweepCursor + examined` 轮转,并以 `rt.isDue(now, defs)`(`daq-runtime.ts:86-89`)先判到期再占额度,注释 `:493-495` 记录了原缺陷与修法。定量提醒:`SWEEP_MAX_CONCURRENCY = 64`(`:132`)+ 250ms 扫描 ⇒ 派发上限 **256 次/s**;若现场真有 282 个节点全部按 1s 周期采,稳态需求 282/s > 上限,节点周期会被动拉长到 ≈1.1s(优雅降级,不丢采样)。
- **per-peer 重复序列化**:不存在。scene 路径 `JSON.stringify` 一次复用(`scene-events.ts:71`),channel 路径同样(`ws.ts:283`)。
- **服务端环形缓冲有界**:`RING_CAP = 5000` + `RING_BYTES_CAP = 4 MB` 双封顶(`ws.ts:36-38,286-289`);落库缓冲 `DB_BUFFER_CAP` 超限即刷 + 失败回队上限 5000(`ws.ts:250-260`)。
- **前端实时缓冲有界**:`hist` 60(`useDaqStream.ts:16,157`)、`frames` 30/节点(`:18,217`)、`dcw.history` 60(`useDcwStream.ts:90`)、`optimizations` 200(`:108`)、`rtcHist` 120(`TownView.vue:1572,1600`)、`recent` ops 40(`useOpsLog.ts:15,102`)、`trendBuf` 36(`index.vue:85`)。`alarms` 的 WS 入口 `unshift` 无显式上限(`useDaqStream.ts:256`),但 5s 轮询会用 `limit=50` 的 REST 结果整体替换(`:363-364`),告警又是边沿事件,故实际有界。**未发现随帧无限增长的数组。**
- **降采样**:服务端按 `bucketMs` 分桶聚合(`storage/sqlite.adapter.ts:131-143`、`queryTagged:183-197`),前端趋势窗口 ≤120 点 ⇒ 当前不需要 LTTB/`appendData`;若趋势窗口拉长到千点级再引入(与 F1-2 一并处理)。
- **WS 处理器不在渲染时重复订阅**:`ensureWsFeed` 引用计数 + `done` 幂等(`useDaqStream.ts:229-245`),心跳为模块级单例(`useWorkshopWs.ts:17-18,108-123`),TownView 的 bus 订阅在 `onBeforeUnmount` 正确解绑(`TownView.vue:740,2867-2870`)。
- **每帧写 `conn.lastDataAt` 不会造成整页重渲**:Vue 3.5.41 的 computed 仅在值变化时通知订阅者(实测:101 次依赖变更 → 1 次重算传播,`effectRuns = 2`),`wsVisible`/`lastDataAgo` 这类布尔/文案派生不会因每条帧而重渲。

### F2-7 [P2] 死代码

- `DaqNodeRuntime.republish()`(`server/services/workshop/daq/daq-runtime.ts:76-78`):仓库内无调用点。
- `DaqController.markAllOffline()` / `onlineCount()`(`daq-controller.ts:519-524`、`768-771`):无调用点。
- `DaqNodeRepo.flushDebounced()`(`daq-node.repo.ts:79-86`):**无调用点**——`daq-node.repo.ts:2-4` 注释「读数变更走 5s 防抖」与实现不符:节点读数从不防抖落盘,只有配置类 CRUD 走 `flushNow()`。注释需修正,或补上调用点(否则重启后节点展示值停留在最后一次配置变更时刻)。

---

## 3. DCW 控制链路

### F3-1 [P1] 回退账本每次防抖落盘 = 整库 pretty-print 序列化(实测 8.57 MB / 23 ms)

**位置**:`server/services/workshop/dcw/recipe-rollback.repo.ts:21-29,118-135`、`server/services/workshop/json-store.mjs:55-71`

```ts
// recipe-rollback.repo.ts:118-126
private flushDebounced(): void {
  if (this.flushTimer) return
  this.flushTimer = setTimeout(() => { this.flushTimer = null; this.flushNow() }, 1500)
  this.flushTimer.unref?.()
}
// 128-131
flushNow(): void { saveJsonFileAtomic(ROLLBACK_PATH, this.db) }   // 整库
```

```js
// json-store.mjs:59
writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8')        // pretty-print
```

`ANCHORS_CAP = 20000` / `RECORDS_CAP = 2000`(`:21-29`),且 `appendAnchor`(`:143-151`)、`updateRecord`(`:256`)每次都调 `flushDebounced`,写热路径(`afterWrite`)与保写心跳共用。

**规模代价**(实测,按真实字段形态合成满配库):20000 锚 + 2000 记录 → compact 5.82 MB / 13.2 ms;`JSON.stringify(db, null, 2)` = **8.57 MB / 23.2 ms**(其中 2.75 MB 是纯缩进空白),外加 8.57 MB 的 `writeFileSync` 落盘。这段 CPU 与 I/O 全部在该进程的事件循环上,与 500ms 的写控制 sweep(`dcw-controller.ts:92,116-121`,内含保写心跳与回退兜底评估)和 250ms 的采样 sweep 争用;一次调控会话(连续锚/记录变更)期间每 1.5s 复现一次。

**修复**:账本改 append-only NDJSON(`fs.appendFile` 单行追加,成本 O(1)),启动/定期做一次压缩重写;或至少去掉 pretty-print(省 2.75 MB/次)、把 anchors 与 records 分文件并各自按需落盘。目标:热路径落盘从 8.57 MB 降到「本拍新增行」的字节数。

### F3-2 [P1] 回退仓库仍有多处按次全扫

**位置**:`recipe-rollback.repo.ts:278-280,165-167,228-230,261-275`;`recipe-rollback-manager.ts:385-386`

```ts
// 278-280  每次兜底评估判定都要全量过滤 records
chainRollbackCount(nodeId: string): number {
  return this.db.records.filter(r => r.nodeId === nodeId && r.status === 'rolled-back').length
}
```

```ts
// 165-167  O(anchors ≤ 20000) 线性查找
anchorById(id) { return this.db.anchors.find(a => a.id === id) }
// 228-230  O(records ≤ 2000);updateRecord 每次更新都先 byId()
byId(id) { return this.db.records.find(r => r.id === id) }
```

`chainRollbackCount` 在 `evaluateOpenRecords → evaluateOnce` 的自动回退分支每次调用一次(`recipe-rollback-manager.ts:442`),`listRecords`(`:261-275`)在 `executeRollbackWrite` 末尾为了取「最新一条记录」再倒序扫一次(`:385-386`)。

**规模代价**:2000/20000 量级的单次扫描在绝对时间上不大(数十微秒),但它们成对出现在「写事务 + 兜底评估」路径上,且 `byId` 被 `updateRecord` 复用 ⇒ 每次记录更新都是 O(2000)。

**修复**:`byId → Map<id, record>`、`anchorById → Map<id, anchor>`、`chainRollbackCount → Map<nodeId, count>`(回退时自增);`executeRollbackWrite` 直接返回刚写入的记录对象,删掉「倒序扫一次取头」的兜底查询。

### F3-3 [P2] `executeRollbackWrite` 末尾的非空断言可能返回 `undefined`

**位置**:`server/services/workshop/dcw/recipe-rollback-manager.ts:385-386`

```ts
const fresh = this.repo.listRecords({ nodeId: record.nodeId, limit: 1 })[0]
return fresh!
```

若回退写因 `afterWrite` 的 5s 去重(`recipe-rollback-manager.ts:118-121`)或「值未变化不记锚」(`:126-128`)提前返回,则新记录不会产生;`listRecords` 过滤 `nodeId` 后返回空数组 → 非空断言把 `undefined` 当 `OptimizationRecord` 交给调用方(上层 `rollbackRecord/rollbackNode` 的返回契约是 `Promise<OptimizationRecord>`)。**修复**:显式构造/返回本次写产生的记录(或 `byId(recordId)`),避免以「查最新一条」代替返回值。

### F3-4 已核实**不是**问题

- 兜底评估走索引:`evaluateOpenRecords` 用 `listOpenRecords()`(`:419`,基于 `openByNode`)而非「全量倒序 + limit 500」,注释 `:417-418` 说明了原缺陷;且有 `MIN_WINDOW_MS` / `RECHECK_MS = 30s`(`:423-426`)双重门控。
- 窗口聚合在写热路径上异步化 + 防重入(`fillMetrics`,`:574-599`),且查询 `limit: 800`(`:522`)使 `Math.min(...values)` 的展开长度有界(不会触发调用栈上限)。
- 写路径状态机:驱动写失败与状态收敛(`dcw-runtime.ts:74-88`)、保写心跳与手动写共用同一在飞闸门(`dcw-runtime.ts:101-117`)正确处理了「心跳并发落到同一通道 / prevValue 跨 await 采样」的历史缺陷。

---

## 4. 架构与可复用性

### F4-1 [P2] `globalThis` 单例:数量多、命名两套、且前端 store 会在 SSR 进程内跨请求共享

**位置**:服务端 40+ 处(如 `server/services/workshop/daq/*`: `__daqController`、`__daqNodeRepo`、`__daqHostPorts`、`__daqQueue`、`__daqFrameProcessors`…);前端 8 处(`app/composables/workshop/*`: `__daqStream`、`__dcwStream`、`__amlStream`、`__opsLogStream`、`__deviceTwins`、`__townBus`、`__workshopWs`)

**现状**:命名前缀不统一(服务端 `__daqXxx` / 前端 `__xxxStream`),单例获取各写各的 `const g = globalThis as … & { __k?: T }` 样板(数十份)。更值得注意的是:前端 composable 的 `globalThis` 单例**在 SSR 期间也运行在同一 Node 进程**(`useDaqStream.ts:483-487`、`useDeviceTwins.ts:141-146` 等),即所有请求共享同一个 reactive store 实例;`useWorkshopWs()` 甚至会在 SSR 期构造一个持有首个请求 Pinia store 引用的 `WorkshopWsSession`(`useWorkshopWs.ts:29-81`,其 `connect()` 靠 `typeof window === 'undefined'` 兜底不建连),该会话对象与其闭包会长期驻留。

**影响**:单租户/单进程部署下实际风险低(数据在客户端 `onMounted` 才装载,SSR 首屏不序列化这些 store),但这是「跨请求状态 + 内存驻留」的结构性隐患,且 `useDeviceTwins()` 每次被调用都触发一次 `void store.load()`(见 F4-3)。

**修复**:前端 store 统一走 `useState`/Pinia(而非裸 `globalThis`),或至少加 `import.meta.server` 守卫不在服务端创建;服务端统一到一个 `singleton(key, factory)` 工具,消除 40 份样板与命名分歧。

### F4-2 [P2] 仓库样板重复 + 落盘原子性不一致

**位置**:`recipe-rollback.repo.ts:118-135`、`dcw-node.repo.ts:59-79`、`dcw-recipe.repo.ts:385-395,407-417`、`daq-node.repo.ts:79-86`、`device-twin.repo.ts:68`

**现状**:至少 5 份几乎逐字相同的「`flushTimer ??= setTimeout(…, N)` + `flushNow` 全量写」实现,间隔各不相同(1500 / 1500 / 1500 / 5000 / 2000 ms),且**原子性不一致**:多数走 `saveJsonFileAtomic`,而 `dcw-recipe.repo.ts:407-417` 的 `flushRecipes/flushRuns/flushHistory` 走普通 `saveJson`,即配方/批次/写历史是「截断即整库丢失」(正是 `json-store.mjs:1-14` 注释里描述的 P0-2 场景,该文件的其他调用点已修好)。

**修复**:抽 `createDebouncedJsonStore(path, { ms, atomic })`,统一原子写与间隔常量;`dcw-recipe.repo` 的写历史(`WRITES_CAP = 3000` × ~200 B ≈ 600 KB)同样适合 append-only。

### F4-3 [P2] `useDeviceTwins()` 以「取 store」为名触发网络请求

**位置**:`app/composables/workshop/useDeviceTwins.ts:141-146`

```ts
export function useDeviceTwins(): DeviceTwinStore {
  const g = globalThis as unknown as Record<string, DeviceTwinStore | undefined>
  if (!g[GLOBAL_KEY]) g[GLOBAL_KEY] = createStore()
  const store = g[GLOBAL_KEY]!
  void store.load()      // 每次调用都发一次 GET(靠 in-flight 去重兜底)
  return store
}
```

DAQ 列表页的每一行组件都会调用它(`app/components/workshop/DaqNodeRow.vue:23`),即 282 个组件 setup 各触发一次加载(同一 tick 内被 `__loading` 去重,但过滤器切换、重新挂载时会再发一轮)。SSR 期该请求必然失败(相对 URL),`apiFetch` 会按幂等 GET 重试 2 次并 sleep 400/800ms(`app/composables/workshop/apiClient.ts:88-100`),在服务端留下无意义的定时器与错误态。

**修复**:把加载移出 composable 调用点(由需要的容器组件显式 `load()`),或加 `import.meta.client` 守卫 + 「数据过期才重拉」的 TTL。

### F4-4 [P2] 其他一致性观察

- 时间语义:`DaqNode.lastAt` 存 ISO 字符串并在前端反复 `Date.parse`,而 `frameBuffer` / `daq_frames` 用 epoch ms;同一条链路两种表示,`Date.parse` 在读数热路径上被反复调用(`useDaqStream.ts:206`、`daq/index.vue:123,242`、`DaqNodeRow.vue:32`)。建议视图层统一暴露 `lastAtMs`。
- 节拍常量散落:`TSDB_FLUSH_MS=500`、`FRAME_BUFFER_CAP=2000`、`SWEEP_MAX_CONCURRENCY=64`、`RING_CAP=5000`、`HIST_CAP=60`、`FLUSH_MS=160` 等分散在 6 个文件,缺少「实时链路预算表」;建议集中为一份常量并标注推导依据(现有注释质量很高,值得复用)。
- 循环依赖:未发现真实环。`recipe-rollback-manager → dcw-controller` 用动态 `import()` 打断(`recipe-rollback-manager.ts:390,513,614`),`scene-events.ts:1-9` 的注释也说明了从 ws 路由解耦的原因;`app/composables/workshop/*` 对 `apiClient` 的依赖是单向的。

---

## 5. 未验证 / 存疑

1. **未做运行时测量**:全部前端代价为静态推导 + 定点量化(载荷字节数、序列化耗时用 `node -e` 单独测得);没有浏览器 Performance/内存 profile,`O(L×R)` 与 `miniTick` 的实际 ms 值未实测。
2. **现场规模取自注释**:「282 节点」「227 条目」「95+ 产线」均来自源码注释,实际部署的节点数/线数未核。
3. **后台标签页节流行为未验证**:F1-6 中「500ms 合批窗退化为分钟级」基于浏览器后台定时器节流的一般行为,未在目标浏览器/内核上验证。
4. **`peer.send` 的积压语义未验证**:F2-3 只确认了应用层未做预算判定;`crossws`/`ws` 在目标平台上的内核写缓冲与背压表现未实测。
5. **插件桥背压(F2-5)是条件性的**:未确认部署中是否真的注册了 `'*'` 或 `event:daq.reading` 监听器(`.AgentWorkShop/plugins` 实际内容未查)。
6. **F2-1 的触发前置条件**:需要 `frameBuffer` 被填到接近 `FRAME_BUFFER_CAP`(即 TSDB 写入持续变慢)。我确认了代码路径与复杂度,但**未构造**真实触发场景;若现场 SQLite 写入始终 <500ms,该路径不会进入最坏情形。
7. **ECharts 重建的实际耗时**未测(仅确证 `notMerge: true` 的调用语义与 `deep: true` 的 watcher)。
8. 未审:AML 训练链路、`server/services/workshop/runtime/**`(agent 运行时)的实时性,以及 `app/components/workshop/town/TownScene3D.ts` 的渲染循环内部(仅看了 HUD 侧调用面)。
