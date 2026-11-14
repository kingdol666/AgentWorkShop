# Round 3 — Integration Hardening Plan (2026-11-14)

Base: `origin/main` at `af7f26c3` (PR #209 merge). Implementation in the isolated acceptance worktree; the paper tree stays untouched. Acceptance bar: every E2E/test-script suite green plus the full `aw-system-acceptance` skill matrix, with backend logic, frontend rendering/interaction, and front↔back integration each verified.

## Consolidated anomaly list (from rounds 1-2 + reviews + Mimosa triage)

Real problems to fix this round:

1. **serial-bridge `/probe` (P1 security)**: any authenticated user can open an arbitrary local serial port and write an arbitrary ASCII line (`sendLine`) — unaudited device-command injection surface.
2. **diag-bridge `/snapshot` (P1 security)**: accepts caller-supplied `line` with only plugin-level `auth:'user'` — any user can read any line's DAQ series and upload it to the external diagnostic service. `/runs`//`report` leak run metadata across users.
3. **diag-bridge exports (P1 integrity)**: `manifest.nodes[].file` joined without containment, symlinks accepted, no artifact hashes — a tampered/foreign file gets uploaded as evidence.
4. **RSI Beta scope has no production authority (P0 functional)**: scope comes only from plugin-private `ctx.kv` (`rsi.beta.scope`), which nothing provisions — in a real deployment Beta stays default-deny forever. Authorization must derive from durable host records (workspace mount + channel enabled + worker enabled/role), with the kv entry demoted to an optional provisioning constraint.
5. **Capability truth (P1 contract)**: descriptor advertises observe/simulate/replay/verify while the production adapter implements discover/snapshot/query only; and `snapshot` is missing from `ALLOWED_CAPABILITIES` so a legal plan step fails. Metadata must derive from the registered adapter summary.
6. **Foreign-ID oracle + candidate integrity + denial audit (P1)**: foreign research run id returns `ok:true, runs:[]`; candidate `add()` skips envelope/hash validation; denials produce no audit trail.
7. **Scope field dropping (P1)**: `normalizeScope` silently drops tenant/subject/window fields instead of failing closed.
8. **Plugin lifecycle (P1 robustness)**: `servicesExt.provide()` entries and DAQ frame processors/templates are never unregistered on reload/disable; setup-failure rollback does not await async disposers; kv retry timers survive dispose; hot reload kills the plugin's context adapter before the new load is known good.

Explicitly out of scope this round (documented, not silently skipped): physical HIL (needs authorized window); Mimosa full-coverage verdict (scanner-side); IDD `/results` proxy visibility (token-scoped service side, default-off).

## PR sequence

### PR-1 — `fix(plugins): close serial probe and diagnostic export surfaces`
- `/probe` admin-only via `event.awUser`; remove `sendLine` write entirely (backend + panel + plugin i18n).
- `/snapshot` requires `ctx.permissions.lineMode(user, line) ∈ {readonly, operate}`; `/runs` filtered by `visibleLineIds` (empty-line runs admin-only); `/report` re-checks the run's line; denials audited via lazy-imported `recordOps` (no payload).
- `readExportDataset`: canonical containment (`resolve` under the export root), symlink/regular-file rejection, per-node sha256 verification when the manifest carries hashes; `daq-export.ts` writes `sha256` per node file (legacy manifests stay readable, verification skips only the missing-hash case and reports it).
- Tests: `tests/builtin-plugin-security.test.ts` (probe admin gate, sendLine removal, snapshot line gate, export containment/hash/symlink, runs/report filtering).

### PR-2 — `fix(rsi): resolve beta scope from host authority and enforce evidence containment`
- `ContextRuntimeService.resolveScopeBinding({principal, requested})`: deployed-scope derivation (workspace mount + channel enabled + worker enabled/role) + principal authorization + channel bound line → the plugin treats kv `rsi.beta.scope` as an optional constraint (intersect when present; host derivation alone suffices when absent).
- `normalizeScope` rejects unknown non-empty scope fields (tenant/subject/window) instead of dropping.
- Capability truth: `ALLOWED_CAPABILITIES` gains `snapshot`; metadata/adapter routes derive advertised capabilities from the registered adapter summary (descriptor only as fallback); plan steps still fail closed on unsupported capabilities.
- Foreign run/evidence ids return uniform `SCOPE_FORBIDDEN`; requested `subjectRefs`/window narrow list results; candidate `add()` validates envelope + canonical hash before insert; Beta denials audited via `recordOps` (no payload).
- Tests: extend `tests/rsi-beta-plugin-lifecycle.test.ts` + `tests/rsi-beta-research-integration.test.ts` + a new host-derivation test on `ContextRuntimeService`.

### PR-3 — `fix(plugins): make extension lifecycle rollback complete`
- `servicesExt.provide()` gains owner tagging; reload/disable prunes entries of plugins no longer active.
- DAQ frame processors + templates: owner-tracked registries with `clearPluginProcessors/clearPluginTemplates`, called from the reload prune path.
- `rollbackPartialLoad` becomes async and awaits disposers.
- kv retry timers tracked + cancelled on dispose (generation-fenced callbacks).
- Context adapter lifecycle: plugins stop unregistering on dispose; the host prunes runtime-registry adapters whose ownerId is no longer an active plugin (after successful load and after failure-restore).
- Tests: failure-injection tests for service prune, processor/template cleanup, rollback await, kv retry fence, adapter prune.

### PR-4 — final acceptance round
- Shared `clickStep` retry helper reuse (model-loop M6.3) — small E2E hardening.
- Full `aw-system-acceptance` skill matrix (T0-T5) on merged main, RSI runner, Mimosa final deep scan, independent review, evidence PR.

## Exit criteria

- Every PR: focused tests + full affected-layer rerun green, CI success, merged with recorded SHA.
- Final: all suites green on merged main per the aw-system-acceptance checklist; no unexplained skips; physical HIL/Mimosa caveats stated honestly.
