# Configuration

One runtime, one source of truth. **`config.yml`** declares defaults; the
**`runtime-settings.json`** inside the config root carries runtime overrides; environment
variables and CLI flags sit on top. Every editable key is declared once in
`shared/config/schema.json` (type/range/enum/effect) — **the web settings page and the
`aw` CLI consume the same descriptor registry**.

```
config.yml (defaults)  <  .AgentWorkShop/runtime-settings.json (runtime)  <  env (AW_* / PORT / HOST)  <  CLI flags
```

## Config root (two modes)

| Run mode | Config root | Factory config.yml / .env |
|---|---|---|
| Source checkout (repo mode) | `<repo>/.AgentWorkShop` | `<repo>/config.yml` (git-versioned) |
| Global install (home mode) | `~/.AgentWorkShop` (redirect with `AW_HOME`) | `~/.AgentWorkShop/config.yml` (seeded on first start) |

Inside the root: `runtime-settings.json`, `data/` (SQLite / JSON repos / backups),
`logs/`, `commands/` (custom commands) and `plugins/`.

## CLI

```bash
aw config list                       # 73 settings (16 groups): effective value + source + effect
aw config get server.prod.port       # single key (value + source)
aw config set server.prod.port 8080  # schema-validated, atomic write
aw config set theme.primaryColor '#41c8f4'
aw config unset server.prod.port     # drop the override, fall back to config.yml
aw config reset --yes                # clear all runtime overrides
```

Every live key hot-reloads where semantics allow; restart-required keys are flagged in
both the settings UI and the CLI output.
