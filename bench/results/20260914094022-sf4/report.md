# AW-IndustrialBench — Benchmark Report
**Run** `20260914094022-sf4`  ·  **Verdict:** ALL CHECKS PASSED  ·  **Overall score 86.7/100 (grade B)**
| Field | Value |
|---|---|
| Tier | `plc` |
| Seed | `42` |
| Target | `http://127.0.0.1:3001` |
| Config hash | `fb96a9804db74f78` |
| Harness hash | `f50938f98319b655` (13 sources, SHA-256) |
| Repository commit | `d6c824d` |
| Node / platform | v24.19.0 · win32 x64 |
| Completed at | 2026-09-14T09:40:23.818Z |
**Tally:** 2 pass · 1 warn · 0 fail · 0 skip (skips score nothing, by design).
## Dimension scores
| Dimension | Score | Checks |
|---|---|---|
| D1 Data acquisition | 86.7 | 2 |
| D6 Interoperability | 80.0 | 1 |
## Check results
| Check | Tier | Status | Score | Key metrics | Note |
|---|---|---|---|---|---|
| `api-0-preflight` 实例连通与鉴权 | api | ✔ PASS | 100 | how=<b>login</b> · role=<b>admin</b> | 实例 http://127.0.0.1:3001 可用 |
| `plc-0-simulator` PLC 模拟器就绪+薄膜产线预设 | plc | ✔ PASS | 100 | protocols=<b>5</b> · sim=<b>http://127.0.0.1:4010</b> | 模拟器就绪(film-line 预设) |
| `plc-1-realpath` 五协议真实连通(导出配置→test-driver) | plc | ▲ WARN | 80 | protocols_ok=<b>4</b> · total=<b>5</b> | 部分协议未连通 |
## Evidence excerpts
### `api-0-preflight` 实例连通与鉴权
- 登录成功（login，role=admin）
### `plc-0-simulator` PLC 模拟器就绪+薄膜产线预设
- 五协议设备: modbus-tcp, modbus-rtu, opcua, mqtt, http
### `plc-1-realpath` 五协议真实连通(导出配置→test-driver)
- ✔ modbus-tcp 真实连通 ok (14ms)
- ✔ modbus-rtu 真实连通 ok (27ms)
- ✘ opcua 连通失败: OPC UA 连接失败: The connection may have been rejected by server
- ✔ mqtt 真实连通 ok (21ms)
- ✔ http 真实连通 ok (20ms)
---
**Reproduce:**
```bash
node bench/run.mjs --tier plc --seed 42 --base http://127.0.0.1:3001
```
Artifacts: `bench/results/20260914094022-sf4/` (run.json · report.md · report.html). Results are append-only — runs are never overwritten, so this report can be cited as experimental evidence. Judge-class metrics are deterministic under a fixed seed; environment-dependent figures (latency, freshness) are reported as measured.