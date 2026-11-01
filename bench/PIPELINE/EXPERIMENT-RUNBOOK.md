# 论文实验运行手册（EXPERIMENT-RUNBOOK）

> 与 [`EXPERIMENT-PIPELINE.md`](EXPERIMENT-PIPELINE.md) 的分工：
> 那份是**合同**（因子/分母/判据/红线），这份是**按顺序执行的命令清单**。
> 跑完本手册 = 论文实验章可写的全部表格 + 证据包。
>
> **顺序不可打乱**：阶段 B 与阶段 C 必须是**两次平台生命周期**（B 态带 `AW_BENCH_MODE`，
> P 态不带）。混跑会让「步长/60s/保持窗」三层在 B 态被整体豁免（缺陷 D3），P 态结论作废。

| 阶段 | 内容 | 预计 | 平台态 | 端口 |
|---|---|---|---|---|
| A | 冻结与预注册 | 5 min | — | — |
| B | E1 协议矩阵 + E2 对照 + E4 四臂 + 复现 | 50–75 min | **B 态** | 3005 / 4011 |
| C | E4 生产态五层 + E3 审批消融 | 10 min（E3 阻塞） | **P 态** | 3010（模拟器可复用 4011） |
| D | 汇总、矩阵、台账、落数 | 10 min | — | — |

---

## 0. 本机前置（一次性，约 3 min）

```bash
cd /d/codes/ABO/AgentWorkShop
node -v                                   # 需 ≥ v20
pnpm install && pnpm build                # 产物 .output/（bin/aw.mjs start 依赖）
git submodule update --init plc-node-simulator && (cd plc-node-simulator && npm install)
```

**全新环境（新机器/新克隆）额外两步**（2026-11-01 实测通过）：

```bash
pnpm install && pnpm build          # 必须有 .output；bench 的 pipeline 走 bin/aw.mjs start
git rev-parse HEAD && git status --porcelain | sha256sum   # 记录 commit + dirty 指纹
```

- **空 AW_HOME 首启是正常形态**：`needsSetup=true` → 脚本自动「首注册即 admin」。
- **模拟器影子目录必须与端口匹配**：影子私有 `data/` 里存着 broker 端口。用过 4011 的机器
  再改 `SIM_BASE=:4012` 会命中预检 `does not use the private embedded broker` 并 fail-closed
  拒绝启动。处置：保持 4011，或删掉 `../plc-node-simulator-bench` 让它按新端口重建。
  全新机器没有这个问题。
- **每一步跑完立刻把 CSV/run.json 复制到 `bench/reports-archive/<日期>-final/`**：
  `bench/results/` 是工作区，可能被外部清理（2026-11-01 实测被删 2605 个跟踪文件，
  已 `git checkout` 恢复；未跟踪的当日 run 产物需重跑）。归档目录可入库，才是真正留存的证据。

端口规划（**选定后全程不变**）：

| 端口 | 用途 | 说明 |
|---|---|---|
| 3005 | B 态平台 | 隔离 AW_HOME=`../aw-exp-home` |
| 4011 | PLC 模拟器 | 脚本自举；4010 是别人的共享 dev 实例，禁用 |
| 3010 | P 态平台 | 隔离 AW_HOME=`../aw-exp-prod-home`，**不带 bench env** |

---

## 1. 阶段 A · 冻结与预注册（5 min）

```bash
git rev-parse HEAD                            # 全量 commit
git status --porcelain | sha256sum            # dirty 指纹（有未提交改动必须记录）
(cd plc-node-simulator && git rev-parse HEAD) # 模拟器子模块 commit
```

把下列字段写进 `bench/results/<实验批次>/preregistration.json` 并算 SHA-256（**看结果前冻结**）：

- `seed_list`: `[42,43,44,45,46]`
- `conditions`: `C0,C1,C2,C3`（E2）/ `M1,M2,M3`（E3，M4=NOT-IMPLEMENTED）
- `scenes`: `injection,wwtp,anneal`（+ `castfilm` 走 P6）
- `gates`: C0 达标数必须 = 0；C1 达标数 ≥ 4/5；E1 结构探针 100% 拒绝；E4 五层 100% 拒绝
- `mde` / `alpha=0.05` / `power=0.8` / 多重比较处理
- 冻结后不得修改；结果出来后任何改动都要在报告里写「未预注册的探索性分析」。

---

## 2. 阶段 B · B 态批量（一次平台生命周期，50–75 min）

### 2.0 环境块（每个新 shell 重设）

```bash
export NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost
export AW_BASE=http://127.0.0.1:3005
export SIM_BASE=http://127.0.0.1:4011
export AW_HOME="D:/codes/ABO/aw-exp-home"
export AW_BENCH_HOME="$AW_HOME"
export AW_MODE=home
export AW_BENCH_MODE=1 AW_BENCH_ACK=1          # 双保险丝；必须在平台进程启动前存在
export AW_TRIAL_INTERVAL_MS=0
export NUXT_SESSION_PASSWORD=aw-exp-isolated-2026
```

### 2.1 静态层（1 min）——论文-代码一致性门

```bash
node bench/run.mjs --tier static --seed 42
```

- **门**：退出码 0 且 s2 = 100%。s2 < 85% → 停，先修论文/代码失真。
- 产物：`bench/results/<runId>/run.json`。

### 2.2 E1 · 场景 × 协议矩阵（约 15–20 min）

```bash
# ① 主场景 + 第二场景 + biax：P2/P3/P8/P10 的协议级证据
node bench/pipeline.mjs --profile integrated --seed 42 --cl-seeds 3
#  门：末行 PASS 且 fail=0、检查数=77；**稳定形态是 76/1/0**（唯一 warn = P10 biax-agent-cards，
#  语义卡长度 16048，非功能项，确定性复现）。P10 biax-mission-* 出现 warn 时按 §5 重跑一次。
#  P0 的 daq-sampling-ready 已于 2026-11-01 改为「采集总控可拉起」判定（采样落库由 P3 逐线断言），
#  不再随隔离 home 的残留批次时好时坏。

# ② 三个新场景的写准入探针（本手册新增执行器）
node bench/experiment/scenario-protocol-probes.mjs --scenarios injection,wwtp,anneal --seed 42
#  门：PASS —— 合法全受理（误拦分母>0）、结构探针全拒绝、回读全一致
#  产物：scenario-protocol-probes.csv/.md/run.json
```

（三场景的闭环结果不在这里跑——它就是 E2 的 C1，见 §2.3，避免同一工作重复两遍。）

- **产物**：`protocol-matrix.csv/.md`（下节 D 生成）+ `scenario-protocol-probes.csv`。
- **论文位置**：`tab:protocol-results`（扩展为 6 场景 5 协议）+ 新增探针类别拆分表。
- ⚠️ 三场景的配方窗口 == 工程量程 → 软窗探针在这三条线**退化**；软窗证据只来自 cast-film P3。
  表脚注必须写明这一点，不能把两类探针合并成「全部拦截」。

### 2.3 E2 · 闭环优化控制（约 20–40 min）

**顺序固定：先跑 C1，再用它实测的 wall time 定 C0 的观察窗**（保证同一 seed 下两条件同窗）。

```bash
# ① C1 阳性对照（脚本策略，受治理写；三场景并行）
for s in 42 43 44 45 46; do
  node bench/experiment/optimization-control.mjs --condition C1 --scenarios injection,wwtp,anneal --seed $s
done
#  门：每场景 ≥4/5 seed attained=true；从 run.json 的 wallS 记下每个 seed 的观察窗
#      （三场景并行 → wallS 是三条线里最慢的一条，作该 seed 的统一观察窗）

# ② C0 阴性对照（不写；duration = 该 seed 的 C1 wallS 向上取整，至少 60s）
#     示例：seed42 C1 wallS=31.8s → --duration 60；seed43 若 48s → --duration 60
for s in 42 43 44 45 46; do
  node bench/experiment/optimization-control.mjs --condition C0 --scenarios injection,wwtp,anneal --seed $s --duration 60
done
#  门：**C0 达标数必须 = 0**；任一场景 C0 达标 → 起点已在目标带内，E2 全部作废
#  说明：C0 按场景串行执行（同一 --duration 施加到三场景），因此它的总耗时 = 3×duration×5 seed

# ③ 可选：C2 确定性工具链（隔离工具层）
node bench/pipeline.mjs --profile integrated --seed 42 --tool-harness opencode
# ④ 可选：C3 Agent goal-loop（无 --seed，每次独立 run，不与 C1 配对）
node bench/optloop.mjs --scenarios injection,wwtp,anneal --budget 30
```

- **产物**：每个 run 一份 `optimization-control.csv/.md/run.json`；D 阶段合并成一张表。
- **论文位置**：替换 `tab:integrated-seeds`；新增 `tab:opt-control`。
- ⚠️ C0/C1 必须同 seed、同 fresh 复位；写预算以 C1 实际写次数登记，C2/C3 不得超过。

### 2.4 E4 · 治理四臂（B 态，3 min）

```bash
node bench/e1-lite.mjs --seed 42 --repeats 3
#  门：full/no-readback 6/6；no-interlock/ungated 4/6 且 windowBreach>0；falseBlock 恒 0
#  若 no-interlock 也 6/6 → 平台没带双 env，重启平台重跑
```

### 2.5 复现（5 min）

```bash
node bench/experiment/scenario-protocol-probes.mjs --scenarios injection,wwtp,anneal --seed 42 --out <第二个目录>
node bench/tools/build-protocol-matrix.mjs --pipeline <首个 pipeline runId> --replicate <第二个 pipeline runId> \
     --out bench/reports-archive/<日期>-experiment-matrix
#  门：复现一致性 PASS（判定类字段逐项一致）
node bench/compare.mjs --selftest
#  门：SELFTEST PASS（门槛有牙）
```

---

## 3. 阶段 C · P 态批量（第二次平台生命周期，10 min）

### 3.0 启动 P 态平台（**不带 bench env**）

```bash
export NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost
unset AW_BENCH_MODE AW_BENCH_ACK AW_TRIAL_INTERVAL_MS
echo "bench=[$AW_BENCH_MODE][$AW_BENCH_ACK]"        # 必须为空
export AW_BASE=http://127.0.0.1:3010
export AW_HOME="D:/codes/ABO/aw-exp-prod-home"
export AW_MODE=home NUXT_SESSION_PASSWORD=aw-exp-prod-2026
node scripts/_audit/detached-start.mjs --port 3010 --log "D:/codes/ABO/aw-exp-prod.log" --wait 120
#  门：健康门通过 + echo 为空
```

### 3.1 E4 · 生产态五层一致性（3 min，含两次 62s 等待）

```bash
node bench/experiment/production-guards.mjs --base http://127.0.0.1:3010
```

- **门**：PASS —— L2 结构量程 / L3 配方窗 / L4 单步限 / L5 60s 间隔 / L6 保持窗 各自 4xx，
  且错误码分别指向对应层；基线合法写必须 200（否则夹具不成立）。
- **产物**：`e4-defense-layers.csv/.md`。
- **论文位置**：新增「层 × 攻击」表（与 E1a 的 B 态结果分表，不合并拦截率）。

### 3.2 E3 · 审批门消融（**当前阻塞，见 §7**）

```bash
# 前置：G3（hook 移植）+ G8（模板 AW_HOME）+ G6（步长刺激）完成后才可执行
node bench/PIPELINE/run-approval-ablation-pilot.mjs preflight --run-id <RID>
node bench/PIPELINE/run-approval-ablation-pilot.mjs pilot --run-id <RID> --confirm <RID>
node bench/PIPELINE/run-approval-ablation-pilot.mjs finalize --run-id <RID>
```

- **门**：ON 臂拒绝/待决 → 驱动到达 = 0；步长刺激两臂 = 0；合法批准 = 恰好 1 次驱动 + 读回匹配；事件完整率 100%。
- 未完成前，论文**不得**出现审批消融数字。

---

## 4. 阶段 D · 汇总与落数（10 min）

```bash
# ① 状态台账（产物派生，禁止手抄）
node bench/tools/experiment-status.mjs --out bench/reports-archive/<日期>-experiment-matrix

# ② E1 矩阵（含复现比对）
node bench/tools/build-protocol-matrix.mjs --pipeline <runA> --replicate <runB> \
     --out bench/reports-archive/<日期>-experiment-matrix

# ③ 跨层总报告（原有执行卡第 5 步）
node bench/tools/build-final-report.mjs --static … --pipeline … --plc … --e1lite … --api-live-log … --out …
```

**落数纪律**：论文每个数字 → 台账里一个 block → 一个 runId → 一个 CSV 行。
脚注必须写：模拟器层级、未运行项、哪些分母来自脚本夹具。

---

## 5. 判据与失败处置

| 症状 | 处置 |
|---|---|
| E1 探针出现 `ACCEPTED` | 结构量程穿透 = 产品级缺陷，停实验修代码 |
| E1 合法写被拒 | 夹具/窗口错误，先查配方窗与开跑状态；不得改判为「误拦可接受」 |
| E2 C0 有场景达标 | 起点已在目标带 → 该场景的 E2 全部作废，先修场景起点 |
| E2 C1 达标 < 4/5 | 策略/场景问题，不得拿来做「优化有效」的证据 |
| E4 五层任一 ACCEPTED | 生产语义守卫缺失，停实验修代码 |
| `production-guards` 基线写 429 | 开跑时配方整批下发刷新了 lastWriteAt；脚本已内置 62s 前置等待，若仍出现说明节点被外部写过 |
| 复现比对 FAIL | 检查是否混了两套平台态（B/P）、是否同一 commit、是否同 seed |
| 平台启动报「发现已运行实例(pid=…) 自动停止失败」 | `taskkill` 强停会留下 `.runtime/aw.lock`，PID 可能已被系统回收给别的进程。确认端口无监听后删除该锁文件（隔离 home 安全），或改用 `aw stop` 正常收尾 |
| 探针合法笔数每次不同 | 旧版本按「当前值」过滤候选值 → 分母随现场漂移；已修为每节点固定 4 笔（3 区间内 + 1 上边界）。若仍不同，检查是否改回了旧逻辑 |
| 回读计数偶尔少 1 | 驱动瞬时读失败；已内置 3 次重试。仍失败则如实记录为空（不猜测），并在报告里注明该协议回读可用性 |
| C1 出现 `writes=0 / attained=false` | 上一轮 Agent 写留下的 open 优化记录触发**写互斥**（属主≠本次 actor，孤儿接管默认 30 分钟）。runner 已内置前置清理（判定 keep 收口），日志会打印「前置清理：收口 N 条」；若 N>0 且仍 0 写，查 mission `ev`（已进 run.json）里的拒绝原因 |
| 任何一步中断 | 保留现场与证据，不补写、不改判、不重跑到「好看」为止 |

---

## 6. 实测记录（2026-11-01 两轮）

**第一轮：流程贯通**（每场景 1 seed，验证脚本能跑出预期方向）

| 实验 | runId | 结果 |
|---|---|---|
| E2 C1 阳性对照 | `20261101043435-optcontrol-c1` | injection seed42：attained=true，PV 32.157 g（目标 32.5±0.35），写 2 次、3 轮 |
| E2 C0 阴性对照 | `20261101043329-optcontrol-c0` | injection seed42：attained=false，PV 31.236 g，写 0 次，缩痕 2.125 超限 |
| E2 同 seed 复现 | `20261101043618-optcontrol-c0` | seed42 重跑逐位一致（31.236 / 0.022 / 2.125） |
| E2 seed 独立性 | `20261101043511-optcontrol-c0` | seed43 → 31.272 / 0.015 / 2.146，与 seed42 不同 → seed 已真正下传物理复位（修复前所有 seed 同轨迹） |
| E4 P 态五层 | `20261101043749-production-guards` | L2–L6 全部按预期拒绝（见下） |

**第二轮：可复现性验证**（修掉两处会让分母漂移的实现问题后重跑）

| 检查 | 结果 |
|---|---|
| E1 三场景写探针 ×2 次 | 两次都是 **合法 100/100 · 结构 100/100 · 回读 100/100**（injection 11 节点 44/44；wwtp 7 节点 28/28；anneal 7 节点 28/28）。分母固定 = 每节点 3 区间内 + 1 上边界 |
| E1 协议覆盖 | 每场景 4 类可写协议（modbus-tcp / modbus-rtu / opcua / mqtt）；HTTP 设备全为只读检测站 |
| E2 C1 三场景 | `20261101044743-optcontrol-c1` · seed42：**三条线全部 attained=true** —— injection 32.36 g（3 写/4 轮）、wwtp DO 3.842 mg/L（12 写，五项排放全达标）、anneal 98.2 HV（8 写，抗拉 295.98、表面 0.15）；并行 wall **184.56s** |
| E2 C0 三场景 | seed42 · 60s 窗口：**三条线全部 attained=false** —— injection 31.246 g、wwtp DO 0.204 mg/L（COD 359.7 严重超标）、anneal 134.58 HV |
| E4 P 态五层 ×2 次 | 两次同序同码：L5 `WRITE_INTERVAL_NOT_ELAPSED`、L4 `STEP_LIMIT_EXCEEDED`（10℃>5℃）、L2 `NODE_RANGE_EXCEEDED`、L3 `RECIPE_LIMIT_EXCEEDED`、L6 `WRITE_FREQUENT`（剩余 118s）；基线合法写恒 200 |
| E2 C1 连跑 ×3（同线同 seed） | 修前置清理前第 3 次静默降级为 **0 写/未达标**（写互斥）；修后连跑两次 **逐位一致**：writes=2、rounds=3、PV **32.153**。另一次从前序探针状态起步得 32.32/3 写/4 轮 —— 达标结论稳定，轨迹级细节属环境类波动 |

**本轮修掉的三个可复现性缺陷**
1. 合法探针分母随「上一轮现场」变化（首跑 95 笔、重启后 77 笔）→ 改为每节点固定 4 笔，不按当前值过滤。
2. 驱动回读瞬时失败被记成「不可用」，回读分母 100→99 → 加 3 次重试；仍失败才如实记空。
3. **C1 重跑被上一轮 open 优化记录阻断**（Agent 写互斥，孤儿接管 30 分钟）→ 表现为「0 写、未达标」且 errors 为空。runner 现在前置判定收口这些记录，并给 0 写未达标的行打 `suspect=zero-writes` + 把 mission 过程写进 run.json。
4. （运维）`taskkill` 强停平台会留下 `.runtime/aw.lock`，PID 被系统回收给其他进程后，下次启动报「发现已运行实例…自动停止失败」→ 确认端口无监听后删锁文件。

**第三轮：全链路 + 流水线复现判定**

| 检查 | 结果 |
|---|---|
| 静态层 | `20261101050609-14jc`：100.0，s2（论文-代码一致性 20 锚点）= 100% |
| 集成流水线 A | `20261101055752-101k`：**76/1/0 PASS**（唯一 warn = P10 `biax-agent-cards`） |
| 集成流水线 B（同命令复跑） | `20261101062520-8yc`：**76/1/0 PASS**，同一 warn |
| 复现判定 | `compare-pipeline --a A --b B` → **REPRODUCIBLE（判定类失败 0 · 环境类 10 项仅报告）** |
| P10 双拉 warn 处置 | `20261101061150-ku8` 出现 `biax-mission-multinode` warn（75/2/0）→ 按协议重跑一次得 B；该 run 仅作非确定性披露 |
| 真实协议层 | `20261101052559-15k4`：13/13，`intercept_rate=1`、`false_block_rate=0` |
| 四臂消融 | `20261101053023-e1lite`：full/no-readback 6/6；no-interlock/ungated 4/6 且越窗执行 2；误拦 0 |
| 汇总产物 | `reports-archive/2026-11-01-perfect/`（`experiment-report.html` + `PAPER-READY-RESULTS.md` + 原始 CSV） |

**P0 `daq-sampling-ready` 语义修正（2026-11-01）**：旧实现干等 `produced` 增长，而采样受活动批次门控，
P0 时还没建线 → 结果取决于隔离 home 是否残留未闭合批次（同一命令时而 pass 时而 warn，被 compare-pipeline
判成判定类漂移，实测 76/1/0 vs 74/3/0 → NOT REPRODUCIBLE）。现改为：幂等拉起采集总控 → 断言可拉起；
采样落库由 P3 逐线断言。修正后冷启/复用两种状态都稳定 76/1/0。

> 这些是**流程贯通 + 可复现性**证据（每场景 1 seed）。论文的确认性结论仍需按阶段 B/C 跑满 5 seed × 3 场景。

---

## 7. 仍未闭合的（E3）与前置工作量

| # | 缺口 | 影响 | 工作量 |
|---|---|---|---|
| G3 | 审批旁路 hook 在 `recipe_trial`，须移植到 `dcwControlGovernedInternal` 的 `needsApproval` 分支（`dcw-tools.ts:190-224`） | 审批消融证不到论文路径 | 1–2 天 + 独立安全复核 |
| G8 | A1 `prepare` 需要模板 AW_HOME 预置配方 + 节点写授权 | 11/11 prepare 失败 | 半天 |
| G6 | 「范围内超最大步长」刺激必须在 P 态（B 态全局豁免步长限） | 第 4 类刺激无法触发 | 随 G3 |
| G7 | （可选）auto 配置 + 强制审批的 M4 格 | 无法估计审批×模式交互 | 可选 |

未闭合前，论文实验章的写法：E1/E2/E4 用实测数字，E3 明确写 `NOT-RUN` 及原因——
**不要**用 e1-lite 的四臂代替审批消融，也不要写预期方向。
