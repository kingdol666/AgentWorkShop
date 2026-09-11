# 插件上下文 ctx(运行时完整变量面)

`setup(ctx)` 收到的 `ctx` 是宿主装配的 SDK 运行时。**下表是完整成员面**;
最后三行(`ctx.daq` / `ctx.omp` / `ctx.services`)由插件宿主在 `setup` 之前直接挂载,
不在 `sdk/context.mjs` 里。

| 分组 | 成员 | 类型 | 说明 |
|---|---|---|---|
| 身份 | `ctx.name` | `string` | 插件名(= 目录名 / 声明名) |
| | `ctx.scope` | `'builtin' \| 'project' \| 'user'` | 装载作用域;同名时优先级 builtin > project > user |
| | `ctx.dir` | `string` | 插件目录绝对路径 |
| | `ctx.sdkVersion` | `string` | SDK 接口版本(= `SDK_VERSION`) |
| 钩子 | `ctx.hooks` | `{ on, once, off, emit }` | 本插件作用域的钩子门面;**不是 `HookBus` 实例,没有 `.size`** |
| 日志 | `ctx.logger` | `{ debug, info, warn, error }` | 输出前缀 `[aw-plugins] [<插件名>]` |
| 配置 | `ctx.config.get(key)` | 任意 | 有效配置项(四层合并后的值) |
| | `ctx.config.all()` | `Record<string, any>` | 全部有效配置的浅拷贝快照 |
| | `ctx.config.onChange(fn)` | 退订函数 | 订阅 `config:changed` |
| | `ctx.config.defineGroup(def)` | 分组对象 \| `null` | 声明本插件专属配置分组 |
| | `ctx.config.defineField(decl)` | 描述符 \| `null` | 声明配置字段(key 自动编址 `plugins.<name>.<key>`) |
| | `ctx.config.removeGroup(id)` / `removeField(key)` | `boolean` | 摘除声明 |
| | `ctx.config.groups()` / `fields()` | 数组 | 本插件当前已注册的分组 / 字段(只读快照) |
| 路径 | `ctx.paths` | `{ home, configRoot, dataDir }` | 配置根信息(home 模式 = `~/.AgentWorkShop`) |
| | `ctx.dataDir` | `string` | 本插件私有数据目录 = `<paths.dataDir>/plugins/<name>` |
| 存储 | `ctx.kv` | `{ get, set, all, bump }` | 插件私有 KV;**没有 `reset()`** |
| 定时 | `ctx.timer.setInterval/setTimeout` | 定时器 id | 自动 `unref` + 关闭 / 热重载自动回收 |
| 清理 | `ctx.onDispose(fn)` / `ctx.subscriptions.add(d)` | 传入值 | 同一回收队列 |
| 路由 | `ctx.route(method, path, handler)` | `boolean` | 挂到 `/api/plugins/<name><path>`;鉴权由插件 `auth` 字段声明 |
| 平台 | `ctx.api` | `PlatformClient` | 自环 REST 客户端(**默认无 token**) |
| 网络 | `ctx.http.get(url, opts)` / `post(url, body, opts)` | `Promise<Response>` | 出站请求,守卫只限协议,默认 8s 超时 |
| 事件 | `ctx.events.on(type, fn)` / `off(type, fn)` | 退订函数 | scene 事件订阅,自动补 `event:` 前缀 |
| 产线权限(宿主注入) | `ctx.permissions` | 见下 | 用户 × 产线三态授权 |
| 数采扩展(宿主注入) | `ctx.daq` | 见下 | 驱动 / 处理器 / 模板注册 + 帧订阅 + 时序查询 |
| Agent 工具(宿主注入) | `ctx.omp.registerTool(tool)` | 见下 | 运行时热注入自定义 host 工具 |
| 运行时服务(宿主注入) | `ctx.services` | 见下 | 惰性服务取数 + 跨插件供服务 |

`ctx` 上**没有** `ctx.routes`、`ctx.dcw`、`ctx.scene`、`ctx.version`:
路由注册只有单数的 `ctx.route()`;写控流量靠 `dcw:write` 钩子观察;scene 事件走 `ctx.events`。

## ctx.hooks —— 钩子门面

宿主持有一个名为 `aw-plugins` 的共享 `HookBus`,插件拿到的是只含 `on` / `once` / `off` / `emit`
的**作用域门面**:经它注册的监听器会在插件热重载时自动解绑。

```js
function onSample(sample) { ctx.kv.bump('samples') }

const off = ctx.hooks.on('daq:sample', onSample)   // 返回解绑函数
ctx.hooks.once('server:close', () => { /* 收尾 */ })
ctx.hooks.off('daq:sample', onSample)              // 手动解绑:传原 handler
off()                                              // 或调用 on() 返回的解绑函数

await ctx.hooks.emit('my-plugin:custom', { hello: 1 })   // 插件间通信
ctx.hooks.on('*', ({ type, payload }) => { /* 全部事件 */ })
```

- **异步串行**:同 type 监听器按注册序 `await`。
- **错误隔离**:单监听器抛错只计数告警,不影响兄弟监听器与主服务。
- **熔断**:同一监听器**连续**失败 8 次自动摘除;任意一次成功即清零。
- **扇出而非 waterfall**:每个监听器收到**同一个未改动的 payload**;`emit()` 只返回
  「最后一个非 `undefined` 的返回值」,值不会在监听器间链式传递。
- **服务端通配只有裸 `'*'`**,回调收到 `{ type, payload }`;`ctx.hooks.on('event:*')` 永不触发。
- **v1 是观察语义**:没有 veto / 拦截 / 改写。

## ctx.kv —— 插件私有持久化

```js
ctx.kv.set('threshold', 100)
ctx.kv.bump('samples')                  // 原子自增(高频钩子安全)
ctx.kv.get('threshold')                 // 100
ctx.kv.all()                            // { samples: 19448, threshold: 100, ... }
```

**只有 `get` / `set` / `all` / `bump` 四个方法**,没有 `reset()`、`delete()`、`keys()`。
落盘位置:`<ctx.dataDir>/kv.json`(即 `<paths.dataDir>/plugins/<name>/kv.json`),
内存态为准 + 200ms 防抖原子写;关闭 / 热重载时取消防抖并同步落盘。

## ctx.timer + ctx.onDispose —— 生命周期安全的后台工作

```js
ctx.timer.setInterval(() => ctx.kv.set('heartbeat', Date.now()), 5000)  // 自动 unref + 自动回收
ctx.timer.setTimeout(() => ctx.logger.info('一次性任务'), 1000)
ctx.onDispose(() => ctx.logger.info('清理完成'))

const controller = new AbortController()
ctx.subscriptions.add({ dispose() { controller.abort() } })   // 与 onDispose 同一队列
```

服务关闭序列:**逐插件执行 dispose 队列(逐个 try/catch)→ 广播 `server:close { at }`**。
该队列在**插件热重载**时同样执行 —— 定时器不会泄漏。

## ctx.route —— 插件 API

```js
export default {
  name: 'my-plugin',
  auth: 'user',        // 'none'(默认) | 'user' | 'admin' | 'agent-or-user'
  async setup(ctx) {
    const ok = ctx.route('GET', '/stats', () => ctx.kv.all())   // 返回 boolean
    if (!ok) ctx.logger.warn('路由注册失败')

    ctx.route('POST', '/threshold', (event) => {
      const body = event.awBody          // 宿主已预读的 JSON body(可能是 undefined)
      ctx.kv.set('threshold', Number(body?.threshold))
      return { ok: true }                // 返回值由 nitro 序列化为 JSON
    })
  },
}
```

→ `/api/plugins/<name><path>`。

- **返回值是 `boolean`**;`handler` 不是函数时返回 `false`。
- **鉴权是声明式的**:`auth` 字段由平台 catch-all 在进入 handler **之前**统一校验,失败 401。
  **不要自己写鉴权**:`resolveUser(event)` 不在 `ctx` 上,也无法从插件模块 import。
- `event.awBody` 是已预读的 JSON body(不是 h3 的 `readBody`)。
- handler 抛错被隔离:平台记录带插件名的日志,返回 500 信封,不裸传堆栈。

## ctx.config —— 配置读取与变更

```js
ctx.config.get('plugins.my-plugin.threshold')   // 有效值(四层合并后)
ctx.config.all()                                // 全部有效配置(浅拷贝)
const off = ctx.config.onChange(payload => {    // 本质是 ctx.hooks.on('config:changed', fn)
  ctx.logger.info('新阈值', payload?.changed)
})

// 声明式扩展:分组 + 字段(setup 里按条件注册;等价于 manifest 的 settings[])
ctx.config.defineGroup({ id: 'conn', label: '连接', collapsed: true })
ctx.config.defineField({ key: 'retries', type: 'number', default: 3, min: 0, max: 10, group: 'conn' })
ctx.config.groups()                             // 本插件当前的分组快照
ctx.config.fields()                             // 本插件当前的字段快照
```

## ctx.permissions —— 用户 × 产线授权

| 方法 | 返回 | 说明 |
|---|---|---|
| `lineMode(user, lineId)` | `'none' \| 'readonly' \| 'operate'` | `user` 是 `{ id, role }`;admin/editor 恒为 `operate` |
| `visibleLineIds(user)` | `Set<string> \| null` | `null` 表示不限(admin/editor) |
| `listGrants(userId)` | `Array<{ lineId, mode, grantedBy, grantedAt }>` | 读取某用户的全部授权 |
| `setGrants(userId, grants, grantedBy?)` | 写入后的授权数组 | `mode` 取 `'readonly'` / `'operate'` / `null` |

变更通知是 scene 事件 `permissions.changed`,经 `ctx.events` 补前缀后订阅:

```js
ctx.events.on('permissions.changed', ({ userId }) => ctx.logger.info('授权变更:', userId))
```

## ctx.api / ctx.http / ctx.events —— 怎么选

| 需求 | 用 | 原因 |
|---|---|---|
| 读 / 写**平台业务数据** | `ctx.api` | 鉴权 / 信封 / 资源语义开箱即用 |
| 调**外部系统**(MES、webhook) | `ctx.http` | 通用请求 + 协议守卫(仅 http/https) |
| 对**实时流**做反应 | `ctx.events` / `ctx.hooks.on` | 进程内直连,零 HTTP 开销 |

```js
// ctx.api 默认无 token:免鉴权端点可直接用,其余端点先登录再 setToken
const { token } = await ctx.api.users.login('user@example.com', 'secret')
ctx.api.setToken(token)
const { lines } = await ctx.api.lines.list()

// ctx.http:出站请求,默认 8s 超时
const res = await ctx.http.get('https://mes.example.com/health', { timeoutMs: 3000 })

// ctx.events:type 传场景事件名本身,自动补 event: 前缀
ctx.events.on('daq.reading', r => ctx.logger.info('采样', r.nodeId))
ctx.events.on('device.created', d => ctx.logger.info('新设备', d.id))
```

## ctx.daq —— 多形态数采扩展(v0.6 帧管线)

```js
ctx.daq.registerProcessor('vector', 'my-derive', (frame) => {
  // frame = { kind: 'vector'|'image', points? | blob?(仅图像生产侧), metrics }
  return { ...frame, metrics: { ...frame.metrics, myMetric: 1 } }
})
ctx.daq.registerTemplate({ /* DaqTemplateDef:key/signalKind/vector/sink/metrics */ })
ctx.daq.registerDriver({ kind: 'my-ccd', available, sample, test })
ctx.daq.onFrame(fn)     // 糖衣 = ctx.hooks.on('daq:frame')
ctx.daq.onSample(fn)    // 糖衣 = ctx.hooks.on('daq:sample')
const rows = await ctx.daq.query({ nodeIds: ['n1'], from: Date.now() - 3600_000, to: Date.now(), bucketMs: 60_000 })
const nodes = await ctx.daq.nodes()
```

模板 `sink.processors` 声明下沉管线(采样后、入库前执行);`metrics` 声明派生指标阈值,
越限走平台既有告警链路。向量 / 帧元数据入 Timescale `daq_frames`,图像像素入对象存储
(`daq:frame` 载荷**不含像素 blob**)。

## ctx.services —— 后端运行时对象面

```js
const daq = await ctx.services.get('daq')          // { query(q), nodes() }
const lines = await ctx.services.get('lines')      // { list(), byId(id) }
const channels = await ctx.services.get('channels')// { list(), agents(channelId) }
const plugins = await ctx.services.get('plugins')  // 插件清单**数组**(不是对象)
ctx.services.names()                               // 可用服务名(含插件提供的)
ctx.services.provide('my-data', async () => ({ ready: true }))   // → 'my-plugin.my-data'
```

- 惰性求值并缓存;未知名抛错(错误由调用方兜底)。
- 只读取数优先;`provide` 强制 `<插件名>.` 前缀,避免跨插件命名冲突。

## 插件设置声明(index.mjs 顶层 `settings:` / `configGroups:`)

```js
export default {
  name: 'my-plugin',
  configGroups: [{ id: 'conn', label: '连接', collapsed: true }],
  settings: [{ key: 'base_url', type: 'string', default: 'https://example.com', group: 'conn',
               labelKey: 'plugin.my-plugin.base_url', label: '回退文案' }],
}
```

- 键强制编址 `plugins.<插件名>.<key>`;装载后并入平台设置服务 —— 设置页「插件」分区
  自动渲染,PATCH 同源校验,保存即热生效。
- 读取:`ctx.config.get('plugins.<name>.base_url')`。校验失败条目跳过并告警,不阻断装载。
- 规则:`key` 必须是 `[A-Za-z0-9_-]+`;`type` 取 `string`/`number`/`boolean`/`select`;
  **`default` 必填**;`select` 必须给 `options` 且 `default` 在其中;`min`/`max` 只对 `number` 生效;
  不给 `group` 的字段落入 `plugin-<name>` 分组,标签即插件名。

## ctx.omp —— omp 自定义工具(运行时热注入)

```js
ctx.omp.registerTool({
  name: 'sensor_log',
  description: '查询/登记传感器标定结论',
  parameters: { type: 'object', properties: { sensor: { type: 'string' } }, required: ['sensor'] },
  roles: ['lead', 'worker'],                          // 合法字面量只有 'lead' 与 'worker';缺省双角色
  handler: async (args, agent) => ({ text: '...' }),  // agent = { agentId, channelId, role, name }
})
```

注册表变更即时热注入全部在跑 omp agent 会话(重发 `set_host_tools`,不重 spawn);
与内置 host tool 同名会被忽略(内置优先)。

## 事件订阅的常见错误

| 写法 | 结果 |
|---|---|
| `ctx.hooks.on('event:*', fn)` | **永不触发** —— 服务端通配只有裸 `'*'` |
| `ctx.hooks.on('permissions:changed', fn)` | **永不触发** —— 实际发射名是 `event:permissions:changed` |
| `ctx.events.on('permissions.changed', fn)` | 正确 —— 糖衣会补 `event:` 前缀 |
| `ctx.hooks.on('*', ({ type, payload }) => …)` | 正确 —— 收全部事件 |
