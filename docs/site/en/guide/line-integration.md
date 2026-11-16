# Line integration: from blueprint to governed work

> This page describes the current mainline line-integration path. It can prove protocol-stack behavior, data acquisition, experience reuse and governed single-step writes in an isolated simulator; it is **not physical HIL or production approval**.

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
- The current-main evidence is [`docs/audit/2026-11-16-line-integration-skill-demo-acceptance.md`](https://github.com/kingdol666/AgentWorkShop/blob/main/docs/audit/2026-11-16-line-integration-skill-demo-acceptance.md) (simulator acceptance, not physical HIL).

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

An isolated simulation acceptance uses `AW_MODE=home`, a fresh `AW_HOME`, independent platform and simulator ports, an independent simulator shadow, and a `simulated=true` test line. V2/V3 include an out-of-range attempt and a valid write; `onboard.mjs --smoke` may auto-decide test HITL, so use it only on the isolated test line.

A real cutover is not “patch the endpoint and keep writing”:

```text
stop line → save governance/binding snapshot → replace driverConfig endpoint/register
          → start a new batch (or synchronize the recipe baseline) → read-only/minimal-step checks
          → V1/V3 and three-way readback → switch back and open another batch when required
```

Changing endpoints while the old batch is active can leave step and recipe baselines tied to the old device; refusing the next write is the correct protection. Physical rollout still needs an authorized maintenance window, read-only soak, device/platform/mirror comparison, emergency-stop and physical-safety acceptance.

## Evidence

Keep the simulator tick and per-device export, provision/forge/verify JSON and logs, tagged DAQ samples/frames, HITL decision, DCW readback, journal anchor, range rejection, Channel messages, memory searches and cross-Channel results. Separate `simulated`, `physical HIL` and `production` verdicts.

Only executed assertions may be called passing. External IDD/RAG timeouts, Mimosa `inconclusive`, product-scope gaps and seed-task cold-start delays must be listed separately.

## Related skills

- [`aw-plc-sim-twin`](https://github.com/kingdol666/AgentWorkShop/tree/main/skills/aw-plc-sim-twin): create five-protocol simulator twins and exports.
- [`aw-protocol-onboarding`](https://github.com/kingdol666/AgentWorkShop/tree/main/skills/aw-protocol-onboarding): protocol/data-shape matching and mirror ingestion.
- [`aw-line-onboarding`](https://github.com/kingdol666/AgentWorkShop/tree/main/skills/aw-line-onboarding): provisioning, Channel forging and V1–V6.
- [`aw-doc-to-project`](https://github.com/kingdol666/AgentWorkShop/tree/main/skills/aw-doc-to-project): human-reviewed blueprints, Channel grouping and Project acceptance.
- [`aw-system-acceptance`](https://github.com/kingdol666/AgentWorkShop/tree/main/skills/aw-system-acceptance): full gates and boundary decisions.
