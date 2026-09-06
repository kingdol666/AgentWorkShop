# The `aw` command manual

`aw` is the global CLI shipped with the npm package — it runs, configures and inspects the
platform from any directory.

## Core commands

| Command | Purpose |
|---|---|
| `aw dev` | development server (HMR, dev-guard) |
| `aw start` | production server (builds on first run; port from config.yml, auto-increments when busy) |
| `aw build` | `nuxt build` → `.output/` |
| `aw stop` | stop the running instance (single-instance lock) |
| `aw status` | runtime overview (version, mode, port, uptime) |
| `aw update` | check + update the global install (`--check` to report only) |
| `aw doctor` | environment diagnostics (node, ports, docker, config) |
| `aw config list/get/set/unset/reset` | the whole settings descriptor registry from the terminal |

## Global flags

- `--port N` — override the port (otherwise `config.yml` → `server.prod.port`, busy ports
  auto-increment);
- `AW_HOME` — redirect the user-level config root;
- `AW_MODE=home` — force home mode inside a source checkout.

## Custom commands

Drop a module into `<config-root>/commands/` (project or user level) and it joins the
command registry with three-layer precedence: project > user > built-in.
