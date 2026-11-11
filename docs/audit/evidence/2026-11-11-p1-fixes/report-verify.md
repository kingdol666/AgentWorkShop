# P1 修复复验报告（ralph 循环 · 2026-11-11）

> 基线：`main@b9a4ae20`（含 P1 修复轮 4 PR：#162/#163/#164/#166）
> 方法：逐项**先复现、再验证**；未收口的继续修复。复验用例与证据如下。

## US-1 · ROOT_TIMEOUT 解耦 — ✅ 已修好

| 验证 | 结果 |
|---|---|
| 存量 4 用例（超期收口/豁免矩阵/fail-closed/模式任务） | 全 PASS |
| **新增锁持有顺序回归**：`withExecLock` 被永不返回的 promise 持有时，`runRound` 仍在锁外完成过期收口（timeoutTree 触发断言） | PASS（旧行为此场景下收口被饿死——正是 2026-11-10 的 deadline 证据复现路径） |
| 源码核验 | `tickRound` 不再含过期判定；唯一入口 = `runRound` 锁外 `enforceRootDeadlines` |

## US-2 · 群聊消息对空闲 lead — ✅ 已修好（live 实证）

| 验证 | 结果 |
|---|---|
| live :4201 群聊 @空闲 lead（频道 B，此前复现卡死 3+ 分钟的同一频道） | **REPLIED**（此前 VERDICT=NO-REPLY/181s+） |
| 看门狗兜底路径 | `withMessageWatchdog`（600s abort+requeue）+ `ensureClient` 120s 超时均在源码与全量 unit 中 |
| 全量 unit | 1417 pass / 0 fail（修复合并时） |

## US-3 · real 动作证据台账派生 — ✅ 已修好

| 验证 | 结果 |
|---|---|
| 行为矩阵 5→7 用例（observed / ack_only×2 / unknown / runIds 谱系 / **MV 节点收窄** / **exec 节点映射**） | 全 PASS |
| 源码核验 | real 作用域不再硬编码 unknown → `deriveActionEvidenceFromLedger(...)` |
| 复验新增修正（2 个追加 PR） | #167：证据按 MV 节点收窄（同批次其他参数 ACK 不污染）；#168：过滤集覆盖 MV 执行节点（DCW）与 DAQ 镜像（台账记 dw-...、spec 引用 dn-... 的映射断层） |

## US-4 · 数据集网格最近邻对齐 — ✅ 已修好（真实数据实证）

| 验证 | 结果 |
|---|---|
| **修复前**（real WWTP 线 3 档治理激励） | `AML_NO_USABLE_RUNS: 网格缺失率 50.0%`（复现） |
| **修复后**（同产线 v13 复验） | **rows=523 / runs=3 构建成功**；v13b rows=593 / runs=4；旧批次按预期继续被拒（历史窗无镜像数据/告警态——数据质量闸设计行为） |
| 源码核验 | 精确毫秒匹配已移除 → 指针单调最近邻 + 容差（`maxInterpMs` 缺省一个 beat） |
| 资格门协同验证 | 无有效激励的批次被 `MV_CONSTANT/MV_INSUFFICIENT_EXCITATION` 正确拒绝（fail-closed 全程工作） |

## US-5 · 全门禁终验

| 项 | 结果 |
|---|---|
| 全量 unit | 1431+ pass / **0 fail** / 2 skipped（连续 3 轮） |
| eslint 全仓 | 0 error |
| RSI 红线 | 19 文件 0 设备写调用 |
| stage1 / evolution 验收 | 13/13、11/11 |
| Mimosa | 完整扫描有 seal；14 条 advisory 全在非业务路径 |
| typecheck | 通过 |

## AML real 全链：机制面收口 + 物理面环境阻塞（升级报告）

11+ 轮迭代已实证（全部有断言/证据）：治理激励写（含步幅/量程/间隔守卫真实拦截）→ 真实 modbus 采样镜像 → spec 发布 → **数据集构建成功（对齐修复生效）** → 资格评估（台账派生证据 + 激励充分性判定）→ 训练作业链。

**升级阻塞（需用户决策）**：共享模拟器 :4010 的 wwtp 引擎经 14h+ 多会话使用后卡在 `warmup` 相——plant reset(×2) + 风机拉到 40Hz，DO 恒 ~0.27（物理引擎与执行量解耦）。独立验证需：① 独占/全新模拟器实例；② `plc-node-simulator` 子模块 `npm install` 授权（当前子模块未安装，影子目录方案被 `cpSync EINVAL`/源码漂移阻断）。这不影响本轮 4 个代码修复的正确性——数据质量门（告警行剔除、激励充分性、fail-closed）全程按设计工作。

## 本轮全部产物

- 代码：#162/#163/#164/#166（P1 轮）+ #167/#168（复验追加修正），6 个 PR 全部 CI 绿独立合入
- 测试：+11 用例（调度 4→6、证据 5→7、顺序回归 1）
- 报告/证据：`docs/audit/evidence/2026-11-11-p1-fixes/`（含 Mimosa seal）
- 脚本：`scripts/_live-aml-real-chain*.mjs`（12 个迭代版本归档）、`scripts/_live-rsi-*.mjs`
