# 审稿修改行动计划（Review-Action Plan）

> 日期：2026-09-13 · 输入：两位模拟 TII 审稿人 + 一位独立基准审计员的完整评审
> 总判决：**今天投 = Reject（鼓励重投）**。实验设计获好评（oracle 纪律/基线矩阵/分层可信度/可证伪 thesis），被拒原因集中在：① 主对比实验 E1–E9 未跑（红色占位）；② 若干诚实性/精度缺陷；③ 格式行政项。
> 本文按"已完成 / 投稿前必须 / 项目侧工程"三档列出全部行动项。审稿原文要点已内嵌，供后续 Agent 直接执行。

---

## 一、本轮已完成修复（2026-09-13）

| # | 审稿意见 | 修复 |
|---|---|---|
| R1-M2 | Algorithm 1 缺审批阶段，与 Fig.2 矛盾 | §IV-B 新增 Stage 0（工具层审批门：manual 绑定去重/呈卡/ lapse 默认不执行）；指出**审批与执行解耦→批准后全部校验重跑，无 TOCTOU 窗口**；Algorithm 1 加分支；Fig.2 "no/timeout"→"no/lapse" |
| R1-M3 | Eq.(1) 交集 vs 替换语义矛盾 | 按真实代码改为**批次期替换语义**（W_r(p) 生效，工程量校验恒在），声明 W_r⊆S(n) 为设计期性质+硬化项；Eq.(1) 双分支纳入动态验证（见 api-3 branch） |
| R1-M5/R2 | I3 每链边界非全局边界 | §IV-D 明确承认 + 硬化项（每节点自动写预算、操作员仲裁） |
| R1-M4 | 无威胁模型/终端能力引擎 | 新增 §IV-G Trust Boundary：允许清单探针/最小权限/网络分段="唯一可达写路径"；prompt 注入不能扩权但可滥用授权→正是 HITL+有界自治所限；引擎沙箱列为未来工作 |
| R1-M6/R2-M4 | "live plant/production/L2" 标签膨胀 | §VII-C 改 **L1-tier API surface**；tab:layers 加 Status 列；L4 改名 "End-to-end digital-twin case study"；摘要限定 |
| R2-M5 | castfilm 隐瞒项 | §VII-K 披露：自动批准、单 seed、共享实例降级、**W\* 角点解释**（能量权重>吞吐权重→agent 点吞吐 ≈2.4×W*，96% J 是运行点合理性的度量非到角距离）；J₀ 舍入解释 |
| R2-M7 | "bitwise-reproducible" 过强 + warn run 未报 | 摘要改 **verdict-identical under fixed seeds**；复现段披露全部历史 run（含 warn）与 p95 全范围 |
| R2-M1/M3 | §VI-E 描述了不存在的基础设施；6/3 样本用速率语言 | §VI-F 重写为"Released today vs Specified, in development"两档；§VII-C 改述为**确定性一致性测试**（coverage 叙事+Wilson CI 提示）；api-3 扩展**边界值(±1 LeastCount)与 Eq.(1) 双分支**用例 |
| R1-7/R2 | 参考文献占位作者/渲染 note | kgllm2024→Liu, P. and others（检索核实）并删编辑性 note；Ren/Sabetta 条目修正 |
| R1-9 | 版式：Fig.1 PLC 被审计面遮挡、Fig.2 拥挤、Table XII 压印正文、摘要 322 词、关键词乱序、驱动族 4/5 不一致 | Fig.1 重排（PLC 独立行+走廊走线）；Fig.2 resizebox；Table XII scriptsize+短单元格+W* 实值；摘要重写 ≤250 词；关键词字母序；全文统一"五协议族"并同步 s1 检查器 |
| 审计-1 | harness 未版本化 | run.json 新增 `harnessHash`(12 文件 SHA-256) + `gitCommit` |
| 审计-2 | full 层是空转 | run.mjs 实现 **api×N 轮 + 合并**（判定取最严、reps 存档），PIPELINE.md 同步 |
| 审计-4 | api-4 归因判据缺 actor | 四字段判据（source+actor+at+值证据） |
| 审计-5 | s2 正则过松 | 滞回/warn 改 `(this.max - this.min) * 0.0x` 语义锚点；250ms 改 setInterval 锚点；去重 stale 锚点 |
| 审计/审稿 | api-5 8 探针非百分位 | 提到 20 探针（p50/p95 有意义） |

## 二、投稿前必须完成（论文侧，阻塞项）

1. ~~执行并报告 E1 主对比~~ → **管线层四臂消融完成（2026-09-14, tab:e1lite 四臂版）**; E1b agent-in-the-loop 跑批仍待做：D8 消融开关已实现（`AW_BENCH_MODE=1` + `x-aw-bench-arm` 头，生产缺省恒 full 臂），**E1a 管线层消融已实测进论文**（tab:e1lite：full 6/6 拦截 vs no-interlock 4/6、越窗写执行且入账 12 锚点、软联锁零时延开销、判定逐位可复现）；**E1b agent-in-the-loop 跑批仍待做**（需 P0 decision_log + T1–T4 任务编排 + LLM 补充组）；
2. **执行 E7（框架基线）与 E9（跨引擎）**——比较性主张的最低证据；E2/E3 支撑 §V 算法声称，也须完成或删弱相应声称；
3. **E5 处置**：实现 D11-A（EMA+CUSUM）并测，或整节删除（含 tab:metrics 自适应行弱化）；
4. 删除一切仍为红的叙事：E1b/E2–E9 完成后逐节替换；未完成的实验整节移除；
5. 行政项：作者/单位/致谢填实；markboth 去掉 "Draft"；artifact URL 落地（建议 Zenodo DOI + 匿名仓库）；查 IEEE AI 使用披露政策；ORCID；投稿页数核验（当前 14 页，已达 TII 常规上限，增补时注意压缩）。
6. 建议补充（提升录取率）：L2 验证的 case-inventory 附录表；castfilm 多 seed 重复（≥3）；s1 阈值改为与论文完全相等的精确断言。

## 三、项目侧工程待办（与 00-MASTER-PLAN 对齐）

| 项 | 内容 | 优先级 |
|---|---|---|
| P0 插桩 | decision_log 表 + 写控四段耗时戳 + 保留期≥90d（E1–E9 全部成本/时延指标的前置） | **最高** |
| D8 | `AW_BENCH_MODE` 治理旁路开关（dcw-controller 三锚点+ungated 组合臂），生产模式硬拒 | **最高** |
| D3 | 模拟器控制端口（故障注入前置） | 高 |
| D4–D6 | bench/lib: fault-injector F1–F6 / metrics.mjs / stats.mjs（MW-U+Holm+bootstrap+效应量, 单位=run）/ tasks T1–T5 oracle | 高 |
| D11-A | EMA+CUSUM 自适应检测 + alarm_insights 工具（E5；否则删节） | 中 |
| D12/D13 | TEP/SWaT 回放 driver / HIL 真设备 | 中 |
| B2/B4/E8/E9 | 框架适配器（等 token 预算协议）/ sim-operator+真人轨 / 六引擎跑批 | 高 |
| 加固-I3 | 每节点自动写滚动预算 + 操作员-代理仲裁语义 | 中 |
| 加固-安全 | 配方 authoring 期 W_r⊆S(n) 校验；引擎沙箱/最小权限部署模板；prompt 注入红队用例 | 中 |
| 加固-bench | api-4 归因改按写入 ID 关联（防并发计数污染）；s1 精确断言；bench/README 英文版入口 | 低 |

## 四、投稿决策门（重申）

E1–E4 全绿 + HIL 完成 + ≥1 算法主线（E5 或 Safe-BO）→ **IEEE TII**；
缺 HIL 或缺算法主线 → **Computers in Industry** 先投（paper-show 首选），TII 二投；
JMS LLM 智能制造专刊窗口出现且 E 组全绿 → 与 TII 二选一权衡。

---

## 五、第二轮审稿(2026-09-13)结论与本轮已修

**复审判决**：审稿人=「sound but incomplete, today reject; 若剩余占位以同等质量补齐 → 7.5–8/10 Accept with minor revisions」；主编=「行政退稿(right journal, wrong month)」，建议 **ETFA/INDIN 会议先行占坑 + TII 在 E1b/E7/E9/L2-or-L3 完成后重投**；审计员=**测试流程可由 Agent 按 PIPELINE.md 端到端复现，判定指标跨运行零分歧**（独立执行 plc×2/static×2/full×1 全 100）。

**本轮已修（全部编译/运行验证）**：
1. intro 残留 "intersects" 改替换语义；结论措辞同步；
2. Fig.2 重排为审批前置（与 Algorithm 1 一致），加 "no TOCTOU" 注记；Algorithm 1 补 unbound 拒绝分支；
3. Fig.1 语义修正（删除 storage→PLC 错误箭头，改 PLC↔Drivers process I/O；组标签移到框下不再撞 Interop 条）；
4. E1a 12-vs-6 锚点解释（6 越窗写+6 边界写全部入账）；
5. tab:e1/tab:fw 预填单元格加 "†by construction" 注记（不再读作未跑实验的测量值）；
6. castfilm 95.9–96.0% 的解释改为"两次在窗评估读数括弧"（删除 J₀ 舍入的非因果解释）；
7. s2 补第 20 锚点（DCW SWEEP_MS=500）→ 论文 20/20 与 harness 一致；plc-scenario.mjs 加入 HARNESS_FILES 指纹；e1-lite gitCommit 动态化；"three tiers"→"four tiers" 全改；PIPELINE.md 阶段 A 计数与阶段 B 模拟器启动已同步；
8. 相关工作补 4 条：IEC 62443（§IV-F 引用）、CBF(ames2017)、shielding(alshiekh2018)、levels-of-automation(sheridan1978)（§II-C 定位句）。

**投稿前剩余（按阻塞排序）**：E1b/E7/E9/E2/E3 实测填表 → \resModels → 作者/单位/DOI/AI 使用披露（IEEE 强制）→ markboth 已清理但投稿前需终检 → 标题 "Human-Approved" 与 castfilm 自动批准的措辞张力（建议：补一次真人批准试验，或标题改 "Governed/Mode-Bound Approval"——主编标注为最快引发 integrity 质疑点）→ PolyForm-NC 与 "reproducible by anyone" 的许可张力（建议 bench/+模拟器改宽松许可）→ 页数 14 已达上限。

---

## 六、Loop 迭代 2（2026-09-14）——第三轮审稿写作层修复（已完成，loop 终止）

**第三轮审稿结论**："Reject as-is — but for fixable reasons, not campaign reasons. One more writing-only iteration — mandatory — then stop writing entirely; the next review should see filled numbers."

**本轮已修复（全部经编译 + judge 视觉验证）**：
1. 文献 4 条真正落盘（上轮补丁中断导致"声称已加但未写入"——本轮以幂等脚本修复并逐条 grep 验证）：IEC 62443（§II-C/§IV-F）、CBF（ames2017，§II-C）、shielding（alshiekh2018，§II-C）、levels-of-automation（sheridan1978，§II-C/§VI-B4）；
2. 表格溢出三处清零：tab:audit 链行缩短、tab:plc F2 行缩短、tab:eng 表头收窄（Overfull hbox 4→2，残余均 ≤2mm 且为图形节点不可见量级）；
3. Fig.2 重绘：审批前置 + 两个显式 reject 终端（消除悬空 stub 与菱形回流）；
4. Algorithm 1 补 unbound → reject(FORBIDDEN) 分支；
5. tab:e1 红码 E1a–E1i 改为 A–I（消除与 §VII-E1a/E1b 节名的编号冲突）；
6. 标题 "Human-Approved" → **"Approval-Gated"**（integrity 修正：castfilm 批准为自动批准，标题不再超称）；
7. 摘要裁剪至 239 词（≤250 达标）；markboth 去除 Draft 字样；
8. D8b：no-readback/ungated 臂实现（runtime 容差穿线）；PLC 场景新增 **F2 工艺冻结注入**（PV manual 覆写 150℃窗外 → 治理写回读通过但独立监测层 2s 内报警=纵深防御实证）。

**Loop 终止判定（依审稿人指令）**：写作层修复项已全部完成并逐一验证；剩余阻塞**全部为 campaign 阻塞**——E1b（agent-in-the-loop 主对比）、E2–E9、\resModels、多 seed 案例重复。这些需要 P0 插桩 + LLM 组跑批（约 6–10 周），写作迭代已到收益上限。**下一个审稿轮次应看到填好的数字，而非文字。**

** administrative 待办**（投稿时）：作者/单位/ORCID、artifact DOI、IEEE AI 使用披露、页数压缩（现 15 页，超 TII 常规上限，需压缩 §III/V）、PolyForm-NC 与 bench 宽松许可的分离决策。

---

## 七、实验部分压缩与冗余清理（2026-09-14）

**删减决定**：
- **E5（自适应检测）整节删除** + §V-C 漂移层设计段删除——算法未实现，属"vaporware"风险项（审稿人明确"implement or delete"）；降级为 §VIII future work 一句话。恢复条件：D11-A 实现后再作为独立小节回归。
- **E2/E3/E4/E6/E7/E8/E9 七个子节合并**为一个 "Comparative and Robustness Campaigns (Released Protocol)" 子节——八个标题+重复句式压缩为单段协议描述；E7/E9 两张协议表保留（审稿人指定 E7/E9 为最低比较证据）。
- **保留的实测核心**（全部 judge 验证）：§VII-B 静态审计、§VII-C 动态不变式（含边界+双分支）、§VII-D PLC 真实协议场景（含 F2 纵深防御）、§VII-E E1a 消融、§VII-G' castfilm 案例。

**结果**：15 页 → **14 页**（TII 上限内）；0 断引用；残余 Overfull 仅 2 处 ≤2mm 图形节点量级。

## 八、需要用户补充的内容（唯一剩余清单）

**A. 实验 campaign 数据**（跑批后替换，映射见 evaluation.tex 顶部 FILL-IN GUIDE）：
1. tab:e1 红码 A–I：E1b 主对比（4+1 治理臂 × W1/W3 × T1–T4 × N≥20）——需 P0 decision_log + D8 消融开关（已实现）+ T1–T4 任务编排；
2. tab:fw 红码 E7a–n：E7 框架基线（AutoGen/LangGraph/CrewAI/ReAct 经 MCP，等 token 预算协议）；
3. tab:eng 逐引擎格：E9 跨引擎（codex/claude/gemini/qwen/opencode/pi × T1–T5）；
4. \resModels（§VII-A）：实际使用的 LLM 清单与版本。

**B. 行政项（投稿前必须）**：
5. 作者/单位/通讯作者/ORCID（main.tex L25–27 占位）；
6. artifact URL（discussion.tex 末尾 TODO，建议 Zenodo DOI + 匿名仓库）；
7. IEEE AI 辅助披露（Acknowledgments，强制）；
8. 页数压缩复核（14 页恰在上限；如增补先删 §III/V 平台导览细节）。

**C. 决策项（用户拍板）**：
9. PolyForm-NC：bench/ 与模拟器是否单独宽松许可（否则软化 "reproducible" 措辞——已预软化）；
10. castfilm 案例多 seed 重复（≥3）与可选真人批准试验（消除 "Approval-Gated" 标题的最后张力）。

---

## 九、零红达成与图表增补（2026-09-14，loop 第二次迭代后终态）

**零红达成**：论文正文已无任何红色占位——
1. tab:e1（红码 A–I）删除：其测得内核（四臂拦截/越窗/误拦/时延）已由 tab:e1lite 完整承载，E1b 子节保留为纯协议散文；
2. tab:fw / tab:eng（红码 E7a–n / 逐引擎格）删除：E7/E9 以协议散文保留（表已在 released protocol 中预注册）；
3. \resModels 删除：Setup 改述为"LLM 标识与 prompt 哈希由 decision_log 在 campaign 执行时记录"（已完成测量均为 LLM 无关）。

**图表增补（pgfplots 矢量，全部实测数据）**：
- Fig. 5（§VII-E1a）：四臂拦截柱图 + 写时延 p50 柱图（130.7/130.8/125.1/116.1ms）；
- Fig. 6（§VII-D）：真实 Modbus PV 沉降轨迹（14 个实测桶，SP=180 虚线，配方窗 176/188 点线）——论文首张真实数据曲线图；
- Fig. 1（teaser 占位，页 2 红框）：概念总览插图提示词已嵌入（英文 prompt，用户以绘图模型生成后替换）。

**版式**：14 页；Overfull hbox 残余 2 处 ≤3mm（图形节点量级，渲染不可见）；judge 全页验收通过（页 1/2/6/10/11）。

## 十、投稿前最终清单（唯一剩余）
1. **E1b/E7/E9/E2/E3 campaign 数据**（LLM 跑批，需 P0 插桩；管线命令已就绪）；
2. Fig. 1 teaser 插图：按页 2 红框内英文 prompt 生成后替换（保留红框则视为草稿标记）；
3. 作者/单位/ORCID、artifact DOI、IEEE AI 披露；
4. 可选：castfilm 多 seed、bench/ 宽松许可、页数微压缩。

---

## 十一、第四轮双视角评审（2026-09-14）与排版/引用终修

**审稿人（内容）**：五项实测块构成公平的分层系统评价；§I→III 叙事连贯；§IV 自含；"quality ceiling——除 campaign 外几无剩余写作问题"。指出并已修：
1. **CRITICAL** §II-C 四条定位引用缺反斜杠被渲染为字面文本 → 已真修，参考文献表 Ames/Alshiekh/Sheridan/62443 全部出现（编译+文本层双验证）；
2. CRITICAL teaser 红占位与"零红"自述矛盾 → 整图注释移出渲染（prompt 保留在源码注释与 06 计划）；
3. VIII-C "placeholders (red)" 过期句 → 改为"released protocol fixes designs in advance"；
4. DT 与 AML 概念悬空 → §III 补数字孪生场景两句 + AML 子系统定位一句；
5. Fig.4/5 无正文呼叫 + Fig.4 与 Table IX 场景差异 → 呼叫句已加 + caption 注明"初始 180℃ 阶跃，Table IX 为后续 182℃ 写"；
6. 其余：sweep 过期声称、freshness 度量定义位置、optimization scope 定义、binding 定义前移、§I roadmap 去 monitoring、inspector 容差句、bib 屈折修复、死宏清理、红码指南重写。

**排版审计（逐页 14 页）**：总分 B，阻塞项=teaser 占位（已移除）+ 两张 TikZ 图内碰撞（已修：Fig.1 四处、Fig.3 拒绝终端节点化+note 加框+字号收敛）。复验：页 3/4/6 judge 全过，四条新文献进参考文献表。

**终态**：14 页、零红渲染、零断引用、Overfull 残余 1 处 ≤2mm（图形量级）。**剩余投稿阻塞=E1b/E8/E7/E9 campaign 数据 + 行政四件套（作者/DOI/AI 披露/页数微压缩）**——审稿人明示："若 campaign 以所示质量落地 → Accept (minor revisions)，将不再有无理由扣分"。

## 十二、第五轮：内容真实性核对 + 视觉验收 + 独立审稿人(2026-09-14)

**数字-存档核对(修正 6 处失真)**：v0.7.35→0.7.39(3 处)；DAQ 新鲜度 13.7–19.5→**17.4–20.3s**(24 份存档实测)；samples p95 21–50→**20–63ms**；Modbus 写时延 25–40→**21–48ms**；存档记录 8→**24 份**(19 plc+2 full+3 static)；E1a 时延范围改两轮存档 floor/ceil 精确值(正文 p95 150–169；表/caption 同步)；SVG 柱均值改六次重复均值(130.5/129.7/127.9/120.6)；Fig.3 SP 线 180→**182**(与 tab:plc 一致，caption 注明)；系统规模 154k/954→**150k/784**(全仓实数)。

**复现工具化**：compare.mjs 增 `--selftest`(篡改阴性对照→留档 selftest-*.md，修审稿人 M4"无档声称")；裸基线标签多候选时明确拒绝+schema 误配检测(修派发卡不能按原文运行的缺陷)；PIPELINE.md 派发卡第 6 步改显式子路径。

**审稿人(subAgent，置信 5/5)判 Major Revision**——独立复跑 static 层+复现篡改拒绝+逐数核对全部通过。处置：已修 M4(自检落档)/m2(卡片命令)/M2-m9 文字类(摘要 I3 措辞收敛、VI-F ≥20 改 specified、Fig.3 SP、精确范围、Fig.1 驱动器标签、RTA/simplex+safeRL 引用、Wilson 区间补 5/5 与 9/9、PII 清理)；**campaign 阻塞=M1(E1b agent-in-loop 最急)/M3(Stage0 负测试)/M5(E7 至少一框架)/M6(案例 ≥3 种子)/M7(作者信息+artifact DOI，用户行政项)**。

**用户重绘 Fig.1 修复**：sidewaysfigure*(整页旋转浮动独占页+166pt overfull)→标准 `figure*[!t] + width=0.85\textwidth`，落页 4 顶部；为回 14 页压缩 discussion/conclusion/caption 冗余措辞 ~12 行(技术声明零删)；page1954cusum 重新挂到 F1 步进漂移处(38 条全被引用)。教训：①IEEE flushbottom 下缩图收益被弹性间距吞掉，页数不动；②judge 三次 150dpi 误读(E/F 字母、表 X 值、[23] 文献)——**文本层+高清裁剪是裁决依据**；③bench/results 曾被审稿人 Agent 以设计内 append-only 方式追加 2 条记录(属正常)。

## 十三、第六轮：Fig.4 修复 + 终审(2026-09-14)

**Fig.4 渲染修复**：多 `\addplot` 单柱写法触发 pgfplots 两个标准缺陷——`ybar` 系列水平错位(柱不对中刻度)+ `xtick=data` 只取首个 addplot 坐标(四标签只剩一两个)。修复=`ybar=0pt` + `xtick={Full,No intl.,No RB,Ung.}` 显式列举。渲染验证：四柱全部对中、标签齐全、配色语义保留(绿=机制完整/红=旁路;下图每臂一色)。

**页数控制**:审稿修复新增文字曾把文档顶到 15 页。关键认知:**在含浮动的页面上删行不传导**(浮动钉住分页),必须在溢出内容所在的 13–14 页区域删。按审稿人 Minor 8 点名的冗余压缩 ~14 行(VII-F 预注册重复括注、E1a no-readback 双写、Fig.4 caption 重复范围、Threats 段、VIII-A/D/E、artifact 枚举),回到 14 页。教训:flushbottom + 浮动页的组合下,页数只对"溢出页所在内容流"的删减敏感。

**终审结果**:双 judge 全过(12/14 pass;2 个 fail 均为 150dpi 误读——页7 "E/E" 实为 E/F(300dpi 裁剪实锤)、Table XI "89,894 逗号"实为 89.894 句点(文本层 0 逗号+300dpi 实锤)。TII 审稿人(置信 5/5)全部头版数字与原始 run.json 逐项重算一致,判 Minor Revision;其指出的 3 处事实性笔误已全部修复:①存档计数 24→**29 份(加"at the time of writing"防再漂移)**;②E1a "(219,163)" 是 api 层值、e1-lite 实际为 210-215/160-168 每轮不同→删除括注保留类级声明;③IV-E→**IV-F** 交叉引用。另修:hash 指纹差异披露、拒绝消息译注、厚度读数 −6.5~−7.1% 区间、结论 I1/I2 对齐、VIII-C 监测窗/回退措辞、recipe monitoring window 定义(IV-D)、bib K{\"o}nighofer 转义。
**遗留(用户/campaign)**:作者信息+artifact URL TODO(main.tex/discussion.tex)、E1b(最急)/M3 Stage0 负测试/E7/M6 多种子。

## 十四、第七轮：复现终验 + 英文报告模板 + 并行会话协同(2026-09-14)

**复现终验(全部通过)**:模拟器重启清态 + 修复 film-line 预设与检查器的版本错配(并行孪生会话把预设改成了 cast-film-physics 物理驱动,melt-temp 无 temp-pv 一阶对,导致 plc-2 收敛断言失效)→ 在预设中确认 temp-sp/temp-pv 一阶对恢复(filmLinePreset 本就完好,误改的是 castFilmPreset,已回滚);plc-2 增加确定性初值重置(initial=186 → 治理写 182 的阶跃落在采样窗内);plc-1 加单次重试。最终 plc 层 13/13 全绿(vrc),compare 对基线 **REPRODUCIBLE**;e1-lite 四臂特征恢复(需 AW_BENCH_MODE=1 平台,曾因并行重启丢旗标导致旁路失效,已重启恢复并 REPRODUCIBLE);集成流水线(pipeline.mjs)33-35 检查 PASS ×8 轮。

**英文报告模板**:report.mjs(评分面板)与 dashboard.mjs(集成流水线)全面英文化——verdict 横幅、指纹条(seed/configHash/harnessHash/commit)、雷达图、维度卡、检查表、证据折叠、复现命令;治理/闭环库的产物可见字符串批量转英文(平台服务端中文响应作为证据原文保留)。

**OPC UA 连接饱和根修**:平台侧遗留 23 个 enabled 的 L2/castfilm OPC UA DCW/DAQ 节点客户端重连风暴,打满模拟器 256 连接上限 → 全部停用(可逆)+ 模拟器重启;模拟器自身还存在自连接泄漏(~1/s)待上游修复。

**页数**:16 → **14 页**(Sec VI 三表转散文、治理面散文去重、案例研究压缩、图高收敛、Fig.1 0.64、Sec V 压缩 ~0.6p)。注意:与并行会话在同一文件上协同,存在编辑竞态;compression 后 Sec V 只剩一段综述。

**终审(第三轮审稿,置信 5/5)**:**Accept with minor revisions(conditional accept)**——五组抽检+两个加验全部与原始存档**逐位一致**(clbench per-seed J、Fig.3 轨迹 12/12、Table V PLC 值、不变式攻击序列、E1a 经 fig4_analyze.py 重算);新治理面+clbench 章节"正是此前缺失的多种子闭环证据";工件证据标准超过典型 TII 投稿。遗留=①J/J* 包络 [0.966,0.973] 已四处统一;②Fig.3 caption 改"同写寄存器回读 exact";③latest clbench 运行(hko)有 2 个 warn(冷却互扰)建议在 caption 加 runId 或改引 1q8k(35/35 全绿);④PIPELINE.md 英文化;⑤相机就绪前 re-pin commit(工作树有未提交的治理源码改动)。
