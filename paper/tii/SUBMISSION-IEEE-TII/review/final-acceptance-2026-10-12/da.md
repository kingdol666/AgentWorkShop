# Devil's Advocate 终验盲审报告 — "Grading Machine-Originated Plant Writes: Separately Inspectable Evidence for Industrial Agent Teams"

- 席位: 第五席 Devil's Advocate(固定攻击席,不做平衡)
- 日期: 2026-10-12
- 审阅材料(仅限许可清单): main.tex、sections/{introduction,related,system,mechanisms,evaluation,discussion}.tex、resources/refs.bib、resources/results-macros.tex、main.pdf(p01–p10 渲染图已逐页查看)
- 纪律声明: 未读取任何 README/REVISION/RESPONSE/AUDIT/POLISH/MANIFEST/review/figures 材料;文中所有引文均逐字取自稿件本体;标注"推测"处为无法从稿件证实的推断。

---

## 1. 最强反方论证(Strongest Counter-Argument)

若我要在评审会上毙掉这篇论文,我会说:这是一份以研究论文形式提交的系统自测报告。它的全部证据由同一作者、同一代码库、同一 harness、同一组自写模拟器闭环产生——提案者、实现者、测试者、判卷者四位一体;论文自己承认这是 "an author-defined regression instrument, not an external certification",且 "the primary comparator is internal"。标题与摘要向读者出售"治理 LLM 智能体对工业对象的写入",但 Q1–Q4 全部过程任务的写入来自 scripted policy;唯一的两次真引擎运行判据只是"转录本中的完成标记",而转录本已被日志保留规则销毁;威胁模型里的"失控行为体"从未由真实模型扮演。两个旗舰机制(三级确认分级、line master switch)晚于过程任务快照才加入,仅由同月自建脚本验证,而 Q5 主战役又把开关置于 automatic。社区基准 Tennessee Eastman 与 SWaT 就躺在参考文献库里未被使用,作者选择了自写工厂、自定谓词、自定 J、自造故障。所有对照都是定义性的:关掉检查,检查自然不再拦截。工程纪律值得尊敬,但作为 TII 研究,声明—证据契约不成立。

---

## 2. 问题清单

### CRITICAL(不改无法通过评审)

**CR-1 论文的 titular 对象(机器/LLM 产生的写入)在主体证据中不存在;唯一涉 LLM 的物证已被销毁**
- 维度: 声明-证据契约 / 确认偏误
- 位置: main.tex:74–76, 94–99(摘要);sections/evaluation.tex:167–169, 189–196;sections/discussion.tex:27–30, 93–96;PDF p.1, p.8, p.10
- 原文短引: "a scripted policy rather than a language model issued the writes (two live engine turns follow)";"the run's pass criterion is a completion marker in the transcript";"The two live engine-turn console transcripts (Section V-D) were excluded by the repository's log-retention rule and survive only as recorded outcomes";"The threat model is a misbehaving or manipulated agent (wrong or hallucinated proposals)... no adversarial injection campaign or approval-dialog operator study is reported"
- 攻击: 题目、摘要与动机全部以"LLM agents acting on plants"立论,但 Q1–Q4 的每一次"governed write"都由作者脚本发出;治理层最核心的卖点——围堵一个幻觉/被操纵的提议者——从未被一个真实模型压测过。仅有的两次 live-engine 运行发生在 scratch line 上,判据是转录本里出现完成标记,而转录本本身已按日志保留规则销毁——论文主题的关键证据在物理上不可复核。系统章大书 14 个 engine adapters、112 个 channels 的"agent team",其"引擎可替换"主张仅由 2 次无档运行支撑。这不是措辞问题,而是:论文标题所描述的现象没有被实验制造出来。
- 自保所需: (a) 将 live-engine 任务纳入主战役(不止 scratch line),归档并公开转录本;(b) 加入脚本化 adversarial-proposer 臂(越界提案、in-window 有害序列、伪造 verdict、重复写入/振荡、approval 卡面注入文本),展示治理层按设计响应——无需真 LLM 也可先补对抗臂,但至少一次真实模型失败案例是题目成立的前提;(c) 否则将题目/摘要降格为 "machine-originated proposals"(不特指 LLM)并相应收缩动机。

**CR-2 全部证据为 internal-oracle 自证:命题、实现、测试、判卷、工厂、故障、谓词同源;对照皆为定义性;社区基准在库不用**
- 维度: 逻辑链 / cherry-picking / 替代路径
- 位置: sections/evaluation.tex:53–55, 66–68, 72–75, 79–84, 319–321;sections/system.tex:58–60;sections/discussion.tex:14–25;resources/refs.bib:226–235(downsw1993tep/TEP)、237–244(goh2017swat/SWaT);PDF p.6–p.9
- 原文短引: "an author-defined regression instrument, not an external certification";"No prior system in Table I owns a governed write path to plant endpoints, so the primary comparator is internal";"the success-flag outcome is definitional---the pre-hardening harness itself reported a broker puback as success";"they are deterministic per seed, not validated digital twins";"Across the five questions, Section IV's mechanisms behave as specified"
- 攻击: 五个问题的每一个"通过"都由同一工件定义、执行并判定。两个归档对照臂均为自比定义操作(去掉 interlock 看拦截消失;把报告规则从 success-flag 换成 graded 看标签变化);规划中的 admin-REST 对照臂实测 24/24 双臂全拒、未产生任何区分数据,却被重述为 "gate evidence"——把失败实验转记为支持性证据,是典型 cherry-picking 结构。工厂动态、扰动、故障注入点(frozen measurement、broker cut、publish-only endpoint)恰好全部落在系统被设计去捕获的包络内;"honest grading"在自造故障上自证诚实。在库未用的 TEP 与 SWaT 条目表明作者知道存在社区基准而未采用。结论:"mechanisms behave as specified"在本设计下等价于"单元测试全部通过",不构成可失败的研究命题。
- 自保所需: 至少其一:(a) 一条 hardware-in-the-loop leg(真实 PLC / OPC-UA / Modbus 端点,哪怕单回路);(b) 一个社区过程基准上的完整任务;(c) 一个外部治理基线(现有 batch/DCS e-journal + 服务账号客户端)在同一故障集上的失效对照。若均不可行,须在摘要(而非仅 VI-B)声明"self-graded, internal-oracle evidence",并把论文定位为 design/architecture 记录。

### MAJOR

**MAJ-1 "fail-safe default is manual" 的直觉含义与机制现实存在系统性落差,治理豁免面共四处**
- 维度: 逻辑链 / 利益相关者
- 位置: main.tex:84–86(摘要);sections/mechanisms.tex:216–228, 230–235, 101–102;sections/discussion.tex:45–49, 66–67, 74–75;PDF p.1, p.6, p.9–10
- 原文短引: "a line master switch whose fail-safe default is manual intercepts approval-free recipe dispatch";"direct node-tool writes remain gated by their binding mode and the admission interval, not by the line switch";"the grant's execution mode is chosen at grant time rather than gated by the user-side confirmation";"The decision endpoint authenticates a user but does not enforce a line-scoped approver role";"AW\_BENCH\_MODE=1 admits harness-declared arms that relax the soft window or readback"
- 攻击: 安全官读者从摘要得到的印象是"默认该线必须人批才能写";机制现实是四条残余路径:(1) switch 只拦截 recipe-family × approval-free 组合,持有 automatic 直接节点绑定的成员在 manual 线上照写不误;(2) lead agent 可经 delegation 自选执行模式,绕过用户侧确认(论文自己称之为 "the one agent-reachable path around per-request approval",而修补只是 "queued guard");(3) 任何认证用户都是合格 approver,无 line-scoped role、无 segregation of duties;(4) bench-mode 环境变量今天在生产启动时不被拒绝("refused at production boot" 列在 production needs 清单里)。每条都在正文诚实披露,但摘要单句制造的保证强度与披露的碎片化位置之间的落差,正是治理系统论文最不能有的缺口。
- 自保所需: 摘要与结论一句明示 switch 的精确拦截范围与残余路径;把 delegation 模式封顶于 granter 自身 binding mode(现成设计,立即实现);approver role 检查进入实现;bench-mode 拒绝进入当前代码而非需求清单。

**MAJ-2 判决层是自报闭环:caller 的 keep 关掉 backstop;three-way check 属于 harness 而非平台,却被写进对比表的差异化特征**
- 维度: 逻辑链
- 位置: sections/mechanisms.tex:149–166, 177–192;sections/related.tex:45(Table I AgentWorkShop 行);PDF p.5–6, p.2
- 原文短引: "a scripted keep can coexist with a missed objective";"it evaluates only open records; a caller's keep closes the record and stands it down";"Three-way setpoint consistency is checked by the evaluation harness rather than the platform";Table I: "harness-checked three-way consistency"
- 攻击: 论文叙事中最"智能"的两道防线——verdict 与 backstop——都站在被治理者的自报之上:被怀疑的写入者可以用自己的 keep verdict 关闭记录并解除 backstop;平台"does not independently validate the evidence";被列入 Table I 差异化特征的 three-way consistency 其实是评估 harness 的属性,生产部署中不存在。于是 "separately inspectable evidence" 的终点是"请人类看日志"——这正是论文自认为超越的传统 DCS 审计做法。治理路径的独立校验环节实际为空。
- 自保所需: backstop 的解除与 caller verdict 解耦(keep 亦进入观察冷却或二次确认);three-way check 移入平台为可配置产品能力;Table I 中把 harness 属性与平台属性分开标注(或从该行删去 "harness-checked" 字样改为 "platform-side readback grading")。

**MAJ-3 旗舰机制晚于过程任务快照;主战役把标题机制置于关闭态**
- 维度: cherry-picking / 逻辑链
- 位置: sections/evaluation.tex:43–48;PDF p.6–7
- 原文短引: "mechanisms are unchanged since the Q1--Q4 snapshot except the October hardening pass's acknowledgment grading and master switch";"The harness sets the benchmark line's master switch to automatic by user-side confirmation---the automated path is the object under test"
- 攻击: 六大不变量中的两个(graded acknowledgment、line master switch)没有参与任何过程任务,仅由 7-leg 脚本的 leg 1–5 在合成故障上验证;Q5 的主闭环战役又以用户侧确认把 benchmark line 置为 automatic——标题机制在其最主要的战役中处于关闭态。四个过程场景展示的是 9 月 21 日的旧系统行为,架构章与机制章描述的是 10 月的新系统;两套系统从未在同一证据中同时出现。"graded acknowledgment" 的承诺对 Q1–Q4 的全部 25 个 governed writes 不成立(当时无分级)。
- 自保所需: 在十月 tier 上重跑至少一个过程任务覆盖 grading + manual-switch 拦截场景;或在摘要与贡献处显式标注 Q1–Q4 为 pre-grading/pre-switch system 的证据。

**MAJ-4 "deployment-scale" 实为单宿主上的 34 条仿真对象**
- 维度: 过度泛化
- 位置: main.tex:94–95(摘要);sections/evaluation.tex:29–35;PDF p.1, p.6
- 原文短引: "a deployment-scale regression campaign on one multi-line instance";"a live v0.7.57 instance carrying 34 provisioned lines, 112 agent channels...---simulator- and bench-backed objects, not physical plants; multi-line means many provisioned lines and channels on one host."
- 攻击: 工业读者从 "deployment-scale" 读出的是多站点、真实设备、生产负载;证据是单 Node.js 实例上 34 个仿真对象的自我负载测试。真实部署的决定性瓶颈——现场总线时序抖动、设备并发写入、网络分区、进程重启恢复、历史库增长——一项未测。正文在括号里如实定义 "multi-line",但摘要措辞的语义重心在 "deployment-scale"。
- 自保所需: 摘要改用 "single-host, 34 simulated lines" 级别的措辞;或补一条最小真机负载 leg 使该词有根。

**MAJ-5 更平庸的替代路径(现有 DCS/batch 治理 + LLM 服务账号客户端)未被构造、未被排除;ABAC/UCON 文献缺位**
- 维度: 替代路径
- 位置: sections/related.tex:68–86;sections/discussion.tex:3–7;PDF p.2, p.9
- 原文短引: "Permissions, range checks, approvals, and audit trails long existed in distributed-control-system (DCS) and SCADA practice";"Against that practice the difference is the proposer: a machine-generated agent identity rather than a presupposed human operator"
- 攻击: 论文自认机制全集(权限、限位、批准、审计、版本化 recipe、e-journal)是 DCS/21 CFR Part 11/ISA-88 实践的既有物,增量仅在 proposer 是机器。那么最短的替代路径是:把 LLM 作为现代 DCS/batch 管理系统的一个 per-role 服务账号接入现有 interlock 与 batch journal。该路径没有一个被展示的失败模式。而"逐请求按 live product/recipe 重查权限"在文献中就是 attribute-based access control(ABAC/UCON)的上下文条件重评估,论文未引用该分支,使核心新颖性主张悬置于未对比的邻域。
- 自保所需: 要么给出朴素替代的具体失效实验(如静态 role 授权在 recipe 切换/临时窗口时的过期授权),要么引用并逐维区分 ABAC/UCON/PBNM,把增量精确落在"机器身份 + 生产上下文 + 分级证据"的组合上。

**MAJ-6 统计脆弱:单种子单轨迹;BOPET 达标裕量 0.04 µm;同一归档 run 内 prose 与谓词相互矛盾;BOPET 时钟未归档**
- 维度: cherry-picking / 确认偏误
- 位置: sections/evaluation.tex:24–27, 180–185, 236–239;PDF p.6–8
- 原文短引: "Q1, Q2, and Q4 are single-trace case studies";"---0.04 µm inside the window; the same run's prose summary records it not attained while its machine-readable verdict records attained, so we report both; the verdict matches the archived predicate---the prose narration erred";"Mission clocks (26.48 s, 169.27 s, 102.76 s; BOPET's unarchived)"
- 攻击: 头条过程结果建立在单种子、单轨迹之上;BOPET 的达标裕量 0.04 µm 仅为窗口宽度的 2.9%,处于仿真记录分辨率的刀锋上;更严重的是同一归档 run 的 prose 层与机器谓词层相互矛盾——作者采纳了对达标有利的一侧,并解释为 "the prose narration erred"。这等于承认归档证据的叙述生成层会出错,直接削弱 VI-B "counts are re-derivable rather than trusted" 的证据学主张:如果 prose 层会错,哪些层可信、由谁仲裁?BOPET 时钟 "unarchived" 进一步暴露归档完备性有洞。
- 自保所需: 关键任务多种子重复;说明 prose 层的生成机制与该错误的根因;补 BOPET 时钟或写明缺失原因;报告达标裕量对观测噪声的灵敏度。

**MAJ-7 人类监督从未有人类参与:harness 自批;疲劳缓解的唯一证据是一次脚本化批量批准**
- 维度: 利益相关者 / so-what
- 位置: sections/evaluation.tex:126–128, 293–296;sections/discussion.tex:24–25, 40–45;PDF p.7, p.9
- 原文短引: "unblocks it on approval (latency 461 ms, harness-adjudicated and poll-dominated)";"harness-adjudicated approval (human decision latency and quality out of scope)";"batch release (Section V-G, leg 5) is the demonstrated fatigue mitigation"
- 攻击: 全部 HITL 数据由 harness 扮演人类产生;461 ms 是机器自批时延,"poll-dominated" 说明它连平台时延都代表不了;审批疲劳缓解的唯一证据是脚本执行的一次 6 参数批量批准;摘要却把 "mediating approval" 列为已演习能力。论文引用 Bainbridge(1983)与 Parasuraman(2000)承认风险,却没有任何人因数据。对一篇以 HITL 为支柱的治理论文,人类环节的证据集是空集。
- 自保所需: 小规模受控 operator study(n≥5 的批准任务:时延分布、误批率、对 graded evidence 的理解);或在摘要把 "mediating approval" 限定为 "harness-adjudicated approval mediation"。

**MAJ-8 治理层把写权限集中到单平台进程,其自身安全与可用性后果未评估;"every agent-originated path" 的全称断言缺少专门证据**
- 维度: 利益相关者 / 替代路径
- 位置: sections/system.tex:36–40, 101–102;sections/discussion.tex:59–63, 72–75;sections/mechanisms.tex:230–235;PDF p.3, p.10
- 原文短引: "The Node.js core hosts channel routing, industrial services, and protocol adapters";"a supervisor outage halts dispatch rather than permitting writes through";"every agent-originated path to the plant passes through the same governed write"
- 攻击: 该层把原本分散于各应用的写权限集中到一个平台进程及其 admin REST 面,成为单点妥协与单点故障:攻陷平台即获得 34 线、385 bindings 的全域写权限。"every agent-originated path passes through the same governed write" 成立的前提是 agent 身份无法触及 admin REST、line-switch 端点与 driver 层——这一隔离在稿件中是断言,S1 API-surface matrix 是否包含"agent 身份调 admin 面 = 拒绝"的负面用例未说明(推测包含,但稿件未写明)。split-brain、凭据生命周期、平台自身补丁均已列为 open 或未提。集中化是架构决策,其安全后果必须被论证而非默认。
- 自保所需: 一条"agent 身份触达 admin/switch 面 = 拒绝"的显式证据 leg;讨论平台妥协情景的爆炸半径与缓解路线;冗余部署(split-brain)从 open 项升级为至少定性分析。

### MINOR

**MIN-1 n≈6 的 p50/p95 是装饰性统计**
- 维度: cherry-picking(呈现)
- 位置: sections/evaluation.tex:102–106;PDF p.7
- 原文短引: "about 6 writes each, p50/p95: 47.8/248.9 ms (Modbus TCP)..."
- 攻击: 每协议约 6 个写入,其 p95 即准最大值;55 个 DAQ 样本对 "protocol closure" 的采集面主张同样单薄。给小样本报告分位数是伪统计。
- 自保: 报告原始 6 值或增大 N;分位数仅在有 n≥20 时使用。

**MIN-2 协议族计数 6/5/4 的三层嵌套误导**
- 维度: 过度泛化(呈现)
- 位置: sections/introduction.tex:41–44;sections/system.tex:52–57;PDF p.1, p.3
- 原文短引: "six protocol families (five instantiated as lines, four exercised for governed writes)";"an S7 stub that fails loudly until its driver lands"
- 攻击: 贡献 2 的首词是 "six",核心功能(受治理写入)实际覆盖 4/6;S7 是 stub,RTU 仅采集。括号披露诚实,但阅读印象由首词决定。
- 自保: 贡献句改为 "four exercised write families (of six declared)"。

**MIN-3 相关工作全称断言以单引文支撑**
- 维度: 过度泛化
- 位置: sections/introduction.tex:20–22;PDF p.1
- 原文短引: "Industrial LLM work to date is mostly generation, diagnosis, and single-domain control (e.g., [6])"
- 攻击: "mostly" 是对一个领域的全称概括,引文只有 Agents4PLC;jiang2026agentic 综述已在 related 出现却未前置支撑此句。
- 自保: 软化为 "much of" 并前置综述引文。

**MIN-4 Eq.(1) 是 DCS 硬限位的形式化;对 "learned feasibility model" 的对比是稻草人**
- 维度: 逻辑链(新颖性)
- 位置: sections/mechanisms.tex:66–87;PDF p.5
- 原文短引: "rejection is decidable and layer-attributable, where a learned feasibility model offers neither"
- 攻击: 硬/基线/产品/recipe 四层区间交集即经典 HIHI/LOLO + SP clamp + recipe 限值的分层实现;没有任何被引系统主张用 learned feasibility model 做准入,与之对比树立了假想敌。
- 自保: 把贡献重述为"分层可归因、可回放审计"的工程化与证据化,而非区间形式本身;删去或弱化 strawman 句。

**MIN-5 backstop 时序算术需一句话澄清**
- 维度: 逻辑链(一致性)
- 位置: sections/mechanisms.tex:184–190;resources/results-macros.tex:41(\resBackstop=130.2 s);PDF p.6, p.7
- 原文短引: "The policy waits 120 s, polls every 30 s, and fires on three out-of-window samples---cumulatively";"ends with a system-judged backstop rollback 130.2 s later"
- 攻击: 若计时锚点为写入关闭且首轮轮询在 120 s 后,三次采样最早需 120+60=180 s;130.2 s 与策略描述不符——除非样本可取自历史(cumulative),首轮即满足。稿件未说明锚点,读者只能猜。
- 自保: 一句话写明计时锚点与历史采样可行性。

**MIN-6 Table I 的对比维度由被比系统自选;自身行打包五项特征且含 harness 属性**
- 维度: cherry-picking(呈现)
- 位置: sections/related.tex:34–47;PDF p.2
- 原文短引: "\system{} & replaceable strategy slot & governed write path: admission, HITL, dispatch, readback & member--node bindings; line master switch; product/recipe-scoped limits & graded acknowledgment; harness-checked three-way consistency; attributed journal; compensation; backstop"
- 攻击: 维度集(write path / authority / write evidence)恰为自身特征集;先行系统的原生优势维度(实时控制、物理部署、工业验证)不在表内,故"每行皆输"由构造保证。
- 自保: 增加一列对方系统的原生优势(如 "physical deployment / real-time capability"),允许先行系统得分。

**MIN-7 Q3 报告 J/J* 又否认性能主张——免责式修辞堆叠**
- 维度: so-what(呈现)
- 位置: sections/evaluation.tex:199–212;PDF p.8
- 原文短引: "What the benchmark establishes is narrower: ... The claim is transparency of evidence handling, not a performance delta."
- 攻击: 报告 0.965–0.972 的比值就是在邀请性能解读,随后一句免责。全文多处采用"先给出诱读数字、后加限定"的结构(另见摘要 "deployment-scale"),评审印象由前者塑造、责任由后者豁免。
- 自保: 将 J/J* 降为脚注;统一"先限定、后数字"的陈述顺序。

**MIN-8 源文件卫生**
- 维度: 逻辑链(簿记一致性)
- 位置: resources/refs.bib:2;sections/mechanisms.tex:177
- 原文短引: "26 entries are cited by the manuscript and appear in the reference list"(实际编译 28 条);重复的 "\looseness=-1 \looseness=-1"
- 攻击: 投稿源码包内的自述计数与产物不符;重复宏为排版噪声。
- 自保: 更新注释;删除重复宏。

---

## 3. 被忽略的替代解释/路径

1. **"这只是 RBAC/ABAC + interlock + 审计日志换了机器提议者。"** 论文自认全部机制在 DCS/batch 实践中长期存在,增量仅在 proposer 身份;而逐请求上下文重查就是 ABAC 的条件属性重评估。论文未与这条最短替代路径对垒(见 MAJ-5)。
2. **"100% 自测通过 = 普通软件正确性,不是研究发现。"** "mechanisms behave as specified" 与"单元/回归套件通过"是同一命题的两种说法;五个问题只是把一套回归套件拆成五幕叙事。
3. **"三级分级的'诚实'是实现标签的直接结果,未受真实设备反例压力。"** publish-only endpoint、broker cut、frozen measurement 全部是作者构造的、恰好可被分级的故障;没有出现一个让分级规则本身尴尬的真实案例。
4. **"三源一致性 0.0 bar 误差是仿真透明性的同义反复。"** recipe 值、PLC readback、mirror sample 三条腿在作者实现的仿真中读取同一状态源;正文自认 "a fault fabricating the endpoint is a common-mode boundary"。检查从未在报告过的运行中失败过,其区分力未知。
5. **"任务达标 = 谓词与脚本策略同源。"** 谓词由作者随 blueprint 一起设定,scripted policy 与仿真器同为作者产物;"all four attain their archived predicates" 的信息量取决于三者独立性的缺失程度。
6. **"WWTP blower 与 annealing 回退事件展示的是策略选择,不是平台能力。"** "a bad proposal is rejected in the evidence, not at the admission gate" ——即准入层对 in-window 有害提案无能为力,安全性由调用方自己的 verdict 完成(见 MAJ-2)。
7. **"治理时延数字说明该路径按构造只适用于监督级节奏。"** "the loop's time is governance, not platform overhead"(25–245 s)对监督级写入是自洽设计,但也承认了对任何快过程的不适用——论文以 scope 声明处理了这一点,替代解释与设计意图一致,非缺陷。

---

## 4. 缺失的利益相关者视角

- **操作员/审批人**: 谁来批?任意认证用户皆是合格 approver、无 line-scoped role(MAJ-1);批卡信息密度、alarm 负载、自动化偏差对真实审批人的影响零数据;审批疲劳的"缓解"由脚本代证。
- **工艺工程师**: 四层限值(H/B/P/R)由谁、如何正确设定?限值错误即新的攻击面(过窄卡产、过宽放行);论文只说空交集会在首次写入时暴露,未提供限值来源验证方法。blueprint ensure pass "repairs drift" 在工厂语境下若触及设备侧配置,本身是一次未经 governed write 的面向对象的变更(推测现仅限平台侧 provisioning,稿件未划界)。
- **安全官(Security)**: 平台集中化爆炸半径、admin 面隔离、凭据生命周期、split-brain 未评估(MAJ-8);bench-mode 标志的启动期治理(MAJ-1)。
- **功能安全工程师**: 与 SIS/IEC 61511 的界面仅一句("neither a safety instrumented function nor a plant-protection substitute");backstop 的一步回退与 safe-state 的关系未讨论。
- **集成商/调试方**: 贡献 2 主张 "reusable integration boundary",但复用成本零度量(无工时、无 LOC、无配置项统计);唯一证据是"第二 preset 由纯配置commissioned"。
- **监管/QA(制药、食品)**: "approval treated as workflow mediation---attribution and timestamp, not an electronic signature"——在 21 CFR Part 11 辖区这是部署阻断项,论文将其列入 production needs 而非设计目标;归因链止于 "member" 身份,到人问责链断裂。
- **生产管理**: supervisor outage 使 dispatch 停摆、pacing 窗口(60 s/300 s)对产能节奏的影响、审批等待(180 s 超时即拒绝)对产量的量化影响未评估——治理的可用性成本全篇无数字。

---

## 5. 观察项(非缺陷)

1. results-macros.tex 保留了被替代/未用的指标(WWTP 成本 181.5→179.1、\resBackstopDrill 134.7 s 与 130.2 s 的取舍说明、单 run 诊断值被三 run 区间替代的原因),并写明缘由——这是少见的内部审计痕迹,值得保持;WWTP 成本数据若属实,考虑入正文可部分回应 so-what。
2. \resConsistencyErr = 0.0 bar 且注释自认 "all three legs equal exactly at the endpoint's recording resolution"——检查从未失败过;建议在正文主动披露其"从未触发"的先验,以免读者误读为强验证。
3. 摘要末句与 VI-B 的五条限定是全文最坚硬的部分;若编辑部要求压缩篇幅,请勿牺牲这两处。
4. Fig. 2 需要在图注里声明 "Governance Agent" 不是模型,说明该命名本身易误导;建议改名 "Governance Pipeline"。
5. hold heartbeats 作为 "the one non-governed re-dispatch" 且 "trailing a narrowed window"——干净的设计让步,值得在结论中重申以保持声明-证据对称。
6. refs.bib 含大量未引用条目(ReAct、AutoGen、AgentBench、TEP、SWaT 等),头注已声明未审计;若投稿打包 .bib 请注意体积与 TEP/SWaT "在库不用"的观感(与 CR-2 相关)。
7. results-macros 注释泄露内部仓库路径与文件名(ARTIFACT-NOTES.md、docs/benchmarks/...);对双盲一般无害,但建议投稿版注释中性化。
8. 协议探针每线 6 条(第一 preset)与每线 3 条(第二 preset)不一致,33=24+9 算术正确但强度不对齐,一句话即可说明。

---

## 6. "so what" 测试

**若全部机制成立,工业界获得的真实增量是什么?**
四项:(i) 写入确认从"传输成功"升级为三级分级且 fail-honest(成熟 DCS 的 write-verify 已有,但对 LLM 客户生态是新工程规范);(ii) 面向机器提议者的、按 product/recipe 逐请求解析的准入与机器身份归因审计;(iii) recipe 派发的 fail-safe 默认人工闸;(iv) "prompt 不是权限"从原则落为实现。合计是一个**扎实的平台/工具论文**与一套可复用的设计模式。

**它不是什么**: 不是过程收益(无优化受益主张)、不是安全保证(明示放弃)、不是人类监督的验证(harness 代批)、不是 LLM 有效性的证据(转录本已销毁)——后三者论文在结论中自认 "stay unsupported claims"。

**是否足以支撑一篇 TII 论文?** 这正是编辑部必须裁决的问题。支持接收的理由:LLM-agent 工业治理的时间窗价值、罕见的声明-证据纪律(graded evidence、internal-oracle 自白、归档可复算)、六协议四写入族的覆盖面。反对的理由:全部证据 internal-oracle 自证(CR-2)、标题现象未被实验制造(CR-1)、机制层与既有工业实践的差异收敛于"提议者身份"一个维度而该维度未与最短替代路径对垒(MAJ-5)。以魔鬼代言人的立场:**当前形态更像一篇 boundary-setting + system description 论文;按 TII 传统证据标准(工业应用 + 外部效度)应要求 CR-1/CR-2 补强后重审;若编辑部按"早期治理架构记录"定位接收,两条 CRITICAL 也应以文字降格(题目/摘要措辞)为最低门槛处理,而不能仅靠正文已有的分散披露抵账。**

---

*报告完。本报告仅为编辑部裁决输入;所有引文逐字取自投稿稿件本体,未依赖任何外部评审/审计文档。*
