# EDA 数据层全功能实机演示报告

日期：2026-10-21 · 环境：隔离实例 `3470`（`AW_HOME=aw-scenario-suite-VZMjFC`）+ PLC 模拟器 `4050`（五协议注塑预设）· 产线 `ln-bb1192ff`（14 DAQ + 11 DCW 节点）
脚本：`scripts/eda-live-demo.mjs` · 证据：`docs/audit/evidence/2026-10-21-eda-demo/`（7 张截图 PNG + demo-evidence.json）
**结果：24/24 PASS**（US-101 节点连接与镜像采集 / US-102 实时展示 / US-103 复合查询与导出 / US-104 EDA 分析链；US-102/104 的 UI 论据为**渲染产物断言**——轮廓 polyline 上屏、图像 contentUrl 上屏、golden 叠加无报错、看板栅格卡渲染——而非仅截图存在）

---

## 1. 节点连接与镜像采集（标量 + 数组 + 图像 三形态）

- 五协议设备（modbus-tcp / modbus-rtu / opcua / mqtt / http）全部 running；停/开线后标量镜像采样活性探针 50 点。
- 三形态节点：标量（温度/压力/克重等 14 个）+ **向量**「EDA演示-膜厚断面」（thickness-scan 模板，48 点膜厚断面）+ **图像**「EDA演示-CCD图像」（ccd-image 模板）。

## 2. 多源异构数据的入库与实时镜像

- **外部系统推送入库**（`POST /api/workshop/daq/:id/ingest`，与网关采样同队列/打标/告警链路）：48 点数组帧 `accepted` ✓、base64 图像帧 `accepted` ✓。
- **实时镜像活性**：推送驱动的帧数持续增长（向量 2→3、图像 2→3）；mock 采样器同时以 60s 周期自发 64 点合成断面帧——外部 48 点帧与自发 64 点帧在帧列表中**可区分**（D1.6）。
- 图像像素不入 LLM：帧接口返回 `contentUrl`（鉴权流式），对象存储降级时落本地 `data/daq-objects/`。

## 3. 多字段复合查询（4 组合实测）

| 组合 | 字段 | 结果 |
|---|---|---|
| ① 线+节点+时间窗+桶+聚合 | `line_id + node_ids×2 + from/to + bucket_ms + agg=avg` |  2 序列 151/151 点 ✓ |
| ② +批次打标 | `+ run_id` | 只取该批次样本 ✓ |
| ③ +配方打标 | `+ recipe_id` |  301 点 ✓ |
| ④ +min/max 包络 | `+ include_band=1` |  band 151 ✓ |

## 4. 数据拉取/导出

- REST 导出（merge）：ready，564 行（不含表头），manifest.json + nodes/*.csv + **merged.csv 多参数对齐宽表**。
- 帧导出（`daq_export` Agent 工具）：**向量长表 CSV**（`frames/<node>.csv`：ts_iso,ts_ms,point_index,value）+ **图像原文件目录**（3 个 PNG）。
- 打标语义：导出走 run 窗口时只含该批次样本（复合②与 E1 打标链路交叉验证）。

## 5. EDA 分析链

- 关账批（203 样本）→ 特征仓库 12 行（cnt/mean/std/min/max/slope 全字段，D4.3）。
- SPC 控制图注册 + 重算（n=14，冷启动 enabled=false 为正确语义）。
- golden 参考轨迹：20 桶画像 + 指纹（mean 15.3 / cnt 183）生成成功。
- 分析报告台账：场景 S7 `analysis_save`/`analysis_query` 通过（ar- 台账可检索）。

## 6. 实机演示截图（论据；每张截图的渲染产物均有 DOM 断言背书）

### 6.1 数据管理台：批量查询与实时展示（预览表列=所选节点，多序列经 /studio 与看板展示）
![数据管理台查询](evidence/2026-10-21-eda-demo/demo-1-data-query.png)

### 6.2 数据管理台：导出任务 + 批次台账
![台账](evidence/2026-10-21-eda-demo/demo-2-data-ledger.png)

> 本报告 §3/§4/§5/§7 的数字由 `scripts/eda-demo-report-patch.mjs` 从最终 `demo-evidence.json` 自动同步，消除手抄漂移。

### 6.3 /daq 标量节点：实时镜像详情
![标量实时](evidence/2026-10-21-eda-demo/demo-3-daq-scalar-live.png)

### 6.4 /daq 数组节点（膜厚断面）：轮廓 polyline 渲染（WS 实时帧到达，polylines=1）
![数组帧](evidence/2026-10-21-eda-demo/demo-4-daq-vector-frames.png)

### 6.5 /daq 图像节点（CCD）：页面打开状态下实时推送→contentUrl 图像即时上屏（imgs=1, viaWs=true）
![图像帧](evidence/2026-10-21-eda-demo/demo-5-daq-image-frames.png)

### 6.6 EDA 工坊：图表分析 + golden 叠加（叠加数据请求 200、无错误横幅；golden 节点按全名精确匹配）
![studio 分析](evidence/2026-10-21-eda-demo/demo-6-studio-analysis.png)

### 6.7 EDA 看板：栅格卡内嵌图表渲染（cells=1）
![看板](evidence/2026-10-21-eda-demo/demo-7-studio-board.png)

## 7. 断言明细（24/24）

D0.1 三形态节点在位 · D1.1 标量采集活性(50 点) · D1.2/D1.3 数组/图像帧活性(2→3) · D1.4/D1.5 外推入库 accepted · D1.6 48 点帧可查回 · D2.1-2.4 复合查询四组合 · D3.1 merge 导出 · D3.2 帧导出 CSV+图像 · D3.3 产物存在 · D4.1 台账回填(203) · D4.2 特征 12 行 · D4.3 字段齐备 · D4.4 SPC 重算 · D4.5 golden 20 桶 · D5.1 截图 ≥6 · **D5.2 非空轮廓 polyline 渲染(页面打开推送→WS 上屏) · D5.3 图像 contentUrl 上屏(viaWs=true) · D5.4 golden 叠加数据请求 200+无错误横幅 · D5.5 看板栅格卡渲染**。

## 8. 边界（如实）

1. 注塑预设的 wall-profile/surface-image 原生节点为**标量模板**；数组/图像帧按平台设计由**外部系统经 ingest 推送**（等同产线上位机/检测设备对接方式），mock 采样器另以 60s 周期自发 64 点合成断面帧。
2. ingest 的自定义 metrics 会被派生统计（avg/max）覆写，外部帧以**点数(48 vs 64)**区分。
3. SPC 处于冷启动（n=14 < 25，enabled=false 为正确语义）；golden 取自样本最多的关账批。
4. 图像为 1×1 PNG（演示用最小载荷）；真实 CCD 帧的画面内容取决于外部设备。
