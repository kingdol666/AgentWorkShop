# Governed product experience

Since v0.14.0, RSI experience runs under three governed layers — **immutable versions, one resolver, a release gate**. An experience goes through five auditable stages before an agent uses it: **versioning → evidence gate → human review → release → injection**, and every stage can be withdrawn independently.

## Version lifecycle

- Every experience write lands in `experience_versions`: body and evidence-snapshot hashes are insert-only; any body/evidence/scope change creates a new `candidate` version (CAS head pointer, `EXPERIENCE_VERSION_CONFLICT` on races).
- The lifecycle `candidate → evaluating → validated` and the deployment `none → shadow → canary → active` are **independent**; validation state is not deployment state.
- Upgrade migration backfills existing rows as `legacy-unverified` (historical `retired` stays `retired`) — old rows without resolvable provenance **do not inherit deployment permission** and are never auto-injected.

## The one resolver

Every read path (automatic injection, explicit retrieval, review projection) shares one entry, gated in order:

1. **Authorization epoch**: membership/role/binding/product/experience permission changes advance a durable epoch; a mismatch rejects (`EPOCH_STALE`);
2. **Scope hard filter**: line/product experience is visible only when the current product and recipe revision match; unknown never widens;
3. **Purpose tiers**: `automatic` returns only `validated` + `canary/active`; `explicit` shows undeployed validated rows marked as reference; `review` sees candidates.

After revocation, product switch or retirement, old content stops being injected on the next turn (overlay cache keys include the epoch).

## Evidence and promotion

- Independence is counted by **host-derived support units** (run/batch/seed): same-source retries, splits, and restatements of previously injected claims do not count;
- Claim clusters require matching product, variable, unit, direction, condition and recipe revision; Beta descendants and legacy rows never enter a promotion cluster;
- Promoting to `validated` requires the evidence gate (≥2 independent support units, complete task evidence).

## Release and withdrawal

- Promoting to `active` requires a **host-provenanced evaluation** (`host-evaluation` ledger row carrying the real C−B measurements); client-submitted bench is display-only;
- Release = pending request + audit outbox (one transaction) → audit acknowledged → CAS activation; requester and reviewer must differ (maker-checker);
- One active per scope: activating a new version withdraws the previous one; withdrawal stops injection without rewriting reviewed facts.

## Plant write-attempt ledger

Every plant write persists `prepared → dispatched → verified | rejected | not_sent | unknown`. After a process restart, reconciliation classifies unclosed attempts: `prepared` → `not_sent` (driver never called), `dispatched` → `unknown` (may have applied). **`unknown` is never auto-resent** and requires independent verification; an old approval is rejected when generation, lease, context or payload differ.

## Project plan progress

Project observability exposes `planProgress` (`pending_approval / applied / rejected / attention_required`); while a plan approval is pending, manual work items that conflict with it are rejected with `PLAN_CHANGE_PENDING`, and non-conflicting manual paths remain available.

## Boundaries (read this)

- Experience is **low-trust reference data**, never the authority for system instructions, tool authorization, device writes or safety limits;
- Deployment requires the explicit human release gate; `shadow` feeds isolated evaluation only; `legacy-unverified` is never auto-injected;
- Simulation evidence is not physical HIL or production approval; effect validation requires independent prospective samples under a frozen protocol;
- Site admission follows the [independent checklist](./governed-industrial-pilot-admission-template) and is separate from this document's software conclusions.

## Related documents

- [Implementation plan and acceptance criteria](https://github.com/kingdol666/AgentWorkShop/blob/main/docs/superpowers/plans/2026-11-20-governed-product-learning-and-industrial-readiness.md)
- [Merged-main audit report](https://github.com/kingdol666/AgentWorkShop/blob/main/docs/audit/governed-product-learning-main-audit.md)
- [Isolated simulation acceptance report](https://github.com/kingdol666/AgentWorkShop/blob/main/docs/audit/governed-product-learning-acceptance.md)
- [RSI experience evolution](../rsi)
