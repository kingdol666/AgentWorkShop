# Six-protocol DAQ & control

The acquisition (DAQ) and write-control (DCW) driver surface covers six field protocols
(5 built-in + the built-in serial plugin). Acquisition and dispatch share one driver registry
with connection pools, classified error diagnostics and per-driver connection tests. The `mock`
driver covers demos and CI. **Protocols are plugins** — drivers injected via
`ctx.daq.registerDriver` / `ctx.dcw.registerWriteDriver` automatically appear in the frontend
protocol dropdown and dynamic forms (⌁ badge) with zero frontend changes.

## Protocol matrix

| Protocol | DAQ | DCW | Key config |
|---|---|---|---|
| Modbus TCP | ✅ holding/input registers, int16–float32, big/little/wordSwap | ✅ write holding registers + readback | `host` `port` `unitId` `register` (40001 style) |
| Modbus RTU (serial gateway) | ✅ same (connectTcpRTUBuffered) | ✅ FC10 write + FC03 readback | same as TCP, port points at the gateway |
| OPC UA | ✅ session pool, any NodeId, anonymous/signed | ✅ write Double node + readback | `endpoint` `nodeId` |
| MQTT | ✅ **passive subscription** (ingest on message arrival; sample time = arrival time, not polling) + jsonPath | ✅ publish `{jsonKey: value}`; with `readTopic`/`readJsonPath` a post-write readback can reach `readback-verified` | `host` `port` `topic` `jsonPath` `qos` `staleMs`; write side also `jsonKey` `readTopic` `readJsonPath` |
| HTTP | ✅ GET + jsonPath | ✅ POST `{bodyKey: value}` + response readback | `url` `jsonPath` / `bodyKey` |
| **Serial (serial-bridge plugin)** | ✅ Modbus RTU (FC03/FC04) + ASCII line protocol (numeric/JSON + freshness window) | ✅ Modbus RTU write holding registers (FC06/FC16) + same-address readback; ASCII template dispatch | `path` `baudRate` `parity` `unitId` `register` `dataType` `byteOrder`; [plugin docs](/en/plugins/guide) (see "Communication-protocol plugins") |

## Byte order (32-bit types)

For 32-bit `dataType` values (int32/uint32/float32), `byteOrder` decides how the two
registers are assembled (value bytes MSB→LSB written as A B C D):

| `byteOrder` | Layout | Registers | Typical use |
|---|---|---|---|
| `big` (default) | **ABCD** | w0=[A B], w1=[C D] | Standard Modbus big-endian, most common |
| `wordSwap` | **CDAB** | w0=[C D], w1=[A B] | Word swap only (some meters/PLCs) |
| `little` | **DCBA** | w0=[D C], w1=[B A] | Full 32-bit little-endian (byte-swapped words, reversed order) |

- Decoding (DAQ) and encoding (DCW) are **exact inverses**: a value written with one order
  always reads back identically with the same order.
- Since 0.8.6 `little` means **standard DCBA**; older releases actually produced the
  non-standard BADC layout for this option. If a node was calibrated under the old
  behaviour, do one known-value write/read comparison before putting it back into production.
- A wrong byte order shows up as a tiny (1e-38-ish) or huge number, not as an error —
  always verify on first commissioning.

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
- **Push protocols (MQTT) bypass the sampling loop**: the controller holds a persistent
  subscription and every arriving message goes straight through queue → storage
  (timestamp = arrival time). While the device is silent no rows are written; after
  `staleMs` (default 300 s; set it to 2–3× the device publish period) the node goes
  offline with a readable `lastError`, and resumes automatically when publishing returns.
- **Line gating**: nodes sample only after being assigned to a line (`lineId`) and the
  line is running (bound to a product/recipe batch). Stopping the line sets them
  offline. Unassigned nodes do not sample.
- **Batch tagging**: every sample taken while running is tagged `product/recipe/runId`,
  so data is queried per batch.

## MQTT structured decoding and user sinks

An MQTT node can turn a structured JSON payload (or plain numbers / binary images) into one
typed sample: `scalar` (a number), `vector` (a numeric array) or `image`. The mapping is
declared in the node's `driverConfig` **at node creation**, and the result is stored with the
node/template/line/batch metadata: scalars in `daq_samples`; vectors and images in
`daq_frames` (points + metrics; image object key + dimensions + sha256 + metrics).

| Template kind | driverConfig (set at node creation) | Storage |
|---|---|---|
| scalar | `jsonPath` (e.g. `data.temperature`; empty for plain-number payloads) | `daq_samples` |
| vector | `pointsPath` (default `points`), optional `metricsPath` | `daq_frames` (points/metrics) |
| image | `imageFormat=json\|binary`, `imagePath` (default `png`), `imageMime`, optional `imageWidthPath`/`imageHeightPath` | `daq_frames` (objectKey/mime/width/height/sha256/metrics) |

Example: `{"data":{"points":[10,20,30,40,50],"metrics":{"avg":30}}}` with a vector template and
`pointsPath=data.points` becomes a 5-point frame; the template's `sink.processors`
(`derive-metric`, `zones`, `thumbnail`, `quality-gate`, or plugin-registered processors) run on
the production side before storage.

**Custom parsing (one interface, owned by the user):** a plugin registers a decoder:

```js
export default {
  name: 'my-mqtt-sink',
  setup(ctx) {
    ctx.daq.registerDecoder('my-json', (input) => {
      const j = JSON.parse(input.raw)                 // input: raw/bytes/json/config/signalKind/nodeId
      return { kind: 'scalar', value: j.a + j.b }     // or {kind:'vector',points:[...]} / {kind:'image',blob,mime,width,height}
    })
  },
}
```

Set `driverConfig.decoder = 'my-json'` on the node (it takes precedence over the declarative
paths). The decoded kind must match the template's `signalKind`, otherwise the node reports a
`lastError` and stores nothing. Decoders are synchronous pure functions (a Promise return is
rejected), registered with plugin ownership and revoked on plugin reload/disable; `input.json`
is already parsed. Heavier frame processing belongs in
`ctx.daq.registerProcessor(kind, name, fn)` + the template sink. Decode config (paths/decoder)
is part of the subscription fingerprint: PATCHing it rebuilds the live subscription.

> Boundaries: no XML/HTML parsing; raster MIME only (PNG/JPEG/WebP/BMP/GIF/TIFF; SVG and other
> executable content rejected); base64 cap 10 MB (`imageMaxBytes`), side ≤16384, ≤16M pixels,
> bounded decompression; non-PNG needs explicit dimensions (`width`/`height` or width/height
> paths; binary JPEG uses fixed `width`/`height`) and MIME (`mimePath` beats the static
> `imageMime`, a data-URL MIME beats both); null/boolean/empty strings are never silently
> coerced to 0, and explicitly provided dimensions must be positive; the saved-node test
> decodes with the node template kind (the add wizard auto-detects); image brightness and
> thumbnails only understand this repo's 8-bit gray PNG (RGB/JPEG may yield no metrics).

## Write-control safety chain

All dispatch (manual REST / recipe batch / agent tools) converges on a single entry point:

1. gateway & node on/off gates (disabled nodes are always refused);
2. line operate permission;
3. agent mutual-exclusion and rollback-cooldown guards;
4. safe range ∩ active recipe window interlock;
5. (manual binding mode) HITL approval;
6. PLC write → readback verification (beyond tolerance = failure) → signed write history.

> MQTT write control: a QoS1 puback only means **the broker accepted the message**
> (transport-ack). If the device echoes the setpoint on a state topic, configure
> `readTopic` (e.g. `aw/sim/state`) + `readJsonPath` (e.g. `setpoint`) on the node; the
> gateway then performs an independent post-write readback and reports
> `readback-verified`. Without a readback topic the result stays `unverified` — the
> platform never claims device-side effect it did not observe.

If a node referenced by a recipe is deleted, disabled or unbound, dispatch **skips** that
parameter and records the reason in the batch results; the UI and agent tools surface
"disabled / unbound / deleted" consistently.
