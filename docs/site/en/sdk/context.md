# Plugin context (ctx) — the complete runtime surface

The `ctx` handed to `setup(ctx)` is the host-assembled SDK runtime. **The table below is the
complete surface**; the last three rows (`ctx.daq` / `ctx.omp` / `ctx.services`) are attached
directly by the plugin host before `setup` runs and are not part of `sdk/context.mjs`.

| Group | Member | Type | Notes |
|---|---|---|---|
| Identity | `ctx.name` | `string` | plugin name (= directory name / declared name) |
| | `ctx.scope` | `'builtin' \| 'project' \| 'user'` | load scope; on a name clash the priority is builtin > project > user |
| | `ctx.dir` | `string` | absolute path of the plugin directory |
| | `ctx.sdkVersion` | `string` | SDK interface version (= `SDK_VERSION`) |
| Hooks | `ctx.hooks` | `{ on, once, off, emit }` | per-plugin scoped hook facade; **not a `HookBus` instance and has no `.size`** |
| Logging | `ctx.logger` | `{ debug, info, warn, error }` | output is prefixed `[aw-plugins] [<plugin name>]` |
| Config | `ctx.config.get(key)` | any | effective value (after the four-layer merge) |
| | `ctx.config.all()` | `Record<string, any>` | shallow copy of every effective setting |
| | `ctx.config.onChange(fn)` | unsubscribe function | subscribes to `config:changed` |
| | `ctx.config.defineGroup(def)` | group object \| `null` | declare a plugin-owned config group |
| | `ctx.config.defineField(decl)` | descriptor \| `null` | declare a setting field (key auto-addressed as `plugins.<name>.<key>`) |
| | `ctx.config.removeGroup(id)` / `removeField(key)` | `boolean` | remove a declaration |
| | `ctx.config.groups()` / `fields()` | arrays | the groups / fields currently registered (read-only snapshot) |
| Paths | `ctx.paths` | `{ home, configRoot, dataDir }` | config-root information (home mode = `~/.AgentWorkShop`) |
| | `ctx.dataDir` | `string` | this plugin's private data directory = `<paths.dataDir>/plugins/<name>` |
| Storage | `ctx.kv` | `{ get, set, all, bump }` | plugin-private KV; **there is no `reset()`** |
| Timers | `ctx.timer.setInterval/setTimeout` | timer id | auto `unref` + auto-collected on shutdown / hot reload |
| Cleanup | `ctx.onDispose(fn)` / `ctx.subscriptions.add(d)` | the value you passed | one shared collection queue |
| Routes | `ctx.route(method, path, handler)` | `boolean` | mounts at `/api/plugins/<name><path>`; auth is declared by the plugin's `auth` field |
| Platform | `ctx.api` | `PlatformClient` | loopback REST client (**no token by default**) |
| Network | `ctx.http.get(url, opts)` / `post(url, body, opts)` | `Promise<Response>` | outbound requests; protocol-only guard; 8 s default timeout |
| Events | `ctx.events.on(type, fn)` / `off(type, fn)` | unsubscribe function | scene event subscription; the `event:` prefix is added for you |
| Line permissions (host-injected) | `ctx.permissions` | see below | per-user, per-line three-state grants |
| DAQ extension (host-injected) | `ctx.daq` | see below | driver / processor / template registration + frame subscription + time-series queries |
| Agent tools (host-injected) | `ctx.omp.registerTool(tool)` | see below | hot-inject a custom host tool at runtime |
| Runtime services (host-injected) | `ctx.services` | see below | lazy service access + cross-plugin service provision |

`ctx` has **no** `ctx.routes`, `ctx.dcw`, `ctx.scene` or `ctx.version`: route registration is the
singular `ctx.route()`; write-control traffic is observed through the `dcw:write` hook; scene
events go through `ctx.events`.

## ctx.hooks — the hook facade

The host owns one shared `HookBus` named `aw-plugins`, and a plugin receives a **scoped facade**
exposing only `on` / `once` / `off` / `emit`: listeners registered through it are auto-unbound
when the plugin hot-reloads.

```js
function onSample(sample) { ctx.kv.bump('samples') }

const off = ctx.hooks.on('daq:sample', onSample)   // returns an unsubscribe function
ctx.hooks.once('server:close', () => { /* teardown */ })
ctx.hooks.off('daq:sample', onSample)              // manual unbind: pass the original handler
off()                                              // or call the function returned by on()

await ctx.hooks.emit('my-plugin:custom', { hello: 1 })   // inter-plugin messaging
ctx.hooks.on('*', ({ type, payload }) => { /* every event */ })
```

- **Async-serial**: listeners of one type run in registration order and are awaited.
- **Error isolation**: one throwing listener is only counted and warned about; siblings and the main service are unaffected.
- **Circuit breaker**: a listener failing **8 times in a row** is removed automatically; any single success resets the counter.
- **Fan-out, not a waterfall**: every listener receives **the same unmodified payload**; `emit()` only returns "the last non-`undefined` return value", so values are never threaded between listeners.
- **The only server-side wildcard is the bare `'*'`**, whose callback receives `{ type, payload }`; `ctx.hooks.on('event:*')` never fires.
- **v1 is observation-only**: no veto / interception / rewriting.

## ctx.kv — plugin-private persistence

```js
ctx.kv.set('threshold', 100)
ctx.kv.bump('samples')                  // atomic increment (safe in high-frequency hooks)
ctx.kv.get('threshold')                 // 100
ctx.kv.all()                            // { samples: 19448, threshold: 100, ... }
```

**Only these four methods**: `get` / `set` / `all` / `bump` — no `reset()`, no `delete()`, no `keys()`.
On-disk location: `<ctx.dataDir>/kv.json` (that is `<paths.dataDir>/plugins/<name>/kv.json`),
in-memory state authoritative plus a 200 ms debounced atomic write; on shutdown / hot reload the
debounce is cancelled and flushed synchronously.

## ctx.timer + ctx.onDispose — lifecycle-safe background work

```js
ctx.timer.setInterval(() => ctx.kv.set('heartbeat', Date.now()), 5000)  // auto unref + auto-collected
ctx.timer.setTimeout(() => ctx.logger.info('one-shot task'), 1000)
ctx.onDispose(() => ctx.logger.info('cleanup done'))

const controller = new AbortController()
ctx.subscriptions.add({ dispose() { controller.abort() } })   // same queue as onDispose
```

Server shutdown sequence: **per-plugin dispose queue (each entry try/catch) → broadcast
`server:close { at }`**. The same queue also runs on **plugin hot reload**, so timers cannot leak.

## ctx.route — plugin API

```js
export default {
  name: 'my-plugin',
  auth: 'user',        // 'none' (default) | 'user' | 'admin' | 'agent-or-user'
  async setup(ctx) {
    const ok = ctx.route('GET', '/stats', () => ctx.kv.all())   // returns boolean
    if (!ok) ctx.logger.warn('route registration failed')

    ctx.route('POST', '/threshold', (event) => {
      const body = event.awBody          // the JSON body the host already pre-read (may be undefined)
      ctx.kv.set('threshold', Number(body?.threshold))
      return { ok: true }                // the return value is serialized to JSON by nitro
    })
  },
}
```

→ `/api/plugins/<name><path>`.

- **The return value is `boolean`**; `false` when `handler` is not a function.
- **Auth is declarative**: the `auth` field is validated by the platform catch-all **before** your
  handler runs, returning 401 on failure. **Do not roll your own**: `resolveUser(event)` is not on
  `ctx` and cannot be imported from a plugin module.
- `event.awBody` is the pre-read JSON body (not h3's `readBody`).
- Handler errors are isolated: the platform logs with the plugin name and returns a 500 envelope
  without leaking a stack trace.

## ctx.config — reading config and declaring fields

```js
ctx.config.get('plugins.my-plugin.threshold')   // effective value (after the four-layer merge)
ctx.config.all()                                // every effective setting (shallow copy)
const off = ctx.config.onChange(payload => {    // essentially ctx.hooks.on('config:changed', fn)
  ctx.logger.info('changed keys', payload?.changed)
})

// declarative extension: groups + fields (register conditionally in setup; equivalent to manifest settings[])
ctx.config.defineGroup({ id: 'conn', label: 'Connection', collapsed: true })
ctx.config.defineField({ key: 'retries', type: 'number', default: 3, min: 0, max: 10, group: 'conn' })
ctx.config.groups()                             // this plugin's current group snapshot
ctx.config.fields()                             // this plugin's current field snapshot
```

## ctx.permissions — per-user, per-line grants

| Method | Returns | Notes |
|---|---|---|
| `lineMode(user, lineId)` | `'none' \| 'readonly' \| 'operate'` | `user` is `{ id, role }`; admin/editor is always `operate` |
| `visibleLineIds(user)` | `Set<string> \| null` | `null` means unrestricted (admin/editor) |
| `listGrants(userId)` | `Array<{ lineId, mode, grantedBy, grantedAt }>` | read every grant of one user |
| `setGrants(userId, grants, grantedBy?)` | the grants after the write | `mode` = `'readonly'` / `'operate'` / `null` |

The change notification is the scene event `permissions.changed`, subscribed through `ctx.events`
(the prefix is added for you):

```js
ctx.events.on('permissions.changed', ({ userId }) => ctx.logger.info('grants changed:', userId))
```

## ctx.api / ctx.http / ctx.events — which one to use

| Need | Use | Why |
|---|---|---|
| Read / write **platform business data** | `ctx.api` | auth / envelope / resource semantics out of the box |
| Call an **external system** (MES, webhook) | `ctx.http` | generic requests plus a protocol-only guard (http/https) |
| React to the **live stream** | `ctx.events` / `ctx.hooks.on` | in-process, zero HTTP overhead |

```js
// ctx.api has no token by default: unauthenticated endpoints work immediately, others need a login first
const { token } = await ctx.api.users.login('user@example.com', 'secret')
ctx.api.setToken(token)
const { lines } = await ctx.api.lines.list()

// ctx.http: outbound requests, 8 s default timeout
const res = await ctx.http.get('https://mes.example.com/health', { timeoutMs: 3000 })

// ctx.events: pass the scene event name itself; the event: prefix is added for you
ctx.events.on('daq.reading', r => ctx.logger.info('sample', r.nodeId))
ctx.events.on('device.created', d => ctx.logger.info('new device', d.id))
```

## ctx.daq — multi-modal DAQ extension (v0.6 frame pipeline)

```js
ctx.daq.registerProcessor('vector', 'my-derive', (frame) => {
  // frame = { kind: 'vector'|'image', points? | blob? (image producer side only), metrics }
  return { ...frame, metrics: { ...frame.metrics, myMetric: 1 } }
})
ctx.daq.registerTemplate({ /* DaqTemplateDef: key/signalKind/vector/sink/metrics */ })
ctx.daq.registerDriver({ kind: 'my-ccd', available, sample, test })
ctx.daq.onFrame(fn)     // sugar = ctx.hooks.on('daq:frame')
ctx.daq.onSample(fn)    // sugar = ctx.hooks.on('daq:sample')
const rows = await ctx.daq.query({ nodeIds: ['n1'], from: Date.now() - 3600_000, to: Date.now(), bucketMs: 60_000 })
const nodes = await ctx.daq.nodes()
```

A template's `sink.processors` declares the sink pipeline (after sampling, before storage);
`metrics` declares derived-metric thresholds whose breaches ride the platform's existing alarm
chain. Vector / frame metadata lands in Timescale `daq_frames`; image pixels land in object
storage (the `daq:frame` payload **carries no pixel blob**).

## ctx.services — the backend runtime object surface

```js
const daq = await ctx.services.get('daq')          // { query(q), nodes() }
const lines = await ctx.services.get('lines')      // { list(), byId(id) }
const channels = await ctx.services.get('channels')// { list(), agents(channelId) }
const plugins = await ctx.services.get('plugins')  // the plugin manifest ARRAY (not an object)
ctx.services.names()                               // every service name (including plugin-provided ones)
ctx.services.provide('my-data', async () => ({ ready: true }))   // → 'my-plugin.my-data'
```

- Lazy evaluation, cached after first access; an unknown name throws (the caller handles it).
- Read-only service access is preferred; `provide` forces the `<plugin>.` prefix so cross-plugin
  name clashes cannot happen.

## Plugin setting declarations (top-level `settings:` / `configGroups:` in index.mjs)

```js
export default {
  name: 'my-plugin',
  configGroups: [{ id: 'conn', label: 'Connection', collapsed: true }],
  settings: [{ key: 'base_url', type: 'string', default: 'https://example.com', group: 'conn',
               labelKey: 'plugin.my-plugin.base_url', label: 'fallback text' }],
}
```

- Keys are forcibly addressed as `plugins.<plugin name>.<key>`; once loaded they merge into the
  platform settings service — the "Plugins" section of the settings page renders automatically,
  PATCH validation uses the same source, and saving takes effect immediately.
- Read with `ctx.config.get('plugins.<name>.base_url')`. An entry that fails validation is skipped
  with a warning and never blocks loading.
- Rules: `key` must match `[A-Za-z0-9_-]+`; `type` is `string`/`number`/`boolean`/`select`;
  **`default` is required**; a `select` must supply `options` containing its `default`; `min`/`max`
  apply to `number` only; a field without `group` lands in the `plugin-<name>` group labelled with
  the plugin name.

## ctx.omp — custom agent tools (hot-injected at runtime)

```js
ctx.omp.registerTool({
  name: 'sensor_log',
  description: 'query/register sensor calibration conclusions',
  parameters: { type: 'object', properties: { sensor: { type: 'string' } }, required: ['sensor'] },
  roles: ['lead', 'worker'],                          // the only valid literals are 'lead' and 'worker'; default is both
  handler: async (args, agent) => ({ text: '...' }),  // agent = { agentId, channelId, role, name }
})
```

Registry changes hot-inject into every running omp agent session immediately (re-sending
`set_host_tools`, no respawn); a tool sharing a name with a built-in host tool is ignored
(built-ins win).

## Common event-subscription mistakes

| Spelling | Result |
|---|---|
| `ctx.hooks.on('event:*', fn)` | **never fires** — the server wildcard is the bare `'*'` only |
| `ctx.hooks.on('permissions:changed', fn)` | **never fires** — the real emitted name is `event:permissions:changed` |
| `ctx.events.on('permissions.changed', fn)` | correct — the sugar adds the `event:` prefix |
| `ctx.hooks.on('*', ({ type, payload }) => …)` | correct — receives every event |
