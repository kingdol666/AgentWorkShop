# Plugin lifecycle

From folder to running feature:

```
discovery → manifest parse → permission check → load module → setup(ctx)
        → route mounting → tool/driver/template registration → hot-reload watch → dispose
```

## Stages

1. **Discovery** — both config roots are scanned; project-level wins on name conflicts;
2. **Manifest** — `plugin.json` declares permissions and the browser enhancement;
   malformed manifests are reported on the Plugins page, not silently dropped;
3. **Permission check** — declared grants are validated against the host capability set;
4. **Load & setup** — `setup(ctx)` runs; throw here and the plugin is marked failed while
   the platform keeps booting;
5. **Registration** — tools/drivers/processors/templates join their registries; agent
   tools are hot-injected into every running harness session on registry change;
6. **Hot reload** — tool/driver/template registry changes re-inject without restart;
7. **Dispose** — `dispose()` cleans up (KV flush, timers, connections).

## Failure semantics

- a plugin can never break sampling, write control or agent dispatch — hook errors are
  contained and counted;
- repeated failures degrade the plugin (failure counter resets after successes);
- the Plugins page shows per-plugin state (active / disabled / failed with reason) and
  the ops log records load/unload events.
