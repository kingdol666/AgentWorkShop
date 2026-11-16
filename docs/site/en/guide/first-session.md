# Your first "agent × line" session (~2 minutes)

> For a first run, use an isolated simulator only: a fresh `AW_HOME`, independent platform/simulator ports and a `simulated=true` test line. Provisioning, starting a line, proposing a recipe and approving it change test data; do not use a shared simulator, unapproved real equipment or a production line. Follow the [line integration guide](/en/guide/line-integration) for setup.

1. **Sign in** — register on the test instance. The first account in a fresh isolated home becomes admin; do not create test accounts on shared or production instances.
2. **Prepare a simulated line** — build an independent simulator twin from a reviewed blueprint and connect it to a `simulated=true` test line as described in the [line integration guide](/en/guide/line-integration). Do not put real endpoints in the example configuration.
3. **Create a team and Session** — create an Agent/Channel; create integrated Sessions with a trusted product binding. A `generic` Channel does not gain line access from a `lineId` alone.
4. **Bind nodes** — bind DAQ and any required write-control/recipe nodes. Read-only bindings are for acquisition; Channel, line-master and binding modes jointly determine whether a write requires HITL.
5. **Submit a goal** — on the simulated test line, request analysis of the last five minutes of temperature; if a change is warranted, submit a recipe candidate rather than a direct device write.
6. **Check the result** — handle HITL only when policy requires it and only after confirming the target is this isolated simulator. Reconcile DCW readback, subsequent DAQ samples and the journal. A simulated pass is not physical HIL or production acceptance.

## What actually happens

```text
goal → integrated Channel / product-bound Session → line_context and memory search
     → scalar DAQ or frame read → recipe_propose → HITL when effective policy requires it
     → simulator readback / DAQ response / journal reconciliation
```

## Verify from the CLI

```bash
aw config get server.prod.port          # where the port comes from
aw status                               # runtime overview
aw plugin enable line-sentinel          # example plugins are disabled by default: enable first, or its routes are never registered
curl -X POST http://localhost:3001/api/plugins/line-sentinel/threshold \
  -H 'content-type: application/json' -d '{"threshold":100}'   # plugin API (the line-sentinel example plugin)
```

> First-start bootstrap seeds the example plugins (`line-sentinel` / `ops-notifier` /
> `sample-insight`) into `~/.AgentWorkShop/plugins` and records them as **disabled** in
> `plugins-state.json`; a disabled plugin's routes are not registered at all, so the curl
> above 404s until you run `aw plugin enable line-sentinel` (hot reload lands in about 1 s).
> Plugin scope precedence is builtin > project > user; `aw plugin create` lands in the
> project scope by default and `--global` / `-g` selects the user scope.
