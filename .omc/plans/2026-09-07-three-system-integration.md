# 三系统集成计划 v2:AgentWorkShop × industrial-deep-diagnostic × rag-knowledge

> **实施实况(2026-09-08 as-built)**:R1-R3 平台修已落地并追加第 4 处——`manager.invokeHostTool` 工具执行错误统一 try/catch 降级 isError(原实现会让 AppError 以 unhandledRejection 杀死 worker)+ `invokeAgentWorkspaceTool` async 化(修复 send_cross_channel_message 缺 await 在成功路径崩溃)。团队演示架构微调:每队 lead=mock(编排/跨通道)+ 1 名 **omp 执行器** worker(REST 工具直调走共享 host-tool-bridge,零 LLM 会话)——mock 无 dispatch 面, 不能作为工具执行体。DAQ 采样间歇(共享实例节拍被并行调节),快照已加「去 lineId 兜底 + 宽窗重试」。

> 状态:**approved**(2026-09-07 用户明确指示执行;经 Architect/Critic 双评审修订)
> 评审结论:Architect「有条件可行」+ Critic「REVISE」→ 本 v2 已吸收全部阻断项(B1-B7)与关键建议(N1-N6)
> 目标:数字孪生闭环——实时数采(AWS DAQ)→ 深度诊断(diag:3210,harness=omp)→ 知识沉淀/检索(KB:8770)→ 控制策略(DCW+HITL)→ 经验学习。

## v2 修订记录(相对 v1,评审驱动)

| # | 修订 | 来源 |
|---|---|---|
| R1 | **平台修复**:host.mjs doReload 对被卸载插件调用 `unregisterPluginTools(name)`(原零调用→停用后工具残留可调用) | Architect#1 P0 |
| R2 | **插件路由鉴权**:`server/api/plugins/[name]/[...path].ts` 支持插件声明 `auth:'user'|'admin'|'agent-or-user'|'none'(默认,兼容存量)`;两个桥接插件声明 `auth:'user'` | Architect#2 P0 |
| R3 | **ctx.daq 增加查询直通**:`ctx.daq.query(queryTagged 直通)` + `ctx.daq.nodes()`(daq/plugin-bridge.ts,~10 行)——插件免 token 取数,消除 N+1 REST 与自环鉴权问题 | Critic-B1 方案B |
| R4 | diag_start **显式 `harness:"omp"`**(缺省落 claude 引擎,无 key 必挂;omp 实测 available 18.1.13);做成插件 kv 配置 `diag.harness` | Critic-B2 |
| R5 | upload 契约钉死:multipart 字段名 **`files`**,dataPath 用返回的相对路径 `data/<folder>/<file>`(绝对路径 403) | Critic-B5 |
| R6 | CSV 契约钉死:bucketMs 必填(默认 5000)、limit 恒 10000 且断言无截断、列序 `timestamp,<nodeId...>`、pivot 按 ts 对齐、timestamp=本地 ISO(AW 全库本地时区宪法) | Critic-B6/Arch#6 |
| R7 | KB 归属:插件 ensureKB(无则经 web:6789 建 `aw-industrial` 库)+ experience init;**所有 rag 响应必须断言 body.success**(200 也可能 success:false) | Critic-B3 |
| R8 | 双引擎验收改写:mock 不执行工具→演示走 **agent-token `POST /api/workshop/agent-tools/invoke`** 直调(真实插件工具链)+ 跨通道消息断言;omp 引擎跑一次真实诊断 | Architect#3/Critic-B4 |
| R9 | run 映射持久化(ctx.kv `run:<id>`)+ 轮询器重水化(setup 时从 kv+3210 /api/diagnosis/list 重建);热重载安全 | Architect#8/Critic-N1 |
| R10 | 自动诊断护栏(P2-lite):每产线并发≤1、同因冷却 30min、默认关闭(kv 开关);429/超时退避重试≤2;检索类超时 30s | Architect#5/#7 |
| R11 | 双写去重:诊断报告入库由 diag-bridge 独占(tags source=diag-bridge);agent `kb_store` 只存人工结论 | Architect#11 |
| R12 | 风险增补:3021 重启 taskkill 整树(先停后起)、plugins-state.json 在用户家目录(fs.watch 400ms 防抖热重载,可免重启装载新插件,但核心改动仍需重启)、DAQ 空窗(line_id null→按 nodeIds 重查) | Critic-N4 |

## 0. 现状快照(2026-09-07 实测)

| 系统 | 端口 | 状态 |
|---|---|---|
| AgentWorkShop dev | **3021** | 运行中(PID 15124;单实例锁 `<repo>/.AgentWorkShop/.runtime/aw.lock` 当前无——重启用 taskkill /T /F 后 `node bin/aw.mjs dev --port 3021`) |
| rag-knowledge backend | **8770** | healthy(8765 被无关 python http.server 永久占用) |
| rag-knowledge web | 6789 | 运行中(config.yml 仍指 8765→本次对齐 8770 并重启) |
| Neo4j | 7474/7687 | 共享,graph available=true |
| diag backend / frontend / RAG | 3210 / 5180 / 8764 | 全部 healthy;**缺 `.env`(无 ANTHROPIC key)→ 走 omp 引擎** |

## 1. 实施清单(执行序)

### A. AgentWorkShop 核心小修(本次发布的一部分)
1. `server/services/workshop/agents/plugin-tools.ts`:已有 `unregisterPluginTools`;在 `server/services/workshop/plugins/host.mjs` doReload 卸载路径调用之(R1)。
2. `server/api/plugins/[name]/[...path].ts`:读插件模块 `auth` 声明,`resolveUser`/`requireAdmin`/`resolveAgentOrUser` 校验,失败回统一 401 信封;缺省 `none` 兼容存量插件(R2)。
3. `server/services/workshop/daq/plugin-bridge.ts` + `host.mjs`:`ctx.daq.query(TsdbTagQuery)`(直通 `getTsdb().queryTagged`)+ `ctx.daq.nodes()`(daq-node.repo)(R3)。
4. 完成后**全量重启 3021**(核心改动必须重启,非热重载)。

### B. 两个桥接插件(并行开发,单文件自包含 `.AgentWorkShop/plugins/<name>/index.mjs`,零导入)
**rag-bridge**(auth:'user';kv: `kb.base_url`=http://127.0.0.1:8770、`kb.web_url`=http://127.0.0.1:6789、`kb.id`、`kb.token` 可选):
- ensureKB:GET :6789/api/kb/catalog 无 `aw-industrial` 则 POST /api/kb/create;POST /api/v1/experience/{id}/init
- 工具 `kb_search`(query, kb_id?, top_k→stage2_top_k)→ two-stage;`kb_store`(title, category, problem, solution, key_lessons?, tags?, severity?)→ experience/{kb};`kb_index`(title, content, tags?)→ web create(写盘)+ backend index-document(content 直传,断言 body.success)
- 路由:GET /health、/search、/experience;所有 rag 调用 30s 超时、429/网络错误退避重试≤2

**diag-bridge**(auth:'user';kv: `diag.base_url`=http://127.0.0.1:3210、`diag.harness`=omp、`diag.max_minutes`=40、`auto_diag_enabled`=false):
- `ctx.daq.nodes()` 选产线节点 → `ctx.daq.query({nodeIds,fromMs,toMs,bucketMs:5000,limit:10000})` → pivot 宽表 CSV(行断言:样本总数<limit,否则报错建议缩窗)→ native fetch+AbortController multipart `files` 上传 → 用返回相对路径 `POST /api/diagnosis/start {dataPath, sceneName, userQuestion, harness:"omp", enhancement:"off", maxTurns:150, timeoutMinutes:40}` → `POST /api/diagnosis/execute/:runId` → 即返 runId
- kv `run:<runId>`={line,window,question,status,source};轮询器 15s(setup 重水化 kv pending);completed→拉 report(`GET /api/files/workspace/report/<runName>`)→ 调 KB(同 rag-bridge 契约,独立最小客户端)create+index+experience(tags: [line,scene,诊断,source:diag-bridge])
- 工具 `diag_run`(line, from_ms, to_ms, question?, scene?)异步即返;`diag_status`(runId?)→ 状态+score+verdict+报告摘要
- 路由:GET /health、/runs、POST /snapshot
- 护栏:每产线并发≤1、kv 冷却 30min、hooks.on('daq:sample') 自动触发仅在 `auto_diag_enabled`=true 时生效

### C. rag-knowledge(一次配置提交,零代码)
- `config.yml` server.dev.backend_port 8765→8770;`.env` BACKEND_PORT=8770;重启 web:6789;新增 `docs/agentworkshop-integration.md`(契约引用)。

### D. industrial-deep-diagnostic(零代码)
- 新增 `docs/agentworkshop-integration.md`(被插件消费的端点契约+harness 说明);`.env` 不入库(密钥纪律)。

### E. e2e 与演示(`scripts/three-system-e2e.mjs`,token 惯例照 scripts/api-live-e2e.mjs:41-67 register→token)
- **Stage1 快链(<2min)**:四服务健康特征断言(3021 401信封/8770 healthy JSON/3210 checks.activeRuns/8764 kb_ready)→ 插件路由 200(auth 生效:无 token 401)→ agent-tools/list 含 5 工具且无 url/base_url 参数 → snapshot CSV 结构断言(首列 timestamp、列数=节点数+1、行数=唯一 ts 数)→ kb_index+kb_search 命中、kb_store+global-search 命中(断言 body.success)
- **Stage2 双团队演示(零 LLM,确定性)**:建 Channel A「产线数据分析组」(lead=mock)与 B「闭环控制组」(lead=mock);A lead token invoke diag_run→diag_status→kb_search;`send_cross_channel_message`(A lead→B,require_reply)断言消息落 B(经 channels/:id/messages);B lead invoke `dcw_control`(mock 驱动节点,manual→HITL)→ 用户 token `POST /api/workshop/hitl/respond {confirmed:true}` → 断言写入 ACK+dcw:write 审计
- **Stage3 真实诊断(长,后台)**:真实 omp 诊断跑通→KB 自动入库→kb_search 命中报告独特句
- 团队绑定前置:B lead 需 dcw 节点绑定——经现有绑定 REST;若无 REST 则 e2e 内直接调 node-bindings repo 的 HTTP 出口(实现时核实,必要时补一个 PUT /api/workshop/agents/:id/bindings 管理端点)

### F. 回归 + 交付
- `node scripts/api-live-e2e.mjs` 回归;插件目录新文件不影响既有测试
- 三库提交推送(pathspec 限定);AWS 版本 0.7.24→0.7.25 + changelog + `npm pack`(发布物 agentworkshop-0.7.25.tgz)

## 2. 验收标准(全部可机器判定)
1. 四服务健康特征断言通过(见 E-Stage1;身份用特征路径区分,3210 无 service 字段)
2. 插件路由无 token→401;带 register token→200
3. agent-tools/list 含 diag_run/diag_status/kb_search/kb_store/kb_index,且 parameters 无 url/base_url/host 键
4. CSV:首列 timestamp、列数=节点数+1、数据行数=唯一时间戳数、无空行;样本总数<10000
5. invoke diag_run 返回 runId;diag_status 终态 completed 且 score/verdict 存在;KB two-stage 用报告独特句检索命中该文档
6. 跨通道:A→B 消息落库,B 的 in_reply_to 回执落 A
7. dcw_control(manual)→ HITL pending→respond confirmed→写入成功(mock 驱动 ACK)+ops 审计含 Agent 归因
8. 停用 diag-bridge(state 文件或 admin API)后:/api/plugins/diag-bridge/**→404 且 agent-tools/list 无 diag_*(R1 生效);恢复 enable 后 ≤10s 回归
9. api-live-e2e 回归全绿

## 3. 风险与缓解(增补后)
| 风险 | 缓解 |
|---|---|
| 3021 重启杀整树(omp 子进程/MCP 桥) | 先 taskkill 后台起,重启窗口 <1min;诊断 run 状态在 3210 侧持久,轮询器重水化 |
| 无 Anthropic key | 全链 harness=omp;E0-E8 零 LLM 兜底 |
| KB 限流 600/min 共享桶 | 插件串行入库+429 退避 |
| DAQ 空窗(line_id null) | 按 nodeIds 重查;空 CSV 显式报错 |
| mock 引擎无工具能力 | 演示经 invoke 直调(真实工具链),mock 仅作团队载体 |
| 双写重复 | source=diag-bridge 独占自动入库 |

## 4. 时间戳规范
CSV `timestamp` 列=本地 ISO(AW 宪法);kv/文件名带偏移本地 ISO;epoch ms 仅在工具参数(from_ms/to_ms)与 tsdb 内部使用。
