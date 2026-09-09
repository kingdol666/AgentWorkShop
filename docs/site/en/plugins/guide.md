# Plugin development — full guide

This single page condenses everything about writing plugins: the contract, the `ctx`
surface, hooks, registration APIs, routes and packaging.

## 1. Contract (`index.mjs`)

A plugin is a folder under the config root's `plugins/` whose `index.mjs` exports a plain
object (zero imports — `ctx` is host-injected):

```js
export default {
  name: 'my-plugin',            // required, globally unique
  version: '1.0.0',
  description: '…',
  client: './client.mjs',       // optional: browser enhancement entry (relative path)
  routes: [                     // optional: declarative API (or ctx.route() in setup)
    { method: 'GET', path: '/health', handler: () => ({ ok: true }) },
  ],
  async setup(ctx) { /* server-side lifecycle */ },
}
```

There is no `plugin.json` and no permission sandbox: plugins are trusted node code with the
full `ctx` surface (same trust level as aw commands).

## 2. The `ctx` surface

- `ctx.logger` — scoped logger (`debug/info/warn/error`);
- `ctx.config.get/all/onChange` — effective platform config + change subscription;
- `ctx.permissions` — line-grant face: `lineMode(user, lineId)`, `visibleLineIds(user)`,
  `listGrants(userId)`, `setGrants(userId, grants)` (changes broadcast `permissions:changed`);
- `ctx.http.get/post` — generic requests (http/https, 8 s default timeout);
- `ctx.events.on(type, fn)` — live scene events;
- `ctx.hooks` — the hook bus (async-serial, error-isolated, `'*'` wildcard, circuit-breaker);
- `ctx.route(method, path, handler)` — plugin API under `/api/plugins/<name>/`;
- `ctx.kv` — plugin-private KV (200 ms debounced flush);
- `ctx.timer` / `ctx.onDispose` / `ctx.subscriptions` — lifecycle-safe background work;
- `ctx.omp.registerTool(def)` — agent tools with JSON-schema parameters, hot-injected;
- `ctx.daq.registerDriver / registerProcessor / registerTemplate` (+ `onFrame`/`onSample`) —
  protocol & pipeline extensions;
- `ctx.api` — the platform REST client over a loopback origin (`setToken` for
  authenticated endpoints; manifest/ping are unauthenticated).

## 3. Hooks

`plugin:host:init`, `daq:sample`, `daq:frame`, `dcw:write`, `line:start`, `line:stop`,
`permissions:changed`, `config:changed`, `event:*` (scene stream), `server:close`.
Sequential per event, failures contained. See [Lifecycle](/en/plugins/lifecycle).

## 4. Routes & auth

`ctx.route('GET', '/stats', () => ctx.kv.all())` mounts under `/api/plugins/<name>/`
(exact match; the pre-read body arrives on `event.awBody`). In v1 auth is the plugin's own
concern — call `resolveUser(event)` inside the handler to reuse platform auth, and branch by
line grant via `ctx.permissions` if needed. Handlers return plain objects — the platform
wraps the envelope.

## 5. Browser enhancement (`client.mjs`)

A self-contained ESM exporting `setup(ctx)`; the host loads it via
`createClientContext()`. `ctx.on('daq.reading', …)` subscribes to live scene events,
`ctx.hooks.on('page:change', …)` to page lifecycle, `ctx.el`/`ctx.root()` build UI, and
`ctx.fetch()` calls the platform API with the session cookie.

## 6. Checklist

- [ ] `setup`/`onDispose` symmetric (timers cleaned up)
- [ ] hook handlers never throw (they are contained, but keep logs clean)
- [ ] routes validate input and return plain objects
- [ ] tools use JSON-schema parameters (they surface in every harness's tool list)
- [ ] state persisted through `ctx.kv` survives restarts (`data/plugins/<name>/kv.json`)
