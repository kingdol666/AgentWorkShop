# Optimizer / Process Model 实现复核与局部修复

日期：2026-10-23。对照计划：`docs/plans/2026-10-22-optimizer-process-model-plan.md` v3.1。§3 未完成出口已整合为总计划 `docs/plans/2026-10-23-optimizer-master-plan.md`（M0 基线收录本报告十项修复）。

## 1. 结论

**内置场景基础链已实现；原计划的全部功能和验收出口尚未完成。** 本轮以源码、隔离数值探针及回归测试核查，直接修复可定位的局部错误；数据事实/资格谱系/统一授权/插件路由等成组改造进入[后续计划](../plans/2026-10-23-optimizer-integration-followup.md)。

未回滚用户原有未提交实现，未修改已注册模型、未连接真实设备、未安装新依赖或触发现场写入。

## 2. 本轮修复

| 问题 | 修正与回归 |
|---|---|
| 零延迟ARX遗漏输入反馈 | 当拍输入系数进入状态B，避免仅放D导致下一步反馈丢失。独立plant `y=0.5*y_prev+2*u`、连续输入1，旧输出`[2,2,2]`，正确输出`[2,3,3.5]`；覆盖零延迟与正延迟、多步响应。 |
| OSQP状态映射错误 | 使用已安装版本的状态常量区分不精确不可行、无界、迭代上限、超时、中断；修正分段迭代重试条件。 |
| 静态求解越过maxStep | Python优化边界与`uPrev±maxStep`取交集，空交集判不可行；TS独立约束报告同时核验。 |
| 训练评价假通过 | 静态无留出样本不再返回误差0/改善100%；ARX分别计算val/test，不把同一测试值冒充两组指标；门禁拒绝空窗口/非有限误差。 |
| 维护锁/Worker竞争 | 获取维护文件锁失败也清除本进程exclusive；文件锁原子wx创建、token校验释放。超时/退出Worker先封存，exit确认前不分配下一请求。跨进程读租约完整治理仍未完成。 |
| plan_get串ID越权 | 建议、运行与候选必须同源并分别核验归属；显式不存在建议不能回退；覆盖snake/camel及混合参数。 |
| 撤销他人绑定 | DELETE复用成员资源授权及Channel管理权；拒绝请求不失效建议、不删除绑定；owner/admin合法路径保留。 |
| horizon参数静默忽略 | 维持已冻结的问题时域；显式请求必须为相同正整数，否则422。静态固定1，动态取Spec；不临时改IR/hash。 |
| 非法UQ/过期状态 | NaN/Infinity/范围非法coverage、负距离、未评估来源不能被标verified；状态读取在归属校验后统一处理TTL并持久失效。完整工况/权限失效另列后续任务。 |
| 未支持输入静默丢弃 | 当前内置训练器尚未消费MD/feature，配置入口明确返回UNSUPPORTED_MODEL_INPUT；保留MV/CV链路，完整扩展另列计划。 |
| 已登记旧ARX工件 | 识别具有ARX标记、零延迟且存在旧D直接项的编译工件，运行时返回MODEL_RETRAIN_REQUIRED；不重写工件/hash，不误拒无ARX标记的合法通用状态空间D项。 |

旧零延迟ARX模型需要重新训练并重新发布/绑定，不能把训练器修复当作历史工件已自动修复。

## 3. 尚未完成的计划出口

- 历史run按配方确认版本/工况切段、unknown隔离、静态稳定样本、单长run切分。
- 动作账本/回读证据与模拟试验runner；真实线目前被unknown资格阻断，模拟资格也不能只根据line.simulated自动证明发生干预。
- 模型→dataset→specVersion/condition的精确资格绑定；REST/Agent/MCP统一授权与所有读面资源过滤；求解完成/建议读取时完整失效。
- Twin SolverAdapter/ObjectiveAdapter实际参与新求解路由；MD/特征从训练到推理的完整语义。
- Timescale与SQLite的分页/质量/到达语义对等；跨进程环境读租约及崩溃恢复、完整依赖锁。
- plc-node-simulator薄膜/连续退火的真实联调收益、第三场景纯配置、工具面刷新时序与A1–A22逐子断言证据。

现有67/67、90/90报告证明其对应断言通过；报告自身也披露了fixture、存储、插件等边界，不能据总通过数推定上面所有出口完成。

## 4. 本轮验证

| 检查 | 本轮结果 | 日志 |
|---|---|---|
| 全量 TypeScript 单元测试 | **372/372，0失败、0跳过，exit 0** | `optimizer-review-full-unit-final.log` |
| Python 数值回归 | **6/6，exit 0**（使用现有 AML `.venv`） | `optimizer-review-python.log` |
| 全仓 ESLint | **exit 0**；新增工件guard及调用处另经定向ESLint通过 | `optimizer-review-lint.log` |
| 完整类型检查 | **exit 0**，包含最终guard后的nuxi prepare与vue-tsc | `optimizer-review-typecheck-final.log` |
| 双语完整性 | **2983/2983，未解析key 0，exit 0** | `optimizer-review-i18n.log` |
| 文档一致性 | **91/91，exit 0** | `optimizer-review-docs.log` |

日志原件在`.omc/`，本轮证据副本与源码hash见`docs/audit/evidence/2026-10-23-optimizer-review/summary.json`；不覆盖原67/90条验收证据。本轮未重跑完整浏览器live脚本或真实模拟器闭环；上述单元/数值检查不冒充这些尚待完成的出口。

初次受限环境下的本机HTTP EACCES与系统临时目录rename EPERM已与业务错误区分；工作区内临时目录可通过模型注册测试，但会使“裸目录”发现测试读取到祖先config，因此完整套件另用正常隔离系统临时目录与本机回环网络复核。

## 5. 审查

本轮实现与审查为独立人员/上下文。独立代码复审：**APPROVED，无剩余局部修复阻塞项**，已检查共享工件guard、数值/生命周期及权限回归，并核对统一验证日志。结论仅覆盖本轮修复，不代表原计划整体验收完成。

后续F1–F6计划另经独立复审：**APPROVED**，任务、验收和依赖顺序无必改项，仍待实施。
