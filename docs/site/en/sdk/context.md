# Plugin context (ctx)

`setup(ctx)` receives the host-injected context. Plugins never import the SDK — everything
arrives through `ctx`, which mirrors the plugin's declared permissions.

## Surface overview

| Member | Purpose |
|---|---|
| `ctx.log` | scoped logger writing into the platform log stream |
| `ctx.config` | plugin config from the plugin manifest (hot values) |
| `ctx.permissions` | permission-aware view (`lineMode`, `visibleLineIds`, `filterByLine`) — plugins see what the calling user may see |
| `ctx.http` | pre-configured REST client (auth + envelope handled) |
| `ctx.events` / `ctx.hooks` | lifecycle events (see [Lifecycle](/en/sdk/lifecycle)) |
| `ctx.routes` | register the plugin's own API routes (mounted under `/api/plugins/<name>/…`) |
| `ctx.kv` | small plugin KV store, flushed on dispose |
| `ctx.omp.registerTool` | register a custom agent tool — hot-injected into every running session on registry change |
| `ctx.daq.registerDriver / registerProcessor / registerTemplate` | custom acquisition drivers, sink processors and node templates |
| `ctx.dcw` | observe/audit write-control traffic (`dcw:write` hook) |
| `ctx.scene` | broadcast platform scene events |

## Minimal plugin

```js
export default {
  name: 'my-plugin',
  setup(ctx) {
    ctx.log.info('hello from my-plugin')
    ctx.omp.registerTool({
      name: 'my_tool',
      description: 'does something useful',
      parameters: { type: 'object', properties: {} },
      handler: async (args) => ({ text: 'result' }),
    })
  },
}
```

Drop the folder into the config root's `plugins/` directory (project-level) or
`~/.AgentWorkShop/plugins/` (user-level) — it is loaded on the next start, and hot
re-registers tool/driver changes on file change.
