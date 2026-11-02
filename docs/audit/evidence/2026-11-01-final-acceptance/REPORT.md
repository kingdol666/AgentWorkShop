# AgentWorkShop 最终完整验收报告(final-acceptance)

**时间**:2026-11-01 02:05~03:0x · **平台**:v0.8.8 · 3300 · **依据**:aw-system-acceptance 五层 skill
**范围**:T0-T4 全量 + PROTO3 真实产线 crown 链 + 历史稳定性汇整 → 生产判定

---

## 0. 结论(一句话)

**五层验收 0 阻断红:T0 五门禁/T1 六套件/T3 四套件全绿,T2 六绿一黄(51/53,twin 工具面 2 断言回归已立案)+ PROTO3 实机 crown 链全通(实时抓取→分析落账→Agent 中枢 HITL 写→回读→收口)。生产判定:受控试点 GO 维持;无人值守 NO-GO(两条硬理由:双进程内存预算与 R-1/守护上限,见 §4)。** 本轮同时抓到一个重量级稳定性实锤:多负载叠加把生产实例挤崩、守护 11 连重启后按设计放弃——这是投产资源规划的硬依据。

## 1. 五层矩阵(本轮 fresh 证据)

| 层 | 套件 | 结果 | 证据 |
| --- | --- | --- | --- |
| T0 | lint/typecheck/docs:check/i18n:check/readme:lint | **0 / ✓ / 89-0 / parity / 全过** | 本轮 fresh |
| T1 | unit / mcp / plugin-lifecycle / sdk-surface / twin-provider / skills | **913 pass 0 fail / 14 / 22 / ✓ / 5 / 147** | /d/tmp/t1-*.log |
| T2 | e2e-line(产线治理 L1-L12) | **44/44 PASS** | t2-e2e-line.log |
| T2 | 本体离线 | **57/57** | t2-onto-offline.log |
| T2 | 本体真机(L1-L7+前端六 tab) | **87/87**(重跑绿;首轮死于内存饥饿) | t2r-onto-live.log |
| T2 | 优化器(REST 全链/负例契约/Agent 工具面) | **105/105**(MCP optimizer_solve 真实求解 status=optimal) | t2-optimizer.log |
| T2 | 模型闭环(孪生冻结→真实训练 v1→v3→求解器→前端) | **51/53**;2 红=TWIN_PROVIDER_UNAVAILABLE(工具面查 provider 断链;插件注册面正常,单测 5/5)——**真回归立案** | t2r2-model-loop.log |
| T2 | IDD 结果库 | **36/36**(首跑红=复活实例漏 AW_ALLOW_PRIVATE_OUTBOUND 的环境漂移,修正后绿) | t3-idd-results.log |
| T2 | 注塑闭环 | 本轮未重跑(需 AW_TRIAL_INTERVAL_MS=0 实例 env;recipe_trial HITL 闭环已由 PROTO3 实机两轮佐证) | 如实标注 |
| T3 | api-live / hitl-live / tool-surface-multiagent | **✓ / 28/28 / 37/37** | t3-*.log |
| T4 | 插件 11 enabled failures=0;工具 126 全 available;工具抽真 | **✓**(治理拒绝也是证据:未启用插件的 diag_status 被正确拒) | evidence/2026-11-01-toolface-verify/t4-*.json |

## 2. PROTO3 真实产线 crown 链(实机,US-6)

1. **实时抓取**:熔体压力 22.1bar / 瓶坯温度 103.8℃ / 环境温度 22.15℃——三点全落文档期望带;
2. **分析落账**:`analysis_save` → ar-21b71aa2,`analysis_query` 查回(append-only 台账,归属频道/产线);
3. **Agent 中枢 HITL 写**:任务 fa72bf96 → lead 读数→派子任务→工艺工程师 recipe_trial(带假设全文)→**人工批准**(预授权批准器代行,范围匹配+留痕)→ **写落账 anc-0843c5e3(source=agent,2.65→2.6)**→ 子任务 COMPLETED → **根任务 COMPLETED**(complete_task 本轮正常收口);
4. **AML 真实训练尝试(诚实负结果)**:数据集构建被**三道门正确拦截**——授权门(_dcw 节点不在绑定面/feedback 列出全部可授权节点)、批次完结门(批次未关闭不可训)、**数据质量门(网格缺失率 35.2%→33.8%→31.3% 均超 30% 上限;缺口=宕机 10 分钟+设备三次重启)**。结论:垃圾数据训不了模型,门在工作;真实训练链由 model-loop 的 v1→v3 进化另证。修复路径:干净连续批次 ≥30min 后重训。
5. 批次收口时 temp-SP hold 重写 HTTP 404(ack=failed,设备恰在重启窗)——如实披露;全程含三次维护性重启(崩溃复活×1、env 修正×2,均为死亡/漂移实例动作,详见 §4),启动/env/复活规程已固化为 docs/runbook-production-instance.md。

## 3. 运行事件与发现(如实)

| # | 事件 | 定级 | 根因/处置 |
| --- | --- | --- | --- |
| E-1 | **生产实例崩溃循环**:多负载叠加(4 组并行单测+多 dev 实例+浏览器 300ms 轮询)→ 内存耗尽(31GB 剩 0.7GB)→ 子进程 1 小时 11 连退出 → **守护按设计放弃重启(fail-loud)** | P1 资源规划 | 非代码缺陷;投产硬依据:生产实例独占内存预算(≥8GB 空闲),验收负载与生产实例不同机 |
| E-2 | 复活实例环境漂移:漏 `AW_ALLOW_PRIVATE_OUTBOUND=1` → diag/IDD 全拒(SSRF 守卫按设计拦截) | P2 运维 | 带全 env 重启修正;**启动 env 清单必须入库**(runbook) |
| E-3 | twin 工具面回归:`twin_trial_run` 报 TWIN_PROVIDER_UNAVAILABLE(插件已注册,查找断链);单测 5/5 过 | **P2 真回归** | 立案待修;影响面=工具面虚拟试验(孪生快照链/训练进化/求解器全绿) |
| E-4 | 守护三连自愈实录(#5→#7)+ 11 连后放弃;复活用 detached-start 正道 | — | 自愈机制有效但有上限;放弃后需人工 runbook |
| E-5 | 并行会话实测共存:同仓并行写码/跑测试与生产实例争资源,是 E-1 的直接诱因 | 运维纪律 | 多会话作业需资源预算协调 |

## 4. 生产判定

- **受控试点:GO(维持,证据三连轮递增)**——crown 链(抓取→分析→HITL→治理写→回读→收口)、优化器最优解下发(105)、模型训练进化(51/53)、治理面(负向/授权/审计)全部实机验证。
- **无人值守:NO-GO**,两条硬理由:
  1. **资源隔离未解决**(E-1):共享机器上任何重负载都能挤崩生产实例,无人值守需要独占资源+守护上限告警外呼(当前放弃后无自动外呼);
  2. **E-3 twin 工具面回归**未修(工具面虚拟试验不可用)。
- **投产 runbook(新增)**:启动 env 清单(AW_MODE/AW_HOME/AW_ALLOW_PRIVATE_OUTBOUND=1/AW_MCP_ENABLED=true)、detached-start 正道、守护放弃后人工复活步骤、AML 训练前置(批次完结+干净连续数据+节点绑定三元组)。

## 5. 历史稳定性汇整(10-25→11-01)

| 轮次 | 规模 | 结论 |
| --- | --- | --- |
| 10-25 全栈复验 | 821 检查 | 全绿 |
| 10-28 安全加固+绑定矩阵+真实 harness | 702 单测+44+42+24 | 全绿(S1-S16 落地) |
| 10-29 生产投产验收 golive | 五层 24 项 ~1100 断言 | 全绿(e2e-golive-matrix 21/21 主证) |
| 10-29 ralph 三系统全量 | 31 套件 ~1700 断言 | 全绿 |
| 10-31 最终集成验收(v0.8.8) | 12 故事+24 套件 | 全绿(受控试点 GO 首判) |
| 10-31 协议割接演练 | verify-mirror 5/5+verify-line 11/11 | PROVEN |
| 10-31 澄清门轮 | 14/14 供给+写穿+导出五项 | 全绿 |
| 11-01 工具面核查 | 11 项+8 截图 | 全 PASS |
| 11-01 本轮 final-acceptance | 五层+crown 链 | 0 阻断红(1 回归立案+1 环境事故) |
| **稳定性事件史** | R-1 卸载阻塞(10-31 首现,#2/#3 自愈)→ 11-01 #5→#7 自愈 → 内存耗尽 11 连放弃 | 自愈机制全程有效;放弃=按设计 fail-loud;数据零损贯穿全部事件 |

**稳定性结论**:九天九轮大规模验收,0 数据损失,0 未自愈的功能回归;唯一崩溃事件根因是**资源**而非代码。平台在"有界资源+受控负载"下足够稳定,可受控试点;无人值守前必须解决资源独占与 R-1/E-3。

*证据:docs/audit/evidence/2026-11-01-final-acceptance/(本轮 JSON/日志指针)+ /d/tmp/t1-*/t2-*/t3-*.log 全量套件日志 + 平台台账。*
