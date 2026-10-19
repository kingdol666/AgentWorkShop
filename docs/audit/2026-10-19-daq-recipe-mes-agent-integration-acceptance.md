# 数采 / 配方 / MES Agent 集成验收(2026-10-19)

## 结论

本轮把「Agent 按绑定节点、当前产品、product_id/recipe_id 取数与下发」和「多源异构数据(数组/图像/MES 字段字典)在线分析 + 离线导出」打通，并完成隔离实例真实验收：

- 单元/集成测试：**251/251 通过**
- 隔离实例 E2E：`scripts/mes-agent-integration-e2e.mjs` **25/25 通过**
  - 含真实 HTTP、Agent 工具桥、真实 HITL 人工批准、MES 模拟器、外部 API 推送数组/图像、浏览器点击配方管理「下发历史」弹窗
- `npm run typecheck`：通过
- `npm run lint`：通过
- `npm run build`：通过

## 一、Agent 数据查询与配方控制

### 1. 按绑定节点 / 当前产品 / product_id / recipe_id 查询

已有能力复核并补齐：

- `daq_query`：绑定数采节点 ∪ 频道绑线数采节点；默认自动按**当前活动批次的 product/recipe/run** 过滤，显式传 `product_id`/`recipe_id`/`run_id` 时按显式值过滤；`scope=all` 才跨配方。
- `line_context`：活动批次、产品、配方、参数目标值 vs PLC 当前值、数采窗口。
- 新增 `recipe_catalog`：按 `line_id`/`product_id`/关键字列出配方，明确标出**当前执行中**配方、产品、参数、良好批次；解决只能从自由文本里猜 recipe_id 的问题。
- `mes_catalog` 新增 `product_id`/`recipe_id` 过滤：按产品/配方解析产线后收窄 MES 点位，跨线或不存在即拒绝。
- `recipe_log`/`ops_log`：按 `line_id`/`product_id`/`recipe_id`/时间查询；本轮补齐 Agent `recipe.apply`/`recipe.trial`/`recipe.propose` 审计行的 `product_id`，按产品过滤不再丢失下发动作。

### 2. 直接对「当前配方」下发

`recipe_apply`、`recipe_trial`、`recipe_update` 的 `recipe_id` 改为可选，新增 `line_id`：

- 只传 `line_id` → 解析该产线**当前活动批次**的 recipe_id；
- 同时传 → 校验配方归属产线与 `line_id` 一致；
- 未开跑 → 明确报错并提示先开跑或直接传 `recipe_id`。

E2E G3 已实测：`recipe_apply({line_id})` 经 manual HITL 人工批准后整批下发，1/1 设备证实。

### 3. 把当前配方/批次保存为新配方

新增 Agent 工具 `recipe_create`：

- 参数来源优先级：显式 `params` > `from_run_id` 的 `paramsSnapshot` > `source_recipe_id` 的配方定义；
- `use_active_run=true` 直接使用当前活动批次的冻结参数；
- 可复制 `daq_windows`/`access`；
- 权限：Agent 必须在目标产线已有写向绑定(数控节点或配方)；manual 线/绑定 → HITL 人工批准；审批卡展示来源、参数、产品、产线；
- 创建后**不自动绑定**给 Agent，返回文案提示用户/lead 在配方管理里绑定后才能继续 update/apply；
- 审计 `recipe.create` 带 `line_id`/`product_id`/`recipe_id`。

E2E G4 已实测：从活动批次冻结参数另存新配方，HITL 批准后创建，`recipe_catalog` 可见。

### 4. manual 模式人工确认

- 配方写动作统一走 `assertRecipeOperation`：绑定 → 二级认证 → 运行门 → `binding.mode==='manual' || line.controlMode==='manual'` → HITL。
- `recipe_create` 新增 `assertRecipeCreate`：产线写向绑定 + manual 线/绑定 → HITL；频道绑线(只读)不能单独作为新建依据。
- HITL 超时/拒绝/批准附言沿用既有 30 分钟配方下发审批链。
- E2E 两次动作均真实挂起审批单，人工批准后执行。

### 5. 配方管理 UI 下发历史

- 配方卡片新增「下发历史」按钮；
- 新组件 `app/components/dcw/DcwRecipeDispatchHistoryModal.vue` 读取 `GET /api/workshop/ops-logs?scope=line&recipeId=...`；
- 只保留配方作业面：`recipe.*`、`line.start/stop`、`dcw.write.*`，避免告警/数采事件混入；
- 与 Agent `recipe_log` 同源。
- E2E G8 用 Chrome 实际打开 `/dcw/<line>`、点击「下发历史」、断言弹窗含下发/回执/开跑记录；截图 `recipe-dispatch-history.png`。

## 二、多源异构数采

### 1. 外部 API 推送数组/图像

新增 `POST /api/workshop/daq/:id/ingest`：

- 标量：`{ value }`
- 向量(如膜厚模头点位数组)：`{ points: number[] }` 或 `{ values: number[] }`，1..4096 有限数
- 图像：`{ image: { base64|data, mime, width?, height? } }`，≤10MB，`image/*`
- 可选 `at`(±7 天)、`state`、`metrics`
- 鉴权：设置 `AW_DAQ_INGEST_TOKEN` 后要求 `x-aw-daq-token`；未设置退回仪表盘用户会话
- 载荷走与网关采样相同的队列 → `daq_frames`/`daq_samples` → 批次打标/告警/WS

E2E G6 已实测：外部推送 8 点数组和 1×1 PNG，`daq_frames` 点列完整、图像元数据(`objectKey/width/height`)入库。

### 2. 向量点位语义

- DAQ 模板 `vector` 新增 `axis`/`pointUnit`/`pointLabelPrefix`/`pointIndexBase`/`labels`；
- 内置 `thickness-scan` 标注「模头横向位置(操作侧→传动侧)」「模头点1..64」；
- `daq_frames` 新增 `include_points`/`point_limit`，输出单位、量程、轴、点位标签；在线可取最多 1024 点/帧；
- `daq_export` manifest 带 `vector` 布局，README 写逐点标签；CSV 长表仍是 `ts_iso,ts_ms,point_index,value`。

E2E G6c/G6d 已实测：Agent 在线读取数组时看到「模头点1」「横向位置」；导出 manifest/README 带向量布局。

## 三、MES 多源异构数据与字段语义

### 1. 字段级数据字典

`readMap`/`historyMap` 新增 `dictionaryPath`(兼容 `response.dictionaryPath`)：

- MES 响应可返回数组/对象/`{fields:[...]}` 形态的字典；
- 解析为 `field/label/unit/description/min/max/kind/index/points[]`；
- 向量字段的 `points[]` 描述每个下标/模头点位含义；
- 首次 `mes_fetch` 后缓存；后续 `mes_catalog` 显示字段摘要；
- 无字典时明确提示，不臆测单位。

E2E G7a/G7d/G7g 已实测：MES 模拟器返回 48 点位字典，`mes_fetch` 回包含「字段字典/膜厚/模头点1/um」；`mes_catalog` 显示 `48 点`；导出 manifest 保留 `unit=um` 与 48 个点标签。

### 2. 在线取数返回实际数组

`mes_fetch` 新增 `include_data`：

- 标量：采样行附实际 `value`；
- 向量：采样行附 `values=[模头点1=..., 模头点2=...]`(最多 64 点/行，带字典标签)；
- 图像/表格/事件仍按原安全约束，不把 base64 原文塞进 prompt；
- `table/event` 的多参数 map 行新增逐数值字段统计(最多 12 个字段，带字典标签/单位)，Agent 不必只看 3 行采样就能判断各加工参数分布。

### 3. MES 数据导出到指定目录

新增 Agent 工具 `mes_export`：

- `ids`、`from/to`、`max_rows`(≤200000)、`param`、`folder`、`title`、`note`、`merge`；
- 标量 → `data.csv`；向量 → 宽表 `data.csv`(`ts,v0..vN`)；图像 → `frames/` + `records.jsonl`；table/event → `records.jsonl`；
- 多标量节点 → `merged.csv`(按时间戳对齐，不插值)；
- 每个目录写 `manifest.json` + `README.md`：单位/量程/物理意义/字段字典/逐点语义/产线-产品-配方-批次上下文/列名/行数；
- 目录限定在 `<配置根>/mes-exports` 下(`folder` 相对路径)；管理员可用 `AW_MES_EXPORT_ROOT` 指定根；拒绝 `../` 逃逸；
- 权限与 `mes_fetch` 同源(仅绑定数控点位)。

E2E G7c-G7e 已实测：导出到指定子目录，manifest 字段字典 48 点，宽表 49 列(ts+v0..v47)，README 可读。

### 4. MES 数据集本地镜像

- 异步 `mes_fetch`(max_rows>2000)现在同时生成 `<dataset>.manifest.json`：
  - 节点单位/量程/描述/物理意义/格式；
  - 字段字典；
  - 产线/产品/配方/批次上下文；
  - 文件列名、行数、sha256；
- `mes_dataset_read` 回包暴露数据文件绝对路径、manifest 路径与字段字典；
- `mes_datasets` 清单也显示数据文件路径。

E2E G7f 已实测：异步数据集完成，`mes_datasets` 显示就绪。

## 四、关于「AWS 镜像数据库」

本仓库没有 Amazon AWS SDK/连接器。当前所谓「镜像数据库」是 **AgentWorkShop 本地镜像 TSDB**(`daq_samples`/`daq_frames`，MES 经 HTTP 镜像节点或异步数据集落盘)：

- `daq_export` 已升级：manifest + `README.md`，包含节点单位/量程/语义、向量逐点布局、产线/产品/配方/批次上下文、报警统计；
- MES 数据集/导出同样带字段字典；
- 如果这里的「AWS」指 Amazon Web Services(而非 AgentWorkShop)，需要另接 AWS 连接器(S3/Timestream/RDS 等)，不在本轮范围。

## 五、变更文件(主要)

| 层 | 文件 |
|---|---|
| MES 驱动/字典 | `server/services/workshop/dcw/drivers/shared.ts`、`drivers/mes-rest.ts` |
| MES 控制器/导出 | `server/services/workshop/mes/mes-controller.ts`、`mes-datasets.ts` |
| MES Agent 工具 | `server/services/workshop/agents/industrial/mes-tools.ts`、`host-tool-bridge/tools/industrial.ts`、`industrial/index.ts`、`.AgentWorkShop/prompts/host-tools.json` |
| 配方工具/审计 | `agents/industrial/ops-tools.ts`、`recipe-gate.ts`、`recipe-propose-tools.ts`、`dcw-recipe.repo.ts`、mark-good/rollback-good 路由 |
| 配方 UI | `app/components/dcw/DcwRecipePanel.vue`、`DcwRecipeDispatchHistoryModal.vue`、`app/pages/dcw/[id].vue`、i18n |
| DAQ 推送/向量语义 | `server/api/workshop/daq/[id]/ingest.post.ts`、`shared/daq-protocol.ts`、`daq-templates.ts`、`daq-tools.ts`、`daq-export.ts` |
| 测试 | `tests/mes-rest-driver.test.ts`、`tests/mes-datasets.test.ts`、`tests/mes-export.test.ts`、`tests/high-risk-tool-scope.test.ts`、`scripts/mes-agent-integration-e2e.mjs` |

## 六、复现

```bash
# 单元/集成
npm run test:unit

# 隔离实例 E2E(自动起 aw dev + MES 模拟器 + HITL + Chrome UI)
npm run test:mes-agent

# 静态门禁
npm run typecheck
npm run lint
npm run build
```

E2E 产物(临时目录)：`%TEMP%/aw-mes-agent-e2e/`
- `dev.log`、`mes-sim.log`
- `exports/`(MES 导出目录)
- `recipe-dispatch-history.png`(UI 截图)
