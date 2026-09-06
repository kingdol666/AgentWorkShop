# Multi-harness agent teams

Six execution engines are interchangeable behind one `AgentInterface` contract — the
platform never knows which one drives an agent: `mock` (in-process, for demos/CI), `omp`,
`codex`, `dsh`, `opencode` (real engine subprocesses over RPC/ACP/JSON-RPC) and `claude`
(SDK adapter).

## Per-channel engine & model selection

- Each channel sets a **harness → provider → model (+effort)** triple from the engine's
  live catalog (e.g. `zhipu-coding-plan/glm-5.3-flash` on omp, `ustc/glm-5.3-flash` on dsh);
- Members inherit it unless they override — **mixing engines in one team is a first-class
  setup**, not a workaround;
- Each harness declares its capability surface (steer / lead scheduling / HITL / terminal
  mirror / context stats / compaction), shown as badges in the UI.

## Environment availability check

- `GET /api/workshop/harnesses` returns per-engine `available` (PATH probing of the
  external CLI; in-process engines are always available), `command`, `resolvedPath`,
  `error`;
- the UI **disables not-installed engines** in selects and marks them "not installed";
  the dashboard shows an engine readiness panel;
- dispatch is hard-checked at seven entry points with `assertHarnessUsable` — unknown
  engine → 400 `UNKNOWN_HARNESS`; not installed → 409 `HARNESS_UNAVAILABLE` (human-readable).

## Verified multi-engine parallelism

`scripts/_dbg-multiharness-live-e2e.mjs` (against a production instance) runs four engines
in parallel, each in its own channel on a real Modbus line:

| Engine | Scenario | Marker |
|---|---|---|
| omp | closed loop (write → sample → judge keep) | `OMP-CLOSEDLOOP-OK` |
| codex | data control (real register write + journal) | `CODEX-WRITE-OK` |
| dsh | data acquisition (line_context + daq_query) | `DSH-DAQ-OK` |
| opencode | recipe write + rollback (recipe_update → recipe_rollback) | `OC-RECIPE-OK` |

## LLM provider configuration

The channel-level `llm` (provider/model/effort) is chosen in the channel settings; each
engine's catalog is at `GET /api/workshop/harnesses/:harness/providers`. Members inherit
the channel default unless they override.
