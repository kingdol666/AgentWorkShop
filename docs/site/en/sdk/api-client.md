# Platform REST client createPlatformClient

The SDK fronts the platform as a "project service client": it attaches the Bearer token, unwraps
the unified envelope (`{ code, message, data } → data`), and throws according to the rules below.

## Creation

```js
import { createPlatformClient } from 'agentworkshop/sdk'

const api = createPlatformClient({
  baseUrl: 'http://127.0.0.1:3001',  // defaults to '' (same-origin relative); integrators pass the platform address
  token: '<bearer-token>',            // optional; api.setToken() swaps it later
  timeoutMs: 10_000,                  // optional; per-request timeout (AbortSignal), default 10 000
  logger,                             // optional; warns when a request fails
})
```

> `baseUrl` also accepts a **function** (lazy resolution): the plugin host passes a `() => origin`
> because the listening port is only known once the server is up. A trailing `/` is stripped.

## Envelope and error semantics

| Case | Behaviour |
|---|---|
| HTTP non-2xx | throws an `Error` carrying **only `err.status` and `err.body`**; this path **does not set `err.code`** |
| HTTP 200 but envelope `code !== 0` | throws an `Error` carrying `err.status`, `err.code` **and** `err.body` |
| Success | returns the unwrapped `data`; a body with no `code`/`data` envelope is returned **as-is** (e.g. `GET /api/workshop/plugins`, `GET /api/plugins/manifest`) |

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

## Generic calls

| Method | Signature | Notes |
|---|---|---|
| `api.call(method, path, body?, opt?)` | low level | `opt` may carry `{ timeoutMs, headers }`; returns the unwrapped `data` |
| `api.get(path, query?)` | query object serialized automatically | `api.get('/api/workshop/dcw', { page: 1 })` |
| `api.post(path, body?)` | JSON-serialized | |
| `api.patch(path, body?)` | | |
| `api.delete(path)` | | |
| `api.setToken(token)` | chainable, returns `api` | `api.setToken(res.token)` after login; pass `null` to clear |
| `api.ping()` | `GET /api/plugins/manifest` | liveness probe (unauthenticated) |

`toQuery` drops `undefined` / `null` / empty-string values, so it never produces
`?lineId=undefined`.

## Resource surfaces and their real base paths

Every resource is built by `resource(root)`, so **all of them expose five methods**:
`list(query?)`, `get(id)`, `create(body)`, `update(id, patch)`, `remove(id)`.

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

The payload for `api.permissions.set`:

```json
{ "userId": "<user id>", "grants": [{ "lineId": "<line id>", "mode": "readonly" }] }
```

`mode` is `'readonly'`, `'operate'` or `null` (passing `null` revokes that grant).

## Real route support

`resource(root)` always generates five methods, but only some server route files exist. The table
below was checked against every route file: "no" means the call targets a path that does not exist
and therefore 404s.

| Namespace | `list` | `get(id)` | `create` | `update(id)` | `remove(id)` | Notes |
|---|---|---|---|---|---|---|
| `users` | yes | yes | yes | **no** | yes | The server only has `PUT /api/users/:id`, while `update()` sends `PATCH`; use `api.call('PUT', '/api/users/' + id, patch)` to update a user. `list`/`get`/`create` require admin |
| `lines` | yes | no | yes | yes | yes | Plus `start` / `stop`. `create` requires `admin` or `editor` |
| `products` | **no** | no | yes | yes | yes | No `GET /api/workshop/dcw/products`; read products from `.products` of `GET /api/workshop/dcw` |
| `recipes` | yes | no | yes | yes | yes | `list()` → `{ recipes, runs }` |
| `dcwNodes` | yes | no | yes | yes | yes | No `[id].get.ts`; read nodes from `.nodes` |
| `daqNodes` | yes | no | yes | yes | yes | No `[id].get.ts`; `alarms()` works |
| `twins` | yes | no | yes | yes | yes | No `[id].get.ts` |
| `teams` | yes | yes | yes | yes | yes | Full CRUD |
| `agents` | yes | yes | yes | yes | yes | Full CRUD |
| `channels` | yes | yes | yes | yes | yes | Full CRUD |
| `permissions` | `overview()` only | — | — | — | — | Only `overview()` and `set()` |
| `plugins` | `manifest()` only | — | — | — | — | Unauthenticated |

- Business read endpoints go through platform auth and need a user token (`api.setToken(...)`, or
  the cookie in a browser).
- `api.plugins.manifest()` and `api.ping()` are unauthenticated — the only two endpoints you can
  call without a token.

## Response shapes at a glance

**A list does not necessarily return an array** — every row below was checked against the server handler.

| Call | Real response |
|---|---|
| `api.lines.list()` | `{ lines, states }` (**not an array**) |
| `api.daqNodes.list()` | `{ controller, nodes, meta, driverAvailable, infra, templates }` |
| `api.dcwNodes.list()` | a multi-key object (`controller` / `nodes` / `templates` / `recipes` / `runs` / `history` / `products` / `lines` …) |
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

Two things to watch closely:

- `api.daqNodes.list({ lineId })`: the `{ lineId }` query argument **is not read by that handler**;
  line filtering happens server-side from the caller's permissions. Do not treat it as a working
  client-side filter.
- `api.lines.start(id, recipeId)`: `recipeId` defaults to an empty string, but the server
  **requires a recipe that actually exists** (an empty string or an unknown id yields
  404 `Recipe 不存在`). When a line has recipes, `recipeId` is effectively mandatory.

## Full example: integrating a line from an external project

```js
import { createPlatformClient } from 'agentworkshop/sdk'

const api = createPlatformClient({ baseUrl: 'http://plant.local:3001' })
const { token } = await api.users.login('you@example.com', 'secret')
api.setToken(token)

// 1) Line list: { lines, states }, not an array
const { lines, states } = await api.lines.list()
console.log(`${lines.length} lines`)

// 2) DAQ surface: { controller, nodes, ... }
const { nodes } = await api.daqNodes.list()
console.log(`${nodes.length} DAQ nodes`)

// 3) Write-control surface: the node list is an object too; read products from .products
const dcw = await api.dcwNodes.list()
console.log(`${dcw.nodes.length} DCW nodes, ${dcw.products.length} products`)

// 4) Recipe surface: { recipes, runs }
const { recipes } = await api.recipes.list()

// 5) Starting a line: recipeId must be a real recipe of that line
const line = lines[0]
const recipe = recipes.find(r => r.lineId === line?.id)
if (line && recipe) {
  await api.lines.start(line.id, recipe.id)
  await api.lines.stop(line.id)
}
```

## Using ctx.api inside a plugin

`ctx.api` is a `PlatformClient`, except that its **baseUrl is resolved lazily by the host (the
loopback origin) and it carries no token by default**:

```js
const { token } = await ctx.api.users.login('user@example.com', 'secret')
ctx.api.setToken(token)
const { lines } = await ctx.api.lines.list()
```

Unauthenticated endpoints (`api.plugins.manifest()` / `api.ping()`) can be called right away; if you
only need in-process data, prefer `ctx.events` and `ctx.hooks` (no auth, no overhead).
