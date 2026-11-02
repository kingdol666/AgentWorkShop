---
title: PROTO3-B3 深度根因诊断报告(数据审计终止 / NOT_ASSESSABLE-EMPTY_EXPORT)
kb: aw-industrial (3aea5973-1d8a-4db6-b415-6d4432f514bb)
scenario: proto3-b3-blowline
line: ln-5402968a
tags: proto3-b3, offline-data-diag, empty-export, not-assessable, 数据可诊断性审计
source_result_id: 035d5a1b
source_run_id: 202611010429369_offline-data_diag
source_api: /api/files/workspace/report/202611010429369_offline-data_diag
source_file: D:/codes/myskills/idd-doe-impl/workspace/diagnostic-runs/202611010429369_offline-data_diag/report.md
staged_at: 2026-11-01 (worker 知识调优工程师)
ingest_status: STAGED — 未入库;kb_agent action=ingest 受平台 HITL(kb)约束,180s 默认拒绝;仅待人工批准后单次提交
---

# PROTO3-B3-文档驱动接入线 — 深度根因诊断报告（数据审计终止）

- **Run ID**: `202611010429369_offline-data_diag`
- **产线**: `ln-5402968a` / PROTO3-B3-文档驱动接入线
- **数据集**: `aw-snapshots/exp-daqexp-20261101120342-a9e9f7`（export `daqexp-20261101120342-a9e9f7`，2026-11-01T12:03:42 生成）
- **分析窗口**: 2026-11-01T11:03:42.251+08:00 ~ 2026-11-01T12:03:42.251+08:00（60 分钟）
- **运行模式**: `full`（本体模式 `full`，增强策略 `off`）
- **状态**: **NOT_ASSESSABLE / EMPTY_EXPORT** — 本次不出具诊断结论

---

## 执行摘要

本次调用未产出根因诊断，原因是**数据侧为空**，而非分析侧失败：目标导出的 7 个节点 CSV **全部只有表头、零数据行**（文件大小 24–30 字节），manifest 亦自报 `totals.rows = 0`、全部节点 `rows: 0 / frames: 0`、`value_range_observed: null`。

因此本报告不是诊断报告，而是**数据可诊断性审计报告**。按管线 Step 0.5 的数据源无关性门禁（`status=no_tabular_data` → 停止并交付审计），本体构建、统计处理、竞争假设诊断、Judge 评审、报告与 HTML 均**未执行**，对应的 CP-2 ~ CP-9 门禁全部状态为 `NOT_RUN`。

**明确不输出**：评分、等级、趋势、SPC 判异、根因假设、工艺参数建议。零行数据上任何此类输出都只能是编造。

---

## 核心证据（数据审计）

### 1. 文件级实测（逐文件 sha256 + 行数）

| 文件 | 节点 | 物理量/单位 | 字节 | 数据行 |
|---|---|---|---:|---:|
| `dn-812822ad.csv` | dn-812822ad | 熔体压力 bar | 24 | **0** |
| `dn-0f7c8b75.csv` | dn-0f7c8b75 | 瓶坯温度 ℃ | 24 | **0** |
| `dn-767e0a6c.csv` | dn-767e0a6c | 环境温度 ℃ | 24 | **0** |
| `dn-f9ea1045.csv` | dn-f9ea1045 | 环境湿度 %RH | 24 | **0** |
| `dn-df726c9e.csv` | dn-df726c9e | 回读-吹气压力 bar | 24 | **0** |
| `dn-4ce0d6a1.csv` | dn-4ce0d6a1 | Modbus 熔体温度 ℃ | 24 | **0** |
| `dn-3d2dd37e.csv` | dn-3d2dd37e | 壁厚截面 16 点 mm | 30 | **0** |

6 个标量文件字节数与 sha256 **完全一致**（均为 `b005417b…342b`，即字符串 `ts_iso,ts_ms,value,state` 的哈希）；向量文件为 `ts_iso,ts_ms,point_index,value`。这证明文件仅含表头，且 6 个标量文件的表头逐字节相同——不存在"某个文件被截断"的可能，是整批导出空洞。

### 2. 分析与处置证据

- `node .claude/analysis-auto/scripts/inspect.mjs dn-812822ad.csv` → `File has no data rows`
- `data_preprocessor.py --data-path <snapshot dir>` → `status: no_tabular_data`，`tables_found: 0`，`selected_table: null`，7 个 CSV 全部处置为 `excluded_from_scoring`
- manifest 自报 `totals: {files: 6, rows: 0}`，且每个节点 `value_range_observed: null`、`state_summary: {}`

### 3. 对照实验：排除工具链故障

在**已填充的兄弟导出**（`exp-daqexp-20261031032954-62e508/dn-7bbe981e.csv`）上执行同一条 `inspect.mjs` 代码路径，读到 **3354 行 × 4 列**，时间列 `ts_iso` 正常解析。结论：解析器、Python venv、Node 脚本链路均可用；**失败点是数据为空**。

> 对照数据不属于本产线对象，仅用于证明工具链可用，**不得**用于本线任何结论。

### 4. 数据不存在的确认（不是路径错）

- 同 `export_id` 全盘检索：仅命中 `manifest.json` 与既往运行记录，无任何数据副本
- 检索包含窗口起始 `ts_ms=1793502222251` 的文件：无命中
- 检索任何 `*a9e9f7*` 目录或 `nodes/` 目录（manifest 的 `file` 字段实际指向 `nodes/xxx.csv`）：无命中

即：本地环境中该导出**不存在任何原始测点副本**，不是"文件放错目录"。

---

## 诊断结论

**无诊断结论**。零实测值下，四条件判别（时间先行 + 统计显著 + 物理机理 + 无矛盾）无一可评估，任何根因陈述都属于无证据推断。

- 诊断类型：`null`
- 置信度：`null`
- 判定：`NOT_ASSESSABLE`，`reason_code = EMPTY_EXPORT`

## 证据全景

| 证据等级 | 内容 | 状态 |
|---|---|---|
| L0 数据存在性 | 7 个 CSV 全部 0 数据行；manifest 自报 0 行 | **已证实** |
| L0 工具链 | 兄弟导出 3354 行读取成功 | **已证实（对照）** |
| L1 数值统计 | 均值/方差/漂移/相关性 | 不可计算 |
| L2 时序结构 | 变化点、CCF、Granger | 不可计算 |
| L3 物理机理 | 温度-压力黏度耦合验证 | 不可验证 |
| L4 视觉 | 趋势图 / 壁厚截面云图 | 不可绘制 |

## 竞争假设（排除逻辑）

未进入假设竞争阶段。此处严格说明为何**不能**降级为"假设列表"：

- 若列"滤网堵塞导致熔体压力突升"这类假设，需要压力序列支持时间先行与显著性检验——**无数据**；
- 若列"采集网关掉线"作为解释，它只能解释数据为空，不能解释产线状态；而导出侧（仅写表头）与采集侧（节点无数据）两种成因**当前证据无法区分**，正是本管线定义的 `NEEDS_DATA` 情形。

因此按协议输出：**`NEEDS_DATA`**，而非强行选一个候选。

## 详细推导（推理过程）

1. 任务要求对 7 节点 × 60 分钟窗口做深度根因诊断 → 前提是窗口内存在实测时序。
2. Step 0.5 数据源无关性门禁解析目录：7 个 CSV 均被判 `no_tabular`（表头之外无行）→ `no_tabular_data`。
3. 协议明令：`no_tabular_data` → 停止并向用户报告审计，不进入 Step 2+。
4. 交叉验证三次：`inspect.mjs` 直接读单文件（无行）、`manifest.totals.rows`（0）、全盘检索原始副本（无命中）。
5. 对照实验排除工具链问题 → 归因锁定为**导出为空**。
6. 结论：`NOT_ASSESSABLE / EMPTY_EXPORT`，评分与根因一律 `null`。

## 推理链

```
窗口声明 60min × 7 节点
  → 期望健康行数 1s 节点 3600 / 2s 节点 1800（实测 0）
  → 解析层：header-only，0 行
  → 门禁层：preprocessing = no_tabular_data（阻断）
  → 归因层：工具链对照通过 ⇒ 数据为空，非管线故障
  → 输出层：NOT_ASSESSABLE，禁止 score/grade/findings/trends/spc
```

## 统计（数据统计）

| 指标 | 值 |
|---|---|
| CSV 文件数 | 7 |
| 总数据行 | 0 |
| 可用时序表 | 0 |
| 期望健康行数（推算，`inferred: true`） | 6 个标量节点共 14400 行（2×3600 + 4×1800） |
| 缺失率 | 100% |
| 分析窗口 | 60 分钟 |

期望行数按"窗口时长 ÷ 采样间隔"推算，未计通信丢包与停机——因此它是**上限式健康基线**，不是严格应到行数。

## 行动方案（局限）

**建议按顺序执行（均属数据采集侧，非工艺侧）：**

1. **确认节点在线**：核查 `ln-5402968a` 的 7 个节点在 11:03–12:03 窗口内是否真正建立了采集会话（网关连接、Modbus 从站可达性、节点启用状态）。若节点从未上线，此窗口永久无法诊断，只能换窗口。
2. **确认导出逻辑**：manifest 中 `file` 字段指向 `nodes/dn-*.csv` 而实际文件平铺同级，且仅写表头——排查导出器是否在"节点无数据"时仍写出文件骨架。这是可修的导出缺陷。
3. **重新导出并自检**：重导该窗口，导出前逐文件断言 `data_rows > 0`；健康基线为 1s 节点 3600 行、2s 节点 1800 行。
4. **重跑管线**：数据补齐后调起同一 run 场景，Step 0.5 通过即可进入 Step 2 本体构建与后续全链路。

**局限与假设（本次审计的边界）：**

- 仅覆盖本地 `aw-snapshots` 快照与其可达的引用；若原始测点保存在未授权的远端存储（本环境后端 `/api/*` 需认证），本审计无法排除远端有数据。此为该结论的唯一未闭环风险。
- 对照实验只证明解析链路可用，**不**证明本产线任何工艺特征。
- 场景备注字段在 manifest 中为乱码（`IDD async ȫ������`），推断原文为"IDD async 全链路回归"——即本次调用本身是全链路回归测试，而非产线异常求诊。若属实，则"空导出"正是回归应当捕获的缺陷，本报告即为该缺陷的定位书。

---

## 门禁状态

| 门禁 | 状态 | 说明 |
|---|---|---|
| CP-1 输入 | PASS | `input_manifest.json` + `user_context.json` + schema 合法 `run_config.json` |
| Step 0.5 预处理 | **BLOCK** | `status = no_tabular_data`（协议停止点） |
| CP-2 本体 | NOT_RUN | 协议在 Step 0.5 即停止，未进入 Step 2 |
| CP-3 ~ CP-9 | NOT_RUN | 无数据可分析 |
| 增强（E0-E8） | SKIPPED | `policy = off`，且无基线可增强 |
