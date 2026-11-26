# Runtime Harness / Native Model & Industrial Binding Hot-Load — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (native, user requested direct execution) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Let owner/admin choose the execution harness (omp / dsh / codex / opencode / claude / …) and that harness's own configured provider/model/effort for a **single session runtime instance** or at **template / member creation**, validate it before commit, and hot-swap the runtime on the next message; plus expose per-runtime industrial node/recipe bindings that take effect on the next tool call.

**Architecture:** Extend the existing `session_runtime_overrides` JSON (no schema change) with `harness` and explicit "suppress inherited selector" values; compute one *effective harness* at wire time so `implFactory`, Prefab capability resolution, session-context profile and channel mode all agree. Reuse the existing revision-CAS + `hotReloadRuntime` swap. Add a read-only binding summary API and a UI section that reuses the existing `agent-tools/bindings` mutation endpoints (authorization already live per call).

**Tech Stack:** Nuxt 4 / Nitro / TypeScript / `node:sqlite` / zod / Vue 3.5 / Ant Design Vue / `node:test`.

**Spec:** `docs/design/session-runtime-overrides.md` (current feature) + this plan's "Semantics" section. No separate spec file exists; the user request is the spec.

## Global Constraints

- Never modify `channel_agents.config_json` / `prefab_binding_json` or `channel_sessions.prefab_snapshot_json/hash` from the runtime-override path.
- Only `instanceKind='manual'` + `status='active'` sessions are writable; task/project sessions stay read-only.
- Only channel owner/admin may write; session clones are `role='worker'` (all clones, including cloned lead).
- Writes are revision-CAS; failures are 409 `RUNTIME_REVISION_CONFLICT`.
- Effective at **next turn** only; never interrupt the current turn.
- Never accept `command/args/cwd/env/rpcMode/settings/token` from the runtime API.
- Do not touch the frozen session binding snapshot (`productId/lineId/recipes`) — display it read-only; changing it requires a new session.
- Failure semantics are fail-closed and actionable; no silent fallback of an unsupported selector.
- No commit/push/release unless the user asks.

## Semantics (decided)

1. `harness` override: effective harness = `overrides.harness ?? clone.harness`. It drives `implFactory`, `resolveAgentCapabilitySet` (Prefab tool support), `SESSION_BRIEF_PROFILE_ENGINES`, and session-context profile.
2. `provider/model/effort` values:
   - string → set
   - `null` or absent → keep inheriting the clone/channel value
   - `''` (empty string) → **suppress** the inherited value for this runtime (delete from effective config). Needed because switching omp→codex with an inherited omp provider would otherwise reach codex.
3. On harness change the PATCH is validated against the **target** harness's catalog and Prefab profile; a leftover inherited selector that is invalid for the target harness is a 409 with the exact field, unless the same PATCH suppresses it with `''`.
4. Industrial node/recipe bindings (`agent_node_bindings`) are already read live at execution time. The UI reuses the existing mutation APIs; the backend only adds a read summary + a tool-surface refresh hint. No automatic runtime rebuild on binding change (avoids resetting engine conversation continuity); an explicit "rebuild" action is provided.
5. The frozen session scope (`productId/lineId/recipe versions`) stays immutable and is displayed read-only with a "new session required" note.

## Review Focus

- A harness swap with an inherited provider/model the target cannot use must fail **before** the DB commit (today it fails at next wire, after commit).
- Suppressing a selector (`''`) must delete the native alias too (omp `thinkingLevel`, opencode `variant`, pi `thinking`), not just `config.effort`.
- `resolveRuntimeForMember` must use the effective harness for Prefab capability resolution, otherwise a Prefab tool marked unsupported/supported by the old harness leaks into the new one.
- Binding summary must not leak resources from lines the caller cannot see, and must not mutate the frozen snapshot.
- All harnesses in `HARNESS_REGISTRY` must appear in the picker; ones with `available=false` are disabled with the probe error, and harnesses with no provider/model support hide those controls.

---

### Task 1: Profile support introspection + harness meta

**Files:**
- Modify: `server/services/workshop/agent-prefabs/profile.ts`
- Modify: `server/api/workshop/harnesses.get.ts`
- Test: `tests/runtime-profile-support.test.ts` (new)

**Interfaces:**
- Produces:
  ```ts
  export interface HarnessProfileSupport { provider: boolean, model: boolean, effort: boolean }
  export function profileSupportOf(harness: string): HarnessProfileSupport
  export function effortSettingKeyOf(harness: string): string | undefined
  ```
- `GET /api/workshop/harnesses` response item gains `profile: HarnessProfileSupport`.

- [ ] **Step 1: Write the failing test**
  Assert `profileSupportOf('omp') = {provider:true,model:true,effort:true}`, `codex = {false,true,true}`, `mock = {false,false,false}`, `claude = {false,true,false}`, and `effortSettingKeyOf('omp') === 'thinkingLevel'`, `('opencode') === 'variant'`, `('pi') === 'thinking'`, `('codex') === undefined`.
- [ ] **Step 2: Run `node --test tests/runtime-profile-support.test.ts` — expect FAIL (export missing).**
- [ ] **Step 3: Implement** by exporting read-only views over the existing `PROVIDER_HARNESSES` / `MODEL_HARNESSES` / `EFFORT_HARNESSES` / `EFFORT_SETTINGS`. Add `profile` to the mapped item in `harnesses.get.ts`.
- [ ] **Step 4: Run test — PASS.**
- [ ] **Step 5: Commit** `feat(runtime): expose per-harness profile support`.

---

### Task 2: Override schema v2 (harness + suppression) and effective-harness wiring

**Files:**
- Modify: `server/services/workshop/sessions/runtime-overrides.ts`
- Modify: `server/services/workshop/agent-prefabs/runtime.ts:50-100`
- Modify: `server/services/workshop/runtime/manager/runtime-wiring.ts:72-151`
- Test: `tests/session-runtime-harness-wiring.test.ts` (new)
- Update: `tests/session-runtime-overrides.test.ts` (harness no longer forbidden; use `command` as the forbidden key)

**Interfaces:**
- `SessionRuntimeOverrides` gains `harness?: string`; `SESSION_RUNTIME_OVERRIDE_KEYS` gains `'harness'`.
- `parseSessionRuntimeOverrides` preserves `''` for `provider|model|effort`.
- `applySessionRuntimeOverrides(config, harness, overrides)` deletes suppressed keys (including the native effort alias via `effortSettingKeyOf(harness)`) **before** applying the rest.
- `resolveRuntimeForMember` uses `effectiveMember.harness` in `resolveAgentCapabilitySet` and returns `member: effectiveMember`.
- `wireMember` reads overrides first and builds `AgentInfo` from `{...m, harness: effectiveHarness}`.

- [ ] **Step 1: Write failing tests**
  - `applySessionRuntimeOverrides({provider:'p',model:'m',effort:'high',thinkingLevel:'high'}, 'omp', {provider:'',model:'',effort:''})` yields none of those keys.
  - `parseSessionRuntimeOverrides('{"harness":"codex","provider":""}')` preserves both.
  - A clone with `harness:'omp'`, override `{harness:'codex'}`, `resolveRuntimeForMember` returns `member.harness==='codex'` and resolution input harness is codex (assert via a Prefab fixture whose tool is unsupported/ supported differently — simplest: assert `member.harness` + that `resolveAgentCapabilitySet` receives it by monkey-patching? Prefer a source assertion: `runtime.ts` contains `effectiveMember.harness` in the resolution call. Keep it as a source contract + behavior test).
  - `wireMember` test double: clone harness `fake`, override row `{harness:'other'}`; `implFactory` captures `agent.harness`; assert it received `other`.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run new test + `tests/session-runtime-wiring.test.ts` + `tests/session-runtime-overrides.test.ts` — PASS.**
- [ ] **Step 5: Commit** `feat(runtime): per-session harness override and selector suppression`.

---

### Task 3: Runtime service — harness validation, target catalog, dry-run

**Files:**
- Modify: `server/services/workshop/sessions/runtime-service.ts`
- Modify: `server/services/workshop/runtime/manager/admin-agents.ts:918-988` (audit fields)
- Modify: `server/api/workshop/channels/[id]/sessions/[sid]/runtime/[agentId].patch.ts`
- Test: `tests/session-runtime-harness.test.ts` (new)

**Interfaces:**
- `SessionRuntimeView` gains `baseHarness: string`, `profileSupport: HarnessProfileSupport`, `channelMode: 'generic' | 'production_line_integrated'`, `warnings: Array<{ code: string, message: string }>`; `harness` becomes effective.
- `EDITABLE_FIELDS` gains `'harness'`.
- PATCH body overrides schema gains `harness: z.string().trim().min(1).max(64).nullable().optional()`.
- Error codes: `UNKNOWN_HARNESS` 400, `HARNESS_UNAVAILABLE` 409, `RUNTIME_PROFILE_UNSUPPORTED` 409, `HARNESS_CATALOG_UNAVAILABLE` 503, `PREFAB_PROFILE_UNSUPPORTED` 409.

Rules to implement in `update()` before CAS save:
1. `mergeOverrides` accepts `harness` (string, non-empty, ≤64); `''` invalid.
2. Drop `harness` when it equals `member.harness` (inherit, not an override).
3. If `harness` present: `assertHarnessUsable(target, probeConfig)` via **dynamic import** of `../agents/harness-availability` (avoid the registry import cycle).
4. Fetch `catalogOf(targetHarness)` when harness changed or any of provider/model/effort present. Throw 503 on failure. Skip membership checks when `providers.length === 0` (free-text harnesses) but still run `applyPrefabProfile` structural validation.
5. Effective selectors for membership checks: override value (unless `''`) else base config value. `''` = absent.
6. `validateCandidate(..., targetHarness)` applies the Prefab profile with the target harness.
7. Warning when the session is a trusted integrated session and `harnessToolSurface(target) !== 'bridge'` (dynamic import) — response only, not a block.
8. Audit before/after adds `harness` and the suppression state; never include secrets.

- [ ] **Step 1: Write failing tests** (fixture with two catalogs):
  - `harness:'codex'` with inherited `{provider:'local',model:'gemma'}` → 409 `RUNTIME_PROFILE_UNSUPPORTED` naming `provider`.
  - same PATCH plus `provider:'',model:''` → revision+1, `harness==='codex'`, `effective.provider/model` undefined, `baseHarness==='omp'`.
  - `harness:'nope'` → 400 `UNKNOWN_HARNESS`; `harness:'mock'` on a member with model → allowed (catalog empty), `profileSupport` all false.
  - Prefab with omp `provider` + switch to codex → 409 `PREFAB_PROFILE_UNSUPPORTED` and no row written.
  - Catalog failure for target → 503 and no row written.
  - `editableFields` includes `harness`; view `harness` effective, `baseHarness` clone value.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run — PASS + existing runtime tests.**
- [ ] **Step 5: Commit** `feat(runtime): validate and persist session harness changes`.

---

### Task 4: Template / member creation-time harness + profile validation

**Files:**
- Modify: `server/services/workshop/agent-prefabs/profile.ts` (add `assertProfileStructurallyValid`)
- Modify: `server/services/workshop/runtime/manager/admin-channel.ts:439-455` (`createAgent`), `:478+` (`updateAgent`)
- Modify: `server/services/workshop/runtime/manager/admin-agents.ts:392-456` (`updateChannelAgent` pre-validation)
- Modify: `server/api/workshop/channels/[id]/agents/[agentId].patch.ts` (accept `harness`)
- Test: `tests/member-harness-change.test.ts` (new)

**Interfaces:**
- `export function assertProfileStructurallyValid(harness: string, config: Record<string, unknown>): void` — extract `provider/model/effort` and run `applyPrefabProfile(config, harness, {provider,model,effort})`; throws the same 409 codes; no catalog probe.
- `createAgent` / `updateAgent` call it before persisting.
- Member PATCH body accepts `harness?: string`; manager `updateChannelAgent` dry-runs the candidate member (new harness + existing config + existing prefab binding) via `resolveRuntimeForMember` and `prefabBlockedReason` **before** the transaction; failure → 409, nothing written.
- `updateChannelAgent` keeps `assertHarnessUsable`.

- [ ] **Step 1: Write failing tests**:
  - `POST /agents`-equivalent manager `createAgent({harness:'codex', config:{provider:'local'}})` → 409 (provider unsupported by codex).
  - `createAgent({harness:'codex', config:{model:'gpt-5'}})` → succeeds.
  - Member PATCH harness with a Prefab pinned to an omp-only provider → 409 and row harness unchanged.
  - Member PATCH harness with compatible config → row harness changed, runtime unloaded.
- [ ] **Step 2–5:** fail → implement → pass → commit `feat(members): harness/profile validation at creation and member edit`.

---

### Task 5: Runtime binding summary service + API

**Files:**
- Create: `server/services/workshop/sessions/runtime-bindings.ts`
- Create: `server/api/workshop/channels/[id]/sessions/[sid]/runtime/[agentId]/bindings.get.ts`
- Test: `tests/session-runtime-bindings.test.ts` (new)

**Interfaces:**
```ts
export interface RuntimeBindingSummary {
  channelId: string
  sessionId: string
  runtimeObjectId: string
  channelMode: 'generic' | 'production_line_integrated'
  lineId: string | null
  productId: string | null
  bindingSnapshotRevision: number
  frozenRecipes: Array<{ id: string, name: string, version: number }>
  bindings: Array<{ id: string, kind: 'daq'|'dcw'|'recipe'|'line-recipe', nodeId: string, name: string, unit: string, lineId: string | null, mode: 'auto'|'manual' }>
  resources: {
    daqNodes: Array<{ id: string, name: string, unit: string, lineId: string | null }>
    dcwNodes: Array<{ id: string, name: string, unit: string, lineId: string | null }>
    recipes: Array<{ id: string, name: string, version: number, lineId: string | null, productId: string | null }>
    lines: Array<{ id: string, name: string }>
  }
  toolRefresh: 'native' | 'list_changed' | 'per_turn'
  effectiveAt: 'next_turn'
}
export function createSessionRuntimeBindingService(db: DatabaseSync, deps: RuntimeBindingDeps): { get(input): RuntimeBindingSummary }
```
`RuntimeBindingDeps` injects the four resource listers + `lineMode` so the service is unit-testable; the API handler supplies the real `getDaqController()` / `getDcwController()` / `lineMode(user, lineId)` implementations.

Rules: resource lists are restricted to the channel line when bound; a resource whose line the caller cannot see (`lineMode === 'none'`) is omitted; frozen recipes come from `trustedSessionBindingIdentity(session)` and are name-resolved from the recipe list; unknown/deleted recipe ids keep `name: id`.

- [ ] **Step 1: Write failing tests** with fake deps: line filter, permission filter, frozen recipe versions preserved, bindings resolved with names, unknown runtime → 404.
- [ ] **Step 2–5:** fail → implement → pass → commit `feat(runtime): binding summary API for session runtime`.

---

### Task 6: Tool-surface refresh + explicit runtime rebuild

**Files:**
- Modify: `server/services/workshop/agents/omp-agent/helpers.ts` (export `refreshLiveOmpToolSurfaces()`)
- Modify: `server/services/workshop/runtime/manager/admin-agents.ts` (add `requestSessionRuntimeRebuild`)
- Modify: `server/services/workshop/runtime/manager/runtime-wiring.ts` (`runtimeRevisionChanged` honors a pending-rebuild flag; `hotReloadRuntime` clears it)
- Modify: `server/api/workshop/agent-tools/bindings/index.post.ts`, `[id].patch.ts`, `[id].delete.ts` (call `refreshLiveOmpToolSurfaces()` after a successful mutation)
- Create: `server/api/workshop/channels/[id]/sessions/[sid]/runtime/[agentId]/rebuild.post.ts`
- Test: `tests/runtime-rebuild-flag.test.ts` (new)

Rules: rebuild requests are accepted only for wired worker runtimes; response `{ queued: true, effectiveAt: 'next_turn' }`; leads are refused with 409 `RUNTIME_REBUILD_LEAD_UNSUPPORTED`. A pending rebuild makes `runtimeRevisionChanged` return true once; the next claimed message requeues and swaps.

- [ ] **Step 1: Write failing tests**: revision check true with only a pending flag; flag cleared after successful wire; rebuild endpoint refuses lead and non-wired.
- [ ] **Step 2–5:** fail → implement → pass → commit `feat(runtime): tool-surface refresh and explicit rebuild`.

---

### Task 7: Frontend — session runtime modal (harness, native catalog, bindings, frozen scope)

**Files:**
- Modify: `app/components/workshop/SessionRuntimeEditModal.vue`
- Modify: `app/components/workshop/SessionRuntimePanel.vue` (show effective harness + rebuild/more menu)
- Modify: `app/composables/workshop/useWorkshopApi.ts` (DTO additions + `getSessionRuntimeBindings`, `rebuildSessionRuntime`, `listHarnesses` typing reuse; binding mutation helpers may call existing REST paths)
- Modify: `i18n/locales/zh-CN.ts`, `i18n/locales/en.ts`
- Test: `tests/session-runtime-ui-contract.test.ts` (extend), `tests/runtime-bindings-ui-contract.test.ts` (new)

UI rules:
- Harness select from `GET /workshop/harnesses`; unavailable disabled with probe error; changing harness reloads `listHarnessProviders(newHarness)` and clears provider/model/effort to `''` when the previously inherited/selected value is not present in the new catalog (explicit suppression, visible as 「不指定」).
- Provider shown only when `profileSupport.provider`; model uses `a-auto-complete` (catalog options + free text); effort: select for `levels`, input for `freetext`, hidden for `unsupported`.
- 「节点与配方」section: current bindings with name/kind/mode; remove with `ConfirmPopover`; add via kind + resource select; manual→auto requires the existing confirm flow; note 「下一次工具调用生效；会话产线快照不随绑定变化」.
- Frozen scope read-only block (product/line/recipes + snapshot revision) with note 「变更需新建会话」.
- Save sends `harness` and `''` suppression values; 409 conflict keeps edits and offers refresh; success message says next turn.
- testids: `session-runtime-harness`, `session-runtime-model-custom`, `session-runtime-bindings`, `session-runtime-binding-add`, `session-runtime-frozen-scope`, `session-runtime-rebuild`.
- i18n zh/en parity for every new key.

- [ ] **Step 1: Write failing source-contract tests** naming each testid/API path/i18n key.
- [ ] **Step 2–5:** fail → implement → `npm run i18n:check` + contract tests pass → commit `feat(ui): session runtime harness and binding editor`.

---

### Task 8: Frontend — template and add-member profile UI

**Files:**
- Modify: `app/components/workshop/agents/AgentTemplateEditModal.vue`
- Modify: `app/pages/workshop/composables/useAgentTemplateForm.ts`
- Modify: `app/components/workshop/lanes/AddMemberModal.vue`
- Modify: `i18n/locales/zh-CN.ts`, `i18n/locales/en.ts`
- Test: `tests/template-profile-ui-contract.test.ts` (new)

UI rules:
- Template modal: harness select (existing) + 「运行模型」section (provider/model/effort) that reads/writes the parsed `configJson`; changing harness reloads its catalog and clears incompatible structured values (sets them out of the JSON).
- AddMemberModal: harness radio → registry-driven select; add the same profile section; `create` mode sends `config` with `provider/model/effort`; `template` mode keeps template config and only previews the template's harness.
- Free-text model id allowed everywhere; effort unsupported hides the control.
- testids: `agent-template-profile`, `agent-template-provider/model/effort`, `add-member-harness`, `add-member-provider/model/effort`.

- [ ] **Step 1: Write failing source-contract tests.**
- [ ] **Step 2–5:** fail → implement → i18n + contract pass → commit `feat(ui): harness and native model selection at template creation`.

---

### Task 9: Docs, gates, real acceptance

**Files:**
- Modify: `docs/design/session-runtime-overrides.md` (harness, suppression, bindings, rebuild, frozen scope)
- Create: `docs/design/runtime-harness-model.md` (short operator guide: where each harness reads its native model list; supported fields per harness)
- Evidence: `D:/tmp/aw-runtime-harness-20261126/` (screens, JSON, logs)

- [ ] **Step 1:** Run `npm run lint`, `npm run typecheck`, `npm run test:unit`, `npm run i18n:check`, `npm run docs:check`, `npm run readme:lint`.
- [ ] **Step 2:** `node bin/aw.mjs build`; start an isolated instance (`AW_MODE=home`, `AW_HOME=D:/tmp/...`, `PORT=3083`) and run `npm run test:boot-smoke`.
- [ ] **Step 3:** Real Chrome (puppeteer-core) script: create/edit a session runtime → change harness omp→codex (or dsh if installed) → assert panel revision/harness; add/remove a DAQ binding and assert the summary endpoint; verify frozen scope unchanged; screenshots.
- [ ] **Step 4:** If a local harness/model is available, send one real turn and capture JSONL/log proof of the model change; otherwise record NOT_RUN honestly.
- [ ] **Step 5:** Write the report with exact pass/fail numbers; do not claim security pass (no Mimosa run); do not commit/push/release.

## Out of Scope

- Re-binding a session's frozen `productId/lineId/recipe versions` (requires a new session; documented + read-only UI).
- Per-instance catalog probe overrides (`config.command` / `codexHome` / `dshHome` still use the global probe).
- `config.env` (currently inert platform-wide).
- Any change to task/project session runtimes.
- Automatic runtime rebuild on node/recipe binding change (explicit rebuild only).
