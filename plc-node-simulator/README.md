# PLC Node Simulator

A multi-protocol **virtual industrial device** that stands in for a real PLC: it
generates the signals a physical machine would emit and exposes them over real
protocol stacks. It is the plant side of the closed-loop experiments in
[AgentWorkShop](https://github.com/kingdol666/AgentWorkShop) — edge acquisition,
governed setpoint download, live monitoring and fault drills all run against it
over genuine Modbus / OPC UA / MQTT / HTTP transports.

中文说明见 [README-zh.md](README-zh.md)。

## Quick start

```bash
npm install
npm run dev          # serves http://127.0.0.1:4010 (UI included)
```

Open `http://127.0.0.1:4010`, press **Film-line preset** (薄膜产线预设), and five
protocol endpoints start producing data.

On Windows, loopback traffic must bypass the system proxy:
`NO_PROXY=127.0.0.1,localhost` (a proxy will otherwise intercept `fetch`/`net`).

## Protocols

| Protocol | Role | Default port | Notes |
|---|---|---|---|
| Modbus TCP | slave (ServerTCP) | 16040 | FC03/04/06/16; float32/int16/int32/uint16/uint32; big/little/wordSwap byte order (same convention as the platform's `decodeRegisters`) |
| Modbus RTU over TCP | slave (hand-built frames) | 15041 | `mbap` mode interoperates with the platform's `connectTcpRTUBuffered` (echoes the transaction id, client appends CRC); `raw-rtu` mode emits a real CRC16 for gateways that need it |
| OPC UA | server (node-opcua) | 5840 | custom namespace (default `ns=2`, matching the platform's nodeId convention); writable setpoint nodes are written back; optional username/password |
| MQTT | device-side publisher + **built-in mini-broker** | 18830 | publishes signal values every tick to any broker (built-in 18830 by default); payload template `{"data":{"temp":${value}}}` (compatible with the platform's `jsonPath`); `commandTopic` accepts downlink writes and writes them back |
| HTTP | GET endpoint | 4010 (same as UI) | `/sim-http/{deviceId}{path}` returns plain numeric text or a JSON template |

## Signal engine

Every signal has its own strategy, fault injection and calibration
(`output = value × scale + offset`):

- **Strategies** — `constant`, `sine`, `random-walk` (clamped), `ramp` (looping),
  `first-order` (first-order inertia process loop, PV converging to SP, using the
  dynamics already validated in the platform's `dev-plc-simulator`),
  `expression` (references other signals as `[name]`), `manual` (operator
  override) and `hook` (user-supplied producer, see below).
- **Payload shapes** — `scalar` (default), `vector` (frame, ≤4096 points) and
  `image` (raw PNG bytes), aligned with the platform's v2 frame pipeline
  (`daq_frames`).
- **Fault injection** — `stuckAt`, `spike` (out-of-range peak, raises the
  platform's `daq.alarm`), `drift`, `disconnect` (port closed / HTTP 503,
  self-healing after the window).
- **SP→PV coupling** — point a SP register address at a `writebackTarget` and an
  external write to SP updates that loop's `first-order.sp`, reproducing real PLC
  control semantics.

## `hook`: user-defined data producers

Set a signal's strategy to `{"kind":"hook","code":"…","timegapMs":2000}` to drive
each tick from JavaScript:

```jsonc
// `code` is the body of a producer function. In scope: now / dt / prev / state / vars / min / max / rand
"code": "state.t = (state.t ?? 0) + dt; return prev + (sp(state) - prev) * 0.1"
// return number                        → scalar
// return {points:[…]}                  → vector frame (e.g. a thickness profile)
// return {png, width, height}          → image frame (base64 PNG)
```

- `state` is a private per-signal object that persists across ticks, so filters,
  integrators and state machines are just code.
- `vars` exposes the device's other current signal values, enabling cross-signal
  coupling.
- `timegapMs` throttles emission (2000 = emit every 2 s, hold in between).
- Guardrail: `import`/`require`/`process`/`globalThis` are disabled, and compiled
  producers are cached per strategy object.

## `plant-model`: extrusion cast-film physics (`cast-film-physics` preset)

**DAQ values are no longer independent random walks** — they are integrated from a
system of physical state equations, so a governed setpoint change propagates
through the acquisition side according to real process physics:

```
controls (6 DCW, five protocols)        physical state (Euler integration, seedable)   acquisition (7 DAQ)
zone1/2/3 SP (MBTCP 40021/23/25)  ─→    first-order zone heating + inter-zone
                                        conduction (τ=90 s)                       ─→   melt temperature (MBTCP 40001)
screw speed SP (OPC UA ns=2;s=AW.N.Sp) ─→ Arrhenius viscosity → throughput →
                                        pump-chamber first order                  ─→   melt pressure (OPC UA)
draw speed SP (MQTT aw/sim/lineSp/set) ─→ mass conservation h=Q/(w·v·ρ) +
                                        transport dead time L/v                   ─→   mean film thickness (MQTT)
die gap SP (HTTP POST)            ─→    CCD defect rate / gels, parabolic in Tm  ─→   profile vector / CCD image / defect rate (HTTP) / gels (RTU)
```

- All noise comes from a seedable mulberry32 PRNG, so **the same seed reproduces
  exactly**. Ground truth (noise-free) and protocol-exposed (noisy) values are
  written as two columns to `data/truth.jsonl`: the benchmark scores against
  ground truth, while agents only ever see the noisy world.
- `timeScale` (6× by default) compresses thermal-inertia waits; `dtMs` is the
  integration step; all physical parameters are configurable.
- REST: `GET /api/plant/state` (instantaneous state), `GET /api/plant/truth`
  (ground-truth stream), `POST /api/plant/phase` (label warmup/steady/batch/disturb
  and inject disturbances `heaterDecay`/`feedTempStep`/`feedDriftPerMin`),
  `GET /api/plant/optimum` (offline grid-search optimum window `W*`, ground truth
  available only from the twin).
- Physical-consistency assertions (`npm test`): step-response convergence,
  amplitude within ±2 % of the analytic solution, dead time inversely proportional
  to line speed, pressure rising then falling after heater cutoff, same-seed
  reproduction, steady-state algebraic solution ≡ integrated value.

## Named scenarios (isolation between operating conditions)

```bash
curl -X PUT  http://127.0.0.1:4010/api/scenarios/batch-a-steady          # save the whole current config (nodes + plantModel)
curl -X POST http://127.0.0.1:4010/api/scenarios/batch-a-steady/apply    # switch back in one call
curl -X GET  http://127.0.0.1:4010/api/scenarios                         # list
```

Each scenario is a complete snapshot (devices + signal strategies + protocol
mappings + process-model parameters) and scenarios do not interfere; per-node
start/stop is always available via `POST /api/nodes/:id/start|stop`.

## Web UI

- Device cards: protocol badges, endpoints, live values, mini trends, start/stop.
- Editor: communication config, register/variable/topic/endpoint mapping tables,
  signal strategy parameters, fault injection.
- Click any live value to override it manually, simulating an operator setpoint.
- **Film-line preset** generates a five-protocol line in one click (signal
  semantics aligned with the platform's DAQ templates); the **extrusion cast-film
  twin** preset generates a 6-DCW + 7-DAQ physics-coupled line.
- **Integration export**: every device produces the platform's `driverConfig` JSON
  plus two `curl` calls (`test-driver`), so nothing has to be transcribed by hand.
- Config import/export as JSON (atomic write to `data/config.json`, survives restart).

## Connecting to AgentWorkShop

1. In the platform's `/daq` page choose **Add node → real protocol** and fill in the
   `driverConfig` from the simulator's integration export (or call
   `POST /api/workshop/daq/test-driver` with the exported `curl` to verify first).
2. Start the line: acquisition lands in the time-series store, the WebSocket pushes
   readings, DCW writes SP, the simulator's registers update, and DAQ reads back the
   converging value — a closed loop over real protocol stacks.
3. Full-stack integration e2e:

```bash
# prerequisites: simulator running with the film-line preset applied; platform running
# (env AW_BASE, default http://127.0.0.1:3001)
NO_PROXY='*' AW_BASE=http://127.0.0.1:3001 node scripts/e2e-integration.mjs
```

Coverage: five protocol connection tests → five acquisition-to-store checks → DCW
write SP=182 with matching readback and first-order PV convergence → DCW downlink
MQTT writeback → link-loss drill (rejects while down, reconnects after recovery).

## Self-test

```bash
npm test   # engine 19 + plant-model physics 18 + modbus 6 + opcua 4 + mqtt 3 + http 3
```

## Ports (all configurable via env)

UI/API `4010` (`SIM_PORT`) | modbus-tcp `16040` | modbus-rtu `15041` | opcua `5840` |
built-in mqtt-broker `18830` (`MQTT_BROKER_PORT`) | HTTP endpoints share the UI port

## Architecture

```
src/server/
  index.ts             entry: h3 (API + HTTP endpoints + static frontend) + WS + broker
  api.ts               REST (device CRUD, start/stop, manual override, strategy override,
                       export, presets, operating condition & ground truth, named scenarios)
  store.ts             atomic config.json write
  runtime.ts           per-device tick: signal advance + WS push
  engine/signals.ts    strategy math (incl. hook) + fault injection + writeback (pure functions)
  engine/plant-model.ts     extrusion cast-film physics (state equations, steady-state
                            solution, W* grid search; pure and seedable)
  engine/plant-runtime.ts   model↔signal binding layer + two-column ground-truth JSONL export
  engine/png-enc.ts    minimal PNG encoder (image frames)
  engine/registers.ts  encode/decode (symmetric with the platform's decodeRegisters) + CRC16
  protocols/           modbus-tcp / modbus-rtu / opcua / mqtt / http-endpoint / mqtt-broker / registry
web/                   Vue 3 + Vite (dark control-room theme)
tests/                 engine + four-protocol self-tests against real client libraries
scripts/e2e-integration.mjs  cross-project full-stack e2e
```

## Windows notes

- Always use `NO_PROXY=127.0.0.1,localhost` for loopback connections.
- Clear a port with `netstat -ano | findstr :PORT | findstr LISTENING` followed by
  `taskkill /F /PID <pid>` — kill only the target port, never every `node` process.
- Logs are written to disk; deterministic acceptance never depends on timing.

## License

PolyForm Noncommercial License 1.0.0 — see [LICENSE](LICENSE).
Commercial use requires a separate written agreement with the copyright holder.
