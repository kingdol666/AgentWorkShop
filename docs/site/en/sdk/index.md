# SDK overview — the client for the platform

The SDK is AgentWorkShop's **programming client and extension base**: external projects
consume the platform REST surface through it, and plugins receive the host-injected
runtime context through it. Zero third-party runtime dependencies; works on Node ≥ 23.4
and modern browsers.

## Two identities, one SDK

| Identity | Form | Role of the SDK |
|---|---|---|
| External integrator | regular dependency | call `createPlatformClient()` to consume the platform REST surface |
| Plugin author | export `{ name, setup(ctx) }` | `ctx` is the host-injected SDK context — zero imports |

> Why don't plugins import the SDK directly? Globally installed plugin directories are
> outside node_modules resolution; host injection is the only zero-pitfall shape
> (same paradigm as VSCode's `activate(context)`).

## Install & import

```bash
npm install -g agentworkshop     # global (CLI + platform)
npm install agentworkshop        # or as a dependency of your project
```

```js
import { createPlatformClient, definePlugin, HookBus } from 'agentworkshop/sdk'
import { createClientContext } from 'agentworkshop/sdk/client'   // browser only
```

`index.d.mts` type declarations ship with the package — TypeScript projects get full
IntelliSense with zero configuration.

## Quick example: integrate a line from an external project

```js
import { createPlatformClient } from 'agentworkshop/sdk'

const api = createPlatformClient({ baseUrl: 'http://plant.local:3001' })
const { token } = await api.users.login('you@example.com', 'secret')
api.setToken(token)

await api.lines.create({ name: 'Line 1' })
await api.lines.start((await api.lines.list())[0].id)
```

## In this section

- [Platform REST client](/en/sdk/api-client) — surfaces and error semantics
- [Plugin context (ctx)](/en/sdk/context) — what the host injects
- [Lifecycle events](/en/sdk/lifecycle) — HookBus and event names
- [Browser-side SDK](/en/sdk/client) — `createClientContext`
- [Full guide](/en/sdk/guide) — everything on one page
