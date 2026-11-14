# IDD × RAG × Channel 真实作业验收报告

> 日期:2026-11-14/15
> 环境:隔离 `AW_HOME`、IDD `:3210`、RAG backend `:8771` / web `:6789`、AgentWorkShop `:3994`
> 执行模型:omp + `ustc/deepseek-flash`(Channel 级 LLM,effort=max)
> 边界:**模拟产线(mock DCW/DAQ)**,不是物理 HIL;所有设备写入均走 HITL 且为测试工况;Mimosa 不构成安全结论。

## 1. 案例

- 产线:`IDD-RAG产线-iddragb7en`(`ln-1e3fbd3d`),BOPET 薄膜工况
- 配方:`稳态工艺` v1,熔体压力设定 6.2 bar
- 数采:熔体温度、挤出压力双节点,mock 驱动,1s 采样
- 数据窗:2026-11-14 22:34:46 ~ 22:45:19(+08),609 点/节点
- Channel:`IDD-RAG诊断频道-iddragb7en`,omp lead + omp worker,启用 `diag-bridge` + `rag-bridge`,绑定产线,LLM=`ustc/deepseek-flash`

## 2. 执行链与结果

| 步骤 | 结果 | 证据 |
|---|---|---|
| 产线/配方/双数采创建 + 控制网关启动 | PASS | 证据 JSON `ids` |
| Channel(omp lead+worker,双插件,绑线,ustc/deepseek-flash) | PASS | `ids.channelId/leadId/workerId` |
| HITL `line_start` 审批 → 开线 + 设备回读证实 | PASS | Channel 消息与线状态 |
| `daq_export` 全量 CSV + merged + 工况列 | PASS | `daqexp-20261114224520-3c795d` |
| IDD quick-screen(omp) | **COMPLETED** | run `064cb296`,report 19,815 B |
| IDD deep-diagnosis(omp) | **FAILED / omp_timeout** | run `954d6fa7`,40min 预算耗尽 |
| IDD 报告入库 RAG + 向量检索命中 | PASS | R1-R3,36 chunks |
| rag-bridge 插件检索路由命中 | PASS | R4 |
| Channel lead 拆分任务 → worker 执行 → lead 独立复核/验收 | PASS | task `a6952741` COMPLETED;lead 消息“最终验收通过” |
| KB 入库审批(kb_agent) | 已批准 | HITL `ap-5b091f47` approved;pending=0 |

**RAG/Channel 断言:7/7 PASS**(见 `report.json`)。

## 3. IDD 实际诊断结论(摘录)

quick-screen 报告(`workspace/diagnostic-runs/202611141526122_idd-rag-rr-15b83-liveness/report.md`)给出:

- 熔体温度:未越限(609/609 在声明量程 150–185℃;观测 161.1–171.3),未冻结,无真实漂移
- 挤出压力:**越限判定 UNDETERMINED** —— 节点单位/量程/semantics 为温度节点复用,数值量纲不可确认
- 数据质量:时间轴完整,1 处 3.96s 采样缺口;两节点 607/609 行平台 state=warn,由错配 warn 带驱动,属元数据缺陷而非工艺告警
- IDD 自身发现:哨兵 C4 马氏距离在双参数场景被误判病态跳过;稳健 z 多乘一次 0.6745,`n_outliers=0` 不能作为无离群证据

**这次案例是真实的“自定义配置/元数据错配”工况**:压力节点误用了温度模板(我们构造的 mock 夹具缺陷),IDD 正确识别并拒绝猜测,给出竞争集与前置信息要求。这证明 IDD 在“数据/元数据质量不可信时不编造结论”上的价值,也说明上线前必须做节点元数据校验。

## 4. Channel/Agent 协作实证

- lead(omp)读取 `line_context`/`diag_run`/`kb_agent` 工具说明,建立根任务并拆分 worker 深度诊断任务
- worker 发起 IDD 深度诊断(export `daqexp-20261114232445-01d966`),在 deep run 超时后改用 quick-screen 并完成
- lead 对 worker 交付物做独立复算与验收,逐项修正数字口径(残余 sd、主周期、互相关滞后),最终 `a6952741` COMPLETED
- 异步回执把 IDD quick-screen 报告送回 Channel;KB 入库审批由人工批准后继续
- 消息轨、任务状态、审批终态均可从 DB/HTTP 回溯

## 5. 运行限制与风险(真实发现)

1. **Channel 根任务默认 10 分钟停滞中止**:lead 首次长回合在 10 分钟被取消(root `3fd608bb` CANCELED),但 worker 子任务继续并完成;最终实例将 `workshop.harness_stall_timeout_ms` 调至 30 分钟。生产建议按任务时长配置,并让 lead 优先异步拆分子任务。
2. **IDD deep-diagnosis 40 分钟超时**:`954d6fa7` 在 `omp_timeout` 失败;quick-screen 的确定性哨兵路径 33 分钟完成。深度诊断需要更长预算/更快的模型或分阶段执行。
3. **RAG 大知识库后台重建阻塞交互**:验收期间 RAG backend 对 `自然科学与地球科学` KB 做大批量索引,`/api/v1/health` 与检索出现 HTTP 000/超时;需要索引队列与读面隔离。
4. **插件路由启动竞态**:实例 health ready 后约 2 秒内,rag-bridge `/health` 曾 404(setup 异步完成前路由未注册);前端/探针应做就绪重试。
5. **物理 HIL 未执行**:所有设备数据来自 mock 驱动;不得据此声称真实产线控制。
6. **Mimosa**:终扫仍 partial/inconclusive(34 static findings,依赖 0),不是安全通过。

## 6. 判定

- **IDD 集成**:真实 HTTP token、任务提交、状态轮询、报告落盘/结果库、异步回执均打通;quick-screen 完成;deep-diagnosis 受 40min 预算限制。
- **RAG 集成**:KB 创建、文档索引、向量检索、rag-bridge 插件检索均实证;大库重建时可用性不足。
- **Channel 集成**:omp lead/worker 真实任务拆分、工具调用、独立复核、HITL KB 审批全链实证;根任务长回合默认超时是运维风险。
- **RSI**:同一最终 build 上对真实模拟产线做 `/evidence/operational` 探针 7/7(只读证据、DCW 回读/审计、DAQ 最新/历史/frames、能力真相)。

因此:**“只读诊断 + 知识沉淀 + 人工治理下的调优决策”可以落地;“全自主深度诊断 + 物理闭环写控”尚不具备无条件落地证据**,需要解决 deep-run 预算、RAG 可用性、长回合编排与物理 HIL 四项。
