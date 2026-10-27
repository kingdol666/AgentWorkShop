---
title: 数据管理台与 EDA 工坊
description: /data 镜像·MES·台账与 /studio 图表·管道·看板·golden/FDC/SPC/OCAP/VM 的用法与数据边界。
---

# 数据管理台与 EDA 工坊(/data · /studio)

> v0.7.70 起随平台发布。两块数据面共用同一套[产线级权限](./line-permissions):
> 图表不是数据代理,取数永远回到服务端鉴权的查询链路。

- **/data 数据管理台**——看数据:产线维度的实时镜像、MES 接口与导出/批次台账;
- **/studio EDA 工坊**——用数据:图表、管道后处理、栅格看板与一组企业级 EDA 分析器。

## 数据管理台(/data)

三个页签,全部按产线过滤:

| 页签 | 内容 |
| --- | --- |
| 镜像数据 | 按产线 + 时间窗(近 15 分钟 / 1 小时 / 4 小时 / 自定义)+ 聚合口径浏览 WS 实时镜像;标量、数组断面、CCD 图像三种数据形态同台呈现 |
| MES 接口 | MES 控制台:接口报文与回执的产线维度视图 |
| 台账 | 批量导出作业台账:每次导出生成 manifest + merged.csv,作业状态可追踪 |

## EDA 工坊(/studio)

### 图表、模板与看板

- 图表类型七种:`trend / bar / scatter / table / kpi / histogram / pipeline`(kpi 与 table 为单序列约束);
- 可见性两档:`private`(仅 owner)与 `line`(绑定产线,按产线权限判读);
- 模板把一组查询配置存为可复用资产,看板(/studio/board)以栅格把图表组成产线驾驶舱;
- 看板卡片按图表实时取数渲染;pipeline 快照图表在看板中**只读回放**。

### golden 相位参考

以历史良好批次生成 0–100% 相位轴上的参考画像,当前批次叠加比对并输出偏差分——
「这一批跑得像不像金样本」直接给数。

### FDC / SPC / OCAP / VM

| 分析器 | 做什么 |
| --- | --- |
| FDC 特征参考带 | 对批次提取特征并按参考带判定,后台作业化(run + jobs 查询) |
| SPC 控制图 | Nelson 1–8 判异 / I-MR / EWMA / CUSUM,支持重算 |
| 共性分析 | 跨批次共性因子检索 |
| OCAP 处置单 | 超限后的处置流转记录 |
| 虚拟量测(VM) | 以模型预测质量值,OOD(分布外)直接拒判,不硬给数 |
| 派生数据集 | 把清洗/聚合结果固化为新数据集供后续分析引用 |

批次/run 还支持标注(labels),为上述分析提供「好批 / 坏批」的人工锚点。

### 管道图表(/studio/pipeline)

管道图表把「取数 → 代码后处理 → 绘图」连成一步:

1. **在线拉数**(走 `/daq/query` 同一鉴权)或 **CSV 导入**;
2. **代码后处理**:在浏览器里写变换代码(过滤、派生列、重采样);
3. **绘图与在线查看器**:ECharts 渲染,查看器支持缩放与 PNG 导出;
4. **保存**:存为模板(只存配置),或存为 **pipeline 快照图表**(见下节 B4 边界)。

## B4:图表存参数,不存数据

普通图表只保存**查询参数**(节点、时间窗、聚合……),每次打开按 `/daq/query`
的同一鉴权重新取数——不复制数据、不绕过产线权限。

唯一例外是 **pipeline 快照**,这是显式设计的受控通道:

- 仅 `private` 可见,且必须携带 `line_id` 并与图表一致;
- `options` 中的 `rows` 是客户端提供的保存视图,**最多 2000 行**;
- 读取仍走图表的 owner / line 可见性;Studio 中快照带只读徽章,不允许覆盖保存;
- 非 pipeline 图表的 `options` 只允许 `template` 一类配置引用——携带其他数据/扩展键直接 400。

## REST 与 Agent 面

工坊全部能力暴露为 `/api/workshop/eda/**` REST 面(charts / dashboards / templates /
golden / features / spc / ocap / commonality / vm / derived / run-segments / runs);
Agent 侧则通过 `daq_query` / `daq_export` 等数据工具读同一数据面,引用(节点、产线、批次)
过统一预检(tool-verify:参数形状 + 引用归属面)。

## 验收

- 端到端:`scripts/e2e-eda-pipeline.mjs`,24/24 通过,含 B4 负例
  (非 pipeline 图表携带数据键 → 400;快照 `line_id` 错配 → 400;缺 rows → 400);
- 单元:`tests/chart-pipeline.test.ts`(拉数结果归行、双形态点位兼容)。
