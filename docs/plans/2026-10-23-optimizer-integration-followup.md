# Optimizer 实现审计与后续补齐计划

日期：2026-10-23。依据：`2026-10-22-optimizer-process-model-plan.md` v3.1（含 A1–A22）及当前工作区实现。
状态：**F1–F6 已整合进总计划** `docs/plans/2026-10-23-optimizer-master-plan.md`（SW1–SW7/D16–D22/A13–A18）；本文件保留审计论证。真实产线仍仅提供建议；不启动现场参数试验或自动控制。

## 1. 当前结论

已实现内置 ARX/静态响应模型的配置、数据集/训练、模型登记、两个 Python 求解后端、Profile/实例绑定、五个 Agent 工具和基础管理页面。**这证明内置场景的基础链路存在，尚不足以认定原计划 G1–G6、A1–A22 全部完成。**

本轮针对可局部定位的问题修复数值、训练评价、请求契约及部分权限，保持用户已有实现。下面列的是需要成组改造和独立验收的剩余工作。

| 原阶段 | 审计结论 | 未完成的核心出口 |
|---|---|---|
| G1 契约/注册/环境 | 部分完成 | SolverAdapter 未被新求解链消费；跨进程环境读租约与完整依赖锁不足。 |
| G2 数据/建模 | 部分完成 | 历史配方版本切段、动作证据、真实线资格、MD建模、静态稳定段/单长run切分不完整。 |
| G3 Python 求解 | 内置后端可运行 | 插件求解生命周期、完整模型/资格关联、求解后重校验与反馈评价尚未闭合。 |
| G4 Agent 集成 | 工具注册/基础绑定存在 | REST与Agent路径的统一授权、所有读面资源隔离、精确资格及撤权/失效语义尚需补齐。 |
| G5 用户配置界面 | 基础表单存在 | 工况/证据/运行诊断的可配置范围、试验执行、反馈与受限能力提示不完整。 |
| G6 系统验收 | 局部测试通过 | 真实模拟器闭环、双存储到达语义、所有入口权限/刷新时序尚未逐项实证。 |

## 2. 源码实证与影响

路径相对仓库根。以下是当前静态核查及隔离探针结论，不代表新增功能已运行验收。

1. **历史数据版本归属错误。** `process-model/dataset.ts` 为整批历史 run 填当前 recipe.version/contentHash；`aml/dataset-builder.ts` 未按 `process_context_segments` 裁切。旧版批次可被新版 Spec 收入并标成新版，版本混杂模型的预测与优化结论不可信。
2. **动作证据链未完成。** `process-model/eligibility-service.ts` 将真实线 actionEvidence 固定为 unknown，模拟线仅凭 line.simulated 固定为 simulation_commanded。前者永远无法获得真实优化资格；后者不能证明实际执行了模拟参数干预。`process-model/experiment.ts` 目前仅创建计划/修改状态，没有持久试验执行器。
3. **精确资格谱系缺失。** `optimization/manager.ts` 使用 `latest(spec.id)`，没有固定到 specVersion/condition/model.dataset；同ID其他版本的合格报告可能误用于当前模型。Profile 发布也应核验模型→数据集→Spec 的完整关联。
4. **多入口授权不一致。** REST `optimization/solve.post.ts` 直接调用 manager，仅核验 Channel 成员，未复用 dispatch 的档位、工具策略和产线 grant；资格、试验列表、部分发布/列表路由也没有完整资源归属检查。绑定撤销和跨运行 plan_get 的两处局部漏洞在本轮单独修复。
5. **在途/读取时失效不完整。** 求解后主要核对 binding revision，模型或 Profile 退役、配方切换、有效期变化可能遗漏；建议读取主要依赖 TTL，没有统一的工况/资格/权限重新验证。TTL 部分在本轮补正，完整失效仍是本计划任务。
6. **插件能力未进入运行链。** `process-model/contracts.ts` 的 SOLVER_REFS 固定两个内置值，Python Worker 按内置问题类型分派；Twin Registry 中登记的 SolverAdapter 无法直接被 Optimizer 解析执行。ObjectiveAdapter 也未成为通用问题编译入口。
7. **模型输入能力尚有限。** 两个训练器主要使用 MV/CV；MD/外部特征未贯通训练、IO与推理。静态模型仍从滑动窗口取输入并平均未来输出，不能直接等同于经过稳定性筛选的稳态/批次响应模型。未支持的输入应明确拒绝，不能静默忽略。
8. **生产存储与环境还有差异。** Timescale 未实现 SQLite 同等的 raw-page/state/ingestedAt 读取与到达语义保留；环境读租约只在当前进程内，另一个平台进程无法观察读者。原子维护锁的局部修复不能替代跨进程读写互斥。

## 3. 实施任务与验收

### F1 统一授权与发布前后复核（最高优先）

落点：`optimization/{rest-auth,binding.service,manager,recommendation.service}.ts`，`agents/host-tool-bridge`、`grant-guard.ts`，全部 `optimization/` 与 `process-model/` API。

- 抽取统一操作授权：主体用户/Agent成员实例、Channel档位及工具策略、目标绑定、产线只读grant、变量可读范围、操作capability。REST/native/MCP/内部调用在读取数据前走同一规则；唯一绑定默认调用也须先解析实际目标再鉴权。
- 列表、资格评估、配置发布、状态、取消、建议读取均按资源授权；读取不得因仅登录或拥有editor角色而越权。配置管理权与成员调用权分离。
- 求解提交、结果发布、建议读取分别复核绑定有效期/revision、Profile与模型状态、规格/配方/工况和资格。条件变化将建议持久标 expired，禁止迟到结果恢复有效。
- 绑定变更通知工具面，分别验证OMP/MCP/Pi能力；展示缓存滞后不能造成执行放行。

**验收**：editor A 对 B 的绑定/资格/配置/运行不能读写，拒绝前后数据库不变；持有旧绑定后撤线grant/禁工具/切legacy，REST与Agent调用都拒绝；阻塞Worker后退役模型或换配方，释放后无有效建议；过期或失效建议在所有读取入口一致。

### F2 数据与配方版本真实性

落点：`process-model/{dataset,context,context-segments.repo,watermark}.ts`、`aml/dataset-builder.ts`、`dcw/line-run.ts`、配方应用事件/host-bindings、TSDB端口与双适配器。

- 按已确认的 context segment 和 RecipeRun.paramsSnapshot 归属样本，冻结版本/hash；编辑仓库不等于设备已应用。运行内切换拆段，未知旧记录不倒填当前版本，窗口不得跨段。
- 训练/在线使用相同单位、变量顺序和输入时间语义；按数据用途提供稳定段/批次样本与动态序列。单长run的时间块切分应含purge gap，避免重叠历史/目标泄漏。
- Timescale补齐逐节点raw-page、真实state/ingestedAt、水位截止、首写胜出与更正计数、迟到数据保留。使用一致性快照/固化导出，不能把当前表当过去可见状态。

**验收**：v1运行结束再编辑v2，v2规格不能将v1样本改标v2；同run确认换版后窗口不跨段；unknown明确排除优化资格；SQLite/Timescale对同一坏点/迟到/重复/分页fixture结果一致；单run合法切分通过，重叠泄漏反例失败；静态样本有稳定性证据，过渡段不冒充稳态。

### F3 试验、动作证据与精确资格

落点：`process-model/{experiment,eligibility-service,eligibility}.ts`，既有 DCW/探索账本、AML模型/数据集关联、Optimizer Profile发布及manager。

- 实现模拟试验持久状态机：计划→调度→已有治理链动作→实际回读→保持/观察→证据归档；受simulated目标、预算、告警和中止条件约束；重启未知动作不自动重放。
- 真实线只使用已有历史动作/设备回读证据，不产生本计划未授权的现场试验。request/ack/readback/effective有来源与时间，未知保持未知。
- 资格显式关联 datasetId/hash、specId/version、conditionId、作用域、特征/证据版本；模型绑定使用自己的训练/校准证据，不能从其他版本的latest报告借资格。报告应可追溯和失效。
- 把多步响应、输入激励/覆盖、共线/已知扰动混杂、OOD/UQ与模型性能分别判断。UQ/OOD的当前输入判定来自本次上下文，不能把训练时静态指标当运行时判定。

**验收**：模拟线只标记simulated但未发生干预，不能自动获得动作资格；真实线有可核验历史有效干预时能通过real资格，仅ACK/失败/自然波动仍拒绝；v1合格不放行v2或另一个模型/数据集；资格撤销后所有使用者失效；模拟试验可取消，重启不重复写。

### F4 真正的 Adapter 路由和模型输入扩展

落点：Twin `provider-contracts/registry/loader`、`optimization/{contracts,manager,problem-builder,worker-client}`、Python Worker、训练/预测IO与UI。

- Manager从Registry解析精确SolverAdapter，检查已声明能力、问题/模型兼容与健康，持代际租约调用，保留取消/超时/诊断/退役语义；内置OSQP/SciPy也通过该通路，不另建Registry。
- ObjectiveAdapter/ProblemTemplate实际编译到受验证IR。新增已注册算法或同IR模板无需修改Manager核心；新的IR版本仍需显式编译器/独立验证器，不能声称任意插件都自动兼容。
- MD/特征支持必须成组补齐数据张量、训练器、工件schema、估计/预测假设、ProblemIR、Solver、独立验证。实现前对未支持输入明确unsupported，保留MV/CV功能。
- 工况先选择已验证模型与有效域，再求解；工况编辑器提供真实数据来源字段。模板外模型或控制形态明确拒绝。

**验收**：测试插件注册一个独立SolverAdapter，Manager实际调用它且不改核心；更换已注册问题模板真正改变IR；退役/热更不改变在途代际，取消释放正确租约。扰动变化fixture中，完整支持后模型预测/解随MD合理变化；缺未来扰动策略明确拒绝或记录持值假设，不静默忽略。

### F5 共享环境完整互斥与可恢复性

落点：`aml/{env-lease,env-manager,python-runtime,job-orchestrator}`、`optimization/worker-client`、requirements/打包。

- 跨进程可观察的读租约、原子维护锁、owner/token/heartbeat、死亡进程恢复及退出确认；所有训练/评估和求解入口使用同一环境生命周期。
- 维护先封住新任务、等待/拒绝在途租约，再停止空闲Worker并确认退出；不得在另一个进程仍读环境时重建。
- 形成支持OS/Python组合的完整依赖锁与marker，覆盖解释器/平台/锁摘要；并入打包路径与离线/镜像行为。

**验收**：A进程训练/求解时B进程重建返回ENV_BUSY；B持维护锁时A不能取得读租约；并发维护只有一个成功；崩溃遗留锁确认无活进程后可恢复，活锁不被误删；Windows退出确认后才能切换环境；同平台锁可重现且源码/打包环境一致。

### F6 补齐原验收与用户流程

- 对现有plc-node-simulator薄膜及连续退火引擎做协议/数据/训练/求解闭环，不用简单ARX合成plant替代该出口；Solver仅见exposed，truth供独立验收。
- 固定基准、训练/评测条件、20条配对扰动轨迹、保持方案与原启发式。按原A8检验收益和动作边界，报告质量初始偏差与越界率。
- 第三个留出场景仅配置完成数据→训练→权威评估→注册→绑定→求解并重启复用；核心源码hash不变。UI覆盖受支持的动态/静态、工况、资格缺口、试验状态、求解诊断与建议/实际反馈。
- 将A1–A22逐条拆为子断言；部分通过标partial，缺服务/环境标not-run，不能用67或90个断言的总通过数代替每条计划出口。

**验收**：全量证据含commands/exitCode、源码及模型/数据/配置hash、后端版本、端到端原始轨迹、权限负例、刷新时序、收益结果；独立审查逐项复核。真实产线建议链按run/binding归因的设备写计数为0。

## 4. 依赖与实施顺序

1. **F1优先**：统一授权和失效，先完成跨用户/直接REST负例。
2. **F2 → F3**：先让数据版本/时间/动作事实可信，再发布精确资格。
3. **F4** 的Adapter路由可与F2并行；MD/多工况扩展依赖F2的数据契约与F3的资格。
4. **F5** 可独立进行；跨进程环境使用须等待该阶段验收。
5. **F6** 依赖以上阶段；每阶段独立提交、测试、审查，不以“工具能返回结果”判整阶段完成。

## 5. 完成标准

各阶段验收证据齐全、相关原有回归和lint/typecheck通过、独立review无阻塞后，才能更新原计划对应阶段为完成。模拟收益只代表模拟结果；现场收益须另外收集真实工况证据。本计划不包含无人值守控制、真实线自动激励或新增混合整数/NMPC算法。

2026-10-23独立计划复审：**APPROVED**。已确认F1–F6覆盖本轮发现的大缺口，任务/验收和前置依赖可执行；该结论不表示这些任务已实施。
