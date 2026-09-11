# 真实案例:line-sentinel(产线哨兵)

一个覆盖 SDK 主要能力面的真实插件 —— 源码即文档:
`sdk/examples/line-sentinel/`(可用 `aw plugin create` 同构自行搭建)。

## 功能

- 监视数采样本,越过阈值即按节点计数告警
- 5s 心跳自证存活 + REST 自环通道活性探测(manifest ping)
- 产线启停跟踪、配置变更感知
- 插件 API:`GET /api/plugins/line-sentinel/report` · `POST /threshold`
- 浏览器右下角实时徽标(样本数 + 告警数)

## 服务端(index.mjs)

### 平台服务消费(ctx.api)

```js
async setup(ctx) {
  ctx.logger.info(`装载完成(scope=${ctx.scope}, sdk=${ctx.sdkVersion})`)
  try {
    const { lines } = await ctx.api.lines.list()  // 自环 REST:返回 { lines, states },不是数组(启动期可能早于监听,失败自愈)
    ctx.kv.set('linesTotal', Array.isArray(lines) ? lines.length : 0)
  }
  catch (err) { ctx.logger.warn('产线清单读取失败(心跳期自愈):', err?.message) }
}
```

### 事件消费增强(ctx.hooks / ctx.events)

```js
ctx.hooks.on('daq:sample', (s) => {
  ctx.kv.bump('samples')
  const threshold = Number(ctx.kv.get('threshold')) || 180
  if (typeof s?.value === 'number' && s.value > threshold) {
    const key = `alarm:${s.nodeId}`
    const prev = ctx.kv.get(key) ?? { count: 0 }
    ctx.kv.set(key, { count: (prev.count ?? 0) + 1, value: s.value, at: s.at })
  }
})
ctx.hooks.on('line:start', (p) => { ctx.kv.set('running', true); ctx.kv.bump('runningCount') })
ctx.hooks.on('line:stop', () => ctx.kv.set('running', false))
ctx.events.on('daq.node.changed', (p) => ctx.logger.debug('节点变更', p?.op))
```

`daq:sample` 是**服务端**钩子(下发级节拍,payload 含 `lineId`);按类型订阅 scene 事件要走 `ctx.events`,它会替你补 `event:` 前缀。

### 配置变更感知(ctx.config.onChange)

```js
ctx.config.onChange(() => {
  ctx.logger.info(`配置已变更,当前主题色: ${ctx.config.get('theme.primaryColor')}`)
})
```

### 定时器与清理(ctx.timer / ctx.onDispose)

```js
ctx.timer.setInterval(() => {                       // 关机与热重载都会自动回收
  ctx.kv.set('heartbeat', new Date().toISOString())
  ctx.api.plugins.manifest()                        // REST 自环通道活性探测(免鉴权)
    .then(() => ctx.kv.set('apiOk', true))
    .catch(() => ctx.kv.set('apiOk', false))
}, 5000)
ctx.onDispose(() => ctx.logger.info('哨兵清理:告警状态已随 KV 落盘'))
```

### 插件 API(ctx.route)

```js
ctx.route('GET', '/report', () => {
  const alarms = Object.entries(ctx.kv.all())
    .filter(([k]) => k.startsWith('alarm:'))
    .map(([k, v]) => ({ nodeId: k.slice(6), ...v }))
  return {
    plugin: ctx.name,
    sdkVersion: ctx.sdkVersion,          // ctx 上没有插件 version;manifest 才记录版本
    running: ctx.kv.get('running') ?? false,
    samplesWatched: ctx.kv.get('samples') ?? 0,
    threshold: Number(ctx.kv.get('threshold')) || 180,
    alarms,
  }
})

ctx.route('POST', '/threshold', (event) => {
  const v = Number(event.awBody?.threshold) || 180   // 宿主 catchall 预读 body
  ctx.kv.set('threshold', v)
  return { ok: true, threshold: v }
})
```

两个路由都挂在 `/api/plugins/line-sentinel<path>`(exact-match);鉴权由入口的 `auth` 声明统一执行。

## 浏览器(client.mjs)

```js
export function setup(ctx) {
  let samples = 0
  let alarms = 0
  const badge = ctx.el('div', {
    id: 'line-sentinel-badge',
    style: 'padding:8px 12px;border:1px solid rgba(53,224,160,.5);border-radius:10px;'
      + 'background:rgba(6,18,14,.85);color:#35e0a0;font:600 12px/1 ui-monospace,monospace',
  }, ['line-sentinel · 待机'])

  ctx.root().append(badge)

  // ctx.on(type) 的 type 是 scene 事件名本身(内部装到 event:<type>)。
  // 服务端钩子(daq:sample / line:start / line:stop)不会过桥到浏览器 —— 订阅它们只会静默空转。
  ctx.on('daq.reading', () => {
    samples += 1
    badge.textContent = `line-sentinel · ${samples} 样本 · ${alarms} 告警`
  })
  ctx.on('daq.alarm', () => {
    alarms += 1
    badge.style.borderColor = '#ff6b6b'
    badge.textContent = `line-sentinel · ${samples} 样本 · ${alarms} 告警`
  })
  ctx.on('daq.alarm.changed', () => { badge.style.borderColor = 'rgba(53,224,160,.5)' })

  ctx.log.info('哨兵徽标已挂载(右下角)')
}
```

入口必须在 manifest 里声明 `client: './client.mjs'`,否则 loader 不会去取这个文件。

## 实测记录

| 验证项 | 结果 |
|---|---|
| 用户级自动装载(带客户端增强) | 通过 |
| manifest 路由(/report · /threshold) | 通过 |
| 启线后采样计数(下发级节拍) | 通过 |
| 越限告警(阈值 100) | 通过,按节点持续计数 |
| `line:start/stop` 运行态 | 通过,`running: true → false` |
| 心跳 + REST 自环通道 | 通过,心跳龄 < 1s |
| 浏览器徽标 | 通过,挂载且无 pageerror |
| 热重载后 KV 与定时器无泄漏 | 通过(enable/disable 往返触发) |
| `ctx.onDispose` | 关停路径实现(Windows 强杀不触发优雅钩子,见边界) |

## 安装使用

```bash
mkdir -p ~/.AgentWorkShop/plugins && cp -r sdk/examples/line-sentinel ~/.AgentWorkShop/plugins/  # 用户级安装
aw plugin list                                  # 应看到 line-sentinel(已启用,+client)
curl -X POST http://localhost:3001/api/plugins/line-sentinel/threshold \
  -H 'content-type: application/json' -d '{"threshold":100}'
curl http://localhost:3001/api/plugins/line-sentinel/report
```
