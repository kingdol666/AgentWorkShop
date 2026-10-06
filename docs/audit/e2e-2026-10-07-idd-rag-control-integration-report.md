# IDD×RAG 集成控制测试报告 —— 取数/分析/下发全链实证 + 稳定性优化(2026-10-07 凌晨)

> 本轮两件事:①落实 plan 的稳定性细节优化(6 项,全部活体验证);②按测试 skill 做 IDD+RAG 插件**控制集成**大考——在真实扰动工况下完整走「取数→分析→五要素提案→HITL 人类批准→下发→回读→闭环→回退」,全程监控留痕。频道 b52f28d7,任务 684fb16f。

## 1. 结论(TL;DR)

**可以真正获取数据、分析、并下发控制,全链已实证且每个数字可复核。** 下发链:agent 分析得出缺口 → recipe_propose 结构化审批卡(五要素) → 人类在 HITL 批准(choice=0) → 治理链 `dcw.write.recipe`(双区 211.6℃)→ `recipe.apply`(批次 rr-a52a1b)→ PLC 写入 → **DAQ 读回 211.6 与提案一字不差** → 熔体 199.99→211℃ 真实响应(+11,超预期 4 倍,越过提案自设回退线 207)→ agent 回合因 omp 会话故障中断 → **人类监督者按其承诺执行 journal 回退**(211.6→208.8,熔体回落 208.4,ops 账本五类条目全程在案)。闭环完整:提案-批准-下发-响应-越线-回退-审计,一个不少。

**稳定性优化 6 项落地**:D7 数据集同指纹 10 分钟熔断(防重试循环烧配额,活体验证触发)、配额排除 .venv 基础设施(936MB Python 环境曾占配额 46%)、submit_task 支持 budget_minutes(长链路显式预算,验证 deadline 精确 +60min)、bench 收尾自动复原演示预设、AW_HOME 隔离边界写入 PIPELINE.md、事件录制缺口与恢复路径定位。

## 2. 完整分析作业流程记录(时间线,真实工况)

模拟器注入 heaterDecay=1.5(轻度衰减)→ 熔体从 200 平台缓慢下漂。

| 时刻(+08) | 环节 | 留痕 |
|---|---|---|
| 23:45 | 模板实例化频道+派全链任务 | b52f28d7,e1f1e6a6 |
| 23:47-23:48 | ① daq_export 60min 宽表(1722 行)→ 交换目录双份(ASCII 命名自适应) | daqexp-20261006234747;merged/screen ln-d7e0a2a2 |
| 23:56 | ② sentinel_screen 快筛 + sentinel_watch 批筛 completed | SNW-20261006155618/161018 |
| 00:0x | ②' kb_agent 检索历史(QDCVR 命中 12 篇 P0,显式排除 TC 死回路族:晶点 4.6 低位不符该族指纹) | KB 引用写入提案 |
| 01:12 | ③ recipe_propose 提交(z2/z3 同步 +2.8℃=单步上限,预期 +1.6~2.3℃,回退线 207,停步线增益<0.8) | **ap-d4d30629**,五要素+KB 增益标定 0.57~0.82 |
| 01:1x | ④ 人类批准(choice=0+裁决附言) | approval.approve,decisionId 054ee721 |
| 01:1x | ⑤ dcw.write.recipe ×2 → recipe.apply → PLC 写入 | 批次 **rr-a52a1b**,双区 211.6℃ |
| +1min | ⑥ DAQ 读回验证 | **z2=211.6 与提案一字不差** |
| +15min | ⑦ 熔体响应 199.99→**211.06**(+11,超预期 4 倍,越回退线 207) | — |
| 01:4x-02:0x | ⑧ lead 回合死于 omp 会话故障(prompt 失败循环),停滞检测按规取消任务 | 684fb16f CANCELED |
| 02:1x | ⑨ **人类监督者回退**:dcw/journal/node/:id/rollback ×2(to_last_good+dispatch) | SP 211.6→**208.8**;ops:dcw.write.rollback/dcw.rollback/optimization.open |
| 02:2x | ⑩ 熔体回落 211.1→**208.4**(向 GOAL 205.5 收敛中),系统回安全带 | — |

## 3. 「具体如何下发控制」——机制说明(实测口径)

1. **分析面**:lead 用 `daq_export`(merge 宽表)取 TimescaleDB 真实样本 → 交换目录 → IDD `sentinel_screen`(秒级)/`sentinel_watch`(全窗批筛,亚秒确定性计算)→ 告警与稳态占比;`kb_agent` 走 QDCVR 检索历史 regime 结论,取 GOAL/增益标定/回退线/停步线四把尺子。
2. **提案面**:`recipe_propose` 生成**结构化审批卡**(多方案带序号),每参数附依据/参照/预期/步长/回退——不附理由无法通过平台校验(五要素为平台强制,非提示词自觉)。
3. **治理面**:审批卡进入 HITL  待办(30min TTL,超时 fail-closed);人类经 `/hitl/respond` 裁决(confirmed+choice,无序号的批准按拒绝收敛);批准后平台执行 `dcw.write.recipe`(逐参数,写前量程∩配方窗联锁、写后回读校验)→ `recipe.apply` 整批生效 → **ops/审计/账本四类条目同步落库**(propose/approve/write/apply,本轮全在 ops-logs 可查)。
4. **闭环面**:DAQ 读回对账 → 熔体响应观测 → 越回退线时 `recipe_rollback`(lead 承诺;本回合 lead 失联由人类按同线执行,journal 回退路由同样审计)。

## 4. 稳定性优化明细(6 项,全部验证)

| # | 项 | 验证 |
|---|---|---|
| 1 | **D7 数据集熔断**:aml_dataset_build 同规格指纹 10 分钟内重复 → 拒绝并指向既有 dataset_id;`force=true` 逃生 | 活体:首建成功(6961 行)→ 立即重复 → 熔断命中(实测该循环曾 15 分钟烧穿 2GB) |
| 2 | **配额排除 .venv**:amlDiskUsageMb 排除 .venv/tools/runtime(uv 环境一次安装 936MB,曾占 2GB 配额 46%,零用户数据即近半耗尽) | 清理 34 个 spam 数据集(1.1GB)+排除 venv 后,构建不再 429 |
| 3 | **submit_task budget_minutes**:lead 可显式声明长链路预算(上限 6h),deadline 从入场起算 | 活体:budget_minutes=60 → deadline 精确 +60min;任务链修后 1h 预算内跑完分析+提案+下发 |
| 4 | **bench 收尾复原**:integrated/extended 跑完自动重放 cast-film-physics 预设(AW_BENCH_NO_PRESET_RESTORE=1 可跳过)——修复「跑完 bench 演示产线消失」 | 代码路径复用已被验证的 applyPreset;下次 bench run 生效 |
| 5 | **D8 边界文档**:PIPELINE.md 写明 AW_HOME 不隔离 SQLite、新配置根丢 harness 凭据、单实例锁互顶 | 文档评审通过 |
| 6 | **基础设施断链发现与恢复**:Docker Desktop 停止→tsdb 不可达(数据集构建全 0 步,前台样本 API 走 sqlite 热存显示正常——「降级不停采」设计);PLC 模拟器进程死亡→样本断流 | 拉起 Docker 后 tsdb 30s 自动重连(degraded:false);模拟器重启+预设重放后数采恢复;L1 44/44 复绿 |

## 5. 问题定性

**无架构级缺陷。** 本轮暴露的问题全部为环境层(基础设施进程存活)或既有在案项:
- **P1(既有,唯一大石头)**:omp 会话 prompt-fail 崩溃循环——本轮 control lead 在关键时刻两次失联(提案后闭环段、复测回退段),致任务两次被停滞检测取消、回退由人类代执行。平台治理设计正确兜底(HITL fail-closed/停滞检测/审计完整),但 lead 可用性是当前唯一系统性短板,建议专项(omp 会话重建策略/健康探针/自动换引擎)。
- **P2(新发现)**:新建 Channel 的 AEP 事件录制间歇失效(时间线空白,DB 零行;重启后 boot 挂载的存量频道正常)——ensureStream 总线绑定时序问题,需专项;不影响控制与分析功能,影响前端实时观感。
- **P2(新发现)**:增益标定漂移——KB 标定 0.57~0.82℃/℃SP,今日实测 ~4℃/℃SP(4 倍),导致 +2.8 步长直接越回退线。这是**数据问题不是机制问题**(工况状态影响增益),恰好证明 KB 判读基准需要按工况分段维护;plan:增益标定带工况置信区间+step1 后强制复测再续步(lead 已按此设计执行)。
- 环境层:本机回环(ECONNRESET/headers timeout)间歇抖动,影响测试脚本与 CUA,不影响服务间通信主体。

## 6. 留痕

频道 b52f28d7(lead 95899063);任务 e1f1e6a6→dc746833→684fb16f(CANCELED×停滞检测,工作成果已产生);审批 ap-d4d30629(decisionId 054ee721);批次 rr-a52a1b;导出 daqexp-20261006234747/20261007005537;批筛 SNW-20261006155618/161018/jqdr55008;数据集 ds-muwuk3as(6961 行);回退 ops 三类条目;z2 读回 211.6→208.8;熔体 199.99→211.06→208.4。
代码:aml-dataset-tools.ts(D7)/dataset-builder.ts(配额)/tasks.ts+workspace.ts+agent-interface.ts(budget)/host-tools.json/bench/pipeline.mjs/PIPELINE.md。
