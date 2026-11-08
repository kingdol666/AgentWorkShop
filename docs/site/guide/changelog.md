# 版本历史

> 完整发布产物与逐版本说明见 [GitHub Releases](https://github.com/kingdol666/AgentWorkShop/releases)。
> 以下为核心版本节点——每个节点对应一轮可验收的能力跃迁,验收证据收录于 `docs/audit/`。

## v0.10.0 — Harness 控制台 × Channel 多会话 × Project 交付(2026-11-09)

- **ChatGPT 式 Harness UI**:Channel 控制台、Project 详情与入口页统一重排——800px 阅读列、Agent 通栏块、用户右侧浅泡、每条回复带 harness 标识、26px 圆角 Composer、黑白发送钮;全部 `data-testid`、快捷键、@ 提及、HITL 语义与 API 保留(PR #107 / #108 / #109)。
- **Channel 多会话**:模板 → 频道 → 会话;每个会话克隆基础成员,拥有独立 runtime / mailbox / 执行锁 / 引擎进程 / 记忆域;会话内串行、会话间并行;关闭一个会话会取消其在飞任务树并卸载 clone,基础成员与其他会话不受影响。
- **Project 交付模式**:蓝图一键实例化、计划审批、带 `dependsOn` 的 WBS、技术 L1 复核、Owner L2 验收、交付物与成果台账;`observe / supervised / auto` 三模式;completed 项目可持续开发(plan vN+1)。
- **产线实证**:CAL-3 四期递进(只读分析 → HITL 写入 → 训练数据集 → 有界自主优化)真实产线 **78/78**;Channel 多会话 **20/20**;多 harness 隔离 **24/24**;Project 交付 **58/58**;UI 交互 **12/12**;unit **1253 pass / 0 fail / 2 skip**;typecheck ✔ / lint 0。
- **文档**:README(中/英)重写;新增 [Harness 控制台](/guide/harness-ui)、[Channel 多会话](/guide/channels-sessions)、[Project 模式](/guide/projects) 三篇双语指南;README 设计画布 `docs/design/2026-11-09-readme/canvas/`。

## v0.9.x — 科学探索闭环(2026-11)

- **v0.9.5(2026-11-03)** — **全功能多场景验收收口(T0–T5 + H1–H8)**:①**静态响应面数据集不再参与动态 G6 动作覆盖门**——`static_response@1` 按窗口聚合稳态样本,不做时间维因果识别,原实现把连续扫描判成"纯阶梯"而拒绝训练(优化器 live 105/105 复绿);②**Twin Provider Registry 改全局单例**——dev/多模块图下插件宿主的注册与工具面解析不再分属两份实例(`TWIN_PROVIDER_UNAVAILABLE` 消除,模型闭环 live 53/53);③HITL 审批超时 timer 保持引用(空闲事件循环不再让 Promise 永久 pending);④CI 增加 `pnpm/action-setup` 引导;⑤本体/模型/优化器实机套件夹具对齐 G6 与异步插件装载。验收:T0 静态五门全 0 · T1 单测 1017/1015/0 + MCP/插件/SDK/孪生/skills 全绿 · T2 科学 21/21·闭环 20/20·产线 44/44·本体 57/57·本体真机 87/87·模型闭环 53/53·优化器 105/105·异构 MES 23/23 · T3 api-live 71/鉴权 29/0/REST 鲁棒/时区 · T4 11 插件 failures=[]、工具 129(108 builtin)全 available · T5 build/冒烟/pack · UI 8/8;注塑闭环因演示实例无「工艺优化」worker 未跑(如实声明)。证据 `docs/audit/evidence/2026-11-03-full-acceptance-v094/`。

- **v0.9.4(2026-11-03)** — **多源异构数据与 MES 接入面全量落地(H1–H8)**:①**MES 历史 → 平台 TSDB 桥**——Agent 工具 `mes_bridge` + `POST /api/workshop/mes/bridge`,scalar 入 `daq_samples`、vector/image 入 `daq_frames`(像素入对象存储),按批次窗口打标、`(node,ts)` 幂等、批次窗外只打线标、窗口 ≤7 天/单次 ≤5000 行;`aml_dataset_build` 与 `aml_node_catalog` 接受 mes-rest 点位,打通"MES 数据 → 数据集 → 训练";②**向量网格按点位可配**——节点 `driverConfig.resamplePoints`/`sinkOverrides` 覆盖模板 resample,创建/修改期校验坏配置;③**导出 environment 列**——MES 与 DAQ 导出 `with_context=true` 追加 `line_id,run_id,product_id,recipe_id`(默认关闭保持列契约,manifest/README 始终带环境摘要);④**监督中止决策纯函数化**并补单测(`abortToCancelDecision`);⑤**MES 图像帧统一检索面**——`mes_fetch` 内联图像自动归档到 `daq_frames`/对象存储,frames API 接受 mes-rest 点位(`lineIdOf` 按真实产线鉴权,无缩略图回退主图);⑥**mes-rest 限速/并发配置化**——按目标 origin 的令牌桶 + 并发闸,节点 `rateLimitPerSec`/`maxConcurrent` 覆盖;⑦**DAQ 导出流式分页**——逐页解出即写盘,内存只留一页;⑧**MES 映射模板库**——6 个模板 + `GET/POST /api/workshop/mes/templates`,接入从"写三段 JSON"降为"选模板+填端点"。验收:单测 1017 项 / 1015 通过 / 0 失败 · lint 0 · typecheck 通过 · 异构/MES 验收 23/23 · 科学全链 21/21。详见 `docs/plans/2026-11-03-heterogeneous-mes-plan.md`。

- **v0.9.3(2026-11-03)** — **复验遗留四缺陷收口(P2–P5)**:①真实线 DoE 计划创建/执行前新增**步限可达性校验**——水平间隔与当前值到最近水平的距离超过有效单步限制(节点/参数/配方三层取最小,与写联锁同口径)即 422 拒绝,不再浪费一次 HITL 批准与产线窗口;执行器步序改为**蛇形可行遍历**(控制量内单调、repeat 边界变化为 0,跨控制量仍种子交织打散,满足 G6 来回阶梯);②向量/图像 DAQ 帧成功解析即**清除陈旧 `lastError`**(与标量路径同自愈语义;warn/alarm 仍由模板警告带/指标规则正确判定);③Lead 监督回合被中止(外部取消/硬超时)时,在办任务自动转 **cancel 决策**收口(带原因、可重派),不再滞留 WORKING 需人工取消;④**增益估计只信可辨识步**——新增 `estimateGainFromRows`(欠功效/混杂/负结论/Δ=0 一律排除并如实给 excluded 分母),试验结果透出 `estimatedGain/gainSamples/gainExcludedSteps`。另:`e2e-hitl-live`/`e2e-auth-matrix` 支持 `AW_BASE`。多源异构数据与 MES REST 接入面核查与优化计划(H1–H8)见 `docs/plans/2026-11-03-heterogeneous-mes-plan.md`。验收:单测 998 项 / 996 通过 / 0 失败 · lint 0 · typecheck 通过 · 科学全链 21/21 · 产线治理 44/44 · 本体 57/57 · 注塑闭环 6/6。

- **v0.9.2(2026-11-03)** — **真实作业演示驱动的三处写控修复**:①执行器在真实线首步前等待 60s 在线写间隔(刚开线/刚手动写过的节点不再让整份计划白失败);②写间隔被拒改为**同一步有上限重试**(安全联锁不绕过,但不再直接判计划失败);③**保写心跳与 60s 间隔活锁修复**——节点新增 `lastChangeAt`,60s 间隔只以"值发生变化"为基准,同值心跳不再推进;试验计划校验拒绝启用 `holdIntervalMs` 的控制节点(要求先置 0)。演示:PLC 模拟器孪生(modbus-tcp)+ 真实线 DoE → 基线 31.736g → 3/3 步执行 → 判定回填 + 证据 3 条 → 由实测增益下发 SP 60.6 → **重量 32.088g 入窗 [32.00,32.30]**,15/15 PASS(证据 `docs/audit/evidence/2026-11-02-e2e-optimization-demo/`)。

- **v0.9.1(2026-11-02)** — **上线前安全加固(DoE 与下发互审)**:①真实线试验计划创建/执行双重复核节点归属——跨线注入、节点不存在、targets 指向数控节点、水平越安全量程一律 422 拒绝(批准后执行器以平台身份直写,归属校验必须前移);②**运行中可取消**(每步前感知 cancelled,状态 `cancelled`,已执行步台账保留);③真实线每步驻留强制 ≥60s(与写联锁同口径,避免第 2 步被 429 打回白跑产线时间);④僵死 `running` 超预算+5min 自动置 failed;⑤**双通道互审接入下发路径**:渠道绑定 ARX 模型的工况下,`optimization_explore` 在 auto 模式被"模型有效应 + 本体明确无耦合"确证冲突直接拒(带可证伪说明),unknown 不拦,`AW_CROSSCHECK_GATE=0` 逃生;⑥干预台账判定态收敛为联合类型(修两处类型漏洞)。验收:单测 992 项 / 990 通过 / 0 失败 · lint 0 · typecheck 通过 · 科学探索闭环 E2E **20/20** · 文档一致性 89/0。
- **v0.9.0(2026-11-02)** — **可证伪的探索闭环:可辨识性门禁 · 干预台账 · 正交 DoE · 本体证据回灌**。新增 `aml/identifiability.ts`(主导扰动周期 / 建议窗 3×周期 / bootstrap CI / MDE / 共线诊断;窗口充分的无效应 = 可辨识负结论,欠功效时禁止声称有效应)并接入探索前置门与判读文案(`AW_IDENT_GATE=0` 逃生);新增全路径**干预台账** `intervention_events`(手动/Agent/配方/回退在 DCW 写咽喉单点入行,判定回填);新增 **G6 动作覆盖门**(控制水平数 ≥3、与时间 \|r\| ≤0.9,另用连续段判据抓 2 水平纯阶梯)+ ARX 阶跃仿真动作敏感度;`process_model_experiments` **真实线分级解锁**(仿真线直跑;真实线 HITL 单卡 + 成本核算;随机化步序种子 = 计划 id、跨控制量打散、告警中止、预算上限、逐步关闭记录并判读);新增**双通道互审**(模型增益 vs 本体耦合边;确证冲突自动拒,unknown 不拦)与**审批卡科学载荷**(效应/CI/MDE/覆盖/证据边/可证伪方式);判定回灌 `ontology_evidence`(幂等,support/refute 计数);KB 入库审批卡标注无证据锚因果断言(anecdotal)并留审计。新工具 `daq_identifiability` / `intervention_history`(宿主工具 105→107),设置 138→140(aml 组 19)。验收:单测 986 项 / 984 通过 / 0 失败 · lint 0 · 全链路验收 19/19(`scripts/acceptance-scientific-loop.ts`)· 文档一致性 89/0。详见 `docs/plans/2026-11-02-scientific-exploration-acceptance.md`。

## v0.8.x — 知识与闭环(2026-10 下旬)

- **v0.8.8(2026-10-31)** — **时序存储治理与生命周期健壮性收口 + bench v2 写面**:压缩 chunk 上 `ctid` 批删必炸(TimescaleDB 2.29 实证)改为时间分片普通 DELETE;rollup SQL 三层修复使 1m/1h 聚合首次真正落行(运行期新线免重启);历史截断保最新段;逐线保留期 PUT 部分更新不再抹覆写;裁剪上界受聚合水位钳制。任务生命周期四修(停滞误杀/救援竞争/HITL 顺延/孤儿派发);Agent 工具面六修(终态诚实回执/进度钳位/授权回滚/消息校验);插件宿主 home 模式路径回归修复;MQTT 多字段(fields/jsonTemplate);bench v2 写面收尾复绿。验收:单测 913/913 · PIPELINE 执行卡全层(静态 100% · plc 13/13 · E1a 消融 · api-live 75/75 · 冻结基线逐位复现 ×2)· IDD/RAG 集成链真机全通 · P12 真实 harness episode。
- **v0.8.7(2026-10-29)** — **错误台账 error-ledger 全链 + /logs 日志页生产化**:全异常入账三入口、限流去重、对抗套件 26 断言;/logs 采集-检索-脱敏;README 双语重设计。
- **v0.8.6(2026-10-28)** — **多专家设计审查整改(P0×2 + P1×11)**:Modbus `little` 字节序纠正为**标准 DCBA**(旧实现实际解出 BADC,真实设备会静默读成 1e-41 量级);掩码凭据回写不再覆盖真实口令(入口单点剔除);帧指标告警跨帧保持;停线补种以补种时刻入库;外部 ingest 与驱动共用 sink 管线;系统兜底回退 await 后重验;配方频控在飞占位;委派 auto 必须显式确认 + 审计;`recipe_update` 审批期定义指纹比对;停机窗口不再假送达;人类调用作用域失败路径收口;工具活性信号覆盖 omp 原生;Timescale `queryTagged` 补 state/ingested_at 与分页;owner-FK 老库迁移补齐 8 列不再丢数据。验收:单测 739/739、API 61/61、产线治理 44/44、真实场景(Qwen3.5-9B + omp,worker 身份)17/17。详见 `docs/audit/2026-10-28-multiexpert-remediation-acceptance.md`。
- **v0.8.5(2026-10-28)** — **频道执行三模式**(observe / manual / auto)+ MQTT 结构化解码(jsonPath 单字段入库 / jsonKey 封装下发 / readTopic 回读)+ 安全加固 S1–S16(启动屏障、未知驱动 fail-loud、未来时间戳、MQTT 身份、告警产线隔离、Modbus 范围、单实例数据锁等)。
- **v0.8.4(2026-10-26)** — 3 分钟英文界面宣传片(README / VitePress / 独立播放页)+ EDA 管道标题、在线查看器高度与本体基线 i18n 修复。
- **v0.8.3(2026-10-26)** — 结果库复验收尾(L1/L2/L4)+ 净树发布准备;全局零态实测修正。
- **v0.8.2(2026-10-25)** — 结果库 reviewer 修复:PATCH 角色闸门、热开关、绝对 URL 与证据链。
- **v0.8.1(2026-10-25)** — **diag-bridge 分析结果库**:`diag_results` / `diag_result_get` / `diag_result_annotate` 三工具 + `/plugins` 结果面板 + 五项治理开关,默认关闭,可见面 = 诊断 Token 属主。模型**可读元数据**与本体草稿**一键自修复**;本体图 tab 升级为**节点-边可视化**(1/2 跳邻接抽屉)。同轮全量验收 821 检查全绿。
- **v0.8.0(2026-10-24)** — **本体服务 + AI 先行模型闭环**:10 类实体 × 8 种封闭关系 × 三级证据 × 五态生命周期;编译四工件(过程模型 / ProblemIR 增量 / 场景契约 / 控制守卫)带只收紧不变量与 Rule Trace;Agent 亲手建虚拟模型并经 `optimizer_profile_propose` 提议采纳,HITL 批准即发布+自动重绑——真机两轮 v1→v2→v3 零设备写入。72/72 本体 e2e · 46/46 模型闭环 e2e。详见[本体与 AI 先行模型闭环](./ontology.md)。

## v0.7.6x–7x — 治理与优化(2026-10)

- **v0.7.71(2026-10-24)** — **工艺优化器与求解器**:过程模型 → AML 训练(G1–G3 门禁)→ Profile 冻结 → ProblemIR 哈希锁定 → OSQP/SLSQP 求解 → TS 独立重算交叉核验 → 治理下发;**工具面声明式治理**(104 宿主工具全显式 references 声明)。
- **v0.7.70(2026-10-21)** — **数据管理台 + EDA 工坊**(`/data` · `/studio`):复合查询、批量导出、golden 轨迹、FDC/SPC(Nelson 1-8 / EWMA / CUSUM)、OCAP、虚拟量测、派生数据集。详见[数据管理台与 EDA 工坊](./eda.md)。
- **v0.7.66(2026-10-17)** — **工具调用统一预检**(tool-verify:参数形状 + 引用归属面 + 链式谱系回溯)。
- **v0.7.63–65(2026-10-15/16)** — 数据分析台账定稿(`analysis_reports` + `/analysis` 页 + IDD 六意图目录),死工具摘除。详见[数据分析台账](./analysis-reports.md)。
- **v0.7.62(2026-10-13)** — **数据分析系统**:`analysis_save` / `analysis_query` 一等记录,产线级权限隔离。
- **v0.7.58(2026-10-11)** — **生产化硬化**:保写心跳生命周期、mock 静默兜底封堵、帧指纹 + 对象 GC、Timescale 按天 chunk + 列存压缩、堆水位自动重生。

## v0.7.4x–5x — 平台底座(2026-09)

- **v0.7.54(2026-09-30)** — 全协议矩阵回归(Modbus/OPC UA/MQTT/HTTP/串口)与 MES 集成收尾。
- **v0.7.52(2026-09-28)** — 团队知识库开关、lead→worker 节点委派、通用闭环优化模板。
- **v0.7.50(2026-09-28)** — **双模式优化闭环**(production 影子/投用)、任意场景孪生建模、`aw mcp` 网关、产线操作页、时区底座。
- **v0.7.45(2026-09-21)** — 定时任务调度、DCW 写入保持窗、真实场景合并验收全绿。
- **v0.7.42(2026-09-19)** — 全站中英 i18n 补全与端到端验收。

## 升级说明

语义化版本;`aw start` 每次启动校验配置根并迁移旧版 `data/` 布局(以最新文件为准),数据可跨版本存活;SQLite schema 迁移在服务端启动时执行。
