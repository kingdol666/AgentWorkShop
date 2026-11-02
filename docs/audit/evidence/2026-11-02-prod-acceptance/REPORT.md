# 生产环境验收报告(aw-system-acceptance 五层 + 真实作业工单)

**时间**:2026-11-02 17:00~18:05 · 平台 v0.8.8(F-1/F-3 修复后重建产物)· 生产实例 3300 + 隔离实例 3001/3461/399x
**依据**:`.agents/skills/aw-system-acceptance`(T0-T4 五层)+ 真实产线工单

---

## 0. 结论

**功能面通过:T0/T1 全绿,T2 四个套件全绿(线治理 44/44、本体 57/57、本体真机 87/87、优化器 105/105),T3 三套全绿(api-live 71/71、MCP 34/34、Team 25/25),T4 插件 11/11、工具 126/126 可用。红线 2 项:模型闭环 51/53(既有 E-3 twin provider)、HITL TUI 26/28(T6/T9 文案/时序)。**
**真实作业工单:执行链 PROVEN——用户工单→lead 派工→工艺工程师 recipe_trial→HITL 批准(ap-021c23a2)→Agent 写入 64.8 bar(journal anc-7613cb3c)→克重 32.22~32.29 g 在窗;**但**平台在 17:51 健康探针判僵死后自动重启子进程(OPC UA 会话失效 + MQTT keepalive),重启后工单任务 14564617 仍 SUBMITTED、群聊终报未送达 → 新增 R-4。**
**判定:受控试点 GO;无人值守 NO-GO(E-1 负载稳定性 + R-4 重启后在途工单收口)。**

---

## 1. T0 静态门禁 ✅

| 项 | 结果 |
| --- | --- |
| `npm run lint` | EXIT 0(全仓 0 error) |
| `npm run typecheck` | 通过 |
| `npm run docs:check` | 89 通过 / 0 失败 |
| `npm run i18n:check` | EXIT 0 |
| `npm run readme:lint` | EXIT 0 |

## 2. T1 单元与契约 ✅

| 套件 | 结果 |
| --- | --- |
| `test:unit` | **922 项 / 920 pass / 0 fail / 2 skipped**(含 F-3 新增 2) |
| `test:mcp` | 14/14 |
| `test:plugin-lifecycle` | PASS(服务端/客户端通配约定) |
| `test:sdk-surface` | PASS(exports 全对齐) |
| `test:twin-provider` | 5/5 |
| `test:skills` | 147 PASS / 0 FAIL(7 skills) |

## 3. T2 实机核心闭环

| 套件 | 结果 | 说明 |
| --- | --- | --- |
| 产线治理 `test:e2e-line` | **44/44** | 开停线 HITL/审批期 TOCTOU/换线清理/Agent token 自证/写限界/60s 频控/量程拒绝 |
| 本体离线 `e2e-ontology` | **57/57** | 草稿→校验→编译→批准→发布→守卫→diff→退役 |
| 本体真机 `e2e-ontology-live` | **87/87** | L1-L7 + AML 先验/求解器 + 前端六 tab |
| 模型闭环 `e2e-model-loop-live` | **51/53** | **2 红 = 既有 E-3**:`TWIN_PROVIDER_UNAVAILABLE:injection-greybox-v1`(M2.11/M2.12),非本轮回归 |
| 优化器 `e2e-optimizer-live` | **105/105** | REST/负例/Agent 工具面/浏览器五 tab |
| 注塑闭环 `test:e2e-injection` | 未执行 | 脚本前置要求频道内 worker 名含「工艺优化」(现行模板为「工艺工程师」)→ 由本轮真实工单覆盖同一语义 |
| IDD 结果库 | 未执行 | 脚本前置写死 `D:/tmp/aw-demo-token.txt` + 频道「注塑产线作业-demo」;本轮未提供 |

## 4. T3 回归面

| 套件 | 结果 | 说明 |
| --- | --- | --- |
| `test:api-live` | **71/71 ALL PASS** | 对 3300 生产实例,专用受限用户 token(注册关闸 → 管理员建号) |
| `aw-mcp-live-e2e` | **34/34** | 完全隔离实例 3461 |
| `e2e-agent-team` | **25/25** | 隔离实例 3001;lead 分发子任务且 worker 完成 |
| `e2e-hitl-live` | **26/28** | W1-W8 全绿(挂起/批准/WS/UI/回传);T6/T9 TUI 文案/回合时序 2 红(服务端已 resolved、答案已入服务端) |

## 5. T4 插件与工具注册面 ✅

- 插件:**11/11 enabled,error 全空**(aw-matrix-plugin、daq-sink-verify、daq-vector-demo、idd-closedloop-bridge、omp-sensor-tools、twin-castfilm、twin-thermal-demo、diag-bridge、rag-bridge、serial-bridge、twin-injection-default);
- 工具注册表:**126 = builtin 105 + plugin 21,unavailable 0**;
- 抽真调用:`diag_status` 返回最近 5 条诊断;`list_channel_tasks` 回包正常;错误工具名返回结构化 `isError`。

## 6. 真实作业工单(生产场景)

**工单**:17:05 用户群聊 @生产主管「保压 63→64.8 bar(≤1.8 bar/步)小步确认,走 HITL,复测克重/飞边/缩痕,劣化回退」。

| 时点 | 事件 | 证据 |
| --- | --- | --- |
| 17:05 | 用户工单投递,lead 消费 | mailbox state=consuming |
| 17:25 | lead 用 `dispatch_task` 派给工艺工程师(此前两次误用 `submit_task` 被管理面拒绝,操作员提示后纠正) | 消息 b09cd42d |
| 17:38 | HITL 试验卡 `ap-021c23a2` 挂起:63→64.8 bar,假设=用户授权 +1.8 bar | /hitl/pending |
| 17:41 | **用户批准**(confirmed,comment 留痕) | approve-trial.json |
| 17:41 | Agent 写穿:OPC UA 回读 **64.8**,journal `anc-7613cb3c`(prev 63→64.8, actor=工艺工程师, approvalId=ap-021c23a2, recipeRun=rr-e36ca868) | journal |
| 17:43 | 复测:克重 **32.22 g**(在窗 [32.15,32.85]),保压寄存器 64.8 | daq query / OPC read |
| 17:51 | **平台健康探针连续 3 次失联 → 判僵死 → 子进程 #2 exit 1 → 自动重启 #3**;伴随 OPC UA `BadSessionIdInvalid` 重连、MQTT Keepalive timeout | aw-3300-1102b.log |
| 17:52 | 恢复:line-run 从 `line-runs.json` 恢复(rr-c14ddb76),采样续跑(17:52:40 克重 32.29 g),OPC 仍 64.8 | 日志/查询 |
| 17:56 | 操作员催收(群聊「请收口任务 14564617」)→ lead 转 busy,但至 18:05 任务仍 SUBMITTED、终报未发 | chat=5 / tasks |
| 18:05 | 任务 14564617 仍 **SUBMITTED**;lead idle→催收后 busy、信箱 q=1;群聊终报未送达 | tasks/queue |

**执行链结论:PROVEN;收口链:未完成(R-4)。**

## 7. 发现与定级

| # | 发现 | 定级 | 处置建议 |
| --- | --- | --- | --- |
| E-1 | 负载下健康探针 3 连失联→子进程退出→自动重启;重启前 OPC UA 会话失效、MQTT keepalive 超时 | **P1(稳定性)** | 资源独占 + OPC UA 会话重连不阻塞事件循环;健康探针阈值/退避复核 |
| R-4 | 重启后 D1 兜底已重投 assign,但 lead 保持 idle、信箱 q=1,任务 14564617 未收口、群聊终报未送达 | **P1(恢复)** | 复现 consumeLoop 在 SERVER_RESTART 后的唤醒丢失;修复后回归 |
| E-3 | `TWIN_PROVIDER_UNAVAILABLE:injection-greybox-v1` 导致模型闭环 M2.11/M2.12 红 | P2(既有) | 隔离实例注册 twin provider(与 10-24 立案一致) |
| T-1 | HITL TUI T6/T9 文案/回合时序断言红(服务端 resolved、答案已入服务端) | P2(TUI) | TUI 回执文案与 agent 回传时序对齐 |
| T-2 | lead 工具面暴露 `submit_task`(管理面,调用必拒)而正确工具是 `dispatch_task`;模型连续误用并长时间空转 | P2(可用性) | 面向 Agent 的工具面隐藏/改名管理工具,或在描述中强制指路 |
| T-3 | 性能:omp 回合 10~20 分钟;重启前事件循环被 OPC UA 重连拖慢 | P2 | 资源独占复验;OPC UA 客户端异步化 |

## 8. 判定

- **功能需求满足度**:数采获取、数控下发(含 OPC UA)、产线管理、Agent 集成、HITL、异步/插件/工具面**全部有真机证据**;自动化矩阵除 2 个已知/外围红项外全绿。
- **生产可用性**:受控试点 GO;**无人值守 NO-GO**(E-1 负载稳定性、R-4 重启后在途工单收口)。
- 本轮未执行套件(注塑 legacy 脚本、IDD 结果库)已在 §3 如实标注,不计入绿项。

*证据目录:`docs/audit/evidence/2026-11-02-prod-acceptance/`(T0-T4 日志、插件/工具 JSON、HITL 批准回执、journal、工单聊天与任务状态)。*
