# ADR-PR0: Additive Beta RSI Boundary Contract

- **Status:** Accepted for PR-0 baseline
- **Date:** 2026-11-13
- **Scope:** Documentation and baseline evidence only; this ADR does not add or wire runtime flags.
- **Plan anchor:** `docs/plans/2026-11-13-operational-context-research-learning-framework.md`, PR-0 and §12.

## Context

The Operational Context & Research Learning Framework extends the existing RSI (research and self-improvement) surface to domain-neutral contexts. The first implementation step must be additive and must not create a second control path, a second approval path, or a second promotion authority. Existing industrial behavior remains the compatibility baseline while later PRs add generic context, adapter, research, evidence, and RSI contracts.

The current repository already has stable control, HITL, and audit authorities. This ADR records the boundary that future Beta RSI work must preserve. The exact authority files and their baseline content hashes are recorded in [`2026-11-13-rsi-beta-baseline.json`](../audit/evidence/2026-11-13-rsi-beta-baseline.json).

## Decision

### 1. Additive Beta boundary

1. Beta RSI MUST add contracts through domain-neutral `ContextSubject`, `DomainObject`, `Attribute`, `MaterialAssignment`, context snapshots, evidence envelopes, extensions, and adapters.
2. Domain semantics MUST be supplied by versioned extensions and runtime facts/execution MUST be supplied by adapters or plugins. PVA, injection, WWTP, `line`, `product`, `recipe`, and `run` are profiles or compatibility projections, not required core schema entities.
3. Beta RSI MUST NOT replace, fork, or bypass the existing industrial control, HITL, permission, or audit surfaces. Compatibility views may remain, but a new generic surface cannot become a write or approval authority.
4. PR-0 is documentation-only. No runtime source, schema, plugin, flag reader, or API implementation is introduced by this change.

### 2. Default-off flags

The following names are the normative Beta flag contract for follow-up implementation. They are **reserved documentation names in PR-0**; they are not claimed to exist in the current runtime. An absent, malformed, or unrecognized value MUST resolve to `false`.

| Flag | Default | Contract boundary |
|---|---:|---|
| `AW_RSI_BETA_ENABLED` | `false` | Enables the Beta surface only after explicit deployment opt-in. |
| `AW_RSI_BETA_RESEARCH_ENABLED` | `false` | Enables generic research orchestration; it does not grant actuation or promotion. |
| `AW_RSI_BETA_SIMULATOR_ENABLED` | `false` | Enables an explicitly selected simulator/replay profile. Simulator evidence remains simulation evidence. |
| `AW_RSI_BETA_PHYSICAL_HIL_ENABLED` | `false` | Enables a separately reviewed physical-HIL acceptance profile; it does not grant Beta actuation. |
| `AW_RSI_BETA_ACTUATION_ENABLED` | `false` | Reserved for a future separately approved change. It MUST remain false for the Beta baseline. |
| `AW_RSI_BETA_PROMOTION_ENABLED` | `false` | Reserved for a future separately approved change. It MUST remain false for the Beta baseline. |

Flags are gates, not authorities. Enabling a flag cannot widen scope, skip HITL, waive evidence requirements, or change the stable authority files listed in the baseline manifest.

### 3. Default-deny scope

Beta access is denied unless every required boundary is explicit and valid:

- actor identity and tenant/workspace scope;
- subject/object/attribute/material references and their access scope;
- requested capability and adapter declaration;
- research case/profile authorization;
- evidence provenance, time window, source revision, content hash, and freshness where evidence is consumed; and
- the applicable approval policy for any high-risk operation.

There is no implicit parent-to-child write inheritance. `line/product/recipe/run` selectors are industrial-adapter compatibility selectors only; they do not grant generic context access. Cross-tenant, cross-workspace, cross-subject, unsupported-capability, stale-evidence, unknown-delivery, and missing-scope cases MUST fail closed with an auditable denial rather than an empty success.

An Agent MUST NOT approve its own research, evidence, learning artifact, profile, or promotion action. `candidate` and `anecdotal` artifacts are not readable as control authority merely because they are present in storage.

### 4. No actuation

The Beta RSI layer is recommendation/evidence-only. It MUST NOT:

- call PLC, DCW, MES, driver, or direct database write APIs;
- create a parallel write gateway or approval mechanism;
- synthesize a readback, ACK, or physical result when no adapter supplied one; or
- turn a simulator result into a physical action.

A future research step may describe an `actuate` request as a proposal or approval payload, but actual physical execution remains outside the Beta boundary and, if separately authorized, MUST enter the existing DCW/HITL/permission/audit chain. `AW_RSI_BETA_ACTUATION_ENABLED=false` is therefore a hard Beta baseline invariant, not a soft prompt-level preference.

### 5. No promotion

Beta learning outputs are limited to evidence-linked `candidate` or `anecdotal` results. Beta MUST NOT:

- mark an artifact `validated`;
- activate a profile or pin;
- compile a candidate into control guidance or a hard control guard; or
- invoke a promotion endpoint as part of the Beta loop.

Existing owner/admin promotion and profile lifecycle behavior remains a stable compatibility surface and is not redefined by this ADR. Any future Beta-to-validated path requires a separate implementation decision with independent evidence, approval, scope checks, and rollback tests. `AW_RSI_BETA_PROMOTION_ENABLED=false` remains a hard Beta baseline invariant.

### 6. Stable core authorities

The following files are the stable authorities for the behaviors Beta RSI must reuse. Their repository-root-relative paths, stable path aliases, and baseline hashes are machine-recorded in the manifest.

| Stable concern | Authority | Required invariant |
|---|---|---|
| Physical write throat | `server/services/workshop/dcw/dcw-controller/write.ts` (`dcw/dcw-controller/write.ts`) | All accepted/rejected DCW writes continue through the existing interlocks, limits, pacing, hold window, driver call, and write outcome path. |
| Tool-level approval wait | `server/services/workshop/agents/tool-approvals.ts` (`agents/tool-approvals.ts`) | Approval is explicit; timeout/expiry and cancellation resolve as denial; approval history remains auditable. |
| Unified HITL decision | `server/services/workshop/agents/hitl-decision/decide.ts` (`agents/hitl-decision/decide.ts`) | Authorization, atomic claim, native dispatch, confirmed finalization, failure, unknown delivery, and audit remain one decision flow. |
| HITL HTTP boundary | `server/api/workshop/hitl/respond.post.ts` (`api/workshop/hitl/respond.post.ts`) | The route validates input and delegates to the unified decision service; it is not a second decision authority. |
| Operations/audit sink | `server/services/workshop/ops/ops.ts` (`ops/ops.ts`) | Scope normalization and audit/ops logging remain fail-safe and must not be bypassed by Beta code. |
| Successful write evidence | `server/services/workshop/dcw/dcw-controller/write-audit.ts` (`dcw/dcw-controller/write-audit.ts`) | Successful writes retain operator/source/task/approval context, outcome/readback, and intervention evidence at the existing audit point. |

Beta code may consume the resulting contracts or evidence through an adapter boundary, but MUST NOT fork these responsibilities or silently replace their records.

### 7. Rollback and disablement

Rollback is a first-class contract:

1. The first rollback action is to set the relevant Beta flag(s) to `false`; absent or invalid configuration is already the safe state.
2. A disabled or retired extension, adapter, profile, or learning artifact MUST be excluded from new runs and new recall/pin results.
3. In-flight Beta work that loses authorization, scope, capability, freshness, or evidence validity MUST stop or enter explicit human review; it MUST NOT continue by falling back to a wider scope or physical action.
4. Previous stable behavior remains available because PR-0 is additive and does not replace the six authorities above.
5. Restoring a prior learning/profile version is an explicit, auditable rollback operation. Automatic degradation-triggered rollback is not part of the Beta baseline; an operator/owner/admin decision remains required for behavior-changing rollback.
6. Rollback MUST preserve historical evidence and audit records. It retires or supersedes references; it does not rewrite history or delete the source evidence needed for review.

### 8. Simulator versus physical HIL

Simulator and physical hardware-in-the-loop (HIL) are separate evidence classes and deployment modes.

| Mode | Default | Permitted Beta use | Not implied |
|---|---:|---|---|
| Simulator/replay | Off | Explicitly selected virtual subject, deterministic/replayed observations, simulation verification, and contract testing. | No physical readback, ACK, production validity, actuation permission, or promotion. |
| Physical HIL | Off | Separately approved acceptance profile with declared hardware/adapter identity, time window, scope, and operator context. Read-only observation can be evaluated as HIL evidence. | No automatic production enablement, no Beta actuation, no promotion, and no simulator-to-HIL equivalence. |

A simulator pass does not authorize physical HIL. A physical HIL pass does not authorize production control or learning promotion. Any separately authorized physical write must still pass the stable DCW, approval, decision, permission, and audit authorities; it is not a Beta shortcut.

## Consequences

- Follow-up PRs can add generic contracts and adapters without changing the industrial control throat.
- The safe deployment posture is explicit: all Beta flags off, no actuation, no promotion, and no implicit scope.
- Simulator acceptance can run without hardware, while physical HIL remains separately attributable and reviewable.
- A future implementation must preserve the flag semantics and stable authority paths recorded here; changing them requires a new ADR or an amendment with new evidence.
- This ADR intentionally does not claim that the documented flags are implemented by the current runtime.

## Acceptance checks for PR-0

- [x] ADR exists under `docs/architecture/`.
- [x] Machine-readable baseline manifest records all six stable authorities with exact repository paths and hashes.
- [x] The contract states additive boundaries, default-off flags, default-deny scope, no-actuation, no-promotion, rollback, and simulator/physical-HIL separation.
- [x] Runtime source is unchanged by PR-0.
- [ ] Runtime implementation of the reserved flags is deferred to a later implementation PR.
