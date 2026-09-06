# SDK full guide (single page)

Everything about the SDK on one page: the REST client, the plugin context, lifecycle
events, the browser side and packaging.

## 1. Install

```bash
npm install -g agentworkshop     # global (CLI + platform)
npm install agentworkshop        # or as a project dependency
```

## 2. REST client

```js
import { createPlatformClient } from 'agentworkshop/sdk'

const api = createPlatformClient({ baseUrl: 'http://127.0.0.1:3001' })
const { token } = await api.users.login('you@example.com', 'secret')
api.setToken(token)
```

Surfaces: `users`, `lines` (start/stop), `dcw` (nodes, `write`, `read`, recipes +
`versions` + `revert`), `daq` (`testDriver`, controller, samples), `channels` / `agents`
(tasks, mailbox), `harnesses` (availability), `permissions`, `plugins`.
Errors throw `ApiError { code, status, message }` from the platform envelope; network
failures normalize to `ApiError('NETWORK')`.

## 3. Plugin context

Plugins export `{ name, setup(ctx) }` — no imports:

- `ctx.log` — scoped logger into the platform stream;
- `ctx.config` — manifest config (hot values);
- `ctx.permissions` — grant-aware view (`lineMode`, `visibleLineIds`, `filterByLine`);
- `ctx.http` — auth + envelope handled;
- `ctx.events` / `ctx.hooks` — lifecycle events;
- `ctx.routes` — plugin API routes under `/api/plugins/<name>/`;
- `ctx.kv` — small KV store flushed on dispose;
- `ctx.omp.registerTool(def)` — custom agent tools, hot-injected;
- `ctx.daq.registerDriver / registerProcessor / registerTemplate` — protocol & pipeline
  extensions;
- `ctx.dcw` / `ctx.scene` — write-control audit and scene broadcast.

## 4. Lifecycle events

`daq:sample`, `daq:frame`, `daq:alarm`, `dcw:write`, `line:start`, `line:stop`, `scene:*`.
Sequential per event; failures are contained (a plugin can never break sampling or write
control). See [Lifecycle](./lifecycle).

## 5. Browser side

```js
import { createClientContext } from 'agentworkshop/sdk/client'
const ctx = createClientContext()
ctx.bus.on('daq.reading', (frame) => {})
```

Session-cookie auth; frames filtered by the caller's line permissions.

## 6. Packaging

Ship a folder with `plugin.json` (permissions + browser entry) and `index.mjs` into
`<config-root>/plugins/`. See [Plugin development](/en/plugins/guide).
