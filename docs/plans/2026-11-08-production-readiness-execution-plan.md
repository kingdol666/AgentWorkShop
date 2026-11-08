# 生产就绪实施计划（Production Readiness Execution Plan）

> 来源：`docs/audit/2026-11-08-production-readiness/FINAL-REPORT.md`（审计 8 指控 + 专家评审 CONDITIONAL-GO）。
> 目标：实现全功能通过验收、可上线。每个 PR 都必须：单元/契约测试全绿 + typecheck 0 错 + 全量 unit 无回归 → 合并 main。

## 执行序列（7 个 PR，按依赖排序）

| # | PR | 内容 | 对应审计项 | 验收标准 | 量 |
|---|---|---|---|---|---|
| P1 | `fix/agents-oneshot-ctor` | one-shot 构造顺序修复 + restore() 逐 channel 兜底 + **全 14 引擎构造契约测试** | P0-1 | CI 契约测试 14/14；gemini lead activate 200 且 <5s | S-M |
| P2 | `fix/dangerous-defaults` | 产线绑定节点禁 mock driver（fail-loud）+ leaderHarness 去默认（400） | P0-2 + 指控8 | 绑定产线的 mock 节点被拒并列清单；POST /projects 缺 leaderHarness → 400 | S |
| P3 | `fix/activate-deadline-metrics` | activate 服务端 deadline(~30s) + 引擎失败/延迟计数器入 /api/metrics | P1（P0 放大器） | 挂起 activate 有界返回并清理；故障注入计数器递增 | S-M |
| P4 | `fix/migration-guard` | schema 变更前 pre-upgrade 快照 + legacy rebuild 包 BEGIN IMMEDIATE | P1（升级路径） | 升级中途 kill -9 → 预置快照可回滚启动 | S |
| P5 | `fix/settings-watcher` | watcher 监听生效配置目录（或递归+收紧过滤）+ CLI 文案诚实化 + 手动 reload 端点 | 指控2 P1 | 外部写 runtime-settings.json <1s 触发 reload | S |
| P6 | `fix/result-submit-window` | release 改为「交付物门关闭后」释放实例 + 待提交显式待办 + auto 策略自动 integrator | 指控5 P1 | 自主模式项目不再静默卡死；manual 模式 UI 有待办 | M |
| P7 | `docs/deploy-runbook` | 部署 runbook：env pin 清单/Timescale 改口令/token 轮换/恢复演练 | 阶段0-6 | 按手册可完成一次全量恢复演练 | M |

## 最终验收（全部合并后）

### A. 产线场景（真实工况作业）
1. 撰写**全新产线文档 + 协议接口文档**（第三个行业域）
2. 走 `aw-doc-to-project` skill：孪生 → 供给 → 频道 → verify-line → Project 四期链
3. 验收：V1-V6 全绿 + 四期断言全绿 + 设备回读收敛

### B. Project 通用开发场景（记账软件）
1. 新建 Project：需求→开发→测试 三频道依赖链（非产线域，验证「通用业务」编排）
2. 交付物 = 可运行的记账软件源码（真实写入 workspace）
3. 验收：W1 需求规格 → W2 源码产出 → W3 测试报告，L1+L2 全通过，项目 completed

### C. 全系统回归
- unit 全量 + typecheck + skill 校验 + 既有 live 驱动抽样复跑

## 依赖与风险
- P1 是全链基础（其余 PR 的 CI 都依赖契约测试闸门）
- P6 涉及状态机语义变更 → 需回归既有 4 个 live 驱动（multisession/collab/staged/wwtp）
- 记账软件为「通用开发」验证，代码由驱动经真实文件写入产生（LLM 自主编码不在本期范围，如实标注）
