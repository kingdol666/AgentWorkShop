# Getting started

## Prerequisites

```bash
node -v   # ≥ 23.4.0 (built-in node:sqlite required)
```

> Real agent work needs an execution engine. **14 engines** ship with the platform, in three
> transport classes: in-process (`mock` / `claude`), persistent session
> (`omp` / `codex` / `dsh` / `qwen` / `hermes` / `opencode`) and headless CLI (`gemini` /
> `copilot` / `cursor` / `crush` / `goose` / `pi`). `mock` works out of the box; the rest
> need their CLI on PATH (or, for `claude`, the SDK dependency) — see
> [multi-harness agent teams](/en/guide/multi-harness) for selection and credentials.
> Optional DAQ infrastructure (MQTT broker + TimescaleDB) is started automatically via
> `docker compose up -d` when reachable.

## Option A — install from npm (recommended)

```bash
npm install -g agentworkshop     # → `aw` / `agentworkshop` on PATH
aw start                         # the published tarball ships a prebuilt .output/ → http://localhost:3001
```

The tarball published to npm already contains the production build (`prepublishOnly` builds
once before packing), so `aw start` from an npm install **does not rebuild** and needs no
`pnpm install`. Only a **source checkout** without `.output/` builds once on first start
(about 2–3 minutes).

The first start initializes everything into the **`~/.AgentWorkShop`** config root:
default `config.yml`, `.env` with a generated session secret, `runtime-settings.json`,
docker-compose seeds and an empty `data/` directory. All runtime data (SQLite / JSON
repos / backups / logs) lives in the config root — **config and data follow the install,
not your working directory**.

Just want to try it once?

```bash
npx agentworkshop start          # runs without installing (it still bootstraps the ~/.AgentWorkShop config root)
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
