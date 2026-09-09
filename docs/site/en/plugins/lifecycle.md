# Plugin lifecycle

From folder to running feature:

```
discovery → module validation → disabled check → load module → setup(ctx)
        → route mounting → tool/driver/template registration → hot-reload watch → dispose
```

## Stages

1. **Discovery** — both config roots are scanned; project-level wins on name conflicts;
2. **Validation** — the `index.mjs` export is shape-checked (`{ name, setup(ctx) }` plus
   optional `version` / `description` / `client` / `routes`); malformed modules are
   reported as load failures, not silently dropped;
3. **Disabled check** — names in the config root's `plugins-state.json` are skipped at
   load (they stay visible on the Plugins page with `enabled: false`);
4. **Load & setup** — `setup(ctx)` runs; throw here and the plugin is marked failed while
   the platform keeps booting;
5. **Registration** — tools/drivers/processors/templates join their registries; agent
   tools are hot-injected into every running harness session on registry change;
6. **Hot reload** — tool/driver/template registry changes re-inject without restart;
7. **Dispose** — `ctx.onDispose` registrations and `ctx.timer` handles are collected on
   server close (KV state flushed as the plugin runs).

## Failure semantics

- a plugin can never break sampling, write control or agent dispatch — hook errors are
  contained and counted;
- repeated failures degrade the plugin (failure counter resets after successes;
  8 consecutive failures trip the circuit breaker and remove the listener);
- the Plugins page shows per-plugin state (active / disabled / failed with reason) and
  the ops log records load/unload events.
