# AgentWorkShop SDK 开发与使用指南

> SDK 是 AgentWorkShop 的**编程客户端与扩展基座**：外部项目经它消费平台 REST 服务；
> 插件经它获得宿主注入的运行时上下文（钩子 / 配置 / 存储 / 定时器 / 平台 API / 事件流）。
> 零第三方运行时依赖，Node ≥ 23.4 与现代浏览器双端可用。

**版本**：与主包同步（`SDK_VERSION = 0.3.0`）· **协议**：ESM only
**类型**：`agentworkshop/sdk` 自带 `index.d.mts`，TS 项目零配置获得完整提示。

---

## 1. 获取 SDK

### 1.1 全局安装形态（含 CLI 与平台本体）

```bash
npm install -g agentworkshop
```

SDK 位于全局包内：`$(npm prefix -g)/node_modules/agentworkshop/sdk/`。
插件**无需也不应该**直接 import 它（见 §2 的宿主注入模型），它主要服务两类人：

- **外部项目集成**：把 AgentWorkShop 的产线/数采/写控/孪生能力嵌进你自己的 node 服务；
- **插件开发**（TS）：仅导入类型获得完整 IntelliSense，运行时由宿主注入。

### 1.2 项目依赖形态（推荐集成方）

```bash
npm install agentworkshop        # 作为依赖（含完整 SDK 与类型）
```

### 1.3 导入路径

| 导入 | 内容 |
|---|---|
| `agentworkshop/sdk` | 全部门面（客户端 + 服务端 + 平台 REST 客户端 + 类型） |
| `agentworkshop/sdk/client` | 仅浏览器端（`createClientContext`） |

```js
import { createPlatformClient, definePlugin, HookBus } from 'agentworkshop/sdk'
```

---

## 2. 核心模型：两种身份，一个 SDK

| 身份 | 形态 | SDK 的角色 |
|---|---|---|
| **外部集成者** | 普通依赖 | 直接调用 `createPlatformClient()` 消费平台 REST 面 |
| **插件作者** | 导出 `{ name, setup(ctx) }` | `ctx` 即宿主注入的 SDK 上下文——**零导入依赖**，SDK 运行时由宿主提供 |

> 为什么插件不直接 import SDK？全局安装的插件目录（`~/.AgentWorkShop/plugins/`）
> 不在 node_modules 解析链上，宿主注入是唯一零坑形态（VSCode `activate(context)` 同范式）。

---

## 3. 平台 REST 客户端 `createPlatformClient`

SDK 作为"项目服务客户端"的门面。自动携带鉴权、自动解包平台统一信封 `{ code, message, data } → data`、非 2xx 抛错（含 `err.status` 与 `err.body`）。

### 3.1 创建

```js
import { createPlatformClient } from 'agentworkshop/sdk'

const api = createPlatformClient({
  baseUrl: 'http://127.0.0.1:3001',  // 缺省 ''（同源相对路径）；集成方填平台地址
  token: '<bearer-token>',            // 可选；后续可 api.setToken() 更换
  timeoutMs: 10_000,                  // 可选；单请求超时
  logger,                             // 可选；请求失败时告警
})
```

### 3.2 通用调用（任意平台路径）

| 方法 | 签名 | 说明 |
|---|---|---|
| `api.call(method, path, body?)` | 底层 | 返回解包后的 `data` |
| `api.get(path, query?)` | query 对象自动序列化 | `api.get('/api/workshop/dcw', { page: 1 })` |
| `api.post(path, body?)` | JSON 序列化 | |
| `api.patch(path, body?)` | | |
| `api.delete(path)` | | |
| `api.setToken(token)` | 链式 | 登录后 `api.setToken(res.token)` |

### 3.3 资源面（开箱即用）

| 资源 | 方法 |
|---|---|
| `api.users` | `login(email, password)` · `me()` · `list/get/create/update/remove` |
| `api.lines` | CRUD + **`start(id, recipeId?)`** · `stop(id)` |
| `api.products / api.recipes` | CRUD |
| `api.dcwNodes` | 写控制节点 CRUD |
| `api.daqNodes` | 数采节点 CRUD + `alarms()` |
| `api.templates` | `daq()` / `dcw()` 信号模板注册表 |
| `api.twins` | 数字孪生设备 CRUD |
| `api.teams / api.agents / api.channels` | Agent 编组面 |
| `api.plugins.manifest()` | 已装载插件清单（免鉴权） |
| `api.ping()` | 存活探测（免鉴权） |

### 3.4 示例：外部项目集成产线

```js
import { createPlatformClient } from 'agentworkshop/sdk'

const api = createPlatformClient({ baseUrl: 'http://plant.local:3001' })

const { token } = await api.users.login('you@example.com', 'secret')
api.setToken(token)

await api.lines.create({ name: '一号产线' })
const line = (await api.lines.list())[0]

await api.lines.start(line.id)                     // 开跑
const nodes = await api.daqNodes.list({ lineId: line.id })
console.log(`产线 ${line.name} 在线节点 ${nodes.filter(n => n.state !== 'offline').length}`)
```

---

## 4. 插件上下文 `ctx`（完整成员）

`setup(ctx)` 收到的 `ctx` 是宿主装配的 SDK 运行时。**全部成员一览**：

| 分组 | 成员 | 类型 | 说明 |
|---|---|---|---|
| 身份 | `ctx.name` | `string` | 插件名（= 目录名/声明名） |
| | `ctx.scope` | `'project' \| 'user'` | 装载作用域 |
| | `ctx.dir` | `string` | 插件目录绝对路径 |
| | `ctx.sdkVersion` | `string` | 宿主 SDK 版本 |
| 钩子 | `ctx.hooks` | `HookBus` | 全局钩子总线（§5） |
| 日志 | `ctx.logger` | `{ debug, info, warn, error }` | 自动前缀 `[插件名]` |
| 配置 | `ctx.config.get(key)` | 任意 | 有效配置项（四层合并后） |
| | `ctx.config.all()` | `Record<string, any>` | 全部有效配置快照 |
| | `ctx.config.onChange(fn)` | 退订函数 | 订阅 `config:changed` |
| 存储 | `ctx.kv.get(key)` / `set(key, v)` / `all()` / `bump(key, by?)` | | 插件私有 KV（内存态 + 200ms 防抖落盘，防竞态） |
| 定时 | `ctx.timer.setInterval(fn, ms)` / `setTimeout(fn, ms)` | id | **服务关闭自动回收**，无需手动 clear |
| 清理 | `ctx.onDispose(fn)` / `ctx.subscriptions.add(d)` | | 登记 `server:close` 时执行的清理 |
| 路由 | `ctx.route(method, path, handler)` | boolean | 注册插件 API → `/api/plugins/<name><path>` |
| 平台 | `ctx.api` | `PlatformClient` | 自环 REST 客户端（origin 由宿主权威解析） |
| 网络 | `ctx.http.get(url)` / `post(url, body)` | `Response` | 通用请求（**仅 http/https**，8s 默认超时） |
| 事件 | `ctx.events.on(type, fn)` / `off` | 退订函数 | scene 实时事件订阅（§5 `event:*` 糖衣） |
| 路径 | `ctx.paths` | `{ home, configRoot, dataDir }` | 配置根信息（home 模式 = `~/.AgentWorkShop`） |
| 数据 | `ctx.dataDir` | `string` | 插件私有数据目录（`data/plugins/<name>`） |

### 4.1 `ctx.hooks` — 钩子总线

```js
const off = ctx.hooks.on('daq:sample', (sample) => {
  ctx.kv.bump('samples')
})
ctx.hooks.once('server:close', () => { /* 收尾 */ })
ctx.hooks.off('daq:sample', handler)   // 手动解绑
await ctx.hooks.emit('my-plugin:custom', { hello: 1 })  // 插件间通信(其他插件可监听)
```

- **异步串行**：同 type 监听器按注册序 `await`，返回值链式传递（waterfall）。
- **错误隔离**：单监听器抛错只计数告警，不影响兄弟监听器与主服务。
- **熔断**：同一监听器连续失败 ≥ 8 次自动摘除（防病态插件刷屏）。
- **`'*'` 通配**：`ctx.hooks.on('*', ({ type, payload }) => …)` 收全部事件。

### 4.2 `ctx.kv` — 插件私有持久化

- 存储位置：`<配置根>/data/plugins/<name>/kv.json`（200ms 防抖原子写盘）。
- **内存态为准**：高频钩子（`daq:sample`）与低频钩子（`line:stop`）并发调用无读改写竞态。
- 典型用途：计数器、告警状态、阈值配置、心跳时间戳。

### 4.3 `ctx.timer` / `ctx.onDispose` — 生命周期安全的后台工作

```js
ctx.timer.setInterval(() => ctx.kv.set('heartbeat', Date.now()), 5000)  // 关闭自动回收
ctx.onDispose(() => ctx.logger.info('插件清理完成'))                     // 显式清理登记
```

服务关闭序列：**先逐插件执行 onDispose 队列（逐个 try/catch）→ 再广播 `server:close`**。

### 4.4 `ctx.route` — 插件 API（增强后端）

```js
ctx.route('GET', '/stats', () => ctx.kv.all())
ctx.route('POST', '/reset', (event) => {
  const body = event.awBody        // 宿主已预读 JSON body
  ctx.kv.reset()
  return { ok: true }              // 返回值由 nitro 序列化为 JSON
})
```

→ `GET /api/plugins/<name>/stats`。v1 鉴权由插件自理（handler 内可用 `resolveUser(event)` 复用业务鉴权）。

### 4.5 `ctx.api` vs `ctx.http` vs `ctx.events` — 怎么选

| 需求 | 用 | 原因 |
|---|---|---|
| 读/写**平台业务数据**（产线、节点、孪生…） | `ctx.api` | 鉴权/信封/资源语义开箱即用 |
| 调**外部系统**（MES、webhook、邮件网关） | `ctx.http` | 通用请求 + 协议守卫 |
| 对**实时流**做反应（采样、告警、启停） | `ctx.events` / `ctx.hooks.on` | 进程内直连，零 HTTP 开销 |

> 鉴权说明：`ctx.api` 自环调用遵循平台 REST 鉴权策略——免鉴权端点（manifest/ping）
> 开箱即用；鉴权端点需 `ctx.api.setToken(token)`（token 可来自环境变量，如 `AW_TOKEN`）。
> 服务端插件若仅需进程内数据，优先用 `ctx.events` 与 `ctx.hooks`（零鉴权、零开销）。

---

## 5. 生命周期事件（服务端，全部钩子）

| 事件 | 触发时机 | payload | 典型用途 |
|---|---|---|---|
| `plugin:host:init` | 宿主装载完所有插件后 | `{ plugins: string[], failures: number }` | 就绪自证、延迟初始化 |
| `config:changed` | `runtime-settings.json` 变化（`aw config set` / 设置页写入） | `{ at }` | 热更新阈值、刷新缓存的配置 |
| `daq:sample` | 数采**下发级**采样（与 WS `daq.reading` 同点、按节点 publishIntervalMs 节拍） | `{ nodeId, templateRef, value, state, at }` | 越限告警、统计、联动 |
| `dcw:write` | 写控 ACK 后观察（与运维入册同点、10s 去重） | `{ nodeId, name, eng, prevValue, ok, source, lineId, at }` | 写审计、趋势记录 |
| `line:start` | 产线开跑 | `{ lineId, runId, recipeId, productName? }` | 批次开始联动 |
| `line:stop` | 产线停止 | `{ lineId, runId }` | 批次收尾、报告生成 |
| `event:<scene-type>` / `event:*` | scene 全部实时事件（`device.created` · `daq.node.changed` · `ops.log` …与 WS 同源） | 事件 payload | 任意平台事件的观察与增强 |
| `server:close` | 服务关闭（disposables 回收之后） | `{ at }` | 最终落盘、对外通知 |

> v1 钩子为**观察语义**——不改变联锁/写控决策；veto（拦截/改写）钩子在路线图。

---

## 6. 浏览器端 SDK（`agentworkshop/sdk/client`）

插件 `client.mjs`（自包含 ESM，**无裸导入**）导出 `setup(ctx)`，由宿主 loader 动态装载：

```js
export function setup(ctx) {
  const badge = ctx.el('div', { style: 'color:#35e0a0' }, ['⌁ 0'])
  ctx.root().append(badge)                       // 私有挂载点(右下角)
  let n = 0
  ctx.on('daq:sample', () => { badge.textContent = `⌁ ${++n}` })
  ctx.on('page:change', ({ path }) => ctx.log.info('page →', path))
}
```

| 成员 | 说明 |
|---|---|
| `ctx.on(type, fn)` | 实时事件订阅（`daq:sample` / `event:<type>` / `event:*` / `page:change`），**pagehide 自动回收** |
| `ctx.fetch(path, opt?)` | 同源平台 API 助手（自动 JSON + 信封解包；非 2xx 抛错） |
| `ctx.el(tag, attrs, children)` | DOM 构建（style/class/事件 attrs 特判） |
| `ctx.root()` | 插件私有挂载点 `#aw-plugin-<name>`（懒创建） |
| `ctx.mount(target, node)` | 挂载到任意选择器/元素 |
| `ctx.hooks` | 本地 HookBus（`client:init` / `page:change` / `client:destroy`） |
| `ctx.dispose()` | 卸载：回收订阅 + 清空挂载点 + 广播 `client:destroy`（pagehide 自动触发，幂等） |

---

## 7. 类型与 TypeScript

```ts
import type { PluginDef, PluginContext, PlatformClient } from 'agentworkshop/sdk'

export default {
  name: 'typed-plugin',
  async setup(ctx: PluginContext) {
    const threshold: number = ctx.config.get('api.timeout')
  },
} satisfies PluginDef
```

运行时**不引入** SDK（保持零依赖形态）；类型在构建期擦除。

## 8. 版本与兼容性策略

- SDK 遵循 semver：patch = 修复；minor = 新增钩子/ctx 成员（向后兼容）；major = 破坏性契约变更。
- `aw start` 启动时对配置根做校验与就地迁移——升级不丢数据。
- 宿主在 ctx 中暴露 `ctx.sdkVersion`，插件可按版本特性降级。
