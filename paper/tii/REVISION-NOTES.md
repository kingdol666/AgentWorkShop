## 2026-09-21 Nature-style EXP figure and 5+5 layout pass

- Installed `nature-figure` 2.8.0 and its `nature-shared` dependency from the user-specified repository; Python is saved as the plotting backend.
- Added `figures/walkthrough/aw_working-fig4.png` as the opening full-width figure of Sec. V, explicitly labeled as an implemented UI/API walkthrough rather than experimental evidence.
- Rebuilt the single-column system-execution figure around one claim: the framework retains a governed execution evidence chain while process-objective attainment remains independent.
- Figure QA: 21 source checks passed; 1.5-pt panel-alignment gate passed; strict collision audit found 0 warnings/failures; PDF minimum text size is 5.15 pt; vector PDF/SVG and 600-dpi PNG/TIFF were exported.
- Removed the author-defined 98.3/100 score from the figure and main evaluation claim. The manuscript now reports interpretable check counts, protocol transactions, rejection/breach counts, observations, and process predicates.
- Calibrated claims after source audit: the onboarding flow is a reference adapter built on platform APIs; scenario policies/models remain external; `opencode` is an adapter identity while deterministic external policies produce the tested actions; code-path reuse is not presented as measured zero engineering effort.
- Final structure targets exactly 10 IEEEtran pages: pp. 1--5 background/architecture/mechanisms; pp. 6--10 evaluation/discussion/conclusion/references.


## 2026-09-21 框架化重构（当前稿）

- 题目改为 **AgentWorkShop: A Configurable Agent-Team Framework for Multi-Scenario Industrial Optimization Control**，明确论文对象是可配置框架，而不是某一个特定控制算法。
- 摘要、引言和贡献点按“跨场景重复集成成本 → 配置化架构 → 治理闭环 → 分层实验证据”重写；明确 scripted policy/模拟器边界，避免把任务完成包装为自主优化成功。
- 架构章节补充完整功能面：Channel/lead-worker/task/memory，多入口 WebSocket/MCP/A2A/REST/CLI/TUI，DAQ/DCW 语义节点，六类协议入口，生产对象、权限/审批、热重载配置、插件和 SDK。
- 新增场景接入合约：blueprint → 差分 ensure → driverConfig 导出 → DAQ/DCW + recipe 建线 → Channel/binding → objective/guards/policy；强调四场景复用同一执行路径。
- 新增跨双栏功能矩阵表，区分 team、industrial integration、governance、production operations、extensibility 五个平面及其场景特定输入。
- 实验绘图按需求整理为：
  - 单栏 Fig. 4：系统整体执行（hard gate、五协议、执行证据、2/4 objective 状态）；
  - 双栏 Fig. 5：注塑、A2O 污水、连续退火、BOPET 四场景优化过程。
- 当前匿名 IEEEtran 稿为 9 页（US Letter），实验从第 6 页开始，形成约 5 页架构/方法 + 4 页实验/讨论/参考文献的紧凑结构；未通过缩字号或改页边距压缩。
- clean build 通过：0 LaTeX error、0 unresolved citation/reference、0 overfull box；保留 26 个非阻断 underfull 排版提示。

# IEEE TII 论文修订说明与投稿前检查

## 结论先行

本次交付是**基于现有项目实现及冻结实验记录的修订稿**，不是接收保证，也不是 IEEE 官方格式认证。正文、图示、实验口径和参考文献已修订；独立内容复核已关闭本轮可通过文字纠正的事实问题。**仍不建议把“排版通过”当作“科学证据已充分，可以直接投稿”。**

主稿：`SUBMISSION-IEEE-TII/main.tex`；编译结果：`SUBMISSION-IEEE-TII/main.pdf`。
证据冻结日期：2026-09-20。初始论文和图件已备份在项目 `.omc/research/tii-review-20260920/original/`，没有删除原稿或原始实验数据。

## 1. 排版与期刊要求

按 TII **普通研究论文、匿名初投稿**核查。期刊官网现行要求初投稿最多 10 页；不要继续套用旧版 8 页限制。官网同时要求 IEEE 双栏、匿名稿、字体可移植和文件不超过 40 MB。机构邮箱、作者 ORCID、投稿系统资料属于作者在系统中完成的事项，不在匿名正文里补入身份信息。

本地自动检查结果：
- 10 页，包含参考文献；US Letter；原生 `IEEEtran[journal]`，没有缩小正文或修改页边距来硬凑页数。
- 4 幅图、3 张表、41 条实际引用；正文图件全部为矢量 PDF。
- 所有字体均嵌入，PDF Author 元数据为空，未发现页面之外的文字。
- LaTeX 无 undefined citation/reference、无 overfull box、无 LaTeX Warning；仍有 8 处 underfull 排字提示；最终 10 页已逐页视觉复核，未发现阻断性版式问题。第 6 页代码/归档段及少量参考文献网址仍有略松的字距，不声称日志绝对零提示。
- 修订稿约 0.49 MB；摘要约 210 个英文词，为单段，无引用。

官方核查页面的原文快照保存在 `.omc/research/tii-review-20260920/tii-official.txt` 与 `tii-checklist.txt`。来源如下，仅用于核查，不意味着 IEEE 为本稿背书：

```text
https://www.ieee-ies.org/pubs/transactions-on-industrial-informatics
https://www.ieee-ies.org/pubs/transactions-on-industrial-informatics/new-submission
https://www.ieee-ies.org/pubs/transactions-on-industrial-informatics/new-submission?view=article&id=423:tii-checklist-for-manuscript-submissions&catid=17
```

## 2. 叙事与内容修改

- 标题改为 **AgentWorkShop: Governed Agent-Team Execution for Industrial Recipe Optimization**，把贡献定位在执行治理，而不是暗示已证明自主优化算法优越性。
- 摘要与引言按照“工业任务—现有集成缺口—所提机制—可观察证据—适用范围”展开。
- 方法部分区分请求准入、设备执行/回读、过程观测、提交判断、补偿动作；用区间交集说明普通 agent 写请求的实际限制，保留不同入口的例外。
- 实验按 Q1 协议约束、Q2 预防/回读/过程响应、Q3 控制器及多节点任务闭环组织，读者先知道问题，再读测量与结果。
- 讨论集中说明实现能提供什么、证据不能说明什么、部署需要补齐什么，减少重复否定句，但没有掩盖关键限制。
- 不把脚本 lead/worker、由 harness 发起的工具调用、task completion、无条件 `keep` 包装成 LLM 自主推理成功。

## 3. 实验口径修正：数据未改写

原稿相关的 20 个证据文件 SHA-256 与修订前保持一致。未重跑、挑选或替换实验，也未补造原始时序、置信区间、误差条或缺失日志。

- 控制器表现在明确列出 `J0`、`J1`、`J2` 和两次写后均值与网格参考的比值。三组均满足 `J0 < J2 < J1`，不再把均值得分误当最后一次得分。内部参考允许改变在线控制器固定的线速度，不能用该比值宣称公平优化器对比。
- 消融表的 6 次 breaches 明确只属于攻击探针；关闭窗口检查的每组还有 6 个额外的越界边界用例，不再藏在“边界符合预期”的计数里。
- 59 个返回历史点不再称为 59 个原始独立采样。
- 第一个温度任务的 204.700 °C 是设定值寄存器回读，不是独立过程温度收敛。
- 协议 drill 的 182 °C 写入之后还有拒绝探针及合法 180 °C 写入；30 s 从轮询开始计，不是隔离的 182 °C 阶跃响应。
- 130.205 s 是首次观测到回退判决的延迟，不能称为物理恢复完成时间。
- 控制器、BOPET 厚度、BOPET 熔体温度分别使用最多 6、5、4 个返回点均值；首任务寄存器端点单独说明。
- BOPET 的真实记录保留为 26.90、26.82、26.46、26.00、25.48 μm。目标绝对误差由 1.90 降至 0.48 μm，最终点进入目标带，但没有证明持续稳定或扰动抑制。
- 等待后的观测不再称为已经 settling；轮询退出规则不是稳态检验。

## 4. 与真实实现对齐的重要边界

这次没有修改生产代码。下列行为已写准或补入限制，而不是写成尚不存在的安全能力：

- binding 绑定部署实例，但可被管理员修改，不是不可变授权；新实例不自动继承。
- 审批决策接口验证用户身份，但没有额外的产线/owner approver 作用域；遗漏 `approved` 时仍可能批准。
- 绑定节点的 recipe-window 编辑不经过物理写审批；已打开优化记录保留创建时恢复策略。
- `dcw_judge(rollback)` 不直接执行恢复；物理回退是独立、可拒绝的操作。失败不会自动重新打开原记录供 sweep 重试。
- 回读失败可以发生在物理写已经执行之后；写成功也不能保证日志持久化成功。
- optimization record 没有直接 run ID，观测查询不是严格 run 隔离；共享生产上下文不是原子事务。

源码审计锚点包括 `server/services/workshop/agents/industrial-tools.ts`、`server/services/workshop/dcw/recipe-rollback-manager.ts`、`server/services/workshop/dcw/dcw-controller.ts` 及 `server/api/workshop/agent-tools/approvals/[id]/decide.post.ts`。

## 5. 图件与文献

- 用可重复生成的矢量概念图替换原 AI 栅格图；普通 agent 执行环路重新绘制为矢量图，移入方法部分。
- 移出双栏尺寸下不可读的控制台拼图；原图继续保留，不作为实验测量证据。
- 实验图使用 Times 字体、内向刻度、明确单位和目标带；只绘制真实离散观测点，不连成暗示连续过程的平滑曲线。这是 Origin 风格的科学绘图，并非声称使用 Origin 软件制作。
- 修正旧制图命令和产物路径；保留只读的源数据 hash 校验；9 项图件测试通过。
- 原稿 42 条实际引用均做了外部核查尝试，29 篇学术论文身份得到一手元数据支持。精准化 IEC 引用后，当前正文有 41 条引用。
- 修正 ISA-88 标识，补全已核实的页码/DOI，并将有已核实正式出版版本的 InstructMPC、Greshake 文献改为正式版本；没有把未来期刊卷期冒充已出版。
- **仍需作者手工确认**：实际采用的 ISA-95 历史版本，以及 ISO 23247 的具体分册/版次。相关官方历史/目录端点未能完整取回，不能称为全部标准条目已核实。未引用的 BibTeX 库条目未纳入本轮核查。

## 6. 投稿前优先补充的证据

以下是审阅判断，不是 TII 官网额外规定的硬性实验清单。它们不能靠更漂亮的语言补足。

### A. 一个能验证系统独特价值的受控对照

与合理的“任务编排器 + 工业网关 + 日志”基线，或移除 member/context/evidence 关联的版本比较。保持策略、动作空间、初始条件、预算与 instrumentation 相同。优先比较跨成员/上下文变更时的错归因、越权干预、干预记录完整性及恢复交接，而非只重复证明去掉范围检查会放行越界。

### B. 故障与异常路径验证

覆盖陈旧/缺失遥测、空 journal、日志失败、回退拒绝/部分成功、审批等待期间上下文或绑定变化、任务完成但过程未达标。记录明确的失败/升级处置及证据完整性结果。若要提升安全治理主张，先修复默认批准、审批作用域及窗口编辑保护，再验证，不能倒过来在论文里先宣称已具备。

### C. 审稿人可以独立运行的复现材料

固定平台和模拟器版本、依赖、初始化/清理步骤与完整命令；提供匿名可访问材料和期望输出，并验证一次干净环境回放。新实验应保存原始时间戳和桶数据；旧档案没有的数据不能补造。物理 demonstrator、独立场景或受控扰动可以进一步增强工业说服力，但本说明不把某个具体数据集或物理硬件宣称为 TII 强制要求。

真实 LLM 对比只有在作者希望提出 agent reasoning/autonomy 优势时才必须补足；当前修订稿刻意不提出该主张。

## 7. 重现本轮构建与检查

在项目根目录运行：

```powershell
python paper/tii/SUBMISSION-IEEE-TII/figures/make_publication_figures.py
python -B -m unittest discover -s paper/tii/SUBMISSION-IEEE-TII/figures -p test_publication_figures.py -v
latexmk -cd -pdf -interaction=nonstopmode -halt-on-error paper/tii/SUBMISSION-IEEE-TII/main.tex
python .omc/research/tii-review-20260920/verify_manuscript.py
```

自动检查记录：`.omc/research/tii-review-20260920/verification.json`。
独立内容复查：`.omc/research/tii-review-20260920/final-content-review.md`（最后追加状态优先于前面的历史意见）。
最终逐页视觉复核：`.omc/research/tii-review-20260920/final-layout-review.md`。
完整文献核查：`.omc/research/tii-review-20260920/references-audit.md`。

**交付边界：本轮已完成已有证据条件下的论文修订、重新编译与核查；未完成上面 A–C 所列的新实验及独立复现工程，不宣称满足真实审稿人的接收标准。**

最终 PDF 的 SHA-256：`39ae1fc161306c66fd4a1106b7ea8187ed956a532db13972fc42555e91927222`。逐页复核结论仅为版式通过，不是接收判断。
