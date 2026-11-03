# 实验结果复核与论文一致性评估(2026-11-03)

> 对象:`bench/PIPELINE/EXPERIMENT-PIPELINE.md` 合同 + 2026-11-01 最终批次
> (`bench/reports-archive/2026-11-01-perfect/`)+ 论文
> `_paper-archive-2026-11-02/source-package-current-2026-10-31-v4/sections/evaluation.tex`。
>
> 本轮只做**复核与补测**,不改产品代码;所有数字从产物重算(`reconciliation.json`)。
> 设备层仍是模拟器;没有物理产线。

## 0. 结论

1. **E1 / E2 / E4 已达到论文可写级,且本轮跨 run 对账全部通过**:244/244 合法受理、243/243 结构越界拒绝、236/236 回读;C0 **0/15** vs C1 **15/15**;P 态五层 L2–L6 各自拒绝、基线合法写 200。
2. **E3 仍不完整**:只有配置级 manual vs auto 对照;**单机制 OFF 臂(A1 pilot)本轮尝试执行,但被本机 Docker 环境阻断**——无法在本机产出符合合同(`--network none`)的证据,不伪造、不降级为 warn。
3. **E5(可选)未实现**;C3(LLM Agent 多轮)2026-11-02 pilot 为**负结果**(0 写/超时),不能写入论文阳性结果。
4. **论文的表述清楚、边界诚实,但评估章节落后于最终批次**:论文仍写 2026-10-29 单次集成 run(76/77、24 探针),未包含 2026-11-01 的 77/0/0×2、E1 矩阵、C0/C1、E4 消融与 E3 配置级结果。按 TII 审稿强度,这一节需要整体换数后才匹配系统现有证据。

## 1. 逐块状态(以产物为准)

| 块 | 合同要求 | 当前证据 | 判定 |
|---|---|---|---|
| **E1** 场景×协议 | 6 场景 × 5 协议;合法语料 k/k、结构/软窗/极端探针 100% 拒绝、回读 | 最终批次 + 两个 probes run:5 场景写准入 + film-line;**合法+边界 244/244、结构 243/243、回读 236/236**;film-line 9/9 | **EVIDENCE**(矩阵产物仍分 run,见 §3) |
| **E2** 优化对照 | C0 阴性 / C1 阳性;5 seed × 3 场景;同预算 | C0 **0/15**、C1 **15/15**;cast-film J_end/J* 0.961–0.983;C0 同 seed 逐位复现 | **EVIDENCE**;C2 单线、C3 负结果另述 |
| **E3** 审批门 | M1/M2 单机制消融(3 类刺激×5 对);M4 声明 NOT-IMPLEMENTED | 配置级 manual vs auto 4 调用(批准 202→204.8 / 拒绝 216→216 / auto 执行);**单机制 OFF 臂 NOT-RUN** | **PARTIAL** |
| **E4** 防御纵深 | 四臂 + P 态 L4/L5/L6 + L1 授权 | 四臂:full 100%、no-readback 100%、no-interlock 66.7%、ungated 66.7%,误拦 0/9;P 态 L2–L6 各自拒绝、基线 200;L1 三用例(未绑定拒/绑定放行/跨节点拒) | **EVIDENCE** |
| **E5** Harness×模型 | 可选;先资格检查 | 无 | **NOT-IMPLEMENTED** |

## 2. 本轮跨 run 对账(全部通过)

来源:
- `bench/results/20261101121221-scenario-probes/scenario-protocol-probes.csv`(injection/wwtp/anneal/biax)
- `bench/results/20261101121700-scenario-probes/scenario-protocol-probes.csv`(cast-film)
- `bench/reports-archive/2026-11-01-perfect/protocol-matrix.csv`(film-line)

| 场景 | 合法+边界受理 | 结构越界拒绝 | 回读 | 恢复写 | 协议 |
|---|---|---|---|---|---|
| injection | 44 | 44 | 44 | 11 | modbus-tcp/rtu/opcua/mqtt |
| wwtp | 28 | 28 | 28 | 7 | modbus-tcp/rtu/opcua/mqtt |
| anneal | 28 | 28 | 28 | 6 | modbus-tcp/rtu/opcua/mqtt |
| biax | 120 | 119 | 116 | 30 | modbus-tcp/rtu/opcua/http |
| cast-film | 24 | 24 | 20 | 6 | modbus-tcp/opcua/mqtt/http |
| **合计** | **244/244** | **243/243** | **236/236** | 60 | 5 类 |
| film-line | — | **9/9** | — | — | 5 类 |

对账脚本:`reconcile-experiments.mjs`(产物 `reconciliation.json/.md`);共 14 项断言全部通过,包括 E4 四臂复算:full 18/18、no-readback 18/18、no-interlock 12/18+6 执行、ungated 12/18+6 执行,每臂合法语料 9/9(误拦 0)。

## 3. 仍然不完整/不可写的项

### 3.1 E3 单机制 OFF 臂(本轮尝试,环境阻断)

- 已准备:A1 pilot 的模板 AW_HOME(由 2026-11-01 批次注入线克隆,line `ln-3856f218` / recipe `rc-a17659b1` / node `dw-b32cd27a`,修正 `controlMode=manual` 与 `simSceneId=injection`)、15 对 block、seed 42、`--network none` Docker 隔离。
- 阻断 1:Docker Hub 不可达;已用国内镜像 `docker.m.daocloud.io/library/node:23-bookworm-slim` 拉到本地并打回 `node:23-bookworm-slim`。
- 阻断 2:镜像构建(`pnpm install` + `pnpm build` + 模拟器依赖)期间 **Docker Desktop 引擎返回 500/无响应**;为保证你已有的 `awshop-daq-timescale/minio/mosquitto` 与 `pps-*` 容器不中断,已终止构建、重启 Docker Desktop,并恢复全部容器(现均 Up)。
- 结论:**E3 单机制消融在本机不可安全完成**。需要在 Linux 主机或资源充足、可访问镜像仓库的 Docker 环境重跑:
  ```bash
  node bench/PIPELINE/run-approval-ablation-pilot.mjs prepare --template-home <stopped AW_HOME> \
    --actor-id <agent> --line-id <line> --recipe-id <recipe> --node-id <node> \
    --sim-device-id inj-inject-opcua --sim-signal-id hold-pressure-sp \
    --legal-value 50 --control-value 60 --sim-base http://127.0.0.1:4012 --aw-port 3392
  # 然后 preflight → pilot --confirm <RID> → finalize
  ```
- 未运行前,论文不得出现“审批门单机制拦截率”或“审批×模式交互”。

### 3.2 C3(LLM Agent 多轮)

2026-11-02 pilot 4 次:最好一次 15 min 内完成取证但 **0 次受治理写入**(PV 31.23 g 未入带,BUDGET_TIMEOUT);另一次 0 写被隐式 COMPLETED。平台侧阻塞:lead 队列续消费、task parts 与 omp artifact 协议、goal 收口校验。**只能作为负结果/可行性 pilot**,不能作为“Agent 自主优化有效”的证据。

### 3.3 E5(可选)

未实现。若 TII 版面允许,先跑 omp/opencode × Qwen/DeepSeek 四组合的资格检查;否则列入 future work。

## 4. 论文评估章节审阅

对象:`source-package-current-2026-10-31-v4`(最新 `evaluation.tex`,2026-10-31;归档中无更新版本)。

### 4.1 表述与逻辑:清楚、克制、无夸大

- 结构:Run Design → Protocol Acquisition/Guards → Fixed-Seed Objective → Scripted BOPET → Evidence Boundary;每节先给条件与分母,再给观察,再给边界。
- 明确写了“one integrated execution”“not independent repetitions”“no conventional controller baseline”“language-model loop disabled”“no physical equipment”;没有把单次 run 说成重复实验,没有把模拟器结果说成现场性能。
- 表格口径(76/77、54 样本、24/24 探针、96.3–98.8%、24.84 µm)与 Supplementary 的 run 记录一致;逻辑上没有跳跃。

### 4.2 与最终批次不一致(需要换数)

| 论文现值(2026-10-29 run) | 最终批次(2026-11-01) | 影响 |
|---|---|---|
| 76/77 checks、1 warn | **77/0/0 ×2,REPRODUCIBLE** | 功能覆盖与复现性被低估 |
| 24 探针(cast-film)+ 9(film-line) | **E1 244/244 受理、243/243 拒绝、236/236 回读**;5 场景 + film-line | “多场景多协议”证据量级完全不同 |
| 3 个固定 seed,J_end/J* 96.3–98.8% | 保留;另有 C0 **0/15** vs C1 **15/15**(3 场景×5 seed) | 论文说“无控制器基线”——C0 就是阴性对照,可支撑“优化有效”的受控比较(描述性) |
| 无消融 | E4 四臂 + P 态 L2–L6 + L1 授权 | 拦截机制的因果归因可写 |
| 无审批对照 | E3 配置级 manual vs auto(4 调用) | 可写配置级差异;单机制仍 NOT-RUN |
| 无 C3/E5 | C3 负结果、E5 未实现 | 必须在 limitations/future work 明写 |

### 4.3 具体修改建议(按优先级)

1. **替换评估主表**:用 2026-11-01 批次重写 §Run Design 与 §Protocol;主表改为 E1 矩阵(场景×协议×受理/拒绝/回读),脚注写明合法语料分母与模拟器层级。
2. **新增优化对照表**:C0 0/15 vs C1 15/15(5 seed×3 场景),明确“脚本策略 vs 不写”的阴性对照;不要把它写成统计显著或真实产线收益。
3. **新增消融表**:E4 四臂(注意 `ungated` 不是授权门、B 态 `full` 不是生产 full)+ P 态 L2–L6 分表;L1 授权三用例单列。
4. **审批门**:只写配置级 manual vs auto 与 4 次调用;单机制 OFF 臂标 `NOT-RUN(environment-blocked)`,并说明 Docker `--network none` 隔离要求。
5. **Limitations 明写**:C3 负结果、E5 未实现、单次/模拟器/无物理设备、E3 单机制缺项。
6. **摘要换数**:76/77 → 77/0/0 ×2;24 探针 → 244/244 受理 + 243/243 拒绝;保留“不主张自主 agent/现场性能”的边界句。

## 5. 判定

- **实验层面**:E1/E2/E4 **完成且可复算**;E3 **部分完成**,单机制臂被本机 Docker 环境阻断;E5 可选未实现;C3 负结果。按合同“全部完成”口径,**尚缺 E3 单机制臂一项**,其余缺项均有明确 NOT-RUN/NOT-IMPLEMENTED 标记。
- **论文层面**:表述清楚、逻辑自洽、边界诚实;但**评估章节落后一个批次**,没有把系统现有的受控证据展示出来。建议按 §4.3 换数后再投稿;否则审稿人会按“单次 run、无基线”给出 Major Revision。
- **诚实边界**:本轮未完成 E3;未改产品代码;设备层为模拟器;Docker 环境已恢复,容器均在运行。
