# Platform REST client

`createPlatformClient(options)` returns a client over the platform's REST surface.
It handles base URLs, bearer tokens, envelope unwrapping (`{code, message, data}` →
`data`), timeouts and query serialization. Non-2xx responses throw with
`err.status` / `err.code` / `err.body`.

## Options

```js
import { createPlatformClient } from 'agentworkshop/sdk'

const api = createPlatformClient({
  baseUrl: 'http://127.0.0.1:3001',   // platform origin ('' = same-origin relative)
  token: '<bearer-token>',            // optional; api.setToken() swaps it later
  timeoutMs: 10_000,                  // per-request timeout (AbortSignal)
  logger,                             // optional; warned on API failures
})
```

> `baseUrl` also accepts a **function** (lazy resolution): the plugin host passes a
> `() => origin` because the listening port is only known once the server is up.

## Generic calls

| Method | Signature | Notes |
|---|---|---|
| `api.call(method, path, body?)` | low level | returns unwrapped `data` |
| `api.get(path, query?)` | query object serialized | `api.get('/api/workshop/dcw', { page: 1 })` |
| `api.post(path, body?)` | JSON-serialized | |
| `api.patch(path, body?)` | | |
| `api.delete(path)` | | |
| `api.setToken(token)` | chainable | `api.setToken(res.token)` after login |
| `api.ping()` | unauthenticated liveness probe | |

## Resource surfaces

Each CRUD resource exposes `list(query?) / get(id) / create(body) / update(id, patch) / remove(id)`.

| Surface | Highlights |
|---|---|
| `api.users` | CRUD + `login(email, password)` + `me()` |
| `api.lines` | line CRUD + `start(id, recipeId?)` / `stop(id)` |
| `api.products` / `api.recipes` | line-operations CRUD |
| `api.dcwNodes` | write-control node CRUD |
| `api.daqNodes` | acquisition CRUD + `alarms()` |
| `api.templates` | `daq()` / `dcw()` signal template catalogs |
| `api.twins` | device-twin CRUD |
| `api.teams` / `api.agents` / `api.channels` | agent grouping |
| `api.permissions` | admin `overview()` / `set({ userId, grants })` |
| `api.plugins` | `manifest()` (unauthenticated) |

## Full example: integrating a line from an external project

```js
import { createPlatformClient } from 'agentworkshop/sdk'

const api = createPlatformClient({ baseUrl: 'http://plant.local:3001' })
const { token } = await api.users.login('you@example.com', 'secret')
api.setToken(token)

await api.lines.create({ name: 'Line 1' })
const line = (await api.lines.list())[0]

const dcwT = (await api.templates.dcw())[0]
await api.dcwNodes.create({ name: 'Temp control', templateRef: dcwT.key, driver: 'mock', lineId: line.id })
await api.lines.start(line.id)
```

## Error semantics

```js
try {
  await api.daqNodes.create({ name: 'x' })
}
catch (err) {
  err.status   // HTTP status code
  err.code     // backend business code
  err.body     // full platform error envelope { code, message }
}
```
