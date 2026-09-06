# Your first "agent × line" session (~2 minutes)

1. **Sign in** — open `http://localhost:3001`, register/sign in from the sidebar
   (seeded admin: `zhangwei@awshop.io` / `Awshop@123`; change it on first login).
2. **Build a line** — "Line Operations" → new line → add a **DCW node** (template `temp-sp`)
   and a **DAQ node** (template `temp-tc`) → create a **product** (on the line) → create a
   **recipe** (parameter bound to the DCW node, e.g. target 120) → press **Start**.
   Live values start flowing; every sample is tagged `line/product/recipe/run`.
3. **Build a team** — "Agent Workspace" → create an agent → create a team → add the agent.
4. **Bind nodes** — open the agent's detail panel → bind the DAQ node (*auto* = execute
   automatically) and the DCW node (*manual* = every write needs your approval).
5. **Submit a goal** — "Analyze the last 5 minutes of temperature; if it deviates from
   182°C by more than 1°C, correct the setpoint (awaiting my approval)."
6. **Approve** — the agent reads real history, computes a mean, raises a write request →
   approve in the HITL panel → the setpoint changes, readback verifies, the goal closes
   with a numeric report.

## What actually happened

```
goal ──▶ lead decomposes ──▶ worker reads real TSDB history (semantic cards: meaning/unit/range/recipe window)
     ──▶ computes a proposed setpoint ──▶ dcw_control tool ──▶ interlock (safe range ∩ recipe window)
     ──▶ HITL approval (180s default-timeout rejection) ──▶ PLC write ──▶ readback verification
     ──▶ ACK + signed write history ──▶ goal satisfaction passes
```

## Verify from the CLI

```bash
aw config get server.prod.port          # where the port comes from
aw status                               # runtime overview
curl -X POST http://localhost:3001/api/plugins/line-sentinel/threshold \
  -H 'content-type: application/json' -d '{"threshold":100}'   # plugin API (if the example is installed)
```
