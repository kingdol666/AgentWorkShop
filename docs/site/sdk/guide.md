# AgentWorkShop SDK 开发与使用指南

> SDK 是 AgentWorkShop 的**编程客户端与扩展基座**:外部项目经它消费平台 REST 服务;
> 插件经它获得宿主注入的运行时上下文(钩子 / 配置 / 存储 / 定时器 / 平台 API / 事件流)。
> 零第三方运行时依赖,Node ≥ 23.4 与现代浏览器双端可用。

**SDK 版本常量**:服务端 `SDK_VERSION = '0.3.0'`,浏览器端 `CLIENT_SDK_VERSION = '0.3.0'`。
这两个常量是 **SDK 自身接口的版本号**,与 npm 包版本(`package.json` 的 `version`,当前 0.7.38)
**各自独立演进** —— 常数不同步是预期行为,不要拿 `SDK_VERSION` 去推断包版本,反之亦然。
**模块形态**:ESM only(只有 `import` / `export`,没有 CJS 入口)。
**类型**:`sdk/index.d.mts`、`sdk/client.d.mts` 随包发布,TS 项目零配置获得提示(覆盖范围见 §7)。

---

## 1. 获取 SDK

### 1.1 全局安装形态(含 CLI 与平台本体)

```bash
npm install -g agentworkshop
```

SDK 位于全局包内:`$(npm prefix -g)/node_modules/agentworkshop/sdk/`。
插件**无需也不应该**直接 import 它(见 §2 的宿主注入模型),它主要服务两类人:

- **外部项目集成**:把 AgentWorkShop 的产线 / 数采 / 写控 / 孪生能力嵌进你自己的 node 服务;
- **插件开发**(TS):仅导入类型获得完整 IntelliSense,运行时由宿主注入。

### 1.2 项目依赖形态(推荐集成方)

```bash
npm install agentworkshop        # 作为依赖(含完整 SDK 与类型)
```

### 1.3 导入路径

`package.json` 的 `exports` 只开放四个入口:

| 导入 | 解析到 | 内容 |
|---|---|---|
| `agentworkshop` | `sdk/index.mjs` | 与 `agentworkshop/sdk` **完全同一个门面**(根导入此前未见于文档,可以照用) |
| `agentworkshop/sdk` | `sdk/index.mjs` | 全部门面(服务端 + 浏览器端 + 平台 REST 客户端 + 类型) |
| `agentworkshop/sdk/client` | `sdk/client.mjs` | 仅浏览器端(`createClientContext`) |
| `agentworkshop/package.json` | `package.json` | 包元数据 |

**深路径不可导入**:`agentworkshop/sdk/api.mjs`、`agentworkshop/sdk/hooks.mjs`
这类路径没有出现在 `exports` 里,Node 会抛 `ERR_PACKAGE_PATH_NOT_EXPORTED`。
需要哪个符号,就从上面三个入口取。

```js
import { createPlatformClient, definePlugin, HookBus } from 'agentworkshop/sdk'
import { createClientContext } from 'agentworkshop/sdk/client'   // 仅浏览器端
```

### 1.4 命名导出清单

| 入口 | 命名导出 |
|---|---|
| `agentworkshop/sdk`(等价于 `agentworkshop`) | `SDK_VERSION`、`definePlugin`、`createPluginContext`、`createRouteTable`、`validatePluginModule`、`validatePluginSettings`、`validatePluginGroups`、`resolvePluginGroupId`、`pluginKvExists`、`isPathInside`、`HookBus`、`createPlatformClient`、`CLIENT_SDK_VERSION`、`createClientContext`、`LIFECYCLE_EVENTS`、`CLIENT_EVENTS` |
| `agentworkshop/sdk/client` | `CLIENT_SDK_VERSION`、`createClientContext` |

### 1.5 其余命名导出速查

插件作者平时用的是宿主注入的 `ctx`(§4);下面这些符号服务于宿主装配、脚手架与校验工具。

| 符号 | 签名 | 用途 |
|---|---|---|
| `createPluginContext(opts)` | `opts` 为宿主装配对象 | 由宿主调用生成 `ctx`;插件作者不需要自己调 |
| `createRouteTable()` | → `{ register, resolve, byPlugin, unregisterPlugin, size }` | 宿主路由表:精确匹配,挂 `/api/plugins/<name><path>` |
| `definePlugin(def)` | `def` → `def` | 纯类型糖兼形态校验;不合法直接抛错。宿主同样接受裸对象导出 |
| `validatePluginModule(mod, source)` | → `{ ok, def?, error? }` | 装载前的入口形态检查(`name` 必填、`setup` 必须是函数、`client` 必须是字符串、`settings` 必须是数组) |
| `validatePluginSettings(pluginName, defs)` | → `{ descriptors, errors }` | 校验并规范化设置声明;规则见 §4.9 |
| `validatePluginGroups(pluginName, defs)` | → `{ groups, errors }` | 校验并规范化配置分组声明 |
| `resolvePluginGroupId(pluginName, declaredId)` | → `string` | 把声明的分组名收敛进 `plugin-<name>[-<suffix>]` 命名空间 |
| `pluginKvExists(dataDir, name)` | → `boolean` | 探测 `<dataDir>/plugins/<name>/kv.json` 是否存在 |
| `isPathInside(dir, p)` | → `boolean` | 路径包含判定(用 `relative()`,不会被 `…/foo-evil` 这类兄弟同前缀目录骗过) |
| `HookBus` | `class` | 钩子总线实现;宿主持有一个共享实例,插件侧拿到的是作用域门面(§4.1) |
| `LIFECYCLE_EVENTS` | 冻结数组(11 项) | 服务端事件权威清单(§5) |
| `CLIENT_EVENTS` | 冻结数组(5 项) | 浏览器端事件权威清单(§5) |

---

## 2. 核心模型:两种身份,一个 SDK

| 身份 | 形态 | SDK 的角色 |
|---|---|---|
| **外部集成者** | 普通依赖 | 直接调用 `createPlatformClient()` 消费平台 REST 面 |
| **插件作者** | 导出 `{ name, setup(ctx) }` | `ctx` 即宿主注入的 SDK 上下文 —— **零导入依赖**,SDK 运行时由宿主提供 |

> 为什么插件不直接 import SDK?全局安装的插件目录(`~/.AgentWorkShop/plugins/`)
> 不在 node_modules 解析链上,宿主注入是唯一零坑形态(VSCode `activate(context)` 同范式)。

插件入口就是一个普通 ESM 模块:

```js
export default {
  name: 'my-plugin',
  version: '1.0.0',
  description: '示例插件',
  auth: 'none',              // 插件路由的声明式鉴权,见 §4.4
  client: './client.mjs',    // 浏览器端入口(可省略),见 §6
  async setup(ctx) {
    ctx.logger.info('已装载,目录:', ctx.dir)
  },
}
```

---

## 3. 平台 REST 客户端 `createPlatformClient`

SDK 作为「项目服务客户端」的门面:自动携带 Bearer token、自动解包平台统一信封
`{ code, message, data } → data`、按下面的规则抛错。

### 3.1 创建

```js
import { createPlatformClient } from 'agentworkshop/sdk'

const api = createPlatformClient({
  baseUrl: 'http://127.0.0.1:3001',  // 缺省 ''(同源相对路径);集成方填平台地址
  token: '<bearer-token>',            // 可选;后续可 api.setToken() 更换
  timeoutMs: 10_000,                  // 可选;单请求超时(AbortSignal),默认 10 000
  logger,                             // 可选;请求失败时告警
})
```

- `baseUrl` 缺省为 `''`,即同源相对路径;它**也可以是一个函数**,每次请求时惰性求值
  (宿主的监听端口要到服务真正 listen 之后才确定,所以宿主传的是 `() => origin`)。
- 结尾的 `/` 会被自动去掉,`'http://host:3001/'` 与 `'http://host:3001'` 等价。

### 3.2 信封与错误语义(三条路径,别记混)

| 情形 | 行为 |
|---|---|
| HTTP 非 2xx | 抛 `Error`,错误对象上**只有 `err.status` 与 `err.body`**;这条路径**不设 `err.code`** |
| HTTP 200 但信封 `code !== 0` | 抛 `Error`,错误对象上 `err.status`、`err.code`、`err.body` **三者都有** |
| 成功 | 返回解包后的 `data`;响应体不含 `code`/`data` 信封时**原样返回**(例如 `GET /api/workshop/plugins`、`GET /api/plugins/manifest`) |

```js
try {
  await api.daqNodes.get('no-such-node')
}
catch (err) {
  err.status   // 404
  err.body     // { code: 'NOT_FOUND', message: '…', data: null }
  err.code     // undefined —— 非 2xx 路径不设 code
}
```

> 平台侧 `defineApiHandler` 会把业务错误设成对应的非 2xx 状态码,所以日常遇到的几乎都是第一条路径。
> 第二条路径是 SDK 的防御性检查(`sdk/api.mjs` 在解包前先看 `code`),主要防的是
> 「不走统一包装器、却在 200 下返回错误信封」的端点 —— 没有这道检查,插件会把错误信封
> 解包成 `null` 当成功用。

### 3.3 通用调用(任意平台路径)

| 方法 | 签名 | 说明 |
|---|---|---|
| `api.call(method, path, body?, opt?)` | 底层 | `opt` 可带 `{ timeoutMs, headers }`;返回解包后的 `data` |
| `api.get(path, query?)` | query 对象自动序列化 | `api.get('/api/workshop/dcw', { page: 1 })` |
| `api.post(path, body?)` | JSON 序列化 | |
| `api.patch(path, body?)` | | |
| `api.delete(path)` | | |
| `api.setToken(token)` | 链式,返回 `api` 自身 | 登录后 `api.setToken(res.token)`;传 `null` 清除 |
| `api.ping()` | `GET /api/plugins/manifest` | 存活探测(免鉴权) |

`toQuery` 会**丢弃 `undefined`、`null` 与空串**的字段,所以 `api.get('/x', { lineId: undefined })`
不会产生 `?lineId=undefined`。

### 3.4 资源面与真实基路径

每个资源由内部的 `resource(root)` 生成,因此**都带齐五项**:
`list(query?)`、`get(id)`、`create(body)`、`update(id, patch)`、`remove(id)`。
「方法存在」不等于「服务端路由存在」,真实可用性见 §3.5。

| 命名空间 | 基路径 | 额外方法 |
|---|---|---|
| `api.users` | `/api/users` | `login(email, password)` → `{ user, token }`;`me()` |
| `api.lines` | `/api/workshop/dcw/lines` | `start(id, recipeId = '')`;`stop(id)` |
| `api.products` | `/api/workshop/dcw/products` | — |
| `api.recipes` | `/api/workshop/dcw/recipes` | — |
| `api.dcwNodes` | `/api/workshop/dcw` | — |
| `api.daqNodes` | `/api/workshop/daq` | `alarms()` → `GET /api/workshop/daq/alarms` |
| `api.templates` | — | `daq()` / `dcw()`:读两条列表响应里的 `.templates` |
| `api.twins` | `/api/workshop/device-twins` | — |
| `api.teams` | `/api/workshop/teams` | — |
| `api.agents` | `/api/workshop/agents` | — |
| `api.channels` | `/api/workshop/channels` | — |
| `api.permissions` | — | `overview()` → `GET /api/workshop/permissions`;`set({ userId, grants })` → `PUT /api/workshop/permissions`(admin) |
| `api.plugins` | — | `manifest()` |

`api.permissions.set` 的载荷形状:

```json
{ "userId": "<用户 id>", "grants": [{ "lineId": "<产线 id>", "mode": "readonly" }] }
```

`mode` 取 `'readonly'` / `'operate'` / `null`(传 `null` 表示撤销该项授权)。

### 3.5 路由实际支持情况

`resource(root)` 一律生成五项,但服务端只有部分路由文件存在。**下表是逐个路由文件核对的结果**:
「否」表示该调用打到不存在的路径,实际会 404。

| 命名空间 | `list` | `get(id)` | `create` | `update(id)` | `remove(id)` | 备注 |
|---|---|---|---|---|---|---|
| `users` | 是 | 是 | 是 | **否** | 是 | 服务端只有 `PUT /api/users/:id`,而 `update()` 发的是 `PATCH`;需要更新用户请直接 `api.call('PUT', '/api/users/' + id, patch)`。`list`/`get`/`create` 均需 admin |
| `lines` | 是 | 否 | 是 | 是 | 是 | 另有 `start` / `stop`。`create` 需要 `admin` 或 `editor` 角色 |
| `products` | **否** | 否 | 是 | 是 | 是 | 没有 `GET /api/workshop/dcw/products`;产品列表从 `GET /api/workshop/dcw` 的 `.products` 读(见 §3.6) |
| `recipes` | 是 | 否 | 是 | 是 | 是 | `list()` 返回 `{ recipes, runs }`;`recipes.get(id)` 无对应路由 |
| `dcwNodes` | 是 | 否 | 是 | 是 | 是 | 无 `[id].get.ts`;节点列表从 `GET /api/workshop/dcw` 的 `.nodes` 读 |
| `daqNodes` | 是 | 否 | 是 | 是 | 是 | 无 `[id].get.ts`;`alarms()` 可用 |
| `twins` | 是 | 否 | 是 | 是 | 是 | 无 `[id].get.ts` |
| `teams` | 是 | 是 | 是 | 是 | 是 | 完整 CRUD |
| `agents` | 是 | 是 | 是 | 是 | 是 | 完整 CRUD |
| `channels` | 是 | 是 | 是 | 是 | 是 | 完整 CRUD |
| `permissions` | 仅 `overview()` | — | — | — | — | 无 `resource()` 五项;只有 `overview()` 与 `set()` |
| `plugins` | 仅 `manifest()` | — | — | — | — | 免鉴权 |

鉴权与超时:

- `api.lines.list()`、`api.daqNodes.list()`、`api.dcwNodes.list()` 等业务读接口都走平台鉴权,
  需要用户 token(`api.setToken(...)` 或浏览器里的 cookie);
- `api.plugins.manifest()` 与 `api.ping()` 免鉴权,是唯一的两个「不开 token 就能调」的接口。

### 3.6 响应形状速查

**列表不一定返回数组** —— 这是最容易踩的坑,下面每一条都对着服务端 handler 核过。

| 调用 | 真实响应 |
|---|---|
| `api.lines.list()` | `{ lines, states }`(**不是数组**) |
| `api.daqNodes.list()` | `{ controller, nodes, meta, driverAvailable, infra, templates }` |
| `api.dcwNodes.list()` | 多键对象(`controller` / `nodes` / `templates` / `recipes` / `runs` / `history` / `products` / `lines` …),**不是节点数组** |
| `api.recipes.list()` | `{ recipes, runs }` |
| `api.twins.list()` | `{ twins }` |
| `api.daqNodes.alarms()` | `{ alarms }` |
| `api.permissions.overview()` | `{ lines, users }` |
| `api.templates.daq()` / `api.templates.dcw()` | 数组(`.templates ?? []`) |
| `api.teams.list()` / `api.agents.list()` / `api.channels.list()` | 数组 |
| `api.users.list()` | `{ items, total, page, pageSize }` |
| `api.plugins.manifest()` | `{ plugins }`(无信封,原样返回) |
| `api.lines.create(body)` | `{ line }` |
| `api.recipes.create(body)` | `{ recipe }` |
| `api.products.create(body)` | `{ product }` |
| `api.dcwNodes.create(body)` / `api.daqNodes.create(body)` | `{ node }` |
| `api.twins.create(body)` | `{ twin }` |
| `api.lines.start(id, recipeId)` | `{ run, line }` |
| `api.users.login(email, password)` | `{ user, token }` |

关于 `api.daqNodes.list({ lineId })`:`{ lineId }` 这个查询参数**服务端 handler 并不读取**,
产线过滤是按调用者权限在服务端做的(普通用户只看到被授权产线的节点)。
不要把它当成可用的客户端过滤器。

关于 `api.lines.start(id, recipeId)`:`recipeId` 缺省是空串,但服务端**要求一个真实存在的配方**
(空串或未知 id 会得到 404 `Recipe 不存在`)。产线有配方时,`recipeId` 事实上是必填参数。

### 3.7 完整示例:外部项目集成

```js
import { createPlatformClient } from 'agentworkshop/sdk'

const api = createPlatformClient({ baseUrl: 'http://plant.local:3001' })

const { token } = await api.users.login('you@example.com', 'secret')
api.setToken(token)

// 1) 产线列表:{ lines, states } —— 不是数组
const { lines, states } = await api.lines.list()
console.log(`产线 ${lines.length} 条`)
for (const l of lines) {
  console.log(`  ${l.name} → ${states.find(s => s.lineId === l.id)?.state ?? '未知'}`)
}

// 2) 数采面:{ controller, nodes, meta, driverAvailable, infra, templates }
const { nodes } = await api.daqNodes.list()
console.log(`数采节点 ${nodes.length} 个,离线 ${nodes.filter(n => n.state === 'offline').length} 个`)

// 3) 写控面:节点列表同样是对象,产品从 dcwNodes.list() 的 .products 读
const dcw = await api.dcwNodes.list()
console.log(`写控节点 ${dcw.nodes.length} 个,产品 ${dcw.products.length} 个`)

// 4) 配方面:{ recipes, runs }
const { recipes } = await api.recipes.list()

// 5) 开跑:recipeId 必须是本产线的真实配方(传空串会被服务端拒绝)
const line = lines[0]
const recipe = recipes.find(r => r.lineId === line?.id)
if (line && recipe) {
  await api.lines.start(line.id, recipe.id)
  await api.lines.stop(line.id)
}

// 6) 产线授权(admin):overview() 全量,set() 批量写
const { users } = await api.permissions.overview()
const target = users[0]
if (target && line) {
  await api.permissions.set({ userId: target.id, grants: [{ lineId: line.id, mode: 'readonly' }] })
}
```

---

## 4. 插件上下文 `ctx`(完整成员)

`setup(ctx)` 收到的 `ctx` 是宿主装配的 SDK 运行时。**下表是完整成员面**;
最后三行(`ctx.daq` / `ctx.omp` / `ctx.services`)由插件宿主在 `setup` 之前直接挂载,不在 `sdk/context.mjs` 里。

| 分组 | 成员 | 类型 | 说明 |
|---|---|---|---|
| 身份 | `ctx.name` | `string` | 插件名(= 目录名 / 声明名) |
| | `ctx.scope` | `'builtin' \| 'project' \| 'user'` | 装载作用域;同名时优先级 builtin > project > user |
| | `ctx.dir` | `string` | 插件目录绝对路径 |
| | `ctx.sdkVersion` | `string` | SDK 接口版本(= `SDK_VERSION`) |
| 钩子 | `ctx.hooks` | `{ on, once, off, emit }` | 本插件作用域的钩子门面(§4.1);**不是 `HookBus` 实例,没有 `.size`** |
| 日志 | `ctx.logger` | `{ debug, info, warn, error }` | 输出前缀 `[aw-plugins] [<插件名>]` |
| 配置 | `ctx.config.get(key)` | 任意 | 有效配置项(四层合并后的值) |
| | `ctx.config.all()` | `Record<string, any>` | 全部有效配置的浅拷贝快照 |
| | `ctx.config.onChange(fn)` | 退订函数 | 订阅 `config:changed`(§4.5) |
| | `ctx.config.defineGroup(def)` | 分组对象 \| `null` | 声明本插件专属配置分组(§4.9) |
| | `ctx.config.defineField(decl)` | 描述符 \| `null` | 声明配置字段(key 自动编址 `plugins.<name>.<key>`) |
| | `ctx.config.removeGroup(id)` | `boolean` | 摘除分组声明 |
| | `ctx.config.removeField(key)` | `boolean` | 摘除字段声明 |
| | `ctx.config.groups()` / `fields()` | 数组 | 本插件当前已注册的分组 / 字段(只读快照) |
| 路径 | `ctx.paths` | `{ home, configRoot, dataDir }` | 配置根信息(home 模式 = `~/.AgentWorkShop`) |
| | `ctx.dataDir` | `string` | 本插件私有数据目录 = `<paths.dataDir>/plugins/<name>` |
| 存储 | `ctx.kv` | `{ get, set, all, bump }` | 插件私有 KV(§4.2);**没有 `reset()`** |
| 定时 | `ctx.timer.setInterval(fn, ms)` / `setTimeout(fn, ms)` | 定时器 id | 自动 `unref` + 关闭/热重载自动回收(§4.3) |
| 清理 | `ctx.onDispose(fn)` | 传入的 `fn` | 登记清理回调(§4.3) |
| | `ctx.subscriptions.add(d)` | 传入的 `d` | 登记 `{ dispose() }` 对象或函数;与 `onDispose` 同一回收队列 |
| 路由 | `ctx.route(method, path, handler)` | `boolean` | 挂到 `/api/plugins/<name><path>`;鉴权由插件 `auth` 字段声明(§4.4) |
| 平台 | `ctx.api` | `PlatformClient` | 自环 REST 客户端(**默认无 token**;§4.6) |
| 网络 | `ctx.http.get(url, opts)` / `post(url, body, opts)` | `Promise<Response>` | 出站请求,守卫只限协议,默认 8s 超时(§4.6) |
| 事件 | `ctx.events.on(type, fn)` / `off(type, fn)` | 退订函数 | scene 实时事件订阅,自动补 `event:` 前缀(§4.6) |
| 产线权限(宿主注入) | `ctx.permissions` | 见 §4.7 | 用户 × 产线三态授权的查询与管理 |
| 数采扩展(宿主注入) | `ctx.daq` | 见 §4.8 | 驱动 / 处理器 / 模板注册 + 帧订阅 + 时序查询 |
| Agent 工具(宿主注入) | `ctx.omp.registerTool(tool)` | 见 §4.8 | 运行时热注入自定义 host 工具 |
| 运行时服务(宿主注入) | `ctx.services` | 见 §4.8 | 惰性服务取数 + 跨插件供服务 |

`ctx` 上**没有** `ctx.routes`、`ctx.dcw`、`ctx.scene`、`ctx.version`:
路由注册只有单数的 `ctx.route()`;写控流量靠 `dcw:write` 钩子观察;scene 事件走 `ctx.events`。

### 4.1 `ctx.hooks` — 钩子门面

宿主持有一个名为 `aw-plugins` 的共享 `HookBus`,插件拿到的是**只含 `on` / `once` / `off` / `emit`
的作用域门面**:经它注册的监听器会被登记,插件热重载时自动解绑(这是唯一一条永远有效的清理路径)。
门面没有 `count` / `size` / `listeners` 等诊断属性。

```js
function onSample(sample) {
  ctx.kv.bump('samples')
}

const off = ctx.hooks.on('daq:sample', onSample)   // 返回解绑函数
ctx.hooks.once('server:close', () => { /* 收尾,只触发一次 */ })
ctx.hooks.off('daq:sample', onSample)              // 手动解绑:要传原 handler
off()                                              // 或者直接调用 on() 返回的解绑函数

await ctx.hooks.emit('my-plugin:custom', { hello: 1 })   // 插件间通信:其他插件可监听
ctx.hooks.on('*', ({ type, payload }) => { /* 收全部事件 */ })
```

语义(与 `sdk/hooks.mjs` 一致):

- **异步串行**:同 type 的监听器按注册序 `await`,一个未返回不会开始下一个;
- **错误隔离**:单个监听器抛错只计数并告警,不影响兄弟监听器与主服务;
- **熔断**:同一监听器**连续**失败 8 次自动摘除;**任意一次成功即把计数清零**,偶发失败不会累积驱逐;
- **通配**:服务端通配只有裸 `'*'` 一种写法,回调收到 `{ type, payload }`,且在具名监听器之后执行;
- **返回值为 fan-out 语义,不是 waterfall**:每个监听器都收到**同一个未改动的 payload**;
  `emit()` 只返回「最后一个非 `undefined` 的返回值」,值不会在监听器之间链式传递;
- **v1 是观察语义**:没有 veto / 拦截 / 改写能力。

> `ctx.hooks.on('event:*')` 永远不会触发。`event:*` 是清单里给 scene 事件用的订阅条目名,
> 真正的通配是裸 `'*'`;scene 事件的订阅糖衣是 `ctx.events.on('<type>', fn)`(§4.6)。

### 4.2 `ctx.kv` — 插件私有持久化

```js
ctx.kv.set('threshold', 100)
ctx.kv.bump('samples')        // 原子自增,默认 +1;bump(key, by) 可指定步长
ctx.kv.bump('samples', 5)
ctx.kv.get('threshold')       // 100
ctx.kv.all()                  // { samples: 19453, threshold: 100, ... }
```

- **只有这四个方法**:`get` / `set` / `all` / `bump`。**没有 `reset()`、没有 `delete()`、没有 `keys()`**;
  要清空请显式 `set` 或换成新键。
- 落盘位置:`<ctx.dataDir>/kv.json`,即 `<paths.dataDir>/plugins/<name>/kv.json`。
- **内存态为准 + 200ms 防抖原子写**(临时文件 + `rename`),因此高频钩子(`daq:sample`)
  与低频钩子(`line:stop`)并发调用不会有读改写竞态。
- 关闭 / 热重载时会**取消挂起的防抖并同步落盘**,退出前最后 200ms 内的 `set` 不会丢。
- 典型用途:计数器、告警状态、阈值配置、心跳时间戳。

### 4.3 `ctx.timer` / `ctx.onDispose` / `ctx.subscriptions`

```js
ctx.timer.setInterval(() => ctx.kv.set('heartbeat', Date.now()), 5000)
ctx.timer.setTimeout(() => ctx.logger.info('一次性任务'), 1000)

ctx.onDispose(() => ctx.logger.info('插件清理完成'))

// subscriptions.add 接受 { dispose() } 对象或函数;与 onDispose 共用同一回收队列
const controller = new AbortController()
ctx.subscriptions.add({ dispose() { controller.abort() } })
```

- `ctx.timer.setInterval/setTimeout` 生成的定时器会自动 `unref`(不会拖住进程退出),
  并自动登记到回收队列,**不需要手动 clear**。
- `ctx.onDispose(fn)` 与 `ctx.subscriptions.add(d)`(`d` 可以是 `{ dispose() }` 或函数)
  与定时器共用**同一个宿主回收队列**。
- 该队列在**服务关闭**与**插件热重载**两种时机都会执行 —— 这是这一版 SDK 修复后给出的保证
  (`createPluginContext` 此前漏接宿主的 `onDispose` 注入口,导致定时器泄漏与最后一次 kv 写入丢失)。

服务关闭序列:

```text
服务关闭(nitro close)
  └─ 逐插件执行 dispose 队列(逐个 try/catch):定时器 clear、kv 同步落盘、订阅解绑…
      └─ 广播 server:close { at }
```

### 4.4 `ctx.route` — 插件 API

```js
export default {
  name: 'my-plugin',
  auth: 'user',        // 声明式鉴权:'none'(默认) | 'user' | 'admin' | 'agent-or-user'
  async setup(ctx) {
    // 返回 boolean:true = 注册成功,false = handler 不是函数
    const ok = ctx.route('GET', '/stats', () => ctx.kv.all())
    if (!ok) ctx.logger.warn('路由注册失败')

    ctx.route('POST', '/threshold', (event) => {
      const body = event.awBody              // 宿主已预读的 JSON body(可能是 undefined)
      const threshold = Number(body?.threshold)
      if (!Number.isFinite(threshold)) return { ok: false, error: 'threshold must be a number' }
      ctx.kv.set('threshold', threshold)
      return { ok: true, threshold }         // 返回值由 nitro 序列化为 JSON
    })
  },
}
```

→ 挂载在 `GET /api/plugins/<插件名>/stats`、`POST /api/plugins/<插件名>/threshold`。

- **返回值是 `boolean`**:`handler` 不是函数时返回 `false`。
- **路径**以 `/` 开头(缺失会被自动补上),base 固定是 `/api/plugins/<插件名>`。
- **鉴权是声明式的,不要自己写**:在插件定义上给 `auth: 'none' | 'user' | 'admin' | 'agent-or-user'`,
  平台 catch-all(`server/api/plugins/[name]/[...path].ts`)会在进入你的 handler **之前**统一校验,
  失败返回 401。
- **handler 拿不到用户对象**:`resolveUser(event)` 不在 `ctx` 上,也无法从插件模块 import。
  需要用户身份时请用 `auth` 门 + `ctx.api.setToken(...)` 走平台接口。
- **JSON body 已预读**,挂在 `event.awBody` 上(不是 h3 的 `readBody`)。
- handler 抛错会被隔离:平台记录带插件名的日志,并返回 500 信封
  (`插件路由处理失败(<插件名>): <原始消息>`),不会裸传堆栈。

### 4.5 `ctx.config` — 配置读取与变更

```js
ctx.config.get('plugins.my-plugin.threshold')   // 有效值(四层合并后)
ctx.config.all()                                // 全部有效配置(浅拷贝)

const off = ctx.config.onChange((payload) => {  // payload: config:changed 载荷,见 §5
  ctx.logger.info('配置已变更:', payload?.changed)
})
```

`config:changed` 由平台设置服务的变更事件桥接到插件总线,`ctx.config.onChange(fn)`
本质是 `ctx.hooks.on('config:changed', fn)`,因此热重载时同样会自动解绑。

### 4.6 `ctx.api` / `ctx.http` / `ctx.events` — 怎么选

| 需求 | 用 | 原因 |
|---|---|---|
| 读 / 写**平台业务数据**(产线、节点、孪生…) | `ctx.api` | 鉴权 / 信封 / 资源语义开箱即用 |
| 调**外部系统**(MES、webhook、邮件网关) | `ctx.http` | 通用请求 + 协议守卫 |
| 对**实时流**做反应(采样、告警、启停) | `ctx.events` / `ctx.hooks.on` | 进程内直连,零 HTTP 开销 |

```js
// ctx.api:自环 PlatformClient。baseUrl 由宿主惰性解析,默认不带 token。
const { token } = await ctx.api.users.login('user@example.com', 'secret')
ctx.api.setToken(token)                    // 之后的自环调用带上该 token
const { lines } = await ctx.api.lines.list()

// ctx.http:出站请求,只做协议守卫(仅 http/https),默认 8s 超时
const res = await ctx.http.get('https://mes.example.com/health', { timeoutMs: 3000 })
const payload = await ctx.http.post('https://mes.example.com/events', { lineId: 'L1' })

// ctx.events:scene 事件,type 传场景事件名本身,自动补 `event:` 前缀
ctx.events.on('daq.reading', r => ctx.logger.info('采样', r.nodeId))
ctx.events.on('permissions.changed', ({ userId }) => ctx.logger.info('授权变更', userId))
ctx.events.on('device.created', d => ctx.logger.info('新设备', d.id))
const off = ctx.events.on('daq.alarm', a => ctx.logger.warn('告警', a.id))
off()
```

- `ctx.api` **默认无 token**:免鉴权端点(`plugins.manifest` / `ping`)可直接用;
  其余端点要先登录再 `setToken`。若只需要进程内数据,优先用 `ctx.events` 与 `ctx.hooks`(零鉴权、零开销)。
- `ctx.http` 的守卫**只检查协议**,不限制主机名 —— 目标地址由插件自己负责。
- `ctx.events.on(type, fn)` / `off(type, fn)` 内部装的是 `event:<type>`;
  要收全部 scene 事件请用 `ctx.hooks.on('*', ({ type, payload }) => …)`。

### 4.7 `ctx.permissions` — 用户 × 产线授权

| 方法 | 返回 | 说明 |
|---|---|---|
| `lineMode(user, lineId)` | `'none' \| 'readonly' \| 'operate'` | `user` 是 `{ id, role }`;admin/editor 恒为 `operate` |
| `visibleLineIds(user)` | `Set<string> \| null` | `null` 表示不限(admin/editor) |
| `listGrants(userId)` | `Array<{ lineId, mode, grantedBy, grantedAt }>` | 读取某用户的全部授权 |
| `setGrants(userId, grants, grantedBy?)` | 写入后的授权数组 | `grants` 形如 `[{ lineId, mode }]`,`mode` 取 `'readonly'` / `'operate'` / `null` |

```js
const userId = ctx.kv.get('watchUserId')          // 插件侧的 userId 来自事件载荷或自身配置
if (userId) {
  const mode = ctx.permissions.lineMode({ id: userId, role: 'user' }, 'line-1')
  const visible = ctx.permissions.visibleLineIds({ id: userId, role: 'user' })
  const grants = ctx.permissions.listGrants(userId)
  ctx.logger.info(`mode=${mode} visible=${visible ? visible.size : 'all'} grants=${grants.length}`)
}

// 变更通知是 scene 事件 permissions.changed,经 ctx.events 补前缀后订阅
ctx.events.on('permissions.changed', ({ userId }) => ctx.logger.info('授权变更:', userId))
```

### 4.8 宿主注入的扩展面 `ctx.daq` / `ctx.omp` / `ctx.services`

**`ctx.daq`** —— 多形态数采扩展(v0.6 帧管线):

| 方法 | 说明 |
|---|---|
| `registerDriver({ kind, available, sample, test })` | 注册自定义驱动 |
| `registerProcessor(kind, name, fn)` | 注册下沉处理器(采样后、入库前) |
| `registerTemplate(def)` | 注册数采节点模板(`key` / `signalKind` / `vector` / `sink` / `metrics`) |
| `onFrame(fn)` | 帧订阅糖衣(= `ctx.hooks.on('daq:frame', fn)`) |
| `onSample(fn)` | 采样订阅糖衣(= `ctx.hooks.on('daq:sample', fn)`) |
| `query({ nodeIds?, lineId?, from?, to?, bucketMs? })` | 免鉴权时序查询(直通 `queryTagged`) |
| `nodes()` | 数采节点元数据快照(含产线归属) |

```js
ctx.daq.registerProcessor('vector', 'my-derive', (frame) => {
  // frame = { kind: 'vector'|'image', points? | blob?(仅图像生产侧), metrics }
  return { ...frame, metrics: { ...frame.metrics, myMetric: 1 } }
})
ctx.daq.onFrame(f => ctx.logger.debug('帧', f.nodeId, f.kind))
const rows = await ctx.daq.query({ nodeIds: ['n1'], from: Date.now() - 3600_000, to: Date.now(), bucketMs: 60_000 })
const all = await ctx.daq.nodes()
```

模板的 `sink.processors` 声明下沉管线;`metrics` 声明派生指标阈值,越限走平台既有告警链路。
向量 / 帧元数据入 Timescale `daq_frames`,图像像素入对象存储(`daq:frame` 载荷**不含像素 blob**)。

**`ctx.omp.registerTool({ name, label?, description, parameters, roles?, handler })`** ——
注册自定义 host 工具,运行时热注入全部在跑的 agent 会话:

```js
ctx.omp.registerTool({
  name: 'sensor_log',
  label: '传感器标定',
  description: '查询或登记传感器标定结论',
  parameters: { type: 'object', properties: { sensor: { type: 'string' } }, required: ['sensor'] },
  roles: ['lead', 'worker'],                          // 合法字面量只有 'lead' 与 'worker';缺省双角色
  handler: async (args, agent) => ({ text: `已登记 ${args.sensor}` }),   // agent = { agentId, channelId, role, name }
})
```

注册表变更即时热注入在跑会话(重发 `set_host_tools`,不重 spawn);与内置 host tool 同名会被忽略。

**`ctx.services`** —— 后端运行时对象面(惰性 getter,取到后缓存):

| 调用 | 解析为 |
|---|---|
| `ctx.services.names()` | 全部服务名(含插件提供的 `<plugin>.<name>`) |
| `await ctx.services.get('daq')` | `{ query(q), nodes() }` |
| `await ctx.services.get('lines')` | `{ list(), byId(id) }` |
| `await ctx.services.get('channels')` | `{ list(), agents(channelId) }` |
| `await ctx.services.get('plugins')` | 插件清单**数组**(注意不是对象,也没有 `pluginManifest()`) |
| `ctx.services.provide(name, getter)` | 供服务,自动加 `<插件名>.` 前缀 |

```js
const daq = await ctx.services.get('daq')
const lines = await ctx.services.get('lines')
const channels = await ctx.services.get('channels')
const plugins = await ctx.services.get('plugins')      // 数组
ctx.services.provide('my-data', async () => ({ ready: true }))   // → 'my-plugin.my-data'
ctx.logger.info(ctx.services.names().join(', '))
```

未知名会抛错(错误由调用方兜底)。`provide` 强制 `<插件名>.` 前缀,避免跨插件命名冲突。

### 4.9 插件设置声明(`settings` / `configGroups`)

两条路径等价:入口顶层的 `settings` 数组(声明式),或 `setup` 里的 `ctx.config.defineField`(条件式)。

```js
export default {
  name: 'my-plugin',
  configGroups: [{ id: 'conn', label: '连接', collapsed: true }],
  settings: [
    { key: 'base_url', type: 'string', default: 'https://example.com', group: 'conn',
      labelKey: 'plugin.my-plugin.base_url', label: '服务地址' },
  ],
  async setup(ctx) {
    // 等价写法:按条件在运行时补声明
    ctx.config.defineGroup({ id: 'sync', label: '同步' })
    ctx.config.defineField({ key: 'interval', type: 'number', default: 30, min: 1, max: 3600, group: 'sync' })
  },
}
```

校验规则(不满足的条目**会被跳过并告警**,不阻断插件装载):

| 规则 | 细节 |
|---|---|
| `key` | 必须是 `[A-Za-z0-9_-]+`;最终编址为 `plugins.<插件名>.<key>` |
| `type` | 只能是 `'string'` / `'number'` / `'boolean'` / `'select'` |
| `default` | **必填** —— 缺 `default` 的声明直接跳过 |
| `select` | 必须给 `options` 数组,且 `default` 必须在其字符串化结果里 |
| `min` / `max` | **只对 `number` 生效** |
| 分组 | 显式 `group` 会收敛进 `plugin-<name>[-<suffix>]` 命名空间;不给 `group` 的字段落入 `plugin-<name>` 分组,标签即插件名 |

声明成功后并入平台设置服务:设置页「插件」分区自动渲染、PATCH 校验同源、保存即热生效。
读值时用完整键:`ctx.config.get('plugins.my-plugin.base_url')`。

---

## 5. 生命周期事件

权威清单是 SDK 导出的 `LIFECYCLE_EVENTS`(11 项)与 `CLIENT_EVENTS`(5 项),
与宿主实际发射面逐一核对过。**全部事件也是配置根事件流的一部分**。

### 5.1 服务端事件(`LIFECYCLE_EVENTS`,11 项)

| 事件名(总线 type) | 触发时机 | payload | 典型用途 |
|---|---|---|---|
| `plugin:host:init` | 宿主装载完所有插件(含停用)之后,一次性 | `{ plugins: string[], failures: number }` | 就绪自证、延迟初始化 |
| `plugins:reloaded` | 热重载收尾(启停插件、`plugins-state.json` 变化触发) | `{ plugins: <清单条目数组> }` | 重建缓存、重新注册外部资源 |
| `config:changed` | `runtime-settings.json` 变化(`aw config set` / 设置页写入,经 SystemConfigService 桥接) | `{ type: 'config:changed', changed: string[], effective: object, sources: object }` | 热更新阈值、刷新缓存 |
| `event:permissions:changed` | 产线授权写入成功后 | `{ userId }` | 刷新缓存的授权视图 |
| `event:*` | **订阅条目,不是被发射的事件** | — | 用裸 `'*'` 收全部事件(§4.1) |
| `daq:sample` | 数采**下发级**采样(与 WS `daq.reading` 同点、按节点 `publishIntervalMs` 节拍) | `{ nodeId, templateRef, value, state, at, lineId }` | 越限告警、统计、联动 |
| `daq:frame` | 多形态帧(向量 / 图像)下发级,与 `daq:sample` 同一条帧入账路径 | `{ nodeId, templateRef, kind, at, lineId, preview?, metrics, thumbUrl?, state }` | 自定义下沉、派生指标 |
| `dcw:write` | 写控 ACK 之后观察(不影响写控决策) | `{ nodeId, name, eng, prevValue, ok, source, lineId, at }` | 写审计、趋势记录 |
| `line:start` | 产线开跑(批次窗口开启) | `{ lineId, runId, recipeId, productName? }` | 批次开始联动 |
| `line:stop` | 产线停止(批次窗口关闭) | `{ lineId, runId }` | 批次收尾、报告生成 |
| `server:close` | 服务关闭,逐插件 dispose 队列跑完之后 | `{ at }` | 最终落盘、对外通知 |

`dcw:write` 的 `source` 取 `'manual'` / `'recipe'` / `'agent'` / `'rollback'`;
载荷里**没有 `message` 字段**(失败原因要看平台日志或入册记录)。

`config:changed` 的载荷里**没有 `at` 字段** —— 时间语义请自己取值时的 `Date.now()`,
新值从 `ctx.config.get/all()` 读。

### 5.2 浏览器端事件(`CLIENT_EVENTS`,5 项)

| 事件 | 触发时机 | payload |
|---|---|---|
| `client:init` | 客户端脚本 `setup(ctx)` 执行完成之后 | `{ name }` |
| `event:*` | scene 实时事件(与浏览器 WS 同源,经事件桥) | 事件自身 payload |
| `page:change` | 路由切换完成(`page:finish`) | `{ path }` |
| `i18n:changed` | 界面语言切换 | `{ locale }` |
| `client:destroy` | `ctx.dispose()` 回收前 | `{ name }` |

### 5.3 订阅写法对照

| 想收什么 | 服务端插件 | 浏览器端插件 |
|---|---|---|
| 具名生命周期钩子(`daq:sample` / `dcw:write` / `line:start` …) | `ctx.hooks.on('daq:sample', fn)` | 收不到(服务端钩子从不下发) |
| scene 事件(如 `daq.reading`、`device.created`) | `ctx.events.on('daq.reading', fn)` | `ctx.on('daq.reading', fn)` |
| 全部 scene 事件 | `ctx.hooks.on('*', ({ type, payload }) => …)` | `ctx.on('event:*', fn)` |
| 客户端本地钩子(`client:init` / `page:change` / `i18n:changed` / `client:destroy`) | 不适用 | `ctx.hooks.on('page:change', fn)` |

两个最容易写错的地方:

- 服务端通配只有裸 `'*'`:`ctx.hooks.on('event:*', fn)` **永不触发**;
- 客户端通配只有字面量 `'event:*'`:`ctx.on('*', fn)` **永不触发**,
  而 `ctx.on('event:line.start', fn)` 会被二次加前缀成 `event:event:line.start`,同样永不触发。

scene 事件以 `event:<type>` 进入总线,`ctx.events.on('<type>', fn)` 是补前缀的糖衣;
因此场景事件 `permissions.changed` 的正确订阅是 `ctx.events.on('permissions.changed', fn)`,
而 `ctx.hooks.on('permissions:changed', fn)` 永远不会触发。

### 5.4 关闭与热重载序列

```text
服务关闭(nitro close → shutdownPluginHost)
  └─ 逐插件执行 ctx.onDispose 队列(逐个 try/catch)
      └─ 广播 server:close { at }

插件热重载(plugins-state.json 变化 / 启停插件 / 10s 轮询兜底)
  └─ 逐插件执行 ctx.onDispose 队列
      └─ 解绑经 ctx.hooks 注册的全部监听器
          └─ 重新装载 → 广播 plugins:reloaded
              └─ 广播 scene 事件 plugins.reloaded(浏览器端 loader 据此热注入 / 卸载客户端插件)
```

> v1 钩子为**观察语义** —— 不改变联锁 / 写控决策;veto(拦截 / 改写)钩子在路线图。

---

## 6. 浏览器端 SDK(`agentworkshop/sdk/client`)

插件 `client.mjs` 是**自包含 ESM**(无裸导入,浏览器原生解析),导出 `setup(ctx)`。
入口必须在插件定义里用 `client: './client.mjs'` 声明,loader 经
`GET /api/plugins/client/<插件名>` 取回脚本后动态 import。

### 6.1 创建(宿主调用;插件只写 `setup`)

```js
import { createClientContext } from 'agentworkshop/sdk/client'

// 宿主侧装配(示意);插件作者只需要写 client.mjs 的 setup(ctx)
const listeners = new Set()
const townBus = {
  subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
}

const ctx = createClientContext({
  name: 'my-plugin',
  // 事件桥:宿主把 WS 总线的每条消息交给 dispatch
  eventBridge: dispatch => townBus.subscribe(e => dispatch(e.type, e.payload)),
  baseUrl: '',                              // 同源;跨域集成时可填平台地址
  ui: { slots: ['plugins.page'], registerPanel: () => () => {} },
  t: key => `plugin.my-plugin.${key}`,      // 宿主传入真正的翻译助手
  getLocale: () => 'zh-CN',
})
```

### 6.2 `ctx` 成员

| 成员 | 说明 |
|---|---|
| `ctx.name` | 插件名 |
| `ctx.sdkVersion` | `CLIENT_SDK_VERSION` |
| `ctx.hooks` | 客户端本地 `HookBus`;本地钩子与 scene 事件都在这条总线上 |
| `ctx.on(type, fn)` | 订阅 **scene 实时事件**,`type` 传**场景事件名本身**(如 `'daq.reading'` / `'daq.alarm'` / `'daq.alarm.changed'` / `'dcw.written'` / `'daq.node.changed'` / `'device.updated'`),内部装到 `event:<type>`;返回退订函数,**pagehide 时自动回收**。唯一的通配写法是字面量 **`'event:*'`** |
| `ctx.fetch(path, opt?)` | 同源平台 API:自动 JSON、自动解信封 `{data}`、非 2xx 抛错、**自动携带 cookie 里的平台 token** |
| `ctx.el(tag, attrs, children)` | DOM 构建:`style` / `class` / `on*` 事件属性特判 |
| `ctx.mount(target, node)` | 挂到任意选择器 / 元素;目标缺失时落到 `ctx.root()` |
| `ctx.root()` | 插件私有挂载点 `#aw-plugin-<name>`(右下角,懒创建) |
| `ctx.ui` | UI 注入面:`slots` 与 `registerPanel(entry)`(§6.4) |
| `ctx.t(key, params?)` | 插件命名空间翻译:`ctx.t('panel.title')` → `plugin.<name>.panel.title`(消息来自插件根目录 `i18n.json`;未命中回落原键)。**`params` 目前被忽略,不做插值** |
| `ctx.locale` | 当前界面语言(只读 getter) |
| `ctx.log` | 前缀 console:`info` / `warn` / `error`(**没有 `debug`**) |
| `ctx.dispose()` | 卸载:广播 `client:destroy` → 跑本地 disposables → 移除 `root()`。**幂等**;不负责注销面板(那由 loader 在停用 / 热重载时做) |

`ctx.on` 的两种错误写法:`ctx.on('*')` 与 `ctx.on('event:line.start')` 都**永不触发** ——
前者没装到裸 `'*'`,后者被二次加前缀成 `event:event:line.start`。

**服务端钩子不会到达浏览器**:`daq:sample`、`dcw:write`、`line:start` / `line:stop`
这类带冒号的服务端钩子在客户端收不到。它们的浏览器侧对应物是 scene 事件
(`daq.reading` / `daq.frame` / `dcw.written` 等),请通过 `ctx.on('<scene-type>')` 订阅。

**客户端生命周期钩子也不能走 `ctx.on`**:`client:init` / `page:change` / `i18n:changed` /
`client:destroy` 要用 `ctx.hooks.on(...)` 直订(它们没有 `event:` 前缀)。

### 6.3 完整示例

```js
export function setup(ctx) {
  const badge = ctx.el('div', {
    style: 'padding:8px 12px;border:1px solid #35e0a0;border-radius:10px;color:#35e0a0',
  }, ['samples: 0'])
  ctx.root().append(badge)

  let n = 0
  ctx.on('daq.reading', () => { badge.textContent = `samples: ${++n}` })   // scene 事件
  ctx.on('event:*', (payload) => ctx.log.info('scene 事件', payload))     // 唯一通配写法

  ctx.hooks.on('page:change', ({ path }) => ctx.log.info('page →', path)) // 本地钩子:直订

  // 消费平台 API(同源;cookie 鉴权):产线列表是 { lines, states },不是数组
  ctx.fetch('/api/workshop/dcw/lines').then(({ lines }) => ctx.log.info('产线数', lines.length))
}
```

### 6.4 UI 注入 `ctx.ui.registerPanel`

```js
let samples = 0
ctx.on('daq.reading', () => { samples += 1 })

const off = ctx.ui.registerPanel({
  slot: 'dashboard.widgets',        // 'plugins.page' | 'settings.plugins' | 'dashboard.widgets'
  name: 'my-widget',
  title: '采样统计',
  titleKey: 'plugin.my-plugin.widget.title',   // 有 titleKey 时优先
  order: 100,                        // 越小越靠前,缺省 100
  mount(el) {
    el.textContent = `samples: ${samples}`
    const tick = setInterval(() => { el.textContent = `samples: ${samples}` }, 1000)
    return () => clearInterval(tick)   // 面板卸载时调用
  },
})
off()   // 返回的注销函数;ctx.dispose() 不自动调它,loader 停用插件时统一回收
```

- `ctx.ui.slots` 就是 `['plugins.page', 'settings.plugins', 'dashboard.widgets']`。
- `registerPanel` 返回注销函数;`mount(el)` 的返回值若为函数,会在该面板卸载时被调用。

### 6.5 约束与信任

- **自包含**:不能裸导入 `vue` 等第三方包(浏览器原生 import 解析不到);
  需要 UI 组件就用原生 DOM(`ctx.el`)。
- **信任模型**:客户端脚本由平台服务端点提供,与 aw commands 同级信任 —— 只装可信插件。
- **隔离**:单插件装载失败仅 console 告警,不影响应用与其他插件。

---

## 7. 类型与 TypeScript

```ts
import type { PluginDef, PluginContext, PlatformClient } from 'agentworkshop/sdk'

export default {
  name: 'typed-plugin',
  auth: 'user',
  async setup(ctx: PluginContext) {
    const timeout: number = ctx.config.get('plugins.typed-plugin.timeout')
    const client: PlatformClient = ctx.api
    ctx.logger.info('api 可用:', typeof client.get === 'function', 'timeout:', timeout)
  },
} satisfies PluginDef
```

运行时**不引入** SDK(保持零依赖形态);类型在构建期擦除。

类型声明的当前覆盖范围(请以 `sdk/index.d.mts` / `sdk/client.d.mts` 为准):

- 已声明:`PluginDef`、`PluginContext`、`PluginHostExtensions`、`PluginSettingDecl`、
  `PluginGroupDecl`、`PluginLogger`、`PluginKv`、`PluginHttp`、`CrudResource`、
  `PlatformClient`、`ConfigChangedPayload`、`HookBus`、`ClientContext`、`ClientUi`、
  `ClientPanelEntry`、`LIFECYCLE_EVENTS`、`CLIENT_EVENTS` 与各工厂函数。
- **尚未声明**:`isPathInside`、`validatePluginSettings`、`validatePluginGroups`、
  `resolvePluginGroupId` 目前只有运行时导出,`.d.mts` 里没有对应声明 ——
  TS 项目直接 import 它们会报 TS2614,需要本地补一份声明或改用 `await import()`。
- 另外 `sdk/client.d.mts` 里声明了一个运行时不存在的 `el` 命名导出(运行时只有
  `CLIENT_SDK_VERSION` 与 `createClientContext`),导入它会编译通过但运行期拿到 `undefined`。

---

## 8. 版本与兼容性策略

- SDK 接口遵循 semver:patch = 修复;minor = 新增钩子 / `ctx` 成员(向后兼容);
  major = 破坏性契约变更。`SDK_VERSION` / `CLIENT_SDK_VERSION` 是这条线的版本号,
  **与 npm 包版本独立**,不要互相推断。
- 宿主在 `ctx` 中暴露 `ctx.sdkVersion`,插件可按版本特性降级。
- 配置根的健壮化不在 `aw start` 一条命令里,而在 **CLI 上下文构建器**中 ——
  每个 `aw` 指令在解析运行根时都会调用它(幂等),因此任意命令都不会因为配置根缺目录而失败。
- 这里**没有基于版本的目录布局迁移**:唯一的迁移是把旧位置的数据文件搬进配置根,
  即 `cwd/data`(以及历史遗留的 `cwd/server/data`)→ `<configRoot>/data`,
  只搬 `.sqlite` / `.sqlite-wal` / `.sqlite-shm` / `.json`,同名文件按
  `mtimeMs` **最新者胜**;当配置根回退到 `~/.AgentWorkShop` 时不做该迁移(避免跨项目污染)。

---

## 附:本页覆盖范围

本页是 SDK 的单一事实源指南,以 `sdk/*.mjs`、`sdk/*.d.mts`、`server/services/workshop/plugins/host.mjs`、
`server/api/**` 的实际实现为准。CI 会把本文件复制到站点 `docs/site/sdk/guide.md`,
英文版 `docs/sdk.en.md` 复制到 `docs/site/en/sdk/guide.md`。
