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

Resource namespaces (each CRUD resource exposes `list/get/create/update/remove`):

- `users` — CRUD + `login(email, password)` + `me()`;
- `lines` — line CRUD + `start(id, recipeId?)` / `stop(id)`;
- `products` · `recipes` · `dcwNodes` — line-operations resources;
- `daqNodes` — acquisition CRUD + `alarms()`;
- `templates` — `daq()` / `dcw()` signal template catalogs;
- `twins` · `teams` · `agents` · `channels` — device twins and agent grouping;
- `permissions` — admin `overview()` / `set({ userId, grants })`;
- `plugins` — `manifest()`.

Plus the generic face: `call/get/post/patch/delete`, chainable `setToken`, unauthenticated
`ping()`. Errors throw with `err.status` / `err.code` / `err.body` from the platform
envelope.

## 3. Plugin context

Plugins export `{ name, setup(ctx) }` — no imports; the host injects everything:

- `ctx.logger` — scoped logger (`debug/info/warn/error`);
- `ctx.config.get/all/onChange` — effective platform config + change subscription;
- `ctx.permissions` — line-grant face (`lineMode`, `visibleLineIds`, `listGrants`, `setGrants`);
- `ctx.http.get/post` — generic requests (http/https, 8 s default timeout);
- `ctx.events` / `ctx.hooks` — scene events and lifecycle hooks;
- `ctx.route(method, path, handler)` — plugin API under `/api/plugins/<name>/`;
- `ctx.kv` — plugin-private KV (200 ms debounced flush);
- `ctx.timer` / `ctx.onDispose` / `ctx.subscriptions` — lifecycle-safe background work;
- `ctx.omp.registerTool(def)` — custom agent tools, hot-injected;
- `ctx.daq.registerDriver / registerProcessor / registerTemplate` (+ `onFrame`/`onSample`) —
  protocol & pipeline extensions;
- `ctx.api` — the same platform REST client over a loopback origin.

## 4. Lifecycle events

Server side: `plugin:host:init`, `daq:sample`, `daq:frame`, `dcw:write`, `line:start`,
`line:stop`, `permissions:changed`, `config:changed`, `event:*` (scene stream), `server:close`.
Client side: `client:init`, `page:change`, `client:destroy`. Handlers run sequentially per
event and failures are contained — a plugin can never break sampling or write control.
See [Lifecycle](./lifecycle).

## 5. Browser side

```js
import { createClientContext } from 'agentworkshop/sdk/client'

export function setup(ctx) {
  ctx.on('daq.reading', (frame) => { /* live scene events, same source as the WS hub */ })
  ctx.hooks.on('page:change', ({ path }) => { /* page lifecycle */ })
  ctx.fetch('/api/workshop/dcw/lines').then(lines => { /* cookie-authenticated API */ })
}
```

`ctx.el`/`ctx.root()`/`ctx.mount()` build UI; `ctx.dispose()` unloads. Session-cookie auth;
scene events come from the same hub the dashboards consume.

## 6. Packaging

Ship a folder with `index.mjs` (`export default { name, setup(ctx) }`) and an optional
`client.mjs` into `<config-root>/plugins/` (project or user scope). See
[Plugin development](/en/plugins/guide).
