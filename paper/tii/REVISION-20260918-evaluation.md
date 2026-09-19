# TII 论文实验章节重写与全稿修订记录

日期：2026-09-18
基准档案：`bench/results/20260918043504-bdo/`（seed 42，commit `7d4bfc0`，harness hash `00e7dc827f4a2cea`）
成品：`paper/tii/main.pdf`（**11 页**，无 undefined reference，无 LaTeX error）

---

## 0. AgentTeam 场景 + 闭环流程图（Fig. 6，本轮新增）

`figures/publication/fig11-agentteam-loop.{html,svg,pdf,png}`，由
`build_scenario_figure.py` 生成（绘图前对 `run.json` 逐值断言），
`export_scenario_figure.mjs` 用 Playwright 导出印刷矢量 PDF + 300 dpi PNG。

**三个横向条带**，自下而上对应「场景 → 决策 → 结果」：

| 条带 | 内容 |
|---|---|
| 上：模拟真实工况 | BOPET 双拉线五个工位（铸片 → MDO 纵拉 → TDO 横拉/烘箱 → 测厚仪 → 收卷）+ 三个受写执行器 + 目标卡（h → 25.0 ± 0.7 µm，≤ 6 次受治理写）；膜带走带用流动虚线 |
| 中：决策与治理 | 左＝Channel 任务板（lead 派发 → worker 的 `daq_query`）；中＝受治理写闸门四道检查（binding / 量程∩配方窗 / ownership·cooldown / driver 写+回读）；右＝三次下发记录表（旋钮·节点 / 指令 / 厚度 / 记录号） |
| 下：闭环结果 | 左＝厚度随三次下发的收敛曲线（目标带 + 三次下发标注）；右＝结果卡（|h−25.0| = 0.68 ≤ 0.70、余量 0.02 µm、3/6 次写、3 节点 2 协议、熔体温度、任务收口） |

**动画**（`fig11-agentteam-loop.html`，24 s 六拍循环）：高亮依次扫过
「目标下达 → 测厚仪读数 → 第 1 次写（铸片辊）→ 第 2 次写（MDO 快辊）→
第 3 次写（TDO 轨宽）→ 收口」，每次高亮同时点亮**对应的执行器方框、闸门检查行、
记录表行**，膜带持续流动。

**关键设计**：动画写在 `@media screen and (prefers-reduced-motion: no-preference)`
之下，且只做**叠加式高亮**——基础文档本身就是完整静帧。因此 PDF / 打印 /
reduced-motion 读者拿到的是同样的全部信息，论文没有任何内容只靠动画传达。
导出 QA：`errors: []`、`outside: []`、`text_overlaps: []`、最小字号 6.52 pt（TII ≥5 pt）。

**正文衔接**：§V-E 先交代「两次任务都是脚本成员」，再在第一任务之后用
「Fig. 6 maps it end to end: the line, the team, the admission gate, the three
recorded writes, and the response they produced.」引出图，随后才展开装线参数、
目标、初始读数与三次下发，最后收束到「图说明什么 / 不说明什么」。
读者先看到全貌，再读细节，再读边界。

---

## 1. 实验章节（§V）重写

结构由「先讲方法、后给数字」改为「先给可核验结果、再给边界」：

| 小节 | 内容 |
|---|---|
| A. Evidence Design and the Reference Run | 四个研究问题 + 证据分层 + 档案指纹（run id/seed/commit/hash/Node） |
| B. Suite-Wide Results | **Table I**：17 个 phase → 7 个证据层，Wt / Checks / 主结果，合计 37 权重、75/75 |
| C. Protocol Integration and Governed Writes | **Table II** 逐栈延迟/回读/拦截 + 生命周期 + 参数层 |
| D. Fixed-Controller Closed-Loop Benchmark | **Fig. 5** + `J` 定义、`J∈[0,95]`、两种口径比值、逐项分解 |
| E. Scripted Team Missions | **Fig. 6**（场景 + 闭环流程图）+ 两次任务 |
| F. Reproducibility, Recovery, and Threats to Validity | 回退演练、两次失败、指纹与四条例外 |

### 表格与图与报告一致
Table I 的 7 层 / 17 phase / 37 权重 / 75 检查**逐一等于** `report.md` 记分卡；
Table II 每一格等于 `metrics.csv`。`reviews/verify_evaluation_numbers.py`
对 **199 条**论文数值断言与档案做机检，全部通过。


---

## 2. AgentTeam 真实优化过程图（旧 Fig. 6）

原 `fig10-agentteam-biax.py`（三面板：步骤链 / 厚度轨迹 / 熔体温度）已由
第 0 节的新图取代；旧文件保留备查。新图把原三面板的信息并入更完整的
「场景 → 治理 → 结果」叙事，并新增装线示意、闸门四检查、下发记录表与结果卡。

`fig9-latest-benchmark.py` 修复了原图 (a) 中 `n=3 | 75/75 pass` 文字压条、
(b) 中脚注压图的问题。

---

## 3. 四位盲审（模拟 IEEE TII）发现并已修正

评审席位：方法学、领域（BOPET/自动化）、跨视角、Devil's Advocate。四席独立指向同一批缺陷，均已改：

| # | 缺陷 | 处置 |
|---|---|---|
| 1 | `J_end` 是末两次均值却写作「settle」，掩盖第二次下发使 J 下降 | 明写定义、并列末次迭代比值 0.967/0.963/0.968、声明非单调；结论与摘要同步 |
| 2 | 双拉三次写「不同驱动、不同单位」为**假** | 改为「三个不同线区、跨 2 种协议与 2 种单位」，逐条给出协议与单位 |
| 3 | 三次写「回读一致」档案中并不存在 | 改为「驱动受理 + 静置后复读测厚仪」，明写档案无写后回读值 |
| 4 | 三次写均「账本归因」实际只查了 1 个节点 | 改为仅铸速节点有归因证据 |
| 5 | 任务使用 `harness:'mock'` 成员，论文未披露 | §V 开头、§V-E、Fig. 6 图注均写明 scripted mock |
| 6 | 三次写/三旋钮是人为设定增益 + 固定轮换 | 明写预设比例增益、固定轮换、增益刻意取小 |
| 7 | 「safety window」措辞错误且该约束非绑定 | 改称 process window；说明三个受写执行器不驱动该量、未注入扰动 |
| 8 | 24/24 探针远离边界、n=6 的 p95 实为最大值、回读 n=1 | Table II 图注与正文逐条说明 |
| 9 | 达标余量仅 0.02 µm 未报 | 正文与图注给出余量 |
| 10 | 工具闭环 4 条线「收敛」中 2 条无位置证据 | Table I 改为「3 次脚本化下发」并注明仅两条栈有位置证据 |
| 11 | 复现指纹无法解析、子模块未纳入 | §V-F 明写三条例外（换行敏感性、模拟器版本、空证据检查），改称开发期回归套件 |
| 12 | 审计路径 fail-open、K=2 无人值守未覆盖 | §IV-C、§IV-G、§V-F 明写 |
| 13 | 图 3 编号 1/5,2,3,4,6,7 与「六机制」不符 | 图注改为「编号是回路步骤，非逐条对应小节」 |

---

## 4. 其他章节

- **冗余清理**：审稿人给出的 16 处重复逐条处理（「非安全认证/非事务」类表述由 4 次和 3 次各收敛为 1 次；9/9、28.10→25.68、J/J*、75/75 的重复陈述各保留一处主陈述）。
- **写作**：全稿 em-dash 断句清除，`X is not Y` 句式大幅减少；§V 为 0 处 em-dash。
- **贡献边界**：§I 增加「本文是系统贡献，不提新控制律/学习方法/安全认证论证」；§II-B 增列 APC/RTO 监督写路径等最近邻实践。
- **第一至第四张图**（fig1-intro / fig2-architecture / fig3-channel-loop / fig4-workflow）全部按图序插入并各配完整图注。
- **新增** Data Availability and Disclosure 段。

---

## 5. 版面

11 页（要求 ≤11）。放宽浮动体参数并把宽图声明前移，消除原先约 1000 pt 的浮动空白。

---

## 6. 仍需作者处理（本次未做，属新实验或需作者输入）

1. **未跑新实验**：审稿人建议的治理消融（`--cl-write governed|rest`）、边界探针（l/u±ε）、
   第二次独立整跑、真实 LLM 路径对照，均需要重跑基准，本次只做文本与数值口径修正。
2. **可复现指纹**：harness hash 目前无法对应到任一 commit，且模拟器子模块版本未入指纹；
   建议在重跑前先提交并打 tag，使 hash 可解析。
3. **`keep` 判定**：脚本无条件写 `keep`，且 P4 的理由模板对无回读驱动也写「回读校验通过」，
   建议修正模板后重跑（本次已在正文如实披露）。
4. **BOPET 工艺合理性**：审稿人指出缺少 R_md/R_td、幅宽、断膜风险、产率影响等真实约束，
   以及 25.0±0.7 与预设描述里 25.0±0.8 的差异；建议补一节 plant model 说明或统一预设描述。
5. **参考文献**：为压到 11 页删去 8 条边际引用（现 37 条，全部被引、无孤儿）；
   若改投更长版面可恢复，并可补 APC/RTO、ISA-18.2、薄膜拉伸工艺等文献。
