# AgentWorkShop plugin development guide (full)

> A plugin is a self-contained folder: an `index.mjs` entry (required), an optional
> `client.mjs` (browser enhancement) and an optional `i18n.json` (message bundles).
> One folder enhances both the **server** (routes / tools / DAQ / events) and the
> **browser** (panel components / i18n / settings UI). Drop it in and it loads;
> toggle it and the host hot-reloads. This page is the single authoritative reference;
> the paged docs under `docs/site/plugins/` share the same source of truth.
>
> Applies to: plugin system v2 has been available since **v0.7.29** (frontend component
> injection / plugin settings / plugin i18n / runtime services surface); this document
> describes **v0.7.37**. `ctx.sdkVersion` is currently `0.3.0`.

## 1. Folder layout & quick start

```bash
aw plugin create my-plugin          # scaffolds into <repo>/.AgentWorkShop/plugins/my-plugin (project scope, default)
aw plugin create my-plugin --global # or user scope ~/.AgentWorkShop/plugins/my-plugin (same as -g)
aw plugin list                      # list all three scopes with enable state
aw plugin disable my-plugin         # disable (writes the state file; the server self-applies)
aw plugin enable my-plugin          # re-enable
```

`aw plugin create` defaults to the **project** scope; `--global` / `-g` writes to the **user** scope; `--project` is the explicit spelling (equal to the default, kept for intuition); `--force` / `-f` overwrites an existing folder. Names are validated against `^[a-z][a-z0-9-]{1,31}$` (lowercase letter first, 2–32 chars). The command writes three files:

```
<repo>/.AgentWorkShop/plugins/my-plugin/
├── index.mjs      # server entry (required): export default { name, setup(ctx), … }
├── client.mjs     # browser enhancement (optional, and must be declared as client:'./client.mjs')
└── README.md
```

The plugin folder may also contain `i18n.json` (message bundles, see §5). **Plugin KV does not live here** — it lives at `<configRoot>/data/plugins/<plugin>/kv.json` (see §6).

### Three scopes and precedence

The host scans `builtin` → `project` → `user` and keeps the **first** match per name:

| Scope | Entry path | Notes |
|---|---|---|
| `builtin` | `<packageRoot>/server/plugins-builtin/<name>/index.mjs` | shipped with the package, always present; the current release ships `diag-bridge` and `rag-bridge` |
| `project` | `<repo>/.AgentWorkShop/plugins/<name>/index.mjs` | travels with the checkout, can be versioned in git |
| `user` | `$AW_HOME/plugins/<name>/index.mjs` (default `~/.AgentWorkShop/plugins`) | user-level, shared across projects |

Precedence is **builtin > project > user** (the host scans first-wins and de-duplicates through a `seen` set). Mind the direction: the CLI command registry (`cli/core/registry.mjs`) is **last-wins**, i.e. project > user > builtin — the two are opposite and must not be inferred from each other. `aw plugin list` and `aw plugin enable|disable` use this same order, so a toggle always hits the plugin you see.

### Enable/disable state file

Enable state lives in **`<home>/plugins-state.json`**, where `home = $AW_HOME || ~/.AgentWorkShop`. In a source checkout this is **not** the config root:

- `configRoot = <repo>/.AgentWorkShop` — data and plugin KV live here;
- `home = ~/.AgentWorkShop` — the enable state lives here.

For a global (home-mode) install the two coincide, which is why older text calling it "the config root" looked harmless — but in a checkout it points at the wrong path. File shape:

```json
{ "version": 1, "updatedAt": "2026-09-03T00:00:00.000Z", "disabled": ["my-plugin"] }
```

`aw plugin enable|disable`, the web plugin page and the host all read and write the same file.

## 2. Plugin contract (`index.mjs`)

`index.mjs` exports a **plain object** (zero import dependencies — the host injects `ctx`):

```js
export default {
  name: 'my-plugin',         // required, globally unique (missing / non-string fails the load)
  version: '1.1.0',          // optional, shown in the manifest
  description: '…',          // optional
  auth: 'user',              // optional: none (default) | user | admin | agent-or-user
  client: './client.mjs',    // optional: browser entry (must be a relative path string)
  settings: [ /* optional: setting declarations, see §4 */ ],
  configGroups: [ /* optional: config group declarations, see §4 */ ],
  routes: [                  // optional: declarative routes (registered after setup returns)
    { method: 'GET', path: '/health', handler: () => ({ ok: true }) },
  ],
  async setup(ctx) { /* server lifecycle, see §3 */ },
}
```

The host shape-checks the module at load time (`validatePluginModule`): `name` must be a non-empty string; `setup`, if present, must be a function; `client`, if present, must be a string; `settings`, if present, must be an array. Any violation fails the load, is recorded in `failures` and logged — **error isolation never takes down the main service**.

Registration order matters: **`await setup(ctx)` runs first, then `routes[]` are registered**. That way a throwing `setup` cannot leave a ghost route behind (a route that is live while the host has no record of the plugin).

## 3. Enable, disable and hot reload

| Phase | Server | Browser |
|---|---|---|
| Load | nitro plugin `server/plugins/aw-plugins.ts` → three-scope scan → dynamic import (`?t=` busts the cache) → shape check → `setup(ctx)` → register `routes[]` | loader (`app/plugins/aw-plugins.client.ts`) fetches `GET /api/plugins/manifest` → fetches `GET /api/plugins/i18n` → dynamic-imports `/api/plugins/client/<name>` → `setup(ctx)` |
| Inject | routes / tools / drivers / templates / processors take effect immediately; setting descriptors merge into `SystemConfigService` | panels inject into page slots through `ctx.ui.registerPanel`; `client:init` is emitted |
| Run | `daq:sample` / `daq:frame` / `dcw:write` / `line:start\\|stop` / `config:changed` / `event:<type>` / `*` | `event:<type>` (same source as WS) / `page:change` / `i18n:changed` |
| Reload | state-file change → full dispose (each `await`ed) → unbind hooks → drop routes → reload → emit `plugins:reloaded` | WS `plugins.reloaded` syncs instantly, plus a 15 s polling fallback → disabled plugins get `ctx.dispose()` |
| Shutdown | per-plugin dispose queue (including a synchronous KV flush) → emit `server:close` | the page's `pagehide` triggers `ctx.dispose()` |

Facts about hot reload:

- **The trigger is the state file**: the host `fs.watch`es the directory holding `plugins-state.json`, with a **10 s mtime poll** as a fallback (Windows can drop events for atomic `rename` writes). `aw plugin enable|disable`, the web toggle, or simply touching the file all trigger a full reload **within about 1 s**.
- **Code edits need no process restart**: the reload imports `entry + '?t=' + Date.now()`, which defeats the ESM module cache, so plugin code changes take effect on the next reload. The host has **no separate plugin-directory watcher** — after editing code, touch `plugins-state.json` (or toggle enable/disable once) to make it take effect immediately.
- **Core code still needs a restart**: changes under `server/` and `shared/` are outside plugin hot reload.
- **Race protection**: if the state file changes again while a reload is in flight (a disable→enable burst), the debounced callback hits the in-flight guard; when the load finishes the host compares the disabled-set snapshot and re-runs once if it drifted, so toggle events are never lost.
- **Browser side**: a newly enabled plugin injects within 15 s at the latest (instantly when the WS channel is up); a disabled plugin is unloaded immediately together with all of its panels.

## 4. Plugin settings and config groups

### Declarative fields (manifest `settings[]`)

```js
settings: [
  { key: 'base_url', type: 'string', default: 'http://127.0.0.1:8770',
    labelKey: 'plugin.my-plugin.settings.base_url',   // i18n key (see §5)
    label: 'Service URL (fallback label)', description: 'applies live on save' },
  { key: 'max_turns', type: 'number', default: 0, min: 0, max: 2000, label: 'Max turns' },
  { key: 'auto_enabled', type: 'boolean', default: false, label: 'Automatic mode' },
  { key: 'mode', type: 'select', default: 'a', options: ['a', 'b'], label: 'Mode' },
],
```

Hard constraints enforced by the validator (`validatePluginSettings`) — failing any one of them **skips that entry with a warning** while the rest still load:

| Constraint | Rule |
|---|---|
| `key` | required and must match `/^[A-Za-z0-9_-]+$/` (letters, digits, `-`, `_` only) |
| `type` | must be one of `'string' \| 'number' \| 'boolean' \| 'select'` |
| `default` | **mandatory** — an entry without a default is skipped outright |
| `select` | must supply an `options` array and `default` must be in it (compared as strings) |
| `min` / `max` | honoured for `number` only (they are still written into the descriptor, but mean nothing for other types) |
| `label` | falls back to `key`; `labelKey` wins when present (resolved through i18n) |
| `description` | defaults to an empty string |

Normalised descriptors always carry `applies: 'live'` (applies on save), and the key is force-namespaced to **`plugins.<plugin>.<key>`** — the same addressing space as global schema keys.

### Config groups (manifest `configGroups[]` + `settings[].group`)

```js
configGroups: [
  { id: 'default', label: 'Connection', description: 'Backend URL and auth', order: 400 },
  { id: 'advanced', label: 'Advanced', collapsed: true },
],
settings: [
  { key: 'base_url', type: 'string', default: 'http://127.0.0.1:8770', group: 'default', label: 'Service URL' },
  { key: 'timeout_ms', type: 'number', default: 8000, group: 'advanced', label: 'Timeout (ms)' },
],
```

- Group ids are folded into the plugin's own namespace: `default` (or the plugin name) maps to `plugin-<plugin>`, any other declared id `x` maps to `plugin-<plugin>-x`. Two plugins may both declare `network` without overwriting each other.
- `settings[].group` references the **declared id** (`default` / `advanced`), not the prefixed id.
- Fields **without a `group`** land in the plugin's default group whose id is `plugin-<plugin>`; if the plugin never declared a title for that default id, the settings page shows the id itself (i.e. `plugin-<plugin>`). To get a readable title, declare `{ id: 'default', label: '…' }` as above — both shipped built-ins do exactly that.
- Groups are removed automatically when the plugin is unloaded or disabled; no empty sections are left behind.
- There is **no literal config group called "Plugins"**: what you see in Settings → Runtime is the plugin management list (enable switches + health check), a separate piece of UI from the plugin's own config groups.

> `configGroups` is the field name the host actually reads (`host.mjs` reads `def.configGroups`). The type declaration file `sdk/index.d.mts` spells it `groups?`, which does not match the runtime — this guide and the code win.

### Runtime registration (extend conditionally inside `setup`)

```js
async setup(ctx) {
  // Add a group and get back its real (namespaced) id
  const group = ctx.config.defineGroup({ id: 'rules', label: 'Automatic rules', collapsed: true })
  // Add a field (equivalent to manifest settings[], but registrable conditionally)
  ctx.config.defineField({
    key: 'auto_rules', type: 'string', default: '', group: 'rules', label: 'JSON rules',
  })
  ctx.logger.info(ctx.config.groups().map(g => g.id).join(','))
  ctx.logger.info(ctx.config.fields().map(f => f.key).join(','))
  // Removal (removeGroup takes the namespaced id returned by defineGroup; removeField takes the short key)
  if (group) ctx.config.removeGroup(group.id)
  ctx.config.removeField('auto_rules')
}
```

`defineGroup` / `defineField` enforce exactly the same validation as the declarative form (an invalid call returns `null` and logs a warning); `removeGroup` / `removeField` return a boolean telling whether anything was actually removed. These groups and fields are removed with the plugin, and re-registering never loses values that were already saved.

### Reading and persistence

- Read with `ctx.config.get('plugins.my-plugin.base_url')` (every call reads the merged effective value, so a save applies live); `ctx.config.all()` returns a full snapshot.
- Subscribe with `ctx.config.onChange(fn)`, which is sugar for `ctx.hooks.on('config:changed', fn)`.
- Runtime overrides persist in `<configRoot>/runtime-settings.json`; `PATCH /api/system/settings` validates against the same descriptors and the settings page renders from them.
- Migration: the `plugins.kb.*` / `plugins.diag.*` keys hard-coded in `shared/config/schema.json` before 0.7.28 were replaced by plugin declarations; on startup the server moves old overrides to the new keys in one pass (keeping the old key until the new one is registered, so data is never dropped).

## 5. Plugin i18n (`i18n.json`)

```json
{
  "zh-CN": { "settings": { "base_url": "服务地址" }, "panel": { "title": "我的面板" } },
  "en":    { "settings": { "base_url": "Service URL" }, "panel": { "title": "My panel" } }
}
```

- The host parses `i18n.json` at the plugin folder root during load (a broken file is ignored without blocking the load).
- `GET /api/plugins/i18n` assembles the bundles of all **enabled** plugins (unauthenticated; UI copy only, **never secrets**) and returns `{ i18n: { "<plugin>": { "<locale>": { … } } }, locales: ["zh-CN", "en"] }`.
- After fetching, the browser loader merges the messages into the vue-i18n namespace `plugin.<plugin>` — host components (settings `labelKey`, panel `titleKey`) resolve them directly — and `ctx.t(key)` resolves against the plugin's own message tree (`ctx.t('panel.title')` → `plugin.my-plugin.panel.title`, falling back to the key when missing).
- On a locale switch the loader emits the `i18n:changed` hook; plugins receive it with `ctx.hooks.on('i18n:changed', fn)` (note: it is **not** on the `ctx.on` delivery surface).
- The manifest exposes `hasI18n` / `settingsCount` / `hasClient` for the frontend.

## 6. Server `ctx` reference

| Surface | Members | Notes |
|---|---|---|
| Identity | `ctx.name` / `ctx.scope` / `ctx.dir` / `ctx.sdkVersion` | `scope ∈ 'builtin' \| 'project' \| 'user'`; `dir` is the absolute plugin folder |
| Hooks | `ctx.hooks.on / once / off / emit` | per-plugin facade; auto-unbound on hot reload, no manual `off` needed |
| Logging | `ctx.logger.debug / info / warn / error` | prefixed with `[aw-plugins] [<plugin>]` |
| Config | `ctx.config.get / all / onChange / defineGroup / defineField / removeGroup / removeField / groups / fields` | effective config (read-only) + change subscription + runtime group/field registration (see §4) |
| Storage | `ctx.kv.get / set / all / bump` | plugin-private KV; **no `reset()`**; in-memory state is authoritative with a 200 ms debounced atomic flush |
| Timers | `ctx.timer.setInterval / setTimeout` | auto-registered for disposal on shutdown and hot reload |
| Cleanup | `ctx.onDispose(fn)` / `ctx.subscriptions.add(d)` | shares one host-owned dispose queue with `ctx.timer` |
| Routes | `ctx.route(method, path, handler)` | mounted at `/api/plugins/<plugin><path>` (exact match); **returns a boolean** |
| Platform | `ctx.api` | platform REST client (loopback origin; unwraps the envelope; call `ctx.api.setToken(token)` for authenticated endpoints) |
| Network | `ctx.http.get(url, opt)` / `ctx.http.post(url, body, opt)` | outbound fetch; the guard is **protocol-only** (http/https), it does not restrict hosts; 8 s default timeout; `headers` pass through |
| Events | `ctx.events.on(type, fn)` / `ctx.events.off(type, fn)` | scene-event sugar: subscribes to `event:<type>` internally (see §7) |
| Paths | `ctx.paths.home / configRoot / dataDir`; `ctx.dataDir` | `ctx.dataDir` is this plugin's KV folder, `<configRoot>/data/plugins/<plugin>` |
| DAQ | `ctx.daq.registerDriver / registerProcessor / registerTemplate / onFrame / onSample / query / nodes` | driver, sink-processor and node-template registration + time-series queries + node metadata snapshot |
| Tools | `ctx.omp.registerTool({ name, label?, description, parameters, roles?, handler })` | agent tool injection; `roles` accepts `'lead'` and `'worker'` only (see §10) |
| Services | `ctx.services.names()` / `.get(name)` / `.provide(name, getter)` | runtime object surface: `get('daq' \| 'lines' \| 'channels' \| 'plugins')`; `provide` auto-prefixes `<plugin>.` |
| Permissions | `ctx.permissions.lineMode / visibleLineIds / listGrants / setGrants` | line-grant queries and management |

### Where KV lives

`<configRoot>/data/plugins/<plugin>/kv.json` — **not** inside the plugin folder. Writes are authoritative in memory and flushed atomically (`tmp` + `rename`) after a 200 ms debounce; on shutdown and hot reload the pending debounce is cancelled and the state is flushed synchronously. `ctx.kv` has exactly four methods: `get / set / all / bump`.

```js
ctx.kv.set('threshold', 180)        // write (flushed after 200 ms)
ctx.kv.get('threshold')             // read (undefined if never written)
ctx.kv.bump('alarms')               // +1, returns the new value; bump('alarms', -1) decrements
ctx.kv.all()                        // shallow copy of the whole store
```

## 7. Event reference (server)

Events are dispatched through a HookBus: **listeners run serially, awaited, in registration order**, and every listener receives the **same unmodified payload object** — it is not a waterfall (only the last non-`undefined` return value is kept, and the host ignores it), and v1 has no veto or interception. A throwing listener is isolated and counted: a success resets the counter, and **8 consecutive failures remove the listener** (circuit breaker).

### Lifecycle and platform events

| Event | When | Payload |
|---|---|---|
| `plugin:host:init` | after every plugin finished `setup` (once) | `{ plugins: string[], failures: number }` |
| `plugins:reloaded` | at the end of a hot reload | `{ plugins: <manifest> }` |
| `config:changed` | `runtime-settings.json` / settings page changed | `{ type, changed: string[], effective, sources }` — **there is no `at` field** |
| `server:close` | on nitro close, after every per-plugin dispose ran | `{ at }` |

### Domain events

| Event | When | Payload |
|---|---|---|
| `daq:sample` | the **publish-level** outlet after pipeline aggregation (same point and cadence as WS `daq.reading`, gated by `publishIntervalMs`) | `{ nodeId, templateRef, value, state, at, lineId }` |
| `daq:frame` | after a multi-shape frame (vector/image) is recorded (metadata, metrics and preview only — no blobs) | `{ nodeId, templateRef, kind, at, lineId, preview?, metrics, thumbUrl?, state }` |
| `dcw:write` | after a write-control ACK is booked (with 10 s same-value de-duplication) | `{ nodeId, name, eng, prevValue, ok, source, lineId, at }`; `source ∈ manual \| recipe \| agent \| rollback` |
| `line:start` | batch window opens | `{ lineId, runId, recipeId, productName }` |
| `line:stop` | batch window closes | `{ lineId, runId }` |
| `event:<scene-type>` | any `broadcastSceneEvent(type, payload)`, exactly the same source as the browser WS feed | the event's own payload |

### Wildcards and scene events

The server wildcard spelling is the **bare star `'*'`**, and the callback receives a `{ type, payload }` wrapper:

```js
ctx.hooks.on('*', ({ type, payload }) => {
  ctx.logger.debug('event audit', type)
  void payload
})
```

`ctx.hooks.on('event:*', fn)` is **wrong** — it never fires. To subscribe to scene events by type, use `ctx.events`, which adds the `event:` prefix for you:

```js
ctx.events.on('daq.node.changed', (p) => ctx.logger.debug('node changed', p?.op))
ctx.events.on('daq.alarm.changed', (p) => ctx.logger.info('alarm state', p?.nodeId, p?.recovered))
```

Common scene events: `daq.reading`, `daq.frame`, `daq.alarm`, `daq.alarm.changed`, `daq.node.changed`, `daq.controller`, `daq.template.changed`, `dcw.node.changed`, `device.created|updated|deleted`, `ops.log`, `permissions.changed`, `plugins.reloaded`, `aml.job|dataset|model`.

### Permission changes

Permission changes reach the plugin bus as the scene event `permissions.changed` (its raw bus name is `event:permissions.changed`). `ctx.hooks.on('permissions:changed', …)` **never fires**; the correct form is:

```js
ctx.events.on('permissions.changed', (p) => ctx.logger.info('grants changed', p?.userId))
```

### Config changes

```js
ctx.hooks.on('config:changed', (p) => {
  ctx.logger.info('config changed', p.changed)
  ctx.logger.info('current theme colour', ctx.config.get('theme.primaryColor'))
})
// sugar: ctx.config.onChange(fn)
```

## 8. Browser `client.mjs` (`ctx` reference)

The client entry must be **declared in the manifest** as `client: './client.mjs'` — merely having the file is not enough. The loader fetches the script from `/api/plugins/client/<plugin>` and calls `setup(ctx)` on the imported module.

```js
export function setup(ctx) {
  let samples = 0
  const counter = ctx.el('strong', {}, ['0'])

  // scene event: pass the event name itself; the literal 'event:*' subscribes to all scene events
  ctx.on('daq.reading', () => { samples += 1; counter.textContent = String(samples) })

  // lifecycle hooks only come through ctx.hooks.on (they are not on the ctx.on surface)
  ctx.hooks.on('i18n:changed', ({ locale }) => ctx.log.info('locale switched:', locale))

  ctx.ui.registerPanel({
    slot: 'plugins.page',       // slot name (see below)
    name: 'my-panel',           // unique within the plugin
    titleKey: 'panel.title',    // resolves plugin.my-plugin.panel.title (or use a static title)
    order: 10,
    mount(el) {                 // el = panel container (the slot renders the title)
      const box = ctx.el('div', {}, ['samples:', counter])
      el.append(box)
      const timer = setInterval(() => { counter.textContent = String(samples) }, 5000)
      return () => { clearInterval(timer); box.remove() }   // cleanup: called when the panel unmounts
    },
  })

  ctx.log.info('client injected')
}
```

| Member | Notes |
|---|---|
| `ctx.name` / `ctx.sdkVersion` | plugin name / client SDK version |
| `ctx.hooks` | a real HookBus: `client:init` / `page:change` / `i18n:changed` / `client:destroy` |
| `ctx.on(type, fn)` | scene-event subscription (pass the event name; internally `event:<type>`); only the literal `'event:*'` is a wildcard; returns an unsubscribe function |
| `ctx.fetch(path, opt)` | same-origin platform API helper (adds the cookie token, unwraps the `{code,data}` envelope, throws on non-2xx) |
| `ctx.el(tag, attrs, children)` | DOM helper; `style` goes through `cssText`, `class` through `className`, `onXxx` through `addEventListener` |
| `ctx.mount(target, node)` / `ctx.root()` | mount to a selector/element (falling back to `ctx.root()`) / the plugin's private mount point `#aw-plugin-<name>` |
| `ctx.ui.registerPanel(entry)` / `ctx.ui.slots` | register a panel into a named slot, returns an unregister function; `slots` lists the known slot names |
| `ctx.t(key, params?)` | plugin-namespaced translation (`plugin.<name>.<key>`) |
| `ctx.locale` | current UI locale |
| `ctx.log.info / warn / error` | console with an `[aw-plugin:<name>]` prefix |
| `ctx.dispose()` | unload: emits `client:destroy` → collects subscriptions → removes `root()` (idempotent) |

### Wildcards and dead subscriptions (the common traps)

| Spelling | Result |
|---|---|
| `ctx.on('daq.reading', fn)` | correct: subscribes to the scene event `daq.reading` |
| `ctx.on('event:*', fn)` | correct: the only wildcard spelling, receives all scene events |
| `ctx.on('*', fn)` | **dead subscription**: never fires |
| `ctx.on('event:line.start', fn)` | **dead subscription**: it only subscribes to a scene event literally named `event:line.start`, which does not exist |
| `ctx.on('daq:sample', fn)` | **dead subscription**: server hooks never cross to the browser |
| `ctx.hooks.on('page:change', fn)` | correct: lifecycle hooks go through `ctx.hooks` |
| `ctx.on('client:init', fn)` | **dead subscription**: lifecycle hooks are not on the `ctx.on` surface |

Server hooks (`daq:sample`, `daq:frame`, `dcw:write`, `line:start|stop`) **never reach the browser**; the browser only receives scene events (through the TownBus/WS bridge). Conversely, `page:change` / `i18n:changed` exist on the browser side only.

### Panels and page slots

A host page embeds `<workshop-plugin-slot slot-name="…" />` wherever it should accept injection; `ctx.ui.slots` currently holds:

| Slot | Location |
|---|---|
| `plugins.page` | the plugin management page (the default drop point) |
| `settings.plugins` | Settings → Runtime, below the plugin management area |
| `dashboard.widgets` | the tail of the dashboard page |

`registerPanel` returns an `unregisterPanel` function; a panel's `mount(el)` may return a cleanup function (called when the panel unmounts) and may throw — a single panel's failure is isolated by the slot and never affects the other panels or the page.

### Unload semantics

- `ctx.dispose()` is triggered by the **`pagehide`** event (navigating away / entering bfcache; switching tabs does **not** trigger it). It emits `client:destroy`, collects the plugin's own subscriptions and removes `root()`.
- `ctx.dispose()` does **not** unregister panels by itself — panel cleanup happens in the loader, which calls `unregisterPlugin(name)` on disable / hot reload.
- Two hot channels back this up: the WS `plugins.reloaded` event (instant) plus a 15 s polling diff.

## 9. Routes and authentication

`ctx.route(method, path, handler)` registers immediately and returns a **boolean**; `routes[]` in the manifest is registered only after `setup` returns. Both end up in the same route table:

```
GET /api/plugins/<plugin>/health   ←  ctx.route('GET', '/health', handler)
                                   ←  routes: [{ method: 'GET', path: '/health', handler }]
```

- Matching is **exact**: paths are normalised with a leading `/`, and there are no wildcard segments or sub-route matching.
- The handler receives the h3 `event`; the JSON body has already been pre-read by the platform forwarding layer and attached as **`event.awBody`** (plugins do not import h3).
- The handler's return value is serialised to JSON by nitro; a throw becomes a 500 envelope (with plugin-attributed logging) and never leaks a raw stack.
- **Authentication is enforced declaratively** by the `auth` field, checked **before** your handler, for `routes[]` and `ctx.route()` alike:

| `auth` | Behaviour |
|---|---|
| `'none'` (default) | no check, the handler runs directly |
| `'user'` | requires a valid user token, otherwise 401 |
| `'admin'` | requires an administrator, otherwise 401 |
| `'agent-or-user'` | accepts an agent identity or a user token |

**Do not put authentication inside the handler**: `resolveUser(event)` is not importable from a plugin and is not on `ctx`. Declare `auth` instead.

```js
ctx.route('GET', '/report', () => ({ plugin: ctx.name, at: new Date().toISOString() }))

ctx.route('POST', '/threshold', (event) => {
  const v = Number(event.awBody?.threshold)   // the host pre-read the JSON body
  if (!Number.isFinite(v)) return { ok: false, error: 'threshold must be a number' }
  ctx.kv.set('threshold', v)
  return { ok: true, threshold: v }
})
```

## 10. Tools and team switches

Tools registered with `ctx.omp.registerTool(def)` appear on every harness tool surface (omp receives them over RPC `set_host_tools`, other engines through the MCP bridge `tools/list`, pi through a tool file, mock through a direct REST invoke). A registry change is **re-pushed** to running sessions — no restart, no sub-process respawn.

```js
ctx.omp.registerTool({
  name: 'sensor_log',
  label: 'Sensor calibration',
  description: 'Read or record sensor calibration conclusions',
  parameters: { type: 'object', properties: { sensor: { type: 'string' } }, required: ['sensor'] },
  roles: ['lead', 'worker'],          // only these two literals; omitted = both roles
  handler: async (args, agent) => ({ text: `${agent.role}@${agent.channelId}: ${args.sensor}` }),
})
```

Never open a `url` / `host` injection hole in the parameter schema — plugin tool arguments come straight from the model, so any "let the model pick the target address" field becomes an SSRF surface.

### Team / channel scoped switches

Beyond the global switch, every team (channel) keeps its own plugin switch set backed by the `channel_plugins` table:

- **Picked at team creation**: `POST /api/workshop/teams` accepts `plugins: [{ name, enabled }]`, stored under the team id and propagated to the channel on deploy;
- **Toggled at any time**: `GET|PUT /api/workshop/channels/:id/plugins` and `GET|PUT /api/workshop/teams/:id/plugins` (body `{ plugins: [{ name, enabled }] }`, full-replacement semantics, unknown or disabled plugin names are ignored);
- **Semantics**: no explicit rows = unconfigured → every enabled plugin is visible to that team (backward compatible); once rows exist they filter — **a disabled plugin's tools are not injected into that team's agents and dispatch rejects them at the source**;
- **UI**: the workshop teams page (creation checkboxes + team dialog).

## 11. Complete example

```js
// index.mjs — server entry (zero import dependencies; the host injects ctx)
export default {
  name: 'my-plugin',
  version: '1.0.0',
  description: 'Example: over-threshold counting + own API + config groups + agent tool',
  auth: 'user',
  client: './client.mjs',
  configGroups: [
    { id: 'default', label: 'My plugin', description: 'Basic configuration', order: 500 },
    { id: 'advanced', label: 'Advanced', collapsed: true },
  ],
  settings: [
    { key: 'threshold', type: 'number', default: 180, min: 0, max: 5000, group: 'default',
      label: 'Alarm threshold', description: 'applies live on save' },
    { key: 'endpoint', type: 'string', default: 'http://127.0.0.1:8080', group: 'advanced',
      label: 'External service URL' },
  ],
  routes: [
    { method: 'GET', path: '/health', handler: () => ({ ok: true }) },
  ],

  async setup(ctx) {
    ctx.logger.info(`loaded (scope=${ctx.scope}, sdk=${ctx.sdkVersion})`)

    const threshold = () => Number(ctx.config.get('plugins.my-plugin.threshold')) || 180

    // 1) publish-level DAQ samples: count over-threshold hits in plugin-private KV
    ctx.hooks.on('daq:sample', (s) => {
      if (typeof s?.value === 'number' && s.value > threshold())
        ctx.kv.bump(`alarm:${s.nodeId}`)
    })

    // 2) scene events (ctx.events adds the event: prefix for you)
    ctx.events.on('daq.alarm', (a) => ctx.logger.warn('alarm', a?.nodeId))
    ctx.events.on('permissions.changed', (p) => ctx.logger.info('grants changed', p?.userId))

    // 3) full event audit: the server wildcard is the bare '*', callback gets { type, payload }
    ctx.hooks.on('*', ({ type }) => ctx.logger.debug('event', type))

    // 4) routes[] are registered after setup; ctx.route registers now (returns a boolean)
    ctx.route('POST', '/threshold', (event) => {
      const v = Number(event.awBody?.threshold)
      if (!Number.isFinite(v)) return { ok: false, error: 'threshold must be a number' }
      ctx.kv.set('threshold', v)
      return { ok: true, threshold: v }
    })

    // 5) timers + cleanup: one host-owned dispose queue, run on shutdown and hot reload
    ctx.timer.setInterval(() => ctx.kv.set('heartbeat', new Date().toISOString()), 5000)
    ctx.onDispose(() => ctx.logger.info('plugin cleaned up'))

    // 6) agent tool (roles accepts 'lead' | 'worker' only)
    ctx.omp.registerTool({
      name: 'my_alarm_report',
      description: 'Read the over-threshold alarm counter recorded by this plugin',
      parameters: { type: 'object', properties: { nodeId: { type: 'string' } }, required: ['nodeId'] },
      roles: ['lead', 'worker'],
      handler: async (args, agent) => ({
        text: `${args.nodeId} alarmed ${ctx.kv.get(`alarm:${args.nodeId}`) ?? 0} times (by ${agent.role})`,
      }),
    })
  },
}
```

`client.mjs` is in §8 and `i18n.json` in §5. Which scope to install into and how to toggle are in §1.

## 12. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Plugin code edits have no effect | the host has no plugin-directory watcher: touch `<home>/plugins-state.json`, or toggle `aw plugin enable/disable` once, to trigger a reload (the reload imports with `?t=` to defeat the cache); core `server/` and `shared/` changes still need a process restart |
| Load failures are invisible | `aw plugin list` does **not** show them. Use `GET /api/workshop/plugins` (returns `{ plugins, failures, initedAt }`, **no `{code,data}` envelope**) or read `[aw-plugins] 装载失败 …` in the startup log |
| Plugin route 404 | matching is exact; check the method and the leading `/` of the path, and whether the plugin is enabled (a disabled plugin's routes are dropped from the table) |
| Plugin route 401 | the entry declared `auth: 'user' \| 'admin' \| 'agent-or-user'` and the request carried no valid credential; use `auth: 'none'` only for open endpoints |
| Client panel never appears | check the browser console for `[aw-plugins]` warnings; confirm the manifest says `hasClient: true` (i.e. the manifest declares `client:'./client.mjs'`) and the plugin is `enabled !== false` |
| A client subscription never fires | check you did not fall into the §8 traps (`ctx.on('*')`, `ctx.on('event:line.start')`, `ctx.on('daq:sample')`, or handing a lifecycle hook to `ctx.on`) |
| A setting does not render | a declaration without `default` is skipped with a warning; a `select`'s `default` must be inside `options`; `key` allows letters, digits, `-` and `_` only |
| A changed setting has no effect | read it as `ctx.config.get('plugins.<plugin>.<key>')` (the short key reads nothing) |
| The `permissions:changed` hook never fires | that name does not exist; use `ctx.events.on('permissions.changed', fn)` |
| KV data "disappeared" | KV is at `<configRoot>/data/plugins/<plugin>/kv.json`, not in the plugin folder; writes flush after a 200 ms debounce, so a hard kill has a tiny loss window |
| `ctx.api` returns 401 | authenticated endpoints need `ctx.api.setToken(token)`; unauthenticated ones (manifest / ping) do not |

**Trust model**: a plugin is arbitrary node code, on par with aw commands — only install and enable plugins you trust.

### Known boundaries (intentional, not defects)

- **Hooks are observational**: v1 has no veto / interception / rewriting — write-control interlock integrity comes first.
- **The `ctx.http` guard is protocol-only** (http/https) and does **not** restrict hosts; do your own allow-listing inside the plugin (the built-in `diag-bridge` / `rag-bridge` do exactly that).
- **`ctx.t(key, params)` currently ignores `params`** (no interpolation); build strings yourself inside the plugin.
- **`ctx.kv` has no `reset()`** — only `get / set / all / bump`.
- **Server and browser subscription surfaces do not overlap**: server hooks never cross the bridge, and browser events never reach the server.
- **A newly enabled browser plugin injects within 15 s** (instantly when the WS channel is up).
- **`server:close` / `onDispose` depend on graceful shutdown signals**; a forced kill on Windows does not trigger them.
- **`aw plugin list` only scans directories** — it reflects neither load failures nor runtime health.

## 13. Pre-release checklist

1. `aw plugin list` shows the plugin in all applicable scopes; a client plugin shows `+client`; toggling enable/disable makes routes, tools and panels appear and disappear together (a rapid toggle burst must not lose events).
2. `GET /api/workshop/plugins` reports an empty `failures`; `GET /api/plugins/manifest` reports `settingsCount` / `hasClient` / `hasI18n` matching the declaration.
3. The settings page shows the plugin's config group (fields without a declared group land in the `plugin-<plugin>` group); after a save, `ctx.config.get('plugins.<plugin>.<key>')` returns the new value immediately.
4. Locale switching updates panel titles and copy; the `i18n:changed` cleanup leaves no leaks.
5. The tool is visible through `GET /api/workshop/agent-tools/list`; its parameters expose no `url` / `host` injection hole; after the team switch is turned off the tool disappears and dispatch is rejected.
6. Trigger one hot reload (toggle enable/disable) and confirm `plugins:reloaded` reaches the plugin with no KV or timer leak.
