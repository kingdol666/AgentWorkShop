# PAPER-EVIDENCE-PIPELINE —— 论文证据实验执行标准

> **地位**：本文件按正式设计的 E0–E7 编号定义论文证据流程；按最新记录区分 `PARTIAL`、`PILOT_ONLY`、`NOT_RUN` 与 `NOT_IMPLEMENTED`，不能把协议工具或工程检查写成实验结果。
> **运行上下文**：本文中的 `bench/...` 完整平台/模拟器命令须在完整 AgentWorkShop 仓库中运行。本投稿包只包含 `reproducibility-tools/bench/` 下的离线协议工具，不含平台/模拟器源码或完整采集运行环境。归档结果包含 E6 探索性固定时域子集和 E7 三回合 pilot；完整多臂 E6 与跨 Harness E7 仍未完成。
> 设计依据与完整矩阵见
> [`EXPERIMENT-DESIGN-2026-11-05.md`](EXPERIMENT-DESIGN-2026-11-05.md)
> 与 [`archive/EXPERIMENT-PIPELINE-OPTIMIZED-2026-11-05.md`](archive/EXPERIMENT-PIPELINE-OPTIMIZED-2026-11-05.md)（历史缺口分析/优先级/论文写回映射）。
> 三者冲突时以 EXPERIMENT-DESIGN 的纪律条款为准；本文件只规定「怎么跑、跑到什么程度算数、产物放哪」。

## 当前证据状态（核验至 2026-11-07）

截至 2026-11-07，离线收集器和校验工具已更新；另有归档的 E6 固定时域对照子集（11 次尝试、9 对有效）和 E7 三回合模拟器 pilot（全部取消、未达目标带）。二者均不构成完整多臂/跨 Harness 研究。

| 论文问题 | 当前结论 | 下一项可执行工作 |
|---|---|---|
| Agent 是否根据反馈完成任务、Harness 是否稳健 | 主实验未启动 Agent harness；后续 episode 属探索性 pilot，现有写入链及目标达成不能独立核验 | 修复系统侧 episode 关联后，固定任务/模型/提示/权限/预算，随机化 OMP 与第二种 Harness；全部失败、零写、取消和超时保留 |
| 脚本策略的过程响应 | E6：11 对尝试中 9 对有效；9 个有效对的 ΔIAE 均为正。探索性两臂仿真比较，不支持总体优越性 | 归档的有效配对值用于有限描述；扩展到 PID/Agent、扩大样本并完成独立来源核验仍待实施 |
| 审批及防线效果 | 可支持被测软件分支的局部观察；审批为模拟/脚本决策；mock-driver 消融缺逐请求驱动账本 | 单机制审批 ON/OFF、真实操作者决策与拒绝/超时、驱动侧账本、回读不一致/不可用和 DAQ 陈旧注入分别实施 |
| Harness 稳健性与 Agent 执行 | 最新 E7 有 3 个模拟器 episode，均取消且过程值低于目标带；recorder 报告 2 writes/2 rounds each，未有 server-side journal 可核验 | E7 仅为 pilot；跨 Harness 固定任务比较和完整系统侧事件链尚未完成 |
| 版本与复现 | 旧 S6/commit/断言数描述已在复现说明中纠正；运行服务仍非 hermetic snapshot，后续 zip 曾有过期根清单 | 投稿前冻结源码、运行时、配置、原始数据和唯一 manifest；核验论文引用只指向被冻结的 S7 包 |

`experiment-status.mjs` 与正式合同采用相同编号：E2 入口/授权、E3 审批复核、E4 边界/部分执行、
E5 命令/过程证据、E6 固定时域对照、E7 Agent 执行。它将旧 C0/C1 结果排除在 E6 确认性证据之外，
并把现有 live-Agent 记录标为 `PILOT_ONLY`。这份台账是缺口检查，不是显著性、安全性或投稿资格判定。

工程集成检查使用 P0–P14 编号，与这里的论文证据 E0–E7 分开。历史 `EXPERIMENT-PIPELINE.md`
与 `EXPERIMENT-RUNBOOK.md` 保留旧 E2 C0/C1 命令，仅供追溯；不得把这些编号或方向性门槛当作现行协议。

## §1 隔离环境块（每个证据 run 的硬前置）

所有论文证据 run 必须在**同一隔离环境块**内执行（一次 shell 会话内 export 后
连续执行；换会话必须换新 AW_HOME）：

```bash
export AW_HOME='D:\tmp\aw-paper-ev-<date>'      # 全新隔离配置根,禁止复用历史根
export AW_BENCH_MODE=1                          # B 态:豁免步长限/60s间隔/保持窗
                                                # (四层准入区间不受影响——结构/窗口仍生效)
export SIM_BASE='http://127.0.0.1:4311'         # 非共享端口 → sim.mjs 自动影子目录
# 平台端口经 --base 传入,选非常用端口(如 3577);执行前 netstat 确认空闲
```

`AW_HOME` 必须先由隔离启动流程创建并传给平台进程；执行 runner shell 中设置同名变量本身
不能证明已运行的平台使用了该配置。资格预检不再自动启动服务，要求 `--base`、`SIM_BASE`、
`AW_MODE=home` 和仓库外的既有 `AW_HOME` 均显式提供。预检记录会说明目标进程配置仍是调用方声明、
未独立认证；未知服务身份时停止所有有副作用的步骤。

**禁止**：对 `:4010` 共享模拟器或 `:3001` 生产实例做任何 provisioning/写入；
`production-guards` 类生产模式检查必须用**第二个**独立实例与端口，不得复用
B 态实例切环境变量。

只读预检示例（PowerShell；此命令不创建场景、不执行写、不请求模型 completion）：

```powershell
$env:AW_MODE = 'home'
$env:AW_HOME = 'D:\tmp\aw-paper-ev-20261106-a'
$env:SIM_BASE = 'http://127.0.0.1:4311'
node bench/experiment/agent-qualify.mjs --base 'http://127.0.0.1:3577'
```

只有明确需要验证隔离孪生上的脚本建线与管理端写入冒烟时，才在命令末尾加
`--allow-mutating-smoke`。该检查不是 Agent 调用；通过只会得到
`READY_FOR_SANDBOX_PILOT`，不会得到 `QUALIFIED` 或论文结果。

## §2 run 命名与产物位置

- 每次 runner 执行产出一个 `bench/results/<YYYYMMDDHHMM>-<name>/` 目录
  （runner 自动命名），内含 report/csv/json + runner 自带的 `run.json`
  （runId、git commit、harnessHash、reproCmd）。
- 一轮论文证据收集结束后，在 `bench/results/<ts>-paper-pipeline/` 写
  **流水线汇总**：`manifest.json`（本轮全部 run 目录+各自 verdict）、
  `SHA256SUMS.txt`（对全部产物文件）、`report.md`（人读汇总，含每个块的
  判定与分母）。
- 证明文件进入论文数据包时，按 S7 现行布局复制为新的顶层目录
  （如 `03-pipeline-2026-11-05/`），打包为新版本
  `Supplementary-File-S7-data-<date>.zip`；**不覆盖**旧版本 zip。

## §3 块级执行标准与验收门

| 块 | 命令（在隔离环境块内） | 验收门（全过才 PASS） | 产物 |
|---|---|---|---|
| E1 场景×协议与窗口 | `node bench/experiment/scenario-protocol-probes.mjs --no-autostart --scenarios injection,wwtp,anneal,biax --seed 42 --window-frac 0.8 --base <专用-loopback-base>` | 合法全受理、结构全拒绝、窗口全拒绝（退化路由如实计数为跳过）、回读全一致；缺失分母不算通过 | `scenario-protocol-probes.{csv,md}` + `run.json` |
| E2 入口与授权 | **PARTIAL**：当前授权 probe 只覆盖部分分支；任务入口 vs direct 的匹配 runner **NOT_IMPLEMENTED** | 同一操作、身份、绑定和候选值分别走 task-mediated 与 direct；MCP 单列。各臂复位并比对作用节点及独立授权/驱动事件 | 每个请求的任务/身份/route/tool/治理和节点事件 |
| E3 审批与上下文复核 | **NOT_RUN（确认性）**：现有审批卡为模拟/脚本决定 | 同请求随机化批准/拒绝/超时；等待期间改变产品/配方/run 或撤销 grant；必须证明 dispatch 前重检。操作员决策另做人工研究 | 请求与审批事件、上下文快照、复核、驱动前后状态 |
| E4 边界与部分执行 | 仅运行已实现且经核对的隔离子测试；生产模式与 benchmark 模式分开进程 | 逐层单因素刺激结构边界、recipe window、step、interval、hold、授权和部分执行；driver ledger 证明是否到达驱动 | 各防线独立分母与事件关联，不合并成安全率 |
| E5 命令与过程证据 | `node bench/experiment/readback-mismatch.mjs --no-autostart --scenarios injection --base <专用-loopback-base>` | baseline 匹配、失配降级、恢复匹配三段均保留；加入回读超时/不可用、DAQ 陈旧/缺失；命令回执不能代替独立读回 | `readback-mismatch.{md,json}` + 请求、driver、readback、DAQ 原始事件 |
| E6 固定时域过程对照 | **PARTIAL / EXPLORATORY**：归档有 11 个 post-pilot 尝试，9 个有效配对；两组采样缺口记录为 invalid 且未补跑。仅比较 no-write 与确定性脚本策略 | 扩展到冻结规则、适用 PID 与真实 Agent 多臂；扩大样本并在新的正式比较前冻结样本量与分析计划 | 冻结计划、每臂完整轨迹、reset/写事件/DAQ 原始账本、来源校验和逐场景配对 IAE 报告 |
| E7 真实 Agent 与 Harness 稳健性 | **PILOT_ONLY**：最新归档含 3 个 LLM 驱动的模拟器 episode，全部 CANCELED 且低于目标带；写入计数仅为 recorder-reported | 固定任务、模型/提示/权限/预算，随机化 Harness；需要独立过程轨迹、server-side driver/journal 事件和完整跨系统关联。当前归档不含 server-side journal export | 全部 episode trace、系统事件、独立过程轨迹和汇总；所有计划 episode 保留在状态分母中 |

**通用失败语义**（继承 EXPERIMENT-DESIGN §7）：任何模块
`NOT_RUN / INVALID / CHAIN_INCOMPLETE` 必须进入论文对应句子的限定；按结果
好坏筛选场景/种子/episode = 该轮全部作废；pilot 数据不入确认样本。

## §4 完整多臂确认性方案（已报告的 E6 子集仍属探索性结果）

### E6：共同时间窗的控制比较

比较臂定义为：`C0` 无写静态保持、`C1` 冻结的确定性规则、`C2` 预先整定并冻结参数的 PID（如适用于该场景）、
`C3` 一个真实 Agent/Harness；Harness 稳健性作为额外条件时再加 `C4`，不能把不同 Harness 合并成一个 Agent 臂。
同一 scene 内使用固定目标、配方、扰动、控制约束、起点、采样间隔和 horizon `T`。每个
`scene × reset block` 的臂顺序在看结果前随机化；每臂独立复位，并由模拟器独立状态及 DAQ
新鲜样本核对初态。共享孪生有串扰风险时串行运行。初态不符、reset 不明、采样缺口或数据源过期的
试验标为 `INVALID` 并保留，不按结果方向补跑或删除。

主要过程指标预先登记为固定 `T` 内的 IAE（每个 scene 单独报告；可另报按目标容差归一化值），
以匹配 reset block 的臂间差值和区间呈现。次要指标包括在带时间比例、超调、到带时间（未达标作
删失）、写/拒绝次数和 guard violation。不得将原始不同量纲的 PV 跨场景平均。试点用于估计
方差和冻结有意义差异/样本量；正式样本数、排除规则、统计方法和停止规则在首个正式 outcome
之前注册。未完成 power 设计时只称可行性/探索结果，不称优越性。

Agent 任务的核心结果独立记录：目标是否由独立 DAQ 在固定 `T` 满足；每个动作的控制节点、值、单位
是否与任务授权和配置映射一致；错误节点/越权/越窗/未授权调用数；反馈后决策是否引用最新有效观测；
以及未调用、零写、拒绝、超时、取消、模型/Harness 错误和成本/时延。Agent 的解释、模型输出和 Harness
终端日志只能作辅助材料，不能作为成功判据。第二种 Harness 应在同一模型版本、系统/任务提示、工具
白名单、权限、预算、场景和 reset 上比较；若无法完全相同，差异逐项列出，结论限定为该配置。

Agent episode 预注册三个互不替代的任务族：**目标点选择**（同一场景提供相似名称/单位的诱饵节点，
预先登记唯一授权节点）；**观测诊断与参数选择**（注入已知的模拟过程偏差，Agent 需根据固定观测
选择正确控制点、方向、单位和值域）；**反馈后调整或停止**（首轮动作后注入回读不匹配、过程未响应
或新鲜度失效，检查是否按新观测修正或拒绝继续）。每个 case 保存隐藏的预期节点/单位/目标区间与
可接受决策集合，由不查看模型理由的独立判定器评分。逐 episode 报告：正确节点选择、值/单位在预设
容差内、固定时域目标达成、错误节点尝试与实际 dispatch、越权/越窗/guard 拒绝、反馈使用正确性，
以及零写、失败、取消、超时。被 guard 拦下的错误请求也计作 Agent 选择错误，但与实际驱动违规分开。
先运行并排除在确认性样本之外的 pilot 估算配对差异和所需样本量；随后冻结 episode 数、停止规则、
无效规则与分析代码。不得把模型回答正确、Harness 显示 `COMPLETED` 或单次脚本化写入计为任务成功。

`study.mjs` 已实现对离线轨迹的结构验证、初态/复位配对校验、固定网格和全时域覆盖检查，并对每个场景计算梯形 IAE 与 scripted-minus-no-write 配对差。它不连接平台、模拟器或 DAQ，也不能认证来源、写事件或复位实际发生。现有执行器尚不支持多臂 Agent/PID 联合采集；必须先完成采集适配、独立源验证和复核。当前归档 E6 只支持 exploratory two-arm simulation comparison；离线校验器不独立认证采集来源。旧 E2 C0/C1 CSV 和合成夹具不得作为固定时域结果。

### E2–E5：入口、治理与回读边界

将以下刺激分别登记，逐请求记录计划/尝试/到达驱动/设备状态/回读/DAQ，保持各自分母：授权绑定错误、
错误控制节点、结构边界、recipe window、step/interval/hold、批准/拒绝/超时、审批等待中上下文变更、
读回匹配/失配/超时或不可用、dispatch 后 DAQ 缺失/陈旧/超时，以及多参数中途失败。若没有 server-side
driver event，则不能仅凭 HTTP 拒绝/接受推断是否执行。模拟审批单独标注；真实操作员决策须由独立操作员
样本、预先定义任务和决策质量指标支持。所有此类模拟器结果都不能声明实体设备安全或功能安全认证。

要量化治理对**合法任务成功率**和**违规写入次数**的变化，每个拟评价的机制（例如 process-window
interlock、授权绑定检查或审批）单独做 ON/OFF matched case：保持任务、身份、初态、请求、预算、其余
防线和观察窗相同，只切换一个机制；在 block 内随机顺序并独立复位。逐臂报告合法请求成功数/尝试数、
目标违规被拒数/刺激数、违规请求到达 driver 数、错误节点实际 dispatch 数、合法请求误拒数和完整
事件链比例；给出绝对差及区间。不同机制的分母不能相加，审批 OFF 不得关闭写入分发或其他防线；
pilot 用于确定样本量，正式结果前冻结样本数与判据。当前六个 process-window 针对性请求只能说明
这六个 mock-driver case 的观察，不能推断整体成功率或现场安全收益。

## §5 与论文的对应关系

以下 `sections/` 与 `Supplementary-File-S7.tex` 写回路径指向完整
AgentWorkShop 仓库；本整理包中的对应文件位于
`manuscript/sections/evaluation.tex` 和 `manuscript/Supplementary-File-S7.tex`。
执行完成后，按
[`archive/EXPERIMENT-PIPELINE-OPTIMIZED-2026-11-05.md` §5](archive/EXPERIMENT-PIPELINE-OPTIMIZED-2026-11-05.md)
的**论文写回映射**逐句替换 `sections/evaluation.tex` 与摘要中的对应数字与
限定语；阴性分支的措辞同样已在该表给出。写回后必须同步更新
`Supplementary-File-S7.tex` 的对应小节并重打包数据 zip。

## §6 状态派生

禁止手写「已验证」状态；轮次结束后用
`node bench/tools/experiment-status.mjs` 从产物重新生成状态表。任何只有文字
没有对应 `bench/results/<runId>/` 产物的声明，状态一律 `NOT_VERIFIED`。

收集器 `node bench/tools/collect-paper-evidence.mjs --runs <目录列表> --out <新目录>`
会保留预检的 `READY_FOR_SANDBOX_PILOT` 状态，在总清单中标记
`containsPreflight=true`，且不允许它使 `allPass` 成立；不能把旧格式 `QUALIFIED` 或新的
sandbox 预检状态当作 Agent 任务或闭环结果。收集器只汇总运行状态/文件 hash，不判定
论文证据资格。输出目录必须是新目录，且失败/未完成记录不可移出本轮。
收集器必须接收显式 `--out`；输出目录必须不存在、与任一输入目录不重叠，输入目录 basename 必须唯一。
它会先完整遍历、解析清单并计算所有哈希，拒绝符号链接、非普通文件及读取/解析错误，再将完整 bundle
原子发布到输出路径；失败时不留下部分 manifest。`containsPreflight` 是机器清单字段；不要使用旧名
`paperEvidenceEligible` 推断论文资格。远程模型清单请求须通过 `--allow-remote-model-inventory` 显式授权，
仅进行 model inventory，不发 completion 请求。

## §7 投稿前版本冻结门

1. 先冻结一个完整源码 commit；保存主仓库及子模块 commit、dirty/diff、依赖锁文件、构建产物或
   容器 digest、场景/映射/策略配置哈希、runner 哈希、运行平台/模拟器身份与进程启动配置。若服务
   已运行但无法把进程绑定到冻结源码，记录为 `runtime-source-unverified`，不能写成同版本复现。
2. 固定本轮 registration/analysis plan 和所有原始事件后生成只读 manifest。任何缺少、未收集、
   失败或 invalid 的 episode 都列在分母清单中；不以压缩包成功、哈希通过或 77 项 software checks
   推断 Agent 成功、过程控制有效或现场安全。
3. 投稿包只引用一个已核验的 S7 数据包版本及其 root manifest/SHA-256。同步检查 `main.tex`、
    `Supplementary-File-S7.tex`、`README.md`、`REPRODUCIBILITY.md`、`manifest.json` 和实际 zip
   内部文件名/摘要。排除 `.zip.new`、旧版重复包和 stale manifest；修订后在同一冻结版本重编并再验。
4. manifest 的 hash basis 必须与实际生成输入一致（Git index 或 working tree 只能选一种并写明）。
   若论文、图片或补充材料仍有未提交变更，manifest 只能作为工作区快照，不得称为提交冻结清单。
 5. 本目录是当前工作区快照；在此处用 `tools/build-paper.ps1`、审计脚本和 `manifest.json`
    核对稿件。若需声明冻结 Git 修订版，须在完整仓库的干净提交上重新打包并生成提交级清单；本包不含
    仓库级 `pack-source-package.py`。正式提交前须重编主稿与 S7 PDF，并核对其与 TeX/资源一致。
