> **Historical plan, superseded on 2026-09-17.** Do not treat the implementation guarantees or old benchmark counts below as current evidence. The active revision is described in `REVISION-SUMMARY.md`, `reviews/evidence-ledger-20260917.md`, and the six sources under `figures/publication/`.

# TII 论文重构规划(2026-09-17)

## 目标
把论文重心改为"把系统设计思路、功能、所有模块及模块间协作讲清楚":删除原第 V 部分
(benchmark 实验协议设计, E1–E9/B1–B8),III 写整体架构,IV 写六大核心机制+闭环作业
流程+HITL, V 写真实 benchmark 测试,VI/VII 顺主体微调。

## 新结构(7 节)
- **I Introduction**(改):贡献 C3 去掉 E8/\ref{sec:bench}(原"released designs"叙述),
  改为可执行 benchmark + 冻结基线机器复现判定;C1–C4 的章节指针更新为 III/IV/V。
- **II Related Work**(微调):"Sec.~III-B 告警链""Sec.~III-F 对象树"改指新 IV 小节;
  框架基线句改为"defined over the same MCP tool surface(未测)"。
- **III System Architecture**(重写 system.tex → 纯整体):
  A 是什么(集成框架、单进程单数据域、五个入口面、Fig.1 架构图);
  B 设计原则 P1–P4;C 三个平面+治理桥+统一数据域(概览级);
  D 端到端协作走读(从建模到闭环的一段叙事,逐站前向引用 IV.A–IV.G)。
- **IV Core Mechanisms**(新 mechanisms.tex,吸收 pipeline.tex 全部+system.tex 细节+algorithms.tex 孤儿内容):
  - A Node Connection and Creation(sec:nodes):五协议驱动+mock;设备→集成导出→driverConfig
    推导→连通测试→节点创建;语义卡内容(单位/精度/硬量程/窗口/带warn/2%步长);
    边缘运行时三节拍;网关 250ms sweep、配额 64、旋转游标防饿死。
  - B Agent Channel(sec:channel):channel=lead+workers+任务树7态+邮箱;监督回路(1s tick、
    指纹跳过、事件唤醒);规则引擎(FIFO+最短队列+最长空闲、重试≤3、300s stall 看门狗);
    LLM 负责目标判断;14 引擎注册表+能力矩阵+allow-list 探测;混合记忆(FTS5 中文一元分词+
    sqlite-vec,RRF k=60,0.5ρ+0.3φ+0.2ι,MMR λ=0.7,三层注入 500 token,70% 压缩回收);
    插件宿主(热重载/UI插槽/i18n/ctx.services,无直连 I/O);跨通道 lead 门控消息。
  - C Node Control Execution(sec:writepath):device/node/writable node 形式化,Eq.(1) C(n,r)
    双支;双独立遏制机制;Algorithm 1 阶段(1)–(6)(阶段(0)指见 IV-G);Eq.(2) τ(n) 回读
    闭环+degraded 显式降级;签名 journal 锚+审计去重;不变量 I1/I2。
  - D Production-Line Operations Management(sec:lineops):line/product/recipe/run 对象树,
    run 绑定 版本↔批次 = 治理上下文 W_r(p);批次门控采样(批间 PLC 侧保护仍在);
    告警状态机(ok/warn/alarm/offline,8%带,2%迟滞,3帧去抖,水位线,人工确认+15min升级);
    存储(TimescaleDB 500ms 批刷/MinIO 帧/SQLite WAL+FTS5);审计+运维日志(类型化归因);
    数字孪生注册表+三影面+WS 总线,场景即建模编辑器(watch-only)。
  - E Agent Closed-Loop Control(sec:loop):**插入 Fig. fig3-agentteam-loop(AgentTeam 中心
    +Tools/Plugins/PLC Nodes/Recipes 四 spokes+AgentLoop 1-6+K=2 回边)**;作业流程六步:
    observe(daq_query)→propose(dcw_control 开优化记录,步长≤2% span)→govern(联锁/审批/
    回读)→actuate→verify·judge(dcw_judge 判 keep/rollback/uncertain,判定≠执行)→learn(记忆);
    基线冻结(T_bl=600s)、T_win=120s 后每 T_re=30s 重评、越窗 B=3 → 系统回退判定、K=2 上限、
    回退目标=基线(更细粒度操作员调用)、回退写走同一管线、网关暂停则延迟(fail-safe);
    30min 陈旧记录接管、300s 同向冷却;不变量 I3。
  - F Recipe Management and Rollback(sec:recipe):版本化非破坏(编辑→n+1)、known-good 冻结、
    known-good 回退重下发、一键 apply;run 绑定;越窗两条有界出口(<K 自动回退→强制人工)。
  - G HITL: The Human Control Boundary(sec:hitl):绑定模式 manual/auto/unbound=控制边界
    (是绑定属性不是 prompt);审批门机制(节点+记录去重、lapse、决策-执行解耦——裁决后
    全阶段重跑,防审议期改配方利用);审批队列多入口(web+TUI 同一队列);三重分立
    (判定≠执行、lead-only 工具、告警人工确认);信任边界(引擎是特权本地进程、注入威胁、
    allow-list 探测+最小权限+IEC 62443 分区,sanctioned path 内 prompt 无法扩权);F6 降级 fail-safe。
- **V Benchmark Evaluation**(evaluation.tex 改造):
  新增 A 节"Benchmark Protocol and Data Layers"(sec:protocol):三原则(确定性/分层真实度/
  可执行协议)、Table L1–L4、任务 T1–T5 与故障 F1–F6 一句话保留词汇、B1 消融开关定义、
  B2+ 基线组"已在公开协议定义、本文未测"、指标三族、复现协议(冻结基线+compare 门+自检,
  temperature-0/模型钉定);其余全部实测小节原样保留(port/static+dynamic/plc/govsurface/
  clbench/e1a/case/repro+walkthrough 图);修正:Scope 段去掉 released-designs 章节引用、
  sec:repro 的 [0.965,0.973]→[0.962,0.973]、删">90 run records"具体计数、
  sec:case 的 sec:bench 引用改"released protocol"、硬编码 IV-D→\ref。
- **VI Discussion**(微调):sanctioned path 引用→\ref{sec:hitl};"(B2–B8) released designs"
  改"agent-in-the-loop baselines defined in the released protocol, not reported here"。
- **VII Conclusion**(微调):per-seed 区间→[0.962,0.973];"remaining campaigns released as
  executable protocol designs"→"defined in \bench{}'s released protocol"。

## 文件操作
- 新建 sections/mechanisms.tex;重写 sections/system.tex;改 evaluation/introduction/related/discussion;
  main.tex 输入:pipeline+benchmark 两行替换为 mechanisms;
  git rm sections/pipeline.tex sections/benchmark.tex sections/algorithms.tex(内容已吸收)。

## 自查清单(已核)
1. 全部 \ref/\label 可解析:sec:bench 删除后 grep 全文清零;新增 sec:nodes/channel/
   writepath/lineops/loop/recipe/hitl/mech/protocol 标签;硬编码"Sec.~IV-B/IV-D/III-B/
   III-C/III-F"全部替换为 \ref。
2. 机制零丢失:Algorithm 1、Eq.(1)(2)、I1–I3、backstop 常数组、审批解耦重跑、信任边界、
   记忆公式、监督常数逐项迁移(机制与不变量保留勿删约束)。
3. 用户点名的六机制各占一节,顺序与需求一致;闭环作业流程 + HITL 单独成节;fig3 入 IV-E。
4. 真实性:未测基线仍如实声明未测;所有数字来自实测小节;T1–T5/F1–F6/B1 词汇保留使
   V 部分引用自洽。
5. TII 规范:III 概览+IV 深度的经典布局;贡献-章节对应;measured vs designed 分层标注
   (Table layers);threats to validity 保留;图表全部来自真实运行档案。
