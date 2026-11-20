# 受治理产品学习：三路实施准入记录

- 冻结基线：远端 `main` `cf9dfab35684b53f1af43b54f924d2c183387bb0`，独立洁净检出。
- 三路评审共用原始计划 SHA-256 `e6ff0adcca52202c3d379523dbabaa3268092ac90383e1c7d5538b653999e190`。证据见[冻结索引](governed-learning-evidence-index.md)；本地原件没有纳入可复现门禁。
- 实施规格：[执行计划](../superpowers/plans/2026-11-20-governed-product-learning-and-industrial-readiness.md)。下表是该计划的补充**约束与回归验收条件**，与旧表述冲突时按本记录和原规格的强约束执行。
- `ALLOW` 只表示允许在相应批次施工，不代表提交、合并、部署、现场验证或受控放量。表中后续阻断均 `OPEN`，不得视为已实现或已复审通过。

| 独立评审席 | 准入结论 |
| --- | --- |
| ZCode · 架构／迁移／开发规范 | PR-A `ALLOW`（仅计划、脱敏取证和离线 Task 1）；PR-B `BLOCK`；相关经验批次依赖 PR-B；未评定独立运行支线。 |
| ZCode · Spec／证据谱系／授权与控制边界 | PR-A `ALLOW`，同上；PR-B `BLOCK`；其余批次未获该席独立准入。 |
| ZCode · 运行恢复／统计／验收复现 | PR-A `ALLOW`，仍须候选分支门禁；C、D、E 及最终审计按下表阻断范围推进，不代表全批通过。 |

## Standards / 架构处置

| 级别 / 批次 | 锚点与失败场景 | 约束、关闭证据 |
| --- | --- | --- |
| P0 / B | [schema.ts](../../server/services/workshop/db/database/schema.ts#L147)、[memory.repo.ts](../../server/services/workshop/db/memory.repo.ts#L113)、[admin-agents.ts](../../server/services/workshop/runtime/manager/admin-agents.ts#L148)：普通和经验共用唯一键，旧调用可能原地改变记录类别或已审正文。 | Task 2 以独立版本存储为权威，按拥有者、频道及经验键唯一定位 claim；版本和证据快照不可变，版本指针 CAS。旧通用写入口在 DB 边界拒绝 kind 转换；映射旧行 ID 和 Profile pin，不以旧行的变动改写版本。对仓储及实际管理写入口测双向同键冲突、并发 CAS 和变更后旧 pin 不漂移。 |
| P0 / B | [migrations-experience.ts](../../server/services/workshop/db/database/migrations-experience.ts#L15)、[open.ts](../../server/services/workshop/db/database/open.ts#L49)、[restore.ts](../../server/services/workshop/db/backup/restore.ts#L47)：未提交的分类或回填不能暴露，恢复工具只恢复到新目标。 | Task 2 新增原子 DB migration 及事务提交标识，提交前不得打开发版的读写入口；错误立即阻止服务进入新旧混用状态。PR-B 内记录版本指针/证据/授权变更的持久日志，明确备份后哪些事件可证明、重放或须人工对账。在停写窗口记录快照、恢复到新目标、对账差额，使用兼容的修正二进制，不降级读新库。测试旧盘活跃条目、中途故障重启、重复迁移、恢复后差额可见。 |
| P1 / B | [overlay.ts](../../server/services/workshop/experience/overlay.ts#L18)、[Profile 预览](../../server/api/workshop/channels/[id]/harness-profiles/index.get.ts#L24)：缓存和无会话预览绕过检索时的授权。 | Task 4 对 L0/L1、管理列表、已有 memory REST 与计数、跨频道 `searchSharedExperience`、Profile pin/advisory/预览、RSI adapter 建调用表并测真实调用链。经验正文不走旧 TTL 缓存；缺可信会话的预览只返回非生效的元数据。热缓存后撤权、退休、同频道切换产品、恢复 native session，下一次使用均不得返回或注入失效版本。 |

## Spec / 授权与证据处置

| 级别 / 批次 | 锚点与失败场景 | 约束、关闭证据 |
| --- | --- | --- |
| P1 / B | [session-snapshot.ts](../../server/services/workshop/agents/session-snapshot.ts#L39)：绑定未变不代表成员或调用身份仍有权；运行中的 native 对话仍可能携带旧文本。 | Task 3 在宿主持久层维护单调 learning authorization epoch，成员/角色、绑定、产品、经验或策略权限突变都必须与更新事务一起推进；一期可用单 DB 全局计数以保守失效，不能用快照 hash 替代授权。Task 4 在每次模型出站和工具返回的边界重查实时授权及 epoch；不匹配取消或丢弃响应并清理含旧经验的 native 会话，不仅清理检索缓存。测试绑定不变的撤权再授权、运行中产品切换及下一次模型发送。 |
| P1 / B，依赖 C/E | [RSI 规格](../plans/2026-11-17-rsi-evidence-promotion-product-memory-plan.md#L67)、[Beta ADR](../architecture/2026-11-13-adr-rsi-beta-boundary-contract.md#L65)：汇总、handoff 或手工合并可隐藏来源；同源重试或主张产生前的数据不构成独立复验。 | Task 3 冻结宿主的 `claimOriginTime` 和独立单元标识，按共同批次、数据、模拟种子及推导血缘聚合；依赖关系未知不得计入。Beta 源标记经聚合、摘要、交付与反射传递，不完整血缘不能晋升；验证、Profile、发布和本体发布入口按祖先拒绝。测试派生 Beta、同源分片/重试、主张前记录与异参反例，再测独立同一主张的支持。 |

## 运行恢复、统计与验收处置

| 级别 / 批次 | 锚点与失败场景 | 约束、关闭证据 |
| --- | --- | --- |
| P0 / C1、C2 | [bench-run.ts](../../server/services/workshop/experience/bench-run.ts#L70)、[gates.ts](../../server/services/workshop/experience/gates.ts#L160)：外部旧台账可能以重复观测或缺成本满足旧门。 | C1 合并时同时将既有经验/Profile 晋升入口对旧客户端评测改为只读历史，不能等 C2 再堵；C2 才接入宿主证明。经脱敏的合成夹具验证非宿主来源、重复独立单元、缺成本不可作为发布证据，历史仍可读。 |
| P1 / C1、E3 | [Task 5](../superpowers/plans/2026-11-20-governed-product-learning-and-industrial-readiness.md)：未冻结估计方法和批次归属，结果不具可复现的归因能力。 | 固定估计目标、随机分配/分层单位、同批聚类相关性、区间估计、两项主比较多重性、缺失/停止、功效样本量及费用；同源、跨臂污染、欠功效及缺结果不能达到发布判据。 |
| P0 / D1、E3 | [actuation.ts](../../server/services/workshop/dcw/dcw-controller/actuation.ts#L70)、[write.ts](../../server/services/workshop/dcw/dcw-controller/write.ts#L181)：执行已开始但落账中断时，批准行不能证明设备未执行。 | 在现有 DCW 调用点之前持久登记唯一 attempt/批准/租约，已进入发送边界但未闭合一律 `unknown`，先独立对账，不自动重发；仅有持久证据时判 `not_sent`。假驱动测进入调用前后及落终态前中断，重启不得再次调用。 |
| P1 / D2 | [Project service](../../server/services/workshop/projects/service.ts#L735)：待批冲突若按字符串相似度解释无法复现。 | 同 Project 的稳定 item/dedupe key 或明确的交付对象重叠才判已知冲突；无法辨认且可能与待批计划重叠则拒绝并说明，能显式证明不重叠的独立手工路径保留。批准物化和手工创建在同一事务边界检查。 |
| P1 / D3 | [OMP start](../../server/services/workshop/agents/adapters/omp-rpc-client/start.ts#L67)：进程已启但无 ready 信号，失败对象未被调用层纳管。 | 启动失败清理本次拥有的进程句柄/定时器/监听；证明退出后才允许重试，无法证实退出则阻断，不按端口或进程名清理。测试无 ready 假子进程和连续重试无遗留。 |
| P1 / D5 | [Task 11](../superpowers/plans/2026-11-20-governed-product-learning-and-industrial-readiness.md)：外部任务终态和产物完整性不能共用状态。 | 已终态且产物未验仍忠实记上游 `completed`，另记产物缺失或未验证、验收不通过；对尚未终态及明确终态但无产物分别断言。D4 的 DAQ 缺口回归单独验证。 |
| P1 / E1、E2 | [ontology-learning.ts](../../server/services/workshop/aml/ontology-learning.ts#L100)、[现有回归](../../tests/ontology-learning-p6.test.ts#L60)：旧测试把“没有声明边”断言为否证。 | 随相应改动更新既有规格测试及全部 `hasCouplingPath` 消费者；无图、无匹配边、明确否证、已有支持分别留痕，未知不得当作否证或执行通过。 |
| P1 / E3 | [onboarding lib](../../scripts/onboarding/lib.mjs#L143)：孪生归属证明不能证明 AW 进程、数据库、队列和缓存归属。 | 验收必须同时验证 AW 运行身份和每臂独立 home、数据库、缓存、队列、索引及驱动目标。共享、未知或不匹配时不启动任务、不调用写入；用合成清单测预检。真实模型/外部服务不具备则分别记阻断，不用夹具补结论。 |
| P1 / E3、最终审计 | [Task 15](../superpowers/plans/2026-11-20-governed-product-learning-and-industrial-readiness.md)：`evidenceRef` 本身不保证工具链、源代码和日志对应。 | 严格校验每项散列的执行清单：命令、工具链、锁文件散列、干净状态、checkout/build SHA、退出码、证据摘要；核对远端合并祖先。测试不一致或缺失时不可通过。 |

### 关闭顺序

PR-A 不触及以上运行行为；后续每批开工前将对应条目补入实际文件/接口清单和回归测试，向对应评审席送更新的 SHA 与处置。同一 PR 的防线必须一起合并，不能用后续 PR 抵扣当前缺失的防线。本页不解除任何兼容性、自动晋升、真实部署或现场授权门。
