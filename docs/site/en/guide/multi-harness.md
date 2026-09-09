# Multi-harness agent teams

Fourteen execution engines are interchangeable behind one `AgentInterface` contract — the
platform never knows which one drives an agent: `mock` (in-process, for demos/CI), `omp`,
`codex`, `dsh`, `opencode`, `claude` (in-process SDK), plus the headless CLI family
`gemini`, `qwen`, `copilot`, `cursor`, `crush`, `goose`, `pi`, `hermes`.

## Per-channel engine & model selection

- Each channel sets a **harness → provider → model (+effort)** triple from the engine's
  live catalog (e.g. `zhipu-coding-plan/glm-5.3-flash` on omp, `ustc/glm-5.3-flash` on dsh);
- Members inherit it unless they override — **mixing engines in one team is a first-class
  setup**, not a workaround;
- Each harness declares its capability surface (steer / lead scheduling / HITL / terminal
  mirror / context stats / compaction), shown as badges in the UI.

## Engine integration matrix (verified 2026-09)

| Engine | Integration | Custom provider | Same-turn steer | Programmatic HITL | e2e result |
|---|---|---|---|---|---|
| omp | stdio RPC persistent session | ✅ | ✅ | ✅ extension_ui | ✅ green |
| codex | app-server JSON-RPC | ✅ (config.toml gateway) | ✅ | ✅ requestApproval | ✅ green |
| dsh | ACP v1 | ✅ (DEEPSEEK_BASE_URL) | ❌ deferred | ✅ request_permission | ✅ green |
| opencode | serve + HTTP/SSE | ✅ (models.dev) | ✅ admission | ✅ permission API | ✅ green |
| claude | Agent SDK in-process | ✅ (ANTHROPIC_BASE_URL gateway; Zhipu Anthropic-compatible verified) | ✅ streaming input | ✅ canUseTool | ✅ green |
| qwen | experimental-acp (legacy zed ACP) | ✅ (OPENAI_BASE_URL / OPENAI_MODEL; Zhipu OpenAI-compatible verified) | ❌ deferred | ✅ requestToolCallConfirmation | ✅ green |
| goose | run --output-format stream-json | ✅ (OPENAI_HOST / OPENAI_BASE_PATH; Zhipu verified) | ❌ deferred | ❌ pre-authorized posture | ✅ green (tool loop progress=100) |
| crush | run -q (text one-shot) | ✅ (crushrc openai-compat, key via env; Zhipu verified) | ❌ deferred | ❌ | ✅ green (tool loop progress=100) |
| gemini | -p --output-format stream-json | ❌ Google auth lock-in | ❌ | ❌ (--approval-mode policy) | pipeline ✅ / LLM needs native credentials (SKIP with reason) |
| copilot | -p --output-format json (JSONL) | ❌ GitHub auth lock-in | ❌ | ❌ (--allow-tool whitelist) | pipeline ✅ / LLM needs native credentials (SKIP with reason) |
| cursor | -p --output-format stream-json | ❌ Cursor account lock-in | ❌ | ❌ (no --force by default; changes are proposals) | pipeline ✅ / LLM needs native credentials (SKIP with reason) |
| mock | in-process script | — | ✅ | — | for CI |

Safety posture for engines without HITL: AW bridge tools are platform-trusted and explicitly
whitelisted; engine-native write/exec tools stay at the engine's most conservative level
(gemini `--approval-mode default`, copilot only `--allow-tool aw`, cursor without `--force`
by default, goose headless fail-safe) — risky operations never happen silently.

## Engine credentials (runtime config, never in source)

- Availability of every CLI engine is probed via `GET /api/workshop/harnesses`; the command
  is overridable per engine with the `harness.<engine>_command` setting;
- **Windows npm shim caveat**: the crush npm package may ship a broken `.cmd` shim (pointing
  at a missing run-crush.js); set `crush_command` to the package's `bin/crush.exe`;
- Credentials follow each engine's native mechanism: claude `ANTHROPIC_AUTH_TOKEN`,
  qwen `OPENAI_API_KEY`, goose `OPENAI_API_KEY`, crush `AW_CRUSH_API_KEY` (referenced by
  crushrc), codex/dsh/opencode via their own login or gateway config.

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
`scripts/e2e-multi-harness.ts [engine]` runs the tool-loop + HITL double scenario for any
engine (real subprocess + real LLM; automatic SKIP when credentials are missing).

## LLM provider configuration

Channel-level `llm` (provider/model/effort) is chosen on the channel settings page; each
engine's provider catalog lives at `GET /api/workshop/harnesses/:harness/providers`.
Members inherit the channel default unless overridden.
