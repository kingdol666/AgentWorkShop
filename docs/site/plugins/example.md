# 真实案例:line-sentinel(产线哨兵)

一个覆盖 SDK 全部能力面的真实插件——源码即文档:
`~/.AgentWorkShop/plugins/line-sentinel/`(随本文同步展示)。

## 功能

- 监视运行中产线的数采样本,越过阈值即告警计数(按节点)
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
    const lines = await ctx.api.lines.list()      // 自环 REST(启动期可能早于监听,失败自愈)
    ctx.kv.set('linesTotal', lines.length)
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
ctx.events.on('daq.node.changed', (p) => ctx.logger.debug?.('节点变更', p?.op))
```

### 配置变更感知(ctx.config.onChange)

```js
ctx.config.onChange(() => {
  ctx.logger.info(`配置已变更,当前主题色: ${ctx.config.get('theme.primaryColor')}`)
})
```

### 定时器与清理(ctx.timer / ctx.onDispose)

```js
ctx.timer.setInterval(() => {                       // 关闭自动回收
  ctx.kv.set('heartbeat', new Date().toISOString())
  ctx.api.plugins.manifest()                        // REST 自环通道活性探测(免鉴权)
    .then(() => ctx.kv.set('apiOk', true))
    .catch(() => ctx.kv.set('apiOk', false))
}, 5000)
ctx.onDispose(() => ctx.logger.info('哨兵清理:告警状态已随 KV 落盘'))
```

### 插件 API(ctx.route)

```js
ctx.route('GET', '/report', () => ({
  plugin: ctx.name,
  running: ctx.kv.get('running') ?? false,
  samplesWatched: ctx.kv.get('samples') ?? 0,
  threshold: Number(ctx.kv.get('threshold')) || 180,
  alarms: Object.entries(ctx.kv.all()).filter(([k]) => k.startsWith('alarm:'))
    .map(([k, v]) => ({ nodeId: k.slice(6), ...v })),
}))
ctx.route('POST', '/threshold', (event) => {
  const v = Number(event.awBody?.threshold) || 180   // 宿主 catchall 预读 body
  ctx.kv.set('threshold', v)
  return { ok: true, threshold: v }
})
```

## 浏览器(client.mjs)

```js
export function setup(ctx) {
  const badge = ctx.el('div', { style: '…' }, ['🛡 line-sentinel · 待机'])
  ctx.root().append(badge)
  let n = 0
  ctx.on('daq:sample', () => { badge.textContent = `🛡 line-sentinel · ${++n} 样本` })
  ctx.on('event:line.stop', () => { badge.style.borderColor = 'rgba(53,224,160,.35)' })
}
```

## 实测记录(2026-09-02,dev 3127 + 生产构建 3601 双形态)

| 验证项 | 结果 |
|---|---|
| 用户级自动装载(`(+client)`) | ✔ |
| manifest 路由(/report · /threshold) | ✔ |
| 启线 8s 采样计数 | ✔ 0 → 288+(多节点并发) |
| 越限告警(阈值 100) | ✔ 12 节点持续告警计数 |
| `line:start/stop` 运行态 | ✔ `running:true → false` |
| 心跳 + REST 自环通道 | ✔ `apiChannel:"ok"`、心跳龄 <1s |
| 浏览器徽标 | ✔ 挂载、零 pageerror |
| `ctx.onDispose` | ✔ 关停路径实现(Windows 强杀不触发优雅钩子,见边界) |

## 安装使用

```bash
cp -r sdk/examples/line-sentinel ~/.AgentWorkShop/plugins/   # 示例随包分发
aw start
curl http://localhost:3001/api/plugins/line-sentinel/report
```
