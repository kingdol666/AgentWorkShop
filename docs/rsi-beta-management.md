# RSI Beta management surface and release boundary

> PR-9 adds read-only management visibility only. It does not change the core runtime, existing industrial UI, or control authorities.

## Panel

The `/plugins` page receives an `RSI Beta management status` panel from `.AgentWorkShop/plugins/rsi-interface-beta/client.mjs`. It reads the plugin's authenticated `GET /api/plugins/rsi-interface-beta/metadata` route and shows:

- Beta status, decision code, and explicit flags: `AW_RSI_BETA_ENABLED` and `AW_RSI_BETA_RESEARCH_ENABLED`, plus simulator, physical-HIL, actuation, and promotion state;
- required `workspaceId`, `channelId`, and `workerId` scope and the server's scope decision;
- RSI Beta adapter registration and health;
- source files and versions for Context, Research, and Evidence contracts;
- read-only boundary, candidate-evidence semantics, and current limitations.

The panel has no execute, approve, promote, control-write, or profile-activation controls. Refresh performs only the plugin's read-only metadata request.

## Default deny and visibility

- Missing flags, values other than the exact `1`, or unavailable persistence return `visible: false`; the panel shows only the default-deny reason.
- A request that supplies an exact scope which the host rejects (foreign/stale/unauthorized worker) returns `SCOPE_FORBIDDEN` with `visible: false`. With no scope supplied and no provisioned kv scope, metadata reports `SCOPE_UNBOUND` with `visible: true` and `available: false` — it is a discovery state, not a grant.
- The kv `rsi.beta.scope` entry is an optional provisioning constraint: when present it narrows/denies; when absent the host-derived `resolveScopeBinding` is authoritative.
- The panel never infers or expands scope from client state; every operational Beta route still re-checks host-derived scope (and the kv constraint when present) server-side.
- `AW_RSI_BETA_ACTUATION_ENABLED` or `AW_RSI_BETA_PROMOTION_ENABLED` set to `1` remains a hard denial.
- When the plugin is disabled or its client entry is absent, the host plugin page and existing settings UI remain unchanged.

## Read-only operational evidence (PR-C)

`POST /api/plugins/rsi-interface-beta/evidence/operational` reads operational evidence through the registered `rsi-interface-beta` context adapter's `observe` capability, which in turn uses the existing DAQ/DCW authorities:

- DAQ latest values with explicit `fresh`/`stale`/`missing` freshness and age, history via `tsdbQueryHistory` (explicit `fromMs < toMs` window required), tagged latest samples, and frame metadata/vector previews via `queryFrames`;
- DCW engineering value, readback value, `lastAckAt`/liveness, effective step limit and range, plus recent write-audit rows from the intervention ledger (ack, actual readback, actor, approval/recipe references).

Every response carries `readOnly: true`, `writeCount: 0`, a content hash and source revision. Requested line/node ids are validated against the host-derived bound-line set; foreign lines, nodes, or an empty bound-line set fail closed. Frame metadata is sanitized (full vector/image payloads such as `meta.points` are removed; previews are capped), history/tagged points and frames have a per-request aggregate budget with an explicit `source.truncated` marker, and abort signals are checked between reads. If the intervention ledger is unreadable, the response sets `source.writeAuditAvailable: false` with an error instead of pretending there were no writes. The route never writes, acknowledges, approves, promotes, or provisions device authority, and it cannot be used with `actuate`/`simulate`/`replay`/`verify` capabilities.

## Provenance and limitations

The panel displays contract metadata, not external payloads. It never presents candidate/anecdotal evidence as validated or control authority. Context, Research, and Evidence facts remain owned by their PR-1 through PR-8 contracts, adapters, and existing audit paths.

Beta remains a recommendation/evidence visibility boundary: it does not create a second write gateway, bypass HITL/permissions/audit, self-approve, promote learning candidates, or turn simulator/physical-HIL results into production control authorization.

## Release checklist

```text
- Beta flags default off and malformed values fail closed
- Exact worker scope required; no implicit inheritance
- Metadata and status routes are authenticated read-only plugin routes
- No actuation, promotion, approval, or write controls in the UI
- Existing /plugins and settings UI are unchanged when Beta is absent/off
- Context/research/evidence provenance and limitations are visible
- Operational evidence is read-only, line-bound, explicitly windowed, and hashed
- RSI plugin lifecycle, UI contract, typecheck, lint, docs, i18n, and build checks pass
```
