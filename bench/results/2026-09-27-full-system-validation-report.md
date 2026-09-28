# Full System Validation Report

- Validation date: 2026-09-27
- Scope: current working tree, no commit/reset performed
- Platform targets: existing repo instance 3005 and isolated home attempt 3006
- PLC targets: existing CastFilm shadow 4011, isolated CastFilm shadow 4012, protocol self-test simulator 4010
- Safety boundary: simulated PLC/digital twin only; no physical PLC; bounded-auto/gov write flags unchanged

## Quality Gates

| Gate | Result | Evidence |
|---|---:|---|
| `pnpm lint` | PASS | 0 errors / 0 warnings after cleanup |
| `pnpm typecheck` | PASS | `vue-tsc -b --noEmit` passed |
| Root unit tests | PASS | 50/50 tests, including OPC UA 4/4; TDZ registry fix verified with server tsconfig |
| Twin provider | PASS | 5/5 |
| Plugin lifecycle | PASS | 22/0 |
| SDK surface | PASS | passed |
| Local timezone helper | PASS | 2/2; Shanghai↔Los Angeles, epoch preserved |
| Scheduler | PASS | 44/44 |
| Memory month query | PASS | 16/16 |
| PLC engine/scenario | PASS | engine 19; plant 18; biax 18; scenario 31 |
| PLC live protocols | PASS | Modbus 6/6; OPC UA 4/4; MQTT 3/3; HTTP 3/3 |

## Real Timezone Verification

The system setting `time.timeZone` was switched through the live API:

```text
Asia/Shanghai -> America/Los_Angeles -> Asia/Shanghai
```

Audit records written after each switch:

```text
Asia/Shanghai        2026-09-27T02:24:04.088+08:00
America/Los_Angeles  2026-09-26T11:24:04.133-07:00
```

The read-only timezone API returned the active IANA zone and offset after each change. The final state was restored to `Asia/Shanghai`. DAQ machine timestamps remain epoch/timestamptz; they were not converted to wall-clock strings.

## PLC / AML / Channel Evidence

- Existing CastFilm shadow simulator had been validated on 4011 with five protocol endpoints and prior AML artifacts.
- A fresh 4012 shadow simulator was started with `cast-film-physics`; its remapped Modbus TCP/RTU, OPC UA, HTTP and MQTT endpoints were confirmed by the simulator preset API and port probes.
- A fresh isolated platform 3006 was started with a home data root. It correctly exposed the UI/API and DAQ gateway, but Docker/Timescale/MinIO were unavailable, so the platform reported degraded infrastructure and stopped online DAQ acquisition. This was recorded as an environment limitation, not converted into a pass.
- `scripts/e2e-aml-decoupled.mjs` on the repo-backed platform proved 23/30 assertions before environment/fixture-dependent stages stopped:
  - training and optimization tool surfaces were separated;
  - exploration mode rejected MPC, trial and Bayes tools;
  - optimization mode prompt contained goal, node semantics, tuning range and step metadata;
  - `optimization_explore` performed a real governed DCW write (95.2 -> 95.7), read back DAQ response, and stored an exploration record.
- Remaining decoupled E2E failures were attributable to:
  - PLC 4011 process exiting before the second run, causing MQTT 19830 refusal and DAQ watermark 0;
  - fresh training plan fixture receiving a null dataset spec in the script;
  - model/trial IDs in the script being stale relative to current registry state;
  - the dataset experiment budget being already 12/12, so new training was correctly rejected by the AML budget guard.
- Existing successful proof remains authoritative for model-backed AML: `OPTIMIZATION-LOG.md` and `MOCKOMP-LOG.md` under `bench/results/2026-09-26T01-55-11-aml-live-optloop/` document training, Twin Gate, production promotion, recommendation-only MPC and DCW/DAQ response.

## Computer Use UI Evidence

Computer Use runtime permissions were granted and Edge was controlled through the accessibility/browser surfaces.

Verified visibly:

- `/workshop` loaded on the isolated platform.
- UI registration created `validation-ui-0927` and displayed `注册成功:validation-ui-0927;登录 token 已保存`.
- Workspace empty state rendered after login, with navigation buttons for 系统设置、建模、产线运营、数采中心、Agent 工作台.
- `/aml` rendered the full AML Studio structure: runtime badges, dataset snapshots, training jobs, experiment leaderboard, model registry and prediction console; the fresh isolated home root correctly showed empty states.
- `/settings` rendered the system settings page and runtime configuration entry point.

A full authenticated UI traversal into production AML/Channel records was not claimed because the isolated home root had no historical line/model assets and Docker-backed DAQ was unavailable. No destructive UI actions were executed.

## OMP Smoke

A real OMP task was not sent. The deterministic mock-OMP chain was already proven in `MOCKOMP-LOG.md`; a new training submission during this validation was correctly stopped by the hard experiment budget (`12/12`). No additional token/OMP balance was consumed.

## Remaining Boundaries

- The PLC is a production-shaped simulator/digital twin, not a physical PLC.
- Docker/Timescale/MinIO availability is required for a fresh isolated platform to run live DAQ acquisition; the existing repo-backed artifacts remain valid evidence for the prior closed loop.
- Recommendation-only remains the default; governed/bounded-auto write flags remain closed.
- Model gate qualification and actual PV target convergence remain separate conclusions; the existing CastFilm model passed eligibility but its observed PV remained above the nominal 50/52 μm goals in the documented run.
