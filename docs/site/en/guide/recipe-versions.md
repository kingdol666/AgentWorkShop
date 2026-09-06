# Recipe versioning

Every recipe parameter change is versioned with attribution — **source (user/agent/system),
operator, reason** — and rollback is non-destructive (a new version is created; history is
preserved forever). This is the governance base for online closed-loop optimization.

## Versioning rules

- A recipe starts at `v1`; parameter changes outside an active batch bump the version and
  push the previous version into `paramsHistory` (capped at 20);
- Each entry: `{ version, params, at, by, actorName, actor, description }`;
  - UI edits attribute the signed-in user;
  - agent `recipe_update` attributes "Channel/Member" with a mandatory reason;
- Batch-level safety net: a `keep`-judged optimization record can mark a **lastGood batch**
  (a frozen parameter snapshot).

## REST

```bash
# version history (old → new, last row = current)
GET /api/workshop/dcw/recipes/:id/versions

# rollback: to a version / to the lastGood batch freeze (creates a new version)
POST /api/workshop/dcw/recipes/:id/revert
{ "version": 2, "reason": "UI revert" }
{ "toLastGood": true, "reason": "back to good batch" }
```

## Agent tools

| Tool | Purpose | Authorization |
|---|---|---|
| `line_context` | panorama of my line/product/recipe (targets vs PLC values) | line of bound nodes |
| `recipe_versions` | version history + param diffs (who/when/why) | same |
| `recipe_update` | save best parameters (partial merge, reason required, new version) | per-node dcw binding |
| `recipe_rollback` | roll back to a version / lastGood (reason required) | same |

For per-node value history use `dcw_journal`; for a single-node restore use `dcw_rollback`.

## Stale-node guard

When a node referenced by a recipe is deleted, disabled or unbound:

- dispatch (one-click apply / line start) **skips** those parameters and records the reason
  ("disabled / unbound / deleted") in the batch results;
- the UI grays the chips with badges; the edit form auto-removes deleted rows with a banner;
- agent `recipe_update` rejects touches on stale nodes with precise reasons and auto-prunes
  stale baseline params (with notice) when saving;
- rolling back to a version containing stale nodes prunes them and records the pruning in
  the version description.

## Closed-loop example

```
Agent: line_context (confirm ownership and current values)
  → dcw_control (trial value) → daq_query (evidence)
  → dcw_judge keep (evidence sufficient) → recipe_update (persist as vN)
on failure: recipe_rollback (to_last_good or version) → new version, PLC untouched
```
