# Ontology & the AI-first model loop

> The platform has three modeling layers: **ontology** (constraints & knowledge), **twin** (the virtual plant), and the **solver profile** (optimization execution config).
> All three can be created and iterated by agents through tools, with humans approving and correcting at the governance points. This page is the complete surface and the invariants.

## Why an ontology

Industrial automation never lacks data — it lacks **executable consensus**: how pressure relates to weight, what level of evidence backs it, which process window is currently in force, and whether a write should pass when state is unknown. AgentWorkShop makes that consensus a first-class object:

- **agent-readable and agent-writable** (through approvals), not buried in heads and documents;
- **compilable** into process-model priors, scene contracts and runtime guards — it participates in the work;
- **lifecycle-gated**: candidate influence → observed correlation → validated control; a hard constraint must carry `validated_control` evidence before it can enter the control plane;
- **reversible**: versions are immutable, four-part diffs are queryable, references can be pinned.

## Data model

| Dimension | Values |
|---|---|
| Entity kinds (10) | `process_variable` · `quality_variable` · `equipment` · `material` · `product` · `recipe` · `batch_run` · `defect_mode` · `sensor` · `actuator` |
| Relation kinds (8, closed set) | `influences` · `measures` · `actuates` · `hasPart` · `precedes` · `observedBy` · `constrainedBy` · `basedOn` |
| Evidence levels (3) | `candidate_influence` (expert hypothesis) → `observed_correlation` (data) → `validated_control` (controlled experiment / optimizer run) |
| Lifecycle (5 states) | `proposed → reviewed → validated → approved_for_control → deprecated` |

Rule kinds: `bound` (range / process window) · `rate` (rate of change) · `state_condition` (fail-closed when state is unknown) · `interlock` (compiled into a PLC-layer decision) · `nonlinear` (rejected at compile time when the current solver cannot support it).

## Create & publish

```bash
# 1) open a draft
curl -X POST $BASE/api/workshop/ontology \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"ontologyId":"ont-line01","lineId":"ln-xxx","name":"Line 1 ontology"}'

# 2) save the whole document (optimistic-lock rev; live schema/dimension/binding validation)
curl -X PATCH $BASE/api/workshop/ontology/drafts/$DRAFT \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"doc":{...},"expectedRev":1}'

# 3) walk the lifecycle (hard rules need an approval ledger entry + a second person)
curl -X POST $BASE/api/workshop/ontology/drafts/$DRAFT/rules/R-BOUND/transition \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"to":"reviewed"}'

# 4) publish (admin; immutable version)
curl -X POST $BASE/api/workshop/ontology/drafts/$DRAFT/publish \
  -H "authorization: Bearer $TOKEN"
```

The `/ontology` console has six tabs — **overview · graph · rules · bindings · versions · compile preview**. The versions tab provides a four-part diff (`entities / relations / rules / bindings`); the compile preview shows the four artifacts and the per-rule Rule Trace.

## Compiled artifacts & invariants

| Artifact | Purpose |
|---|---|
| `ProcessModelDelta` | training feature candidates, τ = D/v delay priors, monotonicity (consumed by dataset/training planning) |
| `ProblemIrDelta` | reviewable form of solver-domain deltas (currently **compiled, not yet consumed** as solve constraints) |
| `SceneContractPatch` | twin scene / guard patch |
| `ControlGuardSet` | dispatch-time **node-intent guards** (`block_recommendation` / `annotate`) |

Invariants (violation fails compile/publish):

1. **Tighten-only** — rules narrow existing bounds, never widen them;
2. **Control-level evidence** — `bound / rate / nonlinear` hard constraints require `validated_control` evidence;
3. **PLC-layer separation** — interlocks compile to `PLC_LAYER_REQUIRED` decisions, never to executable software guards;
4. **Hash-domain separation** — `ontologyRefs` are part of the profile content hash and **never** of the solver `ProblemIR` hash; ontology drift is `409 ONTOLOGY_PACK_DRIFTED`, not a fake IR change;
5. **Fail-closed** — unknown state during guard evaluation blocks with reason code `state_unknown`.

## Descriptions & auto-fix

All three model kinds carry human-readable descriptions that agents can write and humans can see:

| Model | Fields | Agent entry | Human entry |
|---|---|---|---|
| Ontology | document `description` + entity/rule descriptions | `ontology_draft_update` / autofix backfill | `/ontology` header & detail; PATCH draft |
| AML model | `label` + `description` | `aml_model_annotate` | `/aml` registry (description line); PATCH metadata |
| Solver profile | `name` + `description` | `optimizer_profile_propose` (`profile_name/profile_description`) | `/optimizer` form & version list |

**Auto-fix** (`POST /ontology/drafts/:id/autofix`, tool `ontology_draft_autofix`, page button) performs only
safe, deterministic, idempotent normalization:

- fills document/entity/rule descriptions; dimension follows unit (compound units such as `mm/s` are left undeclared);
- backfills rule/binding scope to the document line; fills binding units; normalizes an invalid `scale`;
- removes dangling relations/bindings; de-duplicates ids or renames to `-dupN`;
- downgrades hard rules stuck at `approved_for_control` when their evidence is insufficient.

**Partial fixes persist** (optimistic lock + audit) while residual errors are returned honestly;
`validated_control` evidence is never fabricated.

## The four places that actually execute

1. **Dispatch guards** — `dispatch.service` calls `evaluateOntologyGuardsForNodes` before opening a card; a hit returns `409 ONTOLOGY_GUARD_BLOCKED`;
2. **Training priors** — `deriveTrainingPriors(lineId)` feeds feature/delay selection for datasets and training plans;
3. **Twin patch** — scene compilation consumes `SceneContractPatch` and the guard set;
4. **Lineage check** — the profile's `ontologyRefs` pin the published version hash and `assertOntologyUnchanged` re-verifies it at dispatch.

Everything else is **reviewable metadata** — deliberately non-executing.

## Agent tools (nine)

| Tool | Purpose | Class |
|---|---|---|
| `ontology_scene_inspect` | read the active scene subgraph (entities / rules / guards / bindings) | read |
| `ontology_rule_explain` | explain one rule (DSL, evidence, decision) | read |
| `ontology_version_compare` | four-part version diff | read |
| `ontology_draft_create` | open a draft (on lines inside the agent's bound face) | write |
| `ontology_draft_update` | replace the document (optimistic lock) | write |
| `ontology_draft_validate` | live validation (schema / dimensions / bindings) | write |
| `ontology_compile_preview` | compile preview + Rule Trace (no publish) | write |
| `ontology_draft_autofix` | **auto-fix** safely repairable issues and persist (never fabricates evidence) | write |
| `ontology_publish_propose` | propose publishing (HITL card; an admin publishes) | write |

The external MCP server mirrors three read-only tools (`scene_inspect / rule_explain / version_compare`).

## The adoption loop — what evolves is the model, not just parameters

The parameter loop (solve → recommend → dispatch) optimizes **within a fixed model**. The ontology and the adoption loop address how the **model itself** grows:

```
dataset build (lineage verified + eligibility gates)
        ↓
AML training (linear_arx / state space / hybrid_residual)
        ↓  model registry (artifactKind + artifactHash)
optimizer_profile_propose (agent tool: copy published config + swap artifact + draft v(n+1) + HITL card)
        ↓
HITL approval (single throat) → publish v(n+1) (frozen hash) + rebind every binding on the base version (revision+1)
        ↓
the next optimizer_solve runs the new model (in-flight solves converge through BINDING_STALE)
```

Governance invariants:

- a proposal is a draft + a card — **it does not change runtime behaviour by itself**;
- publishing only happens after human approval (dispatcher and decide entry points share one route);
- compatibility (artifact kind × solver family) is checked at proposal time — 422 on mismatch;
- an agent can only propose profiles inside its own binding face;
- reject / timeout = **zero writes**; every round leaves `adopt_propose(agent)` + `adopt(user)` audit rows;
- old versions remain for rollback.

The twin side is agent-created too: `twin_scene_discover → twin_scene_compile → twin_scene_freeze` (human approval) `→ twin_physics_spec_draft / validate / compile → twin_snapshot_create` (server-sampled) `→ twin_trial_run` (recommendation-only).

## Manager surfaces

| Page | What you see |
|---|---|
| `/ontology` | all six tabs: graph, rules (+ lifecycle actions), bindings, versions (+ diff), compile preview |
| `/optimizer` | every profile version with its model artifact, bindings and rebinds, solve runs and recommendations |
| `/aml` | model ledger (stage / metrics / artifactHash), training jobs, promotion |
| `/analysis` | analysis ledger (ontology × diagnosis conclusions are retrievable) |

## Verification

| Suite | Result |
|---|---|
| Unit tests (10 ontology files + 7 adoption cases) | 531/531 |
| Service-level ontology e2e | 44/44 |
| Ontology live e2e (PLC scenario + REST + runtime guards + AML + solver + UI) | 72/72 |
| Model-loop live e2e (twin creation chain + two adoption rounds + zero device writes) | 46/46 |
| MCP tool surface | 14/14 |

Reports: `docs/audit/2026-10-24-ontology-acceptance.md`, `docs/audit/2026-10-24-ontology-live-report.md`, `docs/audit/2026-10-24-model-loop-acceptance.md`.

## Boundaries (explicit)

- `ProblemIrDelta` is compiled but not yet consumed as solve constraints;
- the outcome write-back loop (execution result → recommendation ledger) and per-turn ontology prompt injection remain next-round items;
- RDF / OWL / SHACL export is not shipped;
- solver-family extension stays inside the existing template matrix (`linear_mpc_quadratic@1`, …); unsupported forms are rejected at compile time.
