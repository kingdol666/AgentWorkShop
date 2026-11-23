# 集成实测轮汇报(2026-11-19 17:33 起 — 2026-11-20 凌晨收口)——任务清单·耗时根因·问题定性

- 实例:AW 0.13.0 全新隔离 home(:3021,pid 180032)+ 影子孪生(:4054,pid 164024,归属证明 bundle 在档)
- 执行模型:omp rpc / ustc-deepseek-flash(全部真实回合;无 mock leader)
- 证据:本目录 57 份 phase-*.json;私有凭据只在 D:/tmp/aw-liv2-1119/
- 驱动脚本:scripts/experiments/tsa2-phase-{s,c,p,p1}.mjs(断点续跑式)

---

## 一、已完成的任务(全部有盘上证据)

| # | 任务 | 结果 | 关键证据 |
|---|---|---|---|
| G1 | AW 隔离实例 + IDD/RAG 插件集成 | ✅ | 实例健康 v0.13.0;IDD/RAG token 铸造+热配;插件 12 个 failures=0;工具面 155,含 14 桥工具+9 通讯/记忆工具(phase-s-*) |
| G2 | 真实工况文档→产线接入 | ✅ | sim-twin 孪生 :4054 归属证明成立;onboard.mjs 一键 **7/7**(供给 20/0、锻造 15/0、V1–V6 24/0+V6 SKIP、冒烟步自动 HITL 批准→下发→设备证实 1/1,runId rr-75fb1979);落袋 线 ln-db7a857c / 配方 rc-ef8e2b37 / 频道 830b81f3(lead+3worker)(phase-l-line-onboarding.json) |
| G3a | 绑线 Channel·看到(数采分析) | ✅ | 早班巡检真实回合:lead 调 daq_query 多节点,量化判读「克重 31.46g,低于下限 32.15g」,先派工 3 个子任务(基线审计/调优方案/写入失败取证)后亲自收口(phase-c2-c1-reply.json) |
| G3b | 绑线 Channel·控制(受控下发 R1) | ✅ | 保压压力SP 54→55MPa:审批卡 ap-a4b70de1,choice=0 人工批准→下发→**独立回读 55=55(read.ok=true)**→journal 锚(source=agent,approvalId/recipeRunId rr-097b5a6b 全关联);worker 交付物含量程/步限核验与数据依据 n=41(phase-c2-c2-*) |
| G3c | 受控下发 R2(第二治理写) | ✅ | 保压时间SP 3.5→4.0s:卡 ap-ac9341ce 批准→**回读 4=4**→journal 锚+rr-1c5e9bcc(phase-c2-c3-*) |
| G3d | RSI 多轮优化闭环 | ✅ | 反射器自动产出 **3 条 line 作用域 candidate(2 正 1 负)**→单条晋升被门正确拒(独立任务样本 1/2)→R1+R2 merge(任务证据锚 ×2)→人工晋升 validated→**agent token 越权晋升 401**(phase-c2-c4-*) |
| G3e | 会话经验记忆管理 | ✅ | lead `save_memory` line 作用域沉淀(dedupKey=…:line:ln-db7a857c:…,importance 0.9)+`search_memory` 召回回报命中(phase-c2-c5-reply.json) |
| G3f | 治理负例 | ✅ | 越量程写 **400 NODE_RANGE_EXCEEDED**(四层限界交集说明在消息体);跨用户写 **403 LINE_FORBIDDEN**(phase-c2-c6-*) |
| G4 | 产线 Project 编排 | 🟡 机制链全通,执行被上游中断 | 真实 leader 规划(plan v1,审批卡 25943312)→人工批准→leader 自动物化三级依赖链(基线→差距量化→结论汇总);基线项:我的手工项按先例撤销,leader 物化项 3 次 ROOT_TIMEOUT 后,缩小口径的重试项 **a3d05337 COMPLETED**(attempt2)→reconcile→submit→**L1 reviewed**→下游 ae654001 成功派发(handoff 门 WORKING)(phase-p2-p1-*) |
| G5 | 非产线落地页 Project(双频道协同) | 🟡 设计腿全通,实现腿被上游中断 | 双 generic 频道(设计组 46a82c21/实现组 2525e717)+依赖交付物;真实 leader 规划并**自动物化** W1/W2(重复手工项已按先例撤销);**W1 设计简报 COMPLETED**:508 行《FlowPilot 流航》设计简报+183 行 copy-deck(工作区实文件,质量为可直接投产级)→reconcile→submit→L1 reviewed→**W2 携 handoff bundle 派发**;实现 Agent 在工作区自建 verify-landing.mjs 自测脚本,还出现**跨频道硬口径传达**(模板频道→任务实例,21:06:04);W2 HTML 实现 2 次 ROOT_TIMEOUT,attempt3 于 23:40 派发新实例 f227a2bb 后遇上游瘫痪(phase-p2-p2-*) |
| — | 全程监控与纠偏 | ✅ | 看门狗停滞催办、D1 救援两次(绑线频道/任务实例)均生效;失败全部如实落 FAILED+ROOT_TIMEOUT,零数据损坏、零越权写入 |

## 二、为什么做了这么久(时间根因分解,按占比)

1. **omp/ustc 上游夜间严重劣化(主因,约占 70% 等待)**。`deepseek-flash` 单回合 40s–4min 且频道内执行锁串行;从 20 点起任务实例的 lead 回合反复撞 15min 监督硬超时(`supervise hard timeout(900000ms) → abort`),凌晨 00:36 起 **`omp RPC ready 超时(10s)` 循环 + Harness PROCESS_EXIT 重建循环——上游彻底不可用**,直接终止了 P1/P2 的在途执行。这与 11-17/11-18 两轮记录的「omp 上游不稳+15min 硬超时吞回合」是同一现象。
2. **计划物化时延(约 15%)**:leader 提出 plan 后到 `plan.applied` 物化工作项间隔约 15 分钟(18:09 提案→18:24 物化);期间我按上一轮口径手工建项,随后与 leader 物化重复,按既定先例(撤手工、留 leader)处置,来回多花约 30 分钟。
3. **我的驱动缺陷(约 10%,全部已修正并留痕)**:
   - C1/C2 首捕证据抓到的是「任务派工简报」而非最终交付(已改捕并在 `phase-c2-c1-reply-firstcapture-note.json` 留修正史);
   - C4 首查团队记忆列表(经验条目实际挂在 lead agent 名下)误报 0 候选——SQLite 直查证明数据一直在,属**查询面口径错误,非系统丢数据**;
   - C6 负例首次因 journal 形状解析错误未发出请求(no-node),手工重发后 400/403 正确;
   - P1 驱动只盯 observability.plan 字段,漏了 `/approvals` 上的 pending 计划卡,多等了一轮。
4. **防御链生效但每次重试成本高(约 5%)**:看门狗催办、D1 救援(两次均成功解卡)、retry/attempt 预算、ROOT_TIMEOUT 如实落账——每次失败重试的墙钟代价 30–60 分钟。

## 三、问题定性:哪些是真问题,哪些不是

**是真问题(系统性,但非本轮新发现,且防线全部按设计工作):**
1. **omp 上游单点+慢烧**:执行模型可用性直接决定整个编排体系的吞吐;15min 硬超时 × 慢模型 = 高失败率。平台侧行为正确(失败如实、不盲派、不假验收、可重试、可救援),但**「上游健康度感知→降级/换 harness」目前没有自动策略**,这是真实的产品缺口(11-08 架构评审 robustness-7 的延续)。
2. **计划物化与手工建项的重复窗口**:leader plan 从提案到物化 15 分钟,期间 API 建项会撞重复——已有先例可依,但值得做成「物化期间建项软锁/提示」。
3. **observability.plan 字段不反映 pending 审批卡**:计划卡在 /approvals 可见但 observability.plan=null,自动化监控容易漏判(本轮驱动就漏了)。

**不是系统问题(我的问题,已修正留痕):**
- 证据首捕口径、C4 查询面、C6 解析、驱动 plan 轮询——全部是脚本缺陷,平台数据与状态始终正确。
- 两次重复物化按既定先例处置,非数据损坏。

**功能正确性判定(本轮新增证据,全部成立):**
- 治理写:2/2 步 HITL→下发→独立回读相等(55=55、4=4),journal/审批/批次全链关联;
- 负例:400/403/401/gate 拒四个面全部按设计拒绝,无一漏防;
- RSI:多轮任务→candidate(含负样本)→门拒→merge→人工晋升→agent 401 全链真实发生;
- 记忆:line 作用域沉淀+召回命中,dedupKey 语义正确;
- Project 机制:leader 真实规划、依赖链、handoff 门(RESULT_SUBMISSION→TECHNICAL_REVIEW 两级闸实测 409 拦截)、L1、双账号线程全部按设计工作;
- 双频道协同:设计→实现 handoff、跨频道口径传达、任务实例工作区真实产物(brief/copy-deck/自测脚本)全部落盘。

## 四、当前状态与收口口径

- 凌晨 00:37 起 omp 上游不可用,AW :3021 停止监听(进程随上游反复重建后退出);**P1 剩两步(差距量化→结论汇总)、P2 剩一步(W2 attempt3)未走完,属执行中断,非机制失败**——三个工作项的派发/交接/评审/撤重链条均已实证。
- 遗留两个 🟡 项的性质与 11-19 完整度报告口径一致:编排机制已验证,长链执行受制于上游稳定性。
- 模拟器 :4054 与实例 :3021 未做破坏性清理,待你裁决后收窗(或明日上游恢复后一键续跑:`tsa2-phase-p1.mjs` / `tsa2-phase-p.mjs` 均断点续跑)。

## 五、一句话结论

**六大任务中四项全绿(G1 栈/G2 产线/G3 绑线作业/G3 记忆与负例),两项(G4/G5)机制链全通但收尾执行被 omp 上游深夜瘫痪打断;慢的根因 70% 在上游模型而非平台逻辑;本轮发现的 3 个真实产品缺口(上游健康度感知降级、物化窗口重复、observability 计划字段)全部有证据、有先例、可排期。**
