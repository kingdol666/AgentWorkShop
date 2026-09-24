# 攻击面完整清单 — 多轮模拟评审 2026-09-24

> 结构：第一轮 5 位独立审稿人（功能安全 / LLM系统 / 工厂实践 / 评测方法学 / 怀疑派AE）各 8-12 点；
> 第二轮 2 位红队以 rebuttal 阶段身份攻击拟入文的 DEFENSE-SAFETY-HITL.md 辩护词。
> 一轮总体建议：R1 Major、R2 Major(borderline)、R3 **Reject**、R4 Major(若不补实验则Reject)、R5 Major(不降级标题等同Reject)。
> 上一轮 SIMULATED-REVIEW.md 的 4 个已知 P0（无对照臂/LLM证据薄/复用无外部验证/记忆未证明）不再单列，下面全部是**新增或加深**的攻击面。

---

## S 级：多篇共识、直指贡献存在性（最高优先）

### S1. 全链路自指评测（4/5 审稿人：R2·R3·R4·R5）
模拟器、J* oracle、attainment 谓词、越窗探针、83 检查套件、脚本策略全部同源（作者+同一代码库）。
- 最狠的具体证据（R4）：单节点 mission 脚本策略写入 **204.704 = 判据窗口 204.704±0.75 的精确中心**——策略被编码了答案，这不是搜索。
- TEP/SWaT 已被引用却一个 replay 都没跑；选择自写模拟器而放着公开基准不用，本身需要解释。
- 挡法：TEP 或 SWaT replay 过 governed path（只考治理/证据层）；预注册并哈希冻结判据与探针集；声明策略只能经治理 API 观测。

### S2. "Agent-Team" 品牌与证据倒置（R2·R4·R5 + 红队双方确认）
全部定量结果由脚本策略产出；两轮 live turn 均未进入 team 回路（无 lead 分解/N-plan/检索 agent/judge 路径的任何 LLM 定量指标）；goal turn 自选目标（52.0±0.8µm 不匹配任何归档谓词）、自判 verdict、自存配方——**在构造上就不可能被平台验证**。Fig.3 的 "governance agent" 是确定性区间运算+定时器，术语注水。
- 挡法：LLM 臂跑一个多节点 mission 与脚本臂同任务并排（≥5 seeds，报 token/成本/失败率/拦截 LLM 提案案例）；或标题与贡献降级为 "governed execution layer"。

### S3. 拦截指标同义反复 + 探针同源（R1·R2·R3·R4）
"intercepts every configured out-of-window probe" ≈ "配了区间然后测了区间外的值被拒"。缺边界值/单位错配/跨参数联合约束/时序竞争探针；"无误拦"分母约 7 次；Table I 消融跑在与五协议线分离的 companion fixture 上（归因不迁移）；no-readback 臂 null by construction；三次确定性重复方差为零。
- 挡法：独立探针分类学（每类≥30）+ 消融在真实协议线上重跑 + "structurally unbypassable" 限定到 agent 路由（mechanisms 自列五路由不同 guards，其余四路由探针覆盖为零）。

### S4. 证据链自身有洞（R1·R2·R3·R4）
以证据保存为核心贡献的系统：`signed history` 只在图注（签名对象/密钥/防篡改模型全缺）；records 缺 run identifier；"device may accept a write even if bookkeeping fails"=可存在不入账的写入；旗舰 campaign 丢失 BOPET mission clock；快照缺 simulator-tree 指纹；SQLite 与被审计进程同驻。
- 挡法：write-ahead intent record（工程量小、与 evidence-states 叙事天然契合）；补 run id；"signed/immutable" 撤词或给出哈希链方案；从日志重导 BOPET 时钟。

### S5. 无对照且"没有分母"（R2·R3·R4·R5）
比"无 ungoverned 臂"更宽：无固定配方基线、无经典优化器臂（爬山/BO）、无治理开销差分（raw driver vs governed path 延迟/存储增量）、无接入成本对照（Fig.1(a) 稻草人从未实例化——"the rebuild is where duplicated drivers accumulate" 是全文经济立足点却零数字）。"thin"、"reusable" 无分母。
- 挡法：差分开销臂 n≥1000；单场景 naive 集成臂（LOC/漏掉证据态数/越界写结局）；同场景爬山与 BO 各≥10 seeds。

---

## A 级：机制/安全设计被指认的具体缺陷

### A1. HITL 可自配绕过（R1，红队确认"被加重"）
binding 创建只需 operate 权限，无任何文本限制谁能选 automatic 模式 → 被治理者可自我开通免审通道；评估中唯一 HITL 演练是 461ms **自动**往返——全文无一个真人上过审批回路。
- 挡法：binding 模式选择须独立角色（commissioning）授权；5-10 真人 ×20 请求小实验（报漏拒率/false-approval 率）；或明确声明 LLM-origin 写入不得配 automatic 并说明如何强制。

### A2. 审批-执行 TOCTOU 语境脱钩（R1，红队确认）
审批不锁区间不锁设备状态：人在区间 I₁ 下批准 (v)，recipe 切换后按 I₂ 复检通过即执行——人批准的决策与执行的动作不再是同一个。_expiry 只管超时不管语境变更。
- 挡法：语境变更使 pending 失效重走审批；或执行前 diff 展示强制再确认；最小 drill = 批准与执行之间切 recipe，展示 abort。

### A3. Backstop 的三个结构缺陷（R1·R2 + 红队新发现最危险一条）
(a) **de-arm 条款**：少于两条已回滚保留记录才恢复 → 共因故障（坏配方同时掀翻多回路）时恢复力自动解除，且未列入 §limits 局限清单；(b) **只评估 open records**——错误 "keep" verdict 把记录移出 backstop 作用域，即**最危险的失败模式（自信的错误自证）在结构上处于兜底之外**（红队 RT-B 发现，论文自己的 WWTP/annealing 回退全部是 verdict 阶段调用方自纠，backstop 从未真正抓过一次）；(c) 补偿写入无设备侧确认，记录可显示已恢复而过程未恢复；120s/30s/3点 固定节奏对相差 6 倍以上的场景时标无分析。
- 挡法：de-arm 预算耗尽态告警至人并入 limits；rollback 补偿加设备 readback + "rollback-unconfirmed" 证据态；快慢两个时标 fixture 各跑 drill。

### A4. 治理只管数值不管意图（R1·R2·R5）
Eq.(1) 是静态单参数区间交集：无速率/方向/跨变量/累计效应项。论文自己的 WWTP（两次 admissible 写入造成合规边际损失）与 annealing（176 m/min 执行后才回退）实证了"在窗写入才是真实危害"。goal turn 的三件事——自选目标、自造模型（h∝N/v 本是作者写进模拟器的）、自存配方——全部畅通无阻。**agent 自存配方 = 把影响持久化进未来 admission 上下文**（配方项进 Eq.(1)、参数经 dispatch 逐个下发），被操纵 agent 可持久化影响（红队 RT-B）。
- 挡法：value-only governance 升格为一级局限；构造 in-window 但 process-adverse 的对抗提案展示执行前拦截；recipe-save 纳入审批边界。

### A5. 无注入威胁模型，且辩护词把它写成已有缓解（R2 + 红队 RT-B 判"被加重"）
goal 文本、KB 检索、agent 自写记忆（跨任务 stored-injection 向量）皆可塑造提案意图；五条路由的差异化 guard 区分的是写入来源类型不是影响来源；admission 只见最终数值。related.tex 自认 injection 研究只 "inform adjacent evaluations"。
- 挡法：明示威胁模型（"text is untrusted; only typed values at admission are trusted"）；注入式 goal/记忆投毒 drill（in-window 错误 setpoint 下 admission+verdict+backstop 是否把后果限制在窗内）；**改写为 bounded-blast-radius 主张而非意图防御**——这才是证据撑得住的版本。

### A6. "advisory setpoint" 自相矛盾（红队 RT-A 新发现，全文最重的新靶子）
README/辩护词说 agent 写入是 advisory、产线侧可否决；但论文评测明文 "the write takes effect at the device"，且 automatic binding 明文省略审批等待——**写入直达设备，advisory 一词在机制上无对应物**。
- 挡法：删 "advisory" 或改写为 "subject to device-side limits and plant-side veto"，并指认该否决的具体机制。

### A7. demand-rate / 共因 / safe state 零分析（R1）
"非 SIF" 免责不覆盖"框架改变了既有保护层赖以成立的需求假设"：每 30s 一次、无限持续的合法写入（且 recipe/rollback/heartbeat 路由豁免 write lock）是新的 initiating cause；无 FMEA/LOPA、无框架失效 safe state 定义（"line stop closes records" 只是记账清理）、无响应时间要求。ISA-18.2 "in the spirit of" 挂名反而加重（18.2 本体是 rationalization，一项未做；且自动回退按 18.2/IEC 62682 根本不是 alarm，是控制/保护动作——标准错置）。
- 挡法：加 hazard analysis 小节（initiating causes + demand-rate 定性论证 + 失效安全动作）；"alarm-style" 改为 "automatically actuated supervisory recovery action with ISA-18.2-style annunciation"。

### A8. 语义卡无交叉验证：错标定静默毒化 admission（R3）
单位/标定/字序错误的语义卡产生"内部完全自洽但物理错误"的区间——所有 check 全绿直到产品出问题。无与 EDS/GSD/companion spec 的交叉校验，driver tests 是作者写的。
- 挡法：标定故障注入实验（哪些层发现、哪些静默通过）；量纲一致性检查。

### A9. 测量模型不真实（R3）
在线硬度（实为实验室取样，几十分钟延迟）、注塑单件重量（实为离线抽检）被模拟为实时连续信号——闭环前提在所选场景不成立；verdict 基于陈旧证据判 keep 恰是真实产线最脆弱处。freshness 也不在 admission 侧把关。
- 挡法：保留测量真实的量（DO、测厚仪）；或显式建模采样延迟稀疏性并展示 verdict/backstop 行为；admission/verdict 前加 freshness 门。

### A10. AW_BENCH_MODE=1：生产运行时内未鉴权的治理旁路（R1·R2·R4 三人命中）
env 变量绕过 post-write hold，无授权/无审计/证据中不区分；且论文未声明证据运行是否置位了它——若置位，"full governance" 名不副实。
- 挡法：改为鉴权的服务模式切换 + 证据记录落模式字段；声明全部归档运行的取值。一句话可修，必须修。

---

## B 级：评测与定位的其余可修攻击

| # | 攻击点 | 来源 | 要点与挡法 |
|---|---|---|---|
| B1 | n=1、seed-42、零方差重复、无阴性对照 | R4·R5·R3 | 每 mission ≥20 初始态报达成率区间；加阴性臂（错配蓝图/容差减半）展示 COMPLETED+miss 被记录——"task 状态与达标分离"这一卖点从未演示过一次 |
| B2 | 并发是四条不相交产线，无争用 | R1·R4 | 同节点双主体竞争 drill；并发扫描 1/2/4/8 线报延迟/cadence 抖动；BOPET 时钟缺失与"raw reports 全归档"自相矛盾 |
| B3 | 四 mission 零扰动 | R3 | APC 价值场景是扰动抑制不是从 A 走到 B；加中途扰动注入，报检测时延/verdict 质量/**off-spec 物料量**（backstop 120s+3点滞后内的不良品，工厂评估第一指标） |
| B4 | ISA-88/95 子集断裂：无 run 标识、line-start 非原子、无换型语义 | R3 | 共线多产品/换型场景下记录无法回答"这次写入解释哪个 run 的质量"；加 run id + 换型实验，或明确收窄 domain |
| B5 | MOC 完全缺席；ensure-pass 自动"修复漂移"生产配置 | R3 | 受监管工厂不可接受；ensure-pass 生产配置变更强制走 governed path+双签，或明示生产部署前提是外挂 MOC |
| B6 | J* 不透明一维 oracle | R4 | J 无公式、J* 计算方法未说明、决策变量一维——0.969 是搜索空间平凡性的属性；给出定义+搬到 ≥3 维场景 |
| B7 | 83/83 检查套件不可枚举、与 claim 无映射 | R4·R5 | 附录给检查→claim 映射；从结论性证据链降级为工程回归 |
| B8 | LLM 层不可审计 | R2 | 引擎/模型/版本、token/成本/重试/失败率、≥1 次 engine-swap 复现 |
| B9 | "Reusable" 证据是作者自己 harness 内的 0 行切换 | R5·R4 | onboarding 成本量化（LOC/工时分解）+ 非作者独立接入一个场景；做不到则降级措辞 |
| B10 | 最近邻文献双缺：R2R/APC 血统 + LLM-agent 运行时治理线（CaMeL/AgentSpec/GuardAgent/R-Judge/ToolEmu） | R3·R5 + 红队 | governed lifecycle 重造了 R2R prescription 纪律却未引一词；与 CaMeL 相比在注入轴严格更弱、在"独立裁判"轴是唯一由被评者自证的方向；**唯一站得住的差异化 = 无 LLM 的确定性强制基座包着物理写入（带设备 readback 与工业台账）——那条线守护软件工具调用，没有一家拥有实体写入路径；定位为互补（其策略可编译到本基座）** |
| B11 | 对既有 DCS/MES 栈的增量未证明：平行治理通道 vs 单一权威记录 | R3·R5 | 用跨参数联合约束（DCS 单回路限值表达不了的）做增量实验；写明部署拓扑（框架在 DCS 之上，DCS 为最终权威） |
| B12 | 治理魔数无依据 | R3 | writeLock/backstop 常数在时标差 6 倍的场景原样复用；参数化+敏感性分析 |
| B13 | 未评测能力系统性陈列（记忆/孪生/插件/引擎互换） | R5·R2 | capability-status 表（evaluated/exercised/implemented-only/designed）；摘要只保留 evaluated 层 |
| B14 | 标题三词超载：Agent-Team / Reusable / Optimization | R5 | 全部定量证据不支撑这三个词；改题主语落在受测对象（governed supervisory write path） |
| B15 | HMI 对比句无基线且与"工程师已走此路径"句互相矛盾 | R2·红队 | 要么实测对比要么降为假设；两句必须自洽 |

---

## 辩护词（DEFENSE-SAFETY-HITL.md）红队裁决：**修订后再入文**

一轮 R1 立场：六条机制性反对一条未化解、两条被加重；二轮 RT-B：注入断言把"缺失"恶化为"虚假声称"。**五处可被反杀的让步，入文前必须删除或降格：**

1. **(B)"advisory at the supervisory layer"** — 与评测原文 "the write takes effect at the device" 直接矛盾。→ 改写或删。
2. **(D)"prompt injection is met with source-dependent checks at admission"** — 无机制无实验；recipe 持久化影响路径使它更糟。→ 改为 bounded-blast-radius 主张（值域被夹、权限逐绑定、动作可归因）。
3. **(A) HMI 对比句** — 自认未测且与主流 DCS 点级限值/审计实践相悖。→ 降为 untested hypothesis 或实测。
4. **(C)"staged, revocable trust tier"** — 实际只有 manual/auto 二元标志，模式选择自服务，撤销从未被实验行使。→ 改为 "a per-binding policy choice (approval-required or automatic), revocable"。
5. **(F)"the receiving device is an independent check"** — 驱动契约只有 writability+可选 readback；Table I no-readback 臂 18/18 与全治理无差。→ 删或降为 transport echo 表述。
6. 另：de-arm 条款挂在 Section sec:limits 上但该清单**没有**这一条——交叉引用不实，须先补入 limits 再引。
7. (G)"oversight consumes the evidence record itself" 须加限定（records 缺 run id、记账可失败），(E) driver-acceptance 独立证据态无 drill 支撑须降格，(H) "deployment obligations on a stated path" 中 fail-closed/SoD 无实现路径应改为 future work。

**红队确认辩护词真正站得住的部分**：无形式化保证的自认、approval 非主要防线（检查不依赖审批）、approval 不预留区间/设备状态的复检机制、边界诚实性。这些保留。

---

## 最小实验包（性价比排序，挡住 S 级全部 + A 级大半）

1. **TEP 或 SWaT replay 过 governed path**（只考治理/证据层，不考优化性能，与 scope 一致）→ 废掉 S1 外部效度攻击。
2. **LLM 臂 vs 脚本臂同任务并排**（一个多节点 mission，≥5 seeds，报 token/失败/拦截 LLM 提案案例）→ 废掉 S2。
3. **独立探针分类学**（边界值/单位错配/跨参数联合/时序竞争/非 agent 路由各 ≥30，由未参与门实现的工具生成）+ 合法写入 ≥50/线 → 废掉 S3。
4. **失效注入矩阵**（驱动超时/bookkeeping 失败/审批过期/在途 recipe 切换/mid-mission 撤销）每类 ≥10 → 兑现 evidence-states 卖点。
5. **差分开销臂**（raw driver vs governed，n≥1000）+ **接入成本对照**（同一新场景框架内外各接一遍）→ 给 thin/reusable 分母。
6. **多种子 + 阴性对照臂**（每 mission ≥20 初始态；错配蓝图/容差减半展示 COMPLETED+miss 入档）→ 废掉 B1。
7. **真实人审批小实验**（5-10 人 ×20 请求含应拒项）或机制修复（binding 模式授权独立角色）→ 废掉 A1。
8. **文字级快修**：run id、de-arm 入 limits、signed/immutable 撤词或给哈希链、AW_BENCH_MODE 鉴权+审计、recipe-save 入审批、advisory 措辞修正、alarm-style 改写。
