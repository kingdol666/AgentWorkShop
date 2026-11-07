# 面向论文主张的实验设计与执行合同

> **Status addendum (2026-11-07):** This is the preregistered design snapshot, not a current status report. A later E6 exploratory run archived 11 post-pilot paired attempts (9 valid; 2 invalid due to C0 sampling gaps) for the no-write versus deterministic scripted policy comparison. A separate E7 pilot archived three canceled, below-band simulator episodes. Neither record completes the originally planned multi-arm E6 or cross-Harness E7 study. See `REPRODUCIBILITY.md` and `S7-e6-e7-2026-11-07.zip` for the data and limits.

> 本设计中的完整 `bench/...` 执行命令和 `sections/...` 源码路径面向完整 AgentWorkShop 仓库。当前投稿包中的 LaTeX 位于 `manuscript/`，只包含部分离线协议工具；真实 Agent/模拟器采集适配器与确认性 E6/E7 运行尚未实现或执行。

**状态：方案与实施清单，不是实验结果。** 本文件依据当前论文、现有 runner 和
归档数据制定；除明确标为“已有记录”的内容外，下面的测试均未证明已经执行。
任何模拟器结果都不能写成实体工厂结果、安全认证或人因有效性。正式收集前须冻结
运行协议、候选版本和分析计划；确认过的限制不得在结果不好时临时改变。

## 1. 当前证据与应解决的问题

论文 `sections/evaluation.tex` 与 `Supplementary-File-S7.pdf` 记录了四场景映射探针、
单场景 mock 驱动窗口消融、审批/授权分支、三场景脚本终点比较、一次后续注塑孪生
pilot、两次未发出受治理写入的 live-Agent episode。November 1 清单标记平台
`da627d21`，但运行服务没有完整不可变快照；后续源码增加的 identifiability
和模型/本体交叉检查不能反推为该批实验已执行。

旧 `bench/experiment/optimization-control.mjs` 的 `--duration` 只作用于 C0，C1
使用不同场景的任务逻辑及终止点；历史 seed 42 的两个 C0 还存在残留初态。
因此旧 C0/C1 是描述性记录，不能作为等时、同状态干预效应。该脚本旧报告中
“C0 必须 0/N、C1 必须至少 4/5”的结果门槛不得用于选择或排除数据：对照组自然
进带或脚本效果不佳都是需要报告的结果。质量门只能检查协议执行和数据完整性。

`bench/dual-entry-e2.mjs` 的双入口是 **REST 与 MCP stdio**，不是论文中的
**task-mediated 与 direct**；它使用不同候选值并顺序执行，现状不能证明匹配的
入口等价。脚本工具调用或 mock 调度也不能当作真实 Agent 完成任务的证据。

## 2. 假设、实验单位和证据矩阵

每个结果都标注其实际路径、模式、场景、试验单位和分母；技术重复不能冒充
独立产线。计划中的矩阵如下，具体可用脚本仅表明已有部分夹具，**并不表示完成了
该矩阵**。

| 模块 / 论文对应 | 实验刺激与观察 | 单位 / 关键判断 | 当前基础 / 需要补齐 |
|---|---|---|---|
| E0：运行资格与追溯 | 核对隔离环境、源码及运行进程、配置、服务和时钟，冻结样本清单 | 一次运行；每项可验证，缺失则该项 `NOT_ASSESSED` | 历史清单不含服务快照；需固化可验证的进程构建 ID、配置及采样约定 |
| E1：场景及方向映射 | 对每个实际可用的 scene × protocol × node，记录控制点、采集点、单位、地址、合法边界和越界请求；用独立设备寄存器/模拟器状态核对 | 单个请求；列出计划与收集分母、不可回读情况、映射不符和漏采 | `scenario-protocol-probes.mjs` 有探针；需独立映射 oracle、完整矩阵与可检查的原始路径 |
| E2：入口与授权 | 针对同一命名操作、同一绑定、候选和身份，分别测试任务入口、direct REST；MCP 作为额外入口单列。每臂恢复相同状态，覆盖允许、未绑定、跨节点、无 grant 等 | 一个请求；比较判定、作用对象及可核验事件；缺事件不推断共享 handler | `authorization-probe.mjs` 提供部分工具调用；`dual-entry-e2.mjs` 仅是 REST/MCP 非匹配诊断。任务入口匹配夹具和事件关联**待实现** |
| E3：审批、上下文复核 | 对 node 和 recipe 路径分别测试无需审批、批准、拒绝、超时；在等待审批时分别改变 run/product/recipe、撤销绑定/grant、修改配方定义 | 一个请求；逐项报告复核内容、时序、受影响参数是否到驱动。拒绝/超时为合理结果 | `approval-gate.mjs` 有模拟审批夹具；其历史两臂并非同请求匹配。精确暂停点与变更注入、trace 需实现 |
| E4：边界与部分执行 | 逐层仅改变一个因素：工程/基线/产品/配方窗、试验 override、step、interval、hold；覆盖 benchmark 与非 benchmark、实际写入 source；另做多参数中途失败 | 一次单参数请求或一次明确的批次；分别记录各参数是否下发、结果和设备状态；无原子或自动回滚假设 | `production-guards.mjs`、`e1-lite.mjs` 有部分探针；source × mode × route、部分成功可控注入待补齐 |
| E5：命令与过程证据 | 注入成功/拒绝、设备回读匹配/不匹配/超时、DAQ 缺失/延迟/陈旧样本；分别观测回执、设备回读、独立工艺采样 | 单次请求和其时间戳样本；回执、回读、DAQ 不互相替代，确认样本在实际 dispatch 后 | 当前 guard 消融未注入 readback mismatch；独立读回、故障注入、时钟关联与原始序列待补齐 |
| E6：固定时域过程对照 | 每场景同一初态、扰动、目标、采样和固定时域，对照 no-write 与预先冻结的规则基线；预算与记录方式相同 | 试验单位为 scene × seed × 独立复位 block；报告每对完整轨迹和差值 | 旧 C0/C1 不符合条件；需要支持固定时域、真实初态核验及轨迹的 runner，**现有脚本不可直接当 E6** |
| E7：真实 Agent 可行性 | 真实 harness 通过任务发起操作，保存模型、任务、工具调用、审批、驱动和 DAQ；固定预算，包含失败/超时/零写 | episode；链条每个条件均有系统侧证据才算完成 | `agent-multiround.mjs`、`optloop.mjs` 为候选，不能将脚本策略当 Agent；可配对初态和完整系统侧关联尚需核验 |

论文核心是上下文、写入边界和分离的证据。E1–E5 直接检验机制及路径；E6 是
**另行定义的过程响应问题**，不是证明治理安全的必要替代；E7 只有真实运行且
链条可核验才能支持 Agent 级陈述。若某模块未实现、未运行或未通过数据质量检查，
必须明确对应状态，其他模块的成功不能替代它。

## 3. 执行前的 E0 资格门

1. 只使用本次专用、可重置的模拟平台和模拟器，隔离配置根、数据库、端口、协议
   broker 和进程；核对本次启动的进程身份、启动参数与监听端点。不要复用默认的
   共享 `:4010` 或对未知服务发出复位/写入。localhost 本身不能证明目标是隔离孪生。
   任意真实设备、共享实例或目标身份不能证明时，中止有副作用阶段。
2. 启动两个独立配置：生产规则模式，以及明确记录 `AW_BENCH_MODE`、`AW_BENCH_ACK`
   和节拍设置的隔离基准模式；禁止把 benchmark 关闭的规则描述为生产规则。
   平台进程启动环境须通过可信方式记录，不能只看执行 runner 的 shell。
3. 捕获主仓库完整 commit、dirty 状态和差异、子模块 commit/dirty、镜像 digest 或
   可验证构建产物 hash、实际运行进程与构建身份、场景蓝图/配置/策略哈希、节点和
   协议绑定、时间源、依赖版本；未能证明运行进程对应源码时注明 `unverified`，
   不将 `git rev-parse` 单独当作在运行代码的证明。不得归档令牌、口令或私钥。
4. 预登记场景及纳入清单、每个场景的信号/单位/目标带和约束、各测试刺激、对照、
   样本计划、随机化种子、失败与缺失分类、主要指标和停止规则。先进行带明显
   `PILOT` 标记的夹具资格测试；修改夹具或方案后重新冻结，pilot 不混入确认性样本。
5. 将运行 ID 和可验证本次实例标识贯穿任务、审批、操作、节点、模拟器、驱动和
   DAQ。无法提供或无法核实此关联时仅报告可观察字段，不宣称完整执行链。

## 4. E1–E5 的最小观测合同

每个计划案例先生成不可变 `case_id` 和预期行为，记录 scene、protocol、路由、
node ID、请求值与单位、被试配置、触发条件、期望结果、预期是否到驱动和资格状态。
执行后记录发起与到达时间、状态/错误原文、审批及重新检查的实际记录、驱动调用
计数、写前/写后独立寄存器/模拟器状态；有设备回读时保存原始响应；DAQ 保存源
时间、采样时间、值和单位。确认失败检查发生在驱动前才能报告“未到驱动”；
仅凭 `rejected` 状态或数值未变化不能证明没有发出驱动调用。

对于单点和 recipe 路径分别描述实际复核差异：单点路线不使用 recipe 操作的上下文
快照；配方 trial 候选 override 还受适用 recipe window 约束。步骤、间隔及 hold 是否
执行取决于 source 和 benchmark 状态，agent 发起的试验可能以 agent source 下发，
不得按 route 名称一概判断。对于多参数操作，以每个参数的驱动事件和设备状态报告
部分成功；除非实际机制与证据支持，不能声称整个批次原子或自动回滚。

审批夹具的批准、拒绝和超时是**模拟决策**，不评价操作员行为。上下文或权限在
审批后变化的干预需要明确事件顺序：`proposal < pending < mutation < decision <
recheck < dispatch?`；无法观测 recheck 时标为不可验证，而不是根据最终错误猜测。
对不同入口在相同条件下分别复位重试；若仅能做 REST/MCP，则只报告这两个入口。

## 5. E6 固定时域过程比较：冻结后才能开始

在每个场景预先定义试验起点、目标带、约束、采样间隔、共同 horizon `T`、预热
和最大写预算。至少包含无写基线与可复现的规则基线；若规则基线就是论文中的脚本
方案，必须先将它改为同样在 `T` 结束，并保留完整轨迹。不要称 no-write 为 PID。
场景可以有各自的单位和工程合理的 `T`，但同一场景所有条件必须相同；跨场景
不得直接平均不同量纲的原始误差。

一个 block 对应一个 scene、seed 和固定扰动计划。每臂前从隔离状态重新初始化，
并记录可比的初始 setpoint、PV、配置 hash、模拟器随机状态或复位凭据、预热后
采样时间。仅相同 seed 不能证明初态匹配；若状态在预先规定的测量容差之外、
采样含复位前数据、reset 未能确认或 T 内数据不足，该臂标为无效并保留原始记录，
不能代填或只留下有效轨迹。随机化每个 block 内两臂的顺序；若共享模拟器可能
相互影响则串行执行，不能因为便利而并行污染。

预先选择一个主要指标：例如在共同目标 `r`、统一采样规则下的积分绝对误差
`IAE = integral_0^T |PV(t)-r| dt`；离散采样使用预先约定的梯形法。若缺失数据或
不等采样影响积分，按预先冻结的缺失规则报告，不将未观测区间当零误差。次要指标
可包括时域内在带时间比例、最大超调、到首次进带时间（未达为删失）、写入次数、
拒绝次数与最终状态；最终样本、首次进带值和总墙钟须分开。对每个 scene 报告
每对差值、有效及无效对数、效应量和匹配区间；技术重复不当独立样本。预先确定
最小有意义效应与所需样本量；小样本或未完成 power 设计时仅作探索性可行性报告，
不能声称显著、普适、优于 PID 或现场收益。绝不按 C0/C1 的好坏筛选场景或种子。

## 6. E7 Agent 任务证据与结论

真实 Agent 与脚本分栏运行，固定 harness、模型版本、提示、角色、工具白名单、
超时及外部依赖。每个 episode 记录全部任务状态，包括服务启动失败、无工具调用、
拒绝、超时与零写；不得只汇总成功任务。一个完整链条须能关联任务上下文、Agent
身份和工具请求、相应操作检查与审批（如适用）、驱动回执及可用的独立回读、实际
dispatch 后的 DAQ 观察。若缺失任一环节，则报告具体缺失，不以 Agent 自述的
`COMPLETED` 代替过程目标实现。目标判断失败也是结果；模拟审批不证明人因效益。
对比多 Agent 与单 Agent 或多个模型属于另一个研究问题，必须预先冻结并匹配任务、
权限、预算和起点，不能由原有两个失败 episode 或脚本结果推断。

## 7. 候选执行顺序及现有命令的边界

下面是**隔离环境确认通过之后**的候选夹具命令，用于逐项检查可用性，不能直接
视为完整 E1–E7。所有默认端口、启动参数、身份和写入副作用都须事先核对；输出
目录必须是本次空目录，不得覆盖历史产物。若未满足前置条件，记为 `NOT_RUN`。

```text
node bench/experiment/scenario-protocol-probes.mjs --no-autostart --base <isolated-aw-url> --scenarios injection,wwtp,anneal --seed 42 --out <new-output-dir>
node bench/experiment/authorization-probe.mjs --no-autostart --base <isolated-aw-url> --scenario injection --out <new-output-dir>
node bench/experiment/approval-gate.mjs --no-autostart --base <isolated-aw-url> --scenario injection --out <new-output-dir>
node bench/experiment/production-guards.mjs --ack-unverified-mode --base <isolated-production-mode-aw-url> --out <new-output-dir>
```

这些脚本会创建/修改产线或写入模拟器；明确核对 `SIM_BASE` 为本次隔离实例及
被测平台绑定的协议端点，不要运行在共享环境。前两个或三个 runner 有 `--no-autostart`；
执行前仍需验证其当前参数和实际代码。`production-guards.mjs` 只检查 runner
自身环境变量，不能读取或证明目标平台进程的模式或隔离身份；新加的显式参数
只是确认已知缺口，不是资格证明。无法通过独立证据确认目标时不得运行。
上述脚本均只验证各自已实现子集；E2 task/direct 配对、E3 动态上下文、E4 部分
失败、E5 回读故障、E6 统一时域及 E7 完整链仍需专门实现并完成独立审查。

正式顺序：E0 资格 → 预登记 S0 → pilot → 必要修复与重新冻结 → E1–E5 →
E6 固定时域 → E7 真实 Agent（如果环境与证据具备）→ 原始事件完整性验证 →
报告和图表。每个模块记录 `NOT_IMPLEMENTED`、`NOT_RUN`、`INVALID`、`COMPLETED`
及原因；`COMPLETED` 只表示协议与数据收集完成，不表示假设得到支持。服务故障、
缺字段、采样断流及过期数据必须留在运行总表。

## 8. 结果归档与论文写入规则

每次运行单独留存冻结方案与变更、运行清单、环境身份、每个条件及全部 case 状态、
原始请求和结果、驱动事件、审批事件、复位记录、完整 PV 时间序列、处理脚本、
图表源数据和 SHA-256 清单。保留 `planned`、`attempted`、`valid`、`invalid`、
`failed` 等分母及其理由，不用最终汇总数字覆盖原始记录。敏感身份信息可在公开包
中脱敏，但要保留稳定关联键并说明脱敏规则。

论文只能报告实际完成且可复核的模块，明确 simulator/mock、运行版本、入口、场景、
mode、实验单位、计数、遗漏、时间窗和对应的证据限制。E1 映射验证不证明 E2 授权；
E3 模拟审批不证明人类决策；E4 被测条件的拒绝率不等于物理安全率；E5 回读不等于
过程达标；E6 的仿真效应不等于真实生产收益；E7 链条未完成不能写 Agent 自主成功。
若实际数据与论文原主张不一致，应修订或限定主张，不按目标重新筛选数据。

## 9. 工具实现状态与最新批次

截至 2026-11-05，`bench/paper-runner/` 只有确定性内存夹具；它无网络、无真实
AW/PLC 适配器，输出固定标记为 `NOT_QUALIFIED`。`bench/paper-study/` 提供冻结方案、
证据封存和离线校验，不采集服务数据，也不能认证记录的来源。校验器要求共享时域、
固定采样间隔、注册的采样抖动界、连续单调的观察/源时间戳、新鲜度及初态匹配；
即使输出 `STRUCTURALLY-CONSISTENT-SOURCE-UNVERIFIED`，也只代表结构一致。

2026-11-05 最新记录可按限制条件写作仿真观察，但未满足过程效果对照或 Agent 完整链。
配方窗矩阵同源于配置且覆盖确定性选例；回读失配是一次同一模拟器的偏差注入；两次
Agent episode 均取消且零轮、零写入。预检的模型端点只列出可用模型，Q6 为脚本写入，
均不能替代一次真实 Agent 任务。细节、包内校验差异与论文可写边界见
[`EXPERIMENT-EVIDENCE-AUDIT-2026-11-05.md`](EXPERIMENT-EVIDENCE-AUDIT-2026-11-05.md)。
