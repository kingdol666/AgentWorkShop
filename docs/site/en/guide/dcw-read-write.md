# Read-write DCW

Since v0.7 every DCW node is a **read + write process-parameter channel**: writing sends
an engineering setpoint through calibration to the PLC with an in-place readback (existing
capability); reading pulls the PLC's current value through the same calibration for
display — on the DCW console, the twin panel and the agent tool surface, setpoint (SET)
and actual reading (ACT) sit side by side.

```
SET (setpoint)                        ACT (actual)
user/recipe/agent ──write──▶ PLC register ──read──▶ DCW page · twin panel · agent
      calibrate/verify readback      decode/calibrate
```

## Three ways to read

| Method | Trigger | Use |
|---|---|---|
| Periodic | node `readIntervalMs` (default 5000ms; `0` = off) | normal operation: twin/DCW pages always show the PLC value |
| Manual | "Read" button on the DCW page, or `POST /api/workshop/dcw/:id/read` | commissioning, on-demand checks |
| Agent | `dcw_read(node_id)` | evidence before dispatch, verification after |

Reading is passive: it is not blocked by gateway pause or line gating ("reading the gauge"
is always allowed), failures only set `lastReadError` (hover to see), and it never touches
the write state machine or writes anything to the PLC.

## SET / ACT side by side

- **DCW detail page**: a "PLC reading" column — value + last-read time + a Read button;
  failed reads show a dotted hint with the reason on hover.
- **Twin panel**: each device card gains an **ACT row** (green live reading) under the SET
  value, in the same control-room visual as DAQ channels.
- **Consistency verdict**: the value read back is decoded into engineering units through the
  transform symmetric to the write path; the agent's `dcw_read` reports the verdict directly
  ("reading matches the setpoint / there is a deviation").

The node wizard and the node editor expose "periodic read (ms)"; readings of the `mock`
driver come from the simulated PLC (retentive, with the same semantics as a real register).

## Agent read/write as one

```text
dcw_read(node_id)              # read the PLC's current value (no approval, passive observation)
dcw_control(node_id, value)    # dispatch a setpoint (range ∩ recipe-window interlock; HITL in manual mode)
```

Recommended flow: understand the node with `my_industrial_nodes` → gather evidence with
`dcw_read` → dispatch in small steps with `dcw_control` → wait for the process response →
re-read with `dcw_read` to check whether ACT converged to SET. Every successful dispatch
still opens a control-loop optimization record, and `dcw_read` is one of the evidence tools
used to decide `keep / rollback`.

## Driver support

| Driver | Read | Write | Notes |
|---|---|---|---|
| Modbus TCP / RTU | ✅ | ✅ | read holding registers (same data type/byte order as the write), pooled and queued connections |
| OPC UA | ✅ | ✅ | read node values (session pool reuse) |
| mock | ✅ | ✅ | simulated retentive PLC, used by the acceptance chain |
| MQTT / HTTP | — | ✅ | publish-only channels; for reading, use a DAQ node on the same address |

Real-link validation: `scripts/dev-modbus-simulator.mjs` (a slave on port 1502 where 40021+
holds write-retained setpoints) together with `scripts/_dbg-dcw-read-rest.mjs` and
`scripts/_dbg-agent-dcw-rw.ts` performs a write→read roundtrip against a **real Modbus TCP**
device with no mock involved.
