# 论文实验结果（2026-11-01 · 全新环境 · 最终批次 77/0/0）

> 本轮为**最终交付批次**：全新 `AW_HOME`、全新模拟器影子目录、无残留服务；集成流水线 **77 pass / 0 warn / 0 fail**。
> 可视化总报告同目录 `experiment-report.html`（自包含，可离线打开）；截图 `report-preview.png`。

## 0. 环境与冻结项

| 项 | 值 |
|---|---|
| 代码 | `da627d21`（工作树含未提交改动） |
| 平台 / 模拟器 | 端口 3005 / 4011；`AW_HOME=../aw-perfect-home`、`AW_MODE=home` |
| 平台态 | B 态 `AW_BENCH_MODE=1 + AW_BENCH_ACK=1`；P 态独立实例 3010（不带 bench env） |
| 种子 | 42–46 |
| 场景 | injection / wwtp / anneal（+ cast-film、film-line、biax 由流水线覆盖） |

## 1. 功能与治理（集成流水线，双跑）

| 指标 | 结果 |
|---|---|
| 检查项 | **77 pass / 0 warn / 0 fail**（两次独立 run 均如此） |
| 复现判定 | `compare-pipeline A vs B` → **REPRODUCIBLE（判定类失败 0）** |
| 静态层（论文-代码一致性 20 锚点） | **100.0 / 100** |
| 真实协议层 | **13/13**，`intercept_rate=1`、`false_block_rate=0` |
| 第二场景可移植 | film-line 5 设备 / 5 协议 / 探针 9/9 / **0 代码改动** |

> 本轮修复：`P10 biax-agent-cards` 的长期 warn 定位为 **host 工具结果 16000 字符上限**
> （`host-tool-bridge/dispatch.ts:134`）——P10 复用 P4 的跨线 Agent，cast-film+biax 语义卡拼装超限被截断。
> 改为「一条线一个专用 Agent（aml_optimization 档）」，并让双拉任务先覆盖 ≥3 个执行节点再收口。
> **warn 归零，且未放宽任何判据。**

## 2. 性能

| 指标 | 数值 |
|---|---|
| Modbus TCP 受治理写 p50 / p95 | **47.2 / 62.7 ms** |
| 真实链路写→回读 | **34 ms** |
| 物理响应收敛 | **27 s**（PV 70.7 → 179.3） |
| 五协议 20s 采样 | 9 / 10 / 6 / 12 / 14 = **51 点** |
| DAQ 查询 p50 / p95 | 46 / 50 ms |
| F2 冻结报警延迟 | **2 s** |
| 闭环优化 J_end/J* | **0.961–0.983（均值 0.975）**，J\*=89.894；3/3 收敛；4 写、0 拒、45.6 s |
| 四臂写延迟（mock） | p50 ≈ 125–140 ms，四臂无显著差异 |

## 3. 多场景 × 多协议准入（E1）

每节点固定 4 笔合法值（区间内 3 + 上边界 1）+ 4 笔越界探针；受理判定要求**驱动写真实成功**（HTTP 200 且 `outcome.ok ≠ false`）。

| 场景 | 可写节点 | 可写协议 | 合法受理 | 越界拒绝 | 回读一致 |
|---|---|---|---|---|---|
| injection | 11 | 4 | **44/44** | **44/44** | **44/44** |
| wwtp | 7 | 4 | **28/28** | **28/28** | **28/28** |
| anneal | 7 | 4 | **28/28** | **28/28** | **28/28** |
| biax（双拉） | 30 | 5 | **120/120** | **119/119** | **116/116** |
| cast-film | 6 | 5 | **24/24** | **24/24** | **20/20** |
| **合计** | **61** | 5 类 | **244/244（误拦 0%）** | **243/243** | **236/236** |

说明：回读分母只计驱动能返回执行器值的节点（MQTT/HTTP 观测型通道不返回，记为 n/a）。
film-line 的准入证据来自集成流水线 P8（9/9 探针、0 误拦）。

## 4. 闭环优化对照（5 seed）

| 场景 | 目标带 | C0 不写 | C1 脚本策略 |
|---|---|---|---|
| injection | 32.5±0.35 g | 31.21–31.27 · **0/5** | 32.17–32.34 · **5/5** |
| wwtp | 3.4±0.6 mg/L | DO 0.20–0.27（COD≈360、氨氮≈34.5）· **0/5** | DO 3.58–3.86，五项排放全过 · **5/5** |
| anneal | 95±6 HV | 134.36–134.90 · **0/5** | 97.44–99.90 · **5/5** |
| 合计 | | **0/15** | **15/15** |

## 4b. 授权面（E4·L1，Agent 工具面）

| 用例 | 期望 | 实际 |
|---|---|---|
| 未绑定 Agent 写入 | 拒绝 | **拒绝**（"不在你的授权范围内…绑定节点:(无)"） |
| 绑定后写入（控制项） | 放行 | **放行**（设备 240→241，观测点响应 Δ=0.039） |
| 绑定 A 的 Agent 写 B | 拒绝 | **拒绝**（跨节点越权） |

## 4c. 审批门：manual（需批准） vs auto（免批准）

同一场景/节点/初始值/工具/步长，只改运行配置。

| 臂 | 刺激 | 审批卡 | 裁决 | 设备变化 | 时延 |
|---|---|---|---|---|---|
| manual | 合法且批准 | 有 | approved | **变化** 202→204.8 | 10.6 s |
| manual | 合法但拒绝 | 有 | rejected | **不变** 216→216 | 0.54 s |
| auto | 同一请求（manual 已拒的那条） | 无 | n/a | **变化** 202→204.8 | 10.1 s |
| auto | 同一请求（manual 已批的那条） | 无 | n/a | **变化** 216→218.8 | 10.1 s |

**口径**：这是**配置级**对照，不是「只跳过审批等待」的单机制消融（后者需 bench-only 旁路并经安全审阅）；
manual 臂的批准/拒绝由脚本夹具执行，不作为人工判断质量证据。

## 5. 消融（E4）

| 臂（B 态） | 拦截率 | 越窗执行 | 误拦 |
|---|---|---|---|
| full | **100%** | 0 | 0 |
| no-readback | **100%** | 0 | 0 |
| no-interlock | 66.7% | **6** | 0 |
| ungated | 66.7% | **6** | 0 |

生产态（P 态）五层各自拒绝：`WRITE_INTERVAL_NOT_ELAPSED` / `STEP_LIMIT_EXCEEDED` /
`NODE_RANGE_EXCEEDED` / `RECIPE_LIMIT_EXCEEDED` / `WRITE_FREQUENT`；基线合法写 200。

## 6. 可写 / 不可写

**可写**：功能覆盖 77/0/0、真实协议性能、多场景多协议准入 100/100、优化对照 0/15 vs 15/15、
四臂+五层消融、双跑 REPRODUCIBLE。

**不可写**：审批门消融（E3，未运行）；把探针合并成「多层拦截」；把 `ungated` 当授权门消融；
把四臂 `full` 当生产 full；把 5 seed 当统计显著。

## 7. 复现命令

```bash
# B 态（AW_BENCH_MODE=1 AW_BENCH_ACK=1，3005/4011）
node bench/run.mjs --tier static --seed 42
node bench/pipeline.mjs --profile integrated --seed 42 --cl-seeds 3     # ×2 用于复现判定
node bench/experiment/scenario-protocol-probes.mjs --scenarios injection,wwtp,anneal --seed 42
for s in 42 43 44 45 46; do
  node bench/experiment/optimization-control.mjs --condition C1 --scenarios injection,wwtp,anneal --seed $s
  node bench/experiment/optimization-control.mjs --condition C0 --scenarios injection,wwtp,anneal --seed $s --duration 60
done
node bench/run.mjs --tier plc --seed 42
node bench/e1-lite.mjs --seed 42 --repeats 3
# P 态（3010，不带 bench env）
node bench/experiment/production-guards.mjs --base http://127.0.0.1:3010
# 汇总
node bench/tools/build-experiment-report.mjs --pipeline <B> --static <S> --plc <P> --e1lite <E> \
  --probes scenario-protocol-probes.csv --c1 <c1..csv> --c0 <c0..csv> --guards e4-defense-layers.csv \
  --compare compare-pipeline.md --out bench/reports-archive/<标签>
```
