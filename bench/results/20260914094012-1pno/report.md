# AW-IndustrialBench — Benchmark Report
**Run** `20260914094012-1pno`  ·  **Verdict:** ALL CHECKS PASSED  ·  **Overall score 0.0/100 (grade —)**
| Field | Value |
|---|---|
| Tier | `plc` |
| Seed | `42` |
| Target | `http://127.0.0.1:3001` |
| Config hash | `cfb53266cc6193ba` |
| Harness hash | `f50938f98319b655` (13 sources, SHA-256) |
| Repository commit | `d6c824d` |
| Node / platform | v24.19.0 · win32 x64 |
| Completed at | 2026-09-14T09:40:12.307Z |
**Tally:** 1 pass · 0 warn · 0 fail · 1 skip (skips score nothing, by design).
## Dimension scores
| Dimension | Score | Checks |
|---|---|---|
## Check results
| Check | Tier | Status | Score | Key metrics | Note |
|---|---|---|---|---|---|
| `api-0-preflight` 实例连通与鉴权 | api | ✔ PASS | 100 | how=<b>login</b> · role=<b>admin</b> | 实例 http://127.0.0.1:3001 可用 |
| `plc-1-realpath` 五协议真实连通(导出配置→test-driver) | plc | ↓ SKIP | 0 | — | 需要 PLC 模拟器（plc-0 未通过）——本层诚实跳过 |
## Evidence excerpts
### `api-0-preflight` 实例连通与鉴权
- 登录成功（login，role=admin）
## Skipped checks (with reasons)

- **plc-1-realpath** 需要 PLC 模拟器（plc-0 未通过）——本层诚实跳过
---
**Reproduce:**
```bash
node bench/run.mjs --tier plc --seed 42 --base http://127.0.0.1:3001
```
Artifacts: `bench/results/20260914094012-1pno/` (run.json · report.md · report.html). Results are append-only — runs are never overwritten, so this report can be cited as experimental evidence. Judge-class metrics are deterministic under a fixed seed; environment-dependent figures (latency, freshness) are reported as measured.