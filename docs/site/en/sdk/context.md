# Plugin context (ctx) — the full runtime surface

`setup(ctx)` receives the host-assembled SDK runtime. Every member, one table
(this mirrors the zh page and the implementation in `sdk/context.mjs`):

| Group | Member | Notes |
|---|---|---|
| Identity | `ctx.name` / `ctx.scope` (`'project'\|'user'`) / `ctx.dir` / `ctx.sdkVersion` | plugin identity |
| Hooks | `ctx.hooks` | global HookBus (`on/once/off/emit`; async-serial, error-isolated, `'*'` wildcard, circuit-breaks after 8 consecutive failures) |
| Logging | `ctx.logger` | `debug/info/warn/error`, auto-prefixed with `[plugin-name]` |
| Config | `ctx.config.get(key)` / `all()` / `onChange(fn)` | read-only effective config (4-layer engine) + change subscription |
| Storage | `ctx.kv.get/set/all/bump` | plugin-private KV (in-memory + 200 ms debounced flush to `data/plugins/<name>/kv.json`) |
| Timers | `ctx.timer.setInterval/setTimeout` | **auto-collected on server close** (auto-unref) |
| Cleanup | `ctx.onDispose(fn)` / `ctx.subscriptions.add(d)` | runs before the `server:close` broadcast |
| Routes | `ctx.route(method, path, handler)` | plugin API → `/api/plugins/<name><path>` (host catch-all forwards; pre-read body on `event.awBody`) |
| Platform | `ctx.api` | platform REST client (see [API client](/en/sdk/api-client)); loopback origin resolved lazily |
| Network | `ctx.http.get(url) / post(url, body)` | generic requests (**http/https only**, 8 s default timeout) |
| Events | `ctx.events.on(type, fn)` / `off` | live scene event subscription (same source as WS) |
| Paths | `ctx.paths` | `{ home, configRoot, dataDir }`; `ctx.dataDir` = plugin-private data dir |

There is **no** `ctx.routes`, `ctx.dcw` or `ctx.scene` — route registration is the singular
`ctx.route()`, write-control traffic is observed via the `dcw:write` hook, and scene events
via `ctx.events` / `event:*`.

## ctx.hooks — the hook bus

```js
const off = ctx.hooks.on('daq:sample', (sample) => {
  ctx.kv.bump('samples')
})
ctx.hooks.once('server:close', () => { /* teardown */ })
ctx.hooks.off('daq:sample', handler)                            // manual unsubscribe
await ctx.hooks.emit('my-plugin:custom', { hello: 1 })          // inter-plugin messaging
ctx.hooks.on('*', ({ type, payload }) => { /* every event */ })
```

- **Async-serial**: listeners for a type run in registration order and are awaited.
- **Error isolation**: one throwing listener is counted and logged; siblings and the
  platform continue.
- **Circuit breaker**: a listener failing 8+ times in a row is removed automatically.

## ctx.kv — plugin-private persistence

```js
ctx.kv.set('threshold', 100)
ctx.kv.bump('samples')                  // atomic increment (safe in high-frequency hooks)
ctx.kv.get('threshold')                 // 100
ctx.kv.all()                            // { samples: 19448, threshold: 100, ... }
```

Stored at `<config-root>/data/plugins/<name>/kv.json`.

## ctx.timer + ctx.onDispose — lifecycle-safe background work

```js
ctx.timer.setInterval(() => ctx.kv.set('heartbeat', Date.now()), 5000)  // auto-collected
ctx.onDispose(() => ctx.logger.info('cleanup done'))                    // explicit cleanup
```

Shutdown order: **per-plugin onDispose queues (each try/catch) → `server:close` broadcast**.

## ctx.route — plugin API

```js
ctx.route('GET', '/stats', () => ctx.kv.all())
ctx.route('POST', '/reset', (event) => {
  const body = event.awBody       // host pre-reads the JSON body
  ctx.kv.reset()
  return { ok: true }             // return value serialized as JSON by nitro
})
```

→ `/api/plugins/<name><path>`; in v1 auth is the plugin's own concern
(call `resolveUser(event)` inside the handler to reuse platform auth).

## ctx.config — config read & change

```js
ctx.config.get('theme.primaryColor')                  // effective value (4-layer merge)
ctx.config.all()                                      // all effective settings
ctx.config.onChange(() => {                           // runtime-settings change
  ctx.logger.info('new timeout', ctx.config.get('api.timeout'))
})
```

## ctx.daq — multi-modal DAQ extension (v0.6 frame pipeline)

```js
ctx.daq.registerProcessor('vector', 'my-derive', (frame, args) => {
  // frame = { kind: 'vector'|'image', points? | blob?(image, producer side only), metrics }
  return { ...frame, metrics: { ...frame.metrics, myMetric: 1 } }
})
ctx.daq.registerTemplate({ /* DaqTemplateDef: key/signalKind/vector/sink/metrics */ })
ctx.daq.registerDriver({ kind: 'my-ccd', available, sample, test })
ctx.daq.onFrame(fn)     // sugar = ctx.hooks.on('daq:frame')
ctx.daq.onSample(fn)    // sugar = ctx.hooks.on('daq:sample')
```

A template's `sink.processors` declares the sink pipeline (after sampling, before storage);
`metrics` declares derived-metric thresholds which ride the platform alarm chain. Vector and
frame metadata land in Timescale `daq_frames`; image pixels land in object storage.

## ctx.omp — custom agent tools (hot-injected at runtime)

```js
ctx.omp.registerTool({
  name: 'sensor_log',
  description: 'query/register sensor calibration conclusions',
  parameters: { type: 'object', properties: { sensor: { type: 'string' } }, required: ['sensor'] },
  roles: ['lead', 'worker'],                          // default: both
  handler: async (args, agent) => ({ text: '...' }),  // agent = { agentId, channelId, role, name }
})
```

Registry changes hot-inject into every running omp agent session (re-sends `set_host_tools`,
no respawn); a plugin tool naming-colliding with a built-in host tool is ignored with a
warning (built-ins win).
