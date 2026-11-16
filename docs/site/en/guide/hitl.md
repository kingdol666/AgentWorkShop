# HITL approvals

HITL (Human-in-the-Loop) suspends agent control actions that require a human decision before
execution — the platform guarantees “agents propose, a human approves when policy requires it,
the system executes, and every step is audited.” Approval depends on action type and effective
policy; not every dispatch is unconditionally routed through HITL.

## How it works

1. The write-binding `mode` participates in the decision together with Channel execution mode and the line master switch:
   - `auto` — this binding adds no approval requirement (range/window interlocks and other policy gates remain);
   - `manual` — this binding requires human approval (the approver's comment can flow back to the Agent).
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

### Action exceptions and policy gates

- `recipe_propose` always creates a human approval card; rejection leaves the device unchanged and records the candidate and decision.
- `line_start` / `line_stop` always require HITL, even when the relevant write modes are `auto`.
- Whether `recipe_trial` / `recipe_apply` require HITL depends on Channel/line/binding modes and the optional global `security.recipeDispatchApproval`; the global setting adds a gate only for trial/apply.
- `recipe_update` (definition-only) is outside the global recipe-dispatch approval gate; other applicable governance policies still apply.

### Recipe-dispatch gate (batch actions)

Beyond per-node `dcw_control`, `recipe_trial` / `recipe_apply` batch dispatch can also be gated by the runtime setting `security.recipeDispatchApproval`, which is off by default. When enabled it applies to these actions across Channels and does not replace Channel/line/binding mode gates.

When this global gate is enabled, the approval card lists each parameter's "node current → candidate" value and the hypothesis. Approval dispatches the batch and returns the comment to the Agent; rejection/timeout does not dispatch, and rejection guidance is returned verbatim. Decisions are recorded as `approval.approve` / `approval.reject`, and dispatch as `recipe.trial` / `recipe.apply`. `recipe_rollback` is outside this global gate but remains subject to other applicable governance policies.

> The decide REST surface is the same as above, but `approved` must be an **explicit boolean** (a missing field no longer means approve).

## Relation to the control loop

HITL gates only the "dispatch" step. After a successful write the dispatch enters the
control loop (optimization record → sample observation → `dcw_judge` verdict →
`dcw_rollback`), where judging and rollback can also require human confirmation.
