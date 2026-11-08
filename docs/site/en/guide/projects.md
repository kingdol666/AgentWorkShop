# Project mode: from blueprint to delivery

> A Channel answers "how does the team collaborate"; a Project answers "when is this batch of work delivered".
> Project mode binds a plan, work items, technical review, owner acceptance and deliverables into one auditable
> contract.

## When to use a Project

- the work needs **multiple channels / teams** collaborating in dependency order;
- completion is not "the chat ended" but **deliverables passing L1 technical review + L2 owner acceptance**;
- you need to reconcile after interruption, restart or rework, with a traceable event and decision ledger.

If one Channel can finish it, do not promote it to a Project.

## Object model

| Object | Meaning |
|---|---|
| **Project** | Delivery contract; `ProjectService` is the only writer of lifecycle state |
| **Office channel** | A private channel created with the project, hosting the `project_leader` (`agent_kind='project_leader'`) |
| **Member channel** | A normal channel bound to the project with a charter; work executes here |
| **WorkItem** | One unit of work tied to a deliverable and a member channel; supports `dependsOn`, acceptance criteria and budget |
| **Attempt** | One execution of a work item; `attemptNo` increments and history is retained |
| **Deliverable** | The denominator of completion; required deliverables must pass acceptance |
| **Result** | summary / method / evidence / payload; can be reviewed and superseded |
| **Approval** | `plan_approval` · `deliverable_acceptance` · `project_complete` |
| **Event / Decision** | Project event ledger and decision records for reconciliation and audit |

## Create and activate

```bash
# 1) Create a project (leaderHarness is required; pass mock explicitly for demos)
curl -X POST http://localhost:3001/api/workshop/projects \
  -H "authorization: Bearer <token>" -H "content-type: application/json" \
  -d '{
    "name": "CAL-3 four-stage rerun",
    "objective": "read-only attribution → HITL control → dataset → bounded optimisation",
    "mode": "supervised",
    "leaderHarness": "mock",
    "routingPolicy": "technical"
  }'

# 2) Bind a member channel (owner only)
curl -X POST http://localhost:3001/api/workshop/projects/<projectId>/channels \
  -H "authorization: Bearer <token>" -H "content-type: application/json" \
  -d '{"channelId":"<channelId>","charter":"read-only attribution"}'

# 3) Activate (needs ≥1 member channel + ≥1 required deliverable + an approved plan)
curl -X POST http://localhost:3001/api/workshop/projects/<projectId>/activate \
  -H "authorization: Bearer <token>"
```

**Activation prerequisites**:

1. office channel + Project Leader assembled;
2. at least one member channel bound, and the channel has a lead;
3. at least one required deliverable (or an explicit owner waiver);
4. at least one approved plan version (`observe` may use a draft plan, but nothing is dispatched).

`leaderHarness` has **no default**: a user must not silently get a mock as a production Leader. Pass `mock`
explicitly for demos and acceptance.

## Blueprint instantiation

```bash
curl -X POST http://localhost:3001/api/workshop/projects/instantiate \
  -H "authorization: Bearer <token>" -H "content-type: application/json" \
  -d '{
    "template": "line-optimisation",
    "nameOverride": "CAL-3 rerun"
  }'
```

A `blueprint` document can be passed directly; core fields:

```jsonc
{
  "name": "…",
  "objective": "…",
  "routingPolicy": "technical",          // legacy | technical
  "planApprovalRequired": true,
  "autoDispatch": true,
  "mode": "supervised",                  // observe | supervised | auto
  "leaderHarness": "omp",
  "leaderProvider": "…",
  "leaderModel": "…",
  "channels": [
    { "key": "analysis", "name": "Analysis", "charter": "read-only attribution", "leadHarness": "omp" }
  ],
  "plan": {
    "deliverables": [ { "key": "report", "name": "Attribution report", "required": true } ],
    "work_items": [ { "key": "w1", "deliverableKey": "report", "channelKey": "analysis" } ]
  }
}
```

With `planApprovalRequired=false` a blueprint activates directly; otherwise it returns
`pending_plan_approval` and a `planApprovalId`; the owner approves it in the project page and the project becomes `active`.

## Work item state machine

```text
DRAFT ─▶ DISPATCHING ─▶ DISPATCHED ─▶ RUNNING ─▶ COMPLETED
                    │             │           │
                    ▼             ▼           ├─▶ REWORK ─▶ DISPATCHING
                  BLOCKED       BLOCKED       ├─▶ FAILED ─▶ DISPATCHING
                                              ├─▶ CANCELED
                                              └─▶ SUPERSEDED
```

- **State is a projection**: `reconcileWorkItem()` derives it from the attempt table and the root task; the stored
  `state` is a cache, reconciled on restart, tick and task-state changes;
- when `dependsOn` is not fully completed (or explicitly waived), downstream items stay `BLOCKED`;
- with `routingPolicy=technical`, upstream results must pass technical review before downstream dispatch; `legacy`
  is the compatibility mode;
- an item can rework multiple times; `attemptNo` increments and closed attempts no longer participate in projection.

## Deliverables, L1 and L2

```text
planned ─▶ active ─▶ submitted ─▶ approved / rejected / waived
```

1. **Automatic draft**: when the project root task completes, the platform generates a draft result from task
   artifacts/history;
2. **Channel lead submits**: `project_submit_result` adds summary / method / evidence;
3. **L1 technical review**: `project_review_result` writes a review proposal; the executor applies `reviewed` or
   `rejected` with a reason;
4. **L2 owner acceptance**: `project_approvals(kind='deliverable_acceptance')` → `approved` / `rejected`;
5. **Supersede**: a new result points `supersedes_id` at the old version, which becomes `superseded`.

Evidence must be a real reference: `task_id` / `artifact` / `analysis_report_id` / URL. The server validates that
the task belongs to the project/channel and the artifact exists on that task; **fabricated evidence strings are rejected**.

## Three project modes

| Mode | Plan | Dispatch | Review | Completion | Use |
|---|---|---|---|---|---|
| `observe` | Leader proposes, recorded only | No execution (shadow) | Records suggestions only | No execution | First rollout / shadow evaluation |
| `supervised` (default) | Leader proposes; owner approves or edits | Auto-dispatch after approval; destructive actions need approval | Leader review + owner acceptance | Owner approval | Normal |
| `auto` | Leader proposes autonomously; replan still needs approval | Auto-dispatch / nudge | Leader review + owner acceptance for required deliverables | Owner approval | Mature projects |

Project mode and Channel `execution_mode` are **independent**: the former governs project actions, the latter governs
industrial writes. A Project Leader can never raise a Channel's write authority.

## Lifecycle actions

| Action | API | Semantics |
|---|---|---|
| Pause | `POST /projects/:id/pause` | Stops the scheduler loop; in-flight channel tasks keep running; no new dispatch |
| Resume | `POST /projects/:id/resume` | Rebuilds the loop; full reconcile; dispatch resumes |
| Continue | `POST /projects/:id/continue` | A completed project receives a follow-up → reopens → Leader reads state → plan vN+1 |
| Reconcile | `POST /projects/:id/reconcile` | Re-project state from attempts / root tasks |
| Complete | `POST /projects/:id/complete` | After gates pass, creates a `project_complete` approval |
| Archive | `POST /projects/:id/archive` | Read-only; binding history retained; hidden from the default list |

## Project page

The project page is organised around delivery, not chat:

- **Overview**: Leader chat, snapshot (ready/running/waiting/blocked, work-item completion, deliverable sign-off),
  channel bindings, weekly report;
- **Plan & work**: plan versions, work-item dependencies, dispatch state;
- **Deliverables**: deliverables / results / evidence / supersession;
- **Approvals**: plan, deliverable acceptance, project completion;
- **Decisions & events**: decision records and the event ledger for reconciliation.

See [Harness console & Project detail](/en/guide/harness-ui) for the UI details.

## Live scenario: CAL-3 four-stage progression

One Project dependency chain, released stage by stage (real line, not a mock device):

1. **W1 data analysis (read-only, zero writes)**: `daq_query` pulls furnace temperature / dosing / performance
   data; conclusions land in the ledger; L1+L2 pass;
2. **W2 HITL control dispatch**: `write_intent` → independent admin approval → `recipe_trial` HITL card → approval →
   device readback converges (228.32 °C, clamped by the step limit);
3. **W3 training dataset**: `aml_dataset_build` + quality report; zero-write proof that the device value remains the
   governed value and is not rolled back by `line.start`;
4. **W4 bounded autonomous optimisation**: `aml_optimization` exploration, bounded excitation +6 (within the step
   limit and the bound), **no new approvals**, intervention ledger available.

Result: **78/78**; the 300s inter-adjustment gate and 60s online-write gate really fired. Full report:
[`docs/audit/evidence/2026-11-08-industrial-acceptance/REPORT.md`](https://github.com/kingdol666/AgentWorkShop/blob/main/docs/audit/evidence/2026-11-08-industrial-acceptance/REPORT.md).

## API quick reference

| Method | Path | Purpose |
|---|---|---|
| `GET/POST` | `/api/workshop/projects` | List / create |
| `POST` | `/api/workshop/projects/instantiate` | Instantiate a blueprint or template |
| `POST` | `/api/workshop/projects/:id/activate` | Activate |
| `POST` | `/api/workshop/projects/:id/pause` · `resume` · `complete` · `archive` | Lifecycle |
| `POST` | `/api/workshop/projects/:id/continue` | Continue development |
| `GET/POST` | `/api/workshop/projects/:id/channels` | Member channel bindings |
| `GET/POST` | `/api/workshop/projects/:id/work-items` | Work items |
| `GET/POST` | `/api/workshop/projects/:id/deliverables` | Deliverables |
| `POST` | `/api/workshop/projects/:id/results/:rid/review` | L1 result review |
| `GET` | `/api/workshop/projects/:id/approvals` | Approval list |
| `POST` | `/api/workshop/projects/:id/approvals/:aid/decide` | Approve / reject |
| `GET` | `/api/workshop/projects/:id/sessions` | Project / task session catalogue (briefs only) |
| `GET` | `/api/workshop/projects/:id/observability` | Observability (work items, deliverables, budget) |

## Boundaries and known limits

Project mode can carry real delivery, but these boundaries matter:

- **A completed project still holds its channel bindings**: rerunning the same channels returns
  `CHANNEL_ALREADY_BOUND`; today you must unbind explicitly (`DELETE /projects/:id/channels/:cid`). Automatic
  release is a P0 item;
- **No durable workflow engine**: dispatch, submission and acceptance are stitched from events and reconciliation;
  cross-step failure relies on retries and manual reconciliation;
- **Rate gates reject after the fact**: the 300s / 60s gates reject plans; the scheduler does not yet reserve windows;
- **Mock leaders are possible**: `leaderHarness` is explicit, but demos/acceptance may still use mock; real projects
  should use a real engine;
- **L1/L2 independence**: today it is "technical review + owner acceptance"; multi-reviewer debate is not included.

> Related: [Channel sessions & agent lifecycle](/en/guide/channels-sessions) · [Harness console](/en/guide/harness-ui) · [HITL approvals](/en/guide/hitl) · [Line permissions](/en/guide/line-permissions)
