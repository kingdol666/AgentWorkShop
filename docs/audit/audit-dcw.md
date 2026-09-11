# DCW(数控 / numeric control)链路审计报告

- **审计对象**:`server/services/workshop/dcw/**`(controller / runtime / drivers / rollback ledger / repos / line-run)、`server/api/workshop/dcw/**`(全部 handler)、`server/services/workshop/permissions.ts`、`server/repositories/user.repository.*`、`app/pages/dcw/index.vue`、`app/pages/dcw/[id].vue` + `app/composables/workshop/useDcwStream.ts`
- **链路**:Recipe → write transaction → driver → ACK → rollback ledger → line run
- **方式**:逐文件阅读(引用均为当前工作区代码的 `file:line`)+ 5 个只读实验(`scripts/_audit/`,真实服务对象 + 打桩 host + 本地假 PLC,**未修改任何源文件**)
- **运行环境**:Node v24.19.0;实验统一入口 `node --experimental-transform-types scripts/_audit/run.mjs scripts/_audit/<exp>.ts`(tsx/esbuild 在本沙箱 spawn 被拒 EPERM,故用 Node 原生类型擦除 + `scripts/_audit/ts-resolve-hook.mjs` 解析仓库的无扩展名相对导入与 `@/` 别名)
- **数据隔离**:仓库已在 2026-09-11 11:12 迁移到 `ensureDataDir()`(配置根 `<repo>/.AgentWorkShop/data`),单纯 `chdir` **不再隔离**;`run.mjs` 现在强制注入 `AW_DATA_DIR/AW_MODE=home/AW_HOME` 指向 `scripts/_audit/.tmp/`,所有实验落盘都进临时目录(本轮早期版本曾因此污染线上数据根,已修复并留证 —— 见文末「数据隔离事故」与 P2「数据根解析」)
- **修订说明**:审计期间(11:12:10–11:12:20)另有 agent 把这 7 个 DCW 仓库文件迁移到 `ensureDataDir()`(`dcw-node.repo` / `dcw-line.repo` / `dcw-product.repo` / `dcw-recipe.repo` / `dcw-templates` / `recipe-rollback.repo` / `line-run`)。本文所有行号已按**迁移后当前修订**校正(`recipe-rollback.repo.ts` 与 `dcw-recipe.repo.ts` 的正文未变,仅持久化路径段替换,行号整体 -1);controller / runtime / manager / drivers / 全部 API handler 在审计窗口内**未被改动**,行号与实测输出一一对应
- **实验清单**
  | 实验 | 脚本 | 证明对象 |
  |---|---|---|
  | 1 | `scripts/_audit/dcw-write-mutex.ts` | 写在飞互斥 / 心跳闸门 / 周期读互斥 |
  | 2 | `scripts/_audit/dcw-rollback-ledger.ts` | 账本算法复杂度与落盘成本 |
  | 3 | `scripts/_audit/dcw-unrecorded-write.ts` | 「写已落硬件但 ACK 失败」→ 未入账本;超时语义 |
  | 4 | `scripts/_audit/dcw-flush-cost.ts` | 真实数据规模下的落盘放大 |
  | 5 | `scripts/_audit/dcw-controller-e2e.ts` | 真实 DcwController 端到端:正常写 vs decimals 异常写 |

> 所有「未亲自跑通/仅读码推断」的结论一律标注 `⚠UNVERIFIED`。

---

## 结论速览

| # | 严重度 | 结论 | 位置 |
|---|---|---|---|
| 1 | **P0** | 回读 ACK 失败时写已落到 PLC,但账本不入册 → 不可回退写 + 回滚点错位 + 心跳用陈旧回读值重写 | `drivers.ts:203-219`、`dcw-controller.ts:536` |
| 2 | **P0** | `PATCH /api/workshop/dcw/:id` 无角色/产线校验 → 任意登录用户可改 driverConfig/min/max/decimals/holdIntervalMs,并借网关保写心跳把任意值写到任意目标 | `[id].patch.ts:10-16`、`dcw-controller.ts:361-405`、`dcw-runtime.ts:101-116` |
| 3 | **P0** | `decimals` 无校验 → 后续写「先落硬件、后抛 RangeError」→ 无账本锚、无写历史、调用方 500 | `dcw-controller.ts:167,176,375`、`dcw-node.ts:118` |
| 4 | **P1** | 保写心跳下发从不进账本/优化记录(grep 证实 `afterWrite` 仅 `write()` 调用) | `dcw-runtime.ts:109-115`、`dcw-controller.ts:538` |
| 5 | **P1** | 周期读的在飞互斥失效(`this.reading` 从未被 tick 置位)→ 同节点实测 2 条并发读 | `dcw-runtime.ts:119-124,128-137` |
| 6 | **P1** | 账本 cap 稳态每次 append O(cap)(实测 3.5ms);`flushNow()` 每次 agent/回退写同步序列化 10.9MB(实测 40ms) | `recipe-rollback.repo.ts:143-148,128-135`、`manager:159` |
| 7 | **P1** | 读侧产线授权缺口:journal / optimizations / param-ledger 只校验登录 | 4 个 handler(见正文) |
| 8 | **P1** | 写侧其余变更面越权:test-driver(SSRF)/建节点/配方与模板改删/产线改删仅 `resolveUser` | 见正文 |
| 9 | **P1** | `http` 写驱动只看 2xx、不回读比较 → ACK 语义弱于 modbus/opcua | `drivers.ts:585-604` |
| 10 | **P1** | 写在飞闸门无看门狗;MQTT `client.end()` 无超时 → 该节点可能永久 409 `⚠UNVERIFIED` | `drivers.ts:523-529` vs `daq/drivers.ts:235-242` |
| 11-20 | P2 | 跨微任务采样、闸门/状态机重复、ACK 比较重复、回退循环重复、open 索引双写隐患、读值落盘放大、模块级单例、线性查询与链计数归零、死代码与定时器卫生、数据根解析与测试隔离 | 见正文 |

---
### [P0] 回读 ACK 失败:写已落到硬件但账本不入册(不可回退写 + 回滚点错位 + 心跳重写陈旧值)
- **Where**: `server/services/workshop/dcw/drivers.ts:203-219`(modbus 写+回读判定)、`drivers.ts:305-316`(opcua 同构)、`server/services/workshop/dcw/dcw-controller.ts:532-538`(入册闸门)、`dcw-controller.ts:176` + `dcw-node.ts:117-118`(node.value 无条件覆写)
- **Evidence**:
  ```ts
  // drivers.ts:203-218 —— 先写,再回读判定;判定失败时硬件已被写入
  await conn.client.writeRegisters(offset, words)
  const rb = area === 'holding'
    ? await conn.client.readHoldingRegisters(offset, words.length)
    : await conn.client.readInputRegisters(offset, words.length)
  const rawBack = decodeRegisters(rb.data as number[], dataType, byteOrder)
  const engBack = rawToEng(rawBack, input)
  const ok = Math.abs(engBack - input.eng) <= input.tolerance
  ```
  ```ts
  // dcw-controller.ts:534-538 —— 注释已假设「失败写 = PLC 值未变更」
  // 调控闭环入册:仅成功写记锚/开记录(失败写不动账本 —— PLC 值未变更);
  if (outcome.ok !== false) {
    const rbInfo = getRecipeRollBackManager().afterWrite(node, eng, prevValue, ...)
  ```
  ```ts
  // dcw-controller.ts:176 + dcw-node.ts:117-118 —— 失败也把 value 改成 readback(可能是指令值)
  node.applyWriteResult(outcome.readback ?? eng, outcome.ok, outcome.message, at)
  applyWriteResult(eng, ok, message, at) { this.value = Number(eng.toFixed(this.decimals)) ... }
  ```
  实验 3(本地假 Modbus PLC,FC16 写/FC03 回读返回陈旧值 5)实测输出:
  ```
  驱动返回: ok=false raw=20 readback=5 message=回读偏差超容差:写 20,回读 5(容差 0.5)
  PASS  硬件寄存器已收到写入值 20 (reg0=20)
  PASS  ok=false 时账本未入册(闸门同构复刻)
  PASS  seeded 锚的 prevValue=5 仍是回退目标:回退将跳过真实的上一设定值 10
  PASS  node.value 被写成陈旧回读值 5(既非设定值 20 也非真实上一设定 10)
  ```
- **Impact**: ①硬件(寄存器/OPC 节点)已经变成 20,而账本最新稳定锚仍是 {prev:5,new:10} → `rollbackNode`/`rollbackRun` 会回退到 5,跳过真实的上一设定值 10(回滚点错位);②`node.value` 被写成陈旧回读值 5 → 配置了 `holdIntervalMs` 的节点,保写心跳会把 5 周期重下发到 PLC(既非操作员意图 20,也不是账本记录的 10),且心跳本身不入账;③操作员看到的是 `ok:false`,会认为"没写进去"。
- **Fix**: 给 `DcwWriteResult` 增加 `applied: boolean`(在 `writeRegisters`/`session.write` 返回成功后即置 true),`dcw-controller.ts:536` 的入册闸门改为 `if (outcome.applied !== false)`;`DcwNode.applyWriteResult` 拆成「ACK 记账」与「观测值回填」两件事,ACK 失败时不要把 `readback` 写入 `value`(或写入独立的 `lastReadback` 字段并标记 `unverified`)。
- **Verification**: `node --experimental-transform-types scripts/_audit/run.mjs scripts/_audit/dcw-unrecorded-write.ts`(A/C 段必须全 PASS:寄存器收到值、`ok=false`、账本无锚、回退目标仍是旧锚)。修好后该脚本 A 段应变为「`applied=true` 且账本新增锚」。

---
### [P0] `PATCH /api/workshop/dcw/:id` 无角色/产线校验 → 任意登录用户改写驱动与安全量程,借保写心跳实施任意硬件写
- **Where**: `server/api/workshop/dcw/[id].patch.ts:10-16`;`server/services/workshop/dcw/dcw-controller.ts:361-405`;`server/services/workshop/dcw/dcw-runtime.ts:101-116`;对照 `server/api/workshop/dcw/[id]/write.post.ts:18-19`
- **Evidence**:
  ```ts
  // [id].patch.ts:10-16 —— 只有认证,没有 requireRole / requireLineMode
  export default defineApiHandler(async (event) => {
    resolveUser(event)
    bindDcwBroadcast(broadcastSceneEvent)
    const id = getRouterParam(event, 'id') ?? ''
    const body = await readBody<DcwPatchInput>(event) ?? {}
    const node = getDcwController().patch(id, body)
  ```
  ```ts
  // dcw-controller.ts:366-377 —— driver/driverConfig/min/max/decimals 全部无校验直写
  if (patch.driver !== undefined) node.driver = normalizeDcwDriverKind(patch.driver)
  if (patch.driverConfig !== undefined) node.driverConfig = { ...node.driverConfig, ...patch.driverConfig }
  ...
  if (patch.decimals !== undefined) node.decimals = patch.decimals
  if (patch.min !== undefined) node.min = patch.min
  if (patch.max !== undefined) node.max = patch.max
  ```
  ```ts
  // dcw-runtime.ts:101-110 —— 网关自己会把 node.value 周期写到 node.driverConfig 指向的目标
  if (!this.writing && node.enabled && node.value != null && node.state !== 'writing') {
    const hold = node.holdIntervalMs ?? this.host.defaults().holdIntervalMs
    if (hold && hold > 0 && now - this.lastHoldAt >= hold) {
      ... this.host.executeWrite(node, node.value!, writeTolerance(node), null)
  ```
  对照:同目录的写/绑定/测试/删除端点都做了校验 —— `write.post.ts:19 requireLineMode(user, ..., 'operate')`、`bind.post.ts:16`、`bindings.put.ts:17`、`test.post.ts:16`、`[id].delete.ts:12 requireRole(event)`。
- **Impact**: 一个在 `user_line_grants` 中**没有任何产线权限**(或只有 readonly)的 `role='user'` 账号,可以对任意节点 `PATCH {driverConfig:{host,port,register}, holdIntervalMs:500}`:只要该节点已有设定值(线上 `dcws.json` 实测 **313 个节点中 240 个 `value` 为数字**,全部 `enabled=true`;`holdIntervalMs>0` 的节点当前为 0 —— 而同一个 PATCH 就能把它设上)**不需要任何后续写操作**,网关自己的保写心跳就会把该设定值周期写到攻击者指定的 host:register(实验 1 [B] 段已证实:value≠null + hold 到点 ⇒ tick 直接 `executeWrite`)。同时 `min/max` 无校验可随意放宽 —— 而回读容差正是由量程推导(`dcw-runtime.ts:13-15 writeTolerance = max(0.5×10⁻ᵈ, (max-min)×0.005)`),放宽量程即放宽 ACK 判定;`decimals` 无校验则直接触发下面 P0-3 的不可回退写。`PATCH {lineId}` 还可把节点搬运到任意产线(绕过产线隔离)。
- **Fix**: `[id].patch.ts` 增加 `requireLineMode(user, getDcwController().byId(id)?.lineId, 'operate')`;`driver/driverConfig/min/max/decimals/lineId` 这几类"改变执行语义"的字段再加 `requireRole(event, ['admin','editor'])`;`DcwController.patch` 内做字段级校验(`min < max`、`decimals ∈ [0,4]` 与 `dcw-templates.ts:45` 对齐、driverConfig 必填项按 `DCW_DRIVERS[].configFields` 校验)。
- **Verification**: 代码层已核对(上述四行);服务层事实由实验 5 证实(`ctrl.patch(id,{decimals:101})` 被接受)。攻击链的 HTTP 端到端复现 `⚠UNVERIFIED`(需带 `role='user'` token 的两个请求),建议补一条 API 级用例:`PATCH /api/workshop/dcw/:id`(无产线授权 token)必须 403。

---
### [P0] `decimals` 无校验:后续写「已落硬件 → 记账抛 RangeError」→ 无账本锚、无写历史、调用方 500
- **Where**: `server/services/workshop/dcw/dcw-controller.ts:167`、`:176`、`:375`;`server/services/workshop/dcw/dcw-node.ts:118`
- **Evidence**:
  ```ts
  // dcw-controller.ts:167(DC driver 返回后的成功路径,在 try 内 → 异常被吞成 ok=false)
  if (outcome.ok) outcome.message = `${outcome.message}(标定后物理值 ${Number((outcome.readback ?? eng).toFixed(node.decimals))})`
  // dcw-controller.ts:176(在 try 之外 → 异常直接抛穿 executeWrite,后续记账全部跳过)
  node.applyWriteResult(outcome.readback ?? eng, outcome.ok, outcome.message, at)
  // dcw-node.ts:117-118
  applyWriteResult(eng: number, ok: boolean, message: string, at: string): void {
    this.value = Number(eng.toFixed(this.decimals))
  // dcw-controller.ts:375 —— patch 不校验 decimals(dcw-templates.ts:45 对模板却校验 0~4)
  if (patch.decimals !== undefined) node.decimals = patch.decimals
  ```
  实验 5(真实 `DcwController` + mock 驱动)实测:
  ```
  PASS  PATCH decimals=101 被接受(无校验) (decimals=101)
  写 170 抛错: RangeError: toFixed() digits argument must be between 0 and 100
  PASS  mock PLC 已记录 170(硬件写入已发生) (plc=170)
  PASS  账本未新增锚(这次硬件变更无法回退) (anchors=1)
  PASS  写历史未新增条目(审计缺失) (n=1)
  PASS  节点 state=error 且 value 仍是旧值 160
  PASS  写入抛出异常(调用方得到 500 而非 ACK)
  ```
- **Impact**: 一次 `PATCH {decimals:101}`(任意登录用户,见上一条)之后:(a) 任何写(手动/配方/Agent/心跳)都会把值真正写到 PLC,然后在 `applyWriteResult` 抛 `RangeError`;(b) 抛穿 `executeWrite` ⇒ `afterWrite`(账本)、`appendHistory`(写历史)、`recordOps`、`WS 广播` **全部跳过**;(c) API 层 `defineApiHandler` 的兜底把未知异常转成 **HTTP 500 `INTERNAL_ERROR`**(`server/utils/response.ts`,已读),操作员只看到"服务器内部错误",而硬件已经动了;(d) 心跳路径同样中招,但它的 `.catch(() => {})`(`dcw-runtime.ts:111`)会把错误完全静默 → 形成**每 holdIntervalMs 一次、无账本、无历史、无告警的隐形硬件写循环**。
- **Fix**: `patch()`/`create()` 对 `decimals` 做 `Math.max(0, Math.min(4, Math.round(v)))`(与 `dcw-templates.ts:44-45` 同一口径);把 `dcw-node.ts` 里的 `toFixed(this.decimals)` 统一换成受保护的 `fmt(v, decimals)` 帮助函数(钳制 0~100),使记账路径永不可能抛错。
- **Verification**: `node --experimental-transform-types scripts/_audit/run.mjs scripts/_audit/dcw-controller-e2e.ts`(当前 ALL PASS = 缺陷存在;修复后"账本未新增锚/写历史未新增条目"两条应转为"新增",且写请求应返回 400 校验错误而不是 500)。

---
### [P1] 保写心跳下发从不进账本:硬件可能被改而零记录
- **Where**: `server/services/workshop/dcw/dcw-runtime.ts:109-115` → `dcw-controller.ts:141-142` → `dcw-controller.ts:150-207`
- **Evidence**:
  ```ts
  // dcw-runtime.ts:109-111 —— 心跳直调 host.executeWrite(只共享 writing 闸门,不走 controller.write)
  void Promise.resolve()
    .then(() => this.host.executeWrite(node, node.value!, writeTolerance(node), null))
    .catch(() => { /* 保写失败不抛出:下一拍重试 */ })
  ```
  ```ts
  // dcw-controller.ts:141-144 —— host.executeWrite 直接绑到私有 executeWrite
  executeWrite: async (node, eng, tolerance, recipeRunId) => this.executeWrite(node, eng, tolerance, recipeRunId),
  ```
  `grep -n "afterWrite" server/**` 结果:**只有 `dcw-controller.ts:538` 一处调用**,而 `executeWrite`(150-207)内没有 `afterWrite`/`beforeWrite` —— 即心跳路径只做"驱动写 + applyWriteResult + flushDebounced + appendHistory + 广播"。
- **Impact**: 心跳对硬件的任何实际改动都不会产生锚/优化记录:正常情况下它重下发的是同一个设定值(幂等,影响有限),但与 P0-1 组合后,`node.value` 已被陈旧回读值污染(实测 =5),心跳会把 5 周期写到 PLC —— 账本仍记着"当前 10",没有任何锚/记录能说明硬件为何变成 5,也无法回退到 20。心跳写历史条目也无 `recipeRunId`,与真实下发帧无法区分(`dcw-recipe.repo.ts:403-406` 的窗口兜底会把心跳帧算进批次)。
- **Fix**: 让心跳走 `controller.write(node.id, value, null, { source: 'keepalive', actor: 'system' })`,在 `RecipeRollBackManager.afterWrite` 里把 `keepalive` 归入现有的 5s 去重(`manager:118-121`)并按需补 `source: 'keepalive'` 的审计锚;或在 `executeWrite` 成功且写入值 ≠ 账本最新 `newValue` 时补记一条 `source='keepalive'` 锚。
- **Verification**: `grep -n "afterWrite" server/services/workshop/dcw/*.ts` 应只剩 `write()` 一处;修复后新增用例:配置 `holdIntervalMs=50` 的节点在无手动写的情况下,账本能看到 `source='keepalive'` 或至少"无漂移"断言。

---
### [P1] 周期读的在飞互斥失效:`readNow()` 可与周期读并发(实测 2 条在飞)
- **Where**: `server/services/workshop/dcw/dcw-runtime.ts:118-124` 与 `:128-137`
- **Evidence**:
  ```ts
  // dcw-runtime.ts:119-124 —— 只读 this.reading,从不置位
  if (this.reading || !node.enabled) return
  const readInt = node.readIntervalMs ?? this.host.defaults().readIntervalMs
  if (!readInt || readInt <= 0) return
  if (now - this.lastReadTick < readInt) return
  this.lastReadTick = now
  void this.host.executeRead(node).catch(() => {})
  ```
  ```ts
  // dcw-runtime.ts:128-130 —— 手动读依赖同一标志
  async readNow(): Promise<DcwReadOutcome> {
    if (this.reading) throw new AppError(409, ErrorCodes.CONFLICT, `通道「${this.node.name}」读取进行中,请稍后重试`)
  ```
  实验 1 [C] 段实测输出:
  ```
  FAIL  readNow() rejected (expect rejected:409) while periodic read in flight
        (actual=resolved; concurrent read pairs=1, maxInFlightReads=2)
  ```
  类注释 `dcw-runtime.ts:48` 自我声明 "同节点读不重入" —— 该不变量对 tick 方向不成立。
- **Impact**: 同一节点可同时有 2 条驱动读在飞。Modbus/OPC UA 有连接级串行,不会协议错乱,但链路负载翻倍、`applyReadResult` 后到者覆盖先到者(旧读结果盖新读结果,`lastReadAt` 回退),`mqtt`/`http` 类观测通道则直接向设备重复发请求。REST `POST /dcw/:id/read` 与 Agent `dcw_read` 都走 `readNow()`,因此在周期读(生产配置 2s)期间的手动读/Agent 读**永远拿不到 409**,`readNow` 的互斥形同废弃。
- **Fix**: `tick()` 里改成 `this.reading = true; void this.host.executeRead(node).finally(() => { this.reading = false })`,或直接复用 `void this.readNow().catch(() => { /* 忙则跳过本拍 */ })`。
- **Verification**: `node --experimental-transform-types scripts/_audit/run.mjs scripts/_audit/dcw-write-mutex.ts`(C 段当前 FAIL;修复后应 PASS,`maxInFlightReads=1`)。

---
### [P1] 账本 cap 稳态下每次 append 为 O(cap)(实测 2.7–3.5ms);`flushNow()` 在 Agent/回退写路径同步序列化 10.9MB(实测 30–40ms)
- **Where**: `server/services/workshop/dcw/recipe-rollback.repo.ts:143-148`(淘汰路径)、`:128-135`(`flushNow`)、`recipe-rollback-manager.ts:159`(写路径上的同步 `flushNow()`)、`recipe-rollback-manager.ts:398`
- **Evidence**:
  ```ts
  // recipe-rollback.repo.ts:143-148 —— 注释声称"避免每次追加都 O(cap)",但昂贵的两行在判断之前
  if (this.db.anchors.length > ANCHORS_CAP) {
    const evicted = this.db.anchors.splice(0, this.db.anchors.length - ANCHORS_CAP)   // O(cap) memmove
    const live = new Set(this.db.anchors.map(x => x.id))                              // O(cap) 分配(无条件执行)
    if (evicted.some(e => this.nodeAnchors.get(e.nodeId)?.some(x => x.id === e.id))) this.pruneIndexes(live) // 稳态恒真 → 又一次 O(cap)
  }
  ```
  ```ts
  // recipe-rollback-manager.ts:157-160 —— Agent/回退写入册后同步整库落盘
  anchor.recordId = record.id
  this.repo.flushNow()   // 非 debounced
  ```
  实验 2 实测(anchors 填满 20000 / records 填满 2000,记录含真实形状 windowAgg;两次隔离运行):
  ```
  appendAnchor(在上限稳态,每次触发 splice+new Set): per-op=2.728ms / 3.518ms  (iters=200)
  lastStableAnchor (O(1) 索引): per-op=0.000ms
  listOpenRecords (O(open)): per-op=0.002~0.003ms
  chainRollbackCount (全量 2000 filter): per-op=0.013~0.017ms
  flushNow(anchors=20000 + records=2000 含聚合): per-op=29.660ms / 39.954ms  落盘文件大小=10.92 MB
  ```
  线上真实账本现状(`server/data/dcw-rollback.json`,只读统计):anchors 616 / records 173 / open 19,文件 563 KB,平均锚 211 B、平均记录 1267 B(含 baseline/windowAgg 聚合)。
- **Impact**: 每达到上限后,每次成功写(manual/recipe/agent/rollback 全部)都要付 ~2.7–3.5ms 事件循环阻塞;Agent/回退写额外付 ~30–40ms 的整库 `JSON.stringify(…, null, 2)` + 原子写(Sweep 周期 500ms、同进程所有节点的心跳与 REST 都在这 30–40ms 内被推迟)。文件上限 ~11MB,且**每次**都全量重写。P1-9(上一轮审计的 `evaluateOpenRecords` 全量 reverse)确实已修复(实测 0.002~0.003ms/次,O(open)),但 P1-8 的"上限+索引"修复引入了新的 O(cap) 常态成本。
- **Fix**: ①把 `const live = new Set(...)` 与 `pruneIndexes` 的判断改为"仅当被淘汰锚确实仍在索引中"再构造(把第 146 行移到第 148 行的判断内),并把淘汰改成按批(每 N 条或长度 > cap×1.1 才裁);②`manager:159` 改 `this.repo.flushDebounced()`,把 `baseline/windowAgg` 这类大聚合移出主库(独立文件或截断);
- **Verification**: `node --experimental-transform-types scripts/_audit/run.mjs scripts/_audit/dcw-rollback-ledger.ts`(A 段 per-op 应回落到 <0.1ms,E 段 per-op 应 <5ms)。

---
### [P1] 读侧产线授权缺口:参数台账 / 变更账本 / 优化记录只校验"已登录"
- **Where**: `server/api/workshop/dcw/journal/index.get.ts:11-20`、`server/api/workshop/dcw/optimizations/index.get.ts:11-21`、`server/api/workshop/dcw/optimizations/[id].get.ts:11-16`、`server/api/workshop/dcw/[id]/param-ledger.get.ts:11-14`
- **Evidence**:
  ```ts
  // journal/index.get.ts:11-19 —— resolveUser 后直接用调用方给的 nodeId/lineId
  resolveUser(event)
  const q = getQuery(event)
  const anchors = getRecipeRollBackManager().journal({ nodeId: q.nodeId ? String(q.nodeId) : undefined, ... })
  ```
  ```ts
  // [id]/param-ledger.get.ts:11-13
  resolveUser(event)
  const id = getRouterParam(event, 'id') ?? ''
  const ledger = getRecipeRollBackManager().ledger(id)
  ```
  对照同目录的列表端点 `index.get.ts:18-37`(用 `visibleLineIds(user)` / `filterByLine` 逐项过滤),以及 `line/query.get.ts:19-21`(显式 403)。
- **Impact**: 只要知道节点/记录 id(数字孪生场景、WS 帧、运维日志里都能拿到),任何登录用户都能直读**其他产线**的参数变更史(`journal` 含 prev/new/actor/source 全量)、优化记录(含 Agent 假设 hypothesis 与窗口指标)、参数台账三值对照。生产线数据隔离在该 4 个端点上被绕过。
- **Fix**: 4 个 handler 补 `visibleLineIds(user)`(nodeId → `getDcwController().byId(nodeId)?.lineId`;record → `record.lineId`)判定,非可见产线返回 403,与 `index.get.ts` 同一口径。
- **Verification**: `⚠UNVERIFIED`(HTTP 层未跑):建议加 API 用例 —— 用无授权 token 请求 `GET /api/workshop/dcw/journal?nodeId=<他线节点>` 必须 403;代码级证据:`grep -n "requireLineMode\|visibleLineIds" server/api/workshop/dcw/journal/index.get.ts` 无匹配。

---
### [P1] 写侧其余变更面越权:连接测试可 SSRF、配方/模板/产线/产品改删仅需登录
- **Where**: `server/api/workshop/dcw/test-driver.post.ts:11-14`、`server/api/workshop/dcw/index.post.ts:12-15`、`recipes/index.post.ts:10-12`、`recipes/[id]/index.patch.ts:10-18`、`recipes/[id].delete.ts:9-11`、`recipes/[id]/revert.post.ts:10-24`、`templates/index.post.ts:9-13`、`templates/[key].patch.ts:9-14`、`templates/[key].delete.ts:8-12`、`lines/[id].patch.ts:11-14`、`lines/[id].delete.ts:14-21`、`products/index.post.ts:11-15`、`products/[id].patch.ts:10-15`、`products/[id].delete.ts:9-14`、`runs/[id]/close.post.ts:9-13`
- **Evidence**:
  ```ts
  // test-driver.post.ts:11-14 —— 任意 URL/host 交给服务端发起连接
  resolveUser(event)
  const body = await readBody<{ driver?: DcwDriverKind, driverConfig?: Record<string, unknown> }>(event) ?? {}
  return { test: await getDcwController().testDriver(body.driver ?? 'mock', body.driverConfig ?? {}) }
  ```
  ```ts
  // recipes/[id]/index.patch.ts:10-18 —— 任意登录用户可改任意产线配方参数(改后由 lineStart/apply 下发到真实 PLC)
  const user = resolveUser(event)
  const recipe = getDcwController().updateRecipe(id, body, { by: 'user', actorName: user.name, actor: user.id, description: '界面编辑配方' })
  ```
  对照:`recipes/[id]/apply.post.ts:15 requireRole(event)`、`lines/[id]/start.post.ts:20 requireLineMode(user, id, 'operate')`、`lines/[id]/delete.ts`(无校验)。
- **Impact**: ①`test-driver` 让服务端按调用方给的 `host/port`(modbus/opcua/mqtt)或 `url`(http GET)发起连接 → 内网探活/端口扫描/SSRF;②配方参数是"最终会被下发到 PLC 的载荷":无产线授权的账号可篡改/删除任意配方,再由有权限的操作员开跑时写入硬件(权限模型被"数据面"绕过);③产线/产品/模板的改删同样无角色校验,与同文件族中 `requireRole` 的端点自相矛盾。
- **Fix**: 统一补 `requireRole(event, ['admin','editor'])` 或 `requireLineMode(user, <lineId>, 'operate')`;`testDriver` 至少限制为 admin/editor,并对 `host/url` 做白名单/私网黑名单(`ssrf` 防护)。
- **Verification**: `⚠UNVERIFIED`(HTTP 层未跑)。代码级:`grep -rn "resolveUser\|requireRole\|requireLineMode" server/api/workshop/dcw | sort` 可直接看出这 15 个文件只有 `resolveUser`。

---
### [P1] `http` 写驱动不校验回读:2xx 即 `ok:true`,ACK 语义弱于 modbus/opcua
- **Where**: `server/services/workshop/dcw/drivers.ts:585-604`
- **Evidence**:
  ```ts
  const res = await fetch(String(cfg.url), { method: 'POST', headers, body, signal: AbortSignal.timeout(6000) })
  if (!res.ok) return { ok: false, message: `接口返回 HTTP ${res.status},设定未受理`, raw: null, readback: null }
  let readback: number | null = null
  try { ... const n = Number(target); if (Number.isFinite(n)) readback = n } catch { /* 非 JSON 响应忽略回读 */ }
  return { ok: true, message: readback != null ? `POST 成功(HTTP ${res.status}),接口回读 ${readback}` : ..., raw: input.eng, readback }
  ```
- **Impact**: 接口回传的 `readback` 与下发值不一致(甚至相差极大)时仍返回 `ok:true` → 账本/写历史记录"已应用",而设备侧可能是另一种状态(与 P0-1 相反方向的失真:入册了无效写)。MQTT 无回读是显式标注的(`drivers.ts:532`),HTTP 有回读却不使用,属实现不一致。
- **Fix**: 与 `modbusWrite` 同口径:`readback != null && Number.isFinite(readback)` 时按 `Math.abs(readback - input.eng) <= input.tolerance` 判定 `ok`,不一致时返回 `ok:false` 并在 message 中给出偏差。
- **Verification**: 单元级 —— 起一个本地 HTTP 服务返回 `{"value": 999}`,调 `httpDcwDriver.write({eng:20,...})`,断言当前返回 `ok:true`(缺陷)且修复后为 `ok:false`。

---
### [P1] 写在飞闸门无看门狗;MQTT `client.end()` 无超时 → 单节点可能永久 409 `⚠UNVERIFIED`
- **Where**: `server/services/workshop/dcw/drivers.ts:523-529`、`server/services/workshop/dcw/dcw-runtime.ts:85-87`(finally 释放);对照 `server/services/workshop/daq/drivers.ts:235-242`(`closeModbusSafely` 有 500ms race 保护)
- **Evidence**:
  ```ts
  // dcw/drivers.ts:523-529 —— end() 无超时;若回调不触发,本方法永不 settle
  finally {
    await new Promise<void>((resolve) => {
      client.end(false, {}, resolve)
    })
  }
  ```
  ```ts
  // dcw-runtime.ts:85-87 —— 闸门只在 executeWrite settle 后释放,没有超时兜底
  finally { this.writing = false }
  ```
  Modbus 写有硬超时(实测 3010ms 返回 `Modbus 响应超时(3s)`),OPC UA 有 `requestTimeout: 4000`(`daq/drivers.ts:541`),HTTP 有 `AbortSignal.timeout(6000)`,MQTT 只有"发布确认 8s"(`drivers.ts:519`)。
- **Impact**: 若 `client.end()` 在某种 broker/网络状态下不回调(`⚠UNVERIFIED` —— 未复现),该节点的 `this.writing` 永不释放 → 该节点之后**所有**下发与心跳永久 409"写入进行中",且没有任何自愈路径(只有进程重启)。
- **Fix**: 用现有模式给 `end()` 加 race 超时(`Promise.race([... , sleep(1000)])`),并在 `DcwNodeRuntime.write/tick` 增加"在飞超时看门狗"(例如 `writing && now - writeStartedAt > driverTimeout × 2` → 释放闸门并置 error)。
- **Verification**: `⚠UNVERIFIED`(未构造出 `end()` 挂起)。可验证部分:Modbus 超时已由实验 3 [C] 段实测(3010ms、`ok=false`、`readback=null`)。

---
### [P2] 心跳写目标值跨微任务采样(`node.value!` 在 `.then()` 内读取)
- **Where**: `server/services/workshop/dcw/dcw-runtime.ts:109-110`
- **Evidence**:
  ```ts
  void Promise.resolve()
    .then(() => this.host.executeWrite(node, node.value!, writeTolerance(node), null))
  ```
  闸门判定用的是 tick 同步拍的值,下发用的却是微任务执行时刻的 `node.value`。
- **Impact**: 当前代码下**未能构造出差异**(微任务先于任何 I/O 回调执行,期间没有同步改写 `node.value` 的路径:`applyReadResult` 只改 `readValue`,`applyWriteResult` 只在 `executeWrite` 内被调用且受同一闸门约束)。属潜在缺陷:任何未来在 tick 与微任务之间同步改写 `node.value` 的代码都会让"闸门为 A 值而实际下发 B 值",且该写入不入账本。
- **Fix**: `const target = node.value; ` 在 tick 内同步取出后传入闭包。
- **Verification**: 读码即可确认;无行为差异可测(故不构成当前故障)。

---
### [P2] 写在飞闸门 + 状态机在 `write()` 与 `tick()` 中各写一份
- **Where**: `server/services/workshop/dcw/dcw-runtime.ts:71-88` 与 `:101-117`
- **Evidence**: 两处各自实现 `writing=true; node.state='writing'` … `writing=false; if (node.state==='writing') node.state='error'`(88 行版本还多一个 `catch` 分支置 error),语义要求完全一致(共享同一闸门),任何一处改动漏改另一处都会重现上一轮审计的 P0-5。
- **Impact**: 维护性风险(重复的并发临界区),无即时功能缺陷。
- **Fix**: 抽 `private runWrite(eng: number, recipeRunId: string | null, tag: 'manual' | 'keepalive')`,由 `write()` 与 `tick()` 共同调用,闸门与状态机只保留一份。
- **Verification**: `grep -n "this.writing = true" server/services/workshop/dcw/dcw-runtime.ts` 应只剩 1 处。

---
### [P2] 回读 ACK 比较逻辑在 3 个驱动里各写一份(第 4 个漏写)
- **Where**: `server/services/workshop/dcw/drivers.ts:203-219`(modbus-tcp)、`:400-413`(modbus-rtu)、`:305-324`(opcua)
- **Evidence**: 三段代码逐句同构(`writeRegisters/session.write` → 回读 → `Math.abs(engBack - input.eng) <= input.tolerance` → 同款 message 文案),而 `httpDcwDriver`(见 P1)漏掉了该比较。驱动抽象 `DcwWriteDriver`(`drivers.ts:36-43`)已存在,却把 ACK 判定留在每个实现里。
- **Impact**: 语义漂移已经发生(http 缺失),后续新增驱动极易再漏。
- **Fix**: 在 `drivers.ts` 抽 `ackByReadback(commanded, readback, tolerance, label): DcwWriteResult`,三个驱动改为复用。
- **Verification**: `grep -n "<= input.tolerance" server/services/workshop/dcw/drivers.ts` 收敛为 1 处。

---
### [P2] 分级回退的三个执行循环重复
- **Where**: `recipe-rollback-manager.ts:289-303`(`rollbackRun`)、`:318-327`(`rollbackRecipeGood`)、`:333-387`(`executeRollbackWrite`)
- **Evidence**: `rollbackRun` 与 `rollbackRecipeGood` 是同一形状的两份拷贝(`for (...) { try { await this.writeViaController(nodeId, value, {source:'rollback',...}); outcomes.push({ok:true,...}) } catch { outcomes.push({ok:false,...}) } }`),而节点级/记录级回退又各自重算"锚 → 目标值 → 下发"。
- **Impact**: 回退语义(失败原因、审计 actor、是否关闭原记录)在三条路径上分别演化,容易出现"某一路回退没有入册/没有审计"的遗漏。
- **Fix**: 抽 `private async rollbackNodes(targets: Array<{nodeId, value, hypothesis}>, actor, by)`,三条路径共用。
- **Verification**: `grep -c "writeViaController" server/services/workshop/dcw/recipe-rollback-manager.ts` 应从 3 降为 1~2。

---
### [P2] 账本 open 索引双写隐患 + `updateRecord` 的 `wasOpen` 竞态(实测可复现于 repo 层)
- **Where**: `recipe-rollback.repo.ts:213-226`(`insertRecord` 覆盖索引)、`:247-258`(`updateRecord` 先改对象再判 `wasOpen`)、`recipe-rollback-manager.ts:556-570`(`closeRecord` 先改 `status` 再调 `updateRecord`)
- **Evidence**:
  ```ts
  // repo:213-216 —— 同节点第二条 open 会静默顶掉索引里的第一条
  this.db.records.push(record)
  if (record.status === 'open') this.openByNode.set(record.nodeId, record)
  ```
  ```ts
  // repo:251-255 —— wasOpen 在 Object.assign 之前取,但调用方(manager closeRecord)已把 status 改掉
  const wasOpen = r.status === 'open'
  Object.assign(r, patch)
  if (r.status === 'open') this.openByNode.set(r.nodeId, r)
  else if (wasOpen && this.openByNode.get(r.nodeId) === r) this.openByNode.delete(r.nodeId)
  ```
  实验 2 [D] 段实测:
  ```
  insertRecord #1=opt-… #2=opt-…
  listOpenRecords() 返回 1 条;listRecords(status=open) 返回 2 条
  → 未被索引的 open 记录是否可达:不可达(永不被 sweep 评估)
  ```
  线上真实账本统计:19 条 open、**0 个节点**存在 >1 条 open(即当前尚未踩中)。
- **Impact**: 若将来任何调用方在同一节点插入第二条 open 记录(或在 `closeRecord`/`updateRecord` 的调用序变化后),旧 open 记录会永远停留在 `open` 状态且**不被 `evaluateOpenRecords` 评估** —— 系统兜底回退、Agent 互斥(`beforeWrite` 只看索引)都会漏掉它;同时 `openByNode` 会残留指向已改状态对象的陈旧条目(目前被 `status === 'open'` 过滤兜住)。
- **Fix**: `insertRecord` 在覆盖前先把同节点既有 open 记录显式关闭(或抛错);`updateRecord` 改为在 `Object.assign` **之前**保存 `wasOpen` 的判定,并让 `closeRecord` 只通过 `updateRecord` 改状态(不要在调用前就地改 `record.status`)。
- **Verification**: `node --experimental-transform-types scripts/_audit/run.mjs scripts/_audit/dcw-rollback-ledger.ts` 的 D 段;修复后 `listOpenRecords()` 应与 `listRecords({status:'open'})` 等长。

---
### [P2] 周期读也触发整库落盘:313 节点下每次全量重写 238KB(实测 2.3ms),稳态约每 1.5s 一次
- **Where**: `dcw-controller.ts:235`(`executeRead` 尾部 `this.repo.flushDebounced()`)、`dcw-node.repo.ts:60-79`(1.5s 防抖 + 全量 `toRow()` 序列化)、`dcw-controller.ts:193` + `dcw-recipe.repo.ts:385-395`(写历史 1.5s 防抖全量重写)
- **Evidence**:
  ```ts
  // dcw-controller.ts:234-235 —— 读是纯观测,却也触发落盘
  node.applyReadResult(value, r.raw, r.ok, r.message, at)
  this.repo.flushDebounced()
  ```
  实验 4 实测(真实 `server/data/dcws.json` 313 节点 / `dcw-writes.json` 1304 条的形状):
  ```
  dcws.json: flushNow 全量落盘 per-op=2.3ms (其中 JSON.stringify(pretty) 0.7ms), 文件=237.9KB
  dcw-writes.json: flushNow 全量落盘 per-op=2.5ms (其中 JSON.stringify(pretty) 1.1ms), 文件=444.2KB
  配置了周期读的节点=14,合计周期读频率=7.5 次/秒 → 稳态下 dcws.json 全量重写≈每 1.5s 一次
  ```
- **Impact**: 纯观测字段(`readValue/lastReadAt/lastReadError`)与工艺设定值共用"整库快照 + 原子写"通道,产生持续的磁盘写与事件循环阻塞;随节点数线性放大(313 节点已 238KB/1.5s)。属可接受的现状但无上限保护。
- **Fix**: 只对"执行语义字段"(value/lastAckAt/state/enabled/driverConfig/min/max…)触发落盘,读值类字段按更长周期(如 30s)或仅内存保存;或给 `DcwNodeRepo` 增加 dirty-field 分区。
- **Verification**: `node --experimental-transform-types scripts/_audit/run.mjs scripts/_audit/dcw-flush-cost.ts`。

---
### [P2] `dcw-node.repo` 用模块级单例,其余 DCW 仓库用 `globalThis`(HMR 双实例风险)
- **Where**: `dcw-node.repo.ts:82-86` 对照 `dcw-line.repo.ts:76`、`dcw-product.repo.ts:89`、`dcw-templates.ts:123`、`recipe-rollback.repo.ts:289-294`、`dcw-controller.ts:1013-1018`
- **Evidence**:
  ```ts
  // dcw-node.repo.ts:82-86
  let singleton: DcwNodeRepo | null = null
  export function getDcwNodeRepo(): DcwNodeRepo { singleton ??= new DcwNodeRepo(); return singleton }
  ```
  ```ts
  // recipe-rollback.repo.ts:289-294(同目录其他仓库的写法)
  const g = globalThis as … & { __recipeRollBackRepo?: RecipeRollBackRepo }
  export function getRecipeRollBackRepo(): RecipeRollBackRepo { g.__recipeRollBackRepo ??= new RecipeRollBackRepo(); return g.__recipeRollBackRepo }
  ```
- **Impact**: `DcwController` 与其余仓库都挂在 `globalThis` 上(刻意抗 HMR),而节点仓库不是 —— 开发态模块重载后可能出现"全局控制器持有旧 `DcwNodeRepo`(旧 DcwNode 实例)"与"新加载模块拿到新 repo"并存,导致同一 `id` 两套节点对象(`value/state` 漂移、runtimes 绑定旧实例)。`⚠UNVERIFIED`(未实测 Nuxt HMR 行为)。
- **Fix**: 与其他仓库统一改为 `globalThis` 单例。
- **Verification**: `grep -n "globalThis\|let singleton" server/services/workshop/dcw/*.repo.ts`。

---
### [P2] 线性查询与防乒乓计数归零:`anchorById` / `byId` 全量扫,`chainRollbackCount` 随 records 淘汰归零
- **Where**: `recipe-rollback.repo.ts:165-167`(`anchorById` = `db.anchors.find`)、`:228-230`(`byId` = `db.records.find`)、`:278-280`(`chainRollbackCount` = 全量 filter)、`recipe-rollback-manager.ts:442`(`< MAX_AUTO_ROLLBACKS`)
- **Evidence**: 实验 2 实测 20000 锚下 `anchorById` 未命中 0.198ms/次、2000 记录下 `byId` 0.009ms/次、`chainRollbackCount` 0.017ms/次;`chainRollbackCount` 的计数来源是 `status === 'rolled-back'` 的记录,而 `records` 有 2000 上限(`repo:21`)且按最旧淘汰(`repo:217-223`)。
- **Impact**: 查询成本随账本长度线性(回退/批次回退路径会调 `anchorById`);长跑后最早的 `rolled-back` 记录被淘汰 → `MAX_AUTO_ROLLBACKS=2` 的防乒乓保护在约 2000 条记录后**静默失效**,同一节点可被反复自动回退。
- **Fix**: 给 anchors/records 各加 `Map<id, item>` 索引;把"自动回退链长"改成节点上的独立计数器(不依赖 records 保活)。
- **Verification**: `node --experimental-transform-types scripts/_audit/run.mjs scripts/_audit/dcw-rollback-ledger.ts`(B/C 段数字)。

---
### [P2] 死代码与定时器卫生
- **Where**: `drivers.ts:61-63`(`supportsDcwRead`,生产代码零引用,仅 `scripts/test-dcw-read.ts` 使用);`daq/drivers.ts:240`(`closeModbusSafely` 的 500ms 定时器未 `unref`)、`:309-318`(`getModbusConn` 的连接超时定时器在成功后未 `clearTimeout`)
- **Evidence**: `grep -rn "supportsDcwRead" server/ | grep -v "dcw/drivers.ts"` 无结果(仅 scripts 命中)。
- **Impact**: 无功能影响;`unref/clearTimeout` 缺失会让进程在最后一个连接建立后再多存活最多 3s(服务进程无害,脚本/测试退出时表现为"挂住 3s")。
- **Fix**: 删除 `supportsDcwRead`(或改为 `resolveDcwDriver` 的实例方法);连接超时的 `setTimeout` 在成功后 `clearTimeout` 并 `unref?.()`。
- **Verification**: `grep -rn "supportsDcwRead" server/` 应为空。

---
### [P2] 数据根解析与可测性:`ensureDataDir()` 让"换 cwd"不再隔离,且 `dcw-node.repo.ts` 头注释仍写旧路径
- **Where**: `server/services/workshop/dcw/dcw-node.repo.ts:2`(注释 `server/data/dcws.json`)对照 `:16`(`join(ensureDataDir(), 'dcws.json')`);同族 `recipe-rollback.repo.ts:19`、`dcw-recipe.repo.ts:20-22`、`dcw-line.repo.ts:16`、`dcw-product.repo.ts:17`、`dcw-templates.ts:19`、`line-run.ts:31`;解析逻辑 `shared/config/home.mjs:135-189`
- **Evidence**:
  ```ts
  // dcw-node.repo.ts:1-16 —— 头注释与实现已经不一致
   * DcwNode 持久化仓库 —— 对象快照落盘(server/data/dcws.json),与 DaqNodeRepo 同风格。
  const DB_PATH = join(ensureDataDir(), 'dcws.json')
  ```
  ```js
  // shared/config/home.mjs:136 —— 只有 AW_DATA_DIR 能改变落点;cwd 只影响"向上找配置根"
  if (env.AW_DATA_DIR && String(env.AW_DATA_DIR).trim()) return resolve(String(env.AW_DATA_DIR).trim())
  ```
  ```js
  // shared/config/home.mjs:147-179 —— ensureDataDir 还会按 mtime「最新者胜」把 cwd/data 与
  // cwd/server/data 的 *.json / *.sqlite 复制进配置根
  ```
- **Impact**: 任何"把 cwd 切到临时目录"的测试/审计/脚本都会命中 `<repo>/.AgentWorkShop/data`(向上找到仓库的 `.AgentWorkShop`),从而**直接读写线上数据根**;本轮审计的早期实验就是这样把合成账本写进线上数据根的(已修复,见文末)。反之,线上数据在 `server/data`(旧进程)与 `.AgentWorkShop/data`(新代码/迁移)之间靠 mtime 收敛,两个根同时被不同进程写入时,`newest-wins` 会用"较新但可能不完整"的一份覆盖另一份。
- **Fix**: `dcw-node.repo.ts:2` 注释改为"配置根 `<repo>/.AgentWorkShop/data/dcws.json`";给仓库层加一处 `dataDirFor()` 的显式注入点(或在测试脚手架里统一 `AW_DATA_DIR`),并在 README/审计模板里写明"隔离必须设置 `AW_DATA_DIR` 而不是 chdir"。
- **Verification**: `node --experimental-transform-types scripts/_audit/run.mjs scripts/_audit/dcw-flush-cost.ts`(`run.mjs` 注入 `AW_DATA_DIR` 后,落盘只出现在 `scripts/_audit/.tmp/audit-data/`,线上根 mtime/size 不变 —— 本轮已实测:BEFORE/AFTER 均为 `dcw-rollback.json 563891B`、`dcws.json 243604B`、313 节点、0 个越界 decimals)。

---

## 八个问题的直接回答

**1. 写互斥:心跳是否已走闸门?同节点是否可能并发写?**
**已修复,不再并发。** 当前 `tick()` 在 `dcw-runtime.ts:101` 用 `!this.writing && … && node.state !== 'writing'` 做闸门判定,并在 `:105` 同步置 `this.writing = true; node.state = 'writing'`,由 `:112-115` 的 `finally` 释放 —— 与 `write()`(`:71-87`)共享同一对标志;心跳在写冲突时**跳过本拍**而非排队(符合注释语义)。`host.executeWrite` 的**唯一**调用者就是这两个方法(`grep -n "executeWrite" dcw-controller.ts` 只命中 `host` 定义与 `executeWrite` 实现,`grep -n "new DcwNodeRuntime"` 只有 `:128`,运行时按节点缓存复用,`syncRuntimes` 只增不换)。实验 1 实测:`maxInFlightWrites=1`(手动写在飞时心跳 20 次 tick 全部跳过;心跳在飞时手动写得到 409)。**上一轮审计 P0-5(`dcw-runtime.ts:101` 直调 `host.executeWrite` 绕过闸门)在当前代码中已不成立**;`dcw-controller.ts:532` 的 `prevValue` 采样也已移到 `await` 之前(`:532` 采样、`:533` await)。仍存在的并发缺陷只在**读**侧(见发现 P1-5)。

**2. 回滚账本:是否还有上限?是否有每节点索引?`evaluateOpenRecords` 是否还每 500ms 全量 reverse?当前复杂度?**
**有上限、有索引、全量 reverse 已消除,但引入了新的 O(cap) 常态成本。** `ANCHORS_CAP = 20000`(`repo:29`,启动时把历史无界文件裁剪到上限 `repo:40`)、`RECORDS_CAP = 2000`(`repo:21`);每节点倒序索引 `nodeAnchors` / `stableAnchors`(`repo:53-55`,`lastAnchorOf`/`lastStableAnchor` = O(1),实测 0.000ms)与 `openByNode`(`repo:57`,`listOpenRecords` = O(open),实测 0.003ms);`evaluateOpenRecords`(`manager:416-430`)已改为遍历 open 索引,循环上界 = 当前 open 记录数(线上 19 条),**不再是 `[...records].reverse()` 的 2000 条**。当前复杂度:append 稳态 O(cap)(两次隔离运行实测 **2.728ms / 3.518ms**);`lastStableBefore`/`lastRollbackAnchor` = 该节点稳定锚子序列的短倒扫(实测 0.001ms);`anchorById`/`byId` = 全量线性(0.145–0.198ms / 0.008–0.009ms);`listAnchors({nodeId})` 走索引(0.003~0.004ms),不带 nodeId 时全量倒扫(0.033–0.070ms);`chainRollbackCount` = 2000 条 filter(0.013–0.017ms);`flushNow` = 全量序列化(O(anchors+records),实测 **29.660ms / 39.954ms**,文件 10.92MB),且被 `manager:159` 放在**写成功后的同步路径**上。

**3. 是否存在跨 `await` 采样"前值"再写入账本的陈旧值缺陷?**
**记账侧的陈旧值缺陷已修复;心跳侧只剩一个无行为差异的潜在采样点。** `prevValue` 现在在 `dcw-controller.ts:532` 于 `await rt.write(...)`(`:533`)**之前**采样,传给 `afterWrite`(`:538`);同节点写在飞期间没有其它路径能改 `node.value`(周期读只写 `readValue`,`applyWriteResult` 只在受同一闸门的 `executeWrite` 内调用),故记账前值可信。唯一的跨边界采样是 `dcw-runtime.ts:110` 在 `.then()` 闭包里读 `node.value`(闸门判定在同步拍),但该值**不进入账本**(心跳不入册,见 P1-4),且当前无法构造出与 tick 时刻不同的取值(`⚠` 潜在项,见 P2)。真正等价危害的是**记账缺失**而非采样错位:ACK 失败/超时的写已落到硬件却不入账(P0-1、P0-3)。

**4. 授权:写请求从 HTTP 到驱动的产线权限检查在哪?有没有绕过路径?节点 id 不存在会怎样?**
链路:`POST /api/workshop/dcw/:id/write` → `write.post.ts:19 requireLineMode(user, getDcwController().byId(id)?.lineId, 'operate')` → `permissions.ts:55-62`(内部 `lineMode`:`permissions.ts:31-36`,admin/editor 直接 `operate`;否则查 `userRepository.lineAccessMap(user.id)` 的 `user_line_grants` 表,`readonly`/无记录分别 403 `LINE_READONLY`/`LINE_FORBIDDEN`)→ `DcwController.write`(`dcw-controller.ts:503-586`,网关暂停/节点停用/Agent 互斥/回退冷却/配方窗口)→ `DcwNodeRuntime.write` → `host.executeWrite` → `resolveDcwDriver(node.driver).write(...)`。**绕过路径存在**:①`PATCH /api/workshop/dcw/:id` 只 `resolveUser`(`[id].patch.ts:11`)→ 可改 `driverConfig/holdIntervalMs/min/max/decimals`,再由保写心跳完成硬件写(P0-2);②配方/模板/产线/产品的改删与 `test-driver` 只有登录校验(P1-8);③读侧 4 个端点无产线过滤(P1-7)。**节点 id 不存在**:`byId(id)?.lineId` = `undefined` → `lineMode` 在 `permissions.ts:32` 命中 `if (!lineId) return isPrivilegedRole(user) ? 'operate' : 'none'` —— admin/editor 放行后由 `dcw-controller.ts:505-506` 抛 404(实测实验 5 ③:`status=404`),普通用户得到 403(不泄漏存在性)。这与上一轮 P1-13 的描述一致:**没有越权写发生,但错误码语义取决于角色**。

**5. 驱动正确性:连接复用?错误映射?写超时?超时是否记为已应用?**
连接:`modbus-tcp`/`modbus-rtu`/`opcua` 复用数采侧连接池(`drivers.ts:198,288,396` → `getModbusConn`/`getOpcUaConn`,`daq/drivers.ts:213,491`,带 10 分钟空闲回收与连续 3 错驱逐);`mqtt` **每次写新建一次性连接**(`drivers.ts:491-508`,发布后 `end`),`http` 每次 `fetch`(无连接池概念)。错误映射:三个寄存器/会话驱动把底层异常转成 `{ok:false, message: classifyCommError(err)}`(`:245-248,342-345,438-441`),`http` 转 `ok:false`(`:586`),`AppError`(缺 host/register 等配置错)直接抛出到 API 层(400)。超时:Modbus 每事务 3s(`daq/drivers.ts:250-267`)+ 建连 3s(`:309-318`)、OPC UA `requestTimeout: 4000`、HTTP `AbortSignal.timeout(6000)`、MQTT 发布确认 8s;**实测** Modbus 半开链路 3010ms 返回 `ok=false`、`readback=null`(实验 3 [C])。**超时不会记为已应用**(`ok=false`),但硬件可能已经收到写 —— 而账本同样不入册、`node.value` 被写成指令值,于是"硬件可能已改、账本无记录、节点自认为已是目标值"三者不一致(与 P0-1 同一根因)。

**6. 并发/性能:O(n²)?无界 Map/Set?未 unref 定时器?未移除监听?每拍全表 DB 扫描?**
逐项核对结论:**O(n²)** —— 唯一一处是 `dcw-recipe.repo.ts:261-265` 的 `snapshot.filter` × `stale.some`(配方参数规模小,可忽略);账本/调度路径没有 O(n²)(`rollbackRun` 是 N 节点 × 节点内子序列扫描)。**无界 Map/Set** —— DCW 路径未发现:`opsWriteMemo` 有 `>500` 清空(`dcw-controller.ts:560-561`)、`capturing` 有重入保护与 finally 删除(`manager:574-598`)、`runtimes` 随节点同步增删(`:123-134`)、`modbusPool/opcuaPool` 有 10 分钟空闲回收且 `setInterval(...).unref()`(`daq/drivers.ts:465-478,497-515`)。**定时器**:网关 `setInterval(500ms)` 已 `unref`(`dcw-controller.ts:111`),各仓库防抖定时器均 `unref`(`dcw-node.repo.ts:65`、`recipe-rollback.repo.ts:125`、`dcw-recipe.repo.ts:394`),`withModbusConn` 的 3s 定时器在两个分支都 `clearTimeout`(`daq/drivers.ts:269-277`);瑕疵仅 `closeModbusSafely` 的 500ms 与 `getModbusConn` 建连 3s 定时器未 unref/未清理(P2)。**监听器**:DCW 侧无事件监听注册(WS 由 `scene-events` 的 peer 集合管理,框架侧负责移除);前端 `useDcwStream` 用引用计数订阅/退订(`useDcwStream.ts:59-76`),页面 `onUnmounted(() => unsubDcw())`(`[id].vue:25-26`)。**每拍全表 DB 扫描** —— 已消除:sweep = `runtimes.values()` 的 tick + `evaluateOpenRecords` 遍历 open 索引,均无 DB 访问(`dcw-controller.ts:116-121`);`evaluateOnce` 里的 tsdb 查询有 30s 复查间隔与 `MIN_WINDOW_MS` 双重限流(`manager:416-430`)。**残余热点**是账本 append/flush(P1-6)与读值触发的整库落盘(P2)。

**7. 冗余:哪些 node-value / 回滚 / ACK 逻辑应当合并为一个类?**
①**写在飞闸门 + 状态机**:`dcw-runtime.ts:71-88`(`write`)与 `:101-117`(`tick`)两份(建议抽 `runWrite()`);②**ACK 回读判定**:`drivers.ts:203-219`、`:400-413`、`:305-324` 三份同构 + `:585-604` 漏写(建议 `ackByReadback()`);③**回退执行循环**:`manager:289-303`(`rollbackRun`)与 `:318-327`(`rollbackRecipeGood`)两份,外加 `:333-387` 的记录级编排(建议 `rollbackNodes(targets, actor, by)`);④**节点 ACK 记账**已集中(`dcw-node.ts:117-141` 的 `applyWriteResult`/`applyReadResult`,唯一调用点 `dcw-controller.ts:176,234`)—— 这块无需重构,但需要按 P0-1/P0-3 拆分"ACK 记账"与"观测值回填";⑤**账本"关闭 open 记录"** 有三处入口(`manager:123-125,189-192,345-350`),状态语义分散(`closeRecord` 的 `status` 决策 + 调用方就地改 `status`),是 P2 open 索引问题的根源。

**8. 哪里可能出现"硬件已写但账本无记录"(不可回退写)?**
按可达性排序:**(a)** ACK 回读失败 —— `drivers.ts:203-219`/`:305-316` 先写后判,`ok=false` 时 `dcw-controller.ts:536` 直接跳过 `afterWrite`(实验 3 实测:寄存器=20、账本锚仍 {5,10});**(b)** 写超时/通信异常 —— 同上,且 `readback=null` 使 `node.value` 被写成**指令值**(`dcw-controller.ts:176`),硬件真实状态未知(实验 3 [C] 实测 3s 超时);**(c)** `decimals` 越界 —— `applyWriteResult` 在驱动写成功之后抛 `RangeError`(`dcw-node.ts:118`),账本/写历史/审计全部跳过,心跳路径还会静默重试(实验 5 实测 PLC=170、账本=160、无历史、调用方 500);**(d)** 保写心跳的任何一次下发 —— `dcw-runtime.ts:110` 不经 `afterWrite`(grep 证实唯一调用点 `dcw-controller.ts:538`);**(e)** `afterWrite` 内部异常被吞(`manager:182-185` `catch { return null }`)—— 理论路径,当前 `appendAnchor` 为纯内存操作,未能构造出触发条件(`⚠`);**(f)** 回退下发失败 —— `manager:359-366` 只把失败原因写进 `judge.reason`,而硬件可能已被写(与 (a) 同根因)。**唯一的兜底是"写历史"**:它在 `applyWriteResult` 之后追加(`dcw-controller.ts:181-193`),因此 (a)(b) 会留下 `ok:false` 的记录(`server/data/dcw-writes.json` 中现有 20 条 `ok:false`),但 (c)(d) 连写历史都没有。

---

## 与上一轮审计(`PLAN-ARCH-AUDIT.md`)的对照

| 上一轮结论 | 本轮实测/读码结论 |
|---|---|
| P0-5 心跳绕过写在飞互斥(`dcw-runtime.ts:101` 直调 `host.executeWrite`) | **已修复**:心跳与 `write()` 共享 `writing` 闸门,实验 1 实测 `maxInFlightWrites=1`;`prevValue` 采样也已移到 await 之前(`dcw-controller.ts:532`) |
| P1-8 anchors append-only 无上限 + 4 个方法线性逆扫 | **部分修复**:有 cap(20000)与每节点索引(`lastStableAnchor` 实测 0.000ms);但 cap 稳态 append 变 O(cap)(3.518ms),`anchorById`/`byId` 仍线性 |
| P1-9 `evaluateOpenRecords` 每 500ms 全量 `[...].reverse()` 2000 条 | **已修复**:改为 open 索引遍历(O(open),实测 0.003ms) |
| P1-13 `requireLineMode(user, undefined, …)` 对 admin 放行 | **仍存在**(`permissions.ts:32`);普通用户 403、admin/editor 由控制器 404 兜底(实验 5 ③) |
| (本轮新增)写入册闸门把"ACK 失败"当作"PLC 未变更" | **新发现 P0-1**(实验 3 实测硬件已写但账本无锚) |
| (本轮新增)`PATCH /dcw/:id` 无产线/角色校验 | **新发现 P0-2**(`[id].patch.ts:11` 只有 `resolveUser`) |
| (本轮新增)`decimals` 无校验 → 记账抛错 | **新发现 P0-3**(实验 5 端到端实测) |

## 未验证 / 未覆盖

- **数据隔离事故(已修复,需转告其他 agent)**:本轮审计早期(11:09–11:15)实验脚本只用 `process.chdir('scripts/_audit/.tmp')` 做隔离,但 11:12 的迁移把仓库改为 `ensureDataDir()` → 配置根 `<repo>/.AgentWorkShop/data`,于是 ①`.AgentWorkShop/data/dcw-rollback.json` 被写成 **11.4MB 合成数据**(20000 个 `n-*`/`dw-1` 锚 + 2000 条合成记录,0 条与真实锚对应);②`.AgentWorkShop/data/dcws.json` 被追加 **2 个幻影节点**(`dw-cc28b097` / `dw-c37e304b`,`decimals=101`,来自 P0-3 的端到端实验)。**修复**:账本已用线上权威 `server/data/dcw-rollback.json`(616 锚 / 173 记录 / 563,891 B)覆盖回新数据根;幻影节点已删除 → 新数据根恢复 313 节点、0 个越界 `decimals`;污染现场留证在 `scripts/_audit/.tmp/pollution-backup/{dcw-rollback,dcws}.polluted.json`。`server/data/**` 未被本审计破坏。`run.mjs` 现已强制注入 `AW_DATA_DIR/AW_MODE/AW_HOME` 指向 `scripts/_audit/.tmp/`,并在修复后复跑全部 5 个实验验证线上根零变化。
- `⚠UNVERIFIED` HTTP 层越权复现(P0-2 的攻击链、P1-7/P1-8):需真实 token 与运行中的服务,本轮只做了服务层与代码级验证;三个前端页面按题目要求完整读过 `app/pages/dcw/index.vue`、`app/pages/dcw/[id].vue` 的 `<script setup>` 与其调用的 `app/composables/workshop/useDcwStream.ts`(前端不在写路径上做任何安全判定,一切以服务端返回为准;`doWrite` 的 `[id].vue:116-136` 不做量程预校验)。
- `⚠UNVERIFIED` MQTT `client.end()` 挂起导致闸门永久占用(P1-10 后半)。
- `⚠UNVERIFIED` Nuxt HMR 下 `dcw-node.repo` 模块级单例的双实例后果(P2)。
- `⚠UNVERIFIED` 账本 cap 稳态的真实长跑行为(实测为合成满载 20000 锚;线上实际账本当前仅 616 锚,尚未触发淘汰路径)。
- 未覆盖:`server/services/workshop/agents/industrial-tools.ts` 的 Agent 侧工具权限模型(仅核对了 `toolDcwControl` 的绑定校验与 `getDcwController().write()` 调用点:`industrial-tools.ts:96-188`,Agent 权限由 `agent-node-bindings` 承载,不经产线 grant);未做真实 PLC/OPC UA 服务器互操作测试(P0-1/P1-9 用的是本地假 Modbus PLC;OPC UA 分支为同构读码结论)。
