# Platform REST client

`createPlatformClient(options)` returns a typed client over the platform's REST surface.
It handles base URLs, bearer tokens, envelope unwrapping (`{code, message, data}`),
timeouts and protocol guards.

## Options

```js
const api = createPlatformClient({
  baseUrl: 'http://127.0.0.1:3001',   // platform origin
  timeout: 15_000,                     // per-request timeout (ms)
})
api.setToken(token)                    // bearer for subsequent calls
```

## Surfaces

| Surface | Highlights |
|---|---|
| `api.users` | register / login / me / tokens |
| `api.lines` | CRUD, start / stop, line runs |
| `api.dcw` | nodes CRUD, `write`, `read`, recipes CRUD + `apply` + `versions` + `revert` |
| `api.daq` | nodes CRUD, `testDriver`, controller, samples query |
| `api.channels` / `api.agents` | channels, members, tasks, mailbox |
| `api.harnesses` | engine registry with availability (`available` / `command` / `resolvedPath`) |
| `api.permissions` | line grant matrix (admin) |
| `api.plugins` | manifest, enable/disable |

## Error semantics

Business failures throw `ApiError` with `code` (backend business code), `status` (HTTP)
and a human-readable `message` from the backend envelope — network failures normalize to
`ApiError('NETWORK')` instead of raw fetch errors, so integrators can branch reliably.

```js
try {
  await api.dcw.write(nodeId, 0.95)
} catch (e) {
  if (e.code === 'HARNESS_UNAVAILABLE') console.error('engine not installed:', e.message)
}
```
