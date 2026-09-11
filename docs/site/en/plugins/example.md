# Real example: line-sentinel (line sentry)

A real plugin covering most of the SDK surface — the source is the documentation:
`sdk/examples/line-sentinel/` (you can scaffold an equivalent with `aw plugin create`).

## What it does

- watches DAQ samples and counts per-node alarms once a threshold is crossed
- a 5 s heartbeat proving liveness plus REST loopback channel probing (manifest ping)
- line start/stop tracking and config-change awareness
- plugin API: `GET /api/plugins/line-sentinel/report` · `POST /threshold`
- a live badge in the bottom-right corner of the browser (sample count + alarm count)

## Server (`index.mjs`)

### Consuming platform services (`ctx.api`)

```js
async setup(ctx) {
  ctx.logger.info(`loaded (scope=${ctx.scope}, sdk=${ctx.sdkVersion})`)
  try {
    const { lines } = await ctx.api.lines.list()  // loopback REST: returns { lines, states }, not an array (may run before listen; self-heals)
    ctx.kv.set('linesTotal', Array.isArray(lines) ? lines.length : 0)
  }
  catch (err) { ctx.logger.warn('line list not ready (heartbeat will retry):', err?.message) }
}
```

### Enhanced event consumption (`ctx.hooks` / `ctx.events`)

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
ctx.events.on('daq.node.changed', (p) => ctx.logger.debug('node changed', p?.op))
```

`daq:sample` is a **server** hook (publish-level cadence, payload carries `lineId`); to subscribe to scene events by type,
go through `ctx.events`, which adds the `event:` prefix for you.

### Config-change awareness (`ctx.config.onChange`)

```js
ctx.config.onChange(() => {
  ctx.logger.info(`config changed, current theme colour: ${ctx.config.get('theme.primaryColor')}`)
})
```

### Timers and cleanup (`ctx.timer` / `ctx.onDispose`)

```js
ctx.timer.setInterval(() => {                       // collected automatically on shutdown and hot reload
  ctx.kv.set('heartbeat', new Date().toISOString())
  ctx.api.plugins.manifest()                        // REST loopback channel probe (unauthenticated)
    .then(() => ctx.kv.set('apiOk', true))
    .catch(() => ctx.kv.set('apiOk', false))
}, 5000)
ctx.onDispose(() => ctx.logger.info('sentry cleanup: alarm state already flushed with KV'))
```

### Plugin API (`ctx.route`)

```js
ctx.route('GET', '/report', () => {
  const alarms = Object.entries(ctx.kv.all())
    .filter(([k]) => k.startsWith('alarm:'))
    .map(([k, v]) => ({ nodeId: k.slice(6), ...v }))
  return {
    plugin: ctx.name,
    sdkVersion: ctx.sdkVersion,          // ctx has no plugin version; the manifest records it
    running: ctx.kv.get('running') ?? false,
    samplesWatched: ctx.kv.get('samples') ?? 0,
    threshold: Number(ctx.kv.get('threshold')) || 180,
    alarms,
  }
})

ctx.route('POST', '/threshold', (event) => {
  const v = Number(event.awBody?.threshold) || 180   // the host catch-all pre-read the body
  ctx.kv.set('threshold', v)
  return { ok: true, threshold: v }
})
```

Both routes are mounted at `/api/plugins/line-sentinel<path>` (exact match); authentication is enforced declaratively by
the entry's `auth` field.

## Browser (`client.mjs`)

```js
export function setup(ctx) {
  let samples = 0
  let alarms = 0
  const badge = ctx.el('div', {
    id: 'line-sentinel-badge',
    style: 'padding:8px 12px;border:1px solid rgba(53,224,160,.5);border-radius:10px;'
      + 'background:rgba(6,18,14,.85);color:#35e0a0;font:600 12px/1 ui-monospace,monospace',
  }, ['line-sentinel · idle'])

  ctx.root().append(badge)

  // ctx.on(type) takes the scene event name itself (internally event:<type>).
  // Server hooks (daq:sample / line:start / line:stop) never cross to the browser — subscribing to them just idles silently.
  ctx.on('daq.reading', () => {
    samples += 1
    badge.textContent = `line-sentinel · ${samples} samples · ${alarms} alarms`
  })
  ctx.on('daq.alarm', () => {
    alarms += 1
    badge.style.borderColor = '#ff6b6b'
    badge.textContent = `line-sentinel · ${samples} samples · ${alarms} alarms`
  })
  ctx.on('daq.alarm.changed', () => { badge.style.borderColor = 'rgba(53,224,160,.5)' })

  ctx.log.info('sentry badge mounted (bottom right)')
}
```

The entry must declare `client: './client.mjs'` in the manifest, otherwise the loader never fetches this file.

## Measured record

| Check | Result |
|---|---|
| Automatic load from the user scope (with client enhancement) | pass |
| Manifest routes (/report · /threshold) | pass |
| Sample counting after starting a line (publish-level cadence) | pass |
| Over-threshold alarms (threshold 100) | pass, per-node counting continues |
| `line:start/stop` runtime state | pass, `running: true → false` |
| Heartbeat + REST loopback channel | pass, heartbeat age < 1 s |
| Browser badge | pass, mounted with zero pageerror |
| No KV or timer leak after a hot reload | pass (triggered by an enable/disable round trip) |
| `ctx.onDispose` | implemented on the shutdown path (a forced kill on Windows skips graceful hooks, see boundaries) |

## Install and try it

```bash
mkdir -p ~/.AgentWorkShop/plugins && cp -r sdk/examples/line-sentinel ~/.AgentWorkShop/plugins/  # user-scope install
aw plugin list                                  # line-sentinel should appear (enabled, +client)
curl -X POST http://localhost:3001/api/plugins/line-sentinel/threshold \
  -H 'content-type: application/json' -d '{"threshold":100}'
curl http://localhost:3001/api/plugins/line-sentinel/report
```
