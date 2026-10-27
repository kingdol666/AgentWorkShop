# Bench driver v2 migration — 2026-10-26

## What changed

The multi-scenario benchmark no longer writes directly to DCW nodes. Under permission
model v2, direct node writes are rejected; the harness now uses the recipe face:

- `bench/lib/scenarios.mjs`
  - binds the active **recipe** to the tool agent (`kind='recipe'`), then switches that
    binding to `auto` with `confirm:true`;
  - binds DAQ nodes separately for read-only observation;
  - switches the isolated line to `controlMode='auto'` for unattended benchmark runs
    (the line's four-layer write limits and runtime gate still apply);
  - replaces `dcw_control` + `dcw_judge` with `recipe_trial` batch trials and
    post-trial re-measurement;
  - creates benchmark recipes with `opIntervalMs: 0` (deterministic offline run) and
    documents the `AW_TRIAL_INTERVAL_MS=0` platform prerequisite;
  - reads DAQ samples with an explicit recent `from`/`to` window (without it, a reused
    line returns the oldest limit points and the controller appears unresponsive);
  - isolates the biax plant engine by `id` instead of replacing the whole plant config,
    so the four scenarios can run in parallel without stopping each other's engine.
- `bench/lib/biax.mjs`: same recipe_trial migration and recent-window read.
- `bench/lib/closedloop.mjs`: recent-window read for the reusable closed-loop helper.
- `bench/lib/scenario-report.mjs`: report columns now show the trial batch instead of the
  retired optimization-record/judge pair.

## Verification runs

Runs were executed on an isolated platform (`AW_HOME=D:/tmp/aw-bench-home`, port 3001,
`AW_TRIAL_INTERVAL_MS=0`) with the PLC simulator on port 4010.

| Run | Writes (inj/wwtp/anneal/biax) | Attained | Result |
| --- | --- | --- | --- |
| `20261026110116-1cio` | 1 / 1 / 1 / 1 | no | trial cadence still 300 s |
| `20261026110320-gwg` | 5 / 10 / 2 / 6 | no | stale DAQ samples (no window) |
| `20261026110954-ovw` | 8 / 9 / 6 / 6 | no | biax plantWhole replaced other engines |
| `20261026111620-29mg` | 3 / 11 / 2 / 6 | no | engines isolated; simulator PV mapping weak |

The migration is functionally complete: every trial is now accepted through the recipe
gate and produces a batch id. The remaining failure is **attainment**, not write refusal.

## Remaining red (honest)

After fixing the write path and the two harness bugs, the simulator's PV response does not
follow the scenario gain assumptions closely enough for the existing control targets
(for example injection part weight stays near 30 g after hold pressure reaches its 110 bar
ceiling; anneal hardness settles around 140 HV after the zone setpoints saturate). This is a
simulator blueprint/response-mapping calibration issue, not a platform governance defect.
The benchmark correctly exits non-zero and must not be reported as passing until the
simulator model is recalibrated or the scenario targets/gains are re-derived from measured
response curves.

## Reproduce

```bash
AW_HOME=<isolated-home> AW_TRIAL_INTERVAL_MS=0 PORT=3001 node .output/server/index.mjs
NO_PROXY=127.0.0.1,localhost \
  node bench/scenarios.mjs --base http://127.0.0.1:3001 \
  --no-autostart-platform --seed 45 --tool-harness opencode \
  --scenarios injection,wwtp,anneal,biax
```

## 2026-10-27 更正:attainment 红的真正根因(已修复)

上表"attainment 红是模拟器标定问题"的归因**不准确**,2026-10-27 排查推翻:

- 模拟器引擎/模型**无缺陷**:SP→PV 响应逐层活体验证(引擎真值/信号值/平台采样三层同步跟动,
  保压 110→69 时克重 34.65→32.5 两秒内入窗)。
- 真正根因(两层,均在 **bench 反馈通道**):
  1. **多场景跑器从未启动 DAQ 采样总控**(`ensureGateway` 只在 checks 里被调);
     冷启平台不自动起采样器,mission 的 PV 反馈(`/samples`)没有新样本。
  2. **`readPvMean` 的 60s 窗口 + `/samples` 的 `ORDER BY b_at ASC LIMIT n` 语义**
     = 永远读到窗口内**最旧**的 n 桶(≈55s 前)。v2 迁移把迭代加快到 8-17s/轮后,
     55s 陈旧度 = 控制器永远落后 4-5 轮,对着旧基线反复加码 —— 表象即"PV 冻结"。
- 修复(`bench/lib/scenarios.mjs`):`runScenarioBench` 入口显式 `ensureGateway`;
  每场景 mission 前加**采样活性+值跟动哨兵**(60s 等待;样本值必须等于设备现值,否则记 error 拒跑);
  `readPvMean` 窗口改为 limit×1s+3s(只读最新几桶);慢动力学工况 settle 调优(wwtp 30s/anneal 25s/biax 20s)。
- 修复后复跑(run `20261027043152-u80`,fresh home,四场景并行):**injection ✔(3 发写入收敛)/
  wwtp ✔(11 发,慢动力学)/ anneal ✔(6 发)**;biax 响应已实时(28.00→27.93 递降)但仍未入窗
  —— 剩余项是 biax mission 自身的**控制器增益/轮次预算标定**,不再是通道问题。
