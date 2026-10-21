# 数据工坊 + 企业EDA 全功能验收报告（Ralph 轮）

日期：2026-10-21
任务：新增功能（数据管理台 + EDA 企业级）API 与前后端交互真实测试；先前功能（Agent 节点绑定 / Channel 作业流程 / 数采数控分析作业）同步实机回归。
环境：隔离实例 `AW_HOME=C:\Users\87287\AppData\Local\Temp\aw-scenario-suite-WYxynf`，平台 `http://127.0.0.1:3470`（本轮最终构建），PLC 模拟器 `4050`（五协议注塑预设），产线 `ln-*`（14 DAQ + 11 DCW 节点），admin 首注册。
PRD：`.omc/state/prd.json`（7 故事，全部可执行断言）；进度：`.omc/state/progress.txt`。

## 验收标准与执行结果（逐条）

### US-002 新功能 API 全链（data-studio-e2e.mjs，最终构建上复跑）
**结果：50/50 PASS**（证据：`docs/audit/evidence/2026-10-21-phase-a/phase-a-e2e.json`；stdout 复跑通过）
| 组 | 断言 | 覆盖 |
|---|---|---|
| PA0.5 | 产线开跑 + 采样活性探针 ≥3 点 | 停/开线→DAQ 打标采样在流 |
| PA1.1-1.5 | 批量查询两节点一次返回（每节点≤2000、ASC 契约）、>8 节点 400、>8 产线省略 node_ids 400、同参缓存命中 | B1 语义 + 护栏 + LRU |
| PA2.0-2.2 | run 台账开/关账镜像、ended_at 回填、sample_count 异步回填 >0 | E1 |
| PA3.1-3.6 | 导出任务受理→ready(totalRows>0)→manifest/merged/nodes 下载 200→路径穿越 404 | E1/导出链 |
| PA4.1-4.2 | MES 点位目录（空目录合法）、不可读点位 403 | B2/B3 |
| PB1.1-1.5 | 图表 CRUD、line 无 line_id 400、版本自增、他人读私图 404、他人列表不含 | B4 |
| PB2.1-2.3 | golden 画像 100 桶生成、single 取回、偏差分有限 | E2 |
| PC1.1-1.3 | 特征提取（关账自动）、判定语义（<3 基线只记录）、任务账本 done | E3 |
| PC2.1-2.4 | SPC 注册（metric 自动对齐 templateRef）、冷启动 enabled=false、详情+点序、非法 kind 400 | E4 |
| PC3.1-3.3 | 共性分析 node/hour 200、非法因子 400 | E5 |
| PC4.1 | chamber PATCH → chamber 因子共性可见 | E8 |
| PD1.1-1.3 | OCAP 开单/步骤/关单（孤儿弱关联 stale=false 不报错）/终态清单 | E7 |
| PD2.1 | VM 推理入口：模型缺失 404 | E6 |
| PD3.1-3.4 | 看板创建、内嵌 chart B4 随行、布局保存 version 自增、他人读看板不泄露 chart | M3/B4 |
| PD4.1-4.3 | 派生数据集（movavg+delta）、data.csv 下载、非法算子 400 | M3 |
| PD5.1-5.2 | 相位段定义、重算特征按段拆分（segmented>0） | E8 |

### US-003 新功能 前后端交互（UI，真实 Chrome）
**结果：14/14 PASS**（新增 `scripts/data-studio-ui-e2e.mjs`；证据 `ui-e2e.json`）
- /data：导航项「数据管理」✓、三 tab ✓、产线下拉 ✓、勾 2 节点 ✓、查询→echarts canvas ✓、预览表 100 行 ✓、导出→台账出现任务 ✓、批次台账渲染 ✓
- /studio：节点树 14 ✓、+Y 入字段井 2 ✓、查询→canvas ✓、保存图表→「我的图表」出现 ✓
- /studio/board 可打开 ✓；**全脚本 0 pageerror**

### US-004 先前功能 A：Agent 节点绑定与隔离
**结果：7/7 PASS**——A/B 各绑 1 节点：描述互不含对方节点、查询各只覆盖 1 节点、A 查 B 节点被拒（带绑定面指引）。

### US-005 先前功能 B：Channel 作业流程
**结果：exit 0，PASS(44/44)**（`/tmp/e2e-line-acc.log`）——开停线 HITL、审批期换线/批次/配方 TOCTOU、跨线绑定清理、agent token 自证、DAQ 实采、DCW 写 110 回读 110、步限/60s/量程拒绝。

### US-006 先前功能 C：数采/数控/分析作业
**结果：exit 0，25/25 PASS**（`/tmp/mes-agent-acc.log`）——G2 产线/绑定/配方/开跑、G3 recipe_apply HITL 下发、G4 配方创建审计、G5 配方日志、G6 外部 API 推送数组/图像→daq_frames 语义读取→daq_export、G7 MES 向量历史+字典→mes_fetch/mes_export、G8 配方管理 UI。
分析作业：场景 setup S7 `analysis_save`/`analysis_query` 断言通过（21/23，仅 2 条失败为该脚本自带的**历史已知断言缺陷**——产线状态字段读 `active`、均值解析误取首节点；与本轮功能无关，见 evidence `US-001-002-setup-analysis.json`）。

### 全局门
- ESLint：`npm run lint` exit=0，全仓 0 error
- 单元：`npm run test:unit` **309/309**；仓库 typecheck ✔；i18n 双语 `PARITY OK`（2902 键）

## 边界（如实）
1. VM OOD 阈值用保守缺省（distanceThreshold=3），未做 per-model 调参；VM 训练全链（AML 作业）不在本轮 e2e（入口语义已测）。
2. 注入型断言（FDC 违例注入 / E5 lift>1）机制在、e2e 未种子化（需 ≥3 good 批次种子）。
3. e2e 中 S7 的 2 条失败是场景脚本历史断言缺陷（非系统缺陷），已在注释与本报告记录。
4. UI e2e 覆盖核心交互路径；视觉走查/自适应矩阵沿用既有 scripts/ui 套件未重跑。

## 结论
新增功能（数据管理台 + EDA 企业级八模块）与先前功能（Agent 绑定隔离 / Channel 治理 / 数采数控配方分析作业）在真实环境全部验收通过：**API 50/50、UI 14/14、隔离 7/7、Channel 44/44、MES 集成 25/25、单测 309/309、ESLint/typecheck/i18n 全绿**。
