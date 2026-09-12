# AgentWorkShop SDK Development and Usage Guide

> The SDK is AgentWorkShop's **programming client and extension base**: external projects
> consume the platform REST surface through it, and plugins receive the host-injected
> runtime context through it (hooks / config / storage / timers / platform API / event stream).
> Zero third-party runtime dependencies; works on Node ≥ 23.4 and modern browsers.

**SDK version constants**: server-side `SDK_VERSION = '0.3.0'`, browser-side `CLIENT_SDK_VERSION = '0.3.0'`.
These two constants are the **interface version of the SDK itself** and evolve **independently**
from the npm package version (the `version` field in `package.json`, currently 0.7.37) —
them being out of sync is expected. Never use `SDK_VERSION` to infer the package version, or the reverse.
**Module format**: ESM only (only `import` / `export`; there is no CJS entry).
**Types**: `sdk/index.d.mts` and `sdk/client.d.mts` ship with the package, so TypeScript projects
get IntelliSense with zero configuration (coverage is described in §7).

---

## 1. Getting the SDK

### 1.1 Global install (includes the CLI and the platform itself)

```bash
npm install -g agentworkshop
```

The SDK lives inside the global package at `$(npm prefix -g)/node_modules/agentworkshop/sdk/`.
Plugins **need not and should not** import it directly (see the host-injection model in §2);
it serves two audiences:

- **External integration**: embed AgentWorkShop's line / DAQ / write-control / device-twin
  capabilities into your own node service;
- **Plugin development** (TypeScript): import types only for full IntelliSense — the runtime
  is injected by the host.

### 1.2 Project dependency (recommended for integrators)

```bash
npm install agentworkshop        # as a dependency (full SDK and types)
```

### 1.3 Import paths

`package.json` exposes exactly four `exports` entries:

| Import | Resolves to | Contents |
|---|---|---|
| `agentworkshop` | `sdk/index.mjs` | **Exactly the same facade** as `agentworkshop/sdk` (the root specifier was previously undocumented; it works) |
| `agentworkshop/sdk` | `sdk/index.mjs` | The whole facade (server + browser + platform REST client + types) |
| `agentworkshop/sdk/client` | `sdk/client.mjs` | Browser only (`createClientContext`) |
| `agentworkshop/package.json` | `package.json` | Package metadata |

**Deep paths are not importable**: paths such as `agentworkshop/sdk/api.mjs` or
`agentworkshop/sdk/hooks.mjs` do not appear in `exports`, and Node throws
`ERR_PACKAGE_PATH_NOT_EXPORTED`. Take every symbol from one of the three entry points above.

```js
import { createPlatformClient, definePlugin, HookBus } from 'agentworkshop/sdk'
import { createClientContext } from 'agentworkshop/sdk/client'   // browser only
```

### 1.4 Named export list

| Entry | Named exports |
|---|---|
| `agentworkshop/sdk` (equivalent to `agentworkshop`) | `SDK_VERSION`, `definePlugin`, `createPluginContext`, `createRouteTable`, `validatePluginModule`, `validatePluginSettings`, `validatePluginGroups`, `resolvePluginGroupId`, `pluginKvExists`, `isPathInside`, `HookBus`, `createPlatformClient`, `CLIENT_SDK_VERSION`, `createClientContext`, `LIFECYCLE_EVENTS`, `CLIENT_EVENTS` |
| `agentworkshop/sdk/client` | `CLIENT_SDK_VERSION`, `createClientContext` |

### 1.5 The remaining named exports

Plugin authors normally work with the host-injected `ctx` (§4); the symbols below serve host
assembly, scaffolding and validation tooling.

| Symbol | Signature | Purpose |
|---|---|---|
| `createPluginContext(opts)` | `opts` is the host assembly object | Called by the host to build `ctx`; plugin authors never call it themselves |
| `createRouteTable()` | → `{ register, resolve, byPlugin, unregisterPlugin, size }` | Host route table: exact match, mounted at `/api/plugins/<name><path>` |
| `definePlugin(def)` | `def` → `def` | Type sugar plus shape validation; throws on an invalid definition. The host also accepts a bare object export |
| `validatePluginModule(mod, source)` | → `{ ok, def?, error? }` | Pre-load entry check (`name` required, `setup` must be a function, `client` must be a string, `settings` must be an array) |
| `validatePluginSettings(pluginName, defs)` | → `{ descriptors, errors }` | Validate and normalize setting declarations; rules in §4.9 |
| `validatePluginGroups(pluginName, defs)` | → `{ groups, errors }` | Validate and normalize config-group declarations |
| `resolvePluginGroupId(pluginName, declaredId)` | → `string` | Fold a declared group name into the `plugin-<name>[-<suffix>]` namespace |
| `pluginKvExists(dataDir, name)` | → `boolean` | Probe whether `<dataDir>/plugins/<name>/kv.json` exists |
| `isPathInside(dir, p)` | → `boolean` | Path containment test (uses `relative()`, so a sibling directory with the same prefix such as `…/foo-evil` cannot fool it) |
| `HookBus` | `class` | The hook bus implementation; the host owns one shared instance and plugins receive a scoped facade (§4.1) |
| `LIFECYCLE_EVENTS` | frozen array (11 items) | Authoritative server-side event list (§5) |
| `CLIENT_EVENTS` | frozen array (5 items) | Authoritative browser-side event list (§5) |

---

## 2. Core model: two identities, one SDK

| Identity | Form | Role of the SDK |
|---|---|---|
| **External integrator** | regular dependency | call `createPlatformClient()` to consume the platform REST surface |
| **Plugin author** | exports `{ name, setup(ctx) }` | `ctx` is the host-injected SDK context — **zero imports**, the SDK runtime is provided by the host |

> Why don't plugins import the SDK directly? Globally installed plugin directories
> (`~/.AgentWorkShop/plugins/`) are outside the node_modules resolution chain, so host
> injection is the only zero-pitfall shape (the same paradigm as VSCode's `activate(context)`).

A plugin entry is an ordinary ESM module:

```js
export default {
  name: 'my-plugin',
  version: '1.0.0',
  description: 'Example plugin',
  auth: 'none',              // declarative auth for plugin routes, see §4.4
  client: './client.mjs',    // browser entry (optional), see §6
  async setup(ctx) {
    ctx.logger.info('loaded, directory:', ctx.dir)
  },
}
```

---

## 3. Platform REST client `createPlatformClient`

The SDK fronts the platform as a "project service client": it attaches the Bearer token,
unwraps the unified envelope `{ code, message, data } → data`, and throws according to the
rules below.

### 3.1 Creating a client

```js
import { createPlatformClient } from 'agentworkshop/sdk'

const api = createPlatformClient({
  baseUrl: 'http://127.0.0.1:3001',  // defaults to '' (same-origin relative); integrators pass the platform address
  token: '<bearer-token>',            // optional; api.setToken() swaps it later
  timeoutMs: 10_000,                  // optional; per-request timeout (AbortSignal), default 10 000
  logger,                             // optional; warns when a request fails
})
```

- `baseUrl` defaults to `''`, i.e. same-origin relative paths; it **may also be a function**
  evaluated lazily on every request (the host's listening port is only known once the server
  actually listens, so the host passes `() => origin`).
- A trailing `/` is stripped: `'http://host:3001/'` and `'http://host:3001'` are equivalent.

### 3.2 Envelope and error semantics (three paths — do not mix them up)

| Case | Behaviour |
|---|---|
| HTTP non-2xx | throws an `Error` carrying **only `err.status` and `err.body`**; this path **does not set `err.code`** |
| HTTP 200 but envelope `code !== 0` | throws an `Error` carrying `err.status`, `err.code` **and** `err.body` |
| Success | returns the unwrapped `data`; a body with no `code`/`data` envelope is returned **as-is** (for example `GET /api/workshop/plugins`, `GET /api/plugins/manifest`) |

```js
try {
  await api.daqNodes.get('no-such-node')
}
catch (err) {
  err.status   // 404
  err.body     // { code: 'NOT_FOUND', message: '…', data: null }
  err.code     // undefined —— this path does not set code
}
```

> On the platform side `defineApiHandler` sets a non-2xx status for business errors, so in
> practice you almost always hit the first path. The second path is a defensive check inside
> the SDK (`sdk/api.mjs` inspects `code` before unwrapping) aimed at endpoints that do not go
> through the unified wrapper yet still return an error envelope under HTTP 200 — without that
> check a plugin would unwrap the error envelope to `null` and treat it as success.

### 3.3 Generic calls (any platform path)

| Method | Signature | Notes |
|---|---|---|
| `api.call(method, path, body?, opt?)` | low level | `opt` may carry `{ timeoutMs, headers }`; returns the unwrapped `data` |
| `api.get(path, query?)` | query object serialized automatically | `api.get('/api/workshop/dcw', { page: 1 })` |
| `api.post(path, body?)` | JSON-serialized | |
| `api.patch(path, body?)` | | |
| `api.delete(path)` | | |
| `api.setToken(token)` | chainable, returns `api` | `api.setToken(res.token)` after login; pass `null` to clear |
| `api.ping()` | `GET /api/plugins/manifest` | liveness probe (unauthenticated) |

`toQuery` **drops `undefined`, `null` and empty-string** values, so
`api.get('/x', { lineId: undefined })` never produces `?lineId=undefined`.

### 3.4 Resource surfaces and their real base paths

Every resource is built by the internal `resource(root)` helper, so **all of them expose five
methods**: `list(query?)`, `get(id)`, `create(body)`, `update(id, patch)`, `remove(id)`.
"A method exists" does not mean "the server route exists" — real availability is in §3.5.

| Namespace | Base path | Extra methods |
|---|---|---|
| `api.users` | `/api/users` | `login(email, password)` → `{ user, token }`; `me()` |
| `api.lines` | `/api/workshop/dcw/lines` | `start(id, recipeId = '')`; `stop(id)` |
| `api.products` | `/api/workshop/dcw/products` | — |
| `api.recipes` | `/api/workshop/dcw/recipes` | — |
| `api.dcwNodes` | `/api/workshop/dcw` | — |
| `api.daqNodes` | `/api/workshop/daq` | `alarms()` → `GET /api/workshop/daq/alarms` |
| `api.templates` | — | `daq()` / `dcw()`: read `.templates` off the two list responses |
| `api.twins` | `/api/workshop/device-twins` | — |
| `api.teams` | `/api/workshop/teams` | — |
| `api.agents` | `/api/workshop/agents` | — |
| `api.channels` | `/api/workshop/channels` | — |
| `api.permissions` | — | `overview()` → `GET /api/workshop/permissions`; `set({ userId, grants })` → `PUT /api/workshop/permissions` (admin) |
| `api.plugins` | — | `manifest()` |

The payload shape for `api.permissions.set`:

```json
{ "userId": "<user id>", "grants": [{ "lineId": "<line id>", "mode": "readonly" }] }
```

`mode` is `'readonly'`, `'operate'` or `null` (passing `null` revokes that grant).

### 3.5 Real route support

`resource(root)` always generates five methods, but only some server route files exist.
**The table below is the result of checking every route file**: "no" means the call targets a
path that does not exist and therefore 404s.

| Namespace | `list` | `get(id)` | `create` | `update(id)` | `remove(id)` | Notes |
|---|---|---|---|---|---|---|
| `users` | yes | yes | yes | **no** | yes | The server only has `PUT /api/users/:id`, while `update()` sends `PATCH`; to update a user call `api.call('PUT', '/api/users/' + id, patch)` directly. `list`/`get`/`create` all require admin |
| `lines` | yes | no | yes | yes | yes | Plus `start` / `stop`. `create` requires the `admin` or `editor` role |
| `products` | **no** | no | yes | yes | yes | There is no `GET /api/workshop/dcw/products`; read the product list from `.products` of `GET /api/workshop/dcw` (see §3.6) |
| `recipes` | yes | no | yes | yes | yes | `list()` returns `{ recipes, runs }`; there is no route for `recipes.get(id)` |
| `dcwNodes` | yes | no | yes | yes | yes | No `[id].get.ts`; read the node list from `.nodes` of `GET /api/workshop/dcw` |
| `daqNodes` | yes | no | yes | yes | yes | No `[id].get.ts`; `alarms()` works |
| `twins` | yes | no | yes | yes | yes | No `[id].get.ts` |
| `teams` | yes | yes | yes | yes | yes | Full CRUD |
| `agents` | yes | yes | yes | yes | yes | Full CRUD |
| `channels` | yes | yes | yes | yes | yes | Full CRUD |
| `permissions` | `overview()` only | — | — | — | — | No five-method `resource()`; only `overview()` and `set()` |
| `plugins` | `manifest()` only | — | — | — | — | Unauthenticated |

Authentication and timeouts:

- Business read endpoints such as `api.lines.list()`, `api.daqNodes.list()` and
  `api.dcwNodes.list()` go through platform auth and need a user token (`api.setToken(...)`,
  or the cookie in a browser);
- `api.plugins.manifest()` and `api.ping()` are unauthenticated — the only two endpoints you
  can call without a token.

### 3.6 Response shapes at a glance

**A list does not necessarily return an array** — this is the easiest trap in the whole SDK.
Every row below was checked against the server handler.

| Call | Real response |
|---|---|
| `api.lines.list()` | `{ lines, states }` (**not an array**) |
| `api.daqNodes.list()` | `{ controller, nodes, meta, driverAvailable, infra, templates }` |
| `api.dcwNodes.list()` | a multi-key object (`controller` / `nodes` / `templates` / `recipes` / `runs` / `history` / `products` / `lines` …), **not a node array** |
| `api.recipes.list()` | `{ recipes, runs }` |
| `api.twins.list()` | `{ twins }` |
| `api.daqNodes.alarms()` | `{ alarms }` |
| `api.permissions.overview()` | `{ lines, users }` |
| `api.templates.daq()` / `api.templates.dcw()` | an array (`.templates ?? []`) |
| `api.teams.list()` / `api.agents.list()` / `api.channels.list()` | an array |
| `api.users.list()` | `{ items, total, page, pageSize }` |
| `api.plugins.manifest()` | `{ plugins }` (no envelope, returned as-is) |
| `api.lines.create(body)` | `{ line }` |
| `api.recipes.create(body)` | `{ recipe }` |
| `api.products.create(body)` | `{ product }` |
| `api.dcwNodes.create(body)` / `api.daqNodes.create(body)` | `{ node }` |
| `api.twins.create(body)` | `{ twin }` |
| `api.lines.start(id, recipeId)` | `{ run, line }` |
| `api.users.login(email, password)` | `{ user, token }` |

About `api.daqNodes.list({ lineId })`: the `{ lineId }` query argument **is not read by that
handler**. Line filtering happens server-side from the caller's permissions (a regular user
only sees nodes of granted lines). Do not present it as a working client-side filter.

About `api.lines.start(id, recipeId)`: `recipeId` defaults to an empty string, but the server
**requires a recipe that actually exists** (an empty string or an unknown id yields
404 `Recipe 不存在`). When a line has recipes, `recipeId` is effectively mandatory.

### 3.7 Full example: external integration

```js
import { createPlatformClient } from 'agentworkshop/sdk'

const api = createPlatformClient({ baseUrl: 'http://plant.local:3001' })

const { token } = await api.users.login('you@example.com', 'secret')
api.setToken(token)

// 1) Line list: { lines, states } —— not an array
const { lines, states } = await api.lines.list()
console.log(`${lines.length} lines`)
for (const l of lines) {
  console.log(`  ${l.name} → ${states.find(s => s.lineId === l.id)?.state ?? 'unknown'}`)
}

// 2) DAQ surface: { controller, nodes, meta, driverAvailable, infra, templates }
const { nodes } = await api.daqNodes.list()
console.log(`${nodes.length} DAQ nodes, ${nodes.filter(n => n.state === 'offline').length} offline`)

// 3) Write-control surface: the node list is an object too; products come from .products
const dcw = await api.dcwNodes.list()
console.log(`${dcw.nodes.length} DCW nodes, ${dcw.products.length} products`)

// 4) Recipe surface: { recipes, runs }
const { recipes } = await api.recipes.list()

// 5) Starting a line: recipeId must be a real recipe of that line (an empty string is rejected)
const line = lines[0]
const recipe = recipes.find(r => r.lineId === line?.id)
if (line && recipe) {
  await api.lines.start(line.id, recipe.id)
  await api.lines.stop(line.id)
}

// 6) Line grants (admin): overview() reads everything, set() writes in bulk
const { users } = await api.permissions.overview()
const target = users[0]
if (target && line) {
  await api.permissions.set({ userId: target.id, grants: [{ lineId: line.id, mode: 'readonly' }] })
}
```

---

## 4. Plugin context `ctx` (the complete member surface)

The `ctx` handed to `setup(ctx)` is the host-assembled SDK runtime. **The table below is the
complete surface**; the last three rows (`ctx.daq` / `ctx.omp` / `ctx.services`) are attached
directly by the plugin host before `setup` runs and are not part of `sdk/context.mjs`.

| Group | Member | Type | Notes |
|---|---|---|---|
| Identity | `ctx.name` | `string` | plugin name (= directory name / declared name) |
| | `ctx.scope` | `'builtin' \| 'project' \| 'user'` | load scope; on a name clash the priority is builtin > project > user |
| | `ctx.dir` | `string` | absolute path of the plugin directory |
| | `ctx.sdkVersion` | `string` | SDK interface version (= `SDK_VERSION`) |
| Hooks | `ctx.hooks` | `{ on, once, off, emit }` | per-plugin scoped hook facade (§4.1); **not a `HookBus` instance and has no `.size`** |
| Logging | `ctx.logger` | `{ debug, info, warn, error }` | output is prefixed `[aw-plugins] [<plugin name>]` |
| Config | `ctx.config.get(key)` | any | effective value (after the four-layer merge) |
| | `ctx.config.all()` | `Record<string, any>` | shallow copy of every effective setting |
| | `ctx.config.onChange(fn)` | unsubscribe function | subscribes to `config:changed` (§4.5) |
| | `ctx.config.defineGroup(def)` | group object \| `null` | declare a plugin-owned config group (§4.9) |
| | `ctx.config.defineField(decl)` | descriptor \| `null` | declare a setting field (key auto-addressed as `plugins.<name>.<key>`) |
| | `ctx.config.removeGroup(id)` | `boolean` | remove a group declaration |
| | `ctx.config.removeField(key)` | `boolean` | remove a field declaration |
| | `ctx.config.groups()` / `fields()` | arrays | the groups / fields this plugin currently has registered (read-only snapshot) |
| Paths | `ctx.paths` | `{ home, configRoot, dataDir }` | config-root information (home mode = `~/.AgentWorkShop`) |
| | `ctx.dataDir` | `string` | this plugin's private data directory = `<paths.dataDir>/plugins/<name>` |
| Storage | `ctx.kv` | `{ get, set, all, bump }` | plugin-private KV (§4.2); **there is no `reset()`** |
| Timers | `ctx.timer.setInterval(fn, ms)` / `setTimeout(fn, ms)` | timer id | auto `unref` + auto-collected on shutdown / hot reload (§4.3) |
| Cleanup | `ctx.onDispose(fn)` | the `fn` you passed | register a cleanup callback (§4.3) |
| | `ctx.subscriptions.add(d)` | the `d` you passed | register a `{ dispose() }` object or a function; same collection queue as `onDispose` |
| Routes | `ctx.route(method, path, handler)` | `boolean` | mounts at `/api/plugins/<name><path>`; auth is declared by the plugin's `auth` field (§4.4) |
| Platform | `ctx.api` | `PlatformClient` | loopback REST client (**no token by default**; §4.6) |
| Network | `ctx.http.get(url, opts)` / `post(url, body, opts)` | `Promise<Response>` | outbound requests; the guard is protocol-only; 8 s default timeout (§4.6) |
| Events | `ctx.events.on(type, fn)` / `off(type, fn)` | unsubscribe function | live scene event subscription; the `event:` prefix is added for you (§4.6) |
| Line permissions (host-injected) | `ctx.permissions` | see §4.7 | query and manage the per-user, per-line three-state grants |
| DAQ extension (host-injected) | `ctx.daq` | see §4.8 | driver / processor / template registration + frame subscription + time-series queries |
| Agent tools (host-injected) | `ctx.omp.registerTool(tool)` | see §4.8 | hot-inject a custom host tool at runtime |
| Runtime services (host-injected) | `ctx.services` | see §4.8 | lazy service access + cross-plugin service provision |

`ctx` has **no** `ctx.routes`, `ctx.dcw`, `ctx.scene` or `ctx.version`: route registration is
the singular `ctx.route()`; write-control traffic is observed through the `dcw:write` hook;
scene events go through `ctx.events`.

### 4.1 `ctx.hooks` — the hook facade

The host owns one shared `HookBus` named `aw-plugins`; a plugin receives a **scoped facade
exposing only `on` / `once` / `off` / `emit`**. Listeners registered through it are tracked and
auto-unbound when the plugin hot-reloads (the one cleanup path that always worked).
The facade exposes no diagnostic properties such as `count` / `size` / `listeners`.

```js
function onSample(sample) {
  ctx.kv.bump('samples')
}

const off = ctx.hooks.on('daq:sample', onSample)   // returns an unsubscribe function
ctx.hooks.once('server:close', () => { /* teardown, fires once */ })
ctx.hooks.off('daq:sample', onSample)              // manual unbind: pass the original handler
off()                                              // or just call the function returned by on()

await ctx.hooks.emit('my-plugin:custom', { hello: 1 })   // inter-plugin messaging: other plugins can listen
ctx.hooks.on('*', ({ type, payload }) => { /* every event */ })
```

Semantics (matching `sdk/hooks.mjs`):

- **Async-serial**: listeners of one type run in registration order and are awaited; the next
  one does not start until the previous returns;
- **Error isolation**: one throwing listener is only counted and warned about; siblings and the
  main service are unaffected;
- **Circuit breaker**: a listener failing **8 times in a row** is removed automatically;
  **any single success resets the counter**, so occasional failures never accumulate into an eviction;
- **Wildcard**: the only server-side wildcard spelling is the bare `'*'`; its callback receives
  `{ type, payload }` and runs after the named listeners;
- **The return value is fan-out, not a waterfall**: every listener receives **the same unmodified
  payload**; `emit()` merely returns "the last non-`undefined` return value" — values are never
  threaded from one listener to the next;
- **v1 is observation-only**: there is no veto / interception / rewriting.

> `ctx.hooks.on('event:*')` never fires. `event:*` is the subscription entry name the list uses
> for scene events; the real wildcard is the bare `'*'`, and the ergonomic scene-event form is
> `ctx.events.on('<type>', fn)` (§4.6).

### 4.2 `ctx.kv` — plugin-private persistence

```js
ctx.kv.set('threshold', 100)
ctx.kv.bump('samples')        // atomic increment, +1 by default; bump(key, by) sets the step
ctx.kv.bump('samples', 5)
ctx.kv.get('threshold')       // 100
ctx.kv.all()                  // { samples: 19453, threshold: 100, ... }
```

- **These four methods only**: `get` / `set` / `all` / `bump`. **No `reset()`, no `delete()`,
  no `keys()`**; to clear a key, `set` it explicitly or switch to a new key.
- On-disk location: `<ctx.dataDir>/kv.json`, i.e. `<paths.dataDir>/plugins/<name>/kv.json`.
- **In-memory state is authoritative + a 200 ms debounced atomic write** (temp file plus
  `rename`), so a high-frequency hook (`daq:sample`) and a low-frequency hook (`line:stop`)
  calling concurrently cannot race on read-modify-write.
- On shutdown / hot reload the pending debounce is **cancelled and flushed synchronously**, so a
  `set` from the last 200 ms before exit is not lost.
- Typical uses: counters, alarm state, threshold config, heartbeat timestamps.

### 4.3 `ctx.timer` / `ctx.onDispose` / `ctx.subscriptions`

```js
ctx.timer.setInterval(() => ctx.kv.set('heartbeat', Date.now()), 5000)
ctx.timer.setTimeout(() => ctx.logger.info('one-shot task'), 1000)

ctx.onDispose(() => ctx.logger.info('plugin cleanup done'))

// subscriptions.add accepts a { dispose() } object or a function; same queue as onDispose
const controller = new AbortController()
ctx.subscriptions.add({ dispose() { controller.abort() } })
```

- Timers created by `ctx.timer.setInterval/setTimeout` are automatically `unref`ed (they never
  hold the process open) and automatically registered with the collection queue, so **you never
  have to clear them by hand**.
- `ctx.onDispose(fn)` and `ctx.subscriptions.add(d)` (`d` may be `{ dispose() }` or a function)
  share **one host-owned collection queue** with the timers.
- That queue runs on **both server shutdown and plugin hot reload** — a guarantee this version of
  the SDK can make after the fix (`createPluginContext` previously failed to forward the host's
  `onDispose` injection point, leaking timers and losing the final kv write).

Server shutdown sequence:

```text
server shutdown (nitro close)
  └─ per-plugin dispose queue (each entry try/catch): clear timers, flush kv synchronously, unbind subscriptions…
      └─ broadcast server:close { at }
```

### 4.4 `ctx.route` — plugin API

```js
export default {
  name: 'my-plugin',
  auth: 'user',        // declarative auth: 'none' (default) | 'user' | 'admin' | 'agent-or-user'
  async setup(ctx) {
    // returns boolean: true = registration succeeded, false = handler is not a function
    const ok = ctx.route('GET', '/stats', () => ctx.kv.all())
    if (!ok) ctx.logger.warn('route registration failed')

    ctx.route('POST', '/threshold', (event) => {
      const body = event.awBody              // the JSON body the host already pre-read (may be undefined)
      const threshold = Number(body?.threshold)
      if (!Number.isFinite(threshold)) return { ok: false, error: 'threshold must be a number' }
      ctx.kv.set('threshold', threshold)
      return { ok: true, threshold }         // the return value is serialized to JSON by nitro
    })
  },
}
```

→ mounted at `GET /api/plugins/<plugin name>/stats` and
`POST /api/plugins/<plugin name>/threshold`.

- **The return value is `boolean`**: `false` when `handler` is not a function.
- **Paths** start with `/` (a missing one is added for you); the base is always
  `/api/plugins/<plugin name>`.
- **Auth is declarative — do not write your own**: give the plugin definition
  `auth: 'none' | 'user' | 'admin' | 'agent-or-user'` and the platform catch-all
  (`server/api/plugins/[name]/[...path].ts`) validates it **before** your handler runs,
  returning 401 on failure.
- **The handler cannot obtain a user object**: `resolveUser(event)` is not on `ctx` and cannot be
  imported from a plugin module. When you need an identity, combine the `auth` gate with
  `ctx.api.setToken(...)` and go through the platform API.
- **The JSON body is already pre-read** and attached as `event.awBody` (not h3's `readBody`).
- Handler errors are isolated: the platform logs with the plugin name and returns a 500 envelope
  (`插件路由处理失败(<plugin name>): <original message>`) without leaking a stack trace.

### 4.5 `ctx.config` — reading config and reacting to change

```js
ctx.config.get('plugins.my-plugin.threshold')   // effective value (after the four-layer merge)
ctx.config.all()                                // every effective setting (shallow copy)

const off = ctx.config.onChange((payload) => {  // payload: the config:changed payload, see §5
  ctx.logger.info('config changed:', payload?.changed)
})
```

`config:changed` is bridged onto the plugin bus from the platform settings service, and
`ctx.config.onChange(fn)` is essentially `ctx.hooks.on('config:changed', fn)`, so it is likewise
auto-unbound on hot reload.

### 4.6 `ctx.api` / `ctx.http` / `ctx.events` — which one to use

| Need | Use | Why |
|---|---|---|
| Read / write **platform business data** (lines, nodes, twins…) | `ctx.api` | auth / envelope / resource semantics out of the box |
| Call an **external system** (MES, webhook, mail gateway) | `ctx.http` | generic requests plus a protocol guard |
| React to the **live stream** (samples, alarms, start/stop) | `ctx.events` / `ctx.hooks.on` | in-process, zero HTTP overhead |

```js
// ctx.api: the loopback PlatformClient. baseUrl is resolved lazily by the host; no token by default.
const { token } = await ctx.api.users.login('user@example.com', 'secret')
ctx.api.setToken(token)                    // later loopback calls carry that token
const { lines } = await ctx.api.lines.list()

// ctx.http: outbound requests, protocol guard only (http/https), 8 s default timeout
const res = await ctx.http.get('https://mes.example.com/health', { timeoutMs: 3000 })
const payload = await ctx.http.post('https://mes.example.com/events', { lineId: 'L1' })

// ctx.events: scene events — pass the scene event name itself; the `event:` prefix is added for you
ctx.events.on('daq.reading', r => ctx.logger.info('sample', r.nodeId))
ctx.events.on('permissions.changed', ({ userId }) => ctx.logger.info('grants changed', userId))
ctx.events.on('device.created', d => ctx.logger.info('new device', d.id))
const off = ctx.events.on('daq.alarm', a => ctx.logger.warn('alarm', a.id))
off()
```

- `ctx.api` has **no token by default**: unauthenticated endpoints (`plugins.manifest` / `ping`)
  work immediately; anything else needs a login followed by `setToken`. If you only need
  in-process data, prefer `ctx.events` and `ctx.hooks` (no auth, no overhead).
- The `ctx.http` guard **checks the protocol only** and does not restrict hosts — the target
  address is the plugin's own responsibility.
- `ctx.events.on(type, fn)` / `off(type, fn)` install `event:<type>` underneath; to receive every
  scene event use `ctx.hooks.on('*', ({ type, payload }) => …)`.

### 4.7 `ctx.permissions` — per-user, per-line grants

| Method | Returns | Notes |
|---|---|---|
| `lineMode(user, lineId)` | `'none' \| 'readonly' \| 'operate'` | `user` is `{ id, role }`; admin/editor is always `operate` |
| `visibleLineIds(user)` | `Set<string> \| null` | `null` means unrestricted (admin/editor) |
| `listGrants(userId)` | `Array<{ lineId, mode, grantedBy, grantedAt }>` | read every grant of one user |
| `setGrants(userId, grants, grantedBy?)` | the grants after the write | `grants` looks like `[{ lineId, mode }]` with `mode` = `'readonly'` / `'operate'` / `null` |

```js
const userId = ctx.kv.get('watchUserId')          // a plugin gets userIds from event payloads or its own config
if (userId) {
  const mode = ctx.permissions.lineMode({ id: userId, role: 'user' }, 'line-1')
  const visible = ctx.permissions.visibleLineIds({ id: userId, role: 'user' })
  const grants = ctx.permissions.listGrants(userId)
  ctx.logger.info(`mode=${mode} visible=${visible ? visible.size : 'all'} grants=${grants.length}`)
}

// Change notification is the scene event permissions.changed, subscribed via ctx.events (prefix added for you)
ctx.events.on('permissions.changed', ({ userId }) => ctx.logger.info('grants changed:', userId))
```

### 4.8 Host-injected extensions `ctx.daq` / `ctx.omp` / `ctx.services`

**`ctx.daq`** — multi-modal DAQ extension (v0.6 frame pipeline):

| Method | Notes |
|---|---|
| `registerDriver({ kind, available, sample, test })` | register a custom driver |
| `registerProcessor(kind, name, fn)` | register a sink processor (after sampling, before storage) |
| `registerTemplate(def)` | register a DAQ node template (`key` / `signalKind` / `vector` / `sink` / `metrics`) |
| `onFrame(fn)` | frame subscription sugar (= `ctx.hooks.on('daq:frame', fn)`) |
| `onSample(fn)` | sample subscription sugar (= `ctx.hooks.on('daq:sample', fn)`) |
| `query({ nodeIds?, lineId?, from?, to?, bucketMs? })` | unauthenticated time-series query (straight to `queryTagged`) |
| `nodes()` | DAQ node metadata snapshot (including line ownership) |

```js
ctx.daq.registerProcessor('vector', 'my-derive', (frame) => {
  // frame = { kind: 'vector'|'image', points? | blob? (image producer side only), metrics }
  return { ...frame, metrics: { ...frame.metrics, myMetric: 1 } }
})
ctx.daq.onFrame(f => ctx.logger.debug('frame', f.nodeId, f.kind))
const rows = await ctx.daq.query({ nodeIds: ['n1'], from: Date.now() - 3600_000, to: Date.now(), bucketMs: 60_000 })
const all = await ctx.daq.nodes()
```

A template's `sink.processors` declares the sink pipeline; `metrics` declares derived-metric
thresholds whose breaches ride the platform's existing alarm chain. Vector / frame metadata lands
in Timescale `daq_frames`; image pixels land in object storage (the `daq:frame` payload
**carries no pixel blob**).

**`ctx.omp.registerTool({ name, label?, description, parameters, roles?, handler })`** —
register a custom host tool, hot-injected into every running agent session at runtime:

```js
ctx.omp.registerTool({
  name: 'sensor_log',
  label: 'Sensor calibration',
  description: 'Query or record sensor calibration conclusions',
  parameters: { type: 'object', properties: { sensor: { type: 'string' } }, required: ['sensor'] },
  roles: ['lead', 'worker'],                          // the only valid literals are 'lead' and 'worker'; default is both
  handler: async (args, agent) => ({ text: `recorded ${args.sensor}` }),   // agent = { agentId, channelId, role, name }
})
```

Registry changes are hot-injected into running sessions immediately (re-sending `set_host_tools`,
no respawn); a tool sharing a name with a built-in host tool is ignored.

**`ctx.services`** — the backend runtime object surface (lazy getters, cached after first access):

| Call | Resolves to |
|---|---|
| `ctx.services.names()` | every service name (including plugin-provided `<plugin>.<name>`) |
| `await ctx.services.get('daq')` | `{ query(q), nodes() }` |
| `await ctx.services.get('lines')` | `{ list(), byId(id) }` |
| `await ctx.services.get('channels')` | `{ list(), agents(channelId) }` |
| `await ctx.services.get('plugins')` | the plugin manifest **array** (note: not an object and with no `pluginManifest()`) |
| `ctx.services.provide(name, getter)` | provide a service, auto-prefixed with `<plugin>.` |

```js
const daq = await ctx.services.get('daq')
const lines = await ctx.services.get('lines')
const channels = await ctx.services.get('channels')
const plugins = await ctx.services.get('plugins')      // an array
ctx.services.provide('my-data', async () => ({ ready: true }))   // → 'my-plugin.my-data'
ctx.logger.info(ctx.services.names().join(', '))
```

An unknown name throws (the caller is expected to handle it). `provide` forces the
`<plugin>.` prefix so cross-plugin name clashes cannot happen.

### 4.9 Plugin setting declarations (`settings` / `configGroups`)

Two equivalent routes: the top-level `settings` array in the entry (declarative), or
`ctx.config.defineField` inside `setup` (conditional).

```js
export default {
  name: 'my-plugin',
  configGroups: [{ id: 'conn', label: 'Connection', collapsed: true }],
  settings: [
    { key: 'base_url', type: 'string', default: 'https://example.com', group: 'conn',
      labelKey: 'plugin.my-plugin.base_url', label: 'Service URL' },
  ],
  async setup(ctx) {
    // equivalent form: add declarations conditionally at runtime
    ctx.config.defineGroup({ id: 'sync', label: 'Sync' })
    ctx.config.defineField({ key: 'interval', type: 'number', default: 30, min: 1, max: 3600, group: 'sync' })
  },
}
```

Validation rules (an entry that fails **is skipped with a warning**; it never blocks loading):

| Rule | Detail |
|---|---|
| `key` | must match `[A-Za-z0-9_-]+`; addressed as `plugins.<plugin name>.<key>` |
| `type` | one of `'string'` / `'number'` / `'boolean'` / `'select'` |
| `default` | **required** — a declaration without `default` is skipped outright |
| `select` | must supply an `options` array, and `default` must appear among its stringified values |
| `min` / `max` | **apply to `number` only** |
| Group | an explicit `group` is folded into the `plugin-<name>[-<suffix>]` namespace; a field without `group` lands in the `plugin-<name>` group labelled with the plugin name |

Once declared, the settings are merged into the platform settings service: the "Plugins" section
of the settings page renders them automatically, PATCH validation uses the same source, and
saving takes effect immediately. Read values with the full key:
`ctx.config.get('plugins.my-plugin.base_url')`.

---

## 5. Lifecycle events

The authoritative lists are the SDK-exported `LIFECYCLE_EVENTS` (11 items) and
`CLIENT_EVENTS` (5 items), both checked one by one against what the host actually emits.
**Every event is also part of the config-root event stream.**

### 5.1 Server-side events (`LIFECYCLE_EVENTS`, 11 items)

| Event name (bus type) | When it fires | Payload | Typical use |
|---|---|---|---|
| `plugin:host:init` | once, after the host has loaded every plugin (including disabled ones) | `{ plugins: string[], failures: number }` | readiness proof, deferred init |
| `plugins:reloaded` | end of a hot reload (plugin enabled/disabled, `plugins-state.json` changed) | `{ plugins: <manifest entry array> }` | rebuild caches, re-register external resources |
| `config:changed` | `runtime-settings.json` changed (`aw config set` / settings page, bridged from SystemConfigService) | `{ type: 'config:changed', changed: string[], effective: object, sources: object }` | hot-update thresholds, refresh caches |
| `event:permissions:changed` | after line grants were written successfully | `{ userId }` | refresh cached grant views |
| `event:*` | **a subscription entry, not an emitted event** | — | use the bare `'*'` to receive everything (§4.1) |
| `daq:sample` | DAQ **downlink-level** sampling (same point as WS `daq.reading`, on the node's `publishIntervalMs` cadence) | `{ nodeId, templateRef, value, state, at, lineId }` | limit alarms, statistics, interlocking |
| `daq:frame` | multi-modal frames (vector / image) at downlink level, on the same frame-ingest path as `daq:sample` | `{ nodeId, templateRef, kind, at, lineId, preview?, metrics, thumbUrl?, state }` | custom sinks, derived metrics |
| `dcw:write` | observation after a write-control ACK (never affects the write decision) | `{ nodeId, name, eng, prevValue, ok, source, lineId, at }` | write audit, trend recording |
| `line:start` | a line starts running (batch window opens) | `{ lineId, runId, recipeId, productName? }` | batch-start interlocking |
| `line:stop` | a line stops (batch window closes) | `{ lineId, runId }` | batch wrap-up, report generation |
| `server:close` | server shutdown, after the per-plugin dispose queues have run | `{ at }` | final flush, outbound notification |

`dcw:write`'s `source` is `'manual'` / `'recipe'` / `'agent'` / `'rollback'`; the payload
**has no `message` field** (look at platform logs or the ledger for a failure reason).

The `config:changed` payload **has no `at` field** — take the time yourself with `Date.now()`
when you receive it, and read the new values from `ctx.config.get/all()`.

### 5.2 Browser-side events (`CLIENT_EVENTS`, 5 items)

| Event | When it fires | Payload |
|---|---|---|
| `client:init` | after the client script's `setup(ctx)` has finished | `{ name }` |
| `event:*` | live scene events (same source as the browser WS, via the event bridge) | the event's own payload |
| `page:change` | route change finished (`page:finish`) | `{ path }` |
| `i18n:changed` | UI language switched | `{ locale }` |
| `client:destroy` | just before `ctx.dispose()` collects things | `{ name }` |

### 5.3 Subscription cheat sheet

| What you want | Server plugin | Browser plugin |
|---|---|---|
| A named lifecycle hook (`daq:sample` / `dcw:write` / `line:start` …) | `ctx.hooks.on('daq:sample', fn)` | not delivered (server hooks never reach the browser) |
| A scene event (e.g. `daq.reading`, `device.created`) | `ctx.events.on('daq.reading', fn)` | `ctx.on('daq.reading', fn)` |
| Every scene event | `ctx.hooks.on('*', ({ type, payload }) => …)` | `ctx.on('event:*', fn)` |
| A client-local hook (`client:init` / `page:change` / `i18n:changed` / `client:destroy`) | n/a | `ctx.hooks.on('page:change', fn)` |

The two easiest mistakes:

- The server wildcard is the bare `'*'` only: `ctx.hooks.on('event:*', fn)` **never fires**;
- The client wildcard is the literal `'event:*'` only: `ctx.on('*', fn)` **never fires**, and
  `ctx.on('event:line.start', fn)` gets the prefix added twice (`event:event:line.start`) and
  likewise never fires.

Scene events enter the bus as `event:<type>`, and `ctx.events.on('<type>', fn)` is the sugar that
adds the prefix. So the correct subscription for the scene event `permissions.changed` is
`ctx.events.on('permissions.changed', fn)`, while `ctx.hooks.on('permissions:changed', fn)`
never fires.

### 5.4 Shutdown and hot-reload sequences

```text
server shutdown (nitro close → shutdownPluginHost)
  └─ per-plugin ctx.onDispose queue (each entry try/catch)
      └─ broadcast server:close { at }

plugin hot reload (plugins-state.json changed / plugin enabled-disabled / 10 s poll fallback)
  └─ per-plugin ctx.onDispose queue
      └─ unbind every listener registered through ctx.hooks
          └─ reload → broadcast plugins:reloaded
              └─ broadcast the scene event plugins.reloaded (the browser loader hot-injects / unloads client plugins from it)
```

> v1 hooks are **observation-only** — they never change interlocking or write-control decisions;
> veto (interception / rewriting) hooks are on the roadmap.

---

## 6. Browser-side SDK (`agentworkshop/sdk/client`)

A plugin's `client.mjs` is a **self-contained ESM** module (no bare imports — the browser resolves
it natively) exporting `setup(ctx)`. The entry must be declared in the plugin definition as
`client: './client.mjs'`; the loader fetches the script from
`GET /api/plugins/client/<plugin name>` and imports it dynamically.

### 6.1 Creation (host-invoked; plugins only write `setup`)

```js
import { createClientContext } from 'agentworkshop/sdk/client'

// host-side assembly (illustrative); a plugin author only writes setup(ctx) in client.mjs
const listeners = new Set()
const townBus = {
  subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
}

const ctx = createClientContext({
  name: 'my-plugin',
  // event bridge: the host feeds every WS bus message into dispatch
  eventBridge: dispatch => townBus.subscribe(e => dispatch(e.type, e.payload)),
  baseUrl: '',                              // same-origin; fill in the platform address for cross-origin integration
  ui: { slots: ['plugins.page'], registerPanel: () => () => {} },
  t: key => `plugin.my-plugin.${key}`,      // the host passes a real translation helper
  getLocale: () => 'zh-CN',
})
```

### 6.2 `ctx` members

| Member | Notes |
|---|---|
| `ctx.name` | plugin name |
| `ctx.sdkVersion` | `CLIENT_SDK_VERSION` |
| `ctx.hooks` | the client-local `HookBus`; both local hooks and scene events ride this bus |
| `ctx.on(type, fn)` | subscribe to **live scene events**; `type` is the **scene event name itself** (e.g. `'daq.reading'` / `'daq.alarm'` / `'daq.alarm.changed'` / `'dcw.written'` / `'daq.node.changed'` / `'device.updated'`), installed as `event:<type>` internally; returns an unsubscribe function and is **auto-collected on pagehide**. The only wildcard spelling is the literal **`'event:*'`** |
| `ctx.fetch(path, opt?)` | same-origin platform API: automatic JSON, automatic `{data}` unwrapping, throws on non-2xx, and **automatically carries the platform token from the cookie** |
| `ctx.el(tag, attrs, children)` | DOM builder: `style` / `class` / `on*` event attributes get special handling |
| `ctx.mount(target, node)` | mount into any selector / element; falls back to `ctx.root()` when the target is missing |
| `ctx.root()` | the plugin's private mount point `#aw-plugin-<name>` (bottom-right, lazily created) |
| `ctx.ui` | UI injection surface: `slots` and `registerPanel(entry)` (§6.4) |
| `ctx.t(key, params?)` | plugin namespace translation: `ctx.t('panel.title')` → `plugin.<name>.panel.title` (messages come from `i18n.json` in the plugin root; a miss falls back to the original key). **`params` is currently ignored — there is no interpolation** |
| `ctx.locale` | the current UI language (read-only getter) |
| `ctx.log` | prefixed console: `info` / `warn` / `error` (**no `debug`**) |
| `ctx.dispose()` | unload: broadcast `client:destroy` → run local disposables → remove `root()`. **Idempotent**; it does not unregister panels (the loader does that on disable / hot reload) |

Two wrong spellings of `ctx.on`: `ctx.on('*')` and `ctx.on('event:line.start')` both
**never fire** — the former is not installed on the bare `'*'`, the latter gets a second prefix
and becomes `event:event:line.start`.

**Server hooks never reach the browser**: colon-named server hooks such as `daq:sample`,
`dcw:write`, `line:start` / `line:stop` are not delivered to the client. Their browser-side
counterparts are scene events (`daq.reading` / `daq.frame` / `dcw.written` and so on); subscribe
to those with `ctx.on('<scene-type>')`.

**Client lifecycle hooks cannot go through `ctx.on` either**: `client:init` / `page:change` /
`i18n:changed` / `client:destroy` must be subscribed directly with `ctx.hooks.on(...)` (they carry
no `event:` prefix).

### 6.3 Full example

```js
export function setup(ctx) {
  const badge = ctx.el('div', {
    style: 'padding:8px 12px;border:1px solid #35e0a0;border-radius:10px;color:#35e0a0',
  }, ['samples: 0'])
  ctx.root().append(badge)

  let n = 0
  ctx.on('daq.reading', () => { badge.textContent = `samples: ${++n}` })   // scene event
  ctx.on('event:*', (payload) => ctx.log.info('scene event', payload))     // the only wildcard spelling

  ctx.hooks.on('page:change', ({ path }) => ctx.log.info('page →', path)) // local hook: subscribe directly

  // Consume the platform API (same-origin, cookie auth): the line list is { lines, states }, not an array
  ctx.fetch('/api/workshop/dcw/lines').then(({ lines }) => ctx.log.info('lines', lines.length))
}
```

### 6.4 UI injection `ctx.ui.registerPanel`

```js
let samples = 0
ctx.on('daq.reading', () => { samples += 1 })

const off = ctx.ui.registerPanel({
  slot: 'dashboard.widgets',        // 'plugins.page' | 'settings.plugins' | 'dashboard.widgets'
  name: 'my-widget',
  title: 'Sample counter',
  titleKey: 'plugin.my-plugin.widget.title',   // titleKey wins when present
  order: 100,                        // smaller comes first; default 100
  mount(el) {
    el.textContent = `samples: ${samples}`
    const tick = setInterval(() => { el.textContent = `samples: ${samples}` }, 1000)
    return () => clearInterval(tick)   // called when the panel is unmounted
  },
})
off()   // the returned unregister function; ctx.dispose() does not call it, the loader collects it on disable
```

- `ctx.ui.slots` is exactly `['plugins.page', 'settings.plugins', 'dashboard.widgets']`.
- `registerPanel` returns an unregister function; if `mount(el)` returns a function it is called
  when that panel is unmounted.

### 6.5 Constraints and trust

- **Self-contained**: no bare imports of `vue` or other third-party packages (the browser's native
  import cannot resolve them) — build UI with native DOM (`ctx.el`);
- **Trust model**: client scripts are served by platform endpoints, trusted at the same level as
  aw commands — only install plugins you trust;
- **Isolation**: a single plugin failing to load only logs a console warning; the app and other
  plugins are unaffected.

---

## 7. Types and TypeScript

```ts
import type { PluginDef, PluginContext, PlatformClient } from 'agentworkshop/sdk'

export default {
  name: 'typed-plugin',
  auth: 'user',
  async setup(ctx: PluginContext) {
    const timeout: number = ctx.config.get('plugins.typed-plugin.timeout')
    const client: PlatformClient = ctx.api
    ctx.logger.info('api available:', typeof client.get === 'function', 'timeout:', timeout)
  },
} satisfies PluginDef
```

The runtime **does not import** the SDK (keeping the zero-dependency shape); types are erased at
build time.

Current coverage of the type declarations (always defer to `sdk/index.d.mts` and
`sdk/client.d.mts`):

- Declared: `PluginDef`, `PluginContext`, `PluginHostExtensions`, `PluginSettingDecl`,
  `PluginGroupDecl`, `PluginLogger`, `PluginKv`, `PluginHttp`, `CrudResource`, `PlatformClient`,
  `ConfigChangedPayload`, `HookBus`, `ClientContext`, `ClientUi`, `ClientPanelEntry`,
  `LIFECYCLE_EVENTS`, `CLIENT_EVENTS` and the factory functions.
- **Not yet declared**: `isPathInside`, `validatePluginSettings`, `validatePluginGroups` and
  `resolvePluginGroupId` are runtime-only exports with no declaration in `.d.mts` — a TypeScript
  project importing them gets TS2614 and needs a local declaration or `await import()`.
- In addition, `sdk/client.d.mts` declares an `el` named export that does not exist at runtime
  (the runtime has only `CLIENT_SDK_VERSION` and `createClientContext`); importing it compiles
  but yields `undefined` at runtime.

---

## 8. Versioning and compatibility policy

- The SDK interface follows semver: patch = fixes; minor = new hooks / `ctx` members
  (backwards compatible); major = breaking contract changes. `SDK_VERSION` /
  `CLIENT_SDK_VERSION` are the versions on that line and are **independent of the npm package
  version** — never infer one from the other.
- The host exposes `ctx.sdkVersion` so a plugin can degrade gracefully by feature.
- Config-root hardening does not live in the single `aw start` command but in the **CLI context
  builder** — every `aw` command calls it while resolving the run root (idempotently), so no
  command fails just because a config-root directory is missing.
- There is **no version-based directory-layout migration**: the only migration copies data files
  from the legacy locations into the config root, that is `cwd/data` (and the historical
  `cwd/server/data`) → `<configRoot>/data`, only for `.sqlite` / `.sqlite-wal` / `.sqlite-shm` /
  `.json`, with "newest wins" by `mtimeMs` on a name clash; when the config root falls back to
  `~/.AgentWorkShop` that migration is skipped to avoid cross-project pollution.

---

## Appendix: scope of this page

This page is the single source of truth for the SDK; it follows the actual implementation in
`sdk/*.mjs`, `sdk/*.d.mts`, `server/services/workshop/plugins/host.mjs` and `server/api/**`.
CI copies this file to the site at `docs/site/en/sdk/guide.md`, and the Chinese original
`docs/sdk.md` to `docs/site/sdk/guide.md`.
