## Current unmerged source / 当前未合并源码 — compatibility boundaries（unreleased, under review / 未发布、待审查）

- The agent-token bridge lacks trusted turn provenance: hazardous and authorization/dispatch tools are filtered and denied; plugin tools must explicitly declare `riskClass: 'read'` to pass that layer, with other governance checks still applicable. agent-token 回程桥缺少可信回合来源，危险和授权/派发工具被过滤并拒绝；插件须显式声明只读风险类别才能通过该层。
- `dispatch_task` rejects combined `grant_node_ids` / `grantNodeIds`. Where needed, explicitly grant with `team_grant_nodes` before dispatch; these are not atomic and a failed dispatch does not undo the grant. `manual` is the delegation default; `auto` requires `confirm: true`. 派发不再随任务授权，应先单独授权再派发；失败后检查并按需撤销授权。
- Aborted native omp work or supervision turns retire their process. Late-frame provenance after normal completion remains unresolved; no new physical HIL or security-pass claim. 原生 omp 工作或监督回合中止时退役进程；正常完成后的迟到帧来源问题仍未解决，不作新增物理 HIL 或安全通过声明。
- Saved Channel scenario prompts, member configurations and custom prompts are not automatically rewritten. Review and manually migrate obsolete combined-grant instructions while preserving customization. 存量场景提示词、成员配置及自定义 prompt 不会自动改写，请检查并手动迁移旧指令。
- Structured recipe-propose approval cards take a 0-based `choice` index into the package list; an out-of-range or missing `choice` on an approval is fail-closed denied. 结构化配方审批卡的 `choice` 为方案集 0 基下标，越界或缺失一律按拒绝收敛。
- Simulator 冷启动清空预设设备:after a simulator process restart, re-materialize blueprint devices before platform writes (platform recipes/journals persist independently). 仿真器进程重启会清空预设设备，平台写入前需重新物化蓝图（配方与台账独立保留）。

## v0.12.0 — round-3 agent safety boundaries（2026-11-17）

- Claim-token lifecycle: durable per-claim UUID tokens with exact-token CAS for claim/release/requeue/consume/quarantine (`messages.claim_token`, schema contract v3); steer settlement rechecks claim eligibility before consume and quarantines recovery-held linkage instead of replaying it. Claim 令牌全生命周期按精确 token CAS 结算;steer 结算前复检资格,恢复保留联动改为隔离不重放。
- Legacy recovery holds with an audited operator disposition: startup holds for active task trees with missing/invalid leases; admin-only `GET /api/workshop/tasks/recovery-holds` and `POST /api/workshop/tasks/:id/recovery-disposition` (audit-logged; releases the connection-tree marker, requeues in-flight messages by retry budget, never auto-replays, task state untouched). 旧任务恢复保留新增管理员处置面（审计留痕、不自动重放、任务状态不动）。
- DCW transport-ack write verification (`holdObserve`): a transport-acknowledged write releases the hold interlock only after an independent DAQ observation follows the target; timeout or missing declaration surfaces an explicit `lastError` instead of silently disabling the heartbeat forever. Observation polls slide their read window and supersede per write generation. transport-ack 写经独立 DAQ 观测跟随才解除保写锁;超时/未声明显式报错而非静默停心跳。
- Simulator ownership attestation: the vendored simulator exposes `/api/attestation` echoing a spawner-injected nonce; `sim-attest.mjs` spawns fail-closed fresh instances; all onboarding entry points verify nonce + loopback + pid + endpoint binding before any platform API request; verify-line V2/V3 writes are unblocked against attested simulators with live driverConfig binding. 模拟器归属证明（nonce 绑定）端到端落地,接入脚本证明前零平台请求,V2/V3 写验收解封。
- Idle-unload guard excludes permanent zombie messages: task-linked rows whose every referenced task no longer exists can no longer block idle unload; raw rows are retained as evidence. 孤儿任务引用不再永久阻塞空闲卸载,原始行留作证据。
- Bugbot hardening: holdObserve observation slides its read window (dense DAQ cadence could pin the newest sample and spuriously time out healthy writes); governance audit pairs driver_start/driver_end on every pre-flight failure; onboarding endpoint scanner matches explicit port/URL keys only. bugbot 加固三件套（观测滑动窗/审计配对/扫描器收紧）。
- Verification: lint, typecheck, build; unit 2015/2017（唯一失败为 main 既有 optimizer 测试,与发布分支零交集）; live acceptances — FA line end-to-end (attested sim → provision 14/14 → forge 7/7 → verify 10/0 incl transport-ack observation with holdBlocked auto-release), RSD line closed loop (analysis → recipe_propose → HITL → governed write verified 1/1 → journal → retest 111.687→108.527 matching model), paper-operator acceptance (optimization_explore Eq.1 live: u0 anchor → HITL choice=0 → journal 146→140 src=agent → exploration record), dual-scenario dispatch/memory (generic + integrated). Mimosa deep scan completed with seal (43 findings triaged, none exploitable business-path; no security-pass claim).
- Boundaries: simulator evidence only, not physical HIL; omp upstream instability under concurrent harness load (PROCESS_EXIT rebuild loops, 15-min supervise hard timeout caps wedged turns; platform defenses hold — no message loss, no double execution); RAG internal `kb_agent` write path remains unreliable (direct API proven); Mimosa inconclusive is not a security pass.

## v0.11.3 — runtime/security hardening, packaged release（2026-11-16）

- Channel config recycle no longer cancels an in-flight root task: supervise marks the lead busy, recycle defers on active work, and the scheduler aborts with an explicit runtime-stop reason.
- `markConsumed` uses a state-only `state='consuming'` guard: it cannot consume while the message is pending or dead, but a stale completion can still consume it after a new claim returns it to `consuming`. This is not per-attempt ownership CAS. `markConsumed` 仅按状态守卫；消息重新认领为 `consuming` 后旧回合仍可能将其消费，并非按执行次数隔离的 CAS.
- DAQ/DCW/MES test-driver routes close the legacy-unset SSRF hole; rag-bridge `web_url` uses the same localhost allowlist as `base_url`.
- `idd-closedloop-bridge` reports `routesReady=false` instead of a false ok when the current IDD has retired the closed-loop HTTP routes.
- `npm pack` excludes local Mimosa/Nuxt state, logs and pid files.
- Verification: lint, typecheck, unit 1790/1790, build, docs 101/101, README, Skills 176/176, MCP 14/14, plugin lifecycle 22/22, SDK, twin 5/5; simulated five-protocol line + IDD optimizer skill + RAG + omp/`deepseek-flash` Channel V1–V6 25/25, HITL 62.5→64 MPa readback 64, retest 32.416 g.
- Boundaries: simulator evidence only, not physical HIL; V6 records no new protected-line journal anchor, not physical zero disturbance. RAG internal `kb_agent` timed out; Mimosa remains inconclusive and is not a security-pass claim.

## Next — PR-9 RSI Beta management surface (2026-11-14)

- Added a read-only RSI Beta management panel to the plugin page with server-reported status, strict flags/scope, adapter health, Context/Research/Evidence provenance, and limitations.
- Added an authenticated metadata route and fail-closed visibility: absent/off flags or absent, stale, or foreign scope never expose an operational Beta surface.
- No approve, promote, actuate, control-write, or profile activation controls were added; existing UI/runtime behavior remains unchanged when Beta is absent or disabled.
- Release notes and operational boundaries: `docs/rsi-beta-management.md`.


## v0.11.2 — final acceptance closeout（2026-11-12）

- `recipe_trial` now rejects deterministic out-of-range and active recipe-window-invalid candidates before HITL, with no approval card, driver write, execution batch, or device mutation.
- Runtime input validation is fail-closed for null, booleans, empty strings, NaN, Infinity and nonnumeric strings; finite numbers and numeric strings remain supported.
- The PR #166 nearest-neighbor production helper has independent regression coverage for offset timestamps, exact timestamp precedence, tolerance boundary and beyond-tolerance missing values.
- Final main `6af25a8b`: unit 1516/1516, PLC 11/11, Agent 9/9, REST/WS/MCP 75/75, Project 14/14, RSI 32/32, multi-round RSI 10/10; UI screenshots captured from the isolated production-style instance.
- Boundaries are explicit: PLC is a digital twin, orchestration uses deterministic mock harnesses, and Mimosa full scan remained incomplete (`scanner_enobufs`); no security-pass claim is made.


完整发布产物与逐版本说明见 GitHub Releases:<https://github.com/kingdol666/AgentWorkShop/releases>

以下为核心版本节点——每个节点对应一轮可验收的能力跃迁,验收证据收录于 `docs/audit/`。

## v0.11.1 — 加固收口：取消硬停 × RSI 证据完整性 × Session 幂等 × 升级安全（2026-11-11）

- **Project 取消/终止硬停（#176）**：canceled 终态全写面 fail-closed（成员/审批/提案/绑定/成果/回调/对账）；runtime 缺失取消能力时 terminate 以 503 回滚；孤立任务实例频道事务内取消 + durable 回收。
- **RSI 证据完整性（#180）**：bench pValue 服务端按 perSeed 配对符号检验重算（客户端自报不再落台账）；经验 merge/promote validated 必须锚定本频道真实 COMPLETED 任务；pin 只渲染本频道 validated 且 scope 匹配的行；生命周期 expected-state CAS。
- **Session 幂等与停机屏障（#181）**：会话消息持久 clientMessageId（channel+session+actor+key 原子 INSERT→冲突回读；异载荷 409）；DAQ 帧 lineId 贯穿 ingest→REST→WS→前端；runtime stop 等待消费循环/dispose。
- **升级安全（#182）**：修复存量库升级启动崩溃（messages 幂等索引改在补列后创建）+ 回归测试。
- 验收：unit 1508/1508 · 生产式隔离验收 9 套件 0 FAIL。

## v0.11.0 — 项目中心 × RSI 经验演化 × 真实模型实证（2026-11-09）

- **项目中心**:`/projects` 成为一等入口(侧栏 / 工作台 / 命令面板 / 路由元数据);列表统计/搜索/筛选/每项目进度,`GET /api/workshop/projects` 追加 `summary` 零 N+1;详情真实频道名、五列执行看板、交付物三级门、决策事件统一时间线、`?tab=` 深链。实机 **39/39**。
- **RSI 经验演化**:沉淀(任务/评审/治理写)→ fail-closed 晋升门(单任务拒)→ 同产线跨 Channel 共享(异线零命中)→ 配对评测 Profile `pin → shadow → active` → 回读验证 mismatch 409 阻断 L1 → 回滚 → 元层成功率;学习环 0 设备写。实机 **32/32**。
- **真实模型实证(omp / `ustc/deepseek-flash`)**:同 Channel 双会话真实回执零串扰;Project 工作项派发到任务实例,619 秒交付 artifact,对账→L1→L2→completed,**13/13**。
- **修正与文档**:手工项目须 `activate` + 已批准 plan v1 才可派发(激活本身不要求计划);计划体不要带 `work_items/deliverables`(避免 plan alignment 重复物化);复核权限 owner/admin/project leader;README 中英与 VitePress 新增 RSI 指南并补齐 Project 项目中心/数据面。
- **质量门**:unit **1356 pass / 0 fail / 2 skip**;lint 0、typecheck ✔、docs 87/0、i18n 3293/3293、auth 29/0、REST ALL PASS;插件 11/11、工具 148(127 builtin + 21 plugin)全 available。

## v0.10.0 — Harness 控制台 × Channel 多会话 × Project 交付(2026-11-09)

- **ChatGPT 式 Harness UI**:Channel 控制台、Project 详情与入口页统一重排——800px 阅读列、Agent 通栏块、用户右侧浅泡、每条回复带 harness 标识、26px 圆角 Composer、黑白发送钮;全部 `data-testid`、快捷键、@ 提及、HITL 语义与 API 保留。PR #107 / #108 / #109。
- **Channel 多会话**:模板 → 频道 → 会话;每个会话克隆基础成员,拥有独立 runtime / mailbox / 执行锁 / 引擎进程 / 记忆域;会话内串行、会话间并行;关闭一个会话会取消其在飞任务树并卸载 clone,基础成员与其他会话不受影响。
- **Project 交付模式**:蓝图一键实例化、计划审批、带 `dependsOn` 的 WBS、技术 L1 复核、Owner L2 验收、交付物与成果台账;`observe / supervised / auto` 三模式;completed 项目可持续开发(plan vN+1)。
- **产线实证**:CAL-3 四期递进(只读分析 → HITL 写入 → 训练数据集 → 有界自主优化)在真实产线 **78/78**;Channel 多会话 **20/20**;多 harness 隔离 **24/24**;Project 交付 **58/58**;UI 交互 **12/12**;unit **1253 pass / 0 fail / 2 skip**;typecheck ✔ / lint 0。
- **文档**:README(中/英)与 VitePress 全面重写;新增 [Harness 控制台](./docs/site/guide/harness-ui.md)、[Channel 多会话](./docs/site/guide/channels-sessions.md)、[Project 模式](./docs/site/guide/projects.md) 三篇双语指南;新增 README 设计画布 `docs/design/2026-11-09-readme/canvas/`。
- **打包**:npm tarball 含预构建 `.output/`;`npm i -g` 全局安装链路实测。

## v0.9.x — Project 层与生产化(2026-11 上旬)

- **Project 层落地**:ProjectService / 办公室频道 / Project Leader / 成员 Channel 绑定 / WorkItem / Attempt / Deliverable / Result / Approval / Event;技术路由与 `routingPolicy=technical` 默认。
- **生产审计修复**:`leaderHarness` 去默认(禁止静默 mock 生产 Leader)、activate 装配 deadline、设置热重载 watcher 监听生效配置目录、lint 基线恢复、CI quick-gate 稳定。
- **部署与验收**:生产部署 runbook;BRG-5 MQTT 新产线 12/12;记账软件 Project 58/58;文档→节点→Channel→Project 全链 48/48。

## v0.8.x — 知识与闭环(2026-10 下旬)

- **v0.8.8(2026-10-31)** — **时序存储治理与生命周期健壮性收口 + bench v2 写面**。时序库五修:压缩 chunk 上 `ctid` 批删必炸(TimescaleDB 2.29 实证)改为 MIN(ts) 快进 + 时间分片普通 DELETE,保留期清理在实例运行满 1 天后不再整体失效;rollup SQL 三层修复(GROUP BY 全列覆盖 / 参数显式类型 / 运行期新线免重启发现)使 1m/1h 聚合首次真正落行;历史窗口截断改保**最新**段并如实上报 truncated;逐线保留期 PUT 部分更新不再静默抹掉既有覆写(undefined=保持 / null=重置);裁剪上界受 1m 聚合水位钳制——"超保留期=降分辨率保留"契约兑现。任务生命周期四修:停滞判定改现读全行 artifacts(有交付物的任务不再被投影空值误杀;根任务不再被规则引擎越权自动验收)、D1 兜底救援投递前复读状态(杜绝同任务第二回合并发执行)、HITL 顺延逐根分流(受审批保护的根不再被连带 ROOT_TIMEOUT,悬空审批单消除)、引擎 dispatch 终态先拒 + 未接取先接取(孤儿子任务消除)。Agent 工具面六修:refuse_task 对终态 409 诚实拒绝(不再照发"请改派"回执诱导重复派发)、report_progress 终态 fail-open 修正 + 进度钳位 [0,100]、dispatch 随单节点授权判重前移 + 派发失败自动回滚授权、消息面空内容校验 + 回执票据发送失败保留。插件宿主 home 模式路径回归修复(设置热更重载后插件数据根漂移 → diag_run 读数据集 ENOENT)。MQTT 多字段采集与下发(`driverConfig.fields` 展开多子节点 + `jsonTemplate` 模板)。bench v2 治理写面收尾(探索步激励语义 delta 修复 + 自举节拍适配),流水线/场景复绿。验收:单测 913/913 · typecheck / ESLint 全绿 · Mimosa 深扫 46 项静态发现全定性(产品代码项逐一亲验)· PIPELINE 执行卡全层实测(静态一致性 100% · plc 13/13 · E1a 四臂消融理论模式全对且误拦恒 0 · api-live 75/75 · vs 20260914 冻结基线判定类逐位复现 ×2)· IDD/RAG 插件集成链真机全通(真 PLC 工况 + omp/ustc-deepseek-flash:导出 → IDD 深度诊断受理 → 知识入库(HITL)→ 检索命中)· P12 真实 harness 透明闭环 episode(资格门全过;越权工具调用被事件监控门当场取消并冻结 153 事件证据)。
- **v0.8.7(2026-10-29)** — **错误台账 error-ledger 全链 + /logs 日志页生产化**:全异常入账三入口、限流去重、对抗套件 26 断言;/logs 采集-检索-脱敏;README 双语重设计(993/1028 → 248/247 行)。
- **v0.8.6(2026-10-28)** — **多专家设计审查整改(P0×2 + P1×11)**:Modbus 字节序纠正为标准 DCBA(旧实现实际解出 BADC);掩码凭据回写不再覆盖真实口令;停线补种以补种时刻入库;委派 auto 必须显式确认;配方频控在飞占位;Timescale `queryTagged` 补 state 与分页;owner-FK 老库迁移补齐 8 列。验收:单测 739/739 · 真实场景(Qwen3.5-9B + omp)17/17。
- **v0.8.5(2026-10-28)** — **频道执行三模式(observe / manual / auto)**:频道级执行档位与产线总闸、绑定模式三层取最严——观察档物理零写(注入白名单+分发按名拒写双保险,MES 只读族纳入观察面)、手动档频道钳位强制逐动作 HITL(审批卡展示 Agent 依据,批准附言回流)、自动档治理写必须附带 `hypothesis` 依据并入审计(`dcw.write.*` detail 记 `executionMode`/`hypothesis`);切换 REST(owner-only,放开方向须 `confirm:true`)+ 每次切换审计 + 成员运行时热回收 + 执行模式提示卡注入 + Channel 设置面三选一(产线总闸压制提示/二次确认)。存量频道缺省 auto(零行为变化)。验收:单测 673/673 · lint/typecheck/i18n/readme/docs 全绿 · e2e 34/34 · 回归 line 44/44 + tool-surface 37/37 + api-live 60/60 · 真实模拟器产线实测(物理写入证实)。另含:审批后活动批次上下文复核、omp 工具执行事件钩子。
- **v0.8.4(2026-10-26)** — 3 分钟英文界面宣传片(README / VitePress / 独立播放页)+ EDA 管道标题、在线查看器高度与本体基线 i18n 修复。
- **v0.8.3(2026-10-26)** — 结果库复验收尾(L1/L2/L4)+ 净树发布准备;全局零态实测修正。
- **v0.8.2(2026-10-25)** — 结果库 reviewer 修复:PATCH 角色闸门、热开关、绝对 URL 与证据链。
- **v0.8.1(2026-10-25)** — **diag-bridge 分析结果库**(`diag_results` / `diag_result_get` / `diag_result_annotate` 三工具 + `/plugins` 结果面板 + 五项治理开关,默认关闭,可见面 = 诊断 Token 属主);模型**可读元数据**与本体草稿**一键自修复**;本体图 tab 升级为**节点-边可视化**(1/2 跳邻接抽屉)。同轮完成全量验收:821 检查全绿(单测 538+ · 真机 e2e · MCP · 注塑 · optimizer-live 104/104)。
- **v0.8.0(2026-10-24)** — **本体服务 + AI 先行模型闭环**:10 类实体 × 8 种封闭关系 × 三级证据 × 五态生命周期;编译四工件(过程模型 / ProblemIR 增量 / 场景契约 / 控制守卫)带只收紧不变量与 Rule Trace;Agent 亲手建虚拟模型(场景发现→冻结→物理骨架→快照→试验)并经 `optimizer_profile_propose` 提议采纳,HITL 批准即发布+自动重绑——真机两轮 v1→v2→v3 零设备写入。72/72 本体 e2e · 46/46 模型闭环 e2e。

## v0.7.6x–7x — 治理与优化(2026-10)

- **v0.7.71(2026-10-24)** — **工艺优化器与求解器**:过程模型 → AML 训练(G1–G3 门禁)→ Profile 冻结 → ProblemIR 哈希锁定 → OSQP/SLSQP 求解 → TS 独立重算交叉核验 → 治理下发;**工具面声明式治理**(104 宿主工具全显式 references 声明,注册期登记制)。
- **v0.7.70(2026-10-21)** — **数据管理台 + EDA 工坊**(`/data` · `/studio`):复合查询、批量导出、golden 轨迹、FDC/SPC(Nelson 1-8 / EWMA / CUSUM)、OCAP、虚拟量测、派生数据集;npm 全局链路实测冒烟。
- **v0.7.66(2026-10-17)** — **工具调用统一预检**(tool-verify:参数形状 + 引用归属面 + 链式谱系回溯);npm latest。
- **v0.7.63–65(2026-10-15/16)** — 数据分析台账定稿(`analysis_reports` + `/analysis` 页 + IDD 六意图目录),死工具摘除,全功能验收 44/44。
- **v0.7.62(2026-10-13)** — **数据分析系统**:`analysis_save` / `analysis_query` 一等记录,产线级权限隔离。
- **v0.7.58(2026-10-11)** — **生产化硬化**:保写心跳生命周期、mock 静默兜底封堵、帧指纹 + 对象 GC、Timescale 按天 chunk + 列存压缩、堆水位自动重生。

## v0.7.4x–5x — 平台底座(2026-09)

- **v0.7.54(2026-09-30)** — 全协议矩阵回归(Modbus/OPC UA/MQTT/HTTP/串口)与 MES 集成收尾。
- **v0.7.52(2026-09-28)** — 团队知识库开关、lead→worker 节点委派、通用闭环优化模板。
- **v0.7.50(2026-09-28)** — **双模式优化闭环**(production 影子/投用)、任意场景孪生建模、`aw mcp` 网关、产线操作页、时区底座。
- **v0.7.45(2026-09-21)** — 定时任务调度、DCW 写入保持窗、真实场景合并验收全绿。
- **v0.7.42(2026-09-19)** — 全站中英 i18n 补全与端到端验收。

> 语义化版本;`aw start` 每次启动校验配置根并迁移旧版 `data/` 布局,数据可跨版本存活,SQLite schema 迁移在服务端启动时执行。
