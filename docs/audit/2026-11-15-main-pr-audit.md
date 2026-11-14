# main 主干 PR 审计报告

> 生成:2026-11-15 · 仓库:`D:/codes/ABO/aw-pr-audit-refresh-20261115` · 审计基线:`origin/main @ 2f05f49a`（不含本刷新 PR #222 的 docs-only merge）

## 1. 审计结论

| 项目 | 结果 |
|---|---|
| main HEAD | `2f05f49a`（PR #221 合并;代码状态） |
| 目标 main 的 PR 总数 | **217**（MERGED 215 / CLOSED 2） |
| 真正进入 main 的 PR 内容 | **216/217**;#4 为重复/被替代的演示视频 PR,内容由 #5/#8 覆盖 |
| 所有 MERGED PR 的 mergeCommit 在 main 祖先中 | **215/215 YES** |
| 特殊合并 | #204 GitHub API 502 → 手工合并 `6e5a77c0`;tree 与 head `1ae8f590` 完全一致 |
| 合并方式 | 215 个 MERGED PR = 170 个 merge commit（157 个 first-parent + 13 个早期侧分支合并）+ 45 个 squash/rebase;另有 #204 手工合并与 1 个无 PR 号的 release merge,first-parent 合并合计 159 |
| 非 merge 提交 | 1081（含 squash/rebase 与日常提交） |
| 回滚提交 | 0 个 `^Revert` |
| open PR | **0** |
| main 与 origin/main | 一致（`2f05f49a`） |
| 最新代码 PR | #221 `feat(workshop): isolate generic and production channel sessions`（PR 自测 unit 1714/1714） |

**判定:main 主干内容完整,所有已合并 PR 的变更都包含在 main 的历史/树中;没有“PR 显示 merged 但 main 缺失”的情况。** 唯一非标准状态是 #204(API 502 导致 PR 状态未翻转,但内容已由 `6e5a77c0` 合入并验证 tree 一致);#4 是关闭未合并的重复演示视频 PR,不影响 main。

> 注:本刷新 PR #222 合并后,main 会再前进一个 docs-only merge;代码状态仍是 `2f05f49a`,不影响上述审计结论。

## 2. 阶段小结

### PR #1–#14 — v0.8.x 早期：EDA/MQTT/bench/文档（长生命周期分支，多次侧分支合并）

- 数量:**14**（有效合入 13;closed 1）
- 合并日期范围:2026-10-22 ~ 2026-10-27（号段不严格等于时间顺序）
- 代表项:#1 feat(eda): merge latest platform and EDA updates into main;#2 fix(eda): board card render fallback, chart fidelity, KV retry;#3 v0.8.x 全量合入 main:本体闭环/优化器/结果库 + 文档站版本历史;#4 docs: add AgentWorkShop core demo video;#5 docs(demo): 3 分钟英文界面宣传片 + EDA/i18n 修复;#6 chore(repo): 清理过期脚本/文档 + 本体 L7 与 bench v2 迁移;#7 fix(eda): 全功能验收与生产就绪报告 + 在线管道/B4 收口;#8 docs(site): 演示视频外链收口与 EDA 工坊指南;#9 docs(acceptance): 2026-10-27 全功能验收报告与全套件证据;#10 docs(integration): 本体/求解器/AML 集成评审与四工况实测报告;#11 fix(bench): 四工况 PV 反馈通道双层缺陷修复 + 3/4 工况达标;FIG.06 GIF 重建;#12 feat(bench): 论文级重复闭环实验驱动器与四场景三臂对照结果;#13 fix(mqtt): passive subscription ingest + latest-window reads + writeback verification;#14 feat(mqtt): structured payload decoding to scalar/vector/image + user decoders/sinks

### PR #15–#50 — 生产加固与全功能验收：HITL/权限/调度/Project/UI

- 数量:**36**（有效合入 36;closed 0）
- 合并日期范围:2026-11-02 ~ 2026-11-09（号段不严格等于时间顺序）
- 代表项:#35 fix(project): close remaining P0s from parallel review (PR13);#36 feat(project): API surface completion (plan §7.1) - update/retry/snapshot/trace/history;#37 feat(project): five-tab UI per plan §7.2 + interaction hardening;#38 fix(project): PR16 项目来源 root 取消护栏（lead 不可自取消项目 root）;#39 feat(project): PR17 M4 调度内核 —— 事件分级+双账本+Watchdog+Effects（S2/S3/S5/S6/S7/S11）;#40 fix(ops): PR18 dev 模式短会话密钥 fail-loud 告警 + Track B 演示密钥修复;#41 feat(tasks): PR19 派生进度（自报 vs 派生参照系）+ 演示脚本度量修复;#42 PR20 Project Route 派发闭环：完成回调 → 确定性派发下一就绪项（R1-R12）;#43 docs: PR20 evidence — acceptance/signoff updated to PR1-PR20;#44 docs: live route-loop demo — real-LLM landing page (zero manual dispatch) + full acceptance evidence;#45 demo: R2 full re-run of live route-loop acceptance (all tracks reproduced);#46 demo: Track D multi-Channel coordination (cross-channel relay via route loop, 10/10);#47 demo: Track E simple-vs-complex E2E + core audit + inventory + novelty assessment + paper-core figure;#48 docs: Project operational workflow figure (plan v3.0 + Router v3 target design);#49 docs: workflow figure — English, lower density (visual-gate PASS r1);#50 docs: three-figure set — design panorama, end-to-end execution (industry + agent internals), SuperAgent architecture

### PR #51–#90 — Router v3 / Project / 群聊工作台 / 前端重构

- 数量:**39**（有效合入 39;closed 0）
- 合并日期范围:2026-11-05 ~ 2026-11-07（号段不严格等于时间顺序）
- 代表项:#75 feat(session): platform session context for channel and project;#76 feat(project): continuation chat + project page UI polish (rebased on main);#77 feat(session): tiered context assembly with extractive compression (injection v2);#78 feat(memory): session-scoped memories with runtime tool passthrough;#79 docs(evidence): session injection v2 + memory runtime round report;#80 fix(project): evidence traceability domain = root + descendant tasks;#81 docs(e2e): landing-page scenario evidence + ralph PRD round;#82 fix(project): approved result slots scoped per work item + structured duplicate work-item error;#83 docs(evidence): full-system E2E acceptance + lifecycle demo (42/42);#84 fix(project): 派发原子化（WP1）——同工作项串行化 + attempt 冲突可重试;#85 test(session): 稳定 V2 压缩验收轮询（消除并行套件竞态）;#86 fix(runtime): 会话关闭生命周卫 + 任务实例读面对称 + busy-stuck 救援（WP2/WP9）;#87 fix(governance): 配方下发 Agent 归因 + HITL 鉴权 fail-closed;#88 fix(task-engine): WORKING→WORKING 幂等（D3 调度器假错误收口）;#89 docs(audit): 测试问题与坑总账 + 合并后实机复验（17/17）;#90 feat(runtime): 容量可配 + 看门狗设置面 + 连续性补探 + rescue ops（WP4/WP8/WP10/WP11/WP6）

### PR #91–#130 — 生产就绪、AgentBlock、AML/推理/工件

- 数量:**37**（有效合入 37;closed 0）
- 合并日期范围:2026-11-07 ~ 2026-11-09（号段不严格等于时间顺序）
- 代表项:#115 docs(acceptance): 三维度修复统一验收证据（六层矩阵）;#116 fix(api): 补齐剩余四个子资源主路径 GET;#117 fix(api): 三个高频 GET 的 query 参数改 zod 校验;#118 feat(rsi): WP-A1 经验数据模型（证据链/作用域/生命周期）;#119 feat(rsi): WP-A2 经验反射器（三触发确定性蒸馏）;#120 fix(harness): 会话身份探测不再竞态（建连 await + 回合落定补探）;#121 feat(rsi): WP-A3 经验注入与检索扩展（作用域加分/provenance/过期退休）;#122 feat(rsi): WP-A4 跨 Channel 共享经验 + memoryPolicy 落地;#123 feat(rsi): WP-A5 经验看板 API + Stage-1 验收脚本 + 注入预算核算修正;#124 fix(api): 补 GET /dcw/lines/:id 产线详情（计划原文项）;#125 feat(rsi): WP-D1 配方证据链（recipe_run_id 外键 + verdict→成效聚合）;#126 feat(rsi): WP-D2 改进提案链（identifiable_effect → 配方固化候选）;#127 test(acceptance): Channel/Project 全流程实机验收（v0.10.0）;#128 feat(rsi): WP-D3/D4/D5 Stage-1D 收口（知识工件候选 + 实例 profile 继承）;#129 feat(rsi): WP-B1 Harness Profile 版本化（可进化外壳的版本载体）;#130 feat(rsi): WP-B3/B4 晋升门 + 回滚（经验/Profile 生命周期收口）

### PR #131–#170 — RSI 实施与 P1 修复（证据/看门狗/真实动作）

- 数量:**40**（有效合入 40;closed 0）
- 合并日期范围:2026-11-09 ~ 2026-11-11（号段不严格等于时间顺序）
- 代表项:#155 fix(project): 无在飞停滞可见 + 失败事件进慢路径 + 兜底复核复算内容哈希;#156 fix(hitl): 决策旁路补 finalize + 登记降级留痕 + 新增历史读面;#157 fix(rsi): bench 门 provenance —— 评测台账 + promote 只认 benchRunId + 关两条旁路;#158 fix(rsi): 经验状态单调性 + 合并端点 + 提案生命周期(按源收口/过期/人工裁决);#159 fix(rsi): bench 落库兼容 harness-ab 字符串 seed + 验收脚本走新契约;#160 docs(rsi): 第二轮验收——RSI 越用越聪明实证 + AML/本体/求解器复用审计;#161 style: 修 main lint 红（state.ts quote-props 一致性）;#162 fix(scheduler): 根任务过期收口解耦到调度锁外（P1: ROOT_TIMEOUT 饿死修复）;#163 fix(runtime): 消息级活性看门狗 + supervise ensureClient 超时（P1: 空闲 lead 信箱卡死修复）;#164 feat(process-model): 真实线动作证据从干预台账派生（P1-C: real 作用域优化资格打通）;#165 fix(project): 取消/终止硬停 —— 开工栅栏 + 派发后 CAS + 任务树 abort;#166 fix(aml): 数据集网格对齐改最近邻+容差（修真实多节点 50% 缺失）;#167 fix(process-model): real 动作证据按 MV 节点收窄（防同批次 ACK 污染）;#168 fix(process-model): action evidence filter covers MV exec node (DCW) and DAQ mirror;#169 test(scheduler): lock-held ordering regression + P1 verify evidence;#170 fix(aep): agent.block 协议面补全 —— 帧类型入册/分组/派生块 harness 归因/移除死字段

### PR #171–#205 — 前端舒适度、上下文学习、Project 完整性、RSI 收口

- 数量:**35**（有效合入 35;closed 0）
- 合并日期范围:2026-11-11 ~ 2026-11-13（号段不严格等于时间顺序）
- 代表项:#190 feat(ui): unified work surfaces, chat receipts and approvals;#191 fix(ui): tablet DAQ cards and touch hit areas;#192 fix(ui): close responsive acceptance gaps;#193 fix(ui): close round-2 audit findings;#194 fix(security): harden industrial control boundaries;#195 docs(plan): define domain-neutral context learning framework;#196 fix(session): isolate context and advance message compaction;#197 feat(auth): secure browser sessions and websocket tickets;#198 feat(ops): harden API contracts and database recovery;#199 fix(project): revalidate draft dependency contracts;#200 fix(session): normalize legacy compressed brief budget;#201 feat(daq): expose signal quality and stale state;#202 fix(ui): close lifecycle theme and delivery gates;#203 fix(review): close post-merge hardening findings;#204 fix(closed-loop): restore dispatch attribution and independent readback;#205 fix(goal): block out-of-band task completion + repair P12 pre-goal setup

### PR #206–#221 — RSI Beta、插件安全、兼容矩阵、终验、Channel 隔离与 PR 审计

- 数量:**16**（有效合入 16;closed 0）
- 合并日期范围:2026-11-14 ~ 2026-11-14（号段不严格等于时间顺序）
- 代表项:#206 feat(rsi): Beta RSI context/research/evidence/learning interface plugin;#207 fix(optimizer): honor physical DCW step limits in governed dispatch;#208 docs(rsi): record post-merge final gates evidence;#209 docs(rsi): record independent review approval for rsi closure round;#210 fix(plugins): close serial probe and diagnostic export surfaces;#211 fix(rsi): resolve beta scope from host authority and harden evidence surface;#212 fix(plugins): make extension lifecycle rollback complete;#213 docs(rsi): record round-3 final gate evidence;#214 feat(rsi): add read-only operational evidence for beta;#215 fix(rsi): wire live plugin services and add off/on compatibility matrix;#216 fix(diag): audit denials through the host ops service seam;#217 docs(rsi): record final acceptance on e4885f65;#218 fix(rsi): harden operational evidence and scope truth;#219 docs(audit): record round-4 system evaluation and IDD/RAG evidence;#220 docs(audit): audit all PRs merged into main;#221 feat(workshop): isolate generic and production channel sessions

## 3. 特殊 PR 说明

### #204 — 内容已合并,PR 状态为 CLOSED

- 内容:`fix(closed-loop): restore dispatch attribution and independent readback`（优化器归因、独立回读、RSI 脚本 CAS、users 页鉴权/溢出）
- 原因:GitHub merge API 返回 502,PR 状态未翻转;维护者手工创建合并提交 `6e5a77c0`（父 `e17546f2f` + `1ae8f590`）
- 验证:`6e5a77c0` 是 `origin/main` 祖先;`git diff 1ae8f590 6e5a77c0` 为空(树完全一致)
- 结论:**内容已真正合入 main**,仅 GitHub PR 元数据状态异常

### #4 — 关闭未合并(不影响 main)

- 内容:`docs: add AgentWorkShop core demo video`(66 秒演示视频)
- 处置:关闭;后续 #5(3 分钟英文宣传片)/#8(演示视频外链与 EDA 指南)覆盖了演示视频目标
- 结论:重复/被替代,不是丢失的功能 PR

## 4. 全量 PR 清单

| # | 状态 | 合并方式 | merge commit | 日期 | main 包含 | 标题 |
|---|---|---|---|---|---|---|
| 1 | MERGED | merge commit (side branch → main) | `4e58fc56abea` | 2026-10-22 | YES | feat(eda): merge latest platform and EDA updates into main |
| 2 | MERGED | merge commit (side branch → main) | `b46bb9367bf9` | 2026-10-22 | YES | fix(eda): board card render fallback, chart fidelity, KV retry |
| 3 | MERGED | merge commit (side branch → main) | `d850c995318d` | 2026-10-25 | YES | v0.8.x 全量合入 main:本体闭环/优化器/结果库 + 文档站版本历史 |
| 4 | CLOSED | closed unmerged (superseded) | `—` | — | N/A (closed) | docs: add AgentWorkShop core demo video |
| 5 | MERGED | merge commit (side branch → main) | `c870ed40a131` | 2026-10-26 | YES | docs(demo): 3 分钟英文界面宣传片 + EDA/i18n 修复 |
| 6 | MERGED | merge commit (side branch → main) | `375af4c20506` | 2026-10-26 | YES | chore(repo): 清理过期脚本/文档 + 本体 L7 与 bench v2 迁移 |
| 7 | MERGED | merge commit (side branch → main) | `051f89806b08` | 2026-10-26 | YES | fix(eda): 全功能验收与生产就绪报告 + 在线管道/B4 收口 |
| 8 | MERGED | merge commit (side branch → main) | `f541cdec9494` | 2026-10-26 | YES | docs(site): 演示视频外链收口与 EDA 工坊指南 |
| 9 | MERGED | merge commit (side branch → main) | `4437456c30d1` | 2026-10-26 | YES | docs(acceptance): 2026-10-27 全功能验收报告与全套件证据 |
| 10 | MERGED | merge commit (side branch → main) | `5c6d081ae96e` | 2026-10-26 | YES | docs(integration): 本体/求解器/AML 集成评审与四工况实测报告 |
| 11 | MERGED | merge commit (side branch → main) | `edc49b0e5c29` | 2026-10-27 | YES | fix(bench): 四工况 PV 反馈通道双层缺陷修复 + 3/4 工况达标;FIG.06 GIF 重建 |
| 12 | MERGED | merge commit (side branch → main) | `8d626826364a` | 2026-10-27 | YES | feat(bench): 论文级重复闭环实验驱动器与四场景三臂对照结果 |
| 13 | MERGED | merge commit (side branch → main) | `9143080acf29` | 2026-10-27 | YES | fix(mqtt): passive subscription ingest + latest-window reads + writeback verification |
| 14 | MERGED | merge commit (side branch → main) | `319506f40515` | 2026-10-27 | YES | feat(mqtt): structured payload decoding to scalar/vector/image + user decoders/sinks |
| 15 | MERGED | merge commit (first-parent) | `052524720afd` | 2026-11-02 | YES | 科学探索闭环 + FL-7 实机复验收口(P0–P6 + 发布修复) |
| 16 | MERGED | merge commit (first-parent) | `927b8149dc11` | 2026-11-02 | YES | docs(evidence): 记录合并后 main 状态 |
| 17 | MERGED | merge commit (first-parent) | `420ad28e89c6` | 2026-11-03 | YES | P2–P5 复验遗留缺陷收口 + 多源异构/MES 接入面核查(v0.9.3) |
| 18 | MERGED | merge commit (first-parent) | `e1d7f424ca19` | 2026-11-03 | YES | feat(heterogeneous): MES history to TSDB bridge + unified frames (H1-H8, v0.9.4) |
| 19 | MERGED | merge commit (first-parent) | `808e7a5e9833` | 2026-11-03 | YES | test(acceptance): full T0-T5 matrix + v0.9.5 closeout |
| 20 | MERGED | merge commit (first-parent) | `e4dd99691e3a` | 2026-11-03 | YES | test(scenario): real injection closed-loop 15/15 + D8 measure window |
| 21 | MERGED | merge commit (first-parent) | `0858281324d7` | 2026-11-09 | YES | docs(tii): major-revision rewrite after five-seat review |
| 22 | MERGED | merge commit (first-parent) | `0a11affb09b0` | 2026-11-03 | YES | fix(security): enforce spawn/workspace policy and deny agent-token management MCP |
| 23 | MERGED | merge commit (first-parent) | `394adf8bc343` | 2026-11-03 | YES | feat(project): add V1 schema, migrations, and repos |
| 24 | MERGED | merge commit (first-parent) | `d282514e29de` | 2026-11-04 | YES | feat(project): add project office, leader identity, lifecycle APIs (draft) |
| 25 | MERGED | merge commit (first-parent) | `3e7bdfdcf950` | 2026-11-04 | YES | feat(project): dispatch work items with project context propagation (draft) |
| 26 | MERGED | merge commit (first-parent) | `e8278351997d` | 2026-11-03 | YES | test(security): make P0 cwd-outside assertions portable |
| 27 | MERGED | merge commit (first-parent) | `3a49f1cc2225` | 2026-11-04 | YES | feat(project): results, approvals, audit, and reconciler (draft) |
| 28 | MERGED | merge commit (first-parent) | `c1462049b91a` | 2026-11-04 | YES | feat(project): project list/detail UI + browser smoke (draft) |
| 29 | MERGED | merge commit (first-parent) | `a4bb17c8dbb4` | 2026-11-04 | YES | feat(project): plan/completion gates, autonomous reconciler, MAST regression (draft) |
| 30 | MERGED | merge commit (first-parent) | `e9be149f894d` | 2026-11-04 | YES | feat(project): leader proposal tools, execution gates, write intent |
| 31 | MERGED | merge commit (first-parent) | `822aed3f05b4` | 2026-11-04 | YES | feat(project): audit-atomic destructive actions + line-grant result filtering |
| 32 | MERGED | merge commit (first-parent) | `d2dc969f06f5` | 2026-11-04 | YES | feat(project): member collaboration (viewer/approver) + leader channel proposals |
| 33 | MERGED | merge commit (first-parent) | `730585e3d1bc` | 2026-11-04 | YES | feat(project): weekly report + UI interaction matrix (P17 close) |
| 34 | MERGED | merge commit (first-parent) | `958776fed161` | 2026-11-04 | YES | feat(project): rollback drill + G0-G6 evidence archiver + signoff (P18b close) |
| 35 | MERGED | merge commit (first-parent) | `3dd260d4d27a` | 2026-11-04 | YES | fix(project): close remaining P0s from parallel review (PR13) |
| 36 | MERGED | merge commit (first-parent) | `42521935b740` | 2026-11-04 | YES | feat(project): API surface completion (plan §7.1) - update/retry/snapshot/trace/history |
| 37 | MERGED | merge commit (first-parent) | `8ec2a3fe7e0b` | 2026-11-04 | YES | feat(project): five-tab UI per plan §7.2 + interaction hardening |
| 38 | MERGED | merge commit (first-parent) | `980ca60466a6` | 2026-11-04 | YES | fix(project): PR16 项目来源 root 取消护栏（lead 不可自取消项目 root） |
| 39 | MERGED | merge commit (first-parent) | `48f5a50d20c5` | 2026-11-04 | YES | feat(project): PR17 M4 调度内核 —— 事件分级+双账本+Watchdog+Effects（S2/S3/S5/S6/S7/S11） |
| 40 | MERGED | merge commit (first-parent) | `f008756ee5a7` | 2026-11-04 | YES | fix(ops): PR18 dev 模式短会话密钥 fail-loud 告警 + Track B 演示密钥修复 |
| 41 | MERGED | merge commit (first-parent) | `994c45ca0810` | 2026-11-04 | YES | feat(tasks): PR19 派生进度（自报 vs 派生参照系）+ 演示脚本度量修复 |
| 42 | MERGED | merge commit (first-parent) | `d452e3b9f1b3` | 2026-11-04 | YES | PR20 Project Route 派发闭环：完成回调 → 确定性派发下一就绪项（R1-R12） |
| 43 | MERGED | merge commit (first-parent) | `744116cadcac` | 2026-11-04 | YES | docs: PR20 evidence — acceptance/signoff updated to PR1-PR20 |
| 44 | MERGED | merge commit (first-parent) | `b0032a856911` | 2026-11-04 | YES | docs: live route-loop demo — real-LLM landing page (zero manual dispatch) + full acceptance evidence |
| 45 | MERGED | merge commit (first-parent) | `d67a066fca4e` | 2026-11-04 | YES | demo: R2 full re-run of live route-loop acceptance (all tracks reproduced) |
| 46 | MERGED | merge commit (first-parent) | `3da5771a44a7` | 2026-11-04 | YES | demo: Track D multi-Channel coordination (cross-channel relay via route loop, 10/10) |
| 47 | MERGED | merge commit (first-parent) | `649bc18387ec` | 2026-11-05 | YES | demo: Track E simple-vs-complex E2E + core audit + inventory + novelty assessment + paper-core figure |
| 48 | MERGED | merge commit (first-parent) | `1c6bbcaf632d` | 2026-11-05 | YES | docs: Project operational workflow figure (plan v3.0 + Router v3 target design) |
| 49 | MERGED | merge commit (first-parent) | `0a94bdaee956` | 2026-11-05 | YES | docs: workflow figure — English, lower density (visual-gate PASS r1) |
| 50 | MERGED | merge commit (first-parent) | `758c4fd0bd56` | 2026-11-05 | YES | docs: three-figure set — design panorama, end-to-end execution (industry + agent internals), SuperAgent architecture |
| 51 | MERGED | merge commit (first-parent) | `763e2d92074b` | 2026-11-05 | YES | feat(project): Router v3 — truth gates, handoff contract, delegated acceptance, execution workbench |
| 52 | MERGED | merge commit (first-parent) | `2c57bfd2032d` | 2026-11-05 | YES | docs(project): Router v3 two-scenario observation evidence (A PASS, B PARTIAL) |
| 53 | MERGED | merge commit (first-parent) | `d3650bfc42e1` | 2026-11-05 | YES | docs(project): final two-scenario closure — both projects PASS, runtime caveats documented |
| 54 | MERGED | merge commit (first-parent) | `8f1f623ed0da` | 2026-11-05 | YES | fix(project): close Router v3 acceptance — leader route + delegated L1 review |
| 56 | MERGED | merge commit (first-parent) | `5e1d8eb645ee` | 2026-11-05 | YES | fix(project): harden L1 acceptance — reviewer grant, rework, resubmission |
| 57 | MERGED | merge commit (first-parent) | `4bf44a612991` | 2026-11-05 | YES | feat(ui): 逐界面优化落主分支——设计系统收口+交互宪法+逐页业务驱动优化 |
| 58 | MERGED | merge commit (first-parent) | `61b0e8be6a01` | 2026-11-05 | YES | feat(ui): redesign the AI conversation workspace (ChatGPT/DeepSeek direction) |
| 59 | MERGED | merge commit (first-parent) | `288ecb28aa5e` | 2026-11-06 | YES | fix(project): P0 hardening for multi-channel collaboration (batch 1) |
| 60 | MERGED | merge commit (first-parent) | `22952145348c` | 2026-11-06 | YES | fix(pilot): live pilot refinements from first full PASS run |
| 61 | MERGED | merge commit (first-parent) | `b3fb47ab12d4` | 2026-11-06 | YES | feat(project): P1 batch A - blueprint templates, digest, watchdog ratio, mailbox observability |
| 62 | MERGED | merge commit (first-parent) | `517f57030ada` | 2026-11-06 | YES | feat(project): terminate cascade, channel visibility, leader model selection (P1 batch B) |
| 63 | MERGED | merge commit (first-parent) | `57715e39d7ba` | 2026-11-06 | YES | fix(project): snapshot exposes routingPolicy + lock leader reconcile/routing conventions |
| 64 | MERGED | merge commit (first-parent) | `f084e8df4206` | 2026-11-06 | YES | docs(plan): multi-session runtime design + serialization probe |
| 65 | MERGED | merge commit (first-parent) | `5013432079af` | 2026-11-06 | YES | feat(channel): multi-session S1 - session entity with independent per-session runtime |
| 66 | MERGED | merge commit (first-parent) | `4a9eea7b3ee3` | 2026-11-06 | YES | fix(audit): session live acceptance uses omp session members |
| 67 | MERGED | merge commit (first-parent) | `0fe6f9b1ee4c` | 2026-11-06 | YES | feat(workshop): channel multi-session console view + sessions API consistency |
| 68 | MERGED | merge commit (first-parent) | `93ec2579f021` | 2026-11-06 | YES | fix(app): token dual-channel persistence + 401 self-heal retry + idempotent session polling |
| 69 | MERGED | merge commit (first-parent) | `b1d8a13580ed` | 2026-11-06 | YES | feat(project): task-level multi-session — per-task Channel instance + task session |
| 70 | MERGED | merge commit (first-parent) | `eb29818aee05` | 2026-11-06 | YES | chore(demo): parallel demo + project acceptance scripts |
| 71 | MERGED | merge commit (first-parent) | `c2d53166c94a` | 2026-11-06 | YES | docs(plan): implementation conclusion — decision B to C with root-FIFO evidence |
| 72 | MERGED | merge commit (first-parent) | `52f312b738b9` | 2026-11-06 | YES | feat(ui): 控制台 ChatGPT 化——工作台与项目页三区应用框 |
| 73 | MERGED | merge commit (first-parent) | `f4358085cfcc` | 2026-11-06 | YES | test: 产线×Channel×HITL 集成实机验收脚本（line-integration-live） |
| 74 | MERGED | merge commit (first-parent) | `f276a6a5dfdf` | 2026-11-07 | YES | docs: 刷新项目层验收证据截图（最新 main 实拍） |
| 75 | MERGED | merge commit (first-parent) | `a08ff451dddc` | 2026-11-07 | YES | feat(session): platform session context for channel and project |
| 76 | MERGED | merge commit (first-parent) | `6640a6ed59c6` | 2026-11-07 | YES | feat(project): continuation chat + project page UI polish (rebased on main) |
| 77 | MERGED | merge commit (first-parent) | `50c5609a8771` | 2026-11-07 | YES | feat(session): tiered context assembly with extractive compression (injection v2) |
| 78 | MERGED | merge commit (first-parent) | `3096eaa14a58` | 2026-11-07 | YES | feat(memory): session-scoped memories with runtime tool passthrough |
| 79 | MERGED | merge commit (first-parent) | `137ee7e93bee` | 2026-11-07 | YES | docs(evidence): session injection v2 + memory runtime round report |
| 80 | MERGED | merge commit (first-parent) | `ad63f7118f78` | 2026-11-07 | YES | fix(project): evidence traceability domain = root + descendant tasks |
| 81 | MERGED | merge commit (first-parent) | `01851f372887` | 2026-11-07 | YES | docs(e2e): landing-page scenario evidence + ralph PRD round |
| 82 | MERGED | merge commit (first-parent) | `7513a02f07a2` | 2026-11-07 | YES | fix(project): approved result slots scoped per work item + structured duplicate work-item error |
| 83 | MERGED | merge commit (first-parent) | `6a6e1a8a707a` | 2026-11-07 | YES | docs(evidence): full-system E2E acceptance + lifecycle demo (42/42) |
| 84 | MERGED | merge commit (first-parent) | `6ca901d4cee6` | 2026-11-07 | YES | fix(project): 派发原子化（WP1）——同工作项串行化 + attempt 冲突可重试 |
| 85 | MERGED | merge commit (first-parent) | `3db3850ab715` | 2026-11-07 | YES | test(session): 稳定 V2 压缩验收轮询（消除并行套件竞态） |
| 86 | MERGED | merge commit (first-parent) | `d48fac94e700` | 2026-11-07 | YES | fix(runtime): 会话关闭生命周卫 + 任务实例读面对称 + busy-stuck 救援（WP2/WP9） |
| 87 | MERGED | merge commit (first-parent) | `537b7129c4e4` | 2026-11-07 | YES | fix(governance): 配方下发 Agent 归因 + HITL 鉴权 fail-closed |
| 88 | MERGED | merge commit (first-parent) | `cd874522f399` | 2026-11-07 | YES | fix(task-engine): WORKING→WORKING 幂等（D3 调度器假错误收口） |
| 89 | MERGED | merge commit (first-parent) | `caf734a863e0` | 2026-11-07 | YES | docs(audit): 测试问题与坑总账 + 合并后实机复验（17/17） |
| 90 | MERGED | merge commit (first-parent) | `f7ede6c3cbd1` | 2026-11-07 | YES | feat(runtime): 容量可配 + 看门狗设置面 + 连续性补探 + rescue ops（WP4/WP8/WP10/WP11/WP6） |
| 91 | MERGED | merge commit (first-parent) | `c79d6443df4e` | 2026-11-07 | YES | docs(audit): 产线工具三上下文实机验收 35/35（Channel/Session/Project） |
| 92 | MERGED | merge commit (first-parent) | `538cbc3a56ff` | 2026-11-07 | YES | test: 验收脚本确定性修正（sessions 视图 composer + 写间隔冷却） |
| 93 | MERGED | merge commit (first-parent) | `96a9ab712033` | 2026-11-07 | YES | test: 修复 http-drivers 在 Windows force-exit 下的 libuv 卸载崩溃 |
| 94 | MERGED | merge commit (first-parent) | `144cce5f2b65` | 2026-11-07 | YES | docs(audit): 多Channel组成Project协同作业实机验收 67/67（分析/调优/建模） |
| 95 | MERGED | merge commit (first-parent) | `846706137255` | 2026-11-08 | YES | docs(audit): 全功能验收战役入库——doc-to-project skill + 四期递进/多会话/WWTP E2E 证据与驱动 |
| 96 | MERGED | merge commit (first-parent) | `99a7665e0981` | 2026-11-08 | YES | feat(protocol): AgentBlock v1 —— 跨 harness 统一工具调用块 + agent.block AEP 帧 + 全 harness adapter |
| 97 | MERGED | merge commit (first-parent) | `9811007519f9` | 2026-11-08 | YES | fix(agents): P0-1 one-shot 家族构造崩溃 + restore 兜底 + 全引擎构造契约测试 |
| 98 | MERGED | merge commit (first-parent) | `81ffff307ba1` | 2026-11-08 | YES | fix(config): P0-2 危险默认治理（禁静默 mock 驱动 + leaderHarness 去默认） |
| 99 | MERGED | merge commit (first-parent) | `88ce1ae76a97` | 2026-11-08 | YES | fix(runtime): P1 activate 装配 deadline + 引擎装配失败指标 |
| 100 | MERGED | merge commit (first-parent) | `159b85e49813` | 2026-11-08 | YES | fix(settings): P1 设置热重载 watcher 修 + CLI 文案诚实化 |
| 101 | MERGED | merge commit (first-parent) | `4447b4948cd2` | 2026-11-08 | YES | docs(ops): 生产部署 runbook（上线清单/env pin/轮换/升级/恢复演练/故障速查） |
| 102 | MERGED | merge commit (first-parent) | `314d5cdcc0af` | 2026-11-08 | YES | docs(acceptance): 上线前终验 —— BRG-5 MQTT 新产线 12/12 + 记账软件 Project 58/58 |
| 106 | MERGED | merge commit (first-parent) | `b91566227af9` | 2026-11-08 | YES | chore(lint): 清理 P0 批次引入的 eslint 错误，恢复 main 全绿 |
| 107 | MERGED | merge commit (first-parent) | `87e236686528` | 2026-11-08 | YES | feat(ui): Channel 控制台按 ChatGPT harness 布局重构 |
| 108 | MERGED | merge commit (first-parent) | `df6132040dc0` | 2026-11-08 | YES | feat(ui): Project 详情按 ChatGPT harness 布局收口 |
| 109 | MERGED | merge commit (first-parent) | `3de9177d9f50` | 2026-11-08 | YES | feat(ui): 入口页展示优化（项目列表 / Workspace 列表） |
| 110 | MERGED | merge commit (first-parent) | `d21f6c94fd59` | 2026-11-08 | YES | docs(release): rewrite README & VitePress for v0.10.0 |
| 111 | MERGED | squash/rebase | `f30a54f80808` | 2026-11-09 | YES | fix(harness): 会话身份重建卫生 + 工具面三面一致性门禁 |
| 112 | MERGED | squash/rebase | `8e08c905b302` | 2026-11-09 | YES | fix(api): 六个写面补 zod 校验（含四个高危） |
| 113 | MERGED | squash/rebase | `a513196293b8` | 2026-11-09 | YES | fix(api): 补 Project 子资源主路径 GET(工作项/交付物) |
| 114 | MERGED | squash/rebase | `4cc15c0f009d` | 2026-11-09 | YES | test(acceptance): 三维度修复统一验收脚本(17 断言) |
| 115 | MERGED | squash/rebase | `200a6721e99c` | 2026-11-09 | YES | docs(acceptance): 三维度修复统一验收证据（六层矩阵） |
| 116 | MERGED | squash/rebase | `1566cd5a6beb` | 2026-11-09 | YES | fix(api): 补齐剩余四个子资源主路径 GET |
| 117 | MERGED | squash/rebase | `d67c1bb4508a` | 2026-11-09 | YES | fix(api): 三个高频 GET 的 query 参数改 zod 校验 |
| 118 | MERGED | squash/rebase | `b0e06bf5c963` | 2026-11-09 | YES | feat(rsi): WP-A1 经验数据模型（证据链/作用域/生命周期） |
| 119 | MERGED | squash/rebase | `079541efa8f8` | 2026-11-09 | YES | feat(rsi): WP-A2 经验反射器（三触发确定性蒸馏） |
| 120 | MERGED | squash/rebase | `d4dcf8c29ef8` | 2026-11-09 | YES | fix(harness): 会话身份探测不再竞态（建连 await + 回合落定补探） |
| 121 | MERGED | squash/rebase | `cdcd124c1e5b` | 2026-11-09 | YES | feat(rsi): WP-A3 经验注入与检索扩展（作用域加分/provenance/过期退休） |
| 122 | MERGED | squash/rebase | `b80d2f0c4681` | 2026-11-09 | YES | feat(rsi): WP-A4 跨 Channel 共享经验 + memoryPolicy 落地 |
| 123 | MERGED | squash/rebase | `3b4479c0a6ae` | 2026-11-09 | YES | feat(rsi): WP-A5 经验看板 API + Stage-1 验收脚本 + 注入预算核算修正 |
| 124 | MERGED | squash/rebase | `83900d0f8690` | 2026-11-09 | YES | fix(api): 补 GET /dcw/lines/:id 产线详情（计划原文项） |
| 125 | MERGED | squash/rebase | `c563eb46c6d1` | 2026-11-09 | YES | feat(rsi): WP-D1 配方证据链（recipe_run_id 外键 + verdict→成效聚合） |
| 126 | MERGED | squash/rebase | `0f3a2c93f4e1` | 2026-11-09 | YES | feat(rsi): WP-D2 改进提案链（identifiable_effect → 配方固化候选） |
| 127 | MERGED | merge commit (first-parent) | `91b1f1161836` | 2026-11-09 | YES | test(acceptance): Channel/Project 全流程实机验收（v0.10.0） |
| 128 | MERGED | squash/rebase | `7197ab2ff2b4` | 2026-11-09 | YES | feat(rsi): WP-D3/D4/D5 Stage-1D 收口（知识工件候选 + 实例 profile 继承） |
| 129 | MERGED | squash/rebase | `47af1b1c3e6b` | 2026-11-09 | YES | feat(rsi): WP-B1 Harness Profile 版本化（可进化外壳的版本载体） |
| 130 | MERGED | squash/rebase | `5a56d56e47a6` | 2026-11-09 | YES | feat(rsi): WP-B3/B4 晋升门 + 回滚（经验/Profile 生命周期收口） |
| 131 | MERGED | squash/rebase | `a8e0ef6167ed` | 2026-11-09 | YES | feat(rsi): WP-C3/C4 元层成效表 + 判据数值扩展 |
| 132 | MERGED | squash/rebase | `2a640dff76a6` | 2026-11-09 | YES | docs(rsi): 实施状态与剩余 WP 交接（2026-11-09） |
| 133 | MERGED | merge commit (first-parent) | `d3eda9e256fd` | 2026-11-09 | YES | test(acceptance): 全功能实机验收 @ main 91b1f116 |
| 134 | MERGED | squash/rebase | `516f3c463491` | 2026-11-09 | YES | test(rsi): 全系统验收证据 2026-11-09（T0-T5 + RSI 实机） |
| 135 | MERGED | squash/rebase | `fcdc9b2dc993` | 2026-11-09 | YES | feat(rsi): WP-C0/C2 插件热重载原子化 + 学习性护栏 |
| 136 | MERGED | squash/rebase | `47a03efa4ad5` | 2026-11-09 | YES | feat(rsi): WP-C1/C2 独立回读验证器 + E5-lite 配对评测 |
| 137 | MERGED | squash/rebase | `0cbc16c6d1d2` | 2026-11-09 | YES | fix(rsi): 经验看板只统计经验行 + 自进化全链验收脚本 |
| 138 | MERGED | squash/rebase | `cf683d42d422` | 2026-11-09 | YES | fix(rsi): 计划对照补齐（红线进 lint / C1 接 L1+C4 / 元层 API / E5 文档） |
| 139 | MERGED | squash/rebase | `1af4e5f8c596` | 2026-11-09 | YES | fix(rsi): 产线写台账频道归因 + 真实环境 RSI 端到端验收（32/32） |
| 140 | MERGED | merge commit (first-parent) | `72edc81a518f` | 2026-11-09 | YES | fix(dcw): P0 写面安全 —— 拒绝 null/空串/数组折叠成 0 下发 + 审批裁决显式布尔 |
| 141 | MERGED | merge commit (first-parent) | `71950b945230` | 2026-11-09 | YES | fix(api): 校验失败错误码在 HTTP 层可达 + 会话/任务端点不再吞校验错误 |
| 142 | MERGED | merge commit (first-parent) | `3cb3ec2b1f57` | 2026-11-09 | YES | fix(industrial): 产线治理一致性 —— 死开关接上、写意图门补齐、二级认证不再绕过 |
| 143 | MERGED | merge commit (first-parent) | `61fe5f426462` | 2026-11-09 | YES | fix(runtime): effects 崩溃恢复 + 关停定时器泄漏 + DCW 驱动不再降级 mock |
| 144 | MERGED | merge commit (first-parent) | `0b5706f6056f` | 2026-11-09 | YES | fix(session): 工具桥消息带会话戳 + 广播不跨会话 + clone 名跨会话唯一 |
| 145 | MERGED | merge commit (first-parent) | `c1b6647c14f5` | 2026-11-09 | YES | fix(web): 202 复核挂起不再当成功 + apiFetch 401 与 axios 共用收尾 |
| 146 | MERGED | merge commit (first-parent) | `74fad79dfbf9` | 2026-11-09 | YES | fix(session): 建会话原子化 + 并发 close 去重 + 工具策略复用主连接 |
| 147 | MERGED | merge commit (first-parent) | `a14dab0afba9` | 2026-11-09 | YES | fix(harness): 能力声明如实化 + 手工接入的工具面显式标注 |
| 148 | MERGED | merge commit (first-parent) | `9350a0743c30` | 2026-11-09 | YES | fix(ops): 优雅停机通道 + 密钥指引纠正 + 会话/插件契约收口 |
| 149 | MERGED | merge commit (first-parent) | `2d390f7ad999` | 2026-11-09 | YES | fix(governance): 档位降级可观测 + memoryPolicy 接线 + 会话上限 + 文档计数清零 |
| 150 | MERGED | merge commit (first-parent) | `3cf950c434c2` | 2026-11-09 | YES | test(acceptance): 实机验收 34/34 + 停机钩子挂死兜底 |
| 151 | MERGED | squash/rebase | `89e5f2ba2178` | 2026-11-09 | YES | docs(rsi): 全系统检查 + deepseek-flash 真实作业端到端验收报告（图文） |
| 152 | MERGED | merge commit (first-parent) | `d71e1cf1331c` | 2026-11-09 | YES | fix(project): retry 支持 CANCELED/COMPLETED 重派 + 全链 E2E 修复至 73/73 |
| 153 | MERGED | merge commit (first-parent) | `2fb663d355dc` | 2026-11-10 | YES | fix(runtime): 监管硬超时读设置(不再 360s 硬编码)+ 超时不再合成 cancel |
| 154 | MERGED | merge commit (first-parent) | `a710c29f1053` | 2026-11-10 | YES | fix(recovery): 救援强制重组 + 已停实例重装配 + WAITING 孤儿进救援 |
| 155 | MERGED | merge commit (first-parent) | `f7595ce6d62d` | 2026-11-10 | YES | fix(project): 无在飞停滞可见 + 失败事件进慢路径 + 兜底复核复算内容哈希 |
| 156 | MERGED | merge commit (first-parent) | `4cf9ab07b780` | 2026-11-10 | YES | fix(hitl): 决策旁路补 finalize + 登记降级留痕 + 新增历史读面 |
| 157 | MERGED | merge commit (first-parent) | `456d8895230f` | 2026-11-10 | YES | fix(rsi): bench 门 provenance —— 评测台账 + promote 只认 benchRunId + 关两条旁路 |
| 158 | MERGED | merge commit (first-parent) | `fc2b4994ffe8` | 2026-11-10 | YES | fix(rsi): 经验状态单调性 + 合并端点 + 提案生命周期(按源收口/过期/人工裁决) |
| 159 | MERGED | merge commit (first-parent) | `3d767c7d7de5` | 2026-11-10 | YES | fix(rsi): bench 落库兼容 harness-ab 字符串 seed + 验收脚本走新契约 |
| 160 | MERGED | squash/rebase | `8aa3fedef822` | 2026-11-10 | YES | docs(rsi): 第二轮验收——RSI 越用越聪明实证 + AML/本体/求解器复用审计 |
| 161 | MERGED | squash/rebase | `7d37ad900fd3` | 2026-11-10 | YES | style: 修 main lint 红（state.ts quote-props 一致性） |
| 162 | MERGED | squash/rebase | `91f02b40da32` | 2026-11-10 | YES | fix(scheduler): 根任务过期收口解耦到调度锁外（P1: ROOT_TIMEOUT 饿死修复） |
| 163 | MERGED | squash/rebase | `eb74b2bc9b62` | 2026-11-10 | YES | fix(runtime): 消息级活性看门狗 + supervise ensureClient 超时（P1: 空闲 lead 信箱卡死修复） |
| 164 | MERGED | squash/rebase | `dd946405529a` | 2026-11-10 | YES | feat(process-model): 真实线动作证据从干预台账派生（P1-C: real 作用域优化资格打通） |
| 165 | MERGED | merge commit (first-parent) | `fa9ecf5f892d` | 2026-11-10 | YES | fix(project): 取消/终止硬停 —— 开工栅栏 + 派发后 CAS + 任务树 abort |
| 166 | MERGED | squash/rebase | `7aeb34840ed6` | 2026-11-10 | YES | fix(aml): 数据集网格对齐改最近邻+容差（修真实多节点 50% 缺失） |
| 167 | MERGED | squash/rebase | `0a3b20ea6ff0` | 2026-11-10 | YES | fix(process-model): real 动作证据按 MV 节点收窄（防同批次 ACK 污染） |
| 168 | MERGED | squash/rebase | `19b95441c806` | 2026-11-10 | YES | fix(process-model): action evidence filter covers MV exec node (DCW) and DAQ mirror |
| 169 | MERGED | merge commit (first-parent) | `2f8677a56667` | 2026-11-11 | YES | test(scheduler): lock-held ordering regression + P1 verify evidence |
| 170 | MERGED | merge commit (first-parent) | `f951fa03ebbb` | 2026-11-11 | YES | fix(aep): agent.block 协议面补全 —— 帧类型入册/分组/派生块 harness 归因/移除死字段 |
| 171 | MERGED | merge commit (first-parent) | `7835b4b32b1b` | 2026-11-11 | YES | fix(harness): 能力声明对齐事实 —— mock supervise/crush bridge/pi 发射面/HITL 证据机检 |
| 172 | MERGED | merge commit (first-parent) | `675d95e2bd77` | 2026-11-11 | YES | fix(web): agent.block 前端硬化 —— 渲染防御/过滤对称/注意力同档 |
| 173 | MERGED | merge commit (first-parent) | `aabe2ae8ac6d` | 2026-11-11 | YES | feat(workshop): 频道工具用量聚合 API —— agent.block 下游业务消费者 |
| 174 | MERGED | merge commit (first-parent) | `bee38de8a5d3` | 2026-11-11 | YES | fix(omp): identity 重写补 harness;治理审计 WIP 测试恢复全绿 |
| 175 | MERGED | merge commit (first-parent) | `5527d896c681` | 2026-11-11 | YES | fix(hitl): 三族桥应答映射抽纯函数并单测锁定 |
| 176 | MERGED | merge commit (first-parent) | `0eac6fb587cc` | 2026-11-11 | YES | fix(project): harden cancellation and terminal state gates |
| 177 | MERGED | merge commit (first-parent) | `942a9954c4b4` | 2026-11-11 | YES | feat(ui): P0 shell, tokens and navigation a11y |
| 178 | MERGED | merge commit (first-parent) | `28b9c9bd9433` | 2026-11-11 | YES | feat(ui): ChatGPT-style chat rhythm and chat accessibility |
| 179 | MERGED | merge commit (first-parent) | `f50587445f98` | 2026-11-11 | YES | feat(ui): dashboard shift band and real alarm queue |
| 180 | MERGED | merge commit (first-parent) | `0644534e0369` | 2026-11-11 | YES | fix(rsi): enforce evidence integrity and lifecycle CAS gates |
| 181 | MERGED | merge commit (first-parent) | `ed41a5b01362` | 2026-11-11 | YES | fix(workshop): session message idempotency + DAQ provenance + shutdown races |
| 182 | MERGED | merge commit (first-parent) | `7f28ccb9e5f6` | 2026-11-11 | YES | fix(db): 存量库升级不再因 client 幂等索引崩溃 |
| 183 | MERGED | merge commit (first-parent) | `19d19a4e382a` | 2026-11-11 | YES | test(rsi): live E2E 改用本频道 validated pin（对齐 #180 治理收紧） |
| 184 | MERGED | merge commit (first-parent) | `5d62bed405ac` | 2026-11-11 | YES | release: v0.11.1 — 加固收口（取消硬停 / RSI 证据完整性 / Session 幂等 / 升级安全） |
| 185 | MERGED | squash/rebase | `744c07e19381` | 2026-11-12 | YES | fix(acceptance): preflight recipe trials and lock AML nearest alignment |
| 186 | MERGED | squash/rebase | `6af25a8b10ec` | 2026-11-12 | YES | fix(recipe): reject coercible trial values before HITL |
| 187 | MERGED | squash/rebase | `fc002d2aaf34` | 2026-11-12 | YES | chore(release): v0.11.2 final acceptance closeout |
| 188 | MERGED | merge commit (first-parent) | `39eb47d3c81f` | 2026-11-12 | YES | feat(ui): alarm truth and calm destructive actions |
| 189 | MERGED | merge commit (first-parent) | `ccb5640571b6` | 2026-11-12 | YES | feat(ui): responsive DCW cockpit |
| 190 | MERGED | merge commit (first-parent) | `54d66616aad7` | 2026-11-12 | YES | feat(ui): unified work surfaces, chat receipts and approvals |
| 191 | MERGED | merge commit (first-parent) | `ac635bcb121c` | 2026-11-12 | YES | fix(ui): tablet DAQ cards and touch hit areas |
| 192 | MERGED | squash/rebase | `e2f5b6794ca3` | 2026-11-12 | YES | fix(ui): close responsive acceptance gaps |
| 193 | MERGED | merge commit (first-parent) | `5ea1c591c9ed` | 2026-11-12 | YES | fix(ui): close round-2 audit findings |
| 194 | MERGED | squash/rebase | `1555ded2c456` | 2026-11-12 | YES | fix(security): harden industrial control boundaries |
| 195 | MERGED | squash/rebase | `5b1d31b32057` | 2026-11-13 | YES | docs(plan): define domain-neutral context learning framework |
| 196 | MERGED | squash/rebase | `c9479938e52b` | 2026-11-13 | YES | fix(session): isolate context and advance message compaction |
| 197 | MERGED | merge commit (first-parent) | `206e8b6109b1` | 2026-11-13 | YES | feat(auth): secure browser sessions and websocket tickets |
| 198 | MERGED | merge commit (first-parent) | `d99dd11b27ce` | 2026-11-13 | YES | feat(ops): harden API contracts and database recovery |
| 199 | MERGED | squash/rebase | `2dda8620b395` | 2026-11-13 | YES | fix(project): revalidate draft dependency contracts |
| 200 | MERGED | squash/rebase | `f155a7a43523` | 2026-11-13 | YES | fix(session): normalize legacy compressed brief budget |
| 201 | MERGED | merge commit (first-parent) | `e23ba582ebf9` | 2026-11-13 | YES | feat(daq): expose signal quality and stale state |
| 202 | MERGED | merge commit (first-parent) | `a2e9b3fa73ee` | 2026-11-13 | YES | fix(ui): close lifecycle theme and delivery gates |
| 203 | MERGED | merge commit (first-parent) | `e17546f2f67c` | 2026-11-13 | YES | fix(review): close post-merge hardening findings |
| 204 | CLOSED | manual merge (GitHub 502) | `6e5a77c0` | — | YES (6e5a77c0, identical tree) | fix(closed-loop): restore dispatch attribution and independent readback |
| 205 | MERGED | merge commit (first-parent) | `c5542b4b9b9b` | 2026-11-13 | YES | fix(goal): block out-of-band task completion + repair P12 pre-goal setup |
| 206 | MERGED | merge commit (first-parent) | `abb678748f7a` | 2026-11-14 | YES | feat(rsi): Beta RSI context/research/evidence/learning interface plugin |
| 207 | MERGED | merge commit (first-parent) | `d4ac2e81f799` | 2026-11-14 | YES | fix(optimizer): honor physical DCW step limits in governed dispatch |
| 208 | MERGED | merge commit (first-parent) | `818682181463` | 2026-11-14 | YES | docs(rsi): record post-merge final gates evidence |
| 209 | MERGED | merge commit (first-parent) | `af7f26c3f4ba` | 2026-11-14 | YES | docs(rsi): record independent review approval for rsi closure round |
| 210 | MERGED | merge commit (first-parent) | `e6df87e7719b` | 2026-11-14 | YES | fix(plugins): close serial probe and diagnostic export surfaces |
| 211 | MERGED | merge commit (first-parent) | `699db17a9470` | 2026-11-14 | YES | fix(rsi): resolve beta scope from host authority and harden evidence surface |
| 212 | MERGED | merge commit (first-parent) | `f600bb57a8e6` | 2026-11-14 | YES | fix(plugins): make extension lifecycle rollback complete |
| 213 | MERGED | merge commit (first-parent) | `f4f4d8dccd08` | 2026-11-14 | YES | docs(rsi): record round-3 final gate evidence |
| 214 | MERGED | merge commit (first-parent) | `b7a326ae89ec` | 2026-11-14 | YES | feat(rsi): add read-only operational evidence for beta |
| 215 | MERGED | merge commit (first-parent) | `b1a09d7592e7` | 2026-11-14 | YES | fix(rsi): wire live plugin services and add off/on compatibility matrix |
| 216 | MERGED | merge commit (first-parent) | `e4885f654ed1` | 2026-11-14 | YES | fix(diag): audit denials through the host ops service seam |
| 217 | MERGED | merge commit (first-parent) | `ff306531f812` | 2026-11-14 | YES | docs(rsi): record final acceptance on e4885f65 |
| 218 | MERGED | merge commit (first-parent) | `b6847187c01b` | 2026-11-14 | YES | fix(rsi): harden operational evidence and scope truth |
| 219 | MERGED | merge commit (first-parent) | `16e5c5680fc4` | 2026-11-14 | YES | docs(audit): record round-4 system evaluation and IDD/RAG evidence |
| 220 | MERGED | merge commit (first-parent) | `c6a1d4be4c01` | 2026-11-14 | YES | docs(audit): audit all PRs merged into main |
| 221 | MERGED | merge commit (first-parent) | `2f05f49ad7c8` | 2026-11-14 | YES | feat(workshop): isolate generic and production channel sessions |

## 5. 复核命令

```bash
git fetch origin
git log --oneline -3 origin/main                 # 2f05f49a
git log --first-parent --merges origin/main | wc -l   # 159
git log origin/main --oneline --grep="^Revert"        # 空
gh pr list --state open --limit 20                     # 空
git merge-base --is-ancestor 6e5a77c0 origin/main     # #204 手工合并
git diff 1ae8f590 6e5a77c0                             # #204 tree 一致(空)
```

> 说明:本报告统计的是 **base=main** 的 PR;功能分支内部的中间 PR/分支不计入。全部 215 个 MERGED PR 的 `mergeCommit` 均已用 `git rev-list origin/main` 祖先集合校验通过。
