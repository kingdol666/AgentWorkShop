# Line integration: from blueprint to governed work

> This page describes the line-integration path and historical isolated-simulator results, not physical HIL or production approval. Current unmerged source remains under review; historical results do not verify it. See the onboarding restrictions below.

## Scope

Line integration connects the following auditable chain:

```text
work-condition document → human-reviewed blueprint → PLC simulator twin → exported driverConfig
                      → line/DAQ/DCW/product/recipe → integrated Channel
                      → line_context / DAQ / memory → recipe_propose + HITL
                      → device readback / DAQ response / journal
```

- Document-to-blueprint remains an assistant- or engineer-reviewed extraction and clarification step. The platform does not turn an arbitrary PDF, P&ID or scan into a production-ready configuration automatically.
- The simulator source is bundled at `plc-node-simulator/`; root `pnpm install` installs its workspace dependencies (including `tsx`), so no separate clone is needed. It is licensed under PolyForm Noncommercial 1.0.0, separately from the platform's Apache-2.0.
- Use `aw-plc-sim-twin` for virtual commissioning, then use `aw-line-onboarding` for platform provisioning.
- A simulated protocol stack proves driver, configuration, governance and data-pipeline behavior. It does not prove PLC electrical safety, emergency-stop behavior, register units, or physical process fidelity.
- Historical source-snapshot evidence is [`docs/audit/2026-11-16-line-integration-skill-demo-acceptance.md`](https://github.com/kingdol666/AgentWorkShop/blob/main/docs/audit/2026-11-16-line-integration-skill-demo-acceptance.md) (simulator acceptance, not physical HIL).

## Channel modes and Sessions

### Channel modes

- `generic` is a collaboration channel. It can chat and use explicitly granted general tools, but a `lineId` alone does not grant industrial context or experience scope.
- `production_line_integrated` is a line-work channel. It requires an explicit line binding before `line_context`, line-scoped DAQ reads, industrial memory/experience scopes and governed write paths are available.
- Node bindings, recipe bindings, line grants, control policy and server-side tool gates still define write authority. Channel mode never elevates an existing grant.

### Product-bound Sessions

Create an integrated Session with an explicit product:

```http
POST /api/workshop/channels/<channelId>/sessions
Content-Type: application/json

{"productId":"pd-...","title":"Batch analysis A","memoryPolicy":"session"}
```

The server freezes and verifies the line/product/recipe/node/agent binding snapshot plus its revision/hash. A mutable Channel selector cannot move that Session to another line, product or recipe. A `generic` Session does not gain industrial authority just because a `productId` is supplied.

## Legacy execution recovery hold

> The following behavior ships with v0.13.0 but was not verified line by line by historical acceptance; production use still requires on-site interlock and HITL review.

During upgrade recovery, legacy active tasks without an execution lease are marked `[LEGACY_EXECUTION_RECOVERY_REQUIRED]` while their state and evidence are preserved. Matching pending or consuming task messages are marked dead, not automatically replayed. On `409 LEGACY_EXECUTION_RECOVERY_REQUIRED`, treat the affected task tree as held; do not retry execution or clear the restriction by merely removing the marker or editing the database.

Preserve task, message, approval and write-log evidence. Have qualified site personnel inspect the actual device state, readback and process impact, and escalate to the teams responsible for operations and safety disposition. There is currently no supported, audited hold-release or disposition procedure. An upgrade affected by this condition is not production-ready until such a procedure is implemented and verified. Task state and historical records alone do not establish the actual device state.

## Data and tool order

Read context before acting, then choose the tool for the data shape:

1. `line_context`: line state, active batch, product, recipe targets, PLC readback, windows and visible nodes.
2. `search_memory`: current-session, Channel-shared and trusted experience clues; use `search_other_teams_memory` for cross-Channel reuse.
3. `daq_query`: scalar history/realtime samples with statistics, units, semantics and lag.
4. `daq_frames`: vector/image frames; do not treat a frame node as scalar `daq_query` data.
5. `recipe_propose`: submit a structured recipe candidate; this tool always creates a human approval card. Do not bypass it with direct writes.
6. HITL: an eligible human must approve/reject `recipe_propose`; for other writes, approval depends on effective line, Channel and binding modes plus any applicable global recipe-dispatch setting. `line_start` / `line_stop` always require HITL.
7. Readback and recheck: compare device readback, write journal and post-write DAQ response before continuing.

Out-of-range values, scope mismatches, missing grants or missing readback should result in rejection or `inconclusive`, not in treating transport acceptance as device success.

## Memory and experience reuse

| Scope | Purpose | Visibility |
|---|---|---|
| `session` | Context and task history for the current Session | Current Session |
| `private` | Agent-owned personal memory | Current Agent / authorized Channel surface |
| `shared` | Channel team memory and task chronicle | Current Channel |
| `line` | Line-scoped experience | Same-owner integrated Channels; active/validated only |
| `product` | Product-scoped experience | Requires a trusted product-bound Session; not positively covered by the current simulation run |
| `global` | Governed global experience | Exposed only by server policy |

- Automatic memory injection is a bounded clue layer; long evidence can be truncated by `memory.inject_total`. Use `search_memory` for complete numeric detail.
- `candidate` experience is not exposed as validated cross-Channel knowledge; promotion requires independent task evidence and governance.
- “Read-only” means no device mutation by default. If memory persistence must also be forbidden, explicitly prohibit `save_memory`.
- Experience is reusable research evidence, not physical truth; current readback and current DAQ evidence have final authority.

## Vector-frame contract

The simulator and platform template may use different point counts: the endpoint returns raw points, while a platform sink can resample them before storage. In the current example the simulator returns 48 raw points and the `thickness-scan` template normalizes them to 64 points.

The handoff record must state:

- raw point count and source endpoint;
- normalized point count and template/sink configuration;
- axis, point labels, interpolation and unit;
- the actual frame length returned to the Agent.

If points must align one-to-one with a real device, set the template and `driverConfig.resamplePoints` to an explicit contract value and assert frame length during acceptance. Do not infer it from an old semantic label.

## Simulation and cutover

**Current unmerged source restriction (under review)**: `onboard.mjs` and `provision-line.mjs` unconditionally refuse provisioning; `verify-line.mjs` rejects V2/V3 for nonempty DCW targets pending trusted attestation that the driver implementation and endpoint belong to this isolated simulator. A `simulated=true` label, driver name or loopback address is not ownership proof. Verification's `GET /api/workshop/dcw` can start global automatic hold writes, so even `dcw: []` has no established guarantee of freedom from side effects. **Do not run any onboarding verification** until isolation and absence of unintended side effects are established; do not bypass the guards. Historical V1–V6 results are not a claim that they can currently be repeated.

An isolated simulation acceptance previously required `AW_MODE=home`, a fresh `AW_HOME`, independent platform and simulator ports, an independent simulator shadow, and a `simulated=true` test line. These conditions alone do not remove the above restrictions. V2/V3 include an out-of-range attempt and a valid write; `onboard.mjs --smoke` may auto-decide test HITL.

A real cutover is not “patch the endpoint and keep writing”:

```text
stop line → save governance/binding snapshot → replace driverConfig endpoint/register
          → start a new batch (or synchronize the recipe baseline) → read-only/minimal-step checks
          → separately authorized site verification and three-way readback → switch back and open another batch when required
```

Changing endpoints while the old batch is active can leave step and recipe baselines tied to the old device; refusing the next write is the correct protection. Physical rollout still needs an authorized maintenance window, read-only soak, device/platform/mirror comparison, emergency-stop and physical-safety acceptance.

## Evidence

Keep the simulator tick and per-device export, provision/forge/verify JSON and logs, tagged DAQ samples/frames, HITL decision, DCW readback, journal anchor, range rejection, Channel messages, memory searches and cross-Channel results. Separate `simulated`, `physical HIL` and `production` verdicts.

Only executed assertions may be called passing. External IDD/RAG timeouts, Mimosa `inconclusive`, product-scope gaps and seed-task cold-start delays must be listed separately.

## Related skills

- [`aw-plc-sim-twin`](https://github.com/kingdol666/AgentWorkShop/tree/main/skills/aw-plc-sim-twin): create five-protocol simulator twins and exports.
- [`aw-protocol-onboarding`](https://github.com/kingdol666/AgentWorkShop/tree/main/skills/aw-protocol-onboarding): protocol/data-shape matching and mirror ingestion.
- [`aw-line-onboarding`](https://github.com/kingdol666/AgentWorkShop/tree/main/skills/aw-line-onboarding): provisioning, Channel forging and V1–V6; its steps are subject to the current restrictions above.
- [`aw-doc-to-project`](https://github.com/kingdol666/AgentWorkShop/tree/main/skills/aw-doc-to-project): human-reviewed blueprints, Channel grouping and Project acceptance.
- [`aw-system-acceptance`](https://github.com/kingdol666/AgentWorkShop/tree/main/skills/aw-system-acceptance): full gates and boundary decisions.
