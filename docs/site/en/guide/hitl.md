# HITL approvals

HITL (Human-in-the-Loop) puts a human decision in front of agent dispatches: the platform
guarantees "agents propose, humans approve, the system executes, everything is audited".

## How it works

1. The agent node binding `mode` decides behavior:
   - `auto` — tool calls execute automatically (still interlocked by range ∩ window);
   - `manual` — every dispatch pends for human approval (a comment is returned to the agent).
2. In `manual` mode the dispatch enters the pending queue; duplicate pending requests from
   the same agent for the same node are deduplicated.
3. An operator approves/rejects in the UI (or via REST), optionally with a comment.
4. Approve → the command executes for real (the binding is re-validated); reject/timeout →
   the agent receives the reason and the PLC value is untouched.
5. The decision-maker is written to the audit log (`approval.approve` / `approval.reject`).

## REST surface

```bash
# pending approvals
curl $API/api/workshop/agent-tools/approvals -H "Authorization: Bearer $TOKEN"

# decide
curl -X POST $API/api/workshop/agent-tools/approvals/$ID/decide \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"approved": true, "comment": "within window, approved"}'
```

> Note: in manual mode the agent-side `dcw_control` call **blocks until decided**
> (timeout `security.hitl_timeout_ms`, default 180000 ms = 3 minutes, then auto-reject) — by design.

## Recipe-dispatch gate (batch actions)

Beyond per-node `dcw_control`, the **batch dispatch actions** of the recipe chain sit behind
their own approval gate, controlled by the runtime setting `security.recipeDispatchApproval`
(off by default; when on it applies to every channel):

- Covered actions: `recipe_trial` (batch candidate trial dispatch) and `recipe_apply`
  (dispatch the solidified version). `recipe_update` (definition only, no dispatch) and
  `recipe_rollback` (converge back) are not gated;
- Suspension semantics: after submission the batch action **pends for a human decision**;
  the pending item lists every parameter as "node current → candidate" plus the hypothesis;
- Approve (with optional note) → the batch dispatches for real, and the note is returned
  to the agent with the tool receipt;
- Reject (with optional guidance) → the PLC is untouched and the recipe version unchanged;
  the guidance text flows back **verbatim** in the tool result, and the agent revises the
  candidates and resubmits — "bring the tuned recipe to a human; if not approved, change it
  as the human says";
- Timeout (`security.hitl_timeout_ms`, default 180 s) converges as a reject; nothing dispatches;
- Audit: decisions land in `approval.approve` / `approval.reject`; the dispatch itself in
  `recipe.trial` / `recipe.apply` (with recipe id and agent attribution).

> The decide REST surface is the same as above, but `approved` must be an **explicit
> boolean** (a missing field no longer means approve).

## Relation to the control loop

HITL gates only the "dispatch" step. After a successful write the dispatch enters the
control loop (optimization record → sample observation → `dcw_judge` verdict →
`dcw_rollback`), where judging and rollback can also require human confirmation.
