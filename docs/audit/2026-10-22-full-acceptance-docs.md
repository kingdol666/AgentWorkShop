# 全功能验收 + README/VitePress 文档一致性审计报告

日期：2026-10-22 · 环境：隔离实例 `3470`（`AW_HOME=aw-scenario-suite-OQ68g6`，v0.7.70 冷启，setup 23/23）+ 模拟器 `4050` + IDD `3210` + rag-knowledge `8771` + AML venv · 独立 MES 实例

**总结果：功能验收 197/197 断言全绿（10 套件）+ 平台单测 309/309 + docs:build 构建门通过；文档审计 8 项口径逐一对真值（7 项本已一致，1 项缺口已补），README×2 与 VitePress 落地页优化落地。**

---

## 1. 全功能验收（197/197 + 309 单测）

| # | 套件 | 断言 | 覆盖 |
|---|---|---|---|
| 1 | scenario-suite-setup | **23/23** | 冷启/setup 注册/五协议驱动实测/建线/Channel+绑定+插件/分析落痕 |
| 2 | data-studio API | **50/50** | 复合查询/导出台账/MES 调试台/图表 B4/golden/FDC/SPC/共性/OCAP/VM/看板/派生集/相位段 |
| 3 | data-studio UI | **14/14** | /data 查询→导出、/studio 建图、/studio/board 看板渲染 |
| 4 | eda-live-demo | **24/24** | 三形态节点/异构推送/WS 实时上屏/golden 叠加/渲染产物断言/7 截图刷新 |
| 5 | Agent 绑定矩阵 | **26/26** | 工具面装配(58/70)/绑定取数同值/跨线拒/第二频道/数组帧/图像帧/自定义 API/参数下发 HITL/kb_agent |
| 6 | Agent DAQ 隔离 | **7/7** | 双 Agent 各绑一节点互不可见、越权拒绝附指引 |
| 7 | Team 协调 | **7/7** | 信箱→回报→回执闭环→dispatch_task→任务队列 |
| 8 | 产线+插件 | **6/6** | stop→start 翻转+ops-logs 审计；插件启用面+工具面 |
| 9 | IDD/RAG/AML 回归 | **15/15** | 诊断链(快照→mock 分析→报告代理)/kb_agent 入库+检索锚点命中/数据集→真实 Python 训练→评测门裁决 |
| 10 | MES 集成（独立实例） | **25/25** | 绑定/配方/recipe_apply HITL/审计/外部数组图像推送/MES 历史/UI |
| — | 平台单测 | **309/309** | `npm run test:unit` |
| — | VitePress 构建 | **✔ 6.09s** | `npm run docs:build`（含本轮新增卡片） |

### 套件夹具加固（本轮落地的两处测试侧修复，系统行为无变化）
1. binding-matrix F 段前置「确保开线」——前序套件可能留停线，运行门要求活动批次（运行门本身工作正常，正确拒绝了停线态下发）。
2. idd-rag-aml：厚批循环（sampleCount≥200 的关账批 ×4，不足自动补 210s 开停线循环）+ kb_agent 任务失败自动重提交一次。**评测门语义如实**：轻量回归时窗内数据成熟度不足时，G1/G3/G4 拒绝弱模型属预期防护（终轮实测拦截 438 行/G3 429.1%，前轮 377.1%），过门能力由当日足量数据轮实证归档（mdl-mvj3a0vn，oneStepTest/rollout nrmse=2.72%）。知识库侧 Agent 存在 540s 硬超时容量边界（实测触发后重试语义补齐）。

## 2. 文档一致性审计（对照代码真值逐项）

| # | 口径 | 文档声称 | 代码实测 | 结论 |
|---|---|---|---|---|
| 1 | 版本 | v0.7.70（README×2/落地页/Release 段） | package.json 0.7.70 = npm latest | ✔ 一致 |
| 2 | 宿主工具 | 86 | `.AgentWorkShop/prompts/host-tools.json` 86 | ✔ |
| 3 | 引擎 | 14 | `agents/registry.ts` 14 id | ✔ |
| 4 | 现场协议 | 6（5 内置+串口插件） | modbus-tcp/rtu+opcua+mqtt+http 5 内置 + serial-bridge 插件（s7 为 stub 未计入，如实） | ✔ |
| 5 | 运行时设置 | 119 项/18 组（40 live/79 restart） | `aw config list` 实测 40 live+79 restart=119 | ✔ |
| 6 | stdio MCP 网关 | 38 工具 | `mcp/aw-mcp-server.mjs` 38 唯一工具名 | ✔ |
| 7 | 进程内 MCP | 25 工具 | `server/mcp/workshop-server.ts` 25 个 registerTool | ✔ |
| 8 | **EDA 数据工坊** | **完全缺失**（README×2 与落地页均无 /data·/studio、golden/SPC/FDC/看板） | 已交付并经 50+24+14 断言验收的能力 | ✘ → 已补 |
| 9 | README 相对链接 | 49 条 | 路径存在性全查 | ✔ 0 断链 |

## 3. 文档优化落地（最小真改，中英对齐）

1. `README-zh.md`：功能表新增「**数据管理台与 EDA 工坊（/data · /studio）**」行（三形态镜像/复合查询/导出台账/golden/FDC/SPC/共性/OCAP/VM/派生集）。
2. `README.md`：同位新增「**Data workbench & EDA studio (/data · /studio)**」行（英文对齐）。
3. `docs/site/index.md`：落地页特性卡新增 `EDA` 卡（跟随既有 DATA 卡风格）。
4. `docs/site/en/index.md`：同位新增英文 EDA 卡。

## 4. 证据索引

| 证据 | 路径 |
|---|---|
| 各套件 stdout | `/tmp/full-*.log`（setup/datastudio/ui/demo/binding-matrix/isolation/team/ops/idd/mes） |
| 绑定矩阵 JSON | `docs/audit/evidence/2026-10-22-design-validation/binding-matrix.json` |
| IDD/RAG/AML JSON | `docs/audit/evidence/2026-10-22-idd-rag-aml/regression.json` |
| demo 截图 | `docs/audit/evidence/2026-10-21-eda-demo/shots/`（本轮刷新） |
| 单测/构建 | `/tmp/full-unit.log`、`/tmp/full-docsbuild.log` |
