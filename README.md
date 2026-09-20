<div align="center">

<img src="https://raw.githubusercontent.com/kingdol666/AgentWorkShop/main/docs/readme-assets/hero.png" alt="AgentWorkShop — agent teams driving a real production line" width="100%" />

<br />

# AgentWorkShop

**Where AI agent teams meet the production line.**

[![npm version](https://img.shields.io/npm/v/agentworkshop?logo=npm&logoColor=white&label=npm&color=CB3837)](https://github.com/kingdol666/AgentWorkShop)
[![npm downloads](https://img.shields.io/npm/dm/agentworkshop?logo=npm&logoColor=white&label=downloads&color=CB3837)](https://github.com/kingdol666/AgentWorkShop)
[![GitHub release](https://img.shields.io/github/v/release/kingdol666/AgentWorkShop?logo=github&label=release&color=35e0a0)](https://github.com/kingdol666/AgentWorkShop/releases)
[![Stars](https://img.shields.io/github/stars/kingdol666/AgentWorkShop?logo=github&label=stars&color=35e0a0)](https://github.com/kingdol666/AgentWorkShop/stargazers)
[![Last commit](https://img.shields.io/github/last-commit/kingdol666/AgentWorkShop?logo=git&logoColor=white&label=last%20commit)](https://github.com/kingdol666/AgentWorkShop/commits)
[![Issues](https://img.shields.io/github/issues/kingdol666/AgentWorkShop?logo=github&label=issues)](https://github.com/kingdol666/AgentWorkShop/issues)
[![License](https://img.shields.io/badge/license-PolyForm%20Noncommercial%201.0.0-8A2BE2?logo=openaccess&logoColor=white)](./LICENSE)

[![Nuxt 4](https://img.shields.io/badge/Nuxt-4-00DC82?logo=nuxt&logoColor=white)](https://nuxt.com)
[![Vue 3.5](https://img.shields.io/badge/Vue-3.5-42B883?logo=vuedotjs&logoColor=white)](https://vuejs.org)
[![TypeScript 5.7](https://img.shields.io/badge/TypeScript-5.7-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Node ≥ 23.4](https://img.shields.io/badge/Node.js-%E2%89%A5%2023.4-3C873A?logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![SQLite node:sqlite](https://img.shields.io/badge/SQLite-node%3Asqlite-003B57?logo=sqlite&logoColor=white)](https://nodejs.org/api/sqlite.html)
[![Modbus · OPC UA · MQTT · HTTP](https://img.shields.io/badge/field%20bus-Modbus%20%C2%B7%20OPC%20UA%20%C2%B7%20MQTT%20%C2%B7%20HTTP-41c8f4?logo=siemens&logoColor=white)](./docs/site/guide/daq-protocols.md)
[![Plugins](https://img.shields.io/badge/plugins-hot%20reload-8b5cf6?logo=puzzle&logoColor=white)](./docs/plugins.md)
[![Docs](https://img.shields.io/badge/docs-VitePress%20%C2%B7%20%E4%B8%AD%2FEN-ffd75e?logo=vitepress&logoColor=black)](https://kingdol666.github.io/AgentWorkShop)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-ff69b4?logo=git&logoColor=white)](https://github.com/kingdol666/AgentWorkShop/pulls)

**[简体中文](./README-zh.md)** · **[Documentation](https://kingdol666.github.io/AgentWorkShop)** · **[Releases](https://github.com/kingdol666/AgentWorkShop/releases)** · **[Changelog](./changelog.md)** · **[Plugin API](./docs/plugins.md)** · **[SDK](./docs/sdk.md)**

<sub><b>v0.7.42</b> · 14 agent engines · 6 field protocols · 99 runtime settings · bilingual docs (简体中文 / English)</sub>

<br />

*A configuration-driven platform where **AI agent teams** and an **industrial digital twin** share one runtime — agents query real telemetry, issue supervisory setpoints through human-approved write control, and every event streams live to a 3D twin.*

</div>

> [!IMPORTANT]
> **Positioning: supervisory layer.** AgentWorkShop is a *supervisory* (SCADA-adjacent) layer for production-line management, digital twins, DAQ and agent orchestration, operating at **second-level soft real-time**.
> It is **not** a hard real-time controller: any time-critical loop (**< 10 ms**, interlocks, safety, servo) **must live inside the PLC**. Setpoints written here are advisory — plant-side logic may veto.

---

<table>
<tr>
<td width="33%" valign="top">

**FIGURE INDEX**

`FIG.01` closed loop ·<br/>
`FIG.02` DAQ console ·<br/>
`FIG.03` line operations ·<br/>
`FIG.04` digital twin ·<br/>
`FIG.05` dashboard ·<br/>
`FIG.06` responsive

</td>
<td width="33%" valign="top">

**JUMP TO**

[What is this?](#what-is-this) · [Highlights](#highlights)<br/>
[Interface](#the-interface) · [Architecture](#architecture)<br/>
[Quick start](#quick-start) · [Configuration & CLI](#configuration--cli--config-driven-by-design)<br/>
[Industrial stack](#the-industrial-stack-in-detail) · [Usage](#usage)<br/>
[Verification](#verified-end-to-end) · [Project layout](#project-layout)<br/>
[Tech stack](#tech-stack) · [Development](#development)<br/>
[Roadmap](#roadmap) · [License](#license)

</td>
<td width="33%" valign="top">

**AT A GLANCE**

Supervisory layer, second-level soft real-time<br/>
14 harness engines · 4 entry points<br/>
6 field protocols (5 built-in + serial plugin, read + write)<br/>
7-state task machine · FTS5 + vector memory<br/>
Hot-reloadable plugins · SDK · CLI · TUI

</td>
</tr>
</table>

---

## Documentation

Docs are bilingual — the [VitePress site](https://kingdol666.github.io/AgentWorkShop) ships a language switcher (简体中文 / English) across every section. Deep-dive pages ship in this repo too, and the CLI copies them into the published tarball:

| Topic | Online | In-repo | What it covers |
|---|---|---|---|
| **Getting started** | [Guide](https://kingdol666.github.io/AgentWorkShop/guide/getting-started) | `docs/site/guide/` | install → first run → first agent × line session, configuration, DAQ protocols, DCW read/write, HITL, recipe versioning, multi-harness teams, line permissions, AML |
| **Plugin development** | [Plugin guide](https://kingdol666.github.io/AgentWorkShop/plugins/) | [`docs/plugins.md`](./docs/plugins.md) | the full extension contract: three scopes, `index.mjs` manifest, `ctx` server/browser surface, `settings`/`groups` declarations, lifecycle events, i18n, panels, team-scoped switches, a real example |
| **SDK** | [SDK guide](https://kingdol666.github.io/AgentWorkShop/sdk/) | [`docs/sdk.md`](./docs/sdk.md) | `agentworkshop/sdk` as a programming client (platform REST client with envelope handling) and as the plugin extension base; TypeScript types; browser-side SDK |
| **CLI** | [CLI manual](https://kingdol666.github.io/AgentWorkShop/cli/) | [`docs/cli.md`](./docs/cli.md) | all 14 `aw` commands, global options, exit codes, dual-mode path model, the command-registration system, maintainer publish guide |
| **AML** | [AML guide](https://kingdol666.github.io/AgentWorkShop/guide/aml) | [`docs/aml.md`](./docs/aml.md) | auto-modeling lab: dataset build, job orchestration, model registry, promotion gates, agent tools |
| **TUI** | — | [`docs/tui.md`](./docs/tui.md) · [`tui/README.md`](./tui/README.md) | terminal workbench: channels, agents, tasks, live monitor, HITL answering |
| **Multi-harness architecture** | — | [`docs/multi-harness-architecture.md`](./docs/multi-harness-architecture.md) | engine taxonomy, normalized session contract, provider/model catalog, failure modes |

---

## What is this?

AgentWorkShop started as a **multi-agent software workshop** — channels of coding agents with a lead-agent scheduler, a 7-state task machine, persistent memory, and four interoperable entry points (WebSocket / MCP / A2A / REST).

It grew an **industrial half**: a full data-acquisition and write-control stack (Modbus TCP / OPC UA), production lines with recipes and batch runs, a 3D digital-twin town, an **auto-modeling lab** (dataset → training job → leaderboard → gated promotion) — and the bridge that makes it unique: **agents can be granted bound, permission-scoped access to real industrial nodes**, query their live telemetry with physical semantics attached, and drive write operations through an interlock → human-in-the-loop → readback pipeline.

It is also **extensible by design**: a self-contained plugin can enhance the server (hooks, routes, agent tools, DAQ drivers, config groups) and the browser (panels, i18n) at the same time, and the same surfaces are available to ordinary programs through the SDK — see [`docs/plugins.md`](./docs/plugins.md) and [`docs/sdk.md`](./docs/sdk.md).

The result: submit a goal like *"analyze the melt temperature trend and optimize the setpoint"* — and an agent team reads real sensor history, computes statistics, proposes a new setpoint, waits for your approval in the HITL panel, writes it to the PLC, verifies the readback, and reports the numbers back. **End to end, verified by automated E2E.**

<div align="center">

### FIG.01 — The closed loop

<img src="https://raw.githubusercontent.com/kingdol666/AgentWorkShop/main/docs/readme-assets/fig-01-closedloop.gif" alt="An agent team reads live telemetry, proposes a setpoint, waits for approval, writes to the PLC and verifies the readback" width="88%" />

<sub><b>Goal → read → compute → approve → write → readback → report.</b><br/>
Recorded against a running instance: real DAQ history, real write control, real HITL approval.</sub>

</div>

> [!NOTE]
> Every figure in this README is a recording or screenshot of a **running** instance — not a mockup. The numbers on screen come from seeded industrial data flowing through the same code paths the product ships.

<div align="center">

### 🎬 Live demo (4 min 11 s, English voice-over & captions)

<a href="https://github.com/kingdol666/AgentWorkShop/blob/main/docs/site/public/demo/agentworkshop-demo.mp4"><img src="docs/site/public/demo/poster.jpg" alt="AgentWorkShop live demo: DAQ console, governed write + read-back, serial protocol plugin, agent team execution, closed-loop trend and the 3D digital twin" width="86%" /></a>

<sub><b>Click the cover to watch the full demo.</b> Real PLC simulator, real serial-port enumeration, real agent-team execution — no cuts, no fakes.<br/>Scenes: dashboard → live DAQ → governed write & read-back → serial protocol plugin → agent team execution → closed-loop trend → 3D digital twin.</sub>

</div>

---

## Highlights

#### Agent team runtime

| Capability | Why it matters |
|---|---|
| **Lead-agent orchestration** | Each channel has one lead: decomposes goals, dispatches to idle workers, reassigns failures, judges goal satisfaction. LLM decisions with a deterministic rule-engine fallback — the system never stalls. |
| **Three execution modes** | `goal` (satisfaction judging) · `loop` (fixed-interval replay) · `pipeline` (ordered stages). 7-state task machine with progress, artifacts and full history. |
| **Harness-agnostic** | One `AgentInterface`, **14 engines** in three transport classes: **in-process** — `mock` (no LLM), `claude` (Claude Agent SDK, resident session, same-turn steer); **persistent session over a protocol** — `omp` (RPC subprocess), `codex` (app-server JSON-RPC), `dsh` / `qwen` / `hermes` (ACP), `opencode` (serve + HTTP/SSE); **headless CLI with a structured event stream** — `gemini` (stream-json), `copilot` (JSONL), `cursor` (stream-json), `crush` (non-interactive run), `goose` (stream-json), `pi` (`-p --mode json`). The platform never knows which one runs. |
| **Per-channel LLM selection** | Each channel picks a **harness → provider → model (+effort)** triple from the harness's live catalog (e.g. `zhipu-coding-plan/glm-5.3-flash` on omp). Members inherit it unless they override — mixing harnesses in one team is a first-class setup, not a workaround. |
| **Harness availability check** | `GET /api/workshop/harnesses` probes each engine's CLI on PATH. The UI disables not-installed engines, and dispatch is hard-checked at every entry point. |
| **Stall-safe supervision** | Task reclaim distinguishes *stuck* from *slow*: the watchdog treats agent tool invocations as a liveness signal, so healthy long-running industrial work survives while genuinely stalled tasks surface to the lead. |
| **Persistent memory** | Private + channel-shared domains; FTS5 with CJK segmentation, optional vector hybrid recall, token-budgeted injection; team chronicle and idle reflections keep accumulating. |
| **Four entry points** | One manager behind every door: **WS** (AEP v1 event stream with seq-resume), **MCP** (~25 in-process tools), **A2A** (JSON-RPC 2.0 + AgentCard), **REST**. |

#### Industrial stack

| Capability | Why it matters |
|---|---|
| **Six field protocols** | Modbus TCP, Modbus RTU-over-TCP (serial gateway), OPC UA, MQTT and HTTP/REST, plus a **built-in serial plugin** (direct RS-232/485: Modbus RTU + ASCII line) — acquisition **and** write-control drivers with connection pools, classified error messages and per-driver connection tests. `mock` covers demos/CI. Protocols are plugins: `ctx.daq.registerDriver` / `ctx.dcw.registerWriteDriver` inject straight into the frontend protocol dropdown and dynamic forms (⌁ badge), zero frontend changes. |
| **Agent teams, industrial scope** | Agents bind to DAQ/DCW nodes and see semantic cards — physical meaning, units, safe range, recipe window — never raw registers. |
| **Human-approved write control** | DCW writes flow through **safe-range ∩ recipe-window** interlock → optional **HITL approval** → PLC write → **readback verification** → signed write history. |
| **Read-write DCW channels** | Every control node also **reads its PLC value back** through the same calibration path it writes with: periodic + on-demand + agent reads surface **SET vs ACT** side by side — passive observation, never blocked by write interlocks. |
| **Recipe versioning & governance** | Parameter changes are versioned with attribution (user/agent/system + operator + reason). Roll back to any revision or the last-good batch — non-destructively. Stale-node params are skipped and clearly marked. |
| **Line operations** | Lines → products → recipes → batch runs. Recipe windows gate acquisition and interlock writes; every sample is tagged `product/recipe/run` for per-batch isolation. |
| **Multi-modal DAQ frame pipeline** | Multi-point profiles (thickness/scanner) and CCD image frames flow through template sink pipelines: vectors & metadata into Timescale (`daq_frames`), pixels into object storage (MinIO, auto disk fallback); derived-metric thresholds ride the existing alarm chain. |
| **Agent self-audit tools** | `line_context`, `ops_log`, `recipe_log`, `recipe_versions`, `dcw_journal` — agents see exactly which line/product/recipe they control, who did what, and how every value changed. |

#### Governance, configuration & extension

| Capability | Why it matters |
|---|---|
| **Line-level permissions** | Industrial data is gated **per production line** with three states (none / read-only / operate), enforced in the data plane — regular users see no line data until granted. |
| **Full-operation audit log** | Every user / agent / system action lands in one queryable log; operators are attributed to "Channel/Member", distinct from users and the system. Streamed live over WS. |
| **Team-scoped plugin switches** | Each team (channel) keeps an **independent plugin switch set** (`channel_plugins`): a disabled plugin's tools are not injected into that team's agents. Plugins themselves are hot-managed via `aw plugin` and the `/plugins` page. |
| **Plugin extension API** | A self-contained directory under `plugins/<name>/` enhances **both halves at once**: `index.mjs` (server: hooks, routes, agent tools, **DAQ read drivers / DCW write drivers**, frame processors, node templates, config groups, KV, timers) and `client.mjs` (browser: panels injected into named slots, i18n, settings UI). Three scopes — `builtin` (shipped) > `project` (checkout) > `user` (`~/.AgentWorkShop`) — with ~1 s hot reload on enable/disable **and on code edits**; a disabled plugin's drivers are removed on hot reload immediately. Built-in example: **serial-bridge** (serial communication: read/write drivers, serial probe API, frontend panel). Full contract in [`docs/plugins.md`](./docs/plugins.md). |
| **AML — auto-modeling lab** | Dataset build → training job → leaderboard → promotion gates → model reference, all driven from `/aml` or by agents through 10 `aml_*` tools. Python runtime bootstrapped with `uv` into an `./aml` asset root; artifacts and metadata stay under the config root. |
| **Fully config-driven runtime** | Every runtime knob (memory budgets, compaction, rollback guardrails, retention, backups, log level…) is declared once in the settings descriptor registry with precedence **config.yml < runtime-settings < env** — **99 settings across 16 groups**, no hardcoded defaults in code. |
| **Configurable cadences** | Sampling and query defaults/floors are **live settings** (`daq.sampling.*`, `daq.query.*`): hot-reloaded, clamped on node create/patch, and agent tool descriptions always carry the current values. |

#### Digital twin

| Capability | Why it matters |
|---|---|
| **3D digital twin** | Three.js town: place line equipment and channel territories, watch device health, alarms and live values — driven by the same event bus. An adaptive quality ladder (DPR / shadow / bloom tiers, wall-clock FPS budget) matches the machine, and `window.__townStats` exposes real render metrics for perf probes. |

---

## The interface

Every panel below is the real UI, at 1440×900, recorded from a running instance.

<div align="center">

### FIG.02 — DAQ console

<img src="https://raw.githubusercontent.com/kingdol666/AgentWorkShop/main/docs/readme-assets/fig-02-daq.gif" alt="DAQ console: node inventory, live trends, alarm strip and event stream" width="92%" />

<sub><b>Acquisition, end to end.</b> Node inventory and health under a live gauge band, trends that fill as samples land,
an alarm strip that only holds what is actually unacknowledged, and a tailing event stream.</sub>

<br />

### FIG.03 — Line operations

<img src="https://raw.githubusercontent.com/kingdol666/AgentWorkShop/main/docs/readme-assets/fig-03-dcw.gif" alt="Line operations: production lines, products, recipes and write control" width="92%" />

<sub><b>Lines, products, recipes, batches.</b> Starting a line gates acquisition through its recipe window and tags every
sample with <code>product/recipe/run</code>; control nodes expose <b>SET vs ACT</b> through the same calibration path they write with.</sub>

<br />

### FIG.04 — Digital twin

<img src="https://raw.githubusercontent.com/kingdol666/AgentWorkShop/main/docs/readme-assets/fig-04-town.gif" alt="3D digital twin town driven by live telemetry" width="92%" />

<sub><b>The twin is the same event bus, rendered.</b> Equipment, channel territories, alarms and live values — an adaptive
quality ladder (DPR / shadow / bloom, wall-clock FPS budget) keeps it honest on modest hardware.</sub>

<br />

### FIG.05 — Dashboard

<img src="https://raw.githubusercontent.com/kingdol666/AgentWorkShop/main/docs/readme-assets/fig-05-dashboard.gif" alt="Runtime dashboard with KPI gauges and trends" width="92%" />

<sub><b>One screen for the whole workshop.</b> Channels, agents, tasks, DAQ throughput and alarms — read from the same
state the API serves, not a separate metrics store.</sub>

<br />

### FIG.06 — Responsive

<img src="https://raw.githubusercontent.com/kingdol666/AgentWorkShop/main/docs/readme-assets/fig-06-responsive.gif" alt="The same interface adapting from desktop to tablet to phone" width="92%" />

<sub><b>Desktop → tablet → phone.</b> The instrument rail collapses to an icon rail, then to an off-canvas drawer;
page headers stack, dense tables become scrollable ledgers with a pinned identity column.</sub>

</div>

<table>
<tr>
<td width="50%"><img src="https://raw.githubusercontent.com/kingdol666/AgentWorkShop/main/docs/readme-assets/shot-workshop.png" alt="Agent workshop" width="100%" /><br/><sub><b>Agent workshop.</b> Channel timeline, lanes, tasks, memory and HITL in one workbench.</sub></td>
<td width="50%"><img src="https://raw.githubusercontent.com/kingdol666/AgentWorkShop/main/docs/readme-assets/shot-monitor.png" alt="Runtime monitor" width="100%" /><br/><sub><b>Runtime monitor.</b> Every wired channel, member count, dependency cycle and owner.</sub></td>
</tr>
<tr>
<td><img src="https://raw.githubusercontent.com/kingdol666/AgentWorkShop/main/docs/readme-assets/shot-settings.png" alt="Settings" width="100%" /><br/><sub><b>Settings.</b> 99 keys across 16 groups, descriptor-driven — the same registry the CLI reads.</sub></td>
<td><img src="https://raw.githubusercontent.com/kingdol666/AgentWorkShop/main/docs/readme-assets/shot-plugins.png" alt="Plugins" width="100%" /><br/><sub><b>Plugins.</b> Three scopes, hot reload on edit, per-team switches.</sub></td>
</tr>
</table>

---
## Architecture

```mermaid
flowchart TB
    subgraph FE["Frontend — Nuxt 4 / Vue 3"]
        UI["Workshop UI · 3D Twin · Dashboards"]
        WS["AEP client — seq resume"]
    end
    subgraph SRV["Server — Nitro / h3"]
        REST["REST /api/workshop/**"]
        HUB["WS Hub — AEP v1"]
        A2A["A2A JSON-RPC"]
        MCP["MCP Server"]
        subgraph RT["Runtime"]
            MGR["AgentChannelManager"]
            SCH["SchedulerLoop — lead supervision"]
            TE["TaskEngine — 7-state machine"]
            AR["AgentRuntime × N"]
            MEM["AgentMemory — FTS5 + vector"]
            BUS["ChannelBus — per-channel seq + ring"]
        end
        subgraph IND["Industrial"]
            DAQ["DAQ gateway — per-node edge runtimes"]
            DCW["DCW gateway — write control"]
            BR["Bus — inproc / MQTT"]
            TSDB["TSDB — SQLite / Timescale"]
        end
        subgraph HB["Harness adapters — 14 engines"]
            MOCK["mock · claude — in-process"]
            OMP["omp — RPC subprocess"]
            CDX["codex — app-server"]
            DSH["dsh · qwen · hermes — ACP"]
            OC["opencode — serve"]
            FAM["gemini · copilot · cursor · crush · goose · pi — headless CLI"]
        end
        DB[("SQLite — channels · agents · tasks
messages · memories (FTS5) · events")]
    end
    UI <--> WS
    WS --> BUS
    REST & A2A & MCP --> MGR
    MGR --> SCH & TE & AR
    AR --> MEM
    AR --> MOCK & OMP & CDX & DSH & OC & FAM
    MGR & TE & MEM & BUS --> DB
    DAQ <--> BR --> TSDB
    DCW --> BR
    DAQ & DCW --> BUS
```

**The agent × machine bridge** (the part worth reading the source for):

```
agent ──binds to──▶ node (daq: auto / dcw: manual)
  │                    │
  │  my_industrial_nodes  ◀── semantic card: meaning · unit · safe range · recipe window
  │  daq_query             ◀── TSDB history, stats + physical semantics
  │  dcw_control           ──▶ interlock (safe range ∩ recipe window)
  │                           ──▶ HITL approval (manual mode, 180 s timeout)
  │                           ──▶ PLC write → readback check → ACK + write history
  ◀── result text with numbers the agent can cite
```

---

## Quick start

### Prerequisites

```bash
node -v   # ≥ 23.4.0  (needs built-in node:sqlite)
```

> Real-agent harnesses require their CLI on PATH — `omp`, `codex`, `dsh`, `opencode`, `gemini`, `qwen`, `copilot`, `cursor`, `crush`, `goose`, `pi` or `hermes` (any subset; each channel can mix harnesses). `mock` and `claude` (SDK) run in-process and need no PATH CLI. The dashboard "execution engines" panel shows per-engine readiness with a green/grey dot; uninstalled engines link to their official install page. Optional DAQ infrastructure (MQTT broker + TimescaleDB) auto-starts via Docker when reachable (`docker compose up -d`).

### Option A — install from npm (recommended)

```bash
npm install -g agentworkshop     # → `aw` / `agentworkshop` on PATH
aw start                         # → http://localhost:3001
```

The published tarball ships a **prebuilt production bundle** (`.output/`), so an npm install boots straight away — no build step, no build tools. On first launch everything initializes into the config root **`~/.AgentWorkShop`**: the default `config.yml`, a generated `.env` holding a random session secret, `runtime-settings.json`, a docker-compose seed, `prompts/`, `commands/`, `plugins/` (seeded from the SDK examples, **disabled** by default) and an empty `data/` directory. All runtime data (SQLite, JSON repos, backups, logs) lives there too — config and data stay with the install, not the working directory.

Prefer a one-off run without installing globally?

```bash
npx agentworkshop start          # no global npm install required
```

> `npx` still creates `~/.AgentWorkShop` — running without a global install is not the same as leaving no trace on disk.

### Option B — from source

```bash
git clone https://github.com/kingdol666/AgentWorkShop.git && cd AgentWorkShop
pnpm install
pnpm dev          # → http://localhost:3000  (port from config.yml)
```

Production from source:

```bash
pnpm build        # nuxt build → .output/
pnpm start        # port from config.yml → server.prod.port
```

> In a source checkout the config root is the project's **`.AgentWorkShop/`** folder (runtime overrides, data, project-level commands), while `config.yml` / `.env` stay at the checkout root, version-controlled as the factory defaults.

### Updating

```bash
aw update                              # check + self-update the global install
aw update --check                      # only report; nothing is installed
npm install -g agentworkshop@latest    # manual equivalent
```

Releases follow semver. `aw start` verifies the config root on every launch and migrates the legacy pre-`home` `data/` layout into it (newest file wins), so data survives upgrades. SQLite schema migrations run server-side at boot. Current version: **v0.7.42** — see [Releases](https://github.com/kingdol666/AgentWorkShop/releases).

### Your first agent × line session (~2 minutes)

1. **Sign in** — register in the sidebar (or `POST /api/users/register`).
2. **Build a line** — `Line Operations` → create a line, add DAQ nodes (e.g. `daq-temp-tc`) and control nodes (e.g. `dcw-temp-sp`), create a product + recipe, hit **Start**. Live values start flowing.
3. **Create a team** — `Agent Workshop` → pick a lead + workers, **deploy** into a channel.
4. **Bind nodes** — open the agent's detail panel → bind the DAQ node (*auto*) and the control node (*manual* = needs your approval).
5. **Submit the goal** — *"Analyze the last 5 minutes of melt temperature; if deviation from 182 °C exceeds 1 °C, correct the setpoint (wait for my approval)."*
6. **Approve** — the agent reads real history, computes the mean, requests the write → approve in the HITL panel → watch the setpoint change and the goal close with a numeric report.

---

## Configuration & CLI — config-driven by design

One runtime, one source of truth. **`config.yml`** declares defaults; **`runtime-settings.json`** inside the config root carries runtime overrides; environment variables and CLI flags sit on top. Every editable key is described once in `shared/config/schema.json` (type, range, enum, live-vs-restart) and surfaced through the same descriptors in **both the UI and the CLI**.

```
config.yml (defaults)  <  .AgentWorkShop/runtime-settings.json (runtime)  <  env vars / CLI flags
```

The config root is **`~/.AgentWorkShop`** for a global install (`npm i -g`) — wherever you run `aw` from — and **`<repo>/.AgentWorkShop`** in a source checkout (with `config.yml` / `.env` staying at the checkout root as version-controlled factory defaults). `AW_HOME` redirects it; `AW_MODE=home` forces the global shape.

### Live settings, persisted, hot-reloaded

- The **Settings → Runtime config** tab renders every editable key from the descriptors — change server ports, theme, API timeouts, locale or the approval gate, hit save.
- `live` keys apply instantly (theme, title, timeouts, approval gate, DAQ sampling cadences, TSDB query buckets…) over a server-sent event stream — no reload, no restart.
- `restart` keys (ports, hosts) persist to disk and take effect on the next launch of the matching mode (`aw dev` / `aw start`).
- One channel for every writer: the UI, the CLI and the server's file watcher all converge on the same settings file, so a change made anywhere shows up everywhere.

Example — retune the acquisition and query cadences live:

```bash
aw config set daq.sampling.defaultIntervalMs 2000   # new nodes sample every 2 s
aw config set daq.sampling.minIntervalMs 500        # per-node floor (create/patch clamp)
aw config set daq.query.defaultBucketMs 3000        # TSDB reads default to a 3 s bucket
aw config set daq.query.minBucketMs 500             # query floor (samples/line query/agent tool)
```

Agent tool descriptions are re-rendered with the current values on every injection, so an LLM always sees the floor and default that will actually apply to its `daq_query` calls.

### The `aw` CLI

| Command | What it does |
|---|---|
| `aw start · aw dev · aw build` | Production server / dev server / build — ports from the effective config; first `start` builds once |
| `aw stop` | Stop a running `aw` service instance via the single-instance lock |
| `aw config list · get · set · unset · reset` | Read & write runtime settings (validated against the schema, atomic writes) |
| `aw plugin list · create · enable · disable` | Manage plugins across all three scopes: inspect, scaffold (project scope; `--global` for user scope), enable/disable (state file, ~1 s hot reload on the running server) |
| `aw home` | Inspect / initialize the config root `.AgentWorkShop` |
| `aw init <dir>` | Scaffold a runnable project (full config system + CLI included) |
| `aw register <path\|url\|npm:pkg>` | Register a new command — project-local or `--global` |
| `aw update` | Check npm for the latest release and self-update the global install |
| `aw doctor` | Environment + project health check (node, config, ports, keys) |
| `aw status` | Live overview: mode, config sources, running server, command table |
| `aw tui` | Terminal workbench: channel/agent management, task submission, live monitor pane, HITL answering (see [`docs/tui.md`](./docs/tui.md) · [`tui/README.md`](./tui/README.md)) |
| `aw version` | Print the CLI/package version (alias `v`) |

Global flags: `--help/-h` · `--version/-v` · `--json` (machine-readable) · `--root <dir>` · `--debug`.

Exit codes: **0** success · **1** runtime error · **2** usage error. With `--json`, failures come back as an envelope carrying `{ ok: false, error: 'unknown-command' \| 'no-project' \| 'usage' \| 'internal' \| … }`, so automation can branch without parsing stderr.

### Command registration

Commands are plain modules exporting `{ meta, run }`. Drop one into a scanned directory and it's live on the next invocation — no registry bookkeeping, convention over configuration:

| Scope (highest wins) | Directory |
|---|---|
| project | `<root>/.AgentWorkShop/commands/` |
| user | `~/.AgentWorkShop/commands/` |
| built-in | packaged with the CLI (`cli/commands/`) |

`aw register <file|url|npm:pkg>` copies a command into the right scope (`--global` for user scope); `aw help` lists everything that's registered.

```js
// ~/.AgentWorkShop/commands/hello.mjs
export const meta = { name: 'hello', group: 'Custom', summary: 'Say hi', usage: 'aw hello [--name <n>]' }
export async function run(argv, ctx) {
  console.log(`Hi ${argv.flags.name ?? 'AW'} — mode: ${ctx.mode}`)
}
```

---

## The industrial stack in detail

### Data acquisition (DAQ)

- **Six protocol drivers**: Modbus TCP, Modbus RTU-over-TCP (serial gateway), OPC UA, MQTT, HTTP/REST, plus the **serial-bridge built-in plugin** (direct RS-232/485: Modbus RTU framing + ASCII line protocol, write side with same-address readback verification, serial enumeration/probe API and a frontend panel) — connection pools, classified error messages, per-driver connection tests; the driver registry accepts plugin-registered protocols of any kind (with self-describing metadata, the frontend forms render with zero changes).
- **Per-node edge runtimes**: independent sampling cadence, publish cadence, in-flight mutex per node — one slow driver never blocks its neighbors. Sampling and query defaults/floors are driven by the live `daq.sampling.*` / `daq.query.*` settings.
- **Pipeline**: driver → queue (in-process or MQTT, offline buffer on disconnect) → consumer with out-of-order defense → three-way fan-out: WS live push (gated), TSDB batch write, device-twin writeback.
- **Robustness**: TSDB single-in-flight writes with bounded retries, buffer backpressure with drop counters, real loss metrics exposed on `daq.controller` frames.
- **Alarms**: recipe-scoped monitoring windows with **2 % hysteresis + 3-tick debounce**; alarm/offline transitions are instant (safety first).

### Write control (DCW)

- Engineering-unit writes: `linear` calibration (scale/offset) PLC↔physical, **readback verification** with deadband tolerance, ACK states and write history.
- **Interlock**: with a line running, the active recipe's parameter window *replaces* the node's global safe range for that node.
- **HITL**: `manual`-mode bindings suspend the write for user approval (deduped per agent+node; re-validation at approval time — permission is re-checked when you click approve).

### Recipe & batch

`Line → Product → Recipe → Run`. Starting a run applies recipe params node-by-node (each write verified), gates acquisition per line, and tags every sample with `line/product/recipe/run` — per-product data isolation with five-dimension queries (line × product × recipe × time × node).

### AML — auto-modeling lab

The modeling half of the loop: `/aml` builds **datasets** out of tagged telemetry, submits **training jobs** to a `uv`-managed Python runtime, ranks runs on a **leaderboard**, and promotes a model only when it clears the configured **gates** (NRMSE, rollout NRMSE, validation/test gap, minimum rows and runs). Promoted models are referenced by id, so an MPC or shadow-twin controller can consume a versioned artifact instead of a vague "latest".

- Agents do the same work through 10 tools (`aml_dataset_build`, `aml_job_submit`, `aml_job_status`, `aml_leaderboard`, `aml_model_promote`, …) — submit a goal and let the team train and report.
- The Python runtime bootstraps itself with `uv` into an `./aml` asset root inside the config root; dataset/artifact/metadata paths, disk quota, job timeout, concurrency and retention are all **settings** (16 in the `aml` group), not constants.
- Governance defaults are conservative: cross-recipe datasets are refused unless explicitly allowed, and every job is attributed.

---

## Usage

### Authentication

Email + password login issues a **bearer token** (multiple tokens per user, individually revocable).

```bash
# register
curl -X POST http://localhost:3000/api/users/register \
  -H 'content-type: application/json' \
  -d '{"email":"you@example.com","password":"secret","name":"you"}'

# every workshop call
curl http://localhost:3000/api/workshop/channels \
  -H 'authorization: Bearer <token>'
```

### Line-level permissions

Industrial data is gated **per production line** with three states, managed by an admin
in the built-in **Permissions** page (`/permissions`, admin-only in the sidebar):

| State | DAQ nodes | DCW (write) nodes | Visibility |
| --- | --- | --- | --- |
| **none** (default for regular users) | hidden | hidden | line data withheld server-side — invisible in Line Ops, DAQ center and the digital twin |
| **read-only** | read | ✕ | line visible, values stream, no writes / dispatch / device binding |
| **operate** | read | read + write | full access incl. setpoint writes, dispatch, binding |

- `admin` / `editor` roles are unrestricted (operations roles).
- Regular users **default to none** — they see no line data until granted.
- Enforcement lives in the data plane: list endpoints filter by grant, write/dispatch
  endpoints return a human-readable 403, and Agent↔node bindings validate the line grant
  (DAQ needs read-only+, DCW needs operate).
- Plugins get the same surface via `ctx.permissions` (`lineMode` / `visibleLineIds` /
  `listGrants` / `setGrants`) plus a `permissions:changed` lifecycle hook; the SDK REST
  client exposes `client.permissions.overview()` / `client.permissions.set(...)`.

### Execution modes

Prefix the task description (or pick in the composer UI):

| Mode | Semantics | Config |
|---|---|---|
| `goal` | lead decomposes → workers deliver → **lead judges satisfaction**; unmet → more subtasks; met → parent completes. | `goalCriteria` |
| `loop` | replay the same task on a fixed interval. | `intervalMs` (default 60 000), `maxIterations` (default ∞) |
| `pipeline` | ordered stages; stage N+1 consumes stage N's output. | `stages: [{name, description, assigneeId?}]` |

### The four entry points

| Entry | Endpoint | Audience |
|---|---|---|
| **WS** | `/api/workshop/ws?channelId=…` | Dashboards / UI — AEP v1 envelopes, per-channel monotonic `seq`, 5 000-event ring, `lastSeq` resume, snapshot fallback. |
| **MCP** | in-process server, ~25 tools | Agents (omp host tools) — management + job-face tools, channel-scoped. |
| **A2A** | `POST /api/workshop/a2a/:agentId/rpc` | External agents — JSON-RPC 2.0, `AgentCard` at `/card`, `tasks/sendSubscribe` SSE. |
| **REST** | `/api/workshop/**` | Humans / scripts — full management face. |

### Task state machine

```
SUBMITTED ─▶ ASSIGNED ─▶ WORKING ─▶ WAITING ─▶ COMPLETED
    │            │           │           │
    └────────────┴───────────┴──▶ CANCELED / FAILED ─▶ (retry ≤ 3 or cancel)
```

---

## Verified end-to-end

Every claim above is backed by a suite you can re-run. The closed-loop suite drives a
**production instance over real simulated plant protocols** (Modbus TCP/RTU, OPC UA, MQTT,
HTTP + an MQTT/Timescale pipeline) with a real LLM agent, and asserts on the database,
the event stream and the HTTP API — not on mocks.

| Suite | Latest result | What it covers | Reproduce |
|---|---|---|---|
| `e2e-full-closedloop.mjs` | **124 PASS / 0 FAIL** (2026-09-12, v0.7.36) | registration → login → line/product/recipe → DAQ sampling → agent bound to nodes → `daq_query` → `dcw_control` → HITL approval → PLC write → readback → recipe rollback → cascade delete → data-root isolation | `node scripts/e2e-full-closedloop.mjs http://127.0.0.1:3111` |
| `e2e-aml.ts --real` | 0 failures (2026-09-11) | AML datasets → job submit → status/logs → leaderboard → promotion gates, against the real Python runtime | `node node_modules/tsx/dist/cli.mjs --tsconfig .nuxt/tsconfig.server.json scripts/e2e-aml.ts --real` |
| Five-protocol live line | 37/37 (re-verified 2026-09-12 on a clean instance) | driver connectivity, sampling into Timescale, DCW dispatch + readback per protocol, agent closed loop, HITL over a real OPC UA write, recipe + param-ledger rollback | `node bench/pipeline.mjs --profile integrated` (the five-protocol closed loop is now part of the bench gate; the original 37-assertion script was retired as simulator ports evolved) |
| Production API live | 64/64 (re-verified 2026-09-12 on a clean instance) | persistence across restart, template CRUD, task assign/complete/cancel/loop/pipeline, A2A + mailbox, WS broadcast, MCP endpoint, cascade delete | `AW_E2E_TOKEN=<token> node scripts/api-live-e2e.mjs` |
| Line permissions / audit-negative | 21/21 + 9/9 | three-state line grants with human-readable 403s, binding-subject validation, revocation convergence, unauthenticated WS receives zero telemetry | `node scripts/_dbg-perms-e2e.mjs <base> <adminPass>` · `node scripts/_dbg-audit-neg-e2e.mjs <base> <adminPass>` |
| Render regression | 30/30 | DAQ table integrity (row count aligned with the API), WS-driven row updates, filters, detail page, 3D town + model library, 7-page smoke, zero page errors | `node scripts/_dbg-render-regression.mjs <base> <email> <pass>` |
| Multi-harness parallel | 21 | omp closed loop · codex real register write · dsh real acquisition · opencode recipe write+rollback — four engines on one running line | `node scripts/e2e-multiharness-team.mjs` |
| Offline unit/property suites | all green | AEP event index (`test-events-index`), LRU, data-root split (`test-data-root`), log flooding, rollback index, plugin hardening, memory month query, CLI exit codes (`test-cli-exit`), SDK surface (`test-sdk-surface`) | `node scripts/test-<name>.mjs` |

The five-protocol and API-live rows are the historical **v0.7.20** acceptance baseline —
*156 assertions, 0 failures*, full report in [`docs/audit/e2e-2026-09-07.md`](./docs/audit/e2e-2026-09-07.md).
The closed-loop and AML rows are the current-head runs. Perf probing:
`scripts/_dbg-render-perf.mjs`.

---

## Project layout

```
AgentWorkShop/
├── bin/ · cli/                 # aw CLI — command registry · built-in commands · config engine
├── app/                        # Nuxt 4 frontend (srcDir)
│   ├── pages/                  # / · /workshop · /workshop/agents · /workshop/teams
│   │                           # /workshop/channel-templates · /workshop/w/:id
│   │                           # /town · /daq · /daq/:id · /dcw · /dcw/:id
│   │                           # /aml · /monitor · /logs · /permissions
│   │                           # /plugins · /users · /tokens · /settings
│   ├── components/workshop/    # timeline · lanes · task board · memory panel · 3D town
│   └── stores/composables/     # Pinia + AEP client
├── server/
│   ├── api/                    # REST + WS + A2A + MCP routes
│   ├── services/workshop/
│   │   ├── runtime/            # manager · scheduler-loop · task-engine · memory · mailbox
│   │   ├── agents/             # AgentInterface: 14 engines (+ industrial tools)
│   │   ├── daq/ dcw/ aml/      # edge runtimes · drivers · bus · storage · modeling lab
│   │   └── db/                 # repos over node:sqlite
│   ├── mcp/                    # MCP server (25 tools)
│   ├── plugins-builtin/        # plugins shipped with the package (diag-bridge · rag-bridge)
│   └── plugins/                # runtime assembly (singletons)
├── sdk/                        # agentworkshop/sdk — plugin context, hook bus, REST client, browser SDK
├── tui/                        # terminal workbench (aw tui)
├── shared/
│   └── config/                 # schema.json (99 setting descriptors) + engine (merge/validate/persist) + path resolver
├── config.yml                  # factory defaults (read at build/start; version comes from package.json)
├── .AgentWorkShop/             # config root in a checkout — prompts (versioned) + runtime overrides · data · logs · commands (git-ignored)
├── data/                       # legacy pre-migration location (auto-migrated into the config root)
└── scripts/                    # launchers · home bootstrap · E2E · verification suites
```

## Tech stack

| Layer | Tech |
|---|---|
| Framework | [Nuxt 4](https://nuxt.com) + Nitro (WebSocket) |
| UI | Vue 3.5 · Pinia · Ant Design Vue · UnoCSS · Three.js · ECharts |
| Language | TypeScript 5.7 across the stack; `shared/` used by both sides |
| CLI | Node ESM CLI with a pluggable command registry (`bin/aw.mjs`) |
| Persistence | `node:sqlite` (zero native deps) + FTS5 + optional `sqlite-vec`; TimescaleDB for time-series |
| Validation | `zod` at every message boundary |
| Interop | `@modelcontextprotocol/sdk` · A2A (JSON-RPC 2.0) · AEP v1 (in-house WS protocol) |
| Field bus | `modbus-serial` · `node-opcua` · `mqtt` |

## Development

```bash
pnpm dev          # dev server (port from effective config)
pnpm cli …        # the CLI in-repo: pnpm cli config list
pnpm tui          # terminal workbench against a running instance
pnpm build && pnpm start
pnpm typecheck
pnpm lint
pnpm test:api-live                        # API suite against a running server
node scripts/e2e-full-closedloop.mjs      # full closed loop (server must be running)
node scripts/test-sdk-surface.mjs         # SDK export-surface guard
```

The docs site lives in `docs/site/` (VitePress) and is deployed to GitHub Pages by
[`.github/workflows/deploy-docs.yml`](./.github/workflows/deploy-docs.yml):

```bash
cd docs/site && npx vitepress dev        # preview locally
cd docs/site && npx vitepress build      # production build → .vitepress/dist
```

The workflow syncs `docs/{cli,plugins,sdk}.md` (and their `.en.md` twins) into the site before
building, so those files are the single source of truth for the single-page guides.

## Roadmap

| Capability | Status |
|---|---|
| Channel runtime, lead orchestration, 7-state task engine | Shipped |
| Four entry points: WS (AEP v1) · MCP · A2A · REST | Shipped |
| Persistent memory (FTS5 + optional vector hybrid) | Shipped |
| Industrial stack: DAQ · DCW write control · lines/recipes/runs | Shipped |
| Agent ↔ node binding + HITL approval + interlock | Shipped |
| 3D digital-twin town · line operations UI · dashboards | Shipped |
| Full-feature live E2E (agent reads/writes a real line, 23 checks) | Shipped |
| Runtime configuration system: settings persistence · hot reload · settings UI | Shipped |
| `aw` CLI: config · run · init · register · doctor | Shipped |
| Multi-harness registry: omp · codex · dsh · opencode subprocess engines | Shipped |
| Five field protocols: Modbus RTU-over-TCP · MQTT · HTTP (acquisition + write control) | Shipped |
| Harness availability probing + dispatch-time engine checks (UI disable + 409) | Shipped |
| Recipe versioning with attribution + non-destructive rollback (UI + agent tools) | Shipped |
| Agent self-audit: line_context / ops_log / recipe_log / recipe_versions / dcw_journal | Shipped |
| Multi-harness parallel live E2E on a real protocol line (four engines, one line) | Shipped |
| HITL approval flow verified over real OPC UA writes | Shipped |
| Bilingual docs (简体中文 / English) with VitePress language switcher | Shipped |
| Per-channel LLM provider/model selection from live harness catalogs | Shipped |
| Configurable DAQ/TSDB cadences (sampling & query defaults + floors, live) | Shipped |
| Team-scoped plugin switches (create-time pick + team dialog, per-channel tool injection) | Shipped |
| Plugin hot management: `/plugins` page + `aw plugin list/enable/disable` | Shipped |
| Rendering perf pass (v0.7.27): DAQ main-thread blocking −90%, twin −69%, adaptive quality restored to top tier; `window.__townStats` instrumentation | Shipped |
| Plugin system v2: browser panel injection, plugin-scoped settings/groups, plugin i18n, host runtime services (`ctx.services`/`ctx.daq`/`ctx.omp`) | Shipped |
| Instrument Glass material layer (v0.7.36): three-tier translucent materials, vibrancy, specular edges, spring motion, per-page route transitions | Shipped |
| Realtime pipeline optimizations: DAQ frame indexing O(n²)→O(n), incremental per-agent event index, chart in-place updates, size-aware JSON persistence | Shipped |
| AML auto-modeling lab: dataset build · job orchestration (uv-managed Python) · leaderboard · promotion gates · 10 agent tools | Shipped |
| Claude Agent SDK adapter — resident sessions with same-turn steer and `canUseTool` HITL | Shipped |
| Production hardening: TLS, MQTT auth, OPC UA sign+encrypt defaults, structured audit log | Planned |
| Edge deployment shape: standalone edge-agent + central broker | Planned |
| Alarm outbound delivery (email/webhook) + ack workflow | Planned |
| CI pipeline (typecheck + lint + e2e) — docs deployment already runs on GitHub Actions | Planned |
| License: PolyForm Noncommercial 1.0.0 (source-available, non-commercial) | Shipped |

## License

AgentWorkShop is an independent project and is **not an official product of Anthropic** or any LLM vendor. It integrates with agent harnesses (e.g. `omp`) through their public interfaces.

**AgentWorkShop is source-available software, licensed under the [PolyForm Noncommercial 1.0.0](./LICENSE).**

- **Permitted** — personal study, research, hobby projects, teaching, and use by noncommercial organizations (charities, education, public research, government).
- **Not permitted without prior written permission** — any **commercial use**: selling, paid services, integrating into commercial products, or production use serving a business. Commercial licenses are available from the copyright holder.
- **When you redistribute** the software, you must pass through the `Required Notice` line and these terms.

For commercial licensing, contact: [GitHub @kingdol666](https://github.com/kingdol666) · kingdol6080@gmail.com

<div align="center">

<a href="https://star-history.com/#kingdol666/AgentWorkShop&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=kingdol666/AgentWorkShop&type=Date&theme=dark" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=kingdol666/AgentWorkShop&type=Date" />
    <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=kingdol666/AgentWorkShop&type=Date" width="80%" />
  </picture>
</a>

</div>

---

## Contributing

Issues and pull requests are welcome. Before opening a PR:

1. **Read the contract you are touching** — [`docs/plugins.md`](./docs/plugins.md) for the extension surface, [`docs/sdk.md`](./docs/sdk.md) for the programming client, [`docs/cli.md`](./docs/cli.md) for the command registry.
2. **Run the guards locally**:

```bash
pnpm typecheck                            # vue-tsc across app + server + shared
pnpm lint                                 # eslint 9, zero warnings expected
node scripts/e2e-full-closedloop.mjs      # full closed loop, server must be running
node scripts/test-sdk-surface.mjs         # SDK export surface must not drift
node scripts/check-docs-sync.mjs          # docs/site pages stay in sync with docs/*.md
```

3. **Keep commits conventional** — `commitlint` runs on `commit-msg` (`feat:`, `fix:`, `docs:`, `refactor:`, `perf:`, `test:`, `chore:`), and `lint-staged` fixes staged JS/TS/Vue on commit.
4. **Add a test for behaviour you change.** The repo leans on live E2E scripts under `scripts/` rather than mocks — a new industrial path should be provable against a running instance.

> [!TIP]
> `aw doctor` checks your environment end to end (Node version, config root, port availability, SQLite, optional Docker services) before you file a bug — it answers most "it does not start" reports immediately.

## Security

Please **do not** open a public issue for a vulnerability. Report it privately through [GitHub Security Advisories](https://github.com/kingdol666/AgentWorkShop/security/advisories/new) with a reproduction and the affected version.

AgentWorkShop drives real equipment when you point it at real equipment: review `config.yml` interlocks, safe ranges and HITL settings before connecting a live PLC. The default posture is advisory — writes are interlocked, approved and read back — but the plant-side logic is always the final veto.

---

<div align="center">

**If this project is useful to you, a ⭐ helps other people find it.**

[![Star History Chart](https://api.star-history.com/svg?repos=kingdol666/AgentWorkShop&type=Date)](https://star-history.com/#kingdol666/AgentWorkShop&Date)

<br />

**[Documentation](https://kingdol666.github.io/AgentWorkShop)** · **[Guide](https://kingdol666.github.io/AgentWorkShop/guide/getting-started)** · **[Plugin API](./docs/plugins.md)** · **[SDK](./docs/sdk.md)** · **[CLI](./docs/cli.md)** · **[中文](./README-zh.md)**

<sub>Built with Nuxt 4 · Vue 3 · TypeScript · <code>node:sqlite</code> — supervisory layer, second-level soft real-time.<br />
Time-critical loops stay in the PLC.</sub>

</div>
