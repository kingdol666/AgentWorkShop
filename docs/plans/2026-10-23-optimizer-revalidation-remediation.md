# Optimizer 复验整改执行单

日期：2026-10-23。补充 v4.1 总计划，以本轮实际反例作为回归基线。状态：待实施；本轮测试不自动扩大为全部 SW 重构。

## 实施顺序与验收

| 阶段 | 实施内容及落点 | 必须通过的出口 |
|---|---|---|
| R0 授权与下发复核 | 补齐 SW1：REST/Agent/MCP 共用主体、Channel 档位/策略、产线 grant 与目标资源规则；拒绝统一审计。逐项核对 SW5/D12–D14 的当前回读、CV 新鲜度、活动 run、文件工件完整性与批准时发起人 grant。 | 全 17 handler 及全部读/写/发布/批准入口的跨用户负例；每次授权拒绝恰 1 条 denied 且业务表不变；直接 REST 不能绕过 Agent 策略；批准时八项负例均零写，双裁决入口一致。 |
| R1 数据真实性 | `process-model/dataset.ts` 与 `aml/dataset-builder.ts`：先保留用户 runIds/from/to，再按确认段+RecipeRun 快照裁切；窗口边界不得跨段，未确认版本排除。补真实 block/run/目标时间点元数据。 | 本轮反例：请求 1 批仅返回该批；v2 的旧版/跨段窗口都为 0；unknown 不获 lineage；输出 manifest 可逐窗口追溯。 |
| R2 资格与 UQ | `eligibility*.ts`、两训练器、`uq-evidence.ts`、`manager.ts`：删除 latest 回退，完整匹配 spec/version/dataset/hash/condition/scope；按 manifest 独立块聚合及唯一目标时间点统计，按 v4.1 D2/D3 签发。撤销传播并持久失效。 | 6-run 的 2/2/2 必为 empirical_max、块数 2/2；272 唯一步仍为 272；无动作账本不获 commanded；错版本/hash/工况/数据集、撤销或不足样本均拒绝。既有错误工件重新训练，不重写冻结 hash。 |
| R3 真实试验与 UI | `experiment.ts`、既有 DCW 治理/回读账本、optimizer 页面：实现模拟线持久试验状态机、预算/保持/停止条件/恢复；真实线只消费已发生历史证据。前端补试验、工况、资格缺口、互校、下发/审批状态、工程单位首步及反馈。 | 浏览器真实创建→启动→观察→取消；重启不重放写入；自然漂移/ACK-only 不合格；动态/静态及真实建议作用域均能按声明配置；单凭页面能加载不算完成。 |
| R4 剩余平台项 | 按总计划 SW6 与 SW2.5–2.6 实施跨进程租约、依赖锁、Adapter/Worker v2、服务端发布冻结、多工况、MD、双存储对等；补齐三个 typed 公共调用方单位边界。 | 总计划 MP-A7–10 逐条执行：真实跨进程 ENV_BUSY、第三方 adapter 实际调用、双工况 hash、MD 金标、SQLite/Timescale 同 fixture 等价；无环境标 not-run。 |
| R5 系统最终验收 | 复用本轮真实协议物理场景载体；补两场景各 20 配对收益、第三纯配置留出场景、完整 DD/MP 子断言、刷新时序及回滚演练。 | 标准模型门限不降低；收益≥15%、95%下界>0、原始动作硬约束零违反；全过程仅首步应用；所有 DD/MP 出口证据齐全才标总计划完成。 |

R0 优先；R1→R2→R3→R5；R4 的环境/存储部分可并行，其余依赖 R1/R2 契约。每阶段独立审查并保留 commands/exitCode/源文件与工件 hash。现场真实线设备写计数保持 0，本单不授权现场参数试验。

## 当前已完成的局部修复

typed predictor 使用 `io.variables` 将逻辑变量映射至实际 DAQ 列，系数顺序保留逻辑 ID，返回真实 targetNodes；已实测同一互校请求 HTTP500→200/pass。该修复单独验收，不代表 R1–R5 已完成。
