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
is always allowed), failures only set `lastReadError` (hover to see), and never touch the
write state machine or the PLC.

## SET / ACT side by side

- **DCW detail page**: a "PLC reading" column — value + last-read time + a Read button;
  failed reads show a dotted hint with the reason on hover.
- **Twin panel**: each device card gains an **ACT row** (green live reading) under the SET
  value, in the same control-room visual as DAQ channels.
