# Lifecycle events

Plugins subscribe through `ctx.hooks.on(event, handler)` and return optionally — thrown
errors are contained by the platform and never break the main path. The authoritative
list is the SDK-exported `LIFECYCLE_EVENTS` (`sdk/lifecycle.mjs`).

## Server-side events

| Event | Payload highlights | Use |
|---|---|---|
| `plugin:host:init` | `{ plugins, failures }` after the host loads all plugins | readiness, deferred init |
| `daq:sample` | node snapshot after a sample lands | inline enrichment, thresholds |
| `daq:frame` | vector/image frame envelopes (no pixel blobs) | custom sinks and derived metrics |
| `dcw:write` | write outcome (node, eng, prev, ok, source, lineId) | audit mirrors, downstream sync |
| `line:start` / `line:stop` | active run (product/recipe/run) | batch bookkeeping |
| `permissions:changed` | `{ userId }` after line grants change | refresh cached grant views |
| `config:changed` | `{ at }` when runtime settings change | re-read `ctx.config` |
| `scene:*` | full platform scene stream (node changed, tasks, members…) | twin/panel sync |
| `server:close` | `{ at }` after per-plugin dispose queues ran | final flush |

## Ordering & guarantees

- handlers run sequentially per event; a slow handler delays that event only;
- failures are logged with the plugin name and contained — the platform's write path and
  sampling never depend on plugin success;
- `HookBus` failure counters reset after successes (flapping plugins degrade gracefully).

## Example

```js
ctx.hooks.on('dcw:write', (e) => {
  if (!e.ok) ctx.logger.warn(`write failed on ${e.nodeId}: ${e.message}`)
})
```
