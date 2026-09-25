/**
 * 临时:把 0.7.47 打包实测行追加到 README 双语验收表(保持两语文案对齐)
 * 用法:node scripts/_aw0747-readme-rows.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'

const zhRows = [
  '| `_aw0746-stage12.mjs` | **10 / 0**（2026-09-25,全局安装的 **v0.7.47 打包系统**） | 健康门(version=0.7.47)→ 管理员登录/角色面 → 创建 Channel(真实 `omp` lead)→ 开群聊 → **真实 omp 群聊回复** → 系统监控可见 omp 子进程 | `AW_BASE=<base> node scripts/_aw0746-stage12.mjs` |',
  '| `_aw0746-stage34.mjs` | **11 / 0**（2026-09-25,v0.7.47 打包系统 + PLC 模拟器） | 模拟器建线（11 数控 + 14 数采）→ 产品/配方三元组 → 开跑后**样本逐条带 recipe_id/run_id** → `daq_query` **默认只取当前活动批次**（`scope=all` 可放开，实测 1 vs 4）→ 实例化 Hybrid Twin 模板（lead + 3 worker,注入孪生 6 件套 / 总 57 工具） | `AW_BASE=<base> node scripts/_aw0746-stage34.mjs` |',
  '| `_aw0746-stage6b-train-sweep.mjs` | 门禁**全绿**（2026-09-25,v0.7.46 打包系统,真实 torch 训练） | 1 s 拍格数据集（**1724 行 / 10 批次**）→ 内联 code 作业真实训练 → G1 单步 **0.0992**（≤0.10）/ G2 滚动 0.1092（≤0.25）/ G3 泛化 14.6%（≤20%）/ G4 行数与批次 → 模型注册并**晋升 production** | `AW_BASE=<base> AW_DATASET_ID=<ds> node scripts/_aw0746-stage6b-train-sweep.mjs` |',
  '| `_aw0746-stage7-twin.mjs` | **17 / 0**（2026-09-25,v0.7.47 打包系统,真实 DAQ + 真实模型） | 真实样本 → TwinSnapshot `fresh=true` → 65 组真实 VirtualTrial（12 条安全候选,`candidateExecuted=false`）→ 12 项推荐门禁 **write_eligible** → 门禁结论回写模型 `twinEligibility` → `mpc_optimize` 升档 **precise_search** → 全程 **0 DCW 写入** | `AW_BASE=<base> AW_REQUIRE_MODEL=1 node scripts/_aw0746-stage7-twin.mjs` |',
  '| `_aw0746-stage6c-jobsmoke.mjs` | **5 / 0**（2026-09-25,v0.7.47 打包系统） | AML 作业链路：内联 `code` 被接受（不再要求 `workspace/train.py`）→ 作业到终态 → 训练日志/ONNX 痕迹 → 实验与逐项门禁落库 | `AW_BASE=<base> node scripts/_aw0746-stage6c-jobsmoke.mjs` |',
]
const enRows = [
  '| `_aw0746-stage12.mjs` | **10 / 0** (2026-09-25, globally installed **v0.7.47 packaged build**) | health gate (version=0.7.47) → admin login/role surface → channel creation with a real `omp` lead → group chat opened → **real omp reply** → omp child process visible in monitoring | `AW_BASE=<base> node scripts/_aw0746-stage12.mjs` |',
  '| `_aw0746-stage34.mjs` | **11 / 0** (2026-09-25, v0.7.47 packaged build + PLC simulator) | line provisioned from the simulator (11 DCW + 14 DAQ) → product/recipe triple → **every sample tagged with recipe_id/run_id** while running → `daq_query` **defaults to the active batch** (`scope=all` opts out, measured 1 vs 4) → Hybrid Twin template instantiated (lead + 3 workers, 6 twin tools injected, 57 total) | `AW_BASE=<base> node scripts/_aw0746-stage34.mjs` |',
  '| `_aw0746-stage6b-train-sweep.mjs` | gates **all green** (2026-09-25, v0.7.46 packaged build, real torch training) | 1 s grid dataset (**1724 rows / 10 runs**) → inline-code job trained for real → G1 one-step **0.0992** (≤0.10) / G2 rollout 0.1092 (≤0.25) / G3 generalisation 14.6% (≤20%) / G4 rows+runs → model registered and **promoted to production** | `AW_BASE=<base> AW_DATASET_ID=<ds> node scripts/_aw0746-stage6b-train-sweep.mjs` |',
  '| `_aw0746-stage7-twin.mjs` | **17 / 0** (2026-09-25, v0.7.47 packaged build, real DAQ + real model) | real samples → TwinSnapshot `fresh=true` → 65 real VirtualTrials (12 safe candidates, `candidateExecuted=false`) → 12-check recommendation gate **write_eligible** → verdict written back to the model as `twinEligibility` → `mpc_optimize` upgrades to **precise_search** → **0 DCW writes** throughout | `AW_BASE=<base> AW_REQUIRE_MODEL=1 node scripts/_aw0746-stage7-twin.mjs` |',
  '| `_aw0746-stage6c-jobsmoke.mjs` | **5 / 0** (2026-09-25, v0.7.47 packaged build) | AML job path: inline `code` accepted (no `workspace/train.py` required) → job reaches a terminal state → training logs/ONNX traces → experiment plus per-check gates persisted | `AW_BASE=<base> node scripts/_aw0746-stage6c-jobsmoke.mjs` |',
]

for (const [file, anchor, rows] of [
  ['README-zh.md', '| 前端验收 |', zhRows],
  ['README.md', '| Front-end acceptance |', enRows],
]) {
  const lines = readFileSync(file, 'utf8').split('\n')
  const i = lines.findIndex(l => l.startsWith(anchor))
  if (i < 0) throw new Error(`anchor not found in ${file}`)
  lines.splice(i + 1, 0, ...rows)
  writeFileSync(file, lines.join('\n'), 'utf8')
  console.log(`inserted ${rows.length} rows after line ${i + 1} in ${file}`)
}
