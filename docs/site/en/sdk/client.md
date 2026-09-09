# Browser-side SDK (createClientContext)

A plugin's `client.mjs` is a **self-contained ESM module** (no bare imports — the browser
loads it natively) exporting `setup(ctx)`. At app startup the loader
(`app/plugins/aw-plugins.client.ts`) fetches the plugin manifest and injects each script;
events come from the same source as the browser WebSocket.

## Creation (host-invoked; plugins only write `setup`)

```js
import { createClientContext } from 'agentworkshop/sdk/client'

const ctx = createClientContext({
  name: 'my-plugin',
  eventBridge: (dispatch) => townBus.subscribe((e) => dispatch(e.type, e.payload)),
  baseUrl: '',   // same-origin; fill in the platform address for cross-origin integration
})
```

## ctx members

| Member | Notes |
|---|---|
| `ctx.on(type, fn)` | Subscribe to **live scene events** (same source as the browser WS): `daq.reading` / `daq.frame` / `device.updated` / `ops.log` / `task.status` … (internally rewired to `event:<type>`; `'*'` wildcard). Returns an unsubscribe fn, **auto-collected on pagehide**. Note: colon-named hooks such as `daq:sample` are **server-side only** — the client never receives them |
| `ctx.fetch(path, opt?)` | Same-origin platform API (JSON; unwraps the `{data}` envelope; throws on non-2xx; carries the cookie token automatically) |
| `ctx.el(tag, attrs, children)` | DOM builder (`style`/`class`/`on*` attrs get special handling) |
| `ctx.root()` | The plugin's private mount point `#aw-plugin-<name>` (bottom-right, lazily created) |
| `ctx.mount(target, node)` | Mount into any selector/element (falls back to root when missing) |
| `ctx.hooks` | Local HookBus: `client:init` / `page:change` / `client:destroy` subscribe **here directly** (no `event:` prefix); scene events go through `ctx.on` |
| `ctx.log` | Prefixed console (info/warn/error) |
| `ctx.dispose()` | Unload: collects all subscriptions + clears mount points + broadcasts `client:destroy` (idempotent; also triggered when the page is hidden) |

## Full example

```js
export function setup(ctx) {
  const badge = ctx.el('div', {
    style: 'padding:8px 12px;border:1px solid #35e0a0;border-radius:10px;color:#35e0a0',
  }, ['⌁ 0'])
  ctx.root().append(badge)

  let n = 0
  ctx.on('daq.reading', () => { badge.textContent = `⌁ ${++n}` })   // scene event

  ctx.hooks.on('page:change', ({ path }) => ctx.log.info('page →', path))   // page lifecycle

  // Consume the platform API (same-origin; cookie-authenticated)
  ctx.fetch('/api/workshop/dcw/lines').then(d => ctx.log.info('lines', d.length))
}
```

## Constraints & trust

- **Self-contained**: no bare imports of `vue` or other third-party packages (the browser's
  native import cannot resolve them) — build UI with native DOM (`ctx.el`);
- **Trust model**: client scripts are served by platform endpoints, trusted at the same level
  as aw commands — only install plugins you trust;
- **Isolation**: a single plugin failing to load only logs a console warning; the app and
  other plugins are unaffected.
