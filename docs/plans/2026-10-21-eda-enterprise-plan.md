# 企业级 EDA 设计方案（Equipment Data Acquisition & Analysis，半导体厂级）

状态：**pending approval（待用户批准后实施）**
日期：2026-10-21
前置：[2026-10-21-data-studio-plan.md](./2026-10-21-data-studio-plan.md)（数据管理台 + EDA 工坊 M1-M4，已定稿）
方法：双专家并行讨论（领域专家：SEMI 标准+商用产品+算法规格，30 条全带来源；架构专家：实读本仓库代码逐模块判定，带文件锚点）→ 本文档收敛。

---

## 1. 定位与边界（专家讨论的第一收敛点）

我们做的是 SEMI EDA 生态中的 **historian/分析消费侧**（E134 数据的采集存储+分析应用），**不做**：
- SEMI 接口协议栈本身（E5/E30/E37/E40/E87/E90/E116/E125/E134 设备侧实现）——我们不是设备接入网关；
- 完整 EES/EIS 状态模型（E157 全套状态机）与 E134 的 DCP 管理/过载仲裁；
- 多客户端高带宽订阅总线（run 级切分+批写入即可覆盖，先进 fab 日增 3TB 的场景不是本平台目标）；
- 9 层完整 context 层级树表、lot/wafer genealogy（无 MES 上游实体，双轨必冲突）。

**上下文模型映射（最小扩展）**：fab=单实例 / area=产线 line / tool·chamber=数采节点可选字段 `chamber`+`unitPath`（daq-node JSON 领域对象加字段，**无需 SQL 迁移**）/ recipe=配方 / run=批次 / lot·wafer·operator=`eda_runs.labels_json` KV（不做独立实体）；run 内 step 边界=新表 `run_segments`（FDC 特征按段拆分的最小上下文）。

## 2. 与 data-studio plan 的关系（合并开发路线）

plan1 的 M1（/data 批量查询/导出/MES 调试台）与 B1 适配器修复是 **E 轨全部模块的查询底座**；M2/M3 的 /studio 是 E2 Trace Viewer 的宿主页面。合并开发路线（批准后按此顺序执行）：

| 阶段 | 内容 | 交付物 |
|---|---|---|
| Phase A | plan1-M1（含 B1/B2/B3/B4 修正）+ **E1 run 台账** | /data 数据管理台 + run 不再滚丢 |
| Phase B | plan1-M2（/studio 单图）+ **E2 Trace Viewer/Golden** | 拖拽/字段井搭建 + 轨迹对齐叠加 |
| Phase C | **E3 FDC → E4 SPC → E5 Commonality** | 特征仓库 + 统计过程控制 |
| Phase D | **E6 VM 模型联动 → E7 OCAP 闭环** + plan1-M3/M4 | 软测量 + 告警→处置闭环 + 看板/派生管道 |

## 3. 新表（全部 `CREATE TABLE IF NOT EXISTS` 进 SCHEMA_SQL + prepared 占位符；幂等迁移）

```sql
-- E1 run 台账(最优先):解决 dcw-runs.json RUNS_CAP=200 环形滚丢——EDA 一切查询的主键面
eda_runs(id PK, line_id, product_id, recipe_id, recipe_version, started_at, ended_at,
  sample_count DEFAULT 0, outcome DEFAULT 'open',   -- open|good|bad|scrapped
  labels_json DEFAULT '{}', created_at)
  + idx(line_id,started_at DESC) + idx(recipe_id,started_at DESC)

-- E3 per-run per-node 特征仓库(E3/E4/E5/E6 共同数据源,也是 raw 的降压层)
eda_run_features(id PK, run_id, node_id, metric, cnt, mean, std, min, max, slope,
  breach_cnt DEFAULT 0, ref_mean, ref_std, k,       -- 参考带快照判定时固化,抗基线漂移
  z_score, violated DEFAULT 0, created_at, UNIQUE(run_id,node_id,metric))
  + idx(node_id,created_at DESC) + idx(run_id)

-- E2 golden 参考轨迹
eda_golden_traces(id PK, recipe_id, node_id, source_run_id, n_bins DEFAULT 100,
  profile_json,             -- [{phase,mean,std,min,max}×n_bins]
  fingerprint_json, created_by, created_at, UNIQUE(recipe_id,node_id))

-- E4 SPC 控制图注册 + 判定点
eda_spc_charts(id PK, line_id, node_id, metric, kind,  -- i_mr|xbar_r|ewma|cusum
  params_json, cl, ucl, lcl, sigma, n_points DEFAULT 0,  -- ≥25 才 enabled
  enabled DEFAULT 0, owner_user_id, created_at, updated_at,
  UNIQUE(line_id,node_id,metric,kind))
eda_spc_points(id PK, chart_id REFERENCES eda_spc_charts ON DELETE CASCADE, run_id,
  value, stat, rule_hits DEFAULT '[]', violated DEFAULT 0, at)
  + idx(chart_id,at DESC)

-- E3 特征重建 job 账本(mes_fetch_jobs 同款:进程内 void run() + bootedAt 跨进程判死;并发=1)
eda_feature_jobs(id PK, run_id, status DEFAULT 'running', features DEFAULT 0, error, created_at, updated_at)

-- E7 OCAP 记录
eda_ocap_records(id PK, alarm_id, run_id, node_id, title, steps_json DEFAULT '[]',
  status DEFAULT 'open',    -- open|closed|void
  closed_by, closed_at, linked_exploration_id, linked_rollback_anchor,  -- 弱关联不设 FK
  owner_user_id, created_at) + idx(alarm_id)

-- run 内 step/相位段定义(E3 按段特征 + E2 相位对齐共用)
run_segments(id PK, recipe_id, seq, name, phase_from REAL, phase_to REAL, UNIQUE(recipe_id,seq))
```

## 4. 模块规格与验收断言

### E1 run 台账与 trace 切片（封装级，依赖 M1 B1 修复）
- 现有资产：样本/帧写入时已按活动 LineRun 打标并建 `idx_daq_tag/idx_daq_run`（`ingest.ts:60-79`、`sqlite.adapter.ts:54-57`）；导出游标续页骨架 `daq-export.ts:275-297`。
- 工作：run 开/关账钩子写 `eda_runs`（关账回填 sample_count、outcome）；`toolDaqExport` 与新 REST 导出贯穿 `run_id` 入参；切片查询复用 dataset-builder 的 `queryTagged(runId)` 模式（`aml/dataset-builder.ts:174-262`，清洗+网格化+公共网格可直接复用）。
- 验收：① 开跑采 2 个 run，`samples` 按窗口只含活动 run 样本（停线段 run_id=NULL 不混入）；② 6000 点节点导出 CSV 行数=6000（无丢点/重复）；③ 关账后 eda_runs 一行且 sample_count>0；④ 第 201 个 run 关账后按 runId 仍可查窗口（不再依赖 runs.json）。

### E2 Trace Viewer + Golden 轨迹（前端封装 + 小改，宿主=/studio）
- 现有资产：AwChart（需补注册 **MarkLineComponent**，否则参考带静默丢线）；相位对齐/网格化算法直接复用 `alignToGrid`。
- 工作：多信号叠加（多次 queryTagged 并列 series）；run 边界 markLine；0-100% 相位轴（等分相位桶重采样，n_bins=100）；golden profile 叠加（mean±std 带 markArea）；fingerprint 摘要（与 runData 聚合同口径）。
- 验收：① 相位模式两 run 均按 0-100% 等分叠加；② golden 加载后出现 mean±std 带；③ 单次响应 series 总点数 ≤5000（raw 超限被拒并提示降采样）；④ fingerprint 与 runData 聚合一致（容差 1e-6）；⑤ 相似度=相位归一（n≈100-200）后 DTW+Sakoe-Chiba 带（w=n/10），50 run×1 golden 百毫秒级；**原始长序列直接 DTW 不做**。

### E3 FDC（新建轻量算法，纯 TS）
- 算法：run 关账触发 per-run per-node 特征提取（单遍 O(n)：cnt/mean/std/min/max/slope/越限数；**SQLite 无 stddev/regression，TS 侧算**）；参考带=前 N 个 good run 的 mean±k·σ（快照固化进特征行）；violate=|z|>k；多变量 T²/SPE(PCA) **不进本期**——单变量误报率不达标时升级为 AML venv 作业。
- 告警链复用：`sweep-alarms.ts:91-167`+`alarm-notify.ts`+`alarm_events` 全链已有，扩 rule 枚举（'fdc-zscore'）；误报控制=per-run 粒度天然稀疏 + grace 期（run 前 X 秒不计 breach）+ 冷却期内不重复外送。
- 验收：① 注入越限 run→特征行 violated=1 且 |z_score|>k；② 基线快照固化（改基线不重算历史行）；③ grace 期样本不计入；④ 违例触发 alarm_events 一行且同 run 同节点不重复（幂等），ack 入 audit_log；⑤ 冷却期内第二违例不重复外送通知。

### E4 SPC（新建算法，教科书公式纯 TS + 单测）
- 内容：I-MR/Xbar-R/EWMA/CUSUM 控制图 + Western Electric 4 条/Nelson 8 条判异；数据源=`eda_run_features` 的特征序列（等间隔 per-run）；控制限 ≥25 子组才 enabled；与配方 daqWindows 关系=并存不合并（SPC 是特征序列统计带，daqWindows 是实时单点硬限）。
- 验收：① 30 run 建限后 UCL/LCL=CL±3σ（解析断言）；② 注入连续 9 点同侧→Nelson 规则 2 命中；③ EWMA 漂移注入后 stat 偏离 CL；④ 换配方 chart 隔离（UNIQUE 约束）；⑤ spc_points.run_id 均可回查 eda_runs。

### E5 Commonality（纯封装，GROUP BY）
- 查询形状：bad-run 集（FDC violated ∪ alarm 关联 run）× 因子（recipe/node/chamber/时段桶）交叉聚合 + lift 计算（TS 算占比）。
- 验收：① 3 个同节点违例 bad run→该 node lift>1；② 按 recipe 交叉表行数=配方数；③ 小时桶能区分 bad 集中时段；④ 行级 DISTINCT run 计数不超 bad 集大小。

### E6 Virtual Metrology（AML 链路小改+补齐，无需新建 Python 基建）
- 工作：① `aml_models.purpose` 枚举加 `'virtual_metrology'`（spec.ts:40 + repo 校验）；② 特征对齐适配：VM 输入=per-run FDC 特征向量，现有 io_spec 是滑窗时序——加"特征向量→predict"薄适配；③ OOD 拒判直接挂既有 `evaluateEnsemble`（`twin/uq-ood.ts`）；训练/门禁/promote/推理 API 全链复用（`job-orchestrator`/`twin_gate_evaluate`/`models/[id]/predict`）。残差有界 0.25 对 VM 偏保守，标注文档。
- 验收：① purpose='virtual_metrology' 走训练→门禁→promote 全链；② predict 接口接受特征向量返回目标值；③ OOD 注入→响应带 rejectCode 而非数值。

### E7 OCAP 闭环（纯封装，组装既有设施）
- 链路：FDC/SPC 违例→`user_notifications`+`notifyLineOperators`（线→operate 用户反查，已在跑）→OCAP 记录（处置步骤/关闭人）→弱关联 `optimization_explorations` 与 rollback anchor（跨 JSON 存储不设 FK，孤儿引用显式标 stale 不 500）。
- 验收：① 违例后 operate 用户收通知（event_id 幂等）；② OCAP 从告警详情可跳转；③ closed 时弱关联存在性校验、孤儿标 stale；④ rollback 后 audit_log(kind='rollback') 可被 OCAP 详情检索。

### E8 上下文最小扩展
- `DaqNode` 加 `chamber`/`unitPath`（JSON 序列化，无 SQL 迁移）；`run_segments` 表；`labels_json` 承载 lot/wafer。
- 验收：① chamber 配置后特征查询可按其过滤；② 定义 0-50%/50-100% 两段后特征按段拆两行；③ labels 写入 lot_id 后可按其检索 run。

## 5. 算法实现边界（收敛结论）

- **TS+SQLite 可信**：切片/导出/清单、per-run 特征（单遍 O(n)）、kσ 参考带、I-MR/Xbar-R/EWMA/CUSUM/Nelson、commonality 聚合、相位对齐与 golden profile、受窗约束 DTW、fingerprint。先证：dataset-builder/gates/uq-ood 全是纯 TS 且带单测。
- **走 AML Python venv（已有链路，不新建）**：VM 建模（回归/集成/校准→ONNX 回流 predictor）、多变量 T²/SPE 升级、大规模 run 谱系聚类。
- **明确砍**：SEMI 协议栈、EES 状态机、9 层 context 树、lot/wafer genealogy、逐样本在线 T²、SQLite 端注册 stddev/slope 聚合函数、scheduled_tasks 承载特征重建（它烧 LLM token——用 eda_feature_jobs 进程内 runner，对齐 sqlite retention timer 惯例）。

## 6. 性能与存储红线（SQLite 模式）

- 写路径：默认 5s/节点→500 节点=100 行/s，WAL+500ms 批写无虞。
- 体量：1s×50 节点≈432 万行/天（0.3-0.5GB）；7 天保留期≈3000 万行/2-4GB——**已是 SQLite 红线**。
- **降压层=特征仓库**：per-run per-node 一行，一年 10 万 run×50 节点=500 万行毫无压力；**E3-E6 分析全部落在特征表，不落在 raw**。
- Timescale 切换触发线（DAQ_TSDB_URL 已支持自动降级）：节点>200 且采样≤1s、或保留>30 天、或 per-run 全样本并发分析>2 路、或单库>5GB。
- 导出护栏沿用：raw 单查 clamp 5000、queryTagged clamp 100 万（B1 修复后每节点配额）、exportDaqDataset 4M 行/次、保留 50 目录。

## 7. 企业级平台面（借 plan1 承载）

权限=产线三态+owner_user_id；审计=recordOps 全埋点（feature.build/spc.violate/ocap.close/trace.export）；通知=既有 event_id 幂等链；分层存储=热（raw 7-30 天）+特征层（长期）+导出归档目录；多 fab/语义建模不做。

## 8. 总验收门（批准后执行时逐条打勾）

1. plan1 §8 M1-M4 全部断言绿（含 B1 多节点契约测试、B2/B3/B4 权限与脱敏）。
2. E1-E8 各模块 §4 断言全部绿（9 组共 40+ 条，汇总进 `scripts/eda-enterprise-e2e.mjs`）。
3. `npm run test:unit` 全绿（新增：特征提取/SPC 公式/Nelson 规则/DTW/redactHeaders/可见性矩阵单测）。
4. 真实环境（隔离实例+注塑模拟器）端到端：开跑 3 run→E1 台账→E2 相位叠加 golden→E3 注入越限出告警→E4 建限出 Nelson 命中→E5 lift 报表→E6 VM 训练门禁推理→E7 OCAP 全链留痕。
5. UI：/data 与 /studio 新 tab 截图目检+i18n 双语言校验脚本全绿。
