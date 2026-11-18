# IDD/RAG 插件 v1 契约生产化改造 + 三系统端到端验收报告(2026-11-18)

> 计划:`/.omc/plans/2026-11-18-idd-rag-plugin-enhancement.md`(v3,Critic APPROVED)。
> 实施:PR #233(rag-bridge v2.3)/ #234(diag-bridge v2.4)/ #235(diag_deposit + 写族联合判定 + 文档)/ #236(export 产线锁与授权作用域)/ #237(legacy 报告目录名归一)。
> 环境:全新 AW home(`D:/tmp/aw-accept-1118/home`,:3020)、新产线/节点/频道、真实 IDD(:3210)、真实 RAG(:6789/:8770)、模拟孪生(物理层)。

## 1. 结论摘要

| 面 | 判定 | 说明 |
| --- | --- | --- |
| 契约迁移(v1 定轨/legacy 回退) | ✅ | auto 探测钉 v1;显式 legacy 回归通过;401/5xx 不静默回退 |
| 文档入库检索(RAG) | ✅ | kb_catalog/search/read 实机;two-stage 命中;创建→index-document→自查命中 |
| 导出后在线诊断(IDD) | ⚠️ 部分 | 平台→IDD 提交/轮询/停止全通;IDD 侧 quick-screen/stability 在 60min/2312 行数据集上 40min 未落终态(第 139 事件仍在执行),属 IDD 技能/引擎侧稳定性 |
| 诊断→知识闭环(diag_deposit) | ✅(机制) | legacy 完成 run 实测 `search=hit` 且 kb_doc_search 第 1 命中;**内容为 mock 引擎剧本(明确标注)**;真实分析内容受上一条约束 |
| Agent 工具注入与真实回合 | ✅ | 142 工具(127 builtin+15 plugin);真实模型回合原生调用 kb_doc_search→kb_doc_read→diag_run(被单飞锁正确拒)→diag_status 并 COMPLETED |
| 治理与安全 | ✅ | 写族联合判定、HITL、单飞锁、频控、worker lead-only 拒绝均实机正样本 |
| 闭环优化下发 | ✅ | SP 156→150→144→138,3 步均 HITL 批准+设备证实 1/1;PV 复测 3/3 落 [138,142](均值 139.68) |

**总判定:插件侧生产化改造可投用;IDD 分析技能在长数据集上的终态不稳定是外部依赖,不作为插件验收承诺。**

## 2. 全新环境与产线供给(真实创建)

- 启动:`AW_HOME=D:/tmp/aw-accept-1118/home AW_ALLOW_PRIVATE_OUTBOUND=1 aw start --port 3020 --skip-infra`;首启注册 admin(admin@awshop.local)。
- 模拟孪生:`sim-twin --blueprint blueprint-b.json --sim-port 4050 --spawn`,归属证明成立(3 信号,Modbus 37031/37032,broker 58830)。
- 一键接入(`onboard.mjs`,AW_ONBOARD_ATTESTATION=attest.json):
  - 产线 **ln-5fb718a6**(CNC-850 精密加工热控线 B),数控 `dw-0005ca01`(SP),数采 `dn-a849927d`(主轴温度)/`dn-53fad113`(环境温度),配方 `rc-cdc41b25`;
  - 频道 **133a37fc-eaab-4534-8a80-e5805aed3dd8**(production_line_integrated,4 Agent:生产主管/数据分析师/知识调优工程师/工艺工程师);
  - 供给 9/9、锻造 11/11、V1–V6 11/11(V6 SKIP:无 protected fixture 基线)。
- 插件 token 热配:`PATCH /api/system/settings`(`plugins.diag-bridge.token/contract/results_enabled`、`plugins.rag-bridge.token/docs_kb`);health:diag `token.accepted=true、remote ok`;rag `verify=verify、backend healthy、aw-docs=ebfdf37e`。

## 3. 工具注入面(F1/F2/F5)

证据:`evidence/F1-F2-F5-tools.json`。

| 项 | 结果 |
| --- | --- |
| 工具注册 | `synced builtin=127 plugin=15 unavailable=0 total=142` |
| lead 可见 | 90 个;7 个新工具全部可见(kb_doc_create/search/read/catalog、diag_chat/stop/deposit) |
| worker 可见 | 77 个;`diag_result_annotate`(lead-only)不在面内 |
| schema 增量 | 7 工具 3,087 chars ≈ 965 tokens(估算),≤ +1.2k 预算 |
| i18n | 两插件 i18n.json 中英同步;tools 段含全部工具标签 |

## 4. 真实 Agent 回合(F3,原生工具调用)

> 外部模型供应商当日不可用:ustc `budget_exceeded($30/3h)`、ark `InvalidSubscription`、superapi `socket closed`。为保证**真实回合**不被环境阻断,使用本机 LM Studio `qwen3.5-9b-distilled`(64k,provider=local,新增于 `~/.omp/agents/models.yml`,原文件已备份 `models.yml.bak-accept-1118`),不改变平台协议/权限。

证据:`evidence/task-final.json`(33 条历史)。

- 探针任务 `1fd2f33f`:模型原生调用 `kb_catalog` → COMPLETED。
- 全量任务 `6b128331`(数据分析师,reassign 直派):
  1. `kb_doc_search("CNC-850 主轴 热漂移 治理")` → `hits=3`,首条 `aw-docs/AW-PLUGIN-V1-LIVE-...md`;
  2. `kb_doc_read(doc_path=首条, max_chars=600)` → 正文 124 字符;
  3. `diag_run(line=ln-5fb718a6, ...)` → **被单飞锁正确拒**:`产线 ln-5fb718a6 已有运行中的诊断(run_id=71a837c1)`;
  4. 回退 `diag_status(71a837c1)` → 如实返回 running;
  5. 最终 **COMPLETED(progress=100)**。

结论:插件工具被 Agent 自动看见、正确选择、原生调用;治理拒绝对模型可读并促使其改用查询路径。

## 5. IDD external v1 真实链路(B 区)

证据:`evidence/tools-accept.json`、`evidence/run-*.json`。

| 步骤 | 实测 |
| --- | --- |
| auto 定轨 | capabilities 200 → v1;显式 legacy 亦通过(mock 回归) |
| 快照提交 | `diag_run(line=ln-5fb718a6, 20min)` → 平台 DAQ 导出 **235 行 × 2 节点** → v1 `/analyze` 202 → run **71a837c1** |
| 轮询 | diag_status 30 次(约 10min)全程 running;IDD 进度 events 36→116、tools 24→74 |
| 停止 | `diag_stop(71a837c1)` → `status=stopped`(v1 stop 200) |
| 导出数据集 | `daq_export(line, 60min)` → **daqexp-20261118155748-cad70a**(2312 行,2 节点,manifest+CSV) |
| 多文件分析 | `diag_run(export_id, quick-screen)` → 0689e6a3;30min 后仍 running(106 事件) → stop |
| 稳定性意图 | `diag_run(export_id, stability-report)` → 2ea7d10b;40min 后 139 事件仍在执行 → stop |
| 失败透传 | 较早合成 CSV 快筛 run 654e61f2 → IDD 判 `failed: Run ended without required artifacts (sentinel/quick_screen_report.html)`,插件如实归一 failed+error |
| 单飞/并发 | 同线第二提交被拒(见第 4 节);停止后锁释放 |

**如实边界**:IDD 的 quick-screen/stability 技能在本机 60min/2312 行数据集上长时间不落终态,属 IDD 侧 skill/engine(omp 进程多轮工具调用)稳定性问题;插件侧提交、契约、轮询、停止、失败归一无缺陷。计划中的“禁 mock 出验收结论”被遵守:真实分析结果未完成,不对分析质量下结论。

## 6. 诊断→知识闭环(diag_deposit,机制验证)

证据:`evidence/` + 实时输出。

- legacy 完成 run `4bc21b32`(mock 引擎剧本,报告首行自述“Mock 引擎剧本…非真实诊断结论”;评分 96/ENDORSED)。
- `diag_deposit(run_id=4bc21b32)` →
  `status=ok doc_path=aw-docs/ACCEPT-C1-MOCK-DEPOSIT-20261118.md index=ok tags=ok search=hit hits=5 mode=two-stage`
- 独立 `kb_doc_search("ACCEPT-C1-MOCK-DEPOSIT-20261118")` → 新文档 **第 1 命中**(score 0.5658)。
- 负路径单测:报告为空 → 可读失败且不创建文档(C3)。

**如实边界**:本项证明“入库→索引→两段自查→检索命中”机制闭环;真实诊断报告入库需待 IDD 终态问题解决后复跑(代码路径同一条)。

## 7. 受治理闭环优化下发(真实设备写)

证据:`evidence/recipe-trial.json`、`recipe-step-144.json`、`recipe-step-138.json`、`pv-retest.json`、`recipe-update.json`。

- 基线:SP 156°C / PV 155.86°C(目标窗 [138,142])。
- 三步小步(每步 ≤6°C,均 HITL 批准、设备证实 1/1):
  1. 156→150(batch rr-fbfd9)
  2. 150→144(batch rr-1338d)
  3. 144→138(batch rr-68e0a)
- 频控正样本:60s 配方下发间隔、300s 试验节拍各触发一次,均给出可读等待指引。
- 复测:142.53 / 139.81 / 139.62 / 139.61;后 3 次均值 **139.68**(窗内)→ RETEST PASS。
- 固化:`recipe_update` → HITL → **v2(SP=138)**;`recipe_apply/rollback` 未再触发。

## 8. 治理与可观测正样本

| 项 | 证据 |
| --- | --- |
| worker 调 lead-only | `diag_result_annotate` → `仅对 lead 角色开放(当前 worker)` |
| 单飞锁 | 同产线第二 diag_run 被拒并指向上一个 run_id |
| HITL | 4 次配方动作审批(ap-36ca01c4 / ap-bdece58b / ap-88d1ffb6 / ap-d5e5717b),全部人工附言留痕 |
| 工具计数 | diag health `diag_run ok3/err2、diag_status ok81、diag_stop ok1/err1`;rag health `kb_catalog 2、kb_doc_search 2、kb_doc_read 2` |
| 鉴权 | 两插件 token 均 `accepted=true`;RAG verify 三态实测 |
| 渠道工具面 | `GET /tool-usage` 本环境为 0 —— 数据源是 `channel_events(type=agent.block)`,需 ws 订阅者在线才落块;headless 验收用任务 history + 插件 toolCounters 作为替代证据(已如实标注) |

## 9. 验收矩阵(A–F)

| 项 | 状态 | 备注 |
| --- | --- | --- |
| A1–A3 文档创建/检索/读取 | ✅ | 实机 + 单测;两段检索命中 |
| A4 降级提示 | ⚠️ 单测 | 未在实机强制 6789 故障 |
| A5 有界 prompt | ⚠️ 单测 | 未对比 sync 时长(外部 agent 不稳) |
| B1 v1/legacy 定轨 | ✅ | auto=200→v1;legacy 显式成功 |
| B2 真实 quick-screen 终态 | ⚠️ 外部阻塞 | 提交/轮询/失败/停止全通;终态未达 |
| B3 回执链 | ⚠️ 未实测 | sweep 回执未在本轮 Agent 面板验证 |
| B4 diag_chat | ⚠️ 部分 | legacy run 可读拒绝;v1 完成 run 无样本 |
| B5 diag_stop | ✅ | 71a837c1/2ea7d10b |
| B6 legacy 回归 | ✅ | mock run 走 legacy 完成 |
| B7 同线并发 | ✅(拒绝面) | 第二 run 被单飞锁拒 |
| B8/B9 错误可读/意图 | ✅ 单测+实机 | 未知意图、单飞、失败归一等 |
| C1 deposit 机制 | ✅(mock 内容) | search=hit 第 1;真实内容待 IDD |
| C2 结果库权限 | ✅ | worker 被拒 |
| C3 空报告负路径 | ✅ 单测 | 不落半截文档 |
| C4 漂移警告 | ✅ 单测 | — |
| C5 catalog/token 三态 | ✅ | 实机 64 库;verify=verify |
| C6 awaiting 生命周期 | ✅ 单测 | 占锁/老化 expired |
| F1/F2/F5 注入面/角色/预算 | ✅ | 142 工具;7 新工具;+965 tokens |
| F3 真实 Agent 回合 | ✅ | 原生 kb_doc_search→read→diag_run→status |
| F4 写族 fail-closed | ✅ 单测 | 联合判定无缓存窗口 |
| F6 灰度/一键关停 | ⚠️ 未实测 | 插件启停通道存在 |

## 10. 工程门禁

- `pnpm lint` PASS(RSI 红线 0)
- `pnpm typecheck` PASS
- `pnpm test:unit` **2059 tests / 2058 pass / 0 fail**(1 skipped)
- `pnpm build` PASS(`.output` 用于本验收实例)
- 新增单测:rag 文档族 10、diag v1 契约 21、deposit 5、写族判定 4

## 11. 如实边界与后续

1. **IDD 技能终态不稳定**(quick-screen/stability 在 60min/2312 行数据上 40min 未完成):IDD 侧问题,插件只做透传与降级;建议 IDD 侧排查 omp 工具的产物校验(sentinel/quick_screen_report.html)与 max-time 行为。
2. **云端模型全不可用**:ustc 预算耗尽、ark 订阅失效、superapi 连接被断;真实回合用本机 9B 模型完成(能力有限但完成了目标链路)。生产使用需恢复任一云端 provider。
3. `tool-usage` 需要 ws 订阅者;headless 下用 task history + toolCounters 替代(口径已写明)。
4. V6 受保护线 fixture 缺省跳过;A4/A5/B3/B4-完成态/F6 未做完整实机,列为下一轮补测项。
5. Mimosa 本轮提交时未取得完整扫描结论(scanner_enobufs),**不宣称项目安全**;需另跑完整审计。
