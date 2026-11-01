# 论文实验状态台账（产物派生）

- 生成时间: 2026-11-01T14:47:39.802Z
- 数据源: D:\codes\ABO\AgentWorkShop\bench\results
- 结果目录总数: 20
- 产物计数: {"pipeline":2,"scenarios":0,"e1lite":1,"optloop":0,"agentteam":0,"approvalEvidence":0,"approvalPrepareFailure":0,"approvalAborted":0,"tierRuns":2}

| block | 状态 | 证据 | 缺口 |
|---|---|---|---|
| E1 场景×协议矩阵 | **PARTIAL** | reports-archive/2026-11-01-perfect<br>20261101121700-scenario-probes<br>20261101104849-xu0 | 合起来覆盖 5/6 场景（矩阵=2，写探针=5）；缺的格见各产物 NOT-COLLECTED |
| E2 闭环优化控制 | **EVIDENCE** | 20261101112947-optcontrol-c0 | — |
| E3 审批门消融 | **PARTIAL** | 20261101121436-approval-gate | 已有 manual vs auto 配置级对照；缺「只跳过审批等待」的单机制 OFF 臂（需 bench-only 旁路 + 安全审阅） |
| E4 防御纵深 | **EVIDENCE** | 20261101113644-production-guards<br>20261101103356-e1lite<br>20261101121415-authorization | — |
| E5 Harness×模型 | **NOT-IMPLEMENTED** | — | A2 runner 未实现 |

> 状态语义见 `bench/PIPELINE/EXPERIMENT-PIPELINE.md`：EVIDENCE = 论文可用产物已存在；
> PARTIAL = 只有部分条件的证据；NOT-RUN = 执行器在但零结果；NOT-IMPLEMENTED = 无执行器。
> 本台账不做通过/失败判定 —— 判定见各 runner 的 checks.json / run.json。
