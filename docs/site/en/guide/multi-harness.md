# Multi-harness agent teams

Fourteen execution engines are interchangeable behind one `AgentInterface` contract — the
platform never knows which one drives an agent. They fall into three transport classes:

| Transport class | Engines | Shape |
|---|---|---|
| In-process | `mock` / `claude` | No external CLI: `mock` is a scripted in-process engine, `claude` is a persistent Agent SDK session (the SDK is imported dynamically; a missing dependency reports `HARNESS_NOT_CONFIGURED`) |
| Persistent session over a protocol | `omp` / `codex` / `dsh` / `qwen` / `hermes` / `opencode` | One long-lived child process per agent: `omp` = stdio RPC, `codex` = app-server JSON-RPC, `dsh` / `qwen` / `hermes` = ACP, `opencode` = serve + HTTP/SSE |
| Headless one-shot CLI with a structured event stream | `gemini` / `copilot` / `cursor` / `crush` / `goose` / `pi` | One process spawned per turn, resumed through the engine's own session id: `gemini` / `cursor` = stream-json, `copilot` = JSONL, `crush` = `run -q`, `goose` = stream-json, `pi` = `-p --mode json` |

`qwen` (`qwen --experimental-acp`, legacy Zed ACP) and `hermes` (`hermes acp`, standard
ACP v1) are both **persistent ACP sessions**, not part of the headless CLI family — they
are the same shape as `dsh`, with approvals over `session/request_permission` /
`requestToolCallConfirmation`.

## Per-channel engine & model selection

- Each channel sets a **harness → provider → model (+effort)** triple from the engine's
  live catalog (e.g. `zhipu-coding-plan/glm-5.3-flash` on omp, `ustc/glm-5.3-flash` on dsh);
- Members inherit it unless they override — **mixing engines in one team is a first-class
  setup**, not a workaround;
- Each harness declares its capability surface (steer / lead scheduling / HITL / terminal
  mirror / context stats / compaction), shown as badges in the UI.

## Engine integration matrix (verified 2026-09)

### In-process

| Engine | Integration | Custom provider | Same-turn steer | Programmatic HITL | e2e result |
|---|---|---|---|---|---|
| mock | in-process script (no LLM) | — | ✅ | — | for CI (full chain with no external dependency) |
| claude | Agent SDK in-process persistent session (`query()` + AsyncIterable streaming input) | ✅ (ANTHROPIC_BASE_URL gateway; Zhipu Anthropic-compatible verified) | ✅ streaming input | ✅ canUseTool | ✅ green |

### Persistent session over a protocol

| Engine | Integration | Custom provider | Same-turn steer | Programmatic HITL | e2e result |
|---|---|---|---|---|---|
| omp | `omp --mode rpc` persistent subprocess (own RPC protocol) | ✅ | ✅ native same-turn injection | ✅ extension_ui | ✅ green |
| codex | `codex app-server` NDJSON JSON-RPC v2 | ✅ (config.toml gateway) | ✅ turn/steer | ✅ requestApproval | ✅ green |
| dsh | `dsh --profile acp` standard ACP v1 | ✅ (DEEPSEEK_BASE_URL) | ❌ deferred | ✅ session/request_permission | ✅ green |
| qwen | `qwen --experimental-acp` (legacy Zed ACP) | ✅ (OPENAI_BASE_URL / OPENAI_MODEL; Zhipu OpenAI-compatible verified) | ❌ deferred | ✅ requestToolCallConfirmation | ✅ green |
| hermes | `hermes acp` standard ACP v1 (same shape as dsh) | ✅ (zai provider for GLM; HERMES_PROVIDER / HERMES_MODEL) | ❌ deferred | ✅ session/request_permission | scenario ready (real subprocess + real LLM; automatic SKIP with reason when credentials are missing) |
| opencode | `opencode serve` + HTTP API + global SSE | ✅ (models.dev) | ✅ admission | ✅ permission API | ✅ green |

### Headless one-shot CLI with a structured event stream

| Engine | Integration | Custom provider | Same-turn steer | Programmatic HITL | e2e result |
|---|---|---|---|---|---|
| gemini | `-p --output-format stream-json` | ❌ Google auth lock-in | ❌ | ❌ (--approval-mode policy) | pipeline ✅ / LLM needs native credentials (SKIP with reason) |
| copilot | `-p --output-format json` (JSONL) | ❌ GitHub auth lock-in | ❌ | ❌ (--allow-tool whitelist) | pipeline ✅ / LLM needs native credentials (SKIP with reason) |
| cursor | `-p --output-format stream-json` | ❌ Cursor account lock-in | ❌ | ❌ (no --force by default; changes are proposals) | pipeline ✅ / LLM needs native credentials (SKIP with reason) |
| crush | `run -q` (text one-shot) | ✅ (crushrc openai-compat, key via env; Zhipu verified) | ❌ deferred | ❌ | ✅ green (tool loop progress=100) |
| goose | `run --output-format stream-json` | ✅ (OPENAI_HOST / OPENAI_BASE_PATH; Zhipu verified) | ❌ deferred | ❌ pre-authorized posture | ✅ green (tool loop progress=100) |
| pi | `pi -p --mode json` (JSONL; prompt delivered as `@tempfile`) | ✅ (`--provider/--model` + `~/.pi/agent/models.json`) | ❌ | ❌ | scenario ready (real subprocess + real LLM; automatic SKIP with reason when credentials are missing) |

Safety posture for engines without HITL: AW bridge tools are platform-trusted and explicitly
whitelisted; engine-native write/exec tools stay at the engine's most conservative level
(gemini `--approval-mode default`, copilot only `--allow-tool aw`, cursor without `--force`
by default, goose headless fail-safe) — risky operations never happen silently.

## Engine installation & credentials (runtime config, never in source)

- Availability of every engine is probed via `GET /api/workshop/harnesses`; **11 of them**
  have an overridable command via the `harness.<engine>_command` setting (runtime group on
  the settings page): `opencode` / `codex` / `dsh` / `gemini` / `qwen` / `copilot` /
  `cursor` / `crush` / `goose` / `pi` / `hermes`;
- Three exceptions: **`omp` has no such setting** (its probe command is the literal `omp`),
  and **`mock` / `claude`** declare `probe: { inprocess: true }` — in-process engines with no
  external command to override at all;
- **Windows npm shim caveat**: the crush npm package may ship a broken `.cmd` shim (pointing
  at a missing run-crush.js); set `crush_command` to the package's `bin/crush.exe`;
- Credentials follow each engine's native mechanism: claude `ANTHROPIC_AUTH_TOKEN`,
  qwen `OPENAI_API_KEY`, goose `OPENAI_API_KEY`, crush `AW_CRUSH_API_KEY` (referenced by
  crushrc), pi `--provider/--model` + `~/.pi/agent/models.json` (apiKey passed through),
  hermes `GLM_API_KEY` (zai provider) with `HERMES_PROVIDER` / `HERMES_MODEL`,
  codex/dsh/opencode via their own login or gateway config.

## Availability checks

- `GET /api/workshop/harnesses` returns per-engine `available` (PATH probe for CLI engines;
  in-process engines are always available), `command`, `resolvedPath`, `error`;
- The UI **disables uninstalled engines** with an "not installed" suffix; the dashboard
  "execution engines" panel shows readiness;
- Pre-execution validation: seven entry points call `assertHarnessUsable` —
  unknown engine → 400 `UNKNOWN_HARNESS`, uninstalled → 409 `HARNESS_UNAVAILABLE`.

## Verified multi-engine parallel runs

`scripts/_dbg-multiharness-live-e2e.mjs` (against a production instance) runs several
engines in parallel, each in its own channel on a real Modbus line;
`scripts/e2e-multi-harness.ts [engine]` covers the tool-loop scenario for the 12 external
engines listed above (engines with a programmatic approval surface also run the HITL
scenario), with real subprocesses and a real LLM, and an automatic SKIP when credentials
are missing.

## LLM provider configuration

Channel-level `llm` (provider/model/effort) is chosen on the channel settings page; each
engine's provider catalog lives at `GET /api/workshop/harnesses/:harness/providers`.
Members inherit the channel default unless overridden.
