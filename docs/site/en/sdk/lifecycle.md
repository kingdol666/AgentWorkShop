# Lifecycle events

The host emits events at the runtime's key points, and plugins consume them through `ctx.hooks`
and `ctx.events`. **Every event is also part of the config-root event stream.**
The authoritative lists are the SDK-exported `LIFECYCLE_EVENTS` (11 items) and
`CLIENT_EVENTS` (5 items) in `sdk/lifecycle.mjs`; the tables below match them and were checked
one by one against the host's emission sites.

## Server-side events (11)

| Event name (bus type) | When it fires | Payload |
|---|---|---|
| `plugin:host:init` | once, after the host has loaded every plugin (including disabled ones) | `{ plugins: string[], failures: number }` |
| `plugins:reloaded` | end of a hot reload (plugin enabled/disabled, `plugins-state.json` changed) | `{ plugins: <manifest entry array> }` |
| `config:changed` | `runtime-settings.json` changed (`aw config set` / settings page, bridged from SystemConfigService) | `{ type: 'config:changed', changed: string[], effective: object, sources: object }` |
| `event:permissions:changed` | after line grants were written successfully | `{ userId }` |
| `event:*` | **a subscription entry, not an emitted event** | — |
| `daq:sample` | DAQ **downlink-level** sampling (same point as WS `daq.reading`, on the node's `publishIntervalMs` cadence) | `{ nodeId, templateRef, value, state, at, lineId }` |
| `daq:frame` | multi-modal frames (vector / image) at downlink level, on the same frame-ingest path as `daq:sample` | `{ nodeId, templateRef, kind, at, lineId, preview?, metrics, thumbUrl?, state }` |
| `dcw:write` | observation after a write-control ACK (**never affects the write decision**) | `{ nodeId, name, eng, prevValue, ok, source, lineId, at }` |
| `line:start` | a line starts running (batch window opens) | `{ lineId, runId, recipeId, productName? }` |
| `line:stop` | a line stops (batch window closes, samples lose their tag, nodes converge to offline) | `{ lineId, runId }` |
| `server:close` | server shutdown, after the per-plugin dispose queues have run | `{ at }` |

Additional notes:

- `dcw:write`'s `source` is `'manual'` / `'recipe'` / `'agent'` / `'rollback'`; the payload
  **has no `message` field**.
- The `config:changed` payload **has no `at` field** — besides `changed` / `effective` / `sources`
  there is no timestamp, so take the time yourself with `Date.now()`.
- `event:*` is a subscription entry name in the list, not an emitted event. The server-side
  wildcard is the bare `'*'` (`ctx.hooks.on('*', ({ type, payload }) => …)`);
  `ctx.hooks.on('event:*')` **never fires**.
- Scene events enter the bus as `event:<type>`. `ctx.events.on('<type>', fn)` is the sugar that
  adds the prefix, so the correct subscription for the scene event `permissions.changed` is
  `ctx.events.on('permissions.changed', fn)`.
- The available scene event names (the same source as the browser WS) include `device.created` /
  `device.updated` / `device.deleted`, `daq.reading` / `daq.frame` / `daq.node.changed` /
  `daq.controller` / `daq.alarm` / `daq.alarm.changed`, `dcw.node.changed` / `dcw.written`,
  `ops.log`, `task.status`, `permissions.changed`, `plugins.reloaded` and more.

### Example

```js
ctx.hooks.on('daq:sample', (s) => {
  if (s.value > (ctx.kv.get('threshold') ?? 180)) ctx.kv.bump('alarms')
})

ctx.hooks.on('dcw:write', (e) => {
  if (!e.ok) ctx.logger.warn(`write failed node=${e.nodeId} source=${e.source}`)
})

ctx.events.on('daq.alarm', a => ctx.logger.warn('alarm', a.id))
```

## Browser-side events (5)

| Event | When it fires | Payload | How to subscribe |
|---|---|---|---|
| `client:init` | after the client script's `setup(ctx)` has finished | `{ name }` | `ctx.hooks.on('client:init', fn)` |
| `event:*` | live scene events (same source as the WS, via the event bridge) | the event's own payload | `ctx.on('event:*', fn)` (the only wildcard spelling) |
| `page:change` | route change finished (`page:finish`) | `{ path }` | `ctx.hooks.on('page:change', fn)` |
| `i18n:changed` | UI language switched | `{ locale }` | `ctx.hooks.on('i18n:changed', fn)` |
| `client:destroy` | just before `ctx.dispose()` collects things | `{ name }` | `ctx.hooks.on('client:destroy', fn)` |

Three hard rules on the client:

- **Server hooks are never delivered**: `daq:sample` / `dcw:write` / `line:start` / `line:stop`
  cannot be received in the browser; their counterparts are scene events (`daq.reading` /
  `daq.frame` / `dcw.written` …), subscribed with `ctx.on('<scene-type>')`.
- **Client-local hooks cannot go through `ctx.on`**: `client:init` / `page:change` /
  `i18n:changed` / `client:destroy` must be subscribed directly with `ctx.hooks.on(...)`.
- **`ctx.on('*')` never fires**: the only wildcard spelling is the literal `'event:*'`, and
  `ctx.on('event:line.start')` gets a second prefix (`event:event:line.start`) and never fires either.

## HookBus semantics

| Property | Behaviour |
|---|---|
| Scheduling | listeners of one type run in registration order, **async-serial** and awaited |
| Payload | every listener receives **the same unmodified payload** (fan-out, **not a waterfall**) |
| Return value | `emit()` returns only "the last non-`undefined` return value"; values are not passed between listeners |
| Errors | a single throwing listener is isolated and counted; siblings and the main service are unaffected |
| Circuit breaker | a listener failing **8 times in a row** is removed automatically; any single success resets the counter |
| Wildcard | the bare server-side `'*'`, whose callback receives `{ type, payload }`, runs after the named listeners |
| Interception | v1 has **no** veto / interception / rewriting (observation-only) |
| Cleanup | listeners registered through `ctx.hooks` are auto-unbound on **plugin hot reload** |

## Shutdown and hot-reload sequences

```text
server shutdown (nitro close → shutdownPluginHost)
  └─ per-plugin ctx.onDispose queue (each entry try/catch): clear timers, flush kv synchronously, unbind subscriptions…
      └─ broadcast server:close { at }

plugin hot reload (plugins-state.json changed / plugin enabled-disabled / 10 s poll fallback)
  └─ per-plugin ctx.onDispose queue
      └─ unbind every listener registered through ctx.hooks
          └─ reload → broadcast plugins:reloaded
              └─ broadcast the scene event plugins.reloaded (the browser loader hot-injects / unloads client plugins from it)
```

> v1 hooks are **observation-only** — they never change interlocking or write-control decisions;
> veto (interception / rewriting) hooks are on the roadmap.
