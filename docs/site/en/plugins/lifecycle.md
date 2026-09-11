# Plugin lifecycle

## Load and shutdown panorama

```
                ┌─────────────────────── server start ───────────────────────┐
nitro plugin aw-plugins.ts
  └─ initPluginHost: three-scope scan (first match per name wins: builtin > project > user)
      → per plugin: dynamic import (?t= busts the cache) → shape check → skip disabled
      → createPluginContext → setup(ctx) → register routes[]
      └─ emit plugin:host:init { plugins, failures }
                └─────────────────────── at runtime ────────────────────────┘
daq:sample (publish-level samples) ──┐
daq:frame (multi-shape frames)     ──┤
dcw:write (write-control ACK)      ──┤
line:start / line:stop             ──┼──▶ ctx.hooks (HookBus: serial await / error isolation / removal after 8 consecutive failures) ──▶ plugin consumers
config:changed (settings change)   ──┤
event:<scene-type>                 ──┤
'*' (all-events wildcard)          ──┘
                ┌─────────────────────── hot reload ────────────────────────┐
plugins-state.json changes (fs.watch on the directory + 10 s mtime poll fallback)
  └─ per-plugin awaited dispose → unbind every hook → drop the route table → reload
      → emit plugins:reloaded → broadcast the scene event plugins.reloaded (browser syncs instantly)
                ┌─────────────────────── shutdown ───────────────────────┐
nitro close
  └─ run every per-plugin dispose queue (try/catch; including a synchronous KV flush)
      └─ emit server:close
```

## Server events, one by one

### `plugin:host:init`
- **When**: after every plugin finished `setup` (once).
- **Payload**: `{ plugins: string[], failures: number }`.
- **Use**: readiness self-check; deferred initialisation that depends on another plugin's routes.

### `plugins:reloaded`
- **When**: at the end of a hot reload (after the full reload and the settings re-sync).
- **Payload**: `{ plugins: <manifest> }`.
- **Use**: post-reload self-check; the browser also receives the scene event `plugins.reloaded` over WS.

### `daq:sample` — DAQ sample stream
- **When**: the **publish-level** outlet after pipeline aggregation (the same point as WS `daq.reading`;
  on the node's publishIntervalMs cadence, not every raw sample).
- **Payload**: `{ nodeId, templateRef, value, state, at, lineId }`.
- **Example (over-threshold alarm)**:
  ```js
  ctx.hooks.on('daq:sample', (s) => {
    if (s.value > (ctx.kv.get('threshold') ?? 180)) ctx.kv.bump('alarms')
  })
  ```

### `daq:frame` — multi-shape frame observation
- **When**: after a vector/image frame is recorded (metadata, metrics and preview only, **no blobs**).
- **Payload**: `{ nodeId, templateRef, kind, at, lineId, preview?, metrics, thumbUrl?, state }`.
- **Use**: side-channel derived metrics, frame-level external notifications.

### `dcw:write` — write-control observation
- **When**: after a write-control ACK is booked (with 10 s same-value de-duplication).
- **Payload**: `{ nodeId, name, eng, prevValue, ok, source, lineId, at }`;
  `source ∈ manual | recipe | agent | rollback`, `ok` is the read-back verification result (**there is no `message` field**).
- **Use**: dispatch auditing, alarm linkage, external notification (through ctx.http).

### `line:start` / `line:stop`
- **When**: the batch window opens / closes.
- **Payload**: `{ lineId, runId, recipeId: string, productName: string }` / `{ lineId, runId }`;
  both keys are **always present**, but may be empty strings — test truthiness rather than presence.
- **Example (runtime tracking)**:
  ```js
  ctx.hooks.on('line:start', (p) => { ctx.kv.set('running', true); ctx.kv.bump('runningCount') })
  ctx.hooks.on('line:stop', () => ctx.kv.set('running', false))
  ```

### `event:<scene-type>` and the `'*'` wildcard
- **When**: any `broadcastSceneEvent(type, payload)` (exactly the same source as the browser WS feed).
  Common ones: `daq.reading` · `daq.frame` · `daq.alarm` · `daq.alarm.changed` · `daq.node.changed` ·
  `daq.controller` · `daq.template.changed` · `dcw.node.changed` ·
  `device.created|updated|deleted` · `ops.log` · `permissions.changed` · `plugins.reloaded`.
- **Wildcard**: the server spelling is the **bare star `'*'`**, and the callback receives a `{ type, payload }` wrapper;
  `ctx.hooks.on('event:*', fn)` is **wrong** and never fires.
- **Example**:
  ```js
  ctx.events.on('daq.node.changed', (p) => ctx.logger.debug?.('node changed', p?.op))
  ctx.hooks.on('*', ({ type }) => { /* event audit */ void type })
  ```

### Permission changes, `permissions.changed`
- **When**: after line grants are written (the host prefixes platform events with `event:`).
- **Payload**: `{ userId, at }`.
- **Correct subscription**: `ctx.events.on('permissions.changed', fn)`;
  `ctx.hooks.on('permissions:changed', fn)` **never fires** (its raw bus name is `event:permissions:changed`).

### `config:changed`
- **When**: `runtime-settings.json` changes (`aw config set` / the web settings page; fs.watch debounced 300 ms).
- **Payload**: `{ type, changed: string[], effective, sources }` — **there is no `at` field**;
  `ctx.config.get/all()` has already been refreshed to the new values before the event fires.
- **Example (live threshold update)**:
  ```js
  ctx.config.onChange(() => { ctx.logger.info('config changed', ctx.config.get('theme.primaryColor')) })
  ```

### `server:close`
- **When**: nitro close — **every per-plugin `ctx.onDispose` queue runs first, then this event is emitted**.
- **Payload**: `{ at }`.

## Client events, one by one

| Event | When | Payload |
|---|---|---|
| `client:init` | after `setup(ctx)` completes | `{ name }` |
| `event:<scene-type>` / `event:*` | live WS events (through the TownBus bridge). The only wildcard spelling is the literal `'event:*'`; `ctx.on(type)` takes the **event name itself** | the event payload |
| `page:change` | Vue Router page change finished | `{ path }` |
| `i18n:changed` | UI locale switch (v2; panels re-render on it) | `{ locale }` |
| `client:destroy` | page hidden/unloaded, before `ctx.dispose()` collects | `{ name }` |

Three hard rules for the client subscription surface:

1. `ctx.on(type, fn)` carries **scene events only** (internally `event:<type>`); the wildcard must be written `'event:*'`,
   so `ctx.on('*')` and `ctx.on('event:line.start')` are both **dead subscriptions**.
2. **Server hooks never cross the bridge**: `ctx.on('daq:sample' | 'dcw:write' | 'line:start' | 'line:stop')` silently never fires.
3. **Lifecycle hooks are not on the `ctx.on` surface**: `client:init` / `page:change` / `i18n:changed` / `client:destroy`
   must go through `ctx.hooks.on(...)`.

### Panel lifecycle (v2 UI injection)

Panels registered with `ctx.ui.registerPanel({slot,name,title?,titleKey?,order?,mount(el)})`:

- **Injection**: a host page's `<workshop-plugin-slot slot-name="…" />` reacts to registry changes, mounts a container and
  calls `mount(el)`; the cleanup function returned by `mount` is called when the panel unmounts.
- **Collection**: `ctx.dispose()` collects the plugin's own subscriptions and removes `root()`, but it does **not**
  unregister panels — the loader collects them with `unregisterPlugin(name)` on disable / hot reload.
- **Isolation**: a throwing `mount` affects only that panel; the other panels and the page are unaffected.
- **Built-in slots**: `plugins.page` · `settings.plugins` · `dashboard.widgets`.

## Error isolation and the circuit breaker

- HookBus `emit` **never throws**: listeners run **serially, awaited, in registration order**, and each receives the
  **same unmodified payload**; a single listener's exception is caught, counted and reported through `onError`.
- The same listener failing **8 times in a row** is removed automatically (a success resets the counter, so occasional
  failures never accumulate) — a pathological plugin cannot flood the event stream.
- A plugin load failure (syntax error / missing name / throwing setup) is only recorded in `host.failures`;
  **half-registered state** (routes, hooks, pending omp tools) is rolled back by plugin name, guaranteeing
  "either a complete load or no trace at all".
- **Failure visibility**: `GET /api/workshop/plugins` returns `{ plugins, failures, initedAt }` (**no `{code,data}` envelope**);
  `aw plugin list` does **not** show load failures.

## Hot reload mechanics and race protection

- **Trigger**: `<home>/plugins-state.json` (`home = $AW_HOME || ~/.AgentWorkShop`, **not** the config root).
  The host `fs.watch`es its directory (directory watching is stable against tmp+rename atomic writes) and adds a
  **10 s mtime poll** as a fallback.
- **Cache busting**: the reload imports `entry + '?t=' + Date.now()`, so **editing plugin code needs no process restart**;
  the host has no separate plugin-directory watcher, so after editing code touch the state file (or toggle enable/disable
  once) to make it take effect.
- **Core code still needs a restart**: `server/` and `shared/` are outside plugin hot reload.
- **Race protection**: if the state file changes again while a reload is in flight (a disable→enable burst), the debounced
  callback collides with the in-flight guard and is merged; when the load finishes the host compares the **disabled-set
  snapshot** and re-runs once if it drifted, so toggle events are never lost.
- **Browser side**: the WS scene event `plugins.reloaded` syncs instantly, with a 15 s polling fallback.

## Known boundaries (v2)

- Hooks are **observational**: no veto (interception/rewriting) capability — write-control interlock integrity comes first,
  interception hooks are on the roadmap.
- The `ctx.http` outbound guard is **protocol-only** (http/https) and does **not** restrict hosts; plugins needing an
  allow-list must check it themselves.
- `ctx.t(key, params)` currently ignores `params` (no interpolation).
- `server:close` / `onDispose` depend on graceful shutdown signals (a forced kill on Windows does not trigger them;
  the KV debounce is 200 ms, so the data-loss window is tiny).
- A newly enabled browser plugin injects within 15 s (instantly when the WS channel is up).
