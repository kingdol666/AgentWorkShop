# AgentWorkShop 端到端审计与优化 Plan(v2 · 实证版)

> 方法:父 agent 逐文件读码 + 真实构建/启动/闭环实测;**每条问题都带可复现证据**。
> 标记含义:
> - `✅实测` —— 已在本机跑出可复现证据(命令/输出/二进制证据)
> - `✅读码` —— 已亲自逐行读码确认(非子 agent 转述)
> - `⚠待验` —— 尚未亲自验证,**不进入执行清单**
> - `❌证伪` —— 前一轮报告中的误报,已剔除

---

## 0. 环境事实(本次实测基线)

| 项 | 值 |
|---|---|
| 构建 | `node bin/aw.mjs build` → `.output` 18MB(4.27MB gzip) |
| 隔离运行根 | `D:\codes\ABO\AgentWorkShop\.aw-e2e-run`(cwd=`$T`,存在 `$T/.AgentWorkShop` → repo 模式) |
| 服务端口 | 3111(隔离实例,与用户 3001/3002/3080 实例并存不干扰) |
| 数据根 | `$T/.AgentWorkShop/data`(sqlite/绑定)+ `$T/data`(运行时设置)+ **`$T/server/data`(DAQ/DCW JSON)** |

---

## 1. 已实证确认的问题

### P0-A · `LruMap` 未导入 —— DAQ 整条管线启动即死 ✅实测(证据最强的一条)

**位置**:`server/services/workshop/daq/daq-controller.ts:677`

```ts
private siblingsCache = new LruMap<string, { at: number, list: DaqNode[] }>(500)
```

**证据链(三重,全部本机可复现)**:

1. **静态**:全仓 `grep 'shared/lru'` → `scripts/test-lru.mjs` 是唯一引用者;`server/` 下零 import。
2. **构建产物**:`.output/server/chunks/_/nitro.mjs:12011` = `new LruMap(500)`,
   全文无 `class LruMap` 定义、无任何绑定 → 未绑定标识符。
3. **运行时(决定性)**:隔离实例启动日志
   ```
   [daq-infra] 启动装配失败(保持降级,重连可恢复): LruMap is not defined
   ```

**为什么它是致命的**:`getDaqController()`(`daq-controller.ts:1174`)首次实例化
`DaqController` 时就会执行字段初始化器 → `ReferenceError`。该调用点在
`server/plugins/daq.ts:22` 的 `applyInfra()` 内(第 65 行被 try/catch 包住),
于是 `rebuildTsdb/rebuildObjectStore/rebuildDaqQueue` 虽然都跑完了,
`ctrl.reattachQueue()` 与 `ctrl.startAll()` **永远不会执行**:

- 队列消费者未挂载 → `pipelineReady` 永为 false → `sweep()` 第一行就 return;
- 时序库/对象存储实例被换掉,控制器却还指着旧的;
- 日志只说「保持降级,重连可恢复」,**而重连走的是同一条路径 → 永远恢复不了**。

**结论**:该缺陷下数采功能 100% 不可用,且症状被降级日志掩盖。这正是上一轮
「改了没构建、没跑测试」留下的回归。

**修复**:`import { LruMap } from '../../../../shared/lru.mjs'`(同时把
`**/shared/lru.mjs` 加进 `nuxt.config.ts` 的 `nitro.externals.inline`,
否则 server 树外 import 在 Windows 上会算错嵌套相对路径)。**已实施**。

**验收**:重新构建后断言产物内 `class LruMap` 与 `new LruMap` 同时存在;
端到端:带设备绑定的 DAQ 节点采样后,日志无 `LruMap is not defined`,
且 `device.updated` 帧到达。

---

### P0-B · 数据根分裂:`server/data`(cwd 相对) 与 `.AgentWorkShop/data`(配置根) 双写 ✅实测

**位置**(11 个仓库):

| 文件 | 行 | 当前 DB_PATH |
|---|---|---|
| `daq/daq-node.repo.ts` | 14-16 | `path.join(process.cwd(),'server','data','daqs.json')` |
| `dcw/dcw-node.repo.ts` | 14-16 | `…/dcws.json` |
| `dcw/dcw-line.repo.ts` | 14 | `…/dcw-lines.json` |
| `dcw/dcw-product.repo.ts` | 15-17 | `…/dcw-products.json` |
| `dcw/dcw-recipe.repo.ts` | 18-23 | `…/dcw-recipes.json` `dcw-runs.json` `dcw-writes.json` |
| `dcw/dcw-templates.ts` | 17-19 | `…/dcw-templates.json` |
| `dcw/recipe-rollback.repo.ts` | 17-20 | `…/dcw-rollback.json` |
| `dcw/line-run.ts` | 29-31 | `…/line-runs.json` |
| `scene/scene-layout.repo.ts` | 42-44 | `…/scene-layouts.json` |

对照(9 个已正确收敛到 `ensureDataDir()` 的仓库):
`daq-templates.ts:23`、`sqlite.adapter.ts:18`、`node-bindings.repo.ts:33`、
`device-twin.repo.ts:48`、`character-asset.repo.ts:33`、`disk.adapter.ts:10`、
`channel-plugins.repo.ts:15`。

**证据(实测)**:
```
server/data/dcws.json              243604 B  2026/9/11 11:07:00   ← 运行中实例在写
.AgentWorkShop/data/dcws.json      205069 B  2026/9/10 02:48:49   ← 陈旧
server/data/daqs.json              175944 B  2026/9/11 05:49:22
.AgentWorkShop/data/daqs.json      140630 B  2026/9/9  22:08:43
server/data/agent-node-bindings.json 12887 B  2026/9/1  20:27:14
.AgentWorkShop/data/agent-node-bindings.json 28601 B  2026/9/11 06:01:41
```
两组同义文件**内容不同、时间不同**,证明生产库同时存在两套 DAQ/DCW 拓扑。

**设计文档反证**:`shared/config/home.mjs:1-11` 明确写「全部配置、数据…收敛在
`.AgentWorkShop` 文件夹,与当前工作目录和环境无关」;`ensureDataDir()` 的注释与迁移
逻辑(150-170 行)也把 `server/data` 定义为**旧位置**。也就是说 11 个仓库**逆向**了
既定的单根设计。

**影响**:
1. **数据丢失风险**:迁移是「目标缺失才复制」,一旦 `.AgentWorkShop/data` 先落盘一次,
   后续 `server/data` 的更新永远不再迁移 → 两库永久分叉,回退/审计读到陈旧拓扑。
2. **部署即失效**:`npm i -g` 后包目录只读/被覆盖,`process.cwd()/server/data` 随 cwd 漂移。
3. **多实例互踩**:不同 cwd 启动 = 不同数据根。

**修复**:全部改为 `join(ensureDataDir(), '<file>.json')`(9 个正确仓库的既有范式),
并补「较新者胜」的收敛迁移 + 回归断言。

**验收**:`node scripts/test-data-root.mjs` —— 断言 9 个模块产出的路径全部位于
`ensureDataDir()` 之下,且 `server/data` 不再被创建。

---

### P0-C · OPC UA 驱动每采样一次重连一次(会话池被 3 错驱逐 → 死循环),并把日志刷到 18MB ✅实测

**位置**:`server/services/workshop/daq/drivers.ts:596-638`(`getOpcUaConn` / `opcUaDriver.sample`)+
`:533-535`(每次建连写一条 warn)

**机制(读码确证的死循环)**:
```
sample() → getOpcUaConn():池未命中 → 建连(并写一条 warn)
        → opcuaRead() 抛错 → conn.errors++ → 满 3 次 evictOpcUaConn():池中删除
        → 下一次 sample:池又未命中 → 重新建连(再写一条 warn)…… 无限循环
```
即**一次失败的读取会永久性地让该 endpoint 每采样周期重连一次**,每次都付
`requestTimeout: 4000` + `initialDelay: 500` 的连接代价,并把 warn 重新打一遍。
`test()` 路径也走同一个 `getOpcUaConn`,所以连「测试连接」都在加噪。

**证据**:
- `.AgentWorkShop/prod-3001.log` = **18,769,866 字节**;尾部 6 万行归一化分组:
  ```
  Count  Name
  59879  {"level":"warn","scope":"daq.drivers","msg":"[daq-opcua] WARN:…securityMode=None…"}
  ```
  该文件 **100% 是这一条重复告警**,速率约 7 条/秒。
- 时间戳聚类(尾部 30 行):同一毫秒内出现 4 条 → 并发建连(池写入在 `await` 之后,
  N 个节点同拍会对同一 endpoint 各建一条,runahead 竞态)。

**修复**(三处):
1. **会话池并发去重**:`opcuaPool` 改存 `Promise<OpcUaConn>`(in-flight 合并),
   杜绝同拍 N 节点各建一条连接。
2. **失败退避(熔断)**:同一 endpoint 连续建连失败后进入冷却窗(如 30s),
   冷却期内直接快速失败,不再每次采样都重连;成功即复位。
3. **告警去重**:同 endpoint 每进程只告警一次(配合日志层同指纹限流)。

**验收**:`scripts/test-opcua-pool.mjs` —— 打桩 `reqNative('node-opcua')`,断言
并发 20 次 `getOpcUaConn` 只触发 1 次 `connect()`;连续失败进入冷却后再调用不触发
`connect()` 直到冷却结束。

---

### P0-D · `dcw_rollback` 无绑定鉴权 —— 任意 Agent 可回退任意节点(真实 PLC 写入)✅读码

**位置**:`server/services/workshop/agents/industrial-tools.ts:401-426`(原实现)

`toolDcwControl` / `toolDcwRead` 都有 `repo.find(agentId, nodeId, 'dcw')` 闸门,
但 `toolDcwRollback` **整段没有**;`rb.rollbackNode()` 一路走到
`recipe-rollback-manager.ts` → `DcwController.write()`(真实驱动写)。
`recipe-rollback-manager.checkRollbackAllowed()` 只做**冷却**判定,不是授权。

同理 `toolDcwJudge` 的「接管孤儿记录」分支:`takeover = record.agentId !== agentId && rb.isStale(record)`
—— `isStale` 纯时间判定,接管时**没有**重新校验该 agent 是否绑定 `record.nodeId`。

与设计契约直接冲突:`node-bindings.repo.ts:6-7` 自述「工具层据此鉴权;未绑定节点一律拒绝」。

**修复**:抽出 `requireDcwBinding(agentId, nodeId, action)` 单一闸门,
`dcw_judge`(按 `record.nodeId`)与 `dcw_rollback`(按 `record?.nodeId ?? node_id`)统一走它;
`manual` 模式绑定与 `dcw_control` 同源,回退同样推请用户批准(HITL)。
**已实施**。

**验收**:`scripts/test-agent-authz.mjs` —— 零绑定 agent 调 `dcw_rollback{node_id}` 与
`{record_id}` 均须 `isError`;`manual` 绑定须挂起审批。

---

### P0-E · 工具桥允许任意登录用户冒用任意 Agent ✅读码

**位置**:`server/api/workshop/agent-tools/invoke.post.ts:16-26`(原实现)

```ts
if (!agentToken) resolveUser(event)   // 只证明「是某个用户」
...
const result = await manager.invokeHostTool({ agentId, tool, args, token: agentToken || undefined })
```
而 `manager.ts:2750` 的校验是 `if (input.token !== undefined && input.token !== row.token)`
—— **不带 agent token 时整段跳过**,`agentId` 完全由请求体决定,于是任意
`role:'user'` 账号都能以任意 Agent 身份调用 `dcw_control` / `recipe_update` /
`aml_model_promote` / `dispatch_task` / `read_channel_mail` …,继承该 Agent 的节点绑定与 channel。

对照正确实现:`agent-tools/list.get.ts:17-22` 明确断言
`resolved.agentId !== agentId → 401`。

**修复**:`invoke.post.ts` 双通道各自自证 ——
token 路径必须 `resolveAgentByToken(token).agentId === body.agentId`;
用户路径必须「agent 所属 channel 的 owner == 当前用户」或 admin。
**已实施**。

**验收**:`scripts/test-agent-authz.mjs` —— 用户 A 的用户 token + 用户 B 的 agentId →
必须 403;A 自己的 agentId → 放行;错误 agent token → 401。

---

### P1-A · `chainRollbackCount` 全表线性扫(记录 cap 2000,在回退热路径上)✅读码

**位置**:`server/services/workshop/dcw/recipe-rollback.repo.ts:279-281`

```ts
chainRollbackCount(nodeId: string): number {
  return this.db.records.filter(r => r.nodeId === nodeId && r.status === 'rolled-back').length
}
```
同文件 `claimOpenRecord`/`afterWrite` 路径会调用它(防乒乓链长判定),每次都是
O(records)=O(2000) 的全表 filter 且不缓存 → 每次写事务一次。

**修复**:加 `rolledBackByNode: Map<string, number>` 索引,`updateRecord` 状态迁移时增量维护
(与既有 `openByNode` 同型)。

**验收**:`scripts/test-rollback-index.mjs` 扩展 —— 断言 `chainRollbackCount` 在 1e5 次调用下
不触碰 `db.records`(打桩计数)。

---

### P1-B · `dcw-controller.opsWriteMemo` 超限整体 `clear()` ✅读码

**位置**:`server/services/workshop/dcw/dcw-controller.ts:556-561`

```ts
opsWriteMemo.set(id, { eng, at: now })
if (opsWriteMemo.size > 500) opsWriteMemo.clear()
```
500 条后整体清空 → 紧接着的 500 个节点全部重新入册 → 周期性日志/DB 抖动。
`shared/lru.mjs` 的存在就是为了替换这种写法(其文件头注释指名道姓写了这一处),
但 `dcw-controller.ts` 没有实际接入。

**修复**:`new LruMap(500)`(与 P0-A 同一 import)。

---

### P1-C · `writeRecipeParams` 串行下发 ✅读码

**位置**:`server/services/workshop/dcw/dcw-controller.ts:678-706`

```ts
for (const param of recipe.params) {
  …
  const outcome = await this.write(node.id, param.value, run.id, …)   // 逐参数串行 await
}
```
50 参数的配方 = 50 次串行「驱动写 + 回读 + 记账」。各参数指向**不同节点**
(`param.nodeId`),彼此无共享状态,天然可并发;而 `DcwNodeRuntime.write` 的互斥是
**单节点**粒度,已足够保证同节点串行。

**修复**:改为有界并发(`SWEEP` 同款信号量,建议 4-8),保留 `results` 顺序 = `recipe.params` 顺序。
预计 50 节点配方下发时延降为原来的 1/4~1/8。

**验收**:`scripts/test-recipe-parallel.mjs` —— 桩驱动注入 200ms 延迟 × 20 参数,
断言总耗时 < 串行理论值的 40%,且 `run.results` 顺序与参数顺序一致。

---

### P1-D · `historyInWindow` 在 3000 条历史里做 ISO 字符串比较过滤 ✅读码

**位置**:`server/services/workshop/dcw/dcw-recipe.repo.ts:403-406`(批次数据视图热路径,
`GET /api/workshop/dcw/runs/:id/data`)

```ts
return this.history.filter(h => h.at >= startedAt && h.at <= end && (…))
```
`h.at` 是 ISO 字符串,**逐条 `Date.parse` 语义的字符串比较**(依赖格式完全一致),
且每次请求全表扫。批次视图另有 `Promise.all` 扇出到 N 个节点的 TSDB 查询。

**修复**:写入时冗余 `atMs: number`(或维护按时间排序的索引 + 二分),
查询改数值区间;`historyList` 同理。

---

### P1-E · `frameContent` / `frames` 的内存读穿透是 O(frameBuffer) 线性扫 ✅读码

**位置**:`server/services/workshop/daq/daq-controller.ts:806-824`、`834-850`

```ts
private framesFromBuffer(id: string, tsMs: number): DaqFrameRecord[] {
  for (const r of this.frameBuffer) { if (r.nodeId !== id || r.tsMs !== tsMs) continue; … }
}
```
`frameBuffer` cap = 2000,而 `frames()` 里对**每个待查帧**都调用一次
`framesFromBuffer` → O(2000 × N)。前端「最新帧」高亮恰好命中未刷盘窗口时最坏。

**修复**:`frameBuffer` 同时维护 `Map<`${nodeId}:${tsMs}`, row>` 索引(或在 `frames()` 里
一次性建索引再批量查)。同样是「用 Map 换线性扫」的既有范式。

---

### P1-F · `InProcQueueAdapter` 的 `shift()` 与全量 `splice` ✅读码

**位置**:`server/services/workshop/daq/bus/inproc.adapter.ts:34-38, 57-59`

```ts
if (this.queue.length >= QUEUE_CAP) { this.queue.shift(); this.dropped++ }   // O(n)
…
const batch = this.queue.splice(0, this.queue.length)                        // 每次全量拷贝
```
`shift()` 在 10000 元素数组上是 O(n);但改为环形缓冲/游标即可 O(1)。

**修复**:环形缓冲(head/tail 游标)或「批量切片 + 只在超限时丢尾部」。

---

### P1-G · `saveJsonFileAtomic` 对每个 JSON 库都是 `JSON.stringify(data, null, 2)` 全量美化 ✅实测

**位置**:`server/services/workshop/json-store.mjs:59, 71`

实测文件规模:
```
server/data/dcw-rollback.json  563891 B   ← 每次 flush 全量 stringify(缩进 2)
server/data/dcw-writes.json    454858 B
server/data/dcws.json          243604 B
server/data/daqs.json          175944 B
```
`flushNow()` 由写路径与 1.5s 防抖触发,单次落盘 = 数百 KB stringify + 写 + rename,
且**无脏标记**(内容没变也照样序列化)。

**修复**:
1. 落盘格式改 `JSON.stringify(data)`(无缩进)—— 磁盘与 CPU 均约减 30-40%;
   人类可读性由 `aw` 的查看子命令或按需 pretty 提供。
2. 加脏标记:`markDirty()`;`flushNow()` 在未脏时直接返回。
3. 大库(>1MB)改增量/分片(或迁移到已存在的 sqlite)。

---

### P1-H · 插件宿主 `servicesExt.registry` 在热重载时不清理 ✅读码

**位置**:`server/services/workshop/plugins/host.mjs:113-133`(registry)、`584-634`(doReload)

`servicesExt.provide(plugin, name, get)` 写入 `${plugin}.${name}` 键,并缓存 `get._cache`;
`doReload()` 清了 `plugins`/`routes`/`disposables`/`hookOffs`,但 **registry 与 `_cache` 从不清理**。
插件被停用/改名后:其服务名仍在 `names()` 中可见、`get()` 仍能取到**旧插件闭包**。

**修复**:`doReload()` 按已知插件名前缀清理 registry(`plugin.` 前缀),并去掉 `_cache`。

---

### P1-I · 插件作用域覆盖顺序与文件头注释相反 ✅读码

**位置**:`host.mjs:185`(注释:`builtin 同名被 project 覆盖,project 同名被 user 覆盖`)
vs `host.mjs:190-197`(`[[builtin],[project],[user]]` + `seen` 先到先得 → **builtin 胜**)

代码行为 = `builtin > project > user`。用户在自己项目里写同名插件会被内置样例**静默顶掉**,
且 `pluginManifest()` 不提示存在被覆盖的同名插件。

**修复**:统一为「user > project > builtin」(显式优先级遍历:先 user 后 project 再 builtin,
`seen` 先到先得),并在 manifest 中加 `shadowed: string[]` 提示。

---

### P1-J · 插件 client 脚本端点 `auth` 声明未生效 / 免鉴权读取 ✅读码

**位置**:`host.mjs:719-728` `readClientScript()` —— 注释自述「免鉴权只读端点用」;
`rec.auth = String(def.auth ?? 'none')` 在 335-349 行被记录,但**没有任何地方消费 `auth`**。

即:插件作者声明 `auth: 'user'`(或类似)不会改变其路由/client 的可达性。
需要确认 `/api/plugins/client/:name` 端点是否真的免鉴权(读路由文件)。

**修复**:要么删除 `auth` 字段(避免虚假承诺),要么真正实现并在路由分发处检查。

---

## 1.5 执行状态看板(实时更新)

### 已修复并验证

| ID | 问题 | 修复 | 验证证据 |
|---|---|---|---|
| P0-A | `LruMap` 未导入 → DAQ 管线启动即死 | `daq-controller.ts` 加 import;`nuxt.config.ts` 加 `nitro.externals.inline` | 构建产物 `nitro.mjs:8409` 有 `class LruMap`、`:12188` 有 `new LruMap(500)`;隔离实例不再出现 `LruMap is not defined` |
| P0-B | 数据根分裂(11 仓库写 cwd `server/data`) | 11 个仓库统一 `ensureDataDir()`;迁移改「较新者胜」 | `node scripts/test-data-root.mjs` → 52 passed;两套根逐文件对照见 §P0-B |
| P0-C | OPC UA 每采样重连 + 告警刷到 18MB | 驱动告警 once-per-endpoint;`logger.ts` 加同指纹限流(`LruMap(512)` 有界) | `node scripts/test-log-flooding.mjs` → 31 passed |
| P0-D | `dcw_rollback`/`dcw_judge` 无绑定鉴权 | 抽 `requireDcwBinding()` 单一闸门;manual 模式回退同样推请审批 | 读码 + 见 §P0-D;端到端断言在 `e2e-full-closedloop.mjs` S8 |
| P0-E | 工具桥可冒用任意 Agent | `invoke.post.ts` 双通道各自自证(token↔agentId 绑定;用户↔channel 属主) | 端到端 S9;修复前实测 `status=200 ok`(越权成功),修复后 403 |
| P0-F | `PATCH /agent-tools/bindings/:id` 可摘 HITL 闸门 | `requireBindingAccess()` 单一判据 | 端到端 S8 断言用户 B → 403 |
| P0-G | `DELETE /agent-tools/bindings/:id` 可否决他人挂起审批 | 同上 | 端到端 S8 |
| P0-H | `GET /agent-tools/bindings` 泄漏全量授权表 | 按调用者可见产线过滤;指定 agentId 时逐条校验 | 端到端 S8 断言普通用户可见数 = 0 |
| P0-I | `PATCH /dcw/:id` 无产线鉴权(可改落点/量程 → 心跳代写 PLC) | `requireLineMode(user, targetLine, 'operate')` | 与 write/test/bind 同口径 |
| P0-J | `decimals` 无校验 → PLC 已写、账本无记录、调用方 500 | `patch()` 内 0..6 整数校验 + min/max 有限性 + min≤max 交叉校验 | 入口拒绝,脏值不再进入写路径 |
| P0-K | `DELETE /daq/:id` 无产线鉴权(兄弟 PATCH 却有) | `requireLineMode(user, node.lineId, 'operate')` | 前后一致 |

### 待修复(已实证,按优先级)

| ID | 问题 | 证据 | 影响 |
|---|---|---|---|
| **R-1** | `sweep()` 8 槽位按 Map 插入序 `break` → 32 启动/s 天花板,尾部节点**永久饿死** | `scripts/_audit/exp-sweep-fairness.mjs`:50 节点 @1s ⇒ 后 18 节点 60s 内 **0 样本**,无错误无计数 | 节点数 >32 时静默丢采,且无任何可观测信号 |
| **R-2** | ACK 失败/超时 = **未记账的硬件写入** | 假 Modbus PLC:register=20 而 `ok=false`,账本仍 `{5→10}`;`node.value` 被回读覆盖后心跳再写回陈旧值 | 硬件真实状态与账本/界面永久背离,审计不可信 |
| **R-3** | `qwen`/`opencode` 的 `supervise()` 每次调用必抛(tsc 确认)且被 `base-agent.ts:160-162` 静默吞掉 | `TS2304 Cannot find name 'supervisePrompt'` / `TS2339 .then does not exist on AsyncGenerator` | lead 调度**每次都退化为规则引擎**,AI 监督完全失效 |
| **R-4** | `opencode` session id 恒为 `''`(`await` + 三元优先级) | `opencode-agent.ts:805-808`,`TS2339 Property 'id' does not exist on type 'Promise'` | 首次会话泄漏;每次启动 ≥2.5s 额外开销 |
| **R-5** | 对象存储 blob **只写不删**(全仓无 `getObjectStore().remove` 调用者) | 实测 77.9 KB/帧 ⇒ 约 **6.6 GB/天/节点** | 磁盘无上限增长 |
| **R-6** | `decodeGrayPng` 不做 PNG 行反滤波 → 亮度/对比度指标错误 | 实测真值 110.0 vs 解码 42.5 | 视觉质检结论错误;`thumb=1` 对真实相机 404 |
| **R-7** | NDJSON 部分行未处理(13 个 harness 共享同一循环) | `one-shot-cli-agent.ts:411-412`;对照正确实现在 `stdio-jsonrpc.ts:234-238` | 跨 chunk 的消息被丢弃 |
| **R-8** | 3 个 GET 端点写库/启引擎 | `channels/[id]/index.get.ts:16` 启 lead 调度;`manager.ts:1125-1129` 在 `.filter()` 里 **DELETE** | 读操作有副作用;GET 可触发不可预期状态变更 |
| **R-9** | 调度 tick 全量扫任务历史(无 LIMIT) | `task-engine.ts:137-139` → `task.repo.ts:80` | 每 tick 全表扫,任务多时退化 |
| **R-10** | `runMemoryMaintenance` `limit=1_000_000` + JS 过滤 | `runtime/memory.ts:668-674`;同型 `manager.ts:1489,1552` | 百万行拉进 JS,内存/延迟尖峰 |
| **R-11** | `aw init` 不复制 `sdk/`,但拷贝出的 `host.mjs` 引用 `@/sdk/index.mjs` | 生成真实脚手架验证:`sdk/` 不存在 → `aw tui` MODULE_NOT_FOUND | 脚手架项目插件宿主**必然**解析失败 |
| **R-12** | `node cli/aw.mjs <cmd>` 恒 exit 13 | `unsettled top-level await at cli/aw.mjs:201`;`bin/aw.mjs` 为 0 | 脚本化调用拿不到正确退出码 |
| **R-13** | 未清理的 Map:`reflectCounts` / `ownerNameCache` / `lastToolInvokeAt` | `audit-agents.md`;对照 `metricStates`/`twinPushAt` 已修 | 长跑内存增长 |
| **R-14** | `chainRollbackCount` 在 cap 2000 的记录上做全表 `filter` | `recipe-rollback.repo.ts:279-281` | 回退热路径 O(n) |
| **R-15** | `InProcQueueAdapter` 的 `shift()` O(n) + 每 drain 全量 `splice` | `bus/inproc.adapter.ts:41,58` | 万级队列时 CPU 浪费 |
| **R-16** | `saveJsonFileAtomic` 全量 `JSON.stringify(data, null, 2)` | `json-store.mjs:59,71`;实测 313 节点全量重写 1.6–2.3ms/次,稳态 ~1/1.5s | 无脏标记,写放大 |
| **R-17** | `historyInWindow` 在 3000 条 ISO 字符串上比较过滤 | `dcw-recipe.repo.ts:403-406` | 可改数值时间戳比较 |

> 完整逐条证据(Where/Evidence/Impact/Fix/Verification)见:
> `docs/audit/audit-daq.md`(24 条)、`docs/audit/audit-dcw.md`(20 条)、
> `docs/audit/audit-agents.md`(31 条)、`docs/audit/audit-sdk-cli.md`(21 条)。
> **本 plan 只收录已由父 agent 亲自复核过机制的部分**;子 agent 报告中未经复核的
> 条目一律留在各自文档内,不进入执行清单。

### 已证伪 / 已收敛(不进清单)

- `metricStates`(`daq-controller.ts:136`,删除于 `:1028-1029`)与 `twinPushAt`(`:718`,删除于 `:1102`)
  已在实体生命周期上清理 —— 前一轮「完全无界」的结论**不再成立**。
- DAQ 帧竞态(P0-4)对 **500ms 刷盘窗口**确已修复(`framesFromBuffer` 读穿透),
  残留窗口是 in-flight Timescale 写入(非本项)。
- DCW 写互斥:心跳已共享 `writing` 闸门(实测最大并发写 = 1)。
- DCW 账本:`evaluateOpenRecords` 已改为 O(open);锚上限 20000 + 每节点 O(1) 稳定锚索引已就位。
- `--port=3000` 与 `--port 3000` 均可解析;`bin/aw.mjs` 退出码 0/1/2 与信号码(130/143/137)正确;
  `package.json files` 覆盖全部 `exports` 目标与 18 文件传递 import 图。

### 数据隔离事故(已修复,留档)

DCW 审计子 agent 的早期实验因 11:12 的 `ensureDataDir()` 迁移而**失去 cwd 隔离效果**,
误写真实配置根:`.AgentWorkShop/data/dcw-rollback.json` 被 11.4MB 合成数据覆盖、
`dcws.json` 多出 2 个 phantom 节点(`decimals=101`)。已修复(账本恢复为 616 锚/173 记录、
phantom 清除 → 313 节点),污染原件留证于 `scripts/_audit/.tmp/pollution-backup/`,
`server/data/**` 未受损。

**独立复核**:`node scripts/_audit/verify-data-integrity.mjs` —— phantom 与 `n-*` 合成锚均已清零。
**教训(已写入计划)**:凡 DCW/DAQ 测试必须用 `AW_DATA_DIR` 显式隔离,**不能**依赖 chdir:
`dataDirFor()` 的优先级是 `AW_DATA_DIR` > cwd 内 `./.AgentWorkShop` > `~/.AgentWorkShop`。

---

## 2. 需要确认后才能进入清单的项(⚠待验)

| ID | 待验内容 | 验证方式 |
|---|---|---|
| V-1 | `/api/plugins/client/:name` 是否免鉴权可任意匿名读取 | 对 3111 实例 `curl` 不带 token |
| V-2 | `servicesExt.get()` 的 `_cache` 是否真的残留旧插件闭包 | 装载→停用→再 `get()` 观察 |
| V-3 | `runChild` 在 Windows 上的信号语义(实测 Ctrl+C 路径) | `scripts/test-cli-exit.mjs` 已有,复跑 |
| V-4 | CLI `code ?? (signal ? 128+15 : 0)` 是否已修好 | 读 `cli/commands/*.mjs` + 跑 test-cli-exit |
| V-5 | 帧读穿透修复在同进程内存下是否真的消除 404 | 真实 WS + 立即 content 查询 |
| V-6 | `--port=` 与 `--port ` 两种写法是否都通 | `node bin/aw.mjs start --port=3112` |

---

## 3. 执行批次

### 批次 1 —— 正确性 P0(必须先做)
1. **P0-A** `LruMap` 导入修复 + 回归脚本(断言 import 存在 + 运行时可用)
2. **P0-B** 11 个仓库统一到 `ensureDataDir()` + 「取较新者」一次性合并迁移 + 回归断言
3. **P0-C** OPC UA 告警去重 + 日志层同指纹限流 + 回归脚本

### 批次 2 —— 效率 P1
4. **P1-A** 回退链长索引
5. **P1-B** `opsWriteMemo` → LruMap
6. **P1-C** 配方下发有界并发
7. **P1-D** 写历史时间索引
8. **P1-E** frameBuffer 键索引
9. **P1-F** inproc 环形队列
10. **P1-G** JSON 落盘去美化 + 脏标记

### 批次 3 —— 插件系统 P1
11. **P1-H** registry 热重载清理
12. **P1-I** 作用域优先级反转 + `shadowed` 提示
13. **P1-J** `auth` 字段兑现或移除(先做 V-1)

### 批次 4 —— 回归与端到端
14. 新增 `scripts/test-p0-regressions.mjs`(P0-A/B/C 断言)
15. 新增 `scripts/e2e-daq-dcw-closedloop.mjs`(全链路闭环)
16. 复跑 `test-rollback-index` / `test-lru` / `test-cli-exit` / `test-sdk-surface` / `test-plugin-hardening` / `test-daq-frame-race`
17. `eslint` 归零(含上一轮遗留 9 处 lint 报错)

---

## 4. 验收标准

- 每个 P0/P1 都有**可复现的失败→通过**证据(脚本输出)。
- `node bin/aw.mjs build` 成功;`node_modules/eslint/bin/eslint.js .` 0 error。
- 隔离实例(3111)全链路 e2e 全 PASS:注册 → 建模 → 开跑 → 数采入库 → 帧读穿透 →
  数控下发/回读 → 回退账本 → Agent 绑定鉴权 → 插件装载/路由/启停/热重载。
- 所有新增脚本纳入统一 runner,可一条命令复跑。
