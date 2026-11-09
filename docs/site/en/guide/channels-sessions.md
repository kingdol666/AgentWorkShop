# Channel sessions & agent lifecycle

> A Channel is a team; a **Session** is a separate workshop floor.
> Multi-session lets the same base members (lead + workers) work in parallel without sharing a mailbox,
> execution lock or memory domain.

## The three-layer object model

| Layer | Role | Key fact |
|---|---|---|
| **Channel** | Collaboration unit | Members, tools, node bindings, task machine, HITL and schedules are scoped to the channel |
| **Session** | Isolated execution environment | Clones the base members into an independent agent group; serial within a session, parallel across sessions |
| **Agent** | Clonable object | Unique `agentId`; create / activate / disable / delete; memory is scoped by agentId |

A Session does not replace a Channel: the channel remains the source of team identity and authority; a session is
only an execution surface.

## Creating a session

```bash
# The channel must already have enabled lead/worker base members
curl -X POST http://localhost:3001/api/workshop/channels/<channelId>/sessions \
  -H "authorization: Bearer <token>" -H "content-type: application/json" \
  -d '{"title":"Batch attribution A"}'
```

Response:

```json
{
  "sessionId": "…",
  "title": "Batch attribution A",
  "members": [
    { "baseAgentId": "…", "cloneId": "…", "name": "AnalystLead·session·1", "role": "worker" }
  ]
}
```

Clone rules (`server/services/workshop/agents/session-clone.ts`):

- base members = enabled `lead` / `worker`, **excluding** `project_leader` and existing session clones;
- each clone gets its own `AgentRuntime`, mailbox, exec lock and engine process;
- clones are positioned as `worker` (the base lead keeps its channel coordinator identity);
- the base member's node bindings (DAQ read / DCW write / recipe / line-recipe) are copied to the clone;
  write authority is still bounded by the original grants;
- clone names carry a `·session·` marker for identification and duplicate protection.

## Isolation boundaries

| Resource | Within a session | Across sessions |
|---|---|---|
| Mailbox / execution lock | Per clone | Not shared |
| Engine process (omp / dsh / …) | Per clone | Not shared |
| Memory domain | Scoped by clone agentId | Isolated |
| Team memory (`__team__`) | Channel-scoped | Shared |
| Node bindings | Copied from base members | Independent |
| Tasks | Serial within the session | Parallel |

## Session lifecycle

```text
POST   /api/workshop/channels/:id/sessions          create (clone members)
GET    /api/workshop/channels/:id/sessions          list
GET    /api/workshop/channels/:id/sessions/:sid     detail
GET    /api/workshop/channels/:id/sessions/:sid/brief     brief
GET    /api/workshop/channels/:id/sessions/:sid/history   history
POST   /api/workshop/channels/:id/sessions/:sid/messages  send a message
POST   /api/workshop/channels/:id/sessions/:sid/close     close (idempotent)
```

**Close semantics**:

1. cancel the session's in-flight task tree;
2. `stopAgentRuntime` force-detaches the clones (bypasses the idle/pending gate to avoid zombie runtimes);
3. clone rows get `enabled=0`; later invoke is refused;
4. the session is marked `closed`; repeated close is idempotent;
5. **session A and the base members are untouched** and keep working.

## Agent lifecycle and object isolation

- Every agent gets a unique `agentId` at creation; IDs never collide across channels;
- channel A's member list does not contain channel B's members; A deleting B's member returns a non-2xx;
- a group message without `@` triggers **zero agent executions** (no fallback to the default lead);
- disabling a member makes invoke fail; deleting a member removes it from the list;
- closing channel A leaves channel B members `enabled=1`.

These are server-side object boundaries, not UI hiding: cross-channel reads and deletes are rejected at the API.

## Relationship to Channel templates

```text
Channel template ── instantiate ──▶ Channel (scene + tool profile + members)
                                        │
                                        └── create session ──▶ session A / B / …
```

- `POST /api/workshop/channel-templates/:id/instantiate` instantiates a full team with `scene`, `toolProfile`,
  `controlPolicy`, `bindLineId`, etc.;
- the template produces the **base channel**; each multi-session clones from its base members;
- template / channel / session are independent objects: closing a session deletes neither the template nor the channel.

## Task instances: one work item, one execution environment

When a Project dispatches a work item, the kernel creates a **dedicated task-instance channel + session** (`bindingType=task_instance`):

```
Work item A ──▶ instance channel A (clone of base lead) ──▶ session A ──▶ root task A
Work item B ──▶ instance channel B (clone of base lead) ──▶ session B ──▶ root task B
```

- the two instances differ in `channelId / sessionId / taskId`, and their histories never see each other;
- after the root completes and reconcile runs, the instance channel is disabled and the session archived; the base channel and other tasks are untouched;
- omp proof: artifacts for A and B contain only their own token (`PROJECT-W1-OK` / `PROJECT-W2-OK`), with no cross-task contamination;
- a single work item ran end-to-end on a real LLM (omp / `ustc/deepseek-flash`): dispatch → task instance → 619 s delivery → reconcile → L1 → L2 → completed (13/13).

## Live acceptance

| Check | Result |
|---|---|
| Channel template multi-session (two parallel sessions, real LLM, HITL write, closing B leaves A working) | **20/20** |
| Multi-harness + object isolation (mock / omp / dsh / codex / opencode) | **24/24** |
| Two-session real-reply isolation (omp / `ustc/deepseek-flash`; A=`ALPHA-…`, B=`BETA-…`, zero leakage) | ✔ |
| Task-instance isolation (distinct channel / session / task, no artifact bleed) | ✔ |
| Evidence | [`channel-multisession.json`](https://github.com/kingdol666/AgentWorkShop/blob/main/docs/audit/evidence/2026-11-08-multisession-opt/channel-multisession.json) · [`harness-isolation.json`](https://github.com/kingdol666/AgentWorkShop/blob/main/docs/audit/evidence/2026-11-08-full-acceptance/harness-isolation.json) · [`2026-11-09-full-acceptance`](https://github.com/kingdol666/AgentWorkShop/blob/main/docs/audit/evidence/2026-11-09-full-acceptance/REPORT.md) |

> Related: [Harness console](/en/guide/harness-ui) · [Project mode](/en/guide/projects) · [Multi-harness agent teams](/en/guide/multi-harness)
