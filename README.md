<div align="center">

<img src="https://img.shields.io/badge/Nuxt-4-00DC82?logo=nuxt&logoColor=white" alt="Nuxt 4" />
<img src="https://img.shields.io/badge/Vue-3.5-42B883?logo=vue.js&logoColor=white" alt="Vue 3.5" />
<img src="https://img.shields.io/badge/Node.js-≥%2023.4-3C873A?logo=node.js&logoColor=white" alt="Node.js ≥ 23.4" />
<img src="https://img.shields.io/badge/pnpm-11-F69220?logo=pnpm&logoColor=white" alt="pnpm 11" />
<img src="https://img.shields.io/badge/TypeScript-5.7-3178C6?logo=typescript&logoColor=white" alt="TypeScript 5.7" />
<img src="https://img.shields.io/badge/SQLite-node--sqlite-003B57?logo=sqlite&logoColor=white" alt="SQLite (node:sqlite)" />
<img src="https://img.shields.io/badge/ESLint-9%20(flat)-4B32C3?logo=eslint&logoColor=white" alt="ESLint 9 flat" />

# AgentWorkShop

**A configuration-driven, multi-agent software workshop**

> Orchestrate teams of coding agents inside **Channels** — tasks as first-class objects, a lead-agent scheduler, persistent memory, and four interoperable entry points (WebSocket / MCP / A2A / REST).

[**中文文档 → README-zh.md**](./README-zh.md)

[![License](https://img.shields.io/badge/license-TBD-lightgrey?style=flat-square)](#license)
[![GitHub stars](https://img.shields.io/github/stars/kingdol666/AgentWorkShop?style=social)](https://github.com/kingdol666/AgentWorkShop)

</div>

<div align="center">

| | |
|---|---|
| **Version** | `0.1.0` |
| **Runtime** | Node.js `≥ 23.4.0` (built-in `node:sqlite`, zero native deps) |
| **Stack** | Nuxt 4 · Vue 3 · Nitro · Pinia · Ant Design Vue · MCP SDK |
| **i18n** | `zh-CN` (default) / `en` — driven by `config.yml` |

</div>

---

<div align="center">

## 📑 Contents

- [Features](#features)
- [How it works](#how-it-works)
- [Quick start](#quick-start)
- [Usage](#usage)
- [The four entry points](#the-four-entry-points)
- [Task state machine](#task-state-machine)
- [A2A message & artifact model](#a2a-message--artifact-model)
- [Persistent agent memory](#persistent-agent-memory)
- [Harness adapters](#harness-adapters)
- [Architecture](#architecture)
- [Project layout](#project-layout)
- [Tech stack](#tech-stack)
- [Development](#development)
- [Configuration](#configuration)
- [Design documents](#design-documents)
- [Roadmap](#roadmap)
- [License](#license)

</div>

---

## Features

<div align="center">

| 🔒 Channel isolation | 🧑‍💼 Lead orchestration |
|:---:|:---:|
| **Channel isolation** — every channel is a hard boundary with its own workspace, mailbox, task pool and event stream; agents perceive only their own channel. | **Lead agent** — each channel has exactly one lead: it decomposes tasks, dispatches to idle workers, reassigns failures, summarizes delivery. |

| 🎯 Three execution modes | 📦 Task as first-class object |
|:---:|:---:|
| **`goal` / `loop` / `pipeline`** — goal-satisfaction judging, fixed-interval re-dispatch, or ordered stages with sequential dependencies. | **7-state task machine** — owner/assignee, 0–100 progress, artifacts, full history, parent/child decomposition. |

| 🧠 Persistent memory | 🔌 Harness-agnostic |
|:---:|:---:|
| **Private + shared memory domains** — FTS5 with CJK segmentation, optional vector hybrid recall, token-budgeted injection, auto-harvest on completion. | **One `AgentInterface`** — `mock` (in-process), `omp` (real coding-agent subprocess via RPC), `claude` (SDK adapter); the platform never knows which one runs. |

| 🚪 Four entry points | 🔑 Token auth + monitor |
|:---:|:---:|
| **WS / MCP / A2A / REST** — one manager behind every door: AEP event stream, 20 in-process MCP tools, A2A JSON-RPC 2.0 with `AgentCard`, full REST. | **Accounts + API tokens** with a management UI, plus a `/monitor` page: live runtimes, every harness process (incl. orphans), one-click process-tree kill. |

</div>

---

## How it works

<div align="center">

![Timeline view — live event stream with status chips, progress, results and the lead's summary](docs/screenshots/t1_timeline.png)

*Timeline view — every event (agent status, streaming deltas, progress, results) streams into a live, replayable transcript.*

</div>

```mermaid
flowchart LR
    U(["👤 You"]) -->|submit goal| CH(["📡 Channel"])
    CH --> L["🧑‍💼 Lead agent"]
    L -->|decompose| D["🧩 Subtasks"]
    D -->|dispatch| W1["⚙️ Worker w1"]
    D -->|dispatch| W2["⚙️ Worker w2"]
    W1 -->|report + artifacts| L
    W2 -->|report + artifacts| L
    L -->|judge: goal met?| V{{"✅ Summary & delivery"}}
```

Submit a goal to a channel and watch the lead decompose it, dispatch subtasks to idle workers, reassign failures, and roll the results up into a delivery summary — all visible live in the timeline, lanes and task board.

---

## Quick start

### Prerequisites

```bash
node -v   # ≥ 23.4.0 (node:sqlite required)
pnpm -v   # 11.x
```

> To use the `omp` harness (recommended for real work), install the `omp` CLI and make sure `omp` is on `PATH` (or set `command` in the agent config). The `mock` harness works out of the box for demos and integration tests.

### Install & run (development)

```bash
git clone https://github.com/kingdol666/AgentWorkShop.git && cd AgentWorkShop

pnpm install          # runs `nuxt prepare` via postinstall

pnpm dev              # dev server, port from config.yml → server.dev.port (default :3000)
```

Open **http://localhost:3000** — you are in.

### Production

```bash
pnpm build            # nuxt build → .output/
pnpm start            # node scripts/start.mjs → port from config.yml → server.prod.port (default :3001)
```

`scripts/start.mjs` reads `config.yml` and injects `HOST` / `PORT` before booting the Nitro output. `HOST` / `PORT` env vars take precedence.

### 60-second first session

1. **Sign in** — *Register* in the sidebar user menu (or `POST /api/users/register`), log in → the UI stores your API token.
2. **Create an agent template** — `Workshop → Agents → New` (name, harness = `mock` or `omp`, optional JSON config).
3. **Create a channel** — `Workshop → Channels → New`; pick a name and mark one agent as **lead**.
4. **Add workers** — put more agent templates into the channel (each placement clones an independent instance with its own identity token), or create a **Team** and *deploy* it in one shot.
5. **Submit a task** — open the channel, type a goal in the composer. The lead picks it up, decomposes, dispatches; you watch every event in the live timeline.

---

## Usage

### Authentication & tokens

Users authenticate with `email + password`; sessions are **bearer tokens** (no cookie required for API use).

| Endpoint | Purpose |
|---|---|
| `POST /api/users/register` | Create account `{ email, password, name? }` → returns a token |
| `POST /api/users/login` | Login → returns a token |
| `GET  /api/users/me` | Current profile |
| `POST /api/users/logout` | Revoke current token |
| `GET/POST /api/users/tokens`, `PATCH/DELETE /api/users/tokens/:id` | Token management (also in the `/tokens` UI) |

All `/api/workshop/**` routes require `Authorization: Bearer <token>`.

### Execution modes

Pass a mode prefix in the task description: `[mode:goal] …`, `[mode:loop] …`, `[mode:pipeline] …` (or pick a mode in the composer UI).

| Mode | Semantics | Config (description or UI) |
|---|---|---|
| `goal` | Lead decomposes → workers complete → **lead judges goal satisfaction**; loops with new subtasks until satisfied. | `goalCriteria` — criteria injected into the lead's supervision prompt |
| `loop` | Fixed-interval re-dispatch of the same task. | `intervalMs` (default `60000`), `maxIterations` (default ∞) |
| `pipeline` | Ordered stages; stage *N+1* receives stage *N*'s output. | `stages: [{ name, description, assigneeId? }]` |

### REST API at a glance

All routes return a uniform envelope and validate bodies with `zod`.

| Area | Routes |
|---|---|
| **Users / tokens** | `/api/users` (CRUD), `/api/users/login`, `/api/users/me`, `/api/users/tokens` (CRUD) |
| **Channels** | `/api/workshop/channels` (list/create), `/api/workshop/channels/:id` (get/patch/delete/activate), `.../messages`, `.../tasks`, `.../agents` (add/remove/patch/stop), `.../events`, `.../queue`, `.../memories` |
| **Agents (templates)** | `/api/workshop/agents` (list/create/get/patch/delete/subscribe) |
| **Teams** | `/api/workshop/teams` (CRUD), `.../members` (add/remove), `POST .../deploy` (clone whole team into a channel) |
| **Tasks** | `/api/workshop/tasks`, `/api/workshop/tasks/:id` (get/report/complete/cancel/retry/dispatch) |
| **Memory** | per-agent + channel memory: list / create / delete / `search`, plus `POST /api/workshop/memories/maintenance` |
| **A2A** | `GET /api/workshop/a2a/:agentId/card` (AgentCard), `POST /api/workshop/a2a/:agentId/rpc` (JSON-RPC 2.0), `POST /api/workshop/a2a/send` (peer message) |
| **Mail** | `GET /api/workshop/mailbox` (own inbox), `GET /api/workshop/mailbox/all` (lead: full channel mail log) |
| **System** | `GET /api/system/config`, `GET /api/system/monitor`, `POST /api/system/monitor/terminate` |
| **Game demo** | `/api/game/ws` (WS), `/api/game/brain`, `/api/game/cmd` |

**A2A JSON-RPC methods**: `tasks/send` (blocking, 30 s), `tasks/sendSubscribe` (SSE stream), `tasks/get`, `tasks/list`, `tasks/cancel`, `message/send`, `agent/getCard`.

---

## The four entry points

The same `AgentChannelManager` sits behind every door — pick the one that fits your client.

| Entry | Endpoint / transport | Audience | Notes |
|---|---|---|---|
| **WS (observe)** | `/api/workshop/ws?channelId=…` | Frontend / dashboards | AEP v1 envelopes with per-channel monotonic `seq`; 5000-event ring buffer; `sub` with `lastSeq` replays the gap, otherwise a full `channel.snapshot` re-aligns. Streaming `agent.delta` events power the typewriter UI. |
| **MCP (act)** | in-process server, 20 tools | Agents (host tools for `omp`) | Identity via per-instance bearer token. Management tools (`channel.create`, `task.submit`, …) are open; agent-work tools (`task.dispatch`, `a2a.send`, …) are strictly channel-scoped to the caller. |
| **A2A (interop)** | `POST /api/workshop/a2a/:agentId/rpc` | External A2A clients | Standard JSON-RPC 2.0 with A2A error codes; `AgentCard` at `/a2a/:agentId/card`; SSE via `tasks/sendSubscribe`. |
| **REST (admin)** | `/api/workshop/**` | Humans / scripts / orchestrators | The full management surface: channels, agents, teams, tasks, memory, workspaces. |

**MCP tool catalog**

| Group | Tools |
|---|---|
| Channel | `workshop.channel.create` · `workshop.channel.list` · `workshop.channel.remove` |
| Agent | `workshop.agent.create` · `workshop.agent.add` · `workshop.agent.definitions` · `workshop.agent.list` · `workshop.agent.remove` |
| Task | `workshop.task.submit` · `workshop.task.dispatch` · `workshop.task.list` · `workshop.task.get` · `workshop.task.report` · `workshop.task.complete` · `workshop.task.cancel` |
| A2A | `workshop.a2a.send` · `workshop.a2a.poll` · `workshop.a2a.subscribe` |
| Mail & queue | `workshop.mail.list` (lead: full channel mail log) · `workshop.queue.overview` (all-member status + queues) |

---

## Task state machine

```mermaid
stateDiagram-v2
    [*] --> SUBMITTED: task submitted to channel (routed to lead)
    SUBMITTED --> ASSIGNED: lead dispatches to a worker
    SUBMITTED --> WORKING: lead works it directly
    ASSIGNED --> WORKING: worker picks up from mailbox
    WORKING --> WAITING: waiting on subtask / input
    WAITING --> WORKING: dependency cleared
    WORKING --> COMPLETED: worker reports complete (artifacts)
    WORKING --> FAILED: retryable error (retry ≤ 3 → scheduler reassigns)
    WORKING --> CANCELED: cancelled by lead / user
    FAILED --> ASSIGNED: scheduler reassigns (retry_count + 1)
    COMPLETED --> [*]
    FAILED --> [*]
    CANCELED --> [*]
```

---

## A2A message & artifact model

All internal communication uses A2A semantics — one shape across WS, MCP, REST and A2A:

```ts
Part      = { text, mediaType? } | { data, mediaType? } | { url, … } | { raw, … }
Message   = { messageId, channelId, taskId?, fromAgentId, toAgentId?, role, parts: Part[], metadata }
Artifact  = { artifactId, name?, description?, parts: Part[], metadata? }   // task deliverables
```

---

## Persistent agent memory

- **Domains** — per-agent private + channel-shared (`__team__` sentinel row), isolated per channel.
- **Kinds** — `episodic-task` / `episodic-peer` (auto-harvested on completion, zero LLM cost) and `semantic` (human-curated, decay-exempt).
- **Retrieval** — FTS5 with CJK character segmentation (works for Chinese out of the box); optional `sqlite-vec` embedding provider upgrades recall to hybrid; ranking = `0.5×relevance + 0.3×recency + 0.2×importance` with a greedy token budget.
- **Dynamic pattern** — the runtime injects only a small "primer" budget (`AW_MEMORY_PRIMER_TOKENS`, default 300 tokens); agents fetch full content on demand via the `search_memory` tool and deposit lessons via `save_memory` (auto-routed private/shared, `dedup_key` de-duplication).
- **Maintenance** — `POST /api/workshop/memories/maintenance` runs decay cycles and housekeeping.

---

## Harness adapters

```
AgentInterface (contract: info · run · supervise · workspace tools · dispose)
 ├── MockAgentImpl      in-process, scripted — demos & tests
 ├── OmpRpcAgentImpl    spawns `omp --mode rpc` (lazy, reused across messages);
 │                      AgentWorkspace methods are registered as omp *host tools*,
 │                      so the agent calls report_progress / complete_task /
 │                      dispatch_task natively — no text parsing
 └── ClaudeSdkAgentImpl Claude Agent SDK adapter (scaffold)
```

Each spawned harness process is registered in a process registry (`harness-process.ts`) — the source of truth for the `/monitor` page, including orphan detection and process-tree kill (Windows `taskkill /T /F`, POSIX process-group `SIGKILL`).

---

## Architecture

```mermaid
flowchart TB
    subgraph FE["Frontend (Nuxt 4 / Vue 3)"]
        UI["Workshop UI — timeline · lanes · task board · memory panel"]
        STORES["Pinia stores"]
        WS["useWorkshopWs (AEP client, seq replay)"]
    end

    subgraph SRV["Server (Nitro / h3)"]
        REST["REST API  /api/workshop/**"]
        WSHUB["WS Hub  /api/workshop/ws (AEP v1)"]
        A2A["A2A JSON-RPC  /api/workshop/a2a/:agentId/rpc"]
        MCP["MCP Server  20 tools, in-process (L3)"]
        USR["Users & Tokens  /api/users/**"]
        MON["System monitor  /api/system/monitor"]

        subgraph RT["Runtime — server/services/workshop"]
            MGR["AgentChannelManager (object model + permission checks)"]
            SCH["SchedulerLoop — lead supervision tick + event wake"]
            MODE["ExecutionMode orchestrator  goal / loop / pipeline"]
            TE["TaskEngine — 7-state machine"]
            AR["AgentRuntime × N (per channel member: mailbox, queue, harness proc)"]
            MEM["AgentMemory — FTS5 + vector, budget recall, harvest"]
            BUS["ChannelBus — event fan-out (per-channel seq + ring buffer)"]
        end

        subgraph HB["Harness adapters (AgentInterface)"]
            MOCK["mock-agent (in-process)"]
            OMP["omp-agent (omp --mode rpc subprocess, host tools)"]
            CLD["claude-agent (SDK adapter)"]
        end

        DB[("SQLite — node:sqlite\nchannels · agents · channel_agents\nteams · tasks · messages\nmemories (FTS5) · channel_events")]
    end

    UI --> STORES --> WS
    STORES --> REST
    WS --> BUS
    REST --> MGR
    A2A --> MGR
    MCP --> MGR
    USR -.token auth.-> REST
    MON --> MGR
    MGR --> SCH
    SCH --> MODE
    MGR --> TE
    MGR --> AR
    AR --> MEM
    AR --> MOCK & OMP & CLD
    MGR --> DB
    TE --> DB
    MEM --> DB
    BUS --> DB
```

---

## Project layout

```
AgentWorkShop/
├── app/                        # Nuxt 4 frontend (srcDir)
│   ├── pages/                  # / · /workshop (+ agents · teams · /w/[wsId]) · /users · /tokens · /monitor · /settings
│   ├── components/workshop/    # TranscriptTimeline · AgentLanesView · TaskBoardView · MemoryPanel …
│   ├── composables/workshop/   # useWorkshopWs (AEP client) …
│   ├── stores/workshop/        # Pinia: channels · agents · tasks · user …
│   └── game/                   # Phaser RPG demo (client, scene, protocol)
├── server/
│   ├── api/                    # REST + WS routes (users · workshop · system · game · mcp)
│   ├── services/workshop/
│   │   ├── runtime/            # manager · agent-runtime · scheduler-loop · execution-mode
│   │   │                       # task-engine · memory · mailbox · monitor · channel-runtime
│   │   ├── agents/             # agent-interface · factory · mock-agent · omp-agent · claude-agent
│   │   │   └── adapters/       # omp-rpc-client (RPC transport)
│   │   ├── db/                 # schema.sql + repositories (node:sqlite)
│   │   └── types/              # a2a · task
│   ├── mcp/workshop-server.ts  # MCP server (20 tools)
│   ├── repositories/           # user repository
│   ├── schemas/ utils/ types/  # zod schemas · auth · response envelope
│   └── plugins/workshop.ts     # manager bootstrap (singletons)
├── shared/
│   ├── workshop-protocol.ts    # AEP v1 — the authoritative event protocol (both sides)
│   └── game-protocol.json/.ts  # game command registry (JSON → zod, "edit JSON, it just works")
├── config.yml                  # ⚙ single source of truth (ports · i18n · theme · security)
├── data/                       # runtime SQLite (git-ignored)
└── scripts/                    # e2e / stress / verification suites (tsx)
```

---

## Tech stack

| Layer | Technology |
|---|---|
| Framework | [Nuxt 4](https://nuxt.com) (compatibility v4) + Nitro (WS-capable) |
| UI | Vue 3.5 · Pinia (persisted) · Ant Design Vue 4 · UnoCSS (attributify + icons) |
| Visualization | ECharts / vue-echarts · Phaser 4 (game demo) |
| Language / typing | TypeScript 5.7, end-to-end; `shared/` modules imported by both sides |
| Persistence | `node:sqlite` (zero native deps) + FTS5 + optional `sqlite-vec` |
| Validation | `zod` — one schema per endpoint, compiled at the message boundary |
| Agent interop | `@modelcontextprotocol/sdk` · A2A (JSON-RPC 2.0) · custom AEP v1 WS protocol |
| i18n | `zh-CN` (default) / `en`, driven by `config.yml` |
| Quality | ESLint 9 (flat) · husky + lint-staged · commitlint (conventional) |

---

## Development

```bash
pnpm dev              # dev server (port from config.yml)
pnpm build && pnpm start   # production
pnpm typecheck        # nuxt typecheck
pnpm lint             # eslint .
pnpm lint:fix

# verification suites (scripts/)
node scripts/api-live-e2e.mjs     # live API e2e
node scripts/verify-game.mjs      # game rendering verification
pnpm game:test                    # agent brain + game session tests
```

> Husky pre-commit runs ESLint (with `--fix`) on staged files, and commitlint enforces conventional commit messages.

---

## Configuration

**`config.yml` is the single source of truth** — read once at build/dev by `nuxt.config.ts` and at production boot by `scripts/start.mjs`. Env vars (`.env`) can override the fields exposed via `runtimeConfig.public`.

| Key | Meaning |
|---|---|
| `server.host` / `server.dev.port` / `server.prod.port` | bind host; dev port (`pnpm dev`); prod port (`pnpm start`) |
| `api.baseURL` / `api.timeout` / `api.pageSize` / `api.maxPageSize` | API base, timeout, pagination defaults |
| `i18n.*` | default locale + locale list |
| `theme.primaryColor` / `theme.mode` | UI palette (cobalt-ink "drafting bench" theme) and light/dark |
| `security.sessionPassword` | session-cookie encryption key — **change in production** (or set `NUXT_SESSION_PASSWORD`) |

Runtime env knobs (optional): `AW_MEMORY_PRIMER_TOKENS` (memory primer budget), embedding-provider variables (see `server/services/workshop/runtime/embedding-provider.ts`).

---

## Design documents

- [`docs/superpowers/specs/2026-08-13-agent-workshop-multi-agent-design.md`](docs/superpowers/specs/2026-08-13-agent-workshop-multi-agent-design.md) — system design (roles, task model, four entry points, error handling)
- [`docs/superpowers/plans/2026-08-13-agent-workshop-multi-agent.md`](docs/superpowers/plans/2026-08-13-agent-workshop-multi-agent.md) — implementation plan + core contracts (T3/T5)
- [`docs/superpowers/plans/2026-08-15-agent-memory.md`](docs/superpowers/plans/2026-08-15-agent-memory.md) — persistent memory design
- [`docs/superpowers/plans/2026-08-16-agent-harness-frontend.md`](docs/superpowers/plans/2026-08-16-agent-harness-frontend.md) — harness & frontend plan

---

## Roadmap

| | Item | Status |
|---|---|---|
| ✅ | Channel runtime, lead orchestration, 7-state task engine | shipped |
| ✅ | Persistent memory (FTS5 + optional vector hybrid) | shipped |
| ✅ | Four entry points: WS (AEP v1) · MCP (18 tools) · A2A (JSON-RPC 2.0) · REST | shipped |
| ✅ | Token auth + user/token management UI, `/monitor` page | shipped |
| ✅ | Phaser 4 RPG demo (game protocol + agent brain) | shipped |
| 🔨 | Claude Agent SDK adapter — full parity with `mock` / `omp` | in progress |
| 📜 | License file | pending |
| ⚙️ | CI pipeline (typecheck + lint + e2e) | planned |
| 🧪 | Unit test suite for task engine / memory / scheduler | planned |

---

<div align="center">

## License

AgentWorkShop is an independent project and is **not an official product of Anthropic** or any LLM vendor. It integrates with agent harnesses (e.g. `omp`) through their public interfaces.

**License is TBD** — the license file will be added before the `v1.0` release.

<a href="https://star-history.com/#kingdol666/AgentWorkShop&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=kingdol666/AgentWorkShop&type=Date&theme=dark" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=kingdol666/AgentWorkShop&type=Date" />
    <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=kingdol666/AgentWorkShop&type=Date" width="100%" />
  </picture>
</a>

</div>
