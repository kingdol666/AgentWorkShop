# IDD / RAG 插件契约与运维说明(v2.4 / v2.3)

> 适用:`server/plugins-builtin/diag-bridge`(v2.4)与 `server/plugins-builtin/rag-bridge`(v2.3)。
> 上游契约:IDD `docs/api-external-plugin-manual.md` v1.3;RAG `docs/api-web.md` v2.0。
> 本文只描述**平台侧插件**的工具面、错误语义与降级行为;后端功能不在本文范围。

## 1. 工具清单

### rag-bridge(v2.3,文档面确定性工具)

| 工具 | 角色 | riskClass | 用途 | 关键参数 | 首行输出 |
| --- | --- | --- | --- | --- | --- |
| `kb_agent` | lead+worker | write | 知识库原生 Agent 对话(检索/入库/经验);写走 HITL | `prompt` `action=query\|ingest` `wait/wait_seconds` | 完成文本(✅) |
| `kb_agent_status` | lead+worker | read | 异步任务查询/长轮询 | `task_id` `wait_seconds` | 结果文本 |
| `kb_doc_create` | lead+worker | write | Markdown 直入文档库并建索引(同名幂等) | `name` `content` `description?` `kb?` `tags?` | `status=created doc_path=… index=ok tags=ok` |
| `kb_doc_search` | lead+worker | read | 两段检索为主,关键词兜底 | `query` `kb?` `top_k?` | `status=ok mode=two-stage hits=N` |
| `kb_doc_read` | lead+worker | read | 读文档正文(截断) | `doc_path` `kb?` `max_chars?` | `status=ok doc_path=… truncated=no` |
| `kb_catalog` | lead+worker | read | 库清单与文档数 | — | `status=ok kbs=N` |

缺省文档库 = `plugins.rag-bridge.docs_kb`(默认 `aw-docs`);经验面(`kb_agent`)仍写 `aw-industrial`。
`kb_doc_create` 显式指定 `aw-industrial` 时输出**漂移警告**,不硬拦。

### diag-bridge(v2.4,external v1 主契约)

| 工具 | 角色 | riskClass | 用途 | 关键参数 | 首行输出 |
| --- | --- | --- | --- | --- | --- |
| `diag_run` | lead+worker | read | 发起任意意图分析(提交即返 task_id) | `line/export_id/data_path` `analysis_intent` `wait?` `ontology_*` `preprocessing_mode` `report_language` | `已发起…contract=v1` |
| `diag_status` | lead+worker | read | 状态/结果(含报告路径与 URL) | `run_id?` | `run_id=… contract=… 状态=…` |
| `diag_chat` | lead+worker | read | 已完成/运行中 run 续聊(v1) | `run_id` `message` | `status=ok delivered=… resumed=…` |
| `diag_stop` | lead+worker | write | 停止 run(写审计) | `run_id` | `status=stopped run_id=…` |
| `diag_deposit` | lead+worker | write | 报告一键入 `aw-docs` + 检索自查 | `run_id` `kb?` `title?` | `status=ok doc_path=… search=hit` |
| `diag_results` / `diag_result_get` / `diag_result_annotate` | 结果库(默认关;worker 可读默认关/编辑仅 lead) | 见旧版文档 | 历史结果检索/详情/元数据 | — | — |

全部 7 意图:`deep-diagnosis` / `stability-report` / `quick-screen` / `doe-analysis` /
`experience-mining` / `optimizer-campaign` / `improvement-advisory`。

## 2. 契约与回退

- `plugins.diag-bridge.contract = auto|v1|legacy`(默认 auto)。
- auto:**提交前** `GET /api/external/v1/capabilities` 定轨并缓存 5min(base+token 指纹)。
  - 200 且 v1 信封 → v1;
  - 404/不可达/200 非 v1 信封(代理兜底)→ legacy;
  - 401/403/5xx → **不静默回退**,返回可读 token/服务错误(避免掩盖故障)。
- run 级 `contract + task_id + run_id` 落 kv;提交、轮询、状态、回执、`/report` 全链同契约。
- 显式 `legacy` 仅作回归保障;新功能(`diag_chat`、`diag_deposit`)要求 v1。

## 3. 生命周期与单飞锁

- 终态:`completed` / `failed` / `stopped` / `interrupted` / `expired`。
- `awaiting_input` **不是**终态:占产线单飞锁、不发终态回执;超过
  `plugins.diag-bridge.awaiting_max_minutes`(默认 30)转 `expired` 并发送提示性回执。
- v1 `404` 连续 3 轮 → `expired`;legacy 仍收敛 `failed`。
- 同一产线同时只允许一个未终态 run(`queued/running/awaiting_input` 均占锁)。

## 4. 错误语义(可读优先)

- IDD v1 错误码映射:手册 §9 全表(鉴权/意图/引擎/数据路径/意图-引擎不匹配/续聊状态/停止终态)。
- `diag_run` 提交前 capabilities 软预检:未知意图、引擎无 `runs` 能力、意图不受支持 → 不提交,直接给处方。
- RAG:401/403(重铸 token 路径)、429(退避 30s 一次后给指引)、404(库/文档名)、5xx/timeout(改 async 或 `kb_doc_search`)。

## 5. 降级

- 知识库 Agent 回合不可用(600s 硬顶/502/503)→ `kb_agent` 报错并建议 `kb_doc_search`(两段检索不依赖内部 agent)。
- 两段检索失败 → `kb_doc_search` 关键词兜底,输出 `mode=keyword-degraded`(仅名称/描述,必须 `kb_doc_read` 核实)。
- `diag_deposit` 检索自查未命中(索引可见性窗口)→ `search=miss`,文档已落盘,稍后 `kb_doc_search` 复核。

## 6. 可观测

- `GET /api/plugins/rag-bridge/health`:双库 id、token verify 三态、`toolCounters`(每工具 ok/err)。
- `GET /api/plugins/diag-bridge/health`:contract、token 实测、runs byStatus、`toolCounters`。
- `GET /api/workshop/channels/:id/tool-usage`:Agent 实际调用的工具计数(harness|tool|agent 分账)。
- 写类审计:`plugin.kb_doc.create`、`diag.report.deposit`、`diag.run.stop` 入平台 ops 面。

## 7. 灰度与关停

1. 批一(读类):`kb_doc_search` / `kb_doc_read` / `kb_catalog` / `diag_chat` 先行。
2. 批二(写类):`kb_doc_create` / `diag_deposit` / `diag_stop` 在批一验收通过后启用。
3. 一键关停:`plugins.*-bridge.enabled=false`(或插件管理页停用)→ 工具调用返回可读“未注册”,不崩溃。
4. 契约开关:`contract=legacy` 可即时回到旧路径(无需重启)。

## 8. 安全边界

- 出站地址限 `http(s)://127.0.0.1|localhost`(两插件共用守卫);token 只存系统配置,不入源码。
- `diag_run`/`diag_chat`/`diag_stop`/`diag_deposit` 均校验产线可读面(fail-closed)。
- `diag_deposit`/`diag_stop`/`kb_doc_create` 属写族:策略或目录不可读时 fail-closed
  (`isPolicyWriteTool` 联合判定:静态名单 ∪ 插件 `riskClass='write'`)。
- 结果库默认关闭;`diag_results` 默认仅 lead,worker 需显式开关。
