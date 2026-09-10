# AgentWorkShop plugin development — full guide

> A plugin is a self-contained folder under the config root's `plugins/<name>/`.
> One folder enhances both the **server** (tools/APIs/data/events) and the **browser**
> (panel components / i18n / settings UI). Drop it in and it loads; toggle it and the
> host hot-reloads. Canonical reference: this page (mirrored from the Chinese guide).
>
> Applies to v0.7.29+ (plugin system v2: frontend component injection / plugin settings /
> plugin i18n / runtime services surface).

## 1. Folder layout & quick start

```
plugins/my-plugin/
├── index.mjs      # server entry (required): export default { name, setup(ctx), … }
├── client.mjs     # browser enhancement (optional): export function setup(ctx)
├── i18n.json      # i18n messages (optional): { "zh-CN": {...}, "en": {...} }
└── kv.json        # runtime state (auto-generated)
```

Discovery scopes: builtin (`server/plugins-builtin`) → project (`<repo>/.AgentWorkShop/plugins`) →
user (`~/.AgentWorkShop/plugins`); first match wins. Enable/disable state lives in
`plugins-state.json`; toggling hot-reloads the host.

## 2. Contract (`index.mjs`)

```js
export default {
  name: 'my-plugin',         // required, globally unique
  version: '1.1.0',
  auth: 'user',              // route auth: none | user | admin | agent-or-user
  client: './client.mjs',    // optional browser entry
  settings: [ /* see §4 */ ],
  routes: [{ method: 'GET', path: '/health', handler: () => ({ ok: true }) }],
  async setup(ctx) { /* server lifecycle */ },
}
```

## 3. Lifecycle (full-cycle injection)

| Phase | Server | Browser |
|---|---|---|
| Load | dynamic import (`?t=`) → validate → `setup(ctx)` | loader fetches manifest + i18n bundle → imports client → `setup(ctx)` |
| Inject | routes/tools/drivers/templates live; settings merged into SystemConfigService | `client:init`; panels via `ctx.ui.registerPanel` |
| Run | `event:*` / `daq:sample` / `daq:frame` / `dcw:write` / `line:start|stop` | `event:*` / `page:change` / `i18n:changed` |
| Unload | dispose → unbind hooks → unregister tools → reload | `plugins.reloaded` WS + 15s polling diff → `ctx.dispose()` |
| Shutdown | `server:close` + per-plugin dispose | `pagehide` auto-dispose |

Race protection: state changes during an in-flight reload (disable→enable bursts) are
detected via a disabled-set snapshot and re-run — toggle events are never lost.

## 4. Plugin settings (auto-rendered in the settings UI)

```js
settings: [
  { key: 'base_url', type: 'string', default: 'http://127.0.0.1:8770',
    labelKey: 'plugin.my-plugin.settings.base_url', label: 'fallback label' },
  { key: 'max_turns', type: 'number', default: 0, min: 0, max: 2000 },
  { key: 'auto_enabled', type: 'boolean', default: false },
  { key: 'mode', type: 'select', default: 'a', options: ['a', 'b'] },
],
```

- Keys are force-namespaced `plugins.<plugin>.<key>`; disabled plugins disappear from settings.
- Rendered under Settings → Runtime → "Plugins" (admin/editor); live-apply on save.
- Read via `ctx.config.get('plugins.my-plugin.base_url')`; overrides persist in
  `runtime-settings.json`. Legacy `plugins.kb.*` / `plugins.diag.*` keys are migrated once.

## 5. Plugin i18n (`i18n.json` at the folder root)

```json
{ "zh-CN": { "panel": { "title": "我的面板" } }, "en": { "panel": { "title": "My panel" } } }
```

- Served at `GET /api/plugins/i18n` (public; UI copy only — never secrets).
- Merged into vue-i18n namespace `plugin.<name>` (settings labels / panel titles resolve
  automatically) and exposed to the client via `ctx.t(key)`; locale switches broadcast
  `i18n:changed`.

## 6. Server `ctx` reference

`ctx.hooks / logger / config / kv / timer / onDispose / route / api / http(headers support) /
events / omp.registerTool / daq.*(registerDriver/registerProcessor/registerTemplate/onFrame/
onSample/query/nodes) / permissions / services`.

`ctx.services` (v2 runtime objects): `get('daq' | 'lines' | 'channels' | 'plugins')`,
`provide(name, getter)` (namespaced `<plugin>.<name>`), `names()`.

## 7. Browser `client.mjs` ctx reference

| Member | Purpose |
|---|---|
| `ctx.ui.registerPanel({ slot, name, title?, titleKey?, order?, mount(el) })` | inject a panel into a named slot; return cleanup; auto-removed on dispose |
| `ctx.t(key)` | plugin-namespaced translation from `i18n.json` |
| `ctx.locale` / `i18n:changed` | current locale / locale-switch broadcast |
| `ctx.fetch(path, opt?)` | platform API helper (cookie token, envelope unwrap) |
| `ctx.on(type, fn)` | scene events (`*` wildcard) |
| `ctx.el / mount / root / log / dispose` | DOM helpers / lifecycle |

Built-in slots: `plugins.page` (plugins page), `settings.plugins` (settings → plugins),
`dashboard.widgets` (dashboard tail). Host pages embed `<PluginSlot slot-name="…" />`;
add a slot by dropping the component anywhere.

## 8. Tools & team switches

`ctx.omp.registerTool` tools reach every harness (omp RPC / MCP bridge / pi tools file /
mock REST invoke). Per-team/per-channel plugin switches hide and reject disabled tools;
team creation accepts a `plugins` array and deploy propagates it to the channel.
