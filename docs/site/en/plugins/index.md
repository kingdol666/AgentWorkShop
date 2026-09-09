# Plugin guide

Plugins are folders dropped into the config root's `plugins/` directory. Each plugin is a
module exporting `{ name, setup(ctx) }` (or an array of such modules) plus an optional
`plugin.json` manifest declaring permissions and browser enhancements.

## Layout

```
plugins/
  my-plugin/
    plugin.json        # manifest (optional but recommended)
    index.mjs          # export default { name, setup(ctx) }
    browser.mjs        # optional browser enhancement
```

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "description": "what it does",
  "permissions": { "lines": "read", "dcw": "audit" },
  "browser": "browser.mjs"
}
```

## What plugins can do

| Surface | Examples |
|---|---|
| server hooks | `daq:sample`, `daq:frame`, `dcw:write`, `line:start/stop`, `scene:*` |
| custom DAQ drivers | `ctx.daq.registerDriver(kind, impl)` — joins the same registry as the built-in five protocols |
| custom sink processors | `ctx.daq.registerProcessor(key, fn)` — transform frames before storage |
| node templates | `ctx.daq.registerTemplate(def)` — appear in the create wizard |
| agent tools | `ctx.omp.registerTool(def)` — hot-injected into every running harness session |
| own API routes | `ctx.routes.post('/threshold', handler)` → `/api/plugins/my-plugin/threshold` |
| KV + log | `ctx.kv` (flushed on dispose), `ctx.log` (scoped logger) |

## Loading & lifecycle

- project-level plugins live in `<repo>/.AgentWorkShop/plugins/`, user-level in
  `~/.AgentWorkShop/plugins/`; project wins on name conflicts;
- the Plugins page in the UI shows manifests, enable/disable state and load errors;
- tool/driver/template registry changes hot-inject into running sessions — no restart;
- `dispose()` (if exported) runs on unload for cleanup.

## Hot management (`aw plugin` + the /plugins page)

```bash
aw plugin list                  # both scopes, with enable state
aw plugin create my-plugin      # scaffold (user scope by default; --project for the checkout)
aw plugin disable my-plugin     # writes plugins-state.json; the running server self-applies
aw plugin enable my-plugin
```

The state file is the config root's `plugins-state.json` (`{ version, updatedAt, disabled }`).
The CLI and the web /plugins page write the same file; on (re)load the server skips disabled
plugins (their manifest stays visible with `enabled: false`). Code edits still need a restart —
the state switch is not code hot-reload.

## Team-scoped plugin switches (channel × plugin)

Beyond the global switch, every team (channel) keeps its **own plugin switch set** backed by
the `channel_plugins` table:

- picked at **team creation** (checkboxes) or toggled later in the team dialog;
- semantics: no rows = unconfigured → every enabled plugin is visible to that team
  (backward compatible); once rows exist they filter — **a disabled plugin's tools are not
  injected into that team's agents and dispatch rejects them**, keeping unrelated teams clean;
- UI: the /workshop teams page (creation checkboxes + team dialog); REST: the plugins
  manifest endpoints plus per-team toggle API.

## Built-in example

The repository ships a `daq-vector-demo` (vector sink pipeline + template) and
`line-sentinel` (threshold watcher with its own API route) — see
[the real example](/en/plugins/example) for a complete walkthrough.
