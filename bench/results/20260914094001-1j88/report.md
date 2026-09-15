# AW-IndustrialBench — Benchmark Report
**Run** `20260914094001-1j88`  ·  **Verdict:** NOT EVALUATED  ·  **Overall score 0.0/100 (grade —)**
| Field | Value |
|---|---|
| Tier | `plc` |
| Seed | `42` |
| Target | `http://127.0.0.1:3001` |
| Config hash | `4b40f3b026be5cb1` |
| Harness hash | `f50938f98319b655` (13 sources, SHA-256) |
| Repository commit | `d6c824d` |
| Node / platform | v24.19.0 · win32 x64 |
| Completed at | 2026-09-14T09:40:01.212Z |
**Tally:** 0 pass · 0 warn · 0 fail · 1 skip (skips score nothing, by design).
## Dimension scores
| Dimension | Score | Checks |
|---|---|---|
## Check results
| Check | Tier | Status | Score | Key metrics | Note |
|---|---|---|---|---|---|
| `plc-1-realpath` 五协议真实连通(导出配置→test-driver) | plc | ↓ SKIP | 0 | — | 需要运行中的平台实例（api-0 preflight 未通过）——本层诚实跳过，不影响静态层结论 |
## Evidence excerpts
## Skipped checks (with reasons)

- **plc-1-realpath** 需要运行中的平台实例（api-0 preflight 未通过）——本层诚实跳过，不影响静态层结论
---
**Reproduce:**
```bash
node bench/run.mjs --tier plc --seed 42 --base http://127.0.0.1:3001
```
Artifacts: `bench/results/20260914094001-1j88/` (run.json · report.md · report.html). Results are append-only — runs are never overwritten, so this report can be cited as experimental evidence. Judge-class metrics are deterministic under a fixed seed; environment-dependent figures (latency, freshness) are reported as measured.