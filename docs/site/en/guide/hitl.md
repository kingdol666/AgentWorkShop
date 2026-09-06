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
> (timeout `harness.hitl_timeout_ms`, default 5 minutes, then auto-reject) — by design.

## Relation to the control loop

HITL gates only the "dispatch" step. After a successful write the dispatch enters the
control loop (optimization record → sample observation → `dcw_judge` verdict →
`dcw_rollback`), where judging and rollback can also require human confirmation.
