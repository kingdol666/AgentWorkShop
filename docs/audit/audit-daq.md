# DAQ 管线审计报告(driver → queue → TSDB/object-store → WS → frontend)

- **审计对象**:`D:\codes\ABO\AgentWorkShop`(Nuxt4/Nitro,Node 24)
- **审计方式**:逐行阅读 `server/services/workshop/daq/**`、`shared/daq-protocol.ts`、`server/api/workshop/daq/**`、`server/api/workshop/ws.ts` + `services/workshop/scene-events.ts`、前端 `useDaqStream.ts` / `pages/daq/*` / `DaqNodeRow.vue`、`db/database.ts` / `db/retention.ts`;配合 `tsc --noEmit`、`node:sqlite` 实测与 5 个复刻实验。
- **只读约束**:未修改任何源文件。实验脚本落在 `scripts/_audit/`。
- **环境限制**:本会话未启动 dev server(Timescale/MinIO/broker 均不可达),凡涉及真实后端行为的推断均标 ⚠UNVERIFIED。

---

## 0. 逐题作答

**Q1 帧竞态 —— 已修(防抖窗口),但 flush 在飞窗口仍存在(仅 Timescale 后端)。**
当前 `GET .../frames/content` 的完整代码路径:
`server/api/workshop/daq/[id]/frames/content.get.ts:13-26`(`resolveUser` → `requireLineMode(readonly)` → `ts` 校验 → `frameContent(id, ts, q.thumb === '1')` → 设 `content-type`/`cache-control` → 返回 Buffer)
→ `daq-controller.ts:853-867`:`ensureLoop()` → `await tsdbReady` → `repo.byId`(404 分支 :857)→ **`framesFromBuffer(id, tsMs)` 内存读穿透(:859)** → 未命中才 `getTsdb().queryFrames(id, { fromMs: ts-1, toMs: ts+1, limit: 5 })`(:860)→ `rows.find(r => r.at === tsMs)`(:861)→ 非 image/不存在 → 404(:862)→ `thumb ? meta.thumbKey : meta.objectKey`(:863)→ 键缺失 → 404(:864)→ `getObjectStore().get(key)`(:865)。
`framesFromBuffer`(:806-824)确实存在且被 `frames()` 复用(:842),500ms 防抖窗口内的 404 **已消除**。残留缺口见 **「读穿透在 Timescale 后端仍有在飞窗口」**(Timescale `writeFrames` 在飞期间的“既不在 buffer 也没落库”窗口)与 **「对象存储只写不删」**(`thumb=1` 在 `thumbKey` 缺失时必然 404)。

**Q2 并发 —— 有闸门(8),但闸门调度是「插入序优先」,实测 50 节点 @1s 时尾部 18 个节点 60s 内 0 次采样。**
唯一启动 driver tick 的位置是 `daq-controller.ts:464-482`(`sweep()`,`setInterval 250ms`,:191)。`SWEEP_MAX_CONCURRENCY = 8`(:123),`samplingInFlight` 计数器(:148、469、477-480)。**容量上限 = 8 × 4 拍/s = 32 次采样启动/秒**;超出后 `break`(:474)使尾部节点永远轮不到。详见 **「sweep 闸门尾部饿死」**(P0)。实测:8 节点 @1s = 101.7% 需求(健康);50 节点 @1s = 64.3%,尾部 18 节点 0 采样;MQTT 最坏(3s 阻塞)= 5.4%。

**Q3 无界增长 —— 5 处写入无淘汰/无清理,其中对象存储是真泄漏(实测 6.6 GB/天/节点)。**
① `mqttPool`(`drivers.ts:710`,无空闲 sweep,对比 modbus `:462-478` / opcua `:493-515`)与 `conn.topics`(:748、822);② 对象存储 blob(`daq-controller.ts:267-275` 只 put,全仓无 `getObjectStore().remove` 调用者,`objectstore-port.ts:16` 是死接口);③ `__daqMockStates`(`drivers.ts:94-97`)节点删除后不清理;④ 前端 `readingBuf`(`useDaqStream.ts:142-171`)无上限(标签页节流时);⑤ `metricStates`(:136)已随节点删除清理(:1028-1030),`twinPushAt`(:718)已随设备删除清理(:1102),`siblingsCache`(:677,LRU 500)—— 这三个属于已治理项。详见 **「对象存储只写不删」 / 「队列信封不校验」 / 「节点删除不清理历史样本」**。

**Q4 资源生命周期 —— 定时器全部 `.unref()`,连接池不一致。**
DAQ 模块内 9 个 `setInterval` 全部 `unref?.()`(daq-controller:192、drivers:477/514、infra:215、alarm-notify:95、sqlite:82、timescale:64、inproc:30、node.repo:85);`MqttQueueAdapter.close()` 显式 `removeAllListeners()`(`mqtt.adapter.ts:126`)。缺口:① **driver 侧 `mqttPool` 没有空闲回收**(modbus/opcua 有),节点删除也不关连接,**topic 从不 unsubscribe**(drivers.ts:821-831 只 subscribe);② Modbus connect 超时定时器未清理(`drivers.ts:311`,连接成功后仍持有最长 3s 的 ref'd timer);③ `withModbusConn` 超时后旧 socket 上的在飞 `run` 仍会继续(已用 `conn.tail` 复位,风险有限)。详见 **「MQTT 驱动阻塞与连接池不回收」**。

**Q5 背压 —— 有界缓冲 + 丢最旧,但「丢多少」计数错误,且重试耗尽后整批永久丢弃(无回队)。**
`tsdbBuffer` cap 5000(:108/348-351)、`frameBuffer` cap 2000(:110/397-400)、inproc 队列 cap 10000 + 丢最旧(`inproc.adapter.ts:11/33-39`)、mqtt 离线缓冲 cap 2000 + 丢最旧(`mqtt.adapter.ts:26/91-99`)。问题:① 溢出时 `this.tsdbDropped += 1` 只加 1,而 `splice` 可能一次丢掉上千行 → 指标严重低报;② `flushTsdb` 先 `splice` 走整批,3 次重试失败后 `tsdbDropped += batch.length` 并**直接丢弃**(:631-634、652-655),不像 `ws.ts:248-257` 那样回队;③ WS 场景广播(`scene-events.ts:66-81`)没有 `ws.ts:190-214` 的 per-peer 字节预算,慢消费者只能靠 socket 层无界缓冲。详见 **「写失败重试耗尽丢批 + 丢弃计数失真」 / 「场景广播无慢消费者保护」**。

**Q6 算法效率 —— 最重的是 `frames()` 的 O(B²) 合并(最坏 ~2000×4096)与逐帧同步 zlib。**
`framesFromBuffer` 每次调用都会为每个候选行构造 `DaqFrameRecord` 并把最多 4096 点 `points` 全量 `map(Number)` 复制;`frames()` 里对每个 pending 行再调一次 → 最坏 2000×2000 次迭代、千万级元素拷贝/请求。`frames/content` 也走同一函数(单行 4096 点仍被复制)。逐帧 `inflateSync`/`deflateSync` 同步阻塞事件循环(`frames.ts:156`、`png-enc.ts:55`)。详见 **「frames() 的 O(B²) 合并」 / 「图像帧全链路同步 CPU」**。

**Q7 正确性 —— 无质量位;时间单位统一 ms;桶聚合整数分桶正确;保留期只处理元数据;离线→在线需 3 帧。**
① 时间单位:`tsMs`(epoch ms)内部统一,线上 ISO 字符串,`Date.parse` 转换一致;缺陷是未校验(见 **「队列信封不校验」**)。② 桶聚合:SQLite 用整数字面量内插避免浮点除法(`sqlite.adapter.ts:135-142`,注释准确);Timescale 用 `time_bucket`(`timescale.adapter.ts:112-118`)—— 均正确。③ 保留期:SQLite 分批删行、Timescale `drop_chunks`;对象存储不删(**「对象存储只写不删」**)、节点删除不删历史(**「节点删除不清理历史样本」**)、Timescale 默认 chunk 导致保留期不精确(⚠**「Timescale 保留期不精确」**)。④ 离线→在线:注释称只有 ok↔warn 去抖,实际 offline→ok 也要连续 3 帧(**「offline→ok 恢复被 3 帧去抖延迟」**)。⑤ 报警去重:同 (node_id, metric) 未确认即幂等(`ops.repo.ts:112-129`),但 `alarmsRaised` 在去重前自增(**「alarmsRaised 去重前自增」**)、升级扫描无时间戳导致每分钟重复升级+外送(**「报警升级扫描无上次升级时间」**)。⑥ **质量位:整条链路不存在** —— OPC UA `Bad` 状态直接抛错丢样本(`drivers.ts:587-589`),表结构无 quality 列(**「无质量位维度」**)。

**Q8 冗余 —— 至少 6 组应抽取的重复实现。**
`flushTsdb` 内样本/帧两段各 ~20 行几乎逐字相同的重试+退避+计数(:621-640 vs :642-661);4 份「有界缓冲丢最旧」实现(`tsdbBuffer`/`frameBuffer`/`inproc`/`mqtt.offline`,外加 `ws.ts:250-257` 的第 5 种「回队重试」语义);`pointsFromMeta` 3 份(`daq-controller.ts:827-831`、`sqlite.adapter.ts:302-306`、`timescale.adapter.ts:254-258`)+ `asObject` 2 份;modbus/opcua 两个空闲 sweep 同构(mqtt 缺失);mqtt 驱动 sample/test 的「订阅+等待首帧」双份(:821-836 / :846-859);5 处 `try { void client.close() } catch {}`(`drivers.ts:225/261/314/470/503-507`)。详见 **「重复实现待合并」**。

---

## 1. P0

### [P0] `LruMap` 未导入:构造 DaqController 即抛 ReferenceError,整个 DAQ 面(含启动装配)不可用
- **Where**: `server/services/workshop/daq/daq-controller.ts:677`(定义仅在 `shared/lru.mjs:14`)
- **Evidence**:
```ts
// daq-controller.ts:677
  private siblingsCache = new LruMap<string, { at: number, list: DaqNode[] }>(500)
```
  该文件的 import 段(`:24-46`)没有 `LruMap`;全仓 `LruMap` 只出现 3 处:`shared/lru.mjs:14`(`export class LruMap`)、`scripts/test-lru.mjs:2`(import)、上述使用点。
- **Impact**:类字段初始化器在构造函数中执行 → `new DaqController()` 抛 `ReferenceError: LruMap is not defined` → `getDaqController()`(`:1174-1177`)必然抛错 → `server/api/workshop/daq/**` 全部 500(GET 列表、创建、patch、frames、samples、alarms、controller 总控);`server/plugins/daq.ts:22` 在同一异常下跳过 `reattachQueue()/startAll()`,只留下一条 `console.error('[daq-infra] 启动装配失败…')`(:68),因此**采集管线根本不会启动**(队列消费不挂、sweep 不起、`pipelineReady` 恒 false)。这是 PLAN-ARCH-AUDIT.md P1-4「统一替换为有界 LRU」改造时遗漏 import 造成的回归。
- **Fix**:在 `daq-controller.ts` 的 import 段补一行 `import { LruMap } from '../../../../shared/lru.mjs'`(与同文件 `:12` 的 `'../../../../shared/daq-protocol'` 同层级;`.mjs` 导入在本仓库已有先例,见 `:42` 的 `host.mjs`)。或者退回 `const siblingsCache = new Map(...)`,但会丢 LRU 语义。
- **Verification**:
  `node_modules/.bin/tsc.CMD --noEmit --target es2022 --module esnext --moduleResolution bundler --skipLibCheck server/services/workshop/daq/daq-controller.ts 2>&1 | Select-String LruMap`
  当前输出 `daq-controller.ts(677,31): error TS2304: Cannot find name 'LruMap'.`(实测已复现);修好后该行无输出。运行期验证:`npm run dev` 后 `curl -i http://127.0.0.1:<devPort>/api/workshop/daq`,修复前 500、修复后 200。

### [P0] sweep 并发闸门按「插入序优先」分配,超出 32 次/秒后尾部节点永久 0 采样(静默失采)
- **Where**: `server/services/workshop/daq/daq-controller.ts:464-482`(`:469` budget、`:473` 遍历、`:474` `break`),闸门常量 `:123`,节拍 `:191`
- **Evidence**:
```ts
    const budget = SWEEP_MAX_CONCURRENCY - this.samplingInFlight
    if (budget <= 0) return
    const now = Date.now()
    let started = 0
    for (const rt of this.runtimes.values()) {
      if (started >= budget) break
      if (!host.lineRun.activeRun(rt.node.lineId)) continue
      this.samplingInFlight += 1
      started += 1
      void rt.tick(now).catch(() => {})
```
  `runtimes` 是 `Map<string, DaqNodeRuntime>`(`:130`)且 `syncRuntimes()` 按 `repo.all()` 顺序插入(`:501-508`),即**节点创建顺序**;每拍只发放 8 个额度,`break` 后本拍不再看尾部。
- **Impact**:网关稳态容量 = `8 × (1000/250) = 32` 次采样启动/秒。当集群需求超过该值时,额度被列表中靠前的节点**全部吃满**,尾部节点永远拿不到 `tick()`:`lastAt` 保持 null、`lastSampleAt` 保持 `-Infinity`,节点既不报错也不落库、前端只能显示「从未采样/离线」且没有任何诊断(`samplingInFlight` 未暴露到 `controllerState()`)。逐行复刻 sweep 循环的模拟(60s,50 节点,interval=1000ms,采样瞬时完成):**前 32 个节点各 ~60 次,后 18 个节点 0 次**;若单次采样 100ms → 总达成 32.1%,尾部仍 0 次;若单次 3s(MQTT 驱动最坏,见 「MQTT 驱动阻塞与连接池不回收」)→ 总达成 5.4%。默认配置(intervalMs=5000)下 50 节点仅 10 次/秒,不触发;但 50 节点 @1s、200 节点 @5s 等工业常用配置会直接踩中。
- **Fix**:把「先到先得」改成轮转 / 到期队列。最小改动:`DaqController` 增加 `private sweepCursor = 0`,遍历时从该游标开始(取 `[...this.runtimes.values()]` 的环形切片,或维护 `runtimeOrder: DaqNodeRuntime[]`),每拍把游标推进到本轮最后一个被启动节点之后;这样额度在节点间轮转,慢节点被均匀降频而不是让尾部饿死。同时把 `samplingInFlight` 与「到期但被闸门压掉的节点数」加进 `controllerState()`(`:747-770`)以便观测。
- **Verification**:`node scripts/_audit/exp-sweep-fairness.mjs`(当前输出 50 节点 60s 内 `min=0`,末 5 节点全 0);改成轮转后该脚本应输出 `min≈38`(均匀降频到 32/50 ≈ 0.64 次/秒/节点)。端到端:建 50 个 intervalMs=1000 的节点,挂 1 条活动产线,60s 后查 `SELECT node_id, COUNT(*) FROM daq_samples GROUP BY node_id` —— 修复前有 18 个 node_id 无行。

---

## 2. P1

### [P1] 对象存储只写不删:图像帧 blob 无任何清理路径,实测 ~6.6 GB/天/节点
- **Where**: `server/services/workshop/daq/daq-controller.ts:267-275`(唯一写入点)、`server/services/workshop/daq/storage/sqlite.adapter.ts:276-285`(只删行)、`objectstore/objectstore-port.ts:16`(`remove` 无调用者)
- **Evidence**:
```ts
    const os = getObjectStore()
    const objectKey = daqObjectKey(node.id, now, '.png')
    await os.put(objectKey, wf.blob!, wf.mime ?? 'image/png')
    let thumbKey: string | undefined
    if (wf.thumbBlob) {
      thumbKey = daqObjectKey(node.id, now, '.thumb.png')
      await os.put(thumbKey, wf.thumbBlob, 'image/png')
    }
```
```ts
  private sweepFrameRetention(): void {
    if (!this.db) return
    const cutoff = Date.now() - daqRuntimeSettings().frameRetentionH * 3600_000
    try {
      this.db.prepare('DELETE FROM daq_frames WHERE ts_ms < ?').run(cutoff)
```
  全仓检索确认不存在 `getObjectStore().remove(...)` / `DaqObjectStore.remove` 的调用者;`daq_frames` 只存 `{objectKey, thumbKey, mime, width, height}` 元数据。
- **Impact**:图像节点的每一帧都会向 MinIO 桶 / `data/daq-objects/daq/<nodeId>/<yyyy>/<mm>/<dd>/` 写入 2 个 PNG,**永不删除**。实测(复刻 `png-enc.encodePng` + mock `ccd-image` 320×240 + `thumbnail width=256`):主图 47.2 KB + 缩略图 30.6 KB = **77.9 KB/帧**;`publishIntervalMs` 缺省 1000ms ⇒ **≈6.6 GB/天/节点**(77.9KB × 86400 = 6.57 GB)。`daq.frameRetentionH` 缺省 720h(30 天)只清理数据库行,清理后对象成为**无法枚举的孤儿**(键按日期分片,但没有任何遍历/GC 代码)。磁盘/MinIO 会持续增长直至打满,且降级到 `DiskObjectAdapter` 时直接吃 `data/` 所在盘。
- **Fix**:在保留期清理里做「先取键、再删行、后删对象」。最小改动:给 `DaqObjectStore` 增加批量删除或在 `SqliteTimeSeriesAdapter.sweepFrameRetention()`(`sqlite.adapter.ts:276`)与 `TimescaleAdapter.sweepRetention()`(`timescale.adapter.ts:68`)中先 `SELECT meta FROM daq_frames WHERE ts_ms < cutoff LIMIT 5000` → 解析 `objectKey/thumbKey` → `Promise.allSettled(keys.map(k => getObjectStore().remove(k)))` → 再执行原有 DELETE(分批循环)。若用 MinIO,也可在桶上配 lifecycle rule,但需同步写入运维文档,因为磁盘降级路径没有 lifecycle。
- **Verification**:起一个 `ccd-image` 模板节点(publishIntervalMs=1000)跑 60s,记录目录体积,再跑一次 `SqliteTimeSeriesAdapter.sweepFrameRetention()`(把 `daq.frameRetentionH` 临时设为 0.001):
  `(Get-ChildItem data/daq-objects -Recurse -File | Measure-Object -Property Length -Sum).Sum`
  当前:行数归零后该值不变(泄漏);修复后应回落到 0。

### [P1] `decodeGrayPng` 不做反滤波:真实相机 PNG 的亮度/对比度指标与缩略图全错,部分格式还会让 `thumb=1` 稳定 404
- **Where**: `server/services/workshop/daq/frames.ts:143-166`(`decodeGrayPng`)、`:126-141`(`thumbnail`)、`:168-186`(`quality-gate`)、`daq-controller.ts:272-275`、`:411-415`、`:863-864`
- **Evidence**:
```ts
/** 最小灰度 PNG 解码(仅支持本仓 encodePng 产出的 filter-0/8bit 灰度;其余返回 null) */
function decodeGrayPng(blob: Buffer, w: number, h: number): Uint8Array | null {
  ...
    const raw = inflateSync(Buffer.concat(idat))
    const stride = w + 1
    if (raw.length < stride * h) return null
    const out = new Uint8Array(w * h)
    for (let y = 0; y < h; y++) out.set(raw.subarray(y * stride + 1, y * stride + 1 + w), y * w)
```
  代码只**跳过**每行第 1 个字节(filter type),不做 PNG 规范要求的 un-filter(Sub/Up/Average/Paeth),也不校验 IHDR 的 bitDepth/colorType/interlace(只走了长度判断)。
- **Impact**:实测(标准 8bit 灰度、filter type=2 Up、行值 50/90/130/170):解码结果 50/40/40/40,**maxErr=130/255**,亮度 110.0 → 42.5(`node scripts/_audit/exp-png-decode.mjs`)。后果:① `quality-gate` 派生的 `brightness` 指标是错的 → 内置 `ccd-image` 模板的 `brightness alarmLow=30`(`shared/daq-protocol.ts:146`)会误报/漏报,而这正是图像帧唯一的告警通道;② `thumbnail` 产出的缩略图是噪声;③ RGB/palette/16bit/interlace 的 PNG 会走同一条错误路径(长度判断恰好通过);④ 若 `decodeGrayPng` 返回 null(JPEG 无 IDAT、bitDepth 1/2/4),`thumbnail` 直接 `return frame`(:137)⇒ `thumbKey` 缺失,而 `ingestFrame` 仍在对象存在时广播 `thumbUrl`(`:413-415`),客户端所有图像请求都带 `thumb=1`(`useDaqStream.ts:214`、`pages/daq/[id].vue:858`)⇒ `frameContent` 在 `:863-864` 抛 404「帧对象缺失」,画廊整屏裂图,且**不会回退到主图**。
- **Fix**:两步最小改动。(a) `frames.ts` 的 `decodeGrayPng` 先解析 IHDR 并只接受 `bitDepth===8 && colorType===0 && interlace===0`,其余返回 null(明确不支持而不是算错),随后按 `raw[y*stride]` 的 filter type 实现 5 种反滤波(约 25 行)。(b) `daq-controller.ts:863` 改为 `const key = (thumb ? row.meta.thumbKey ?? row.meta.objectKey : row.meta.objectKey)`,让缺缩略图时回退主图。
- **Verification**:`node scripts/_audit/exp-png-decode.mjs` —— 修复后 `maxErr` 必须为 0、`decodedBrightness` 必须等于 `truthBrightness(110.0)`。端到端:用一个返回标准 PNG(带 Paeth 滤波)的 HTTP 图像源建节点,对比 `daq_frames.metrics.brightness` 与图像真实平均灰度。

### [P1] 图像帧全链路同步 CPU:`inflateSync`/`deflateSync` 阻塞事件循环,`thumbnail`+`quality-gate` 还会重复 inflate
- **Where**: `server/services/workshop/daq/png-enc.ts:35-58`(`deflateSync(raw, { level: 6 })` 在 `:55`)、`frames.ts:156`(`inflateSync`)、`:136` 与 `:175`(两个处理器各调一次 `decodeGrayPng`)、调用点 `daq-controller.ts:263`
- **Evidence**:
```ts
    chunk('IDAT', deflateSync(raw, { level: 6 })),
```
```ts
    const gray = decodeGrayPng(frame.blob, w, h)   // frames.ts:136 thumbnail
    ...
    const gray = decodeGrayPng(frame.blob, w, h)   // frames.ts:175 quality-gate
```
- **Impact**:`runSinkPipeline` 在生产侧同步执行,`deflateSync`/`inflateSync` 期间 Node 事件循环完全停摆 —— 同一进程里的 WS 广播、HTTP 请求、其余节点的采样全被推迟。实测 320×240(7.7 万像素)单帧:主图 encode 2.7ms + 缩略图 encode 1.4ms + 两次 inflate(未单独计时,与像素数同阶)。按像素线性外推(⚠估算,非实测):2000×2000 相机帧(400 万像素,52×)单帧同步 CPU ≈ 0.2–1s 量级,按 1fps 采集即把整个网关拖成秒级抖动。另外 `quality-gate` 与 `thumbnail` 各 inflate 一次同一 blob(可省一半)。
- **Fix**:① 去掉重复解码:`thumbnail` 把解出的灰度像素放进 working frame(如 `wf.gray`),`quality-gate` 命中则复用(两者顺序在模板 `sink.processors` 中固定,先 thumbnail 后 quality-gate);② 把 `encodePng/decodeGrayPng` 换成 `node:zlib` 的异步 API(`deflate`/`inflate` + `util.promisify`),或在超阈值像素数(如 >1M)时走 `worker_threads` 池,并给帧管线加「单帧处理时长」上限(超限丢帧并计数)。
- **Verification**:`node -e "const t=process.hrtime.bigint();/*encodePng 320x240*/;console.log(Number(process.hrtime.bigint()-t)/1e6)"` 或直接跑 `scripts/_audit/exp-envelope-and-png.mjs` 看 “encode 2.7ms / 1.4ms”;改异步后同一脚本应显示帧编码期间无同步阻塞(可另起 `setInterval` 测最大抖动 < 5ms)。

### [P1] WS 场景广播无慢消费者保护:daq.reading/daq.frame 走 `broadcastSceneEvent`,绕过了 `sendFrame` 的字节预算
- **Where**: `server/services/workshop/scene-events.ts:66-81`;对照实现 `server/api/workshop/ws.ts:190-214`(`PEER_SEND_BUDGET_BYTES` 在 `:46`)
- **Evidence**:
```ts
export function broadcastSceneEvent(type: string, payload: unknown): void {
  emitPluginEvent(type, payload)
  if (peers().size === 0) return
  const lineId = payloadLineId(payload)
  const frame = JSON.stringify({ v: AEP_VERSION, type, seq: 0, at: new Date().toISOString(), channelId: '', payload })
  for (const peer of peers()) {
    if (lineId !== undefined && !peerSeesLine(peer, lineId)) continue
    try {
      peer.send(frame)
    }
    catch {
      peers().delete(peer)
    }
  }
}
```
  频道流路径有 `sendFrame()` 的 8MB/s per-peer 预算 + 超限 `close(1013)`;场景路径只有 `try/catch`(`send` 在 socket 背压时**不抛错**,只是把数据排进内部内存队列 —— ⚠库行为推断,未实测 crossws/ws 的排队上限)。
- **Impact**:`daq.reading` 按 `publishIntervalMs`(缺省 1s/节点)直推,`daq.frame` 额外带 ≤64 点预览与 `thumbUrl`;50 节点即 50 帧/秒 × 每个 peer。一个停止读取的浏览器标签(网络挂起、休眠)会让 ws 层为该连接无界排队 JSON 字符串,直到进程 OOM —— 而同一进程的频道流路径本来已有防护。DAQ 正是该出口上频率最高的生产者(`scene-events.ts:63-64` 注释自陈「N 节点×P 页面/秒高频扇出」)。
- **Fix**:把 `ws.ts` 的预算逻辑抽成共享工具(如 `shared/peer-budget.mjs`,导出 `chargePeer(peer, bytes, onExceed)`),在 `broadcastSceneEvent` 的 peer 循环里复用同一 `WeakMap` 预算表与 `close(1013, 'slow consumer')` 语义;或退一步,在 scene-events 内维护自己的 8MB/s 窗并剔除超限 peer。
- **Verification**:新增单测/脚本:构造 2 个假 peer(`send` 计数即可),1 个 `send` 抛错、1 个正常;连续 `broadcastSceneEvent('daq.reading', payload)` 直至单 peer 累计字节 > 8MB,断言其收到 `close(1013)` 且被移出 `sceneEventPeerCount()`;当前实现下该 peer 不会被剔除。

### [P1] TSDB 写失败重试耗尽后整批永久丢弃(不回队),且溢出丢弃数被按「事件」而非「行」计数
- **Where**: `server/services/workshop/daq/daq-controller.ts:617-669`(`:622` splice、`:631-634`、`:652-655`)、`:348-351`、`:397-400`;对照 `server/api/workshop/ws.ts:248-257`(正确做法:回队重试)
- **Evidence**:
```ts
        const batch = this.tsdbBuffer.splice(0, this.tsdbBuffer.length)
        let ok = false
        for (let attempt = 0; attempt < TSDB_WRITE_RETRIES && !ok; attempt++) {
          try {
            await getTsdb().writeSamples(batch)
            this.storedCount += batch.length
            ok = true
          }
          catch (err) {
            if (attempt === TSDB_WRITE_RETRIES - 1) {
              this.tsdbDropped += batch.length
```
```ts
    if (this.tsdbBuffer.length > TSDB_BUFFER_CAP) {
      this.tsdbBuffer.splice(0, this.tsdbBuffer.length - TSDB_BUFFER_CAP)
      this.tsdbDropped += 1
    }
```
- **Impact**:① 写库故障持续 >1.5s(3 次尝试 + 500/1000ms 退避)时,已 splice 出的整批(最多 5000 行,**跨全部节点**)被永久丢弃,数据不可恢复;② 溢出路劲丢 N 行只记 1 次,`meta.tsdbDropped`/`controllerState().tsdbDropped` 严重低报(丢 5000 行显示为 1),运维据此无法判断数据完整性,前后端所有「诚实可见」的指标都失真;③ 帧缓冲同样问题(`:397-400`)。
- **Fix**:① 重试耗尽不丢批:把未成功的 `batch` **回队**(`this.tsdbBuffer.unshift(...batch)` 并加一个「已失败批」上限,超过才丢弃),与 `ws.ts:248-257` 同语义;② 计数按行:`const overflow = this.tsdbBuffer.length - TSDB_BUFFER_CAP; this.tsdbBuffer.splice(0, overflow); this.tsdbDropped += overflow`(帧缓冲同理)。③ 顺手把两段重复的重试循环抽成一个 `writeWithRetry(rows, writer)` 私有方法(见 「重复实现待合并」)。
- **Verification**:停掉 TSDB(把 `DAQ_TSDB_URL` 指向黑洞端口)后跑采集 10s,读 `GET /api/workshop/daq` 的 `meta.dropped/tsdbDropped`:修复前 `tsdbDropped` 远小于实际丢失行数(可对比 `samplesStored` 与 `produced`),恢复 TSDB 后缺失的批次不会补回。

### [P1] 读穿透在 Timescale 后端仍有「在飞窗口」:`GET frames/content` 在刷盘期间 404
- **Where**: `server/services/workshop/daq/daq-controller.ts:806-824`(读穿透)、`:642-661`(splice + await 写)、`:853-867`(`frameContent`);`storage/timescale.adapter.ts:200-227`(逐行 await 的写)
- **Evidence**:
```ts
  /** 注:刷盘 splice 与查询同一 JS 线程,不存在「既不在 buffer 又没落库」的空窗。 */
```
```ts
        const batch = this.frameBuffer.splice(0, this.frameBuffer.length)
        ...
            await getTsdb().writeFrames(batch)
```
```ts
    const rows = this.framesFromBuffer(id, tsMs)
    if (rows.length === 0) rows.push(...await getTsdb().queryFrames(id, { fromMs: tsMs - 1, toMs: tsMs + 1, limit: 5 }))
```
- **Impact**:注释的前提只在 SQLite 后端成立(`SqliteTimeSeriesAdapter.writeFrames` 体内无 `await`,splice 到落盘之间不会让出宏任务)。Timescale 后端 `writeFrames` 会 `await pool.connect()` + 逐行 `await client.query(...)`(`timescale.adapter.ts:203-217`,N 行 N 次往返),这几毫秒到几百毫秒内该批帧**既不在 `frameBuffer` 也不在库里**,此时到达的 `frames/content` 与 `frames` 都会 404 / 缺行;写失败重试时窗口进一步拉长到 1.5s+(`daq-controller.ts:636`)。前端在收到 `daq.frame` 后立即 `<img src=thumbUrl>`(useDaqStream.ts:214 / [id].vue:858),慢一拍就会命中该窗口。
- **Fix**:让「在飞批」也可读:`private frameFlushing: DaqFrameRow[] = []`,`flushTsdb` 在 splice 后赋给 `frameFlushing`、写完成后清空(失败重试期间保持),`framesFromBuffer`(`:806`)同时扫描 `frameBuffer` 与 `frameFlushing`。样本批同理若将来需要按 ts 读。
- **Verification**:切到 Timescale 后端,注入 1 帧后在 flush 窗口内连续 `GET /api/workshop/daq/{id}/frames/content?ts={ts}&thumb=1`(用 `scripts/_dbg-daq-frames-e2e.mjs` 的循环改造),断言 100% 200;当前实现下必然出现 404。SQLite 后端不可复现(这解释了为何现有 e2e 全绿)。

### [P1] 队列信封不校验:坏的 `at` 会永久关闭该节点的乱序防御;Timescale 下还会毒化整批写入
- **Where**: `server/services/workshop/daq/daq-runtime.ts:148-153`;`daq-controller.ts:335-347`;`bus/mqtt.adapter.ts:78-87`(任意 JSON 直接进消费侧);`storage/timescale.adapter.ts:96`;`storage/sqlite.adapter.ts:110-114`
- **Evidence**:
```ts
  onSample(env: DaqSampleEnvelope): ConsumeVerdict {
    const node = this.node
    const tsMs = Date.parse(env.at)
    if (tsMs && tsMs <= this.lastIngestAt) return 'late'
    this.lastIngestAt = tsMs
```
```ts
    this.client.on('message', (topic, payload) => {
      try {
        const env = JSON.parse(payload.toString()) as DaqSampleEnvelope
        this.received++
        for (const fn of this.consumers) fn(env)
```
- **Impact**:MQTT 后端的 envelope 完全来自 broker 上的任意 JSON(`nodeId/at/value` 无 schema 校验,`DaqSampleEnvelope` 只是编译期类型)。实测:① `Date.parse('garbage') = NaN` ⇒ `NaN && ...` 为假、`lastIngestAt = NaN`,此后 `tsMs <= NaN` **恒为 false**,该节点的迟到帧防御永久失效(静默);② SQLite:`NaN` 绑为 NULL,`INSERT OR IGNORE` 把 NOT NULL 冲突**静默吞掉** —— 该行消失、无异常、无计数(实测:插 2 行只落 1 行);③ Timescale:`new Date(NaN).toISOString()` 抛 `RangeError: Invalid time value`(实测)⇒ `writeSamples` 整条多行 INSERT 失败 ⇒ 3 次重试后**整批(最多 5000 行、跨全部节点)被丢弃**;④ 同理 `value:'abc'` 会以 TEXT 落进 `REAL NOT NULL` 列(实测 `typeof(value)=text`),之后 `query()` 的 `Number(r.value)` 变 NaN、前端折线断点。
- **Fix**:在 `onSampleFromQueue`(`:609-614`)入管线前做一次归一校验:`Number.isFinite(tsMs) && Number.isFinite(Number(env.value))` 不过则计数丢弃(`envelopeRejected++`)并 `log.warn`;或在 `MqttQueueAdapter` 的 message 回调里用共享的 `parseSampleEnvelope()`(与 `shared/daq-protocol.ts` 同源的运行时守卫)过滤。`onSample` 内把 `if (tsMs && ...)` 改成显式 `if (!Number.isFinite(tsMs)) return 'late'`(或新增 `'invalid'` verdict)以免污染 `lastIngestAt`。
- **Verification**:`node scripts/_audit/exp-envelope-and-png.mjs`(A1/A2 段,实测 NaN 静默丢行、字符串落 TEXT)与 `node -e "console.log(new Date(NaN).toISOString())"`(RangeError)。端到端:向 `aw/daq/<nodeId>/sample` 发一条 `{"nodeId":"<id>","value":1,"at":"nope"}` 的报文,断言该节点仍能判定迟到帧且 `meta` 里出现拒绝计数。

### [P1] MQTT 驱动:每次采样可阻塞 3s + 4s 建连,且 `close→evict` 直接掐死自动重连
- **Where**: `server/services/workshop/daq/drivers.ts:817-838`(sample 的 3s 忙等)、`:716-778`(`getMqttConn` 与 `evict`)、`:758-768`
- **Evidence**:
```ts
    const entry = conn.topics.get(topic)!
    const t0 = Date.now()
    while (!entry.raw && Date.now() - t0 < 3000) await sleep(100)
    if (!entry.raw) return null
```
```ts
  const evict = () => {
    if (mqttPool.get(key) === conn) {
      mqttPool.delete(key)
      try { client.end(true) } catch { /* 已死 */ }
    }
  }
  client.on('error', evict)
  client.on('close', evict)
```
- **Impact**:① `sample()` 是 tick 内的 await,一个「已订阅但设备不发报文」的 MQTT 节点每拍占用一个采样额度最长 **3s**;broker 不可达时 `getMqttConn` 还要先等 `connectTimeout: 4000`(:735)。② `close` 事件即 evict + `end(true)`,而 `end(true)` 会**终止 mqtt.js 的自动重连**(注释自陈是刻意为之),于是每次 `sample()` 都新建 TCP 连接并重订阅:broker 抖动时形成「每采样一次一条新连接」的连接风暴,并把上面 4s+3s 的阻塞不断重复。③ 与 8 额度闸门叠加 = 队头阻塞:实测(逐行复刻 sweep 模拟)单节点采样 3s 时,50 节点 60s 内总达成率仅 **5.4%**,且尾部节点 0 次(「sweep 闸门尾部饿死」)。健康节点会被坏 broker 拖死。
- **Fix**:① 把「等待首帧」改成非阻塞:订阅后立即返回 `null`(本拍不发样本),由后续采样读缓存 —— 与 modbus 的 `pending > 8` 跳帧同思路(`:417`);若必须等待,把 3000ms 降到 ≤ 采样周期并改用一次性 `setTimeout` 而非 100ms 轮询。② 不要在同一 `close` 上既驱逐又 `end(true)`:保留 `client.on('close', clearCaches)` 与 `reconnectPeriod` 让 mqtt.js 自行重连,仅在 `error` 且 `client.connected === false` 且重连连续失败 N 次后 evict;重连成功后重新 `subscribe`(现在 `topics` 缓存里已有条目,`sample()` 不会再订阅 —— 这正是必须由库自行重连的原因)。
- **Verification**:把 `host` 指向一个可连但不发消息的 broker,建 1 个 mqtt 节点并记录 `Date.now()` 差:`await resolveDaqDriver('mqtt').sample(...)` 当前耗时 ≈3000ms;修复后应 < 1 个采样周期。断网 30s 观察 `netstat`/broker 侧连接数:当前每次采样新建一条连接。

### [P1] `mqttPool` 既无空闲回收也从不 unsubscribe/close:连接、订阅与报文缓存随节点生命周期只增不减
- **Where**: `server/services/workshop/daq/drivers.ts:710-778`(池与连接)、`:821-831`(只 subscribe),对照 `:462-478`(modbus sweep)与 `:493-515`(opcua sweep)
- **Evidence**:
```ts
const mqttPool = new Map<string, MqttConn>()
...
function mqttKey(cfg: Record<string, unknown>): string {
  return `mqtt://${cfg.host}:${cfg.port ?? 1883}|${cfg.username ?? ''}`
}
```
  modbus/opcua 各有一个 `setInterval(..., 120_000)` 的 `lastUsed` 空闲回收 sweep;`mqttPool` 没有任何 sweep,`DaqController.remove()`(`daq-controller.ts:1020-1036`)也只删运行时、不动驱动池。
- **Impact**:① 每个「host:port|username」组合常驻一个 MQTT 客户端 socket + keepalive(`drivers.ts:732-737` 只设了 `connectTimeout/reconnectPeriod`,keepalive 取 mqtt.js 缺省 60s;队列适配器那边才显式设了 `keepalive: 20`,`mqtt.adapter.ts:55`)与逐主题订阅,节点删除、主题改名、配置改 host 都不会释放;② `conn.topics`(`:748`)以 topic 为键只增不减,且断线清缓存也保留键(`:769-775`);③ 长期运行的网关会累积「幽灵订阅」:broker 侧仍向已废弃 topic 投递,本进程继续解析(`JSON.parse`)并占用内存 —— 而 MQTT 驱动的 `topics` 缓存还持有最近原始报文(`{raw, at}`)。
- **Fix**:给 `mqttPool` 补一个与 modbus/opcua 同构的空闲回收:在 `MqttConn` 上加 `lastUsed`,在 `sample()`/`test()` 命中时刷新,新增 `setInterval(120s)` sweep(空闲 >10min 时 `client.end(true)`、`removeAllListeners()`、`mqttPool.delete(key)`);并在 `DaqController.remove(id)` 中按该节点的 `driverConfig` 主动释放(需要驱动层暴露 `release(cfg)` 钩子 —— modbus/opcua 已各有 `evict*`,mqtt 缺失,应补齐 `evictMqttConn(cfg)` 并在 `remove()`/`patch(driverConfig)` 时调用)。
- **Verification**:建 2 个指向不同 broker 的 mqtt 节点 → 删除它们 → `process._getActiveHandles()` 计数 / broker 侧 `$SYS` 连接数应下降。当前实现下连接与订阅都不消失(可用一个 mosquitto 容器 + `mosquitto_sub -t '$SYS/broker/clients/connected'` 观察)。

### [P1] `frames()` 的 pending 合并是 O(B²),且 `framesFromBuffer` 对每个候选行全量复制点列
- **Where**: `server/services/workshop/daq/daq-controller.ts:834-850`(`:842-847`)、`:806-824`(`:813` 的 `pointsFromMeta`)、`:452-460`(`previewOf` 反例,说明作者已知抽点成本)
- **Evidence**:
```ts
    const pending = this.frameBuffer.filter(r => r.nodeId === id
      && (opts.kind == null || r.kind === opts.kind)
      && r.tsMs >= (opts.fromMs ?? 0) && r.tsMs <= (opts.toMs ?? Date.now()))
      .filter(r => !seen.has(r.tsMs))
      .sort((a, b) => b.tsMs - a.tsMs)
      .map(r => this.framesFromBuffer(id, r.tsMs)[0] ?? null)
      .filter((r): r is DaqFrameRecord => r != null)
```
```ts
      out.push({
        at: r.tsMs,
        kind: r.kind,
        points: r.kind === 'vector' ? DaqController.pointsFromMeta(r.meta) : undefined,
```
- **Impact**:`FRAME_BUFFER_CAP = 2000`(:110)。`framesFromBuffer` 每次调用都要线性扫描整个 `frameBuffer`(:808),并在命中时为**每一个**同 ts 的行构造记录、执行 `pointsFromMeta`(对 ≤4096 点做 `every` + `map` 全量拷贝)。最坏情况(单节点 2000 条未刷盘帧,例如 TSDB 故障或停线后残余批次)一次 REST 调用 = 2000 × 2000 ≈ **4×10⁶ 次比较 + 2000 × 4096 ≈ 8×10⁶ 次元素拷贝**;`frameContent` 每次也付一次 O(B) + 至多一次 4096 点拷贝,而它只需要 image 行的 `objectKey`。前端每张缩略图都是一次 `frameContent`(`[id].vue:857-861` 一次渲染最多 30 张)⇒ 画廊首屏可触发 30 次该开销。
- **Fix**:① 给 `frameBuffer` 加索引:`private frameIndex = new Map<string, DaqFrameRow>()`(键 `${nodeId}@${tsMs}`,在 `ingestFrame` push 后 set、在 `flushTsdb` splice 时批量 delete),`framesFromBuffer` 变 O(1);② `frames()` 直接用索引取记录,去掉 `.map(framesFromBuffer)` 的二次扫描;③ `framesFromBuffer`/`pointsFromMeta` 增加 `needPoints` 参数,`frameContent` 路径不解析/不复制点列(source 与 `previewOf` 的抽点思路一致)。
- **Verification**:`node --expose-gc` 脚本或 `node:test` 单测:构造 2000 条 vector 帧(每条 4096 点)进 `frameBuffer`,计时 `controller.frames(id, { limit: 100 })`:当前实现 O(B²)(秒级),索引化后应 <10ms。也可直接压测 `GET /frames` 的 p95(2000 待刷盘帧下)。

### [P1] `DELETE /api/workshop/daq/:id` 缺少产线权限校验:任何登录用户可删除任意节点
- **Where**: `server/api/workshop/daq/[id].delete.ts:12-17`;对照 `server/api/workshop/daq/[id].patch.ts:19` 与 `server/services/workshop/permissions.ts:31-36`
- **Evidence**:
```ts
export default defineApiHandler((event) => {
  const user = resolveUser(event)
  bindDaqHost(broadcastSceneEvent)
  const id = getRouterParam(event, 'id') ?? ''
  const node = getDaqController().byId(id)
  getDaqController().remove(id)
```
```ts
  // 产线权限:参数下发=操控能力(readonly/无权用户 403)
  requireLineMode(user, getDaqController().byId(id)?.lineId, 'operate')
```
- **Impact**:`patch`/`bind`/`bindings`/`frames/content` 都做了 `requireLineMode`(readonly 或 operate),唯独删除只做「已登录」。对某产线只有 readonly(或无任何 grant)的用户可以直接 `DELETE` 该产线的全部数采节点 —— 破坏性且不可撤销(`remove()` 直接 `repo.remove(id)` 并 `flushNow()` 落盘,历史样本留在 TSDB),同时 `recordOps` 会把它记成一次正常操作。这是同族路由之间权限口径不一致导致的越权。
- **Fix**:在 `[id].delete.ts` 的 `resolveUser` 之后、`remove` 之前插入与 patch 同款的 `requireLineMode(user, getDaqController().byId(id)?.lineId, 'operate')`(并考虑对 `templates` 三个路由同样收敛到 admin/editor,当前仅 `resolveUser`)。更彻底的做法是在 `server/utils/response.ts` 的 `defineApiHandler` 上挂统一的 daq 产线守卫。
- **Verification**:建一个 role=user、无该产线 grant 的账号,`DELETE /api/workshop/daq/<lineNodeId>` 带其 cookie:当前返回 200 且节点消失;修复后必须 403 `LINE_FORBIDDEN`。可直接对 `GET /api/workshop/daq` 的可见列表与实际删除结果做对照断言。

### [P1] 无质量位/不确定度维度:OPC UA `Bad` 状态被当成通信故障丢弃,库表也无法记录坏值
- **Where**: `server/services/workshop/daq/drivers.ts:583-593`、`storage/tsdb-port.ts:15-26`(`DaqSampleRow` 无 quality 字段)、`daq-node.ts:127-139`(`deriveState` 只看量程)
- **Evidence**:
```ts
  const dv = await conn.session.read({ nodeId: node, attributeId: opcua.AttributeIds.Value })
  if (dv.statusCode.value !== 0) {
    throw new Error(`NodeId 读取状态异常: 0x${dv.statusCode.value.toString(16)}(检查 ns 与标识)`)
  }
```
```ts
export interface DaqSampleRow {
  nodeId: string
  tsMs: number
  value: number
  state: string
```
- **Impact**:OPC UA 的 `Uncertain`/`Bad`(传感器故障、维护中、超出量程 = 工业上典型的质量位)与「网络断线」在此被折叠成同一个异常路径:样本被丢弃、节点置 `offline`、`lastError` 写通信类文案。后果:曲线出现空洞而非「坏值段」;下游(Agent 的 `daq_query`、DCW 判据、配方窗口统计)无法区分「设备说这个值不可信」与「读不到」;`deriveState` 只用 min/max 派生 ok/warn/alarm,'uncertain' 无法表达。Modbus/HTTP/MQTT 路径也没有质量维度(Modbus 异常码被 `classifyCommError` 归一成文案,不进数据)。
- **Fix**:最小可用版本:`DaqSampleEnvelope`/`DaqSampleRow`/`daq_samples` 增加 `quality TEXT NOT NULL DEFAULT 'good'`('good'|'uncertain'|'bad'),`opcuaRead` 返回 `{value, quality}`(statusCode 高位判定:`0x80000000` → bad,`0x40000000` → uncertain)而不是抛错,`applyReading` 收到非 good 时保持上一状态并只落库 + 打点;前端在 `hist` 与折线里按段着色。
- **Verification**:`node -e` 无法覆盖 OPC UA;可用 `node-opcua` 的 sample server 注入一个 `StatusCodes.UncertainLastUsableValue` 的变量,断言 `daq_samples` 里该时刻的行带 `quality='uncertain'` 且节点不进入 offline(当前实现下会抛错且无行)。

---

## 3. P2

### [P2] 报警升级扫描无「上次升级时间」:任一未确认报警每分钟重复升级 + 重复外送,永不收敛
- **Where**: `server/services/workshop/daq/alarm-notify.ts:73-97`(`:81-89`)、`db/ops.repo.ts:92-94`
- **Evidence**:
```ts
    for (const a of repo.listOpen(200)) {
      if (Date.parse(a.createdAt) > cutoff) continue
      repo.escalate(a.id)
      notifyAlarm({ ... escalation: a.escalation + 1, ... })
    }
```
```ts
  const escalateStmt = db.prepare(
    `UPDATE alarm_events SET escalation = escalation + 1 WHERE id = ?`,
  )
```
  判定依据只有 `createdAt`(报警产生时刻),`alarm_events` 没有 `last_escalated_at` 列(`db/database.ts:232-245`)。
- **Impact**:`ESCALATE_SWEEP_MS = 60_000`,`alarmEscalateMinutes` 缺省 15。任何超过 15 分钟未 ack 的报警,此后**每 60 秒**被 `escalation+1` 一次并重发一次 webhook;`escalation` 无上限(升到几千),`notified_json` 只保留最后 10 条(`:64`)所以外送记录也看不出「已升级过」。10 个未确认报警 ⇒ 每分钟 10 次 webhook(每次最多 3 次尝试 × 5s 超时)+ 10 次 `repo.list(500)` 全表取回 + JSON.parse(:60-64),对钉钉/企微是骚扰级刷屏。
- **Fix**:由「首次升级时间」改为「下次升级时间」:表加 `last_escalated_at`(或复用 `notified_json` 的末条 at),扫描条件改为 `now - lastEscalatedAt >= escalateMin * 60_000 × 2^escalation`(指数退避)并设 `escalation` 上限(如 5);`notifyAlarm` 里把 `repo.list(500).find(...)` 换成按 id 单查(`ops.repo.ts` 已有 `nodeIdById` 的先例,可加 `byId`)。
- **Verification**:造 1 条 `created_at = now - 20min、acked_at IS NULL` 的报警,等 3 个扫描周期(直接调用扫描逻辑的等价单测更快),断言 `escalation` 只从 1 增到 2(而不是 +3)且只发 1 次外送;当前实现下 `escalation` 每次扫描都 +1。

### [P2] `alarmsRaised` 在去重之前自增:被幂等抑制的重复报警仍计入指标
- **Where**: `server/services/workshop/daq/daq-controller.ts:533-546`
- **Evidence**:
```ts
  private handleAlarm(node: DaqNode, value: number, rule: 'lt-min' | 'gt-max', threshold: number, metricKey?: string): void {
    this.alarmsRaised++
    const repo = getOps()?.alarmEvents
    ...
        const raised = repo.raise({ ... })
        if (!raised) id = '' // 已有同源未确认报警:不重复广播/外送
```
- **Impact**:`repo.raise()` 返回 false(同 node+metric 已有未确认报警)时不广播、不外送,但计数器已经 +1 —— `controllerState().alarmsRaised` 与前端 KPI 会虚高,与 `listAlarms()` 的实际记录数不一致(高精度工况下 state 在 alarm/warn 间抖动时,每条 raise 边沿都会 +1)。
- **Fix**:把 `this.alarmsRaised++` 移到 `if (!id) return` 之后(即只在真正新建报警时计数),或按 `raise()` 返回值累加。
- **Verification**:让某节点在阈值附近抖动(或单测直接连调两次 `handleAlarm` 同参),断言 `alarmsRaised` 只 +1 且 `GET /daq/alarms?scope=open` 只有 1 条。

### [P2] offline → ok 恢复被 3 帧去抖延迟,与注释声明的语义不符
- **Where**: `server/services/workshop/daq/daq-node.ts:142-163`(注释在 `:146`)
- **Evidence**:
```ts
    const raw = this.deriveState(v)
    // alarm/offline 立即切换(安全事件不等去抖);ok↔warn 需连续 3 帧一致
    if (raw === 'alarm' || raw === 'offline' || raw === this.state) {
```
- **Impact**:分支只覆盖「目标是 alarm/offline」与「状态未变」;`offline → ok`(驱动短暂抖动后恢复)、`warn → ok` 都落入 `else` 走 `stateCand` 计数,需要连续 3 帧(缺省 1s 周期 ⇒ 最长 3s)才切回 ok。对 `intervalMs` 配到 60s 的慢通道,恢复延迟可达 3 分钟。注释声称「offline 立即切换」只对「进入 offline」成立,恢复方向并非如此 —— 运维会看到 PLC 已恢复但界面持续 offline。
- **Fix**:把恢复方向也纳入立即切换:`if (raw === this.state || raw === 'alarm' || raw === 'offline' || this.state === 'offline' || this.state === 'alarm')` 直接落状态;或仅在 `ok ↔ warn` 之间保留去抖(更贴合注释原意)。
- **Verification**:`server/services/workshop/daq/daq-node.ts` 的单测思路:构造 node → `applyReading(v, t)` 使 state=warn → 直接置 `node.state='offline'` → 再 `applyReading(正常值)` 一次,断言 `node.state === 'ok'`(当前为 'offline')。

### [P2] 节点删除不清理历史样本 / 驱动内存态;`daq_samples` 与 `__daqMockStates` 残留
- **Where**: `server/services/workshop/daq/daq-controller.ts:1020-1036`、`drivers.ts:94-97`
- **Evidence**:
```ts
    this.repo.remove(id)
    this.runtimes.delete(id) // 运行时随节点注销
    ...
    const prefix = `${id}::`
    for (const key of this.metricStates.keys()) {
      if (key.startsWith(prefix)) this.metricStates.delete(key)
    }
```
  `metricStates` 被显式清理,但 `daq_samples`/`daq_frames` 行、对象存储 blob、mock 驱动的 `__daqMockStates`(`states.set(ctx.nodeId, st)` 且从无 delete)都不清理。
- **Impact**:「建节点 → 删节点」循环会永久累积 `__daqMockStates` 条目(小对象,但键集合随历史节点数单调增长)与 TSDB 行(直到 `tsRetentionH`/`frameRetentionH` 到期才回收,且 `latest()`/`queryTagged` 仍可能返回已删节点的行);同 id 重建(legacy 供给路径 `dn-lg-<twinId>` 是可预测 id)会继承旧读数与旧 mock 相位。
- **Fix**:`remove()` 里追加 `deleteMockState(id)`(`drivers.ts` 导出 `clearMockState(nodeId)`,`mockStates().delete(nodeId)`),并(可选)向 TsdbPort 增加 `purgeNode(nodeId)` 在删除节点时清理该节点行;至少要把「已删节点仍有历史」写进 UI 提示。
- **Verification**:建/删 100 个节点后断言 `globalThis.__daqMockStates.size === 0`(当前为 100);`SELECT COUNT(*) FROM daq_samples WHERE node_id='<deleted>'` 当前 > 0。

### [P2] 前端行状态基于 `Date.now()` 但无时间响应式依赖:通道「静默死亡」不会翻转成离线/过期
- **Where**: `app/components/workshop/DaqNodeRow.vue:28-41`、`:155-173`;调用点 `app/pages/daq/index.vue:1499-1501`
- **Evidence**:
```ts
function staleOf(n: DaqNodeLive): boolean {
  if (!n.lastAt) return true
  const iv = n.intervalMs ?? daq.controller.defaultIntervalMs
  return Date.now() - Date.parse(n.lastAt) > Math.max(iv * 4, 12_000)
}
```
```html
            <WorkshopDaqNodeRow v-for="n in filteredNodes" :key="n.id" :n="n" />
```
- **Impact**:`ctx` computed 读取 `Date.now()`,但时间不是响应式依赖;当某节点不再产生新样本(驱动持续返回 null、跳帧、产线门控外的静默停采)时,`n` 上没有任何字段变化 ⇒ 组件不重渲染、computed 不重算(父层 `daq.load()` 的 `Object.assign(old, raw)` 写入同值不触发,Vue 对同引用的子 props 会跳过更新)⇒ 行 pill 永久停在最后一次的 `ok/warn`,而 `staleOf()` 这个「诚实时间观」机制形同虚设。⚠UNVERIFIED(浏览器渲染语义推断,未在真实页面复现)
- **Fix**:把「当前时间」提升为响应式心跳:在 `useDaqStream` 里维护 `const nowTick = ref(Date.now())`(由已有的 5s `useVisibleInterval` 或 1s 轻量 tick 刷新),`DaqNodeRow` 改为 `staleOf(n, nowTick.value)` 并在模板/`ctx` 中读取它;或在 `store` 层按同一规则计算 `stale` 布尔并写回节点(服务端也可在 `toView()` 里带上 `lastAt` 的 age)。
- **Verification**:Playwright:建 1 个 mock 节点使其出值 → 断开驱动(把 driver 改成不可达的 http URL 并在服务端把 `sample` 返回 null,或直接停用产线开关外的门控)→ 等 >15s,断言行 pill 变为离线/过期;当前实现下仍显示 ok。

### [P2] 广播出口靠 REST 副作用装配:未访问过「绑定路由」的部署不会广播任何 DAQ 帧
- **Where**: `server/services/workshop/daq/daq-controller.ts:1179-1190`、`host-bindings.ts:68-71`;9 处调用点(`daq/index.get.ts:19`、`index.post.ts:17`、`controller.post.ts:20`、`test-driver.post.ts:18`、`[id].patch.ts:15`、`[id]/test.post.ts:13`、`[id]/bind.post.ts:15`、`[id]/bindings.put.ts:15`、`[id].delete.ts:14`)
- **Evidence**:
```ts
export function bindDaqBroadcast(fn: BroadcastFn | null): void {
  getDaqController().setBroadcast(fn)
  void getDaqQueue().then((q) => { g_queueBackend = q.backend }).catch(() => {})
}
```
- **Impact**:`this.broadcast` 只在上述路由被执行过之后才非空;而管线上电(`ensureLoop` → `pipelineReady`)还会被 `samples()`/`listViews()` 触发(`:794`、`:784`)。因此「只调 `/daq/:id/samples`(Agent 取数)或只跑 headless 采集」的场景下,样本照常入库、`emitDaqSample` 照常发插件事件,但 `daq.reading/daq.frame/daq.alarm/daq.controller` **一条 WS 帧都不会广播**,且故障时静默(没有「广播出口未装配」的任何日志或 meta 标记)。注释 `:1180-1183` 把「小镇页首访必经 GET /api/workshop/daq」当作保证,属于隐式顺序耦合。
- **Fix**:把 `bindDaqHost(broadcastSceneEvent)` 从各路由的 handler 里上移到模块级(Nitro 路由模块加载即执行,`bindDaqBroadcast` 内部已幂等),或在 `ensureLoop()` 里做一次自装配并在 `controllerState()` 暴露 `broadcastBound: boolean` 供运维观察。
- **Verification**:重启进程后**只**请求 `GET /api/workshop/daq/<id>/samples`(带已连接 WS 的客户端),断言能收到 `daq.reading`;当前实现下收不到。

### [P2] SQLite 保留期清理的执行计划是 SCAN,且同步阻塞主线程
- **Where**: `server/services/workshop/daq/storage/sqlite.adapter.ts:87-104`(`:93-95`)、`:276-285`(`:280`)、索引定义 `:47`、`:73`
- **Evidence**:
```
DELETE FROM daq_samples WHERE rowid IN (SELECT rowid FROM daq_samples WHERE ts_ms < ? LIMIT 5000)
DELETE FROM daq_frames WHERE ts_ms < ?
```
  实测执行计划:`SEARCH daq_samples USING INTEGER PRIMARY KEY (rowid=?) / LIST SUBQUERY 1 / SCAN daq_samples USING COVERING INDEX idx_daq_node_ts`;帧表为 `SCAN daq_frames`。既有索引是 `(node_id, ts_ms DESC)`,没有任何以 `ts_ms` 打头的索引。
- **Impact**:两处清理都是全索引/全表扫描;`node:sqlite` 是同步 API,`sweepRetention/sweepFrameRetention` 在 `init()` 与每 30 分钟的 timer 里同步执行,期间事件循环停摆(WS 广播、采样、REST 全部排队)。实测单批 5000 行 DELETE 在 5 万 / 200 万 / 800 万行表上分别为 18.2 / 11.6 / 32.7 ms(⚠规模未外推到 30M 行稳态,但代价随表增长)。可控但不该出现在主线程。
- **Fix**:① 加 `CREATE INDEX IF NOT EXISTS idx_daq_samples_ts ON daq_samples(ts_ms)`(以及 `idx_daq_frames_ts ON daq_frames(ts_ms)`),让子查询走范围扫描;② 保留期清理移到 `node:worker_threads` 或独立连接 + `setImmediate` 分片执行,避免长同步块。
- **Verification**:`node scripts/_audit/exp-retention-plan.mjs`(打印上述 SCAN 计划与耗时);加索引后同一脚本应输出 `SEARCH … USING INDEX idx_daq_samples_ts (ts_ms<?)`。

### [P2] Timescale 保留期用 `drop_chunks` 但建表未指定 chunk 间隔:配置的保留期不精确
- **Where**: `server/services/workshop/daq/storage/timescale.adapter.ts:41-43`、`:68-81`;缺省 `tsRetentionH=168` / `frameRetentionH=720` 见 `settings.ts:185-186`
- **Evidence**:
```ts
    await this.pool.query(
      `SELECT create_hypertable('daq_samples', 'ts', if_not_exists => TRUE, migrate_data => TRUE)`,
    )
```
```ts
        `SELECT drop_chunks('daq_samples', older_than => now() - ($1 || ' hours')::interval)`,
```
- **Impact**:`drop_chunks` 只能整块丢弃,块边界由创建 hypertable 时的 `chunk_time_interval` 决定;此处未指定 ⇒ 采用扩展缺省值(⚠UNVERIFIED:无法在本会话连接 Timescale 验证缺省值,按 Timescale 文档缺省为 7 天)。若缺省确为 7 天,则 `tsRetentionH=168`(7 天)的实际保留会在 7~14 天之间摆动;若运维把 `tsRetentionH` 调成 24h,实际仍会保留约 7~14 天(既占盘又不符合配置语义)。SQLite 后端不存在该问题(按行删除)。
- **Fix**:显式指定 `chunk_time_interval`,并让它与保留期成比例:`create_hypertable('daq_samples','ts', chunk_time_interval => interval '1 day', if_not_exists => TRUE, migrate_data => TRUE)`(帧表同理);对已有 hypertable 用 `set_chunk_time_interval` 迁移一次。
- **Verification**:有 Timescale 实例时 `SELECT * FROM timescaledb_information.dimensions WHERE hypertable_name='daq_samples'` 查看 `time_interval`,并 `SELECT drop_chunks(...)` 前后对比 `MIN(ts)`;无实例则至少断言 DDL 中出现 `chunk_time_interval`(静态检查)。

### [P2] 「端口未装配」时绑定接口把降级语义变成 404(`!undefined` 恒真)
- **Where**: `server/services/workshop/daq/daq-controller.ts:1041-1043`、`:1056-1058`、`:1084-1088`;对照同类判断 `:690`(`if (!host) return // 端口未装配…跳过回写`)
- **Evidence**:
```ts
    if (deviceId && !getDaqHostPorts()?.telemetry.deviceExists(deviceId)) {
      throw new AppError(404, ErrorCodes.NOT_FOUND, `目标设备不存在: ${deviceId}`)
    }
```
- **Impact**:`getDaqHostPorts()` 为 null 时可选链短路成 `undefined`,`!undefined === true` ⇒ 无论设备是否存在都抛「目标设备不存在」,把「边缘独立运行/端口未装配」伪装成业务 404(与 `writeBackTelemetry` 的降级处理自相矛盾)。当前 REST 路径在调用前都先执行了 `bindDaqHost()`(`[id]/bind.post.ts:15` 等)故**暂不可达**;但 daq 模块的设计目标之一就是可脱离中心平台独立装配(`host-ports.ts:1-10`),届时这条路径会直接失效。
- **Fix**:改为显式判空:`const host = getDaqHostPorts(); if (!host) { /* 边缘模式:跳过存在性校验,允许先绑定 */ } else if (deviceId && !host.telemetry.deviceExists(deviceId)) throw ...`(三处 `bind`/`bindDevice`/`setDeviceBindings` 统一抽一个私有 `assertDeviceExists(id)`)。这正是 PLAN-ARCH-AUDIT.md P1-14 记录的同一问题,当前代码未修。
- **Verification**:单测里不调用 `bindDaqHostPorts` 直接 `new DaqController().bind(nodeId, 'dev-x')`,断言不抛 404(当前抛 `目标设备不存在: dev-x`)。

### [P2] 重复实现待合并(6 组,含精确行号)
- **Where**: `server/services/workshop/daq/daq-controller.ts:621-661`、`:348-351`、`:397-400`、`:827-831`;`server/services/workshop/daq/bus/inproc.adapter.ts:33-39`;`server/services/workshop/daq/bus/mqtt.adapter.ts:91-99`;`server/services/workshop/daq/drivers.ts:235-242`、`:412-432`、`:462-478`、`:493-515`、`:655-671`、`:821-836`、`:846-859`;`server/services/workshop/daq/storage/sqlite.adapter.ts:302-318`;`server/services/workshop/daq/storage/timescale.adapter.ts:254-270`;`server/api/workshop/ws.ts:248-257`
- **Evidence**(逐组同名实现):
  1. **同函数内两段重试+退避+计数**:`daq-controller.ts:621-640`(样本)与 `:642-661`(帧)除 `writeSamples/writeFrames` 与计数器名外逐行相同(~20 行 × 2)。
  2. **「有界缓冲 + 满则丢最旧」5 份**:`daq-controller.ts:348-351`、`:397-400`;`bus/inproc.adapter.ts:33-39`;`bus/mqtt.adapter.ts:91-99`;`ws.ts:248-257`(第 5 种语义:回队重试)。
  3. **`pointsFromMeta` 3 份**:`daq-controller.ts:827-831`、`storage/sqlite.adapter.ts:302-306`、`storage/timescale.adapter.ts:254-258`(规则相同但各自维护,注释已自陈「与 TSDB adapter 同规则」);`asObject` 2 份:`sqlite.adapter.ts:308-318`、`timescale.adapter.ts:260-270`。
  4. **连接池空闲回收 2 份 + 1 处缺失**:`drivers.ts:462-478`(modbus)与 `:493-515`(opcua)结构相同;mqtt 缺失(「MQTT 驱动阻塞与连接池不回收」)。
  5. **modbus 两驱动 body 相同**:`drivers.ts:412-432`(tcp)与 `:655-671`(rtu)除 `transport` 实参外一致;mqtt 的「订阅 + 等首帧」在 `:821-836`(sample)与 `:846-859`(test)重复。
  6. **fire-and-forget close 5 份**:`drivers.ts:225`、`:261`、`:314`、`:470`、`:503-507`(已有 `closeModbusSafely` `:235-242` 却未被统一使用);另有 9 个 daq 路由重复 `bindDaqHost(broadcastSceneEvent)` 样板。
- **Impact**:「写失败重试耗尽丢批 + 丢弃计数失真」(计数口径)、「场景广播无慢消费者保护」(是否回队)、「MQTT 驱动阻塞与连接池不回收」(池是否回收)这三类**语义分叉正是由复制粘贴造成的** —— 同一个「队列/缓冲」概念在 5 处有 4 种行为,修一处漏一处。维护成本随 DAQ 形态(标量/vector/image)线性增长。
- **Fix**:按组抽公共件:① `private async writeWithRetry<T>(rows: T[], write: (rows: T[]) => Promise<void>, onDrop: (n: number) => void)`;② `class BoundedDropBuffer<T>`(`push` / `drainAll` / `overflowed` / `dropped`)放 `daq/bus/` 或 `shared/`,四处替换(ws.ts 的变体用 `requeueOnFailure` 选项);③ `shared/tsdb-codec.ts` 导出 `pointsFromMeta`/`asObject`,`daq-controller.ts:813` 与两个 adapter 统一 import;④ `shared/pool-sweep.mjs` 导出 `startIdleSweep(pool, { idleMs, onEvict })`,modbus/opcua/mqtt 三处复用;⑤ `makeModbusDriver(transport)` 工厂消除 tcp/rtu 双份;⑥ 把 `bindDaqHost` 上移到路由模块顶层去掉 9 处样板。
- **Verification**:`grep -n "writeSamples(batch)" server/services/workshop/daq/daq-controller.ts` 应只剩 1 处调用;`grep -rn "pointsFromMeta" server/` 应只剩定义处 + import;重构后既有 `node scripts/test-daq-frame-race.mjs`、`scripts/_dbg-daq-frames-e2e.mjs`、`scripts/test-lru.mjs` 必须全绿。

---

## 4. 附录

### 4.1 本报告使用的复刻实验(均在 `scripts/_audit/`)
| 脚本 | 用途 | 关键输出 |
|---|---|---|
| `exp-retention-plan.mjs` | 复刻 `sqlite.adapter.ts` DDL + 保留期 DELETE,打执行计划 | `SCAN daq_samples USING COVERING INDEX idx_daq_node_ts`、`SCAN daq_frames` |
| `exp-cost-scaling.mjs` | 表规模对批量 DELETE 的影响;`inproc` 队列 `shift()` 代价 | 5万/50万/200万行 = 18.2/12.2/11.6ms;20 万次 publish(溢出丢最旧)= 16.0ms vs 仅 push 1.2ms |
| `exp-retention-rescan.mjs` | 单批 DELETE 在 800 万行表上的重扫代价 | 32.7ms/批 |
| `exp-envelope-and-png.mjs` | 坏 `at`/字符串 value 落库后果;图像帧体积 | NaN 行被 `INSERT OR IGNORE` 静默吞掉;`value='abc'` 落为 TEXT;帧 77.9 KB |
| `exp-png-decode.mjs` | 复刻 `decodeGrayPng` 对 filter type≠0 的 PNG 解码 | truth 50/90/130/170 → decoded 50/40/40/40,maxErr=130,亮度 110.0→42.5 |
| `exp-sweep-fairness.mjs` | 逐行复刻 `sweep()` 额度分配 | 50 节点 @1s:总达成 64.3%,**后 18 个节点 60s 内 0 次采样** |

### 4.2 审计过程中确认「已修复 / 无问题」的项(避免重复劳动)
- 帧竞态防抖窗口:已由 `framesFromBuffer` 读穿透修复(`daq-controller.ts:801-824`,与 PLAN-ARCH-AUDIT.md P0-4 的推荐方案 (b) 一致)。
- sweep 并发闸门:已加(`SWEEP_MAX_CONCURRENCY=8`,PLAN-ARCH-AUDIT.md P1-6 已闭环)——但调度公平性是新问题(「sweep 闸门尾部饿死」)。
- DAQ 模块 9 个 `setInterval` 全部 `.unref?.()`;`MqttQueueAdapter.close()` 已 `removeAllListeners()`(PLAN-ARCH-AUDIT.md P1-7 已闭环)。
- `metricStates`/`twinPushAt` 已随节点/设备删除清理(`:1028-1030`、`:1102`),不再无界。
- 时间单位统一 epoch ms + ISO;SQLite 桶聚合用整数字面量内插规避浮点除法(`sqlite.adapter.ts:132-135`),数学正确。
- SQLite 批量写单事务 + `INSERT OR IGNORE`(`:109-115`)、Timescale 参数化多值 INSERT(`timescale.adapter.ts:92-105`)写法正确(除 NaN 边界,「队列信封不校验」)。
- `scene-events.broadcastSceneEvent` 已做「序列化一次全 peer 复用」与产线可见性过滤(`:66-81`),仅缺慢消费者保护。
- 报警入库去重(同 node+metric 未确认幂等,`ops.repo.ts:112-129`)正确。
