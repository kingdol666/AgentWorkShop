# Lifecycle events

Plugins subscribe through `ctx.hooks.on(event, handler)` and return optionally — thrown
errors are contained by the platform and never break the main path.

## Server-side events

| Event | Payload highlights | Use |
|---|---|---|
| `daq:sample` | node snapshot after a sample lands | inline enrichment, thresholds |
| `daq:frame` | vector/image frame envelopes | custom sinks and derived metrics |
| `daq:alarm` | alarm raised/recovered | paging, webhook fan-out |
| `dcw:write` | write outcome (node, eng, prev, ok, source, lineId) | audit mirrors, downstream sync |
| `line:start` / `line:stop` | active run (product/recipe/run) | batch bookkeeping |
| `scene:*` | full platform scene stream (node changed, tasks, members…) | twin/panel sync |

## Ordering & guarantees

- handlers run sequentially per event; a slow handler delays that event only;
- failures are logged with the plugin name and contained — the platform's write path and
  sampling never depend on plugin success;
- `HookBus` failure counters reset after successes (flapping plugins degrade gracefully).

## Example

```js
ctx.hooks.on('dcw:write', (e) => {
  if (!e.ok) ctx.log.warn(`write failed on ${e.nodeId}: ${e.message}`)
})
```
