# P1 遗留问题修复轮验收报告（2026-11-11）

> 基线：`main@7d37ad90` → 本轮 4 个独立 PR（#162/#163/#164/#166）全部合入，逐 PR CI 绿。
> 对应遗留清单：2026-11-10 报告（`2026-11-10-rsi-live-demo/report-round2.md` §7）。

## PR-1 · ROOT_TIMEOUT 饿死修复（#162）

- **问题（带 deadline 证据复现）**：任务 deadline 过期 30+ 分钟仍 WORKING——过期收口在 `tickRound` 内（持 lead `execLock`），lead 监督回合（真实 LLM）长时间持锁或被反复外部取消时判定被饿死。
- **修复**：过期收口（含 HITL 顺延逐根分流语义）整体迁出为 `runRound` **锁外**先执行的 `enforceRootDeadlines`（不依赖 LLM/执行锁）；有收口动作则跳过本轮监督。
- **回归**：新增 4 用例（超期收口/SUBMITTED+未超期豁免/无待批 fail-closed/模式任务豁免）；CI 3m50s 绿。

## PR-2 · 群聊消息对空闲 lead 卡死修复（#163）

- **问题（live :4201 复现）**：群聊 @lead → 消息 `consuming` 永滞、runtime 恒 idle、无 omp 进程、无日志——peer/监督回合无停滞看门狗，`ensureClient` 的 await 亦无超时保护，任一处挂死即永久持有 `execLock`。
- **修复（两层）**：① `consumeLoop` 增 `withMessageWatchdog`（claim 后超 `harness_stall_timeout_ms` 未结束 → `abortCurrent` + `mailbox.requeue`，attempts+1 ≥3→dead，`WHERE consuming` 守卫防双重消费）；② `BaseAgent.supervise` 的 `ensureClient` 加 120s 超时（挂死走既有决策失败 catch，锁正常释放）。
- **回归**：全量 unit 1417 pass / 0 fail / 2 skip；CI 3m24s 绿。

## PR-3 · real 作用域优化资格打通（#164）

- **问题**：real 作用域 `actionEvidence` 硬编码 `'unknown'`（"动作账本接入前保持 fail-closed" 的计划遗留）→ `ACTION_EVIDENCE_UNKNOWN` gap 恒成立 → **real 线永远不可获优化资格**——这正是"AML real 全链列入后续"的根本原因。
- **修复**：eligibility-service 从**干预台账**（机器事实源）按数据集批次（`recipe_run_id` 精确谱系）派生动作证据：全 `readback-verified` → `observed`；含 `transport-ack`/`unverified` → `ack_only`；无记录/台账不可读 → `unknown`（fail-closed 保持）。"不允许 Agent 自报 observed" 纪律不变。
- **回归**：`deriveActionEvidenceFromLedger` 5 用例；CI 3m14s 绿。

## PR-4 · 数据集网格对齐修复（#166，real 全链实测抓出）

- **问题（real 产线实测）**：WWTP 五协议产线 3 档治理激励写后，数据集构建恒 `AML_NO_USABLE_RUNS: 网格缺失率 50.0%`。根因：`dataset-builder.ts` 网格对齐用 `byTime.get(t)` **精确毫秒匹配**——独立 DAQ 节点各自轮询、采样相位永不共线，非锚定节点整列 NaN。合成 E2E 样本写在相同毫秒戳上，掩盖了缺陷。
- **修复**：按函数注释既定语义（"逐节点最近邻对齐"）实现指针单调前移的最近邻查找，容差 = `spec.cleaning.maxInterpMs`（缺省一个 beat）。
- **回归**：CI 3m15s 绿；全量 unit 1431 pass / 0 fail / 2 skip。

## AML real 全链实机状态（如实）

机制面已实证：治理激励写（manual/双批准）→ 真实 modbus 采样镜像 → spec 发布 → 数据集构建（含最近邻对齐修复后网格满覆盖验证）→ 资格评估按台账派生证据 → run 谱系圈定。
**剩余阻塞（环境，非代码）**：共享模拟器 :4010 的物理引擎被并发会话预设覆写（warm reset 后 DO 仍读 0.25，应 ~3.4）→ CV 全程 alarm 态 → `cleanPoints` 按质量口径正确丢弃告警行（设计行为）→ 数据集拒绝该窗。**激励协议要求已明确**：干净批次 + DO 在带 + 带内 ±1Hz 激励；待独占模拟器窗口后可闭环。11 轮迭代脚本归档 `scripts/_live-aml-real-chain*.mjs`。

## Mimosa 完整扫描（P1-D）：首次完成，不再 inconclusive

- scanId `scan-2026-11-10T21-09-44.982Z-93427e219d0f`，**seal** `sha256:f3792db0…`，depth normal，283 包，0 已知漏洞匹配。
- **14 条静态 advisory，0 业务逻辑候选**：
  - 4×HIGH"硬编码凭据"：均为 **i18n 界面标签文案**（如 `embedApiKey: 'Embedding key'` 是设置页字段标签，非真实密钥）与测试脚本口令——误报；
  - 9×MEDIUM 跨文件污点：源均在 `scripts/`、`paper/` 快照、`bench/tools/*.py`（离线论文图表）路径，且每条自带保留（"静态 advisory 需人工确认真实数据流"）；
  - 1×HIGH 路径穿越：`bench/tools/fig4_analyze.py`（离线论文图表工具，非服务端）。
- **结论口径**：扫描已完成且有封印；14 条均不触及服务端业务代码路径；仍保留"静态扫描不等于运行时验证"的边界声明。证据：`mimosa-report.md/mimosa-seal.json/mimosa-coverage.json`。

## 全门禁终验（合并后 main）

| 项 | 结果 |
|---|---|
| unit | **1431 pass / 0 fail / 2 skipped**（http-drivers 一次 Windows libuv flake，单跑通过） |
| eslint（全仓，含新红线链） | 0 error |
| typecheck | 通过 |
| RSI 红线 | 19 个学习环文件 0 设备写调用 |
| acceptance-rsi-stage1 / evolution | 13/13、11/11 |
| docs-sync / i18n | 87-0 / 3291 键 PARITY OK |
| Mimosa | 完成（见上） |

## 遗留（更新后）

1. AML real 全链最后一段（real 资格→train→solve）待**独占模拟器窗口**（物理标定 + 干净批次协议已明确）；
2. 项目 root 编排的深层根因（supervise 外部取消的触发源）仍待查——过期收口已解耦，不再造成任务永滞；
3. 数据集网格对齐修复后建议补一次 model-loop E2E 复验（合成路径行为不变的断言已由全量 unit 覆盖）。
