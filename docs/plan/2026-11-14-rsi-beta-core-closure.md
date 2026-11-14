# RSI Beta / Core Job-Flow Closure Plan

This tracked copy is the implementation plan for the 2026-11-14 audit. Base: `origin/main` at `abb678748f7ae7d06c8a6dd21c25e4f8f2437705`; implementation is isolated in `D:/codes/ABO/aw-rsi-final-accept-20261114`; the dirty paper tree `D:/codes/ABO/AgentWorkShop` is protected.

## Boundary

- No second SchedulerLoop, AgentTeam, PLC/DCW gateway, HITL authority, recipe authority, ACK/readback verifier, or audit ledger.
- Beta remains default-off, read-only, candidate-only, no actuation/approval/promotion.
- Plugin KV is research-state persistence only, never authorization authority.
- Simulation/mock/SQLite/fixture evidence never proves physical HIL or production control.
- Every PR is independently tested, reviewed, pushed, CI-checked, merged, then the next PR starts from actual `origin/main`.

## Baseline

On merged main `abb678748` in a clean isolated checkout:

- T0: lint + RSI redline (21 learning-loop files, 0 device-write calls), typecheck, docs 87/87, i18n 3328/3328, README lint: PASS.
- T1: unit 1634/1634, MCP 14/14, plugin lifecycle 22/22, SDK, Twin provider 5/5, skills 167/167: PASS.
- Build and npm pack: PASS.
- RSI simulation and isolated-home baseline compare: PASS.
- Scientific full chain 21/21 (mock boundary explicitly stated): PASS.
- Line governance 44/44 (isolated host/mock PLC): PASS.
- Ontology service 57/57: PASS.
- Model loop 52/53: UI Profile-description assertion failed.
- Optimizer live 89/93: obsolete UI selectors failed, and a real D13/device mismatch was exposed: model `maxStep=20` allowed a 13.04 engineering-unit move while effective DCW node/parameter step limit was 2. DCW correctly rejected the write; response still carried `approved:true` with failed ACK and `readValue` unchanged at 50.
- Ontology live: core assertions passed but final UI readiness timed out after 90s; rerun is required.
- Mimosa: sealed but incomplete (`selectedFiles=1837`, `completeness=partial`, `runStatus=inconclusive`, 34 findings, dependency risk 0). No security-pass claim.

## PR-A — enforce actual optimizer actuator limits

- D13 must intersect model-space maxStep (with scale/offset conversion) and current effective engineering step limit from node/parameter/recipe.
- Re-run the same check immediately before driver invocation; changed limits fail closed before any write.
- Preserve shared DCW write throat as final authority.
- Separate approval state from execution/ACK state: an approved card with failed/unverified execution cannot be reported as successful.
- Add node/parameter/recipe stricter-limit, unit conversion, drift, zero-write and unchanged-readback tests.
- Update the live optimizer fixture to derive expected limits from actual effective node state rather than hardcoding only the model limit.

## PR-B — host-owned Beta scope and capability truth

- Resolve Workspace/Channel/Worker and Channel-bound-line scope from existing durable authorities; provision/revoke on existing lifecycle or re-evaluate on every request.
- Include worker disable/removal, channel unmount, session clone and project assignment policy; preserve or reject unsupported tenant/subject/object/attribute/material/time-window fields, never silently drop them.
- Generate public capabilities from the registered adapter summary. Do not advertise observe/simulate/replay/verify until real implementations exist; expose snapshot if implemented.
- Add real plugin-host HTTP tests: off/on, authorized/unauthorized, worker revoke, cross-channel, Channel-bound-line, reload.

## PR-C — read-only operational evidence

- Add DAQ latest/history/tagged/frame reads through existing DAQ services.
- Add DCW ACK/readback/write-audit reads through existing authorities.
- Keep all operations read-only; no new write or approval path.
- Add stale/fresh, cross-line/channel, source revision/hash and no-write-counter tests.

## PR-D — evidence containment, integrity and audit

- Enforce exact scope plus subject/object/attribute/material/time-window containment for research/evidence create/list/get/cancel.
- Foreign IDs must return uniform `SCOPE_FORBIDDEN`, not `ok:true` with an empty list.
- Validate candidate envelope structure and canonical content hash on insertion, not only restore; keep append-only immutability.
- Route all Beta denials through privacy-safe existing audit sink with actor, scope IDs, capability, reason and request ID but no sensitive payload.
- Revoke behavior must terminate or deny in-flight research and persist the state.

## PR-E — plugin and extension lifecycle hardening

- Owner/generation-tagged service, DAQ processor/template and adapter registrations; drain/revoke old generations.
- Snapshot/restore context adapters/services on failed reload; await async rollback disposers.
- Fence KV retry timers by generation and cancel them on dispose.
- Add disable/reload/failure-injection tests proving no stale handler, service, processor, template or adapter remains.

## PR-F — builtin serial/diagnostic security closure

- Restrict serial probe to admin/operate and registered paths; remove arbitrary caller `sendLine` or use fixed read-only probe frames.
- Enforce line authorization for diag snapshot/runs/report/results.
- Canonicalize export paths, enforce root containment, reject symlinks/non-regular files, and verify SHA-256 artifacts before upload.
- Triage all remaining Mimosa advisories by actual data flow; scanner false positives are not silently treated as fixed.

## PR-G — real compatibility matrix

Add an isolated host-level matrix connecting Workspace → Channel → Worker/AgentTeam → Session/Project/Scheduler context → Recipe/DAQ evidence → HITL outcome references → DCW ACK/readback evidence, with Beta remaining read-only. Include paired feature-off/on behavior, current DOM UI selectors, and explicit mock/simulation vs physical-HIL labels.

## Exit criteria

- Every PR independently reviewed, CI green, merged with recorded SHA.
- Pull merged `origin/main` into a new clean isolated acceptance tree; never alter the paper tree.
- T0–T5 current evidence has exact command, timestamp, HEAD and environment classification.
- Physical HIL only with an authorized operator/window; otherwise BLOCKED/NOT RUN.
- Final Mimosa must be complete and sealed to be called complete; partial/inconclusive remains so and is never called secure.
