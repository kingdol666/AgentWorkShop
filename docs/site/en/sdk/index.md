# SDK overview — the client for the platform

The SDK is AgentWorkShop's **programming client and extension base**: external projects
consume the platform REST surface through it, and plugins receive the host-injected runtime
context through it. Zero third-party runtime dependencies; works on Node ≥ 23.4 and modern
browsers.

## Two identities, one SDK

| Identity | Form | Role of the SDK |
|---|---|---|
| **External integrator** | regular dependency | call `createPlatformClient()` to consume the platform REST surface |
| **Plugin author** | exports `{ name, setup(ctx) }` | `ctx` is the host-injected SDK context — zero imports |

> Why don't plugins import the SDK directly? Globally installed plugin directories are outside
> the node_modules resolution chain, so host injection is the only zero-pitfall shape
> (the same paradigm as VSCode's `activate(context)`).

## Install & import

```bash
npm install -g agentworkshop     # global (CLI + platform)
npm install agentworkshop        # or as a dependency of your project
```

```js
import { createPlatformClient, definePlugin, HookBus } from 'agentworkshop/sdk'
import { createClientContext } from 'agentworkshop/sdk/client'   // browser only
```

## Import paths and version

`package.json` exposes exactly four `exports` entries; deep paths (such as
`agentworkshop/sdk/api.mjs`) are not exported and importing one throws
`ERR_PACKAGE_PATH_NOT_EXPORTED`.

| Import | Resolves to | Contents |
|---|---|---|
| `agentworkshop` | `sdk/index.mjs` | **Exactly the same facade** as `agentworkshop/sdk` |
| `agentworkshop/sdk` | `sdk/index.mjs` | The whole facade (server + browser + REST client + types) |
| `agentworkshop/sdk/client` | `sdk/client.mjs` | Browser only (`createClientContext`) |
| `agentworkshop/package.json` | `package.json` | Package metadata |

**Version**: the SDK ships its own constants `SDK_VERSION = '0.3.0'` (server) and
`CLIENT_SDK_VERSION = '0.3.0'` (browser). They are the **interface version of the SDK itself** and
evolve **independently** from the npm package version (currently 0.7.36) — being out of sync is
expected.

`index.d.mts` / `client.d.mts` type declarations ship with the package, so TypeScript projects get
IntelliSense with zero configuration (see §7 of the [full guide](/en/sdk/guide) for the current
coverage).

## Quick example: integrate a line from an external project

```js
import { createPlatformClient } from 'agentworkshop/sdk'

const api = createPlatformClient({ baseUrl: 'http://plant.local:3001' })
const { token } = await api.users.login('you@example.com', 'secret')
api.setToken(token)

await api.lines.create({ name: 'Line 1' })

// The line list is { lines, states }, not an array
const { lines } = await api.lines.list()
const line = lines[0]

// The DAQ node list is an object too — take .nodes
const { nodes } = await api.daqNodes.list()
console.log(`line ${line?.name ?? '(none)'}, ${nodes.length} nodes`)

// Line-grant surface (admin): overview() reads everything, set() writes in bulk
// const { lines: all, users } = await api.permissions.overview()
// await api.permissions.set({ userId: users[0].id, grants: [{ lineId: all[0].id, mode: 'readonly' }] })
```

## Quick example: a plugin (host-injected ctx)

```js
// ~/.AgentWorkShop/plugins/my-plugin/index.mjs —— zero imports
export default {
  name: 'my-plugin',
  auth: 'user',                 // declarative auth for plugin routes
  async setup(ctx) {
    const { lines } = await ctx.api.lines.list()                // platform REST client (no token by default)
    ctx.hooks.on('daq:sample', () => ctx.kv.bump('samples'))    // lifecycle hook
    ctx.events.on('daq.reading', r => ctx.logger.debug(r.nodeId))  // scene event (the event: prefix is added for you)
    ctx.route('GET', '/stats', () => ctx.kv.all())              // own API → /api/plugins/my-plugin/stats
  },
}
```

## In this section

- [Platform REST client](/en/sdk/api-client) — the full `createPlatformClient` API, real route support, response shapes
- [Plugin context (ctx)](/en/sdk/context) — the complete runtime surface, including the host-injected `permissions` / `daq` / `omp` / `services`
- [Lifecycle events](/en/sdk/lifecycle) — 11 server-side + 5 browser-side events with payloads and subscription rules
- [Browser-side SDK](/en/sdk/client) — `createClientContext`, UI injection and event subscription rules
- [Full guide](/en/sdk/guide) — everything on one page (the single source of truth)
