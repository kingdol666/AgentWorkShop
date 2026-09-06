# Plugin development — full guide

This single page condenses everything about writing plugins: manifests, the `ctx` surface,
hooks, registration APIs, routes and packaging.

## 1. Manifest (`plugin.json`)

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "description": "short description",
  "permissions": { "lines": "read", "dcw": "audit" },
  "browser": "browser.mjs"
}
```

Permissions mirror the platform's line-grant model — `ctx.permissions` exposes only what
was granted, so a `read`-only plugin physically cannot observe write traffic.

## 2. Entry (`index.mjs`)

```js
export default {
  name: 'my-plugin',
  setup(ctx) {
    // ctx.log / ctx.config / ctx.http / ctx.events / ctx.hooks
    // ctx.routes / ctx.kv / ctx.permissions
    // ctx.omp.registerTool / ctx.daq.registerDriver|registerProcessor|registerTemplate
  },
  dispose() { /* cleanup */ },
}
```

## 3. Hooks

`daq:sample`, `daq:frame`, `daq:alarm`, `dcw:write`, `line:start`, `line:stop`, `scene:*`.
Sequential per event, failures contained. See [Lifecycle](/en/plugins/lifecycle).

## 4. Registration APIs

- `ctx.omp.registerTool(def)` — agent tools with JSON-schema parameters; hot-injected;
- `ctx.daq.registerDriver(kind, impl)` — implement `sample()` (+`test()`) to add a
  protocol alongside Modbus/OPC UA/MQTT/HTTP;
- `ctx.daq.registerProcessor(key, fn)` — transform frames inside sink pipelines;
- `ctx.daq.registerTemplate(def)` — node templates appear in the create wizard;
- `ctx.routes.get/post('/x', handler)` — mounted under `/api/plugins/<name>/`.

## 5. Routes & auth

Plugin routes inherit the caller's session; `ctx.permissions` lets you branch by line
grant inside the handler. Responses are plain objects — the platform wraps the envelope.

## 6. Browser enhancement

Declare `"browser": "browser.mjs"`; the host injects it into pages where
`createClientContext()` gives you the user, the WS bus and typed helpers.

## 7. Checklist

- [ ] manifest with the minimal permission set
- [ ] setup/dispose symmetric (timers cleaned up)
- [ ] hook handlers never throw
- [ ] routes validate input and return plain objects
- [ ] tools use JSON-schema parameters (they surface in every harness's tool list)
