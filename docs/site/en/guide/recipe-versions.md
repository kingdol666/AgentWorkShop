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
| `line_context` | panorama of my line/product/recipe (targets vs PLC values) | lines of bound nodes ∪ channel-bound line (read-only) |
| `recipe_versions` | version history + param diffs (who/when/why) | same |
| `recipe_trial` | **multi-parameter candidate batch trial**: dispatch all intended changes in one batch without writing a recipe version (hypothesis required; ≥5 min per-line cadence) | per-node dcw binding |
| `recipe_apply` | batch-dispatch the current saved version — the formal dispatch after `recipe_update` | ≥1 bound node of the recipe |
| `recipe_update` | save best parameters (partial merge, reason required, new version) | per-node dcw binding |
| `recipe_rollback` | roll back to a version / lastGood; with `dispatch: true` = **unified rollback** (definition revert + batch re-dispatch of that version's params to the PLC) | same |

For per-node value history use `dcw_journal`; for a single-node restore use `dcw_rollback`.

## Recipe-chain closed loop (v0.7.53)

Inside the optimization loop every parameter change flows through **recipe management** —
mirroring how human process engineers work; modification (trial) and adoption (update) are
separate steps:

```
multi-parameter candidates (knowledge + data evidence)
  → recipe_trial batch trial (no version written; four-layer bounds still enforced; ≥5 min cadence)
  → wait for process inertia → daq_query re-measure
      progress / target met → recipe_update adopt (same recipe id, version +1) → recipe_apply formal dispatch
      regression            → recipe_rollback { dispatch: true } unified rollback (definition revert + PLC batch restore)
```

- `dcw_control` / `param_control` single-parameter dispatch is disabled inside the
  optimization loop (prevents single-knob oscillation; AML exploration small-step excitation
  is the exception);
- trials skip the 60s / single-step interlocks by design (recipe path) — anti-oscillation
  comes from "batch + cadence + judge gating";
- trials / applies / rejections are fully audited (`recipe.trial` / `recipe.apply` /
  `dcw.write.rejected`);
- with `security.recipeDispatchApproval` on, trial/apply batch dispatches first pass a
  **human decision gate** (a rejection's guidance flows back to the agent verbatim; see
  [HITL approvals](/en/guide/hitl)).

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
  → recipe_trial (multi-param batch trial, no version written) → daq_query (re-measure)
  → progress: recipe_update (adopt as vN, same id) → recipe_apply (formal dispatch)
  → regression: recipe_rollback (dispatch=true) unified rollback (definition revert + PLC batch restore)
single-node emergency nudge (outside the recipe chain): dcw_control → dcw_judge → dcw_rollback
```

**Evidence is batch-scoped by default**: `daq_query` resolves the node's active run and
filters by that batch's `run_id` + `recipe_id`, so after a recipe switch an agent always
reads *the recipe currently running* and never a mix of the previous batch. The header prints
`run=<id> recipe "name" (recipe_id)` and the effective scope is restated per node at the end.
For cross-recipe comparison or history review pass `scope: 'all'`, or give an explicit
`recipe_id` / `run_id` / `product_id`; a line that is not running stays unfiltered, so
historical samples remain queryable.
