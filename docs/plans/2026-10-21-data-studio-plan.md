# 数据管理台 + EDA 可视化工坊 设计规划（Data Studio）

状态：**pending approval（待用户批准后实施）**
日期：2026-10-21
流程：多 Agent 发散→收敛（1×代码盘点 + 1×市面 EDA/BI 调研 → 2×独立评审：架构可行性 / 需求覆盖与 EDA 完整性，评审意见全部带仓库实证）

---

## 1. 现状结论（用户问：当前有没有这个功能？）

**部分底层能力已备，但业务与界面不存在。**

| 用户需求 | 现状 |
|---|---|
| 按产线/节点批量筛选查询 | ✗ 用户面无。底层 `queryTagged`（多节点+批次打标）完备但无 REST（`daq/storage/tsdb-port.ts`）；`samples.get.ts` 仅单节点 |
| 批量导出 | ✗ 用户面无。`exportDaqDataset` 核心完备（manifest/nodes/frames/merged.csv，护栏齐全）但只在 Agent 工具内部路径（`daq-export.ts:405`） |
| 专用数据管理导航与界面 | ✗ 无 /data 页面；现有 /daq 是监控控制台定位 |
| MES API req→res 调试 | ✗ 用户面无。mes-rest 驱动 + mes-test-read（驱动试读）+ mes_datasets 台账已备，缺 REST 暴露与 req/res 面板 |
| 拖拽 EDA 可视化搭建 | ✗ 无。AwChart 已封装 echarts(Line/Bar/Pie/Gauge) 可复用；无任何拖拽/网格依赖 |
| 按用户保存图表（表单模型） | ✗ 无 per-user 图表/看板表 |
| 自动数据处理 | ✗ 仅 Agent 侧有分析工具；无派生数据集管道 |

## 2. 需求覆盖矩阵（10 条 → 里程碑）

| # | 需求原话 | 里程碑 | 说明 |
|---|---|---|---|
| 1 | 按产线/节点批量筛选 | M1 | 多选树+时间窗+聚合粒度，服务端强制桶聚合 |
| 2 | 批量导出 | M1 | 复用 `exportDaqDataset` 核心+新建用户授权壳；CSV+列勾选（xlsx 二期） |
| 3 | 专用导航/界面 | M1 | AppSidebar 新增「数据管理」/data（i18n 双文件同步） |
| 4 | 选产线看镜像数据 | M1 | 标注保留期（tsRetentionH 清扫存在，数据非永久） |
| 5 | 看绑定的 MES API | M1 | 目录口径=可读产线上的 mes-rest 节点（跨线/孤儿不可见） |
| 6 | req→res 预期响应 | M1 | 表单前置显示护栏（窗≤7天/行≤5000/频控 30 次每分钟每用户） |
| 7 | 自动数据处理 | M3 | **派生数据集管道**（纯 TS 算子白名单）+ scheduled_tasks 定时重建=「自动」落点 |
| 8 | 拖拽绘制可视化 | M2+M3 | M2=点选字段井（Tableau 式低摩擦，诚实标注非画布拖拽）；M3=看板栅格拖拽缩放 |
| 9 | 按用户保存（表单模型） | M2/M3 | `eda_charts`(M2)/`eda_dashboards`(M3)，owner_user_id+visibility+version |
| 10 | EDA 尽可能完整 | M2-M4 | 覆盖矩阵+缺口清单见 §8/§9 |

## 3. 总体设计

新增两大页面，与现有页面分工：/daq=监控控制台（运维向）、**/data=数据管理台**（业务数据消费面）、**/studio=EDA 工坊**（分析搭建面）、/analysis=报告台账（图表可一键「生成分析报告」衔接）。

- **/data 数据管理台**（M1）：产线选择器 → 三个 tab：
  1. 镜像数据：节点多选树（unit/量程/semantics 列、搜索+虚拟滚动+templateKey 分面折叠+localStorage 收藏）→ 时间窗（预设+自定义）→ 聚合粒度（bucket 桶宽，min/max 包络可选）→ 批量查询 → AwChart 多序列 + 分页预览表（列勾选）→「自定义导出」弹窗（列/窗/格式/merge）→ 导出台账与下载；
  2. MES 接口：点位目录卡（能力徽章 读/写/史·五格式/钩子/字段字典「未获取」空态）→ req 构造表单（from/to/max_rows/param）→ res 面板（统计+采样 ≤3 行+字典+**脱敏 req 回显**）→ 可存为数据集；失败态（mes_fetch_jobs failed）如实呈现；
  3. 台账：MES 数据集（引用现有 mes_datasets）+ DAQ 导出（eda_export_jobs + 目录产物探测存在性）合并视图。
- **/studio EDA 工坊**（M2/M3）：三栏——左：数据源树（产线→节点 + 我的图表 + 数据集；产线三态权限贯穿可见性）；中：画布（编辑态=单图字段井；看板态=12 栅格 gridPos）；右：图表画廊+属性面板。主交互=**inline 字段井**（Y 轴区可分左右轴（chip 带 L/R 徽标）/系列分组/参考线井）+ 双击测点入图 + Show Me 图型推荐（按字段类型点亮/置灰）+ 表单弹层兜底精细项（Y 轴范围/单位/插值）。20+ 曲线对策：chip 溢出「+N 更多」抽屉、系列>8 提示小倍数、图例隔离（legend selected）。

## 4. 数据模型（schema.ts + migrations 幂等迁移；全部 prepared 占位符）

```sql
eda_charts(id PK, title, viz_type,             -- trend|bar|scatter|table|kpi|histogram
  datasource_json,                              -- {line_id,node_ids[],window,bucket_ms,agg,tag 过滤} 查询参数快照
  encoding_json,                                -- {y:[{node_id,axis L|R}],series_by,ref_lines[],legend_hidden[]}
  transform_json,                               -- 枚举算子白名单:bin/delta/resample/shift/movavg(禁表达式求值)
  options_json, annotations_json,               -- 标注=M4 事件/markArea 融合点
  owner_user_id, line_id NULL,                  -- visibility='line' 时 line_id 非空(写入校验)
  visibility CHECK(private|line),               -- public 首期不做
  version, created_at, updated_at)
eda_dashboards(id PK, title, filters_json,      -- 全局时间/筛选变量定义(节点/批次下拉→panel 查询变量)
  layout_json, owner_user_id, line_id NULL, visibility, version, created_at, updated_at)
eda_dashboard_charts(dashboard_id, chart_id, grid_pos_json, overrides_json,
  PK(dashboard_id,chart_id))                    -- Metabase report_dashboardcard 式关联
eda_export_jobs(id PK, kind(daq-export|derived-dataset), spec_json, status(running|ready|failed),
  result_json, error, created_by, created_at, updated_at)
  -- 复刻 mes_fetch_jobs 模式:进程内 void run() 即返;跨进程 running 按 bootedAt 判死呈现 failed;并发=1 队列
```

- 台账**引用而非复制**：MES 数据集直接用现有 `mes_datasets`（不做镜像表）；DAQ 导出产物仍在 `<dataDir>/daq-exports/`、派生集落 `<configRoot>/datasets/`（注意是两处目录），读取时探测文件缺失并如实呈现（`RETAIN_EXPORTS=50` 会清理旧目录，台账悬空必须处理）。
- JSON 列写入做形状校验；grid_pos 校验为 0-12 整数。
- 命名遵循仓库惯例 `owner_user_id`（agents/teams/scheduled_tasks 同款）。

## 5. 后端 API 设计

### 5.1 批量查询（新，M1 核心）
`GET /api/workshop/daq/query`（静态路由，注意与节点 id "query" 的既有遮蔽权衡一致）
- 参数：`line_id, node_ids[], from/to 或 last_minutes, bucket_ms(强制>0), agg(avg|min|max|cnt 包络), tag 过滤(run_id/recipe_id/product_id)`
- **BLOCKER 修正 B1**：现有 `queryTagged` 的 LIMIT 是**全局共享**（`sqlite.adapter.ts:182-207`、`timescale.adapter.ts:162-215`），多节点语义错误。修法：适配器增加**每节点配额**（`ROW_NUMBER() OVER (PARTITION BY node_id ORDER BY ts)`），并同步补 `tests/tsdb-ordering.test.ts` 多节点契约用例（ASC + 每节点限额 + raw 游标续页契约）。
- **交互式护栏 H2**：node_ids≤8；每节点返回点≤2000；`window/bucketMs ≤ 5000/节点`（超出 400 提示加大桶宽，复用 `daq.query.minBucketMs` 热更新下限）；总点数硬顶 2 万；单用户并发查询≤2（LRU 计数）。
- **缓存 H1**：LRU key=hash(全部影响结果的入参：nodeIds+窗+bucket+agg+tag 过滤+limit+line_id)；TTL 按粒度分档（bucket≥60s→60s，更细→5s）。
- **LTTB 裁决**：M1/M2 不做（评审可砍项）。桶聚合 + min/max 包络已覆盖趋势与峰值场景；LTTB 作为纯函数 util（不进 TsdbPort 适配器，保双后端契约等价）推迟到确有 raw 密度需求时。
- **设计约束 H6（铁律）**：图表不设「按 chart id 服务端代取数据」的代理端点；数据永远在客户端调 /daq/query 时按请求鉴权——防止 chart 成为绕过 lineMode 的数据通道。

### 5.2 批量导出（新，M1）
`POST /api/workshop/daq/export`（body：node_ids/line_id/窗/列选择/format csv/merge）→ `eda_export_jobs` 异步（并发=1 队列，防全内存缓冲叠加造成内存尖峰）+ `GET /api/workshop/daq/export/:jobId` 进度/结果。
- **授权修正**：`exportDaqDataset` 本体零权限（依赖注入设计）。REST 壳新建用户面 allowlist（`lineMode≥readonly` 的可读线 ∪ `filterByLine`）构造 nodeOf/readPoints 注入；护栏沿用 7 天窗/200 万点每节点/400 万总行/safeFileId。
- 二进制下载走裸 `defineEventHandler`（84 字节 Buffer 事故先例）。

### 5.3 MES 调试台（新命名空间，M1）
- `GET /api/workshop/mes/points?line_id=`：复用 `catalog(scope_line_ids=用户可读线)`。
- `POST /api/workshop/mes/preview`：**BLOCKER 修正 B2**——不复用 Agent 单例 controller（其授权=agentId→dcw 绑定，人类无绑定会全 403）。经 `createMesController(deps)` 注入新实例：`boundNodeIds=() => 用户可读线上的 mes-rest 节点`，频控按 userId（30 次/60s，429 转 UI toast）。返回**结构化**统计/采样（注意：现有 `fetch()` 返回 Agent 向 prose，需重构暴露面，非一次调用）+ 字段字典 + **BLOCKER 修正 B3** req 回显脱敏：仅回 path+query+敏感头黑名单剔除后的 headers（authorization/cookie/token/secret/api-key/x-api-key），绝不回显 driverConfig 原文。仓库无现成脱敏工具，需新建 `redactHeaders` util + 单测。
- `GET /api/workshop/mes/datasets`：mes_datasets 台账 + head/stats/rows/下载（复用 mes-datasets store）。

### 5.4 EDA 持久化 CRUD（M2/M3）
- `/api/workshop/eda/charts`（GET 列表/POST/GET·PATCH·DELETE [id]）、`/api/workshop/eda/dashboards`（同型+dashboard_charts 关联管理）。
- **BLOCKER 修正 B4 读路径**：private→owner/admin；line→`requireLineMode(user, chart.lineId,'readonly')`；dashboard 读对其包含的每个 chart 逐个复用同一判定（防看板旁路）。**列表谓词=`owner_user_id==user OR (visibility 可见判定)`**——不能用裸 `filterByLine`（其对 lineId==NULL 一律丢弃，owner 自己的私有无产线图表会消失）；filterByLine 只用于 line 归属过滤段。写操作=owner 或 admin；`visibility='line'` 写入时强制 line_id 非空。
- recordOps 埋点：`data.export`/`chart.save`/`dashboard.save`/`mes.preview`。

## 6. 前端设计

- 组件域 `app/components/data/`、`app/components/studio/`（页面私有组件不进 pages 目录）；页面 `app/pages/data/index.vue`、`app/pages/studio/index.vue`；样式工具类每组件逐字持有（scoped data-v 坑）；echarts 一律 `<ClientOnly>`+autoresize+增量 setOption（`DashboardTrendPanel.vue:32` 范本）。
- **AwChart 补注册清单**：LineBar 外需 Scatter、**MarkLineComponent（参考线——不注册会静默丢线）**、heatmap 需 VisualMapComponent；箱线/直方的分箱与五数概括在服务端算（transform 算子）。
- **零成本三件套（M2 内置）**：`toolbox.saveAsImage`（PNG 导出）、`echarts.connect`（多图共享十字线+dataZoom 联动）、`dispatchAction highlight`（预览表 hover↔图中系列联动）。
- live tail（M4）：复用 `useDaqStream`（daq.reading WS，500ms 合批）；注意 HIST_CAP=60 环形缓冲≈1 分钟，更长实时窗=query+增量拼接防双份序列。
- 看板栅格（M3）：自研最小实现=移动+右下角缩放、无碰撞挤压、gridPos 服务端校验；不引重型依赖（若工期超支再评估 grid-layout-plus）。
- M1→M2 衔接：预览表「加入分析」跳 /studio 携带查询参数。

## 7. 派生数据集管道（「自动数据处理」落点，M3）

- 纯 TS 变换管道（无 Python）：算子白名单=滑动平均/差分/shift(周期)/重采样/分箱；输入=查询结果或已有数据集；产物 CSV 落 `<configRoot>/datasets/` 并登记 `mes_datasets(created_by='studio')`——台账/下载/图表引用/权限全部免费复用现有设施。
- **同比/环比叠加 = shift 算子 + 双系列 overlay**（同一套代码）。
- 「自动」：`scheduled_tasks` 表已有定时任务基建，派生集可挂定时重建。

## 8. 里程碑与验收

### M1 数据管理台（后端三组 API + /data 页）
范围：B1 适配器每节点配额+测试、/daq/query、/daq/export+eda_export_jobs、/mes/points·preview·datasets（含 B2/B3 脱敏）、/data 三 tab。
验收（`scripts/data-studio-e2e.mjs`）：隔离实例+模拟器建线→批量查询断言每节点点数正确（B1 回归）→越权节点 403→导出任务 ready 且盘上 manifest/nodes 存在→台账下载 200→MES preview 返回字典且回显无 Authorization 头→429 频控→unit（redactHeaders/查询护栏/LRU key 全维度）全绿→i18n 校验脚本全绿→导航截图目检。

### M2 EDA 单图搭建
范围：/studio 编辑态（数据源树/字段井/画廊 6 图型：趋势(多 Y 双轴)/柱/散点/表格/KPI/直方；参考线井+阈值模板一键导入（daq-templates 自带上下限）；Show Me 推荐；图例隔离；零成本三件套）；`eda_charts` CRUD+B4 读路径；「加入分析」衔接。
验收：建图→保存→重开还原 encoding；权限负例（无 readonly 用户看不到产线数据源/他用户私有图 404/line 图跨线用户不可见/看板包含私有图时整板按 B4 判定）；PNG 导出文件存在；单测覆盖 CRUD+可见性矩阵。

### M3 看板与派生管道
范围：`eda_dashboards/dashboard_charts`+最小栅格拖拽+全局时间范围联动+看板筛选器（节点/批次下拉→panel 变量）；我的图表库/复制/JSON 导出；派生数据集管道+scheduled 重建；**一键发送 Agent 深度分析**（图表→组装 daq_query 提示词→workshop channel→结论回写 analysis 台账；Agent 基建现成，市面 EDA 都没有的差异化）。
验收：看板拖拽 gridPos 持久化+刷新还原；筛选器改变驱动多 panel 重查；派生集出现在台账与图表数据源；Agent 分析回执在 analysis 台账可查。

### M4 差异化增强（可独立排期）
批次/事件对齐叠加（复用 daq_samples 已有 run/recipe 打标列与索引，标注 annotations_json+markArea——建议单独立项，是变换复杂度大头）；live tail；URL 序列化状态；kiosk 车间大屏（`?kiosk=1` 隐藏侧栏+自动轮播，暗色令牌已有）；资产相对模板（config_json 中 node_id 抽 `{{node}}` 变量+打开时实例化，成本减半做法）。

## 9. 明确不做（避免过度工程）

SQL/notebook 工作区；多数据源连接器抽象；语义层/指标中台/ChatBI；多人实时协作；图表插件架构（内置 6 图型封顶）；独立告警引擎（阈值=参考线+越限标红）；自由画布布局；visibility='public'；看板级整体缓存/物化；Story 模板市场。

## 10. 横切约束（评审实证汇总）

1. 全部 SQL prepared 占位符；DDL 进 schema.ts+migrations（additive 幂等）——Mimosa 对 db.exec 的拦截纪律。
2. TSDB 契约：ASC 正序（`tests/tsdb-ordering.test.ts` 锁死）；raw 超 limit 截取最旧段，取全量必须 lastAt+1 游标续页（学 daq-export）。
3. 时间文本比较：created_at 本地时区 ISO，外部 epoch/Z 先归一（analysis timeArg 先例）。
4. i18n：zh-CN.ts 与 en.ts 双文件同补（哈希键风格），`_i18n-verify-keys.mjs` 校验挂 CI。
5. 权限：产线三态贯穿 /data /studio 数据源树；MES 字典空=「未获取」态。
6. 性能：每系列≤2000 点、预览强制分页、查询超时；SQLite 模式禁 20 节点×7 天原始查询（护栏在 5.1）。

## 11. 风险清单

| 风险 | 缓解 |
|---|---|
| B1 适配器改动动到双后端契约 | 先补多节点契约测试再改实现；Timescale 同步改 |
| 「自动数据处理」承诺兑现 | M3 派生管道是 MVP 级算子集,超出白名单的明确不做 |
| 20+ 曲线/500+ 节点交互 | chip 抽屉+小倍数提示；搜索+虚拟滚动+分面折叠+收藏（TownDaqTree 先例） |
| 栅格拖拽工作量黑洞 | 最小实现（移动+单角缩放+无碰撞），超支即引 grid-layout-plus |
| 导出内存尖峰 | 并发=1 队列+沿用护栏；流式写列为后续 |
