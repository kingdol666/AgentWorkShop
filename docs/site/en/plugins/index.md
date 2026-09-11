# Plugin guide

> A plugin is a self-contained folder (an `index.mjs` entry, optional `client.mjs` / `i18n.json`).
> One folder enhances both the **server** (routes / tools / DAQ / events) and the **browser**
> (panel components / i18n / settings UI). Drop it in and it loads; toggle it and the host
> hot-reloads. The full authoritative reference is the
> [complete guide (single page)](/en/plugins/guide).

## Quick start

```bash
aw plugin create my-plugin          # scaffolds into <repo>/.AgentWorkShop/plugins/my-plugin (project scope, default)
aw plugin create my-plugin --global # or user scope ~/.AgentWorkShop/plugins/my-plugin (same as -g)
aw plugin list                      # list all three scopes with enable state
aw plugin disable my-plugin         # disable (writes the state file; the server self-applies)
aw plugin enable my-plugin          # re-enable
```

`aw plugin create` defaults to the **project** scope, `--global` / `-g` writes to the user scope, `--project` is the explicit spelling (equal to the default) and `--force` / `-f` overwrites an existing folder; names must match `^[a-z][a-z0-9-]{1,31}$`. It writes:

```
<repo>/.AgentWorkShop/plugins/my-plugin/
├── index.mjs      # server entry (required): export default { name, setup(ctx), … }
├── client.mjs     # browser enhancement (optional, and must be declared as client:'./client.mjs')
└── README.md
```

The plugin folder may also contain `i18n.json` (message bundles). **Plugin KV does not live here**: it is at `<configRoot>/data/plugins/<plugin>/kv.json`.

### Three scopes and precedence

| Scope | Entry path | Notes |
|---|---|---|
| `builtin` | `<packageRoot>/server/plugins-builtin/<name>/index.mjs` | shipped with the package; the current release ships `diag-bridge` and `rag-bridge` |
| `project` | `<repo>/.AgentWorkShop/plugins/<name>/index.mjs` | travels with the checkout, can be versioned in git |
| `user` | `$AW_HOME/plugins/<name>/index.mjs` (default `~/.AgentWorkShop/plugins`) | user-level, shared across projects |

The host scans `builtin` → `project` → `user` and keeps the first match per name, so precedence is **builtin > project > user** (`aw plugin list` and `enable|disable` follow the same order). The CLI command registry goes the other way (last-wins) and must not be inferred from this.

### Enable/disable state file

Enable state lives in **`<home>/plugins-state.json`**, where `home = $AW_HOME || ~/.AgentWorkShop` — in a source checkout this is **not** the config root (`configRoot = <repo>/.AgentWorkShop` holds data and KV, `home = ~/.AgentWorkShop` holds state; for a global install the two coincide).

```json
{ "version": 1, "updatedAt": "2026-09-03T00:00:00.000Z", "disabled": ["my-plugin"] }
```

## Plugin system v2: four capabilities

| Capability | How | Where it lands |
|---|---|---|
| **Frontend component injection** | `ctx.ui.registerPanel({slot, name, mount(el)})` in `client.mjs` | page slots via `<workshop-plugin-slot slot-name="…" />`: plugins page / settings page / dashboard |
| **Plugin settings** | `settings: [{key,type,default,…}]` plus `configGroups: [{id,label,…}]` in `index.mjs` | rendered as the plugin's own config group in the settings page; applies live on save |
| **Plugin i18n** | `i18n.json` at the folder root (`{"zh-CN":{…},"en":{…}}`); `ctx.t(key)` / `labelKey` / `titleKey` | vue-i18n namespace `plugin.<plugin>`, follows locale switches instantly |
| **Runtime services surface** | `ctx.services.get('daq'\|'lines'\|'channels'\|'plugins')` / `.provide(name, getter)` | read-only backend runtime objects + cross-plugin service provision (auto-prefixed `<plugin>.`) |

## Plugin contract (`index.mjs`)

`index.mjs` exports a **plain object** (zero import dependencies — the host injects `ctx`):

```js
export default {
  name: 'my-plugin',         // required, globally unique
  version: '1.0.0',
  description: '…',
  auth: 'user',              // optional: none (default) | user | admin | agent-or-user
  client: './client.mjs',    // optional: browser entry (must be a relative path string)
  settings: [ /* optional: setting declarations */ ],
  configGroups: [ /* optional: config group declarations */ ],
  routes: [                  // optional: declarative API (or ctx.route() inside setup)
    { method: 'GET', path: '/health', handler: () => ({ ok: true }) },
  ],
  async setup(ctx) { /* server lifecycle */ },
}
```

The host shape-checks the module at load time (`validatePluginModule`); a failure is recorded in `failures` and logged without taking down the main service. Registration order is **`setup(ctx)` first, then `routes[]`**.

## Plugin settings and config groups

```js
configGroups: [
  { id: 'default', label: 'Connection', description: 'Backend URL and auth', order: 400 },
  { id: 'advanced', label: 'Advanced', collapsed: true },
],
settings: [
  { key: 'base_url', type: 'string', default: 'http://127.0.0.1:8770', group: 'default',
    labelKey: 'plugin.my-plugin.settings.base_url', label: 'Service URL', description: 'applies live on save' },
  { key: 'max_turns', type: 'number', default: 0, min: 0, max: 2000, group: 'advanced', label: 'Max turns' },
  { key: 'mode', type: 'select', default: 'a', options: ['a', 'b'], group: 'advanced', label: 'Mode' },
],
```

- `key` allows letters, digits, `-` and `_` only; `type` is one of `string|number|boolean|select`; **`default` is mandatory** (an entry without one is skipped with a warning); a `select`'s `default` must be inside `options`; `min`/`max` are honoured for `number` only.
- Keys are force-namespaced to `plugins.<plugin>.<key>`; `settings[].group` references the **declared** id (`default` → `plugin-<plugin>`, `x` → `plugin-<plugin>-x`).
- Fields **without a `group`** land in the plugin's default group (titled `plugin-<plugin>`; declare `{ id:'default', label:'…' }` for a readable title).
- There is no literal config group called "Plugins" in the settings page: that is the plugin **management** list (enable switches + health check), a separate piece of UI from the plugin's own config groups.
- Runtime extension: `ctx.config.defineGroup / defineField / removeGroup / removeField / groups / fields` (register conditionally inside `setup`; removed automatically on unload).
- Read with `ctx.config.get('plugins.<plugin>.<key>')`; subscribe with `ctx.config.onChange(fn)`.

## Plugin i18n (`i18n.json`)

```json
{
  "zh-CN": { "settings": { "base_url": "服务地址" }, "panel": { "title": "我的面板" } },
  "en":    { "settings": { "base_url": "Service URL" }, "panel": { "title": "My panel" } }
}
```

`GET /api/plugins/i18n` assembles the bundles of all enabled plugins (unauthenticated; **UI copy only**) and the loader merges them into the vue-i18n namespace `plugin.<plugin>`; `ctx.t('panel.title')` resolves against the plugin's own message tree and falls back to the key. Locale switches emit the `i18n:changed` hook (receive it with `ctx.hooks.on`).

## Hot management (`aw plugin` + the /plugins page)

```bash
aw plugin list                  # three-scope listing with enable state (+client = browser enhancement)
aw plugin create my-plugin      # scaffold (project scope by default; --global for user scope)
aw plugin disable my-plugin     # writes plugins-state.json; the running server self-applies
aw plugin enable my-plugin      # re-enable
```

- The state file is **`<home>/plugins-state.json`** (`home = $AW_HOME || ~/.AgentWorkShop`, **not** the config root), shaped `{ version, updatedAt, disabled: [...] }`. The CLI and the web plugins page write the same file; on (re)load disabled entries are skipped (their manifest stays visible with `enabled: false`).
- **Toggling needs no process restart**: the host `fs.watch`es the state file's directory with a 10 s mtime poll as a fallback, and completes a full reload within about 1 s.
- **Code edits need no process restart either**: the reload imports `entry + '?t=' + Date.now()` to defeat the ESM cache. The host has no plugin-directory watcher, so after editing code touch `plugins-state.json` (or toggle enable/disable once); core `server/` and `shared/` changes still need a restart.
- If the state file changes again while a reload is in flight (a disable→enable burst), the disabled-set snapshot comparison re-runs it once — toggle events are never lost.

## Load and reload flow

```
server start (nitro plugin server/plugins/aw-plugins.ts)
  └─ three-scope scan (first match per name wins: builtin > project > user)
       ├─ <packageRoot>/server/plugins-builtin/*/index.mjs        (builtin)
       ├─ <repo>/.AgentWorkShop/plugins/*/index.mjs               (project)
       └─ $AW_HOME|~/.AgentWorkShop/plugins/*/index.mjs           (user)
  └─ per plugin: dynamic import (?t= busts the cache) → shape check → skip disabled
       → createPluginContext → setup(ctx) → register routes[] → record client/i18n
  └─ sync setting descriptors and config groups → emit plugin:host:init { plugins, failures }

at runtime: plugins-state.json changes (fs.watch + 10 s poll)
  └─ per-plugin dispose (awaited) → unbind hooks → drop the route table → reload
       → emit plugins:reloaded → broadcast the scene event plugins.reloaded (browser syncs instantly)

server shutdown (nitro close)
  └─ run every per-plugin dispose queue (including a synchronous KV flush) → emit server:close
```

- **Error isolation**: a single plugin failing to load or run is recorded in `failures` and logged; it never takes down the main service, and half-registered state (routes / hooks / omp tools) is rolled back by plugin name.
- **Failure visibility**: `aw plugin list` does **not** show load failures; use `GET /api/workshop/plugins` (returns `{ plugins, failures, initedAt }`, **no `{code,data}` envelope**).

## Server `ctx` members

| Group | Members | Notes |
|---|---|---|
| Identity | `ctx.name / scope / dir / sdkVersion` | `scope ∈ 'builtin' \| 'project' \| 'user'` |
| Hooks | `ctx.hooks` | HookBus: `on/once/off/emit` (serial await, error isolation, bare `'*'` wildcard, removal after 8 consecutive failures); auto-unbound on hot reload |
| Logging | `ctx.logger` | `debug/info/warn/error`, prefixed `[aw-plugins] [<plugin>]` |
| Config | `ctx.config.get / all / onChange / defineGroup / defineField / removeGroup / removeField / groups / fields` | effective config (read-only) + change subscription + runtime group/field registration |
| Storage | `ctx.kv.get / set / all / bump` | plugin-private KV (**no `reset()`**); in-memory state is authoritative with a 200 ms debounced atomic flush |
| Timers | `ctx.timer.setInterval / setTimeout` | auto-registered for disposal on shutdown and hot reload |
| Cleanup | `ctx.onDispose(fn)` / `ctx.subscriptions.add(d)` | shares one host-owned dispose queue with `ctx.timer` |
| Routes | `ctx.route(method, path, handler)` | plugin API → `/api/plugins/<plugin><path>` (exact match); returns a boolean |
| Platform | `ctx.api` | platform REST client (loopback origin, unwraps the envelope; `setToken` for authenticated endpoints) |
| Network | `ctx.http.get / post` | outbound fetch; the guard is **protocol-only** (http/https), it does not restrict hosts; 8 s default timeout |
| Events | `ctx.events.on / off` | scene-event subscription (adds the `event:` prefix internally) |
| Paths | `ctx.paths.home / configRoot / dataDir`; `ctx.dataDir` | `ctx.dataDir` = `<configRoot>/data/plugins/<plugin>` |
| DAQ extension | `ctx.daq.registerDriver / registerProcessor / registerTemplate / onFrame / onSample / query / nodes` | plugin drivers / sink processors / node templates / time-series queries / node metadata (same-name override) |
| OMP tools | `ctx.omp.registerTool(tool)` | registers a host tool → hot-injected into every harness; `roles` accepts `'lead'` and `'worker'` only |
| Services | `ctx.services.names / get / provide` | runtime object surface: `get('daq'\|'lines'\|'channels'\|'plugins')`; `provide` auto-prefixes `<plugin>.` |
| Permissions | `ctx.permissions.lineMode / visibleLineIds / listGrants / setGrants` | line-grant queries and management |

**KV location**: `<configRoot>/data/plugins/<plugin>/kv.json` — not inside the plugin folder.

## Server events

| Event | When | Payload |
|---|---|---|
| `plugin:host:init` | after every plugin finished `setup` (once) | `{ plugins: string[], failures: number }` |
| `plugins:reloaded` | at the end of a hot reload | `{ plugins: <manifest> }` |
| `config:changed` | settings changed (settings page / `runtime-settings.json`) | `{ type, changed: string[], effective, sources }` — **there is no `at` field** |
| `daq:sample` | publish-level samples (same point and cadence as WS `daq.reading`) | `{ nodeId, templateRef, value, state, at, lineId }` |
| `daq:frame` | after a multi-shape frame is recorded (no blobs, metadata/metrics/preview only) | `{ nodeId, templateRef, kind, at, lineId, preview?, metrics, thumbUrl?, state }` |
| `dcw:write` | after a write-control ACK is booked (10 s same-value de-duplication) | `{ nodeId, name, eng, prevValue, ok, source, lineId, at }` (`source ∈ manual\|recipe\|agent\|rollback`) |
| `line:start` / `line:stop` | batch window opens / closes | `{ lineId, runId, recipeId, productName }` / `{ lineId, runId }` |
| `event:<scene-type>` | any `broadcastSceneEvent(type, payload)` (same source as the browser WS feed) | the event's own payload |
| `server:close` | on nitro close (after per-plugin dispose ran) | `{ at }` |

```js
// wildcard: the server spelling is the bare '*', the callback receives { type, payload }
ctx.hooks.on('*', ({ type }) => ctx.logger.debug('event', type))

// scene events: use ctx.events, which adds the event: prefix
ctx.events.on('daq.node.changed', (p) => ctx.logger.debug('node changed', p?.op))

// permission changes: ctx.hooks.on('permissions:changed') never fires
ctx.events.on('permissions.changed', (p) => ctx.logger.info('grants changed', p?.userId))
```

## Plugin API (routes and auth)

```js
ctx.route('GET', '/stats', () => ctx.kv.all())

ctx.route('POST', '/threshold', (event) => {
  const v = Number(event.awBody?.threshold)   // the forwarding layer pre-read the JSON body
  if (!Number.isFinite(v)) return { ok: false, error: 'threshold must be a number' }
  ctx.kv.set('threshold', v)
  return { ok: true, threshold: v }
})
```

→ `/api/plugins/<plugin><path>` (exact match; the return value is serialised to JSON by nitro). Authentication is enforced declaratively by the entry's `auth` field, checked **before** your handler for `routes[]` and `ctx.route()` alike:

| `auth` | Behaviour |
|---|---|
| `'none'` (default) | no check |
| `'user'` | requires a valid user token, otherwise 401 |
| `'admin'` | requires an administrator, otherwise 401 |
| `'agent-or-user'` | accepts an agent identity or a user token |

Do not put authentication inside the handler: `resolveUser(event)` is not importable from a plugin and is not on `ctx` — declare `auth` instead.

## Multi-shape DAQ and omp tool extension

DAQ is not limited to single-point values: a template may declare `signalKind: 'vector'` (multi-point profiles from thickness gauges / scanners) or `'image'` (CCD frames). Vector and frame metadata go to Timescale (`daq_frames`); image pixels go to object storage (MinIO, degrading automatically to local disk when unreachable).

```js
// register a sink processor: it takes effect once a template's sink lists { name: 'demo-roughness' }
ctx.daq.registerProcessor('vector', 'demo-roughness', (frame, args) => ({
  ...frame, metrics: { ...frame.metrics, roughness: computeRoughness(frame.points) },
}))

// register a node template (appears in the /daq catalogue and the create wizard; key must match /^[\w-]+$/ and not clash with a built-in)
ctx.daq.registerTemplate({
  key: 'plug-my-plugin-sensor', name: 'My sensor', unit: 'mm',
  min: 0.4, max: 0.6, base: 0.5, amp: 0.02, decimals: 3, icon: 'tension',
  signalKind: 'vector', vector: { points: 32, min: 0.4, max: 0.6 },
  sink: { processors: [{ name: 'resample', args: { n: 32 } }, { name: 'demo-roughness' }] },
  metrics: [{ key: 'roughness', label: 'Roughness', alarmHigh: 0.05 }],
})

// register an omp host tool: hot-injected into every harness (no respawn)
ctx.omp.registerTool({
  name: 'sensor_log',
  description: 'Read or record sensor calibration conclusions',
  parameters: { type: 'object', properties: { sensor: { type: 'string' } }, required: ['sensor'] },
  roles: ['lead', 'worker'],
  handler: async (args, agent) => ({ text: `${args.sensor} @ ${agent.role}` }),
})
```

- Derived-metric threshold breaches (declared through a template's `metrics`) follow the platform's existing alarm chain (storage + WS + webhook).
- Never open a `url`/`host` injection hole in tool parameters; the full semantics and examples are in the [complete guide (single page)](/en/plugins/guide).

## Browser enhancement (`client.mjs`)

A self-contained ESM exporting `setup(ctx)`; the entry must declare `client: './client.mjs'` in the manifest, and the loader fetches the script from `/api/plugins/client/<plugin>`.

```js
export function setup(ctx) {
  let samples = 0
  const counter = ctx.el('strong', {}, ['0'])

  ctx.on('daq.reading', () => { samples += 1; counter.textContent = String(samples) })  // scene event

  ctx.ui.registerPanel({
    slot: 'plugins.page', name: 'my-panel', titleKey: 'panel.title', order: 10,
    mount(el) {
      const box = ctx.el('div', {}, ['samples:', counter])
      el.append(box)
      const timer = setInterval(() => { counter.textContent = String(samples) }, 5000)
      return () => { clearInterval(timer); box.remove() }   // cleanup: called when the panel unmounts
    },
  })

  ctx.log.info('client ready')
}
```

| Event / member | Notes |
|---|---|
| `client:init` | emitted by the loader after `setup(ctx)` completes; subscribe with `ctx.hooks.on` |
| `event:<scene-type>` / `event:*` | live WS events (through the TownBus bridge); `ctx.on(type)` takes the event name itself and the only wildcard spelling is the literal `'event:*'` |
| `page:change` | route change finished, `{ path }`; subscribe with `ctx.hooks.on` |
| `i18n:changed` | locale switch, `{ locale }`; subscribe with `ctx.hooks.on` |
| `client:destroy` | emitted before `ctx.dispose()`, `{ name }` |
| `ctx.t(key, params?)` | plugin-namespaced translation (`params` is currently ignored, no interpolation) |
| `ctx.fetch / el / mount / root / locale / log / dispose` | same-origin API helper / DOM helper / mount / private root node / current locale / prefixed logger / unload |

**Dead subscriptions**: `ctx.on('*')`, `ctx.on('event:line.start')` and `ctx.on('daq:sample')` all never fire — server hooks (`daq:sample` / `dcw:write` / `line:start|stop`) **never cross to the browser**, and lifecycle hooks are **not on the `ctx.on` surface** (use `ctx.hooks.on`).

Built-in slots: `plugins.page` (plugins page) · `settings.plugins` (below the settings-page plugin area) · `dashboard.widgets` (dashboard tail).

## Team-scoped plugin switches (channel × plugin)

Beyond the global switch, every team (channel) keeps its **own plugin switch set** backed by the `channel_plugins` table:

- **Picked at team creation**: `POST /api/workshop/teams` accepts `plugins: [{ name, enabled }]`, stored under the team id and propagated to the channel on deploy;
- **Toggled at any time**: `GET|PUT /api/workshop/channels/:id/plugins` and `GET|PUT /api/workshop/teams/:id/plugins` (body `{ plugins: [{ name, enabled }] }`, full replacement, unknown or disabled names ignored);
- **Semantics**: no explicit rows = unconfigured → every enabled plugin is visible to that team (backward compatible); once rows exist they filter — **a disabled plugin's tools are not injected into that team's agents and dispatch rejects them at the source**;
- **UI**: the workshop teams page (creation checkboxes + team dialog).

## Debugging and traps

| Symptom | Cause / fix |
|---|---|
| Plugin code edits have no effect | the host has no plugin-directory watcher: touch `<home>/plugins-state.json`, or toggle `aw plugin enable/disable` once (the reload imports with `?t=` to defeat the cache); core `server/` and `shared/` changes still need a restart |
| Load failures are invisible | `aw plugin list` does not show them; **use `GET /api/workshop/plugins`** (`{ plugins, failures, initedAt }`, no `{code,data}` envelope) or read `[aw-plugins] 装载失败 …` in the startup log |
| Client badge never appears | check the browser console for `[aw-plugins]` warnings; confirm the manifest says `hasClient: true` (the manifest declares `client:'./client.mjs'`) |
| A client subscription never fires | you hit one of the dead subscriptions listed above |
| Plugin route 404 | matching is exact; check the method and the leading `/`, and whether the plugin is enabled (a disabled plugin's routes are removed) |
| Plugin route 401 | the entry declared `auth` and the request carried no valid credential; use `auth: 'none'` for open endpoints |
| A setting does not render | a missing `default` gets the entry skipped; a `select`'s `default` must be inside `options`; `key` allows letters, digits, `-` and `_` only |
| `ctx.api` returns 401 | authenticated endpoints need `setToken`; unauthenticated ones (manifest/ping) do not |
| The `permissions:changed` hook never fires | that name does not exist; use `ctx.events.on('permissions.changed', fn)` |

**Trust model**: a plugin is arbitrary node code, on par with aw commands — only install and enable plugins you trust.

## Known boundaries (intentional)

- Hooks are **observational**: v1 has no veto / interception / rewriting.
- The `ctx.http` guard is **protocol-only** (http/https) and does **not** restrict hosts — do your own allow-listing inside the plugin.
- `ctx.t(key, params)` currently ignores `params` (no interpolation).
- `ctx.kv` has **no `reset()`**; writes flush after a 200 ms debounce, so a hard kill has a tiny loss window.
- The server and browser subscription surfaces **do not overlap**; **a newly enabled browser plugin injects within 15 s** (instantly when the WS channel is up).
- `server:close` / `onDispose` depend on graceful shutdown signals (a forced kill on Windows does not trigger them).

## Scopes and distribution

- builtin: `<packageRoot>/server/plugins-builtin/` (shipped with the package, highest precedence).
- project: `<repo>/.AgentWorkShop/plugins/` (can be versioned in git with the team).
- user: `$AW_HOME|~/.AgentWorkShop/plugins/` (shared across projects).
- Uninstalling = delete the folder, then restart (or touch the state file to trigger a reload).
