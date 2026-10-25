# 2026-10-24 论文证据与系统一致性审查

[OBJECTIVE] 审查当前 `SUBMISSION-IEEE-TII` 论文的实验前故事线、真实实现对应关系、实验结果与图源、最近复测的解释范围。此次为独立只读审查，未修改论文、代码、原始结果或图。

[DATA] 目标由 `SUBMISSION-IEEE-TII/README.md` 确认：当前源稿为 2026-10-20 component-architecture/evidence-lifecycle revision，文件于 2026-10-21更新；现有 `final-revision-2026-10-20` 为历史交付和核验记录。审读 `main.tex`、全部六个章节、`results-macros.tex`、`CLAIM-EVIDENCE-LEDGER.md`、`REPRODUCIBILITY.md`、实验图生成源；核对历史 R1/R2/R3/R4/R6 档案和 2026-10-23 两个新增失败档案；抽查当前优化工具与调度实现。

审查方式：native delegated 的证据审查子任务；本报告为一个审查者的判断，不称独立专家组共识。`[Shell check]` 表示本次确实运行的 PowerShell JSON/CSV 分组、计数、哈希检查；`[LLM]` 表示对原文与实现的人工语义判断。未运行 canonical `paper-audit` Python 检查脚本：本子任务没有 python_repl 工具，且 scientist 角色限制不允许通过 shell 执行 Python。排版、PDF逐页视觉、外部文献/IEEE规则核实由其他审查任务负责，本报告不代替它们。

## 结论与修复优先级

[FINDING][LLM] 论文已有清晰且基本自洽的主线：注塑需求示例 → 跨引擎、协议和生产上下文的共同执行契约 → 身份/权限/准入/审批 → 分级回执 → 观察与留存。能支持的结论是“被测路径上的执行与证据关联”，不是优化算法优越性、人工监督收益或物理安全保证。
[STAT:n] 阅读范围为完整 6 个章节；Q4 是每过程 1 条轨迹，Q6 主图是 1 条轨迹、4 次顺序压力干预。

**需要本轮修复：**

1. 将 10/23 最新失败复测作为边界事实明确记录，不能把10/18成功结果称为最新系统的成功复现。
2. 对“65 current tests pass”重新执行明确的隔离测试，或把表述限定为10/20归档通过结果。
3. 当前新增 `optimizer_*` 工具应在策略/模型段以一句话补充；它只提供建议，不能在架构图中形成绕开治理的设备写路径。
4. Q1 的延迟统计是六次请求的上中位排序值，不是通常的两个中间值算术平均；建议正文写“archived upper-median latencies”，复现说明给出排序定义。

**投稿研究强度风险（不能靠文案或重绘解决）：**没有完整当前版本 `optimization_explore` 请求→审批→设备确认→过程响应实验，没有匹配初始条件的策略/系统对照，没有独立物理过程样本。主张已经有所克制，不能因此保证 IEEE TII 学术接收。

## 实验前故事线与实现对应

### S1. 引言和机制的论证已闭合，但贡献不应扩大

[FINDING][LLM] `introduction.tex:13–28` 用注塑克重说明请求、设备确认和质量反馈的区别，再提出共同契约问题；`:30–55` 的四项贡献在系统/机制章节均有承接。`system.tex:15–20` 将任务、生产对象、执行记录分开，是最适合图一承担的概念。`mechanisms.tex` 的准入、审批、回执、观察顺序与实验Q1/Q5/Q6能够对应。
[STAT:n] 四项贡献；现有实验包含四协议写入、四过程任务和一条配方主轨迹。

允许措辞：inspectable execution / evidence linkage / route-specific evidence / configuration-based reuse。
不允许据此升级为：safe autonomous optimization / general industrial optimization superiority / proven human oversight effectiveness。

### S2. 新优化器建议工具缺少一句最新实现描述

[FINDING][LLM, moderate] `system.tex:119–126` 以模型绑定、资格和“trained model / candidate / command”区分结束，适合补入当前新增建议服务。`server/services/workshop/agents/industrial/optimizer-tools.ts:3–6,69,87–101,176` 明确 `optimizer_solve` 只返回建议/首步与状态、能力/资格信息，不授予写权限；`host-tool-bridge/optimizer-gate.ts:23–46` 则限制 channel profile 和 binding。原文没有否定这些工具，属于最新架构覆盖不足，不是既有实验数据错误。
[STAT:n] 当前工具族5个入口；0个设备写授权由该工具族直接产生。

建议句："A separately bound optimizer service returns versioned recommendations and their eligibility/state evidence; the recommendation grants no actuation authority and must enter the same governed execution route."

图一建议：只用“Analysis / models / recommendations”合并成策略支持块，不罗列五个工具；建议箭头进入共同治理入口。

### S3. 两条运行生命周期的区别必须保留

[FINDING][LLM] `system.tex:128–147` 与 `optimization-tools.ts:78–133` 一致：先捕获 controlBefore，调用内部治理写入，成功后等待并查询 targetAfter，最后另存 exploration summary；失败不采样 post-write target。配方试验返回 batch/per-parameter receipt 后由调用者观察；保存新配方必须单独 `recipe_update`。R6中 optimization journal 为空正是配方生命周期，不应画成缺失记录错误。
[STAT:n] 两条生命周期；R6四条trial回执、一次recipe update，零node-optimization journal条目。

图二应精简成两个对应泳道，明确 node journal 与 exploration summary 的时间区别，以及 recipe update 是观察接受后的独立动作。拒绝/审批过期分支不能画成设备已执行。

## 数字与图源核验

| 论文锚点 | 本次核验的事实 | 数据单位与允许解释 |
|---|---|---|
| Q1 / `evaluation.tex:62–68` | `[Shell check]` R1 P3 的DAQ样本8+11+11+12+13=55；四写协议各6/6拒绝，总计24/24；RTU无写延迟/攻击分母 | 五协议采集、四协议写；不是五协议全写闭环 |
| Q1 / ablation表 | `[Shell check]` R2 CSV按case=attack分组：full拒绝18，no-readback拒绝18；no-interlock拒绝12/执行6；ungated拒绝12/执行6 | 每arm 6类×3次确定性重复；不视作18个独立生产批次 |
| Q1 / delay | R1 metrics四协议p50=47.807/19.806/19.256/32.947 ms；p95=248.948/20.508/20.112/44.599 ms | 每协议6次。同一目标重复请求，报告API级延迟；不估计人口尾部时延 |
| Q2 / engine | R1摘要有两live engine任务；51.7 μm终值与日志52.02 μm窗口均值被正文明确分开 | 两任务，不是模型性能比较 |
| Q3 / objective | R1三seed的J0=68.740/66.212/66.694，Jend=86.792/87.158/87.341，J*=89.894，ratio=.965/.970/.972；六次写零拒绝 | 三seed、同一软件过程、受限离散网格归一化；不能称全局最优 |
| Q4 / mission | R1四过程最终目标均满足；注塑32.17g仅比下界高.02g，BOPET25.66μm仅比上界低.04μm；WWTP回退及pH变差、退火101.3HV失败尝试均保留 | 每过程1轨迹；控制变化为请求意图，不能当连续设备响应曲线 |
| Q5 / campaign | `[Shell check]` 九个10/7–10/9 JSON的checks数组依次79/79/79/91/92/90/92/90/90，总计782；各score.passed与checks数相等，pass=false为0 | 237+273+272；9次顺序软件suite，非782个过程样本 |
| Q5 / timeline | 原始JSONL的S4 03:38:11.128→03:39:47.233=96.105s；cadence 03:38:13.137→03:39:22.151=69.014s；S5 wait→verdict=66.046s；converged=false | 一次时间线，脚本审批；set/device/mirror一致不证明质量收敛 |
| Q6 / 主图 | R6 baseline45bar/6s、31.28g；四trial到50/55/60/65bar，重量31.49/31.74/32.05/32.30g；final sink1.277%、flash.019%；v2保存65bar/6s | n=1，5个顺序snapshot，4次trial receipt 1/1；没有独立置信区间 |

[FINDING][Shell check] 目前三个实验图使用的原始文件均与10/20 source-data manifest SHA-256一致：R6 `summary.json`、R1 `scenarios.json`、Q5 `timeline.jsonl`。本次没有为使结果正面而修改数字。
[STAT:n] 3/3原始图源哈希匹配；九suite共782条check；ablation72条攻击记录。

### E1. Q1 median定义应澄清（minor）

[FINDING][LLM] `evaluation.tex:57–58,64` 用“median”，而 `bench/lib/metrics.mjs:8–14` 的q=.5返回 `sortedAsc[n >> 1]`。`bench/pipeline.mjs:232–268` 确定WRITES=6，因此该值是第四个排序样本，即上中位数。nearest-rank q=.95返回第六个样本，正文将它解释为observed maximum是正确的。
[STAT:n] 每协议n=6；四写协议。

建议：正文“Archived upper-median write latencies ranged …; the observed maxima …”。复现说明明确返回排序第`floor(n/2)+1`项；不重算不存在于档案的原始逐请求延迟。

### E2. 65条“当前测试”表述具有时间歧义（moderate）

[FINDING][LLM] `evaluation.tex:23–25` 的“65 current ... tests pass”依据是10/20 `qa/verifier-software-tests.json`；本次仓库已有多个相关runtime未提交修改，不能把历史结果当10/24新执行通过。此问题可通过最新隔离运行解决；如果不执行则日期限定即可。
[STAT:n] 归档8个suite，65通过，0失败；本子任务本次未运行这8个suite。

原归档命令列表：`high-risk-tool-scope`, `tool-profile-observer`, `recipe-propose`, `manual-approval-optimization`, `recipe-approval-snapshot`, `manual-approval`, `tool-approvals-choice`, `recipe-op-interval`。运行使用node+tsx、`.nuxt/tsconfig.server.json`、`--test --test-force-exit`。

允许替代句："Separately, the archived October 20 isolated regression recorded 65 passing channel/profile and composition checks with temporary storage and mock I/O."

## 最新10/23复测：不得作为成功复现

### E3. 历史直接节点脚本在新接口被拒（moderate；最新性必须交代）

[FINDING][LLM] `bench/results/20261023151709-1pjk/scenarios-benchmark.md` 的总判定FAIL，注塑任务COMPLETED却没有任何实际写入；八次direct-node候选均被“直接节点写控已禁用”拒绝，weight停在31.25g，attained=false。这是旧harness与当前公开接口的契约边界，不推翻历史R1数据，也不能算最新优化成功。
[STAT:n] 1场景、8次拒绝、0写入，n=1失败复测。

建议在复现记录或实验边界写："An October 23 replay of the historical direct-node harness was refused on all eight attempts by the current public interface (zero writes), confirming that the historical script is not a current-route replay."

### E4. 当前配方路径只有第一步成功，后续被节拍拒绝（major if concealed / moderate if disclosed）

[FINDING][LLM] `bench/results/injection-pressure-loop-2026-10-23T15-25-20-318Z/summary.json`：P3-1 45→50bar成功、回执1/1；P3-2尝试55bar在66s时被300s节拍拒绝；P4 hold-time fallback在132s仍被节拍拒绝；finalOk=false、update=null。最终31.46g低于32.15g下界，sink1.837%高于1.5%限值；P6恢复基线检查也false、平台压力仍50bar。它没有构成一次成功的目标达成或恢复。
[STAT:n] n=1；1次verified压力trial，至少2次后续节拍拒绝；0次recipe update；4/8检查通过、4/8失败。

适合正文的紧凑句："A later October 23 recipe-path check verified the first 45-to-50-bar trial but refused the next requests at 66 and 132 s under the default 300-s cadence; weight remained 31.46 g and no recipe update was saved. This boundary check is not a repetition of the accelerated October 18 trajectory."

若正文提恢复，应说“the archived restoration assertion also failed”，不能写“baseline restored”。完整细节留复现说明即可。不能通过设置实验节拍重跑来覆盖归档失败事实；若新实验需另外编号、完整记录和正确区分。

## 图表是否足以承担论据

[FINDING][LLM] 现有实验绘图的语义设计合理：u/y配对；目标窗与有限sample明确；WWTP不把pH/TP拼成DO；回退候选明确；退火99.84与终点100.08分开；Q6全部5快照使用且不用无来源的update-rationale数值。图源未加入不存在的置信带、设备连续波形或独立重复。
[STAT:n] Q4四过程×一轨迹；Q6五快照、四回执；Q5一事件时间线。

图生成脚本 `make-evaluation-2026.py:mission_data()` 对归档文字恢复的补偿动作已在source-data中标为“rollback stated; no separate raw receipt”，适合控制意图显示，但图注必须保留requested / event index / snapshots。不能把step连线当物理时间。现稿caption已满足该语义要求。

建议保留三张实验图，不为追求正面性删去近边界值、失败候选、converged=false或缺失温度说明。图一、图二重绘只解释组件与生命周期，不可绘制支持数据中不存在的完整模型驱动生产闭环。

## 保留的限制与后续研究边界

[LIMITATION] 所有过程为软件模拟器；实时协议与live LLM任务不是物理工厂试验。审批由脚本提供，不能估计人的理解、干预收益或失误率。

[LIMITATION] 历史R1–R5与当前公开工具面不同；R6只有一条加速节拍配方轨迹。当前 `optimization_explore` 完整过程E2E未归档；当前新optimizer建议链也没有本文实验。不能把新功能和旧结果合成一个跨版本完整验证。

[LIMITATION] Q6 melt缺失、freshness用各传感器最大时间戳，已由正文与复现说明忠实披露；最终snapshot和配方更新理由的质量值不一致，主图正确采用`/final`。该事实不应通过改原始摘要“修复”。

[LIMITATION] Q3只有三seed；Q4/Q6均n=1，无法由档案产生可信总体置信区间或优越性检验。没有匹配初始条件SCADA/固定策略对照；这是研究证据边界，不是加一张漂亮图可解决的问题。

[LIMITATION] 本报告不声明新PDF页数、字体、图像印刷分辨率、官方TII格式合规、文献引文事实全部通过；这些需要对应编译/视觉/官方来源任务的独立证据。

完成条件建议：前述E2–E4在论文或复现说明有明确处置、S2最新建议服务描述补全、E1统计定义澄清；保持证据边界后，可给出“内部证据与声明一致，技术排版经独立检查”的结论，不能给“已保证TII接收/所有系统实证问题已解决”的结论。
