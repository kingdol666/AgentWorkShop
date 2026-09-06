# Getting started

## Prerequisites

```bash
node -v   # ≥ 23.4.0 (built-in node:sqlite required)
```

> The `omp` harness (recommended for real agent work) expects the `omp` CLI on PATH;
> the `mock` harness works out of the box. Optional DAQ infrastructure (MQTT broker +
> TimescaleDB) is started automatically via `docker compose up -d` when reachable.

## Option A — install from npm (recommended)

```bash
npm install -g agentworkshop     # → `aw` / `agentworkshop` on PATH
aw start                         # first run builds once (2–3 min) → http://localhost:3001
```

The first start initializes everything into the **`~/.AgentWorkShop`** config root:
default `config.yml`, `.env` with a generated session secret, `runtime-settings.json`,
docker-compose seeds and an empty `data/` directory. All runtime data (SQLite / JSON
repos / backups / logs) lives in the config root — **config and data follow the install,
not your working directory**.

Just want to try it once?

```bash
npx agentworkshop start          # runs in place, nothing left behind
```

## Option B — from source

```bash
git clone https://github.com/kingdol666/AgentWorkShop.git && cd AgentWorkShop
pnpm install
pnpm dev          # → http://localhost:3000 (port from config.yml)
```

Production (from source):

```bash
pnpm build        # nuxt build → .output/
pnpm start        # port from config.yml → server.prod.port
```

> Inside a source checkout the config root is the project-local **`.AgentWorkShop/`**
> folder (runtime overrides / data / project plugins), while `config.yml` / `.env` stay
> at the checkout root as versioned factory defaults.

## Updating

```bash
aw update                              # check + update in place
aw update --check                      # report only
npm install -g agentworkshop@latest    # manual equivalent
```

Versions follow semver; every `aw start` validates the config root and migrates in place
when a release changes its layout — **upgrades never lose data**. (npmmirror mirrors the
official registry with a delay; add `--registry https://registry.npmjs.org` for the
freshest version.)

## Next steps

- [Configuration](/en/guide/configuration) — four-layer precedence and the config root
- [Your first agent × line session](/en/guide/first-session) — the full chain in 2 minutes
- [Five-protocol DAQ & control](/en/guide/daq-protocols) — Modbus/OPC UA/MQTT/HTTP drivers
- [Recipe versioning](/en/guide/recipe-versions) — attributed history and rollback
- [SDK guide](/en/sdk/) — consume the platform from code
- [Plugin development](/en/plugins/) — extend front and back
