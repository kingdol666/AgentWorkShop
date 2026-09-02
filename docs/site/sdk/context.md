# 插件上下文 ctx(运行时完整变量面)

`setup(ctx)` 收到的 `ctx` 是宿主装配的 SDK 运行时。全部成员一览:

| 分组 | 成员 | 说明 |
|---|---|---|
| 身份 | `ctx.name` / `ctx.scope`(`'project'\|'user'`) / `ctx.dir` / `ctx.sdkVersion` | 插件身份与版本 |
| 钩子 | `ctx.hooks` | 全局 HookBus(`on/once/off/emit`;异步串行、错误隔离、`'*'` 通配、连续失败 8 次熔断) |
| 日志 | `ctx.logger` | `debug/info/warn/error`,自动前缀 `[插件名]` |
| 配置 | `ctx.config.get(key)` / `all()` / `onChange(fn)` | 有效配置只读(四层引擎)+ 变更订阅 |
| 存储 | `ctx.kv.get/set/all/bump` | 插件私有 KV(内存态 + 200ms 防抖落盘 `data/plugins/<name>/kv.json`,高频钩子零竞态) |
| 定时 | `ctx.timer.setInterval/setTimeout` | 定时器 **服务关闭自动回收**(自动 unref),杜绝泄漏 |
| 清理 | `ctx.onDispose(fn)` / `ctx.subscriptions.add(d)` | 登记 `server:close` 前执行的清理(先于 `server:close` 广播) |
| 路由 | `ctx.route(method, path, handler)` | 插件 API → `/api/plugins/<name><path>`(宿主 catchall 转发,body 预读挂 `event.awBody`) |
| 平台 | `ctx.api` | 平台 REST 客户端(见 [API 客户端](/sdk/api-client));自环 origin 延迟解析 |
| 网络 | `ctx.http.get(url) / post(url, body)` | 通用请求(**仅 http/https**,默认 8s 超时) |
| 事件 | `ctx.events.on(type, fn)` / `off` | scene 实时事件订阅(与 WS 同源) |
| 路径 | `ctx.paths` | `{ home, configRoot, dataDir }`;`ctx.dataDir` = 插件私有数据目录 |

## ctx.hooks —— 钩子总线

```js
const off = ctx.hooks.on('daq:sample', (sample) => {
  ctx.kv.bump('samples')
})
ctx.hooks.once('server:close', () => { /* 收尾 */ })
ctx.hooks.off('daq:sample', handler)                            // 手动解绑
await ctx.hooks.emit('my-plugin:custom', { hello: 1 })          // 插件间通信
ctx.hooks.on('*', ({ type, payload }) => { /* 全部事件 */ })
```

- **异步串行**:同 type 监听器按注册序 `await`,返回值链式传递(waterfall)。
- **错误隔离**:单监听器抛错只计数告警,不影响兄弟监听器与主服务。
- **熔断**:同一监听器连续失败 ≥ 8 次自动摘除。

## ctx.kv —— 插件私有持久化

```js
ctx.kv.set('threshold', 100)
ctx.kv.bump('samples')                  // 原子自增(高频钩子安全)
ctx.kv.get('threshold')                 // 100
ctx.kv.all()                            // { samples: 19448, threshold: 100, ... }
```

存储位置:`<配置根>/data/plugins/<name>/kv.json`。

## ctx.timer + ctx.onDispose —— 生命周期安全的后台工作

```js
ctx.timer.setInterval(() => ctx.kv.set('heartbeat', Date.now()), 5000)  // 关闭自动回收
ctx.onDispose(() => ctx.logger.info('清理完成'))                          // 显式清理登记
```

服务关闭序列:**逐插件执行 onDispose 队列(逐个 try/catch)→ 广播 `server:close`**。

## ctx.route —— 插件 API

```js
ctx.route('GET', '/stats', () => ctx.kv.all())
ctx.route('POST', '/reset', (event) => {
  const body = event.awBody       // 宿主已预读 JSON body
  ctx.kv.reset()
  return { ok: true }             // 返回值由 nitro 序列化为 JSON
})
```

→ `/api/plugins/<name><path>`;v1 鉴权由插件自理(handler 内可 `resolveUser(event)`)。

## ctx.config —— 配置读取与变更

```js
ctx.config.get('theme.primaryColor')                  // 有效值(四层合并后)
ctx.config.all()                                      // 全部有效配置
ctx.config.onChange(() => {                           // runtime-settings 变化触发
  ctx.logger.info('新阈值', ctx.config.get('api.timeout'))
})
```
