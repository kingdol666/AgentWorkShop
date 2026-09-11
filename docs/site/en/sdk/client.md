# Browser-side SDK (createClientContext)

A plugin's `client.mjs` is a **self-contained ESM module** (no bare imports — the browser loads it
natively) exporting `setup(ctx)`. At app startup the loader (`app/plugins/aw-plugins.client.ts`)
fetches the plugin manifest and injects each script; events come from the same source as the
browser WebSocket.

## Loading contract

- The entry must be declared in the plugin definition as `client: './client.mjs'`.
- The loader fetches the script from `GET /api/plugins/client/<plugin name>` and imports it dynamically.
- The script must export `setup(ctx)`; when it does not, the loader only warns and skips that plugin.
- A single plugin failing to load only logs a console warning; **the app and other plugins are unaffected**.

## Creation (host-invoked; plugins only write setup)

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

## ctx members

| Member | Notes |
|---|---|
| `ctx.name` / `ctx.sdkVersion` | plugin name and `CLIENT_SDK_VERSION` |
| `ctx.on(type, fn)` | subscribe to **live scene events**: `type` is the **scene event name itself** (`daq.reading` / `daq.frame` / `daq.alarm` / `daq.alarm.changed` / `dcw.written` / `daq.node.changed` / `device.updated` / `ops.log` …), installed as `event:<type>` internally; returns an unsubscribe function and is **auto-collected on pagehide**. The only wildcard spelling is the literal `'event:*'` |
| `ctx.fetch(path, opt?)` | same-origin platform API (JSON; unwraps the `{data}` envelope; throws on non-2xx; carries the platform cookie token automatically) |
| `ctx.el(tag, attrs, children)` | DOM builder (`style`/`class`/`on*` attrs get special handling) |
| `ctx.root()` | the plugin's private mount point `#aw-plugin-<name>` (bottom-right, lazily created) |
| `ctx.mount(target, node)` | mount into any selector / element (falls back to root when missing) |
| `ctx.ui` | UI injection surface: `slots` and `registerPanel(entry)` |
| `ctx.t(key, params?)` | plugin namespace translation: `ctx.t('panel.title')` → `plugin.<name>.panel.title` (messages come from `i18n.json` in the plugin root; a miss falls back to the original key). **`params` is currently ignored — there is no interpolation** |
| `ctx.locale` | the current UI language (read-only getter); switching languages broadcasts `i18n:changed` |
| `ctx.log` | prefixed console: `info` / `warn` / `error` (**no `debug`**) |
| `ctx.hooks` | local `HookBus`: `client:init` / `page:change` / `i18n:changed` / `client:destroy` subscribe **here directly** (no `event:` prefix) |
| `ctx.dispose()` | unload: broadcast `client:destroy` → run local disposables → remove `root()`. **Idempotent**, bound to the browser's `pagehide`; it does not unregister panels (the loader does that on disable / hot reload) |

## Event subscription rules

| What you want | Correct spelling | Wrong spelling and its consequence |
|---|---|---|
| A scene event | `ctx.on('daq.reading', fn)` | `ctx.on('event:line.start', fn)` → prefixed twice into `event:event:line.start`, never fires |
| Every scene event | `ctx.on('event:*', fn)` | `ctx.on('*', fn)` → never fires |
| A client-local hook | `ctx.hooks.on('page:change', fn)` | `ctx.on('page:change', fn)` → never fires |
| A server hook (`daq:sample` etc.) | unsupported | server hooks are never delivered to the browser |

Subscriptions registered through `ctx.on` are collected automatically on the browser's `pagehide`.
**Note**: the collection is bound to `pagehide` (navigation away / bfcache entry), not to
"tab hidden" — switching tabs does not kill a plugin.

## Full example

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

## UI injection ctx.ui.registerPanel

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

The built-in slots are exactly `ctx.ui.slots`, whose value is
`['plugins.page', 'settings.plugins', 'dashboard.widgets']`; a host page receives injections by
placing `<PluginSlot slot-name="…" />` at the matching position.

## Constraints & trust

- **Self-contained**: no bare imports of `vue` or other third-party packages (the browser's native
  import cannot resolve them) — build UI with native DOM (`ctx.el`);
- **Trust model**: client scripts are served by platform endpoints, trusted at the same level as
  aw commands — only install plugins you trust;
- **Isolation**: a single plugin failing to load only logs a console warning; the app and other
  plugins are unaffected.
