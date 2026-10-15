# 数据分析台账（analysis_reports）

Agent 在频道里得出的分析结论,可以作为**一等记录**持久化到平台:专用 `analysis_reports` 表,按「产线 × 配方 × 时间窗」组织,带关键结论、指标、数据来源与操作者归因。前端 `/analysis` 页面提供多维检索与实时刷新;外部分析服务(IDD)经 `diag_run` 以**后台任务**接入,产出统一落同一本台账。

## Agent 原生工具

| 工具 | 作用 | 关键参数 |
|---|---|---|
| `analysis_save` | 保存分析结论(留痕) | `title`/`summary` 必填;`conclusions`(数组)、`report`(完整正文)、`metrics`(对象)、`recipe_id`、`window_from/to`、`data_sources`;产线解析=显式 `line_id` → 频道绑线兜底 |
| `analysis_query` | 检索台账 | `report_id` 精确取全文;否则按 `line_id`/`recipe_id`/`category`/`q`/`from/to` 列表 |

写入门控与产线数据读取一致:**能读到哪条产线,才能给哪条产线留痕**。台账对 Agent **只增不改**(append-only);每笔写入经 `recordOps` 审计(`analysis.save`),前端经 WS 实时前插。

## 人类侧(/analysis 页面)

- **多维检索**:产线下拉 / 分类 / 时间预设(1h·24h·7d·30d)/ 关键词(标题+摘要+结论)。
- **行展开**:完整报告正文 + metrics + 数据来源 + 归因(操作者/频道)。
- **修订**:有 `operate` 产线授权的用户可编辑(`PATCH`),编辑者归因(`updated_by*`)随行刷新;Agent 侧永远看到的是最新版。
- **删除**:仅 admin(清污数据),同样入审计。

## 权限隔离(与全站一致)

台账按**产线级授权**过滤(`visibleLineIds`):无授权的用户,列表为空、详情 403/404、HITL 快照与运维审计同样不可见——数据不离开服务端。只读(`readonly`)授权可查不可改;`operate` 授权可修订。参见[产线级权限](/guide/line-permissions)。

## IDD 外部分析集成(diag-bridge)

`diag_run` 发起后台分析任务,**提交即返 `task_id`**,Channel 无需等待:

```
diag_run({ line, analysis_intent: "stability-report", question: "…运行稳定性报告…" })
→ { task_id }
diag_status({ run_id: task_id })   // 按 taskId 查进度/取结果
→ 状态 running(含阶段)→ completed + 报告文件路径
```

`analysis_intent` 决定 IDD 侧执行的 skill 协议(全意图目录,IDD harness 执行,与平台解耦):

| 意图 | 用途 |
|---|---|
| `deep-diagnosis`(缺省) | 九阶段深度根因诊断(最重) |
| `stability-report` | 产线稳定报告:评分+等级+运行建议(零根因) |
| `quick-screen` | 快速筛查:越限/漂移/冻结异常清单+HTML 看板(最快) |
| `doe-analysis` | DOE 试验分析:因子效应/显著性/最优工况 |
| `experience-mining` | 调参经验挖掘:结构化经验条目,供知识库沉淀 |
| `optimizer-campaign` | 优化战役:寻优迭代+推荐工况(最重) |

每种意图有按情景生成的缺省分析问题(业务语义由桥注入,IDD harness 执行);任务完成后平台把结果**自动回执**到发起频道(含评分/结论/总结/报告绝对路径),Agent 用 `analysis_save` 把结论(附 `run_id` 溯源)落账。

RAG 侧对称:`kb_agent` 支持异步任务——`mode:"async"` 立即返回 `task_id`,知识库后台完成入库/经验沉淀,`kb_agent_status` 按 taskId 查询;检索问答用 `mode:"sync"` 立即返回带引用的答案。

## 保留策略

`retention.analysis_days`(默认 365 天)控制台账保留期,纳入统一保留策略清理。
