# Five-protocol DAQ & control

The acquisition (DAQ) and write-control (DCW) driver surface covers five field protocols.
Acquisition and dispatch share one driver registry with connection pools, classified error
diagnostics and per-driver connection tests. The `mock` driver covers demos and CI; plugins
can register additional protocols.

## Protocol matrix

| Protocol | DAQ | DCW | Key config |
|---|---|---|---|
| Modbus TCP | ✅ holding/input registers, int16–float32, big/little/wordSwap | ✅ write holding registers + readback | `host` `port` `unitId` `register` (40001 style) |
| Modbus RTU (serial gateway) | ✅ same (connectTcpRTUBuffered) | ✅ FC10 write + FC03 readback | same as TCP, port points at the gateway |
| OPC UA | ✅ session pool, any NodeId, anonymous/signed | ✅ write Double node + readback | `endpoint` `nodeId` |
| MQTT | ✅ subscribe topic + jsonPath | ✅ publish `{jsonKey: value}` | `host` `port` `topic` `jsonPath` |
| HTTP | ✅ GET + jsonPath | ✅ POST `{bodyKey: value}` + response readback | `url` `jsonPath` / `bodyKey` |

## Connectivity tests

Test the driver before creating a node (the create wizard enforces a "test connection" step):

```bash
# test by parameters (no node needed)
curl -X POST $API/api/workshop/daq/test-driver \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"driver":"modbus-tcp","driverConfig":{"host":"127.0.0.1","port":1502,"unitId":1,"register":40001,"registerType":"holding","dataType":"float32"}}'

# test an existing node
curl -X POST $API/api/workshop/daq/$NODE_ID/test -H "Authorization: Bearer $TOKEN"
```

## Sampling model

- **One edge runtime per node**: the sampling cadence (`intervalMs`) and the WS publish
  cadence (`publishIntervalMs`) are independent; one slow or stalled node never blocks
  its neighbors.
- **Line gating**: nodes sample only after being assigned to a line (`lineId`) and the
  line is running (bound to a product/recipe batch). Stopping the line sets them
  offline. Unassigned nodes do not sample.
- **Batch tagging**: every sample taken while running is tagged `product/recipe/runId`,
  so data is queried per batch.

## Write-control safety chain

All dispatch (manual REST / recipe batch / agent tools) converges on a single entry point:

1. gateway & node on/off gates (disabled nodes are always refused);
2. line operate permission;
3. agent mutual-exclusion and rollback-cooldown guards;
4. safe range ∩ active recipe window interlock;
5. (manual binding mode) HITL approval;
6. PLC write → readback verification (beyond tolerance = failure) → signed write history.

If a node referenced by a recipe is deleted, disabled or unbound, dispatch **skips** that
parameter and records the reason in the batch results; the UI and agent tools surface
"disabled / unbound / deleted" consistently.
