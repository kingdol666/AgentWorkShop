# 双插件(rag-bridge + diag-bridge)频道协同全链实测(2026-09-30)

- 平台:AgentWorkShop 隔离实例 127.0.0.1:3990(`AW_MODE=home`)
- 外部系统:rag-knowledge(web 6789 + FastAPI 8771 + Neo4j + bge-m3 向量)真实运行;IDD 用 mock(3210,`/api/diagnosis/tasks` 最小任务面契约,报告本地落盘)——按需求「诊断可模拟,省 token」
- 频道:`chtpl-generic-optimize-default` 实例化,`enableKnowledgeBase=true`;工具验证全部走 invoke 直调(平台侧零 LLM token)

## ① 设计结论(代码审读)

**频道级插件开关**(`channel_plugins` 表,per-channel):
- 语义 = **显式覆盖行**:无行 = 默认全启用;`enabled=false` 行才是关闭;`enabled=true` 行为显式开启。工具桥按行过滤插件工具(host-tool-bridge/catalog.ts),切换后对在跑 agent 热刷新工具清单。
- `instantiate { enableKnowledgeBase }`:true → 写 rag:true 行 **并在场景提示词追加 KB 作业段**(教 kb-tuner 用 kb_agent);false → 写 rag:false 行(该频道 kb_* 工具被过滤);缺省 → 不写行。
- IDD 不受该 flag 影响:默认启用;要关须显式 PUT `/api/workshop/channels/:id/plugins` 写 `diag-bridge: false`。**双开 = 默认态或两行都 true。**

**RAG 调用知识库系统的对外 API**(rag-bridge → rag-knowledge):
| 用途 | 端点 |
|---|---|
| 目录/找库 | `GET {web}/api/kb/catalog` |
| 建库 | `POST {web}/api/kb/create`(幂等;库名固定 aw-industrial) |
| **原生 Agent 对话(唯一功能入口)** | `POST {web}/api/kb/agent/chat`(prompt + mode=sync/async) |
| 异步任务结果 | `GET {web}/api/kb/agent/tasks/:id` |
| 经验初始化/列表 | `POST/GET {base}/api/v1/experience/:kbId` |
| 运维检索(插件 API 透传) | `POST {base}/api/v1/search/two-stage` |
| 健康与 token 实测 | `GET {base}/api/v1/health`、`/api/v1/auth/me` |

**「原生 skill」判定:成立。** kb_agent 不在平台侧拼装检索/入库步骤——把任务原话交给 rag-knowledge 内部 Agent(claude/omp 引擎 + QDCVR skill + kb-mcp 工具面),入库走其 A0→A9 门控管线,检索走 QDCVR 全流程。本轮实测可观察到其内部工具调用痕迹:`kb_project_status`/`kb_find_duplicates`/`kb_search_vector`/`kb_doc_read`/`kb_doc_save_parsed`/`kb_index_document`。

**双插件集成机制**(都勾选时):
1. `diag_status` 完成态回包**内置协同契约原文**:报告 md 绝对路径 + 精确的 kb_agent 调用配方(mode=async + prompt 模板 + kb_agent_status 跟进查询);
2. 模板场景提示词的 KB 作业段把 kb-tuner 定为 kb_agent 主消费者,并含与 diag-bridge 的协同条目;
3. 自动诊断(daq:sample 越限规则触发,30 分钟冷却/线)产出同样走该契约。

## ② 全链实测结果(诊断 → 入库 → 检索)

| # | 断言 | 结果 |
|---|---|---|
| P1~P3 | 插件设置热生效;rag /health(backend healthy + token accepted + kb.id);diag /health(remote healthy) | ✅ |
| P5~P7 | 实例化写 rag:true 行(source=explicit);显式 PUT 双行 true;目录视图正确 | ✅ |
| P9 | 成员工具桥正常(line_context) | ✅ |
| **P10** | **kb_agent 打通原生 KB Agent**(sync 探针返回真实回复) | ✅ |
| **P11** | **频道隔离**:rag:false 行的频道调用 kb_agent → 「该团队未启用插件「rag-bridge」,kb_agent 不可用」 | ✅ |
| C1~C2 | 建线开跑;diag_run 导出真实 TSDB 快照 CSV 并提交异步任务(返 task_id) | ✅ |
| D1~D3 | diag_status:状态=completed、评分=86、结论=keep、报告绝对路径;**协同指令原文完整**(kb_agent 配方 + kb_agent_status 跟进) | ✅ |
| **D5** | **原生入库成功**:A0 三通道判重(最高相似 0.6625 < 0.85;正文回读确认非重复)→ `kb_doc_save_parsed` 落盘(savedCount=1)→ 返回 doc_path | ✅ |
| **D6** | **检索逐字命中本 run**:唯一标识 `UNIQ-mockdiag-001-mun0elya`、0.4Hz 窄带峰 4.7dB 原文引用 + doc_id | ✅ |
| **D7** | 插件 `/search` 两阶段检索命中该文档 | ✅ |

**结论:诊断数据入库并能检索到 —— 真实闭环成立**(本轮唯一内容进入 aw-industrial,doc_id `3e258a21-12b1-4e92-b1ea-d6be49307583`;原生 Agent 的去重门、MCP 探测、向量索引全部真实工作)。

## ③ 实测发现(有价值的行为,非缺陷)

1. **A0 等价文档门会拒绝「换 run-id 的同模板报告」**(第一轮 mock 报告骨架逐字相同 → 判 duplicate 跳过入库)——这正是原生管线纪律性的实证;mock 服务因此补了每轮唯一发现字段。
2. `diag_status` 指导 Agent「读文件入库」,而 KB 侧 Agent 的文件读取受其工作域约束时,**内联 markdown 正文入库**(kb_agent 参数文档的原始契约)是最稳路径——本轮即用内联口径成功。
3. AW 侧 token 配置一次打通:`plugins.rag-bridge.token` 接受即 `token.accepted=true`(/health 实测面);库不存在时 ensureKB 幂等自建。
