# 平台 REST 客户端 createPlatformClient

SDK 作为"项目服务客户端"的门面:自动携带鉴权、自动解包平台统一信封
(`{ code, message, data } → data`)、非 2xx 抛错(含 `err.status` 与 `err.body`)。

## 创建

```js
import { createPlatformClient } from 'agentworkshop/sdk'

const api = createPlatformClient({
  baseUrl: 'http://127.0.0.1:3001',  // 缺省 ''(同源相对路径);集成方填平台地址
  token: '<bearer-token>',            // 可选;后续可 api.setToken() 更换
  timeoutMs: 10_000,                  // 可选;单请求超时(AbortSignal)
  logger,                             // 可选;请求失败时告警
})
```

> `baseUrl` 支持**函数**(延迟解析):插件宿主的监听端口在服务真正监听后才确定,
> 宿主传的是 `() => origin`。

## 通用调用

| 方法 | 签名 | 说明 |
|---|---|---|
| `api.call(method, path, body?)` | 底层 | 返回解包后的 `data` |
| `api.get(path, query?)` | query 对象自动序列化 | `api.get('/api/workshop/dcw', { page: 1 })` |
| `api.post(path, body?)` | JSON 序列化 | |
| `api.patch(path, body?)` | | |
| `api.delete(path)` | | |
| `api.setToken(token)` | 链式 | 登录后 `api.setToken(res.token)` |
| `api.ping()` | 免鉴权存活探测 | |

## 资源面

| 资源 | 方法 |
|---|---|
| `api.users` | `login(email, password)` · `me()` · CRUD |
| `api.lines` | CRUD + **`start(id, recipeId?)`** · `stop(id)` |
| `api.products` / `api.recipes` | CRUD |
| `api.dcwNodes` | 写控制节点 CRUD |
| `api.daqNodes` | 数采节点 CRUD + `alarms()` |
| `api.templates` | `daq()` / `dcw()` 信号模板注册表 |
| `api.twins` | 数字孪生设备 CRUD |
| `api.teams` / `api.agents` / `api.channels` | Agent 编组面 |
| `api.plugins.manifest()` | 已装载插件清单(免鉴权) |

## 完整示例:外部项目集成产线

```js
import { createPlatformClient } from 'agentworkshop/sdk'

const api = createPlatformClient({ baseUrl: 'http://plant.local:3001' })
const { token } = await api.users.login('you@example.com', 'secret')
api.setToken(token)

await api.lines.create({ name: '一号产线' })
const line = (await api.lines.list())[0]

const dcwT = (await api.templates.dcw())[0]
await api.dcwNodes.create({ name: '温控', templateRef: dcwT.key, driver: 'mock', lineId: line.id })
await api.lines.start(line.id)
```

## 错误语义

```js
try {
  await api.daqNodes.create({ name: 'x' })
}
catch (err) {
  err.status   // HTTP 状态码
  err.body     // 平台统一错误信封 { code, message }
}
```
