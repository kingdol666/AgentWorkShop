# IDD 分析结果管理集成计划(diag-bridge · Results Library)

状态:**已执行并复验**(2026-10-25;独立 reviewer REVISE 后修复,真机 36/36 + UI 9/9 + 结构 14/14)
日期:2026-10-25 · 依据:IDD `docs/api-external.md` §16(v1 结果库 + §16.3a 分类)、IDD 自带 `results-aws-integration` 验收脚本(87/87)、AW diag-bridge 现状核查

## 1. 需求与现状

**需求**:让 AgentWorkShop 的 Agent 与操作员都能管理 IDD 的分析结果——列出/检索全部结果、按 `result_id` 取完整详情、按 `result_id` 编辑描述与标签。

**现状(已核查)**:

| 面 | 现状 | 锚点 |
|---|---|---|
| AW 插件工具 | 仅 `diag_run` / `diag_status` 两个;结果只见**本平台发起**的 run(KV 存) | `.AgentWorkShop/plugins/diag-bridge/host/plugin.mjs:97,247` |
| AW 插件路由 | `/health` `/runs` `/snapshot` `/report`;无结果库代理 | 同文件 `:341,403,410,428` |
| AW UI | 单面板 diag-runs(本平台 run 列表) | `.AgentWorkShop/plugins/diag-bridge/client.mjs:41` |
| IDD 结果库 API | **已就绪**:索引(过滤/brief)、详情(include_md)、PATCH(描述/标签/标题/分类)、分类 CRUD | IDD `docs/api-external.md` §16.1–16.5 |
| 鉴权 | `idd_` API Token 全链可用;PATCH 属主校验(非属主 403) | 同上 §1 / §16.4;AW 侧已修 external 路由 userId 归属 |

**缺口**:AW 侧完全没有结果库调用面——Agent 无法回答「上次厚度波动的诊断结论是什么」,UI 也看不到历史分析。

## 2. API 映射(新增面)

| AW 面 | 类型 | IDD 端点 | 说明 |
|---|---|---|---|
| 工具 `diag_results` | 读 | `GET /api/external/v1/results` | 索引检索;`brief` 默认 **true**(省 token);`limit` ≤200 |
| 工具 `diag_result_get` | 读 | `GET /results/:resultId` | `include_md` 默认 false;`md_max_chars` 截断保护 |
| 工具 `diag_result_annotate` | 写(元数据) | `PATCH /results/:resultId` | 仅 `description/tags/title`;受双重开关 |
| 路由 `GET /api/plugins/diag-bridge/results` | 读 | 透传 `GET /results` | UI 列表/搜索 |
| 路由 `GET /api/plugins/diag-bridge/results/:id` | 读 | 透传 `GET /results/:id` | UI 详情 |
| 路由 `PATCH /api/plugins/diag-bridge/results/:id` | 写 | 透传 `PATCH /results/:id` | UI 编辑;admin/lead + 开关 |
| 路由 `GET /api/plugins/diag-bridge/results/categories` | 读 | `GET /results/categories` | P2:过滤下拉 |

参数透传清单(索引):`q / intent / category_id / tag / scene / harness / min_score / sort / limit / offset / brief`。
详情:`include_md`。编辑:`description(≤2000) / tags(≤16×≤40) / title(≤200) / category_id`。

## 3. 关键设计决策

- **D1 默认关闭**:新增设置组 `results`,开关 `results_enabled=false`。理由:IDD token 是**平台级**单 token,结果不分产线;开启即等于让所有频道共享同一可见面。默认关闭 + 显式开启,避免隐性跨线暴露。
- **D2 角色收敛**:`diag_results` / `diag_result_get` 默认 `roles:['lead']`;设置 `results_allow_worker=false` 时可放开给 worker。
- **D3 写面双闸门**:`diag_result_annotate` 需 `results_allow_annotate=true` **且** 调用者为 lead;IDD 侧属主校验是最终裁决,403/404 原样回执。只改元数据(描述/标签),不触产线、不绕过 HITL 的工业写面。
- **D4 上下文保护**:`results_md_max_chars`(默认 4000)截断 report.md,并始终返回 `report_md_url`;`include_md=false` 时只回 URL。索引默认 `brief=true`,单卡 ≤~600 字符。
- **D5 不落本地文件**:详情里的 `report_md_path` / `files.html[].abs_path` 是 **IDD 主机**路径,AW 可能跨机——只回传 `report_md_url` 与 `files.html[].url`,不读盘。
- **D6 版本探测**:调用前 `GET /results?limit=1&brief=true` 探测(缓存 5 分钟);404/400 → 回执「当前 IDD 版本不支持结果库(需含 §16 的版本)」,不抛栈、不冒充空结果。
- **D7 PATCH 实现**:SDK `ctx.http` 目前只有 `get/post`(`sdk/context.mjs:524-530`、`sdk/index.d.mts:41-44`)→ 为 `PluginHttp` 增加 `patch`(与 post 同构),插件不裸用 fetch。
- **D8 审计**:工具调用走 `ctx.log`;annotate 成功后在 kv 记 `results:lastWrite`(时间/result_id/字段名);结果归属与写审计由 IDD 侧承担。

## 4. 实施步骤

### P1 SDK:补齐 PATCH
- `sdk/context.mjs:524` 的 `http` 对象加 `patch: (url, body, opts) => fetch(url, { ...safeUrl(url, opts?.timeoutMs), method:'PATCH', headers:{'content-type':'application/json',...opts?.headers}, body: JSON.stringify(body) })`
- `sdk/index.d.mts:41-44` 的 `PluginHttp` 增 `patch` 签名
- 验收:`ctx.http.patch` 存在且与 post 同样受 http/https 白名单与超时保护

### P2 插件 helpers(结果库适配层)
`host/helpers.mjs` 新增:
- `jpatch(ctx, url, body, timeoutMs=15000)`(与 `jpost:86` 同构)
- `resultsEnabledOf(ctx)` / `resultsAllowAnnotateOf(ctx)` / `resultsAllowWorkerOf(ctx)` / `resultsMdMaxOf(ctx)`(config → kv 兜底,同现有 `harnessOf` 模式)
- `probeResults(ctx)` → `{ ok, reason }`(D6 探测 + 5 分钟缓存)
- `mapResultsError(err)` → 中文可行动回执(见 §5)

### P3 插件设置与工具
`host/plugin.mjs`:
- `configGroups` 增 `{ id:'results', label:'分析结果库', order:450, collapsed:true }`(`:21-25`)
- `settings` 增(`:27-33` 同形):
  `results_enabled`(bool,false)、`results_allow_annotate`(bool,false)、`results_allow_worker`(bool,false)、`results_default_limit`(number,20,1-200)、`results_md_max_chars`(number,4000,500-50000)
- 工具 ×3(`ctx.omp.registerTool`,在 `diag_status:247` 之后):
  - `diag_results`:`{ q?, intent?, tag?, scene?, harness?, min_score?, sort?, limit?, offset?, brief? }` → 文本表(每行 `result_id | intent | score/verdict | created | title | tags`)+ `total/limit/offset` + 提示「按 id 用 diag_result_get」
  - `diag_result_get`:`{ result_id, include_md?, md_max_chars? }` → 摘要/关键数字/工件 url/文件清单/run 状态;md 可选截断
  - `diag_result_annotate`:`{ result_id, description?, tags?, title? }` → 回读校验后回执「已更新:description(…), tags(…);属主=… 」
- 三工具均先查 `resultsEnabledOf`;annotate 再查 `resultsAllowAnnotateOf`;`diag_results/get` 按 `resultsAllowWorkerOf` 决定 `roles`

### P4 插件路由与 UI
`host/plugin.mjs`(路由区 `:340-435`)新增:
- `GET /results`、`GET /results/:id`、`PATCH /results/:id`、`GET /results/categories`(P2 可选)
- 写路由要求 AW admin 或 lead agent(`ctx.services.get('agentScope')` 同 diag_run 用法),并复核 `results_allow_annotate`

`client.mjs` 新增第二个面板 `diag-results`(order 21):
- 工具条:`q` 搜索、intent 下拉、min_score、刷新
- 列表:result_id/title/intent/score/verdict/created/tags(点击行展开详情)
- 详情:summary、key_numbers、report_md(折叠)、HTML 链接(带 token 提示)
- 编辑:`description` 文本域 + `tags` 输入(仅 `results_allow_annotate` 时显示)
- 空态/错误态:未启用→配置指引;版本不支持→升级提示
- `i18n.json` 增 `panel.results.*` 键(中英)

### P5 测试与文档
- 结构单测 `tests/diag-bridge-results-surface.test.ts`:settings 键存在、3 工具注册、roles 默认、写开关默认 false、helpers 导出
- 真机 e2e `scripts/e2e-idd-results.mjs`(AW → 真实 IDD 3210):A1-A13
- UI 走查:面板截图(列表/详情/编辑回显)
- 文档:`docs/site/guide/plugins.md`(或 diag 集成页)+ en;README 能力行

## 5. 错误映射(IDD → 回执)

| IDD | AW 回执 |
|---|---|
| 401 `AUTH_REQUIRED` | 「IDD Token 无效/过期;系统设置→运行配置→插件 更新 idd_ API Token」 |
| 400 `RESULTS_QUERY_INVALID` | 「查询参数非法:{code};支持 intent=deep-diagnosis/…, sort=created_desc/created_asc/score_desc」 |
| 400 `RESULT_PATCH_INVALID` | 「编辑体不合法:{原因}(至少给 description/tags/title 之一)」 |
| 400 `SUMMARY_READONLY` | 「summary 系统生成不可改;请改 description」 |
| 403 `RESULT_FORBIDDEN` | 「该结果不属于当前 Token 的属主;换成创建它的账号或管理员」 |
| 404 `RESULT_NOT_FOUND` | 「result_id 不存在/已软删/分析未完成」 |
| 网络失败 | 「诊断服务不可达({base});检查 plugins.diag-bridge.base_url 与服务状态」 |
| 结果库不存在(404 路由) | 「当前 IDD 版本无 §16 结果库;升级 IDD 或关闭 results_enabled」 |

## 6. 验收矩阵

| ID | 载体 | 断言 |
|---|---|---|
| A1 | 结构单测 | `results_*` 五个设置键存在且默认值正确(全关/20/4000);3 工具已注册;读工具默认 lead-only |
| A2 | 真机 e2e | `results_enabled=false` → 三工具均回执「结果库未启用」且不发起 HTTP |
| A3 | 真机 e2e | 开启后 `diag_results` 返回 `total/limit/offset` 与卡片;`brief` 默认 true 时卡片**无** `key_numbers`;显式 `brief=false` 时有 |
| A4 | 真机 e2e | `q` / `intent` / `min_score` / `sort` 过滤生效(各自 total 单调收敛,不报错) |
| A5 | 真机 e2e | `diag_result_get` 默认无 md、有 `report_md_url`;`include_md=true` 有 md 且长度 ≤ `results_md_max_chars`,超出带截断标记 |
| A6 | 真机 e2e | `diag_result_annotate` 设 description+tags → 回读索引 `display_text` 以 description 优先、tags 一致;标题可改 |
| A7 | 真机 e2e | 负例逐条:404 不存在 id、400 非法 sort、400 改 summary、403 非属主(第二 token) |
| A8 | 真机 e2e | `results_allow_worker=false` 时 worker 调用被拒;`allow_annotate=false` 时 annotate 被拒且不发起 PATCH |
| A9 | 真机 e2e | 长报告截断:构造/挑选 md > 上限的结果,断言截断标记 + url 完整 |
| A10 | 真机 e2e | 指向不含 §16 的基址(或 mock 404)→ 明确版本提示,进程无栈 |
| A11 | UI 走查 | 结果面板列表非空;搜索收敛;点击出详情;编辑后回显(截图) |
| A12 | 真机 e2e | 经 `/api/workshop/agent-tools/invoke` 以 lead 调用三工具全部成功(isError≠true) |
| A13 | 回归 | 既有 `diag_run`/`diag_status`/`/runs`/`/health` 全部保持原行为(现有 diag e2e 重跑) |
| A14 | 全量 | 单测全绿 + lint(本次涉及文件) + typecheck + 文档一致性 |

自动化率:14/14(UI 走查含自动断言 + 截图)。

## 7. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 平台级 token 导致跨线数据可见 | D1 默认关 + D2 角色收敛 + 文档明示「结果库可见面 = Token 属主可见面」 |
| IDD 版本漂移(旧版本无 §16) | D6 能力探测 + 缓存 + 明确降级回执 |
| 大报告撑爆 Agent 上下文 | D4 默认 brief + md 截断 + 只给 URL |
| 元数据写被滥用 | D3 双开关 + lead-only + IDD 属主校验 + kv 留痕 |
| 跨机文件路径不可用 | D5 只回 API URL,不读 `abs_path` |
| 插件工具无 HITL | annotate 仅元数据、不触产线;默认关闭;写后回读校验 |

## 8. 不做(v1 边界)

- 结果删除 / 分类 CRUD(仅只读分类列表用于过滤)
- 报告文件下载落盘(跨机语义不清;保留 URL)
- 多 IDD 实例聚合查询
- 结果与 AW 产线的自动归属映射(IDD 结果无 line 字段;需 IDD 侧新增元数据后另立计划)

## 9. 执行记录(2026-10-25)

| 阶段 | 交付 | 验证 |
|---|---|---|
| P1 | `sdk/context.mjs` + `sdk/index.d.mts` 增 `ctx.http.patch` | 结构断言 A1.8 |
| P2 | `host/helpers.mjs`:jpatch / results_* 五设置读取 / probeResults(版本探测+5min 缓存) / mapResultsError | A1.7、A10.1(坏 base_url 降级) |
| P3 | `host/plugin.mjs`:results 设置组 + 5 键 + 三工具(`diag_results/diag_result_get/diag_result_annotate`) | A1.1-A1.5、A2-A9 真机 |
| P4 | 路由 ×4(`/results`、`/results/detail?id=`、`PATCH /results/edit?id=`、`/results/categories`)+ `client.mjs` 第二面板 + i18n 中英 | A12.1-A12.4 |
| P5 | `tests/diag-bridge-results-surface.test.ts`(10)+ `scripts/e2e-idd-results.mjs`(32)+ 文档 | 32/32、10/10 |

**关键实现修正(开工中发现)**:插件路由表是 exact-match,**不支持路径参数**——`/results/:id` 会 404,改为 query 传参(`?id=`),与既有 `/report?run_id=` 同模式。
**同步纪律**:builtin 插件装载源是 `server/plugins-builtin/diag-bridge/`,改动必须同时落 `.AgentWorkShop/plugins/diag-bridge/`(工作副本)与 builtin 源,否则重启不生效。

**验收结果**:A1 结构 10/10;A2-A13 真机 e2e 32/32(含关闭态短路、索引/过滤、详情/截断、编辑回读、404/403/400 负例、写闸门、坏 base 降级、面板路由、既有 diag 回归);全量单测 595/595;typecheck 通过;i18n PARITY;docs 91/91。

## 10. Reviewer 复验修复记录(2026-10-25 第二轮)

独立 reviewer 首轮判 **REVISE**(4 High / 5 Medium),逐条修复并复验:

| 问题 | 修复 | 复验证据 |
|---|---|---|
| H1 PATCH 路由缺 admin/lead 闸门 | 转发层注入 `event.awUser`;PATCH 路由要求 admin(Agent 面走 lead-only 工具) | A1.12 结构断言 + 面板编辑以 admin 通过 |
| H2 brief=false 缺 key_numbers | 卡片输出 `key_numbers` | A3.3 真机断言 |
| H3 探测缓存掩盖版本/连通性;网络错误无映射 | 缓存 key 加 base+token 指纹;`mapResultsError(err, base)` 增网络分支 | A1.13 + A10.1(回执含 base) |
| H4 A7/A11 证据不成立 | A7 拆 2a/2b/3a/3b/3(真 403:新建属主明确结果+第二 token);A11 新增 UI 走查脚本 | 主 e2e 36/36;UI 9/9 |
| M5 worker 开关不热生效 | roles 注册 lead+worker,handler 内实时判 `resultsAllowWorkerOf` | A1.3 |
| M6 少透传 category_id/harness | 补齐 11 项 | A1.11 + 真机 |
| M7 报告 URL 相对路径 404 | `absoluteUrl(base, path)` 绝对化(工具+路由) | A5.1 |
| M8 编辑区无条件显示/大 md 进浏览器 | 路由返回 `canAnnotate`,编辑区按能力显示;详情默认 `include_md=false` | A11.6 |
| M9 详情泄露 IDD 主机路径 | 路由裁剪 `workspace_path`/`report_md_path`/`abs_path` | A1.12 |
| Low CSS 回归/回读空值/注释/null 支持/双副本漂移 | 恢复 `:has` 规则;PATCH 后 GET 回读;注释修正;`description` 支持 null;A1.14 双副本一致断言 | 结构 14/14 |

**实施环境坑(记录)**:插件路由表 exact-match 不支持 path 参数;builtin 装载源是 `server/plugins-builtin`(工作副本 `.AgentWorkShop/plugins` 需同步);ESM 模块缓存导致插件改动必须**真正重启进程**;dev 实例的 SSE 断开会拖垮进程,UI 验收改用生产 `.output` 实例;`.output` 生产模式需 `NUXT_SESSION_PASSWORD`;残留 dev 实例会把共享 `tool_registry` 写成 unavailable(必须清理进程树)。
