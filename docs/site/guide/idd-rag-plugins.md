---
title: IDD / RAG 插件集成
description: diag-bridge v2.4 与 rag-bridge v2.3 的工具面、external v1 契约定轨、生命周期、错误语义与降级
---

# IDD / RAG 插件集成

> 适用内置插件:`diag-bridge`(v2.4,IDD 工业深度诊断)与 `rag-bridge`(v2.3,rag-knowledge 知识库)。
> 上游契约:IDD `external/v1` 调用手册 v1.3;RAG `api-web` v2.0。本文只描述**平台侧插件**的工具面与运行语义,后端功能不在本文范围。

## 1. 工具清单

### rag-bridge(v2.3,文档面确定性工具)

| 工具 | 角色 | riskClass | 用途 | 关键参数 | 首行输出 |
| --- | --- | --- | --- | --- | --- |
| `kb_agent` | lead+worker | write | 知识库原生 Agent 对话(检索/入库/经验);写走 HITL | `prompt` `action=query\|ingest` `wait/wait_seconds` | 完成文本 |
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
| `diag_results` / `diag_result_get` / `diag_result_annotate` | 结果库(默认关) | 读/写 | 历史结果检索/详情/元数据 | 见工具描述 | — |

全部 7 意图:`deep-diagnosis` / `stability-report` / `quick-screen` / `doe-analysis` /
`experience-mining` / `optimizer-campaign` / `improvement-advisory`。

## 2. 契约与回退

- `plugins.diag-bridge.contract = auto|v1|legacy`(默认 `auto`)。
- auto:**提交前** `GET /api/external/v1/capabilities` 定轨并缓存 5 分钟(base+token 指纹)。
  - 200 且 v1 信封 → v1;
  - 404 / 不可达 / 200 非 v1 信封(代理兜底)→ legacy;
  - 401/403/5xx → **不静默回退**,返回可读 token/服务错误(避免掩盖故障)。
- run 级 `contract + task_id + run_id` 落 kv;提交、轮询、状态、回执、`/report` 全链同契约。
- 显式 `legacy` 仅作回归保障;新功能(`diag_chat`、`diag_deposit`)要求 v1。

## 3. 生命周期与单飞锁

- 终态:`completed` / `failed` / `stopped` / `interrupted` / `expired`。
- `awaiting_input` **不是**终态:占产线单飞锁、不发终态回执;超过
  `plugins.diag-bridge.awaiting_max_minutes`(默认 30)转 `expired` 并发送提示性回执。
- v1 `404` 连续 3 轮 → `expired`;legacy 仍收敛 `failed`。
- 同一产线同时只允许一个未终态 run(`queued/running/awaiting_input` 均占锁)。
- export 数据集未显式传 `line` 时按 `manifest.lines[0].lineId` 落锁;`lineScope` 区分授权作用域,
  纯离线数据集不因“offline-data 不在可读范围”被误拒。

## 4. 错误语义(可读优先)

- IDD v1 错误码映射:鉴权 / 意图 / 引擎 / 数据路径 / 意图-引擎不匹配 / 续聊状态 / 停止终态。
- `diag_run` 提交前 capabilities 软预检:未知意图、引擎无 `runs` 能力、意图不受支持 → 不提交,直接给处方。
- RAG:401/403(重铸 token 路径)、429(退避 30s 一次后给指引)、404(库/文档名)、5xx/timeout(改 async 或 `kb_doc_search`)。

## 5. 降级

- 知识库 Agent 回合不可用(600s 硬顶/502/503)→ `kb_agent` 报错并建议 `kb_doc_search`(两段检索不依赖内部 agent)。
- 两段检索失败 → `kb_doc_search` 关键词兜底,输出 `mode=keyword-degraded`(仅名称/描述,必须 `kb_doc_read` 核实)。
- `diag_deposit` 检索自查未命中(索引可见性窗口)→ `search=miss`,文档已落盘,稍后 `kb_doc_search` 复核。

## 6. 可观测

- `GET /api/plugins/rag-bridge/health`:双库 id、token verify 三态、`toolCounters`(每工具 ok/err)。
- `GET /api/plugins/diag-bridge/health`:contract、token 实测、runs byStatus、`toolCounters`。
- `GET /api/workshop/channels/:id/tool-usage`:Agent 实际调用的工具计数(需前端/ws 订阅者在线才会落 `agent.block`)。
- 写类审计:`plugin.kb_doc.create`、`diag.report.deposit`、`diag.run.stop` 入平台 ops 面。

## 7. 灰度与关停

1. 批一(读类):`kb_doc_search` / `kb_doc_read` / `kb_catalog` / `diag_chat` 先行。
2. 批二(写类):`kb_doc_create` / `diag_deposit` / `diag_stop` 在批一验收通过后启用。
3. 一键关停:插件管理页停用 → 工具调用返回可读“未注册”,不崩溃。
4. 契约开关:`contract=legacy` 可即时回到旧路径(无需重启)。

## 8. 安全边界

- 出站地址限 `http(s)://127.0.0.1|localhost`(两插件共用守卫);token 只存系统配置,不入源码。
- `diag_run`/`diag_chat`/`diag_stop`/`diag_deposit` 均校验产线可读面(fail-closed)。
- `diag_deposit`/`diag_stop`/`kb_doc_create` 属写族:策略或目录不可读时 fail-closed
  (`isPolicyWriteTool` 联合判定:静态名单 ∪ 插件 `riskClass='write'`)。
- 结果库默认关闭;`diag_results` 默认仅 lead,worker 需显式开关。

## 9. 验收摘要(2026-11-18)

全新 home / 产线 / 频道实测:供给 9/9、频道锻造 11/11、V1–V6 11/11;142 宿主工具(127 内置 + 15 插件,
schema 增量 ≈965 tokens);真实模型回合原生调用 `kb_doc_search → kb_doc_read → diag_run → diag_status`;
受治理闭环 SP 156→150→144→138 °C(每步 HITL、设备证实 1/1),PV 复测 3/3 落 [138,142](均值 139.68)。

如实边界:IDD quick-screen/stability 在 60min/2,312 行导出数据集上 40min 未落终态(外部技能/引擎);
`diag_deposit` 的入库→索引→检索链路以明确标注的 mock 报告证明;云端模型供应商当日不可用,真实回合使用本机模型;
Mimosa 深扫封印但 **inconclusive**,不宣称安全。完整证据见仓库
`docs/audit/evidence/2026-11-18-idd-rag-plugin-v1-contract/REPORT.md`。
