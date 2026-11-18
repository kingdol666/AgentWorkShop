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
| Agent observation | `line_context` / `my_industrial_nodes`, and `daq_query` where applicable | inspect authorized context and data |

Reading is passive: it is not blocked by gateway pause or line gating ("reading the gauge"
is always allowed), failures only set `lastReadError` (hover to see), and it never touches
the write state machine or writes anything to the PLC.

## SET / ACT side by side

- **DCW detail page**: a "PLC reading" column — value + last-read time + a Read button;
  failed reads show a dotted hint with the reason on hover.
- **Twin panel**: each device card gains an **ACT row** (green live reading) under the SET
  value, in the same control-room visual as DAQ channels.
- **Consistency verdict**: the value read back is decoded into engineering units through the
  transform symmetric to the write path; compare authorized device readback with site evidence.

The node wizard and the node editor expose "periodic read (ms)"; readings of the `mock`
driver come from the simulated PLC (retentive, with the same semantics as a real register).

## Agent read/write as one

```text
line_context / my_industrial_nodes    # inspect authorized line and node context
recipe_propose                       # submit a candidate for human approval
```

Agent calls to `dcw_control` are disabled and rejected; `dcw_read` is not an available agent tool. Use an authorized recipe path for changes and compare device readback, journal and DAQ response. Internal governed exploration writes are not an agent direct-write entry point.

## Write cadence and failure semantics

Online point writes (`source=agent/manual`) enforce a 60-second minimum interval and a
write-hold window, but **only successful dispatches count**:

- Every attempt records `lastAttemptAt` (including failures); `lastWriteAt` / `lastAckAt`
  advance only when the device confirms or accepts the write.
- **A failed write does not consume the 60-second window** — retry immediately after a link
  recovers; a 5-second cooldown only prevents back-to-back hammering.
- The node view exposes both timestamps; UI/WS events update them by `ok`; legacy snapshots
  are migrated automatically.
- Recipe trial / apply / rollback use their own path (not the 60s/step gate); their bound is
  the recipe window (see [Recipe versions](recipe-versions.md)).

## Automatic Hold Interlock

> The following behavior ships with v0.13.0, but historical acceptance does not prove it in isolation; physical writes still require the on-site interlock and HITL review.

Before each driver write, the node synchronously persists `holdBlocked=true`; if persistence fails, dispatch is refused. Failure, timeout, process interruption, or a transport-only ACK leaves automatic hold paused, including after restart, so the previous setpoint is not resent. The node card displays “Automatic hold paused”. This does not mean the physical device has stopped; inspect its actual state.

Automatic hold resumes only after a subsequent authorized governed write returns a finite `readback-verified` device value within the normal tolerance. A verified result arriving after task revocation is evidence but does not clear the interlock. Ordinary reads, disabling or enabling the node, and transport ACKs cannot clear the interlock. MQTT/HTTP and other transport-only drivers, including recipe-level post-write verification, currently cannot clear it; there is no safe manual-clear interface. An authorized operator must investigate and establish a verified readback and recovery procedure; until then automatic hold remains paused. This changes previous hold behavior for write-only channels and must be validated against the device and process before deployment.

This is a per-node response to uncertain writes. A channel task recovery hold does not automatically stop a line or suspend hold on other nodes.

## Driver support

| Driver | Read | Write | Notes |
|---|---|---|---|
| Modbus TCP / RTU | ✅ | ✅ | read holding registers (same data type/byte order as the write), pooled and queued connections |
| OPC UA | ✅ | ✅ | read node values (session pool reuse) |
| mock | ✅ | ✅ | simulated retentive PLC, used by the acceptance chain |
| MQTT / HTTP | — | ✅ | publish-only channels; for reading, use a DAQ node on the same address |

### MQTT payload template (jsonTemplate)

When the device expects a **nested / multi-field** command in a single message, use `jsonTemplate`
instead of `jsonKey`:

```json
{
  "driver": "mqtt",
  "driverConfig": {
    "host": "127.0.0.1", "port": 1883, "topic": "factory/line1/cmd", "qos": 1,
    "jsonTemplate": "{\"cmd\":\"set\",\"params\":{\"temp\":{{value}},\"hold\":8}}",
    "readTopic": "factory/line1/state", "readJsonPath": "setpoint"
  }
}
```

- `{{value}}` is replaced by the **finite number** being written and may appear multiple times;
  static fields are preserved as-is.
- Payload precedence: `jsonTemplate` > `jsonKey` (`{"key":value}`) > bare number;
  **`jsonTemplate` and `jsonKey` are mutually exclusive**.
- Templates are validated at **create/PATCH time**: a missing placeholder, non-JSON rendering, or
  a template over 4 KB is rejected with 400 — a bad template never reaches the write path or the device.
- The rendered payload is `JSON.parse`d and normalized before publishing, so the device client can
  parse its own fields (e.g. `params.temp` / `hold`) exactly as configured.
- Readback still uses `readTopic` + `readJsonPath`; single manual writes report `transport-ack`
  (honest grading), while batch/recipe writes are promoted to `readback-verified` by `readNow`.

Real-link validation: `scripts/dev-modbus-simulator.mjs` (a slave on port 1502 where 40021+
holds write-retained setpoints) together with `scripts/_dbg-dcw-read-rest.mjs` and
`scripts/_dbg-agent-dcw-rw.ts` performs a write→read roundtrip against a **real Modbus TCP**
device with no mock involved.
