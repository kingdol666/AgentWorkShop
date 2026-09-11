# 平台 REST 客户端 createPlatformClient

SDK 作为「项目服务客户端」的门面:自动携带 Bearer token、自动解包平台统一信封
(`{ code, message, data } → data`),并按下面的规则抛错。

## 创建

```js
import { createPlatformClient } from 'agentworkshop/sdk'

const api = createPlatformClient({
  baseUrl: 'http://127.0.0.1:3001',  // 缺省 ''(同源相对路径);集成方填平台地址
  token: '<bearer-token>',            // 可选;后续可 api.setToken() 更换
  timeoutMs: 10_000,                  // 可选;单请求超时(AbortSignal),默认 10 000
  logger,                             // 可选;请求失败时告警
})
```

> `baseUrl` 支持**函数**(延迟解析):插件宿主的监听端口在服务真正监听后才确定,
> 宿主传的是 `() => origin`。结尾的 `/` 会被自动去掉。

## 信封与错误语义

| 情形 | 行为 |
|---|---|
| HTTP 非 2xx | 抛 `Error`,错误对象上**只有 `err.status` 与 `err.body`**;这条路径**不设 `err.code`** |
| HTTP 200 但信封 `code !== 0` | 抛 `Error`,`err.status` / `err.code` / `err.body` **三者都有** |
| 成功 | 返回解包后的 `data`;响应体不含 `code`/`data` 信封时**原样返回**(如 `GET /api/workshop/plugins`、`GET /api/plugins/manifest`) |

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

## 通用调用

| 方法 | 签名 | 说明 |
|---|---|---|
| `api.call(method, path, body?, opt?)` | 底层 | `opt` 可带 `{ timeoutMs, headers }`;返回解包后的 `data` |
| `api.get(path, query?)` | query 对象自动序列化 | `api.get('/api/workshop/dcw', { page: 1 })` |
| `api.post(path, body?)` | JSON 序列化 | |
| `api.patch(path, body?)` | | |
| `api.delete(path)` | | |
| `api.setToken(token)` | 链式,返回 `api` 自身 | 登录后 `api.setToken(res.token)`;传 `null` 清除 |
| `api.ping()` | `GET /api/plugins/manifest` | 存活探测(免鉴权) |

`toQuery` 会丢弃 `undefined` / `null` / 空串字段,不会产生 `?lineId=undefined`。

## 资源面与真实基路径

每个资源由 `resource(root)` 生成,因此**都带齐五项**:
`list(query?)`、`get(id)`、`create(body)`、`update(id, patch)`、`remove(id)`。

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

`api.permissions.set` 的载荷:

```json
{ "userId": "<用户 id>", "grants": [{ "lineId": "<产线 id>", "mode": "readonly" }] }
```

`mode` 取 `'readonly'` / `'operate'` / `null`(传 `null` 表示撤销该项授权)。

## 路由实际支持情况

`resource(root)` 一律生成五项,但服务端只有部分路由文件存在。下表逐个路由文件核对过,
「否」表示该调用打到不存在的路径,实际会 404。

| 命名空间 | `list` | `get(id)` | `create` | `update(id)` | `remove(id)` | 备注 |
|---|---|---|---|---|---|---|
| `users` | 是 | 是 | 是 | **否** | 是 | 服务端只有 `PUT /api/users/:id`,而 `update()` 发 `PATCH`;更新用户请 `api.call('PUT', '/api/users/' + id, patch)`。`list`/`get`/`create` 需 admin |
| `lines` | 是 | 否 | 是 | 是 | 是 | 另有 `start` / `stop`。`create` 需 `admin` 或 `editor` |
| `products` | **否** | 否 | 是 | 是 | 是 | 无 `GET /api/workshop/dcw/products`;产品读 `GET /api/workshop/dcw` 的 `.products` |
| `recipes` | 是 | 否 | 是 | 是 | 是 | `list()` → `{ recipes, runs }` |
| `dcwNodes` | 是 | 否 | 是 | 是 | 是 | 无 `[id].get.ts`;节点读 `.nodes` |
| `daqNodes` | 是 | 否 | 是 | 是 | 是 | 无 `[id].get.ts`;`alarms()` 可用 |
| `twins` | 是 | 否 | 是 | 是 | 是 | 无 `[id].get.ts` |
| `teams` | 是 | 是 | 是 | 是 | 是 | 完整 CRUD |
| `agents` | 是 | 是 | 是 | 是 | 是 | 完整 CRUD |
| `channels` | 是 | 是 | 是 | 是 | 是 | 完整 CRUD |
| `permissions` | 仅 `overview()` | — | — | — | — | 只有 `overview()` 与 `set()` |
| `plugins` | 仅 `manifest()` | — | — | — | — | 免鉴权 |

- 业务读接口都走平台鉴权,需要用户 token(`api.setToken(...)` 或浏览器 cookie)。
- `api.plugins.manifest()` 与 `api.ping()` 免鉴权,是仅有的两个「不开 token 就能调」的接口。

## 响应形状速查

**列表不一定返回数组** —— 下面每一条都对着服务端 handler 核过。

| 调用 | 真实响应 |
|---|---|
| `api.lines.list()` | `{ lines, states }`(**不是数组**) |
| `api.daqNodes.list()` | `{ controller, nodes, meta, driverAvailable, infra, templates }` |
| `api.dcwNodes.list()` | 多键对象(`controller` / `nodes` / `templates` / `recipes` / `runs` / `history` / `products` / `lines` …) |
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

两处需要特别注意:

- `api.daqNodes.list({ lineId })`:`{ lineId }` 这个查询参数**服务端 handler 不读取**;
  产线过滤按调用者权限在服务端完成。不要把它当成可用的客户端过滤器。
- `api.lines.start(id, recipeId)`:`recipeId` 缺省是空串,但服务端**要求一个真实存在的配方**
  (空串或未知 id 会得到 404 `Recipe 不存在`)。产线有配方时 `recipeId` 事实上必填。

## 完整示例:外部项目集成产线

```js
import { createPlatformClient } from 'agentworkshop/sdk'

const api = createPlatformClient({ baseUrl: 'http://plant.local:3001' })
const { token } = await api.users.login('you@example.com', 'secret')
api.setToken(token)

// 1) 产线列表:{ lines, states },不是数组
const { lines, states } = await api.lines.list()
console.log(`产线 ${lines.length} 条`)

// 2) 数采面:{ controller, nodes, ... }
const { nodes } = await api.daqNodes.list()
console.log(`数采节点 ${nodes.length} 个`)

// 3) 写控面:节点列表同样是对象,产品读 .products
const dcw = await api.dcwNodes.list()
console.log(`写控节点 ${dcw.nodes.length} 个,产品 ${dcw.products.length} 个`)

// 4) 配方面:{ recipes, runs }
const { recipes } = await api.recipes.list()

// 5) 开跑:recipeId 必须是本产线的真实配方
const line = lines[0]
const recipe = recipes.find(r => r.lineId === line?.id)
if (line && recipe) {
  await api.lines.start(line.id, recipe.id)
  await api.lines.stop(line.id)
}
```

## 在插件内使用 ctx.api

`ctx.api` 就是一个 `PlatformClient`,但 **baseUrl 由宿主惰性解析(自环 origin)、默认不带 token**:

```js
const { token } = await ctx.api.users.login('user@example.com', 'secret')
ctx.api.setToken(token)
const { lines } = await ctx.api.lines.list()
```

免鉴权端点(`api.plugins.manifest()` / `api.ping()`)可以直接调;
若只需要进程内数据,优先用 `ctx.events` 与 `ctx.hooks`(零鉴权、零开销)。
