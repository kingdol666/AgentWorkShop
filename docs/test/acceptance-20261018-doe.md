# 数据分析 + DOE 参数闭环集成测试报告（2026-10-18）

> 目标：最新 IDD + RAG 系统启动 → 真实 DOE 参数实验 → 数据落盘文件夹 → IDD 场景化异步分析 → 结果存系统台账 → RAG 入库/检索 → DOE 推荐参数闭环下发与响应实测。
> 环境：平台 v0.7.65（3001）· PLC 模拟器 4036（injection-line）· IDD 最新代码（3210，含 external task manager 提交）· RAG 后端 8771 + web 6789（ClaudeGPT 树，最新）· 产线 `ln-dd4d6163` · 频道 `bab03588…`
> 结论：**全链真实跑通**——DOE 实验（2×2+中心点）→ 数据集落盘（7 CSV，5382 行）→ IDD 异步 doe-analysis（31 分钟，185 行 DOE 表）→ 台账留痕 `ar-881ee996` → RAG 入库+检索命中 → v4 配方 HITL 下发（SP 回读 51/240）→ 制品重量响应 31.507→31.564g。

---

## 一、系统启动（最新代码）

| 组件 | 动作 | 结果 |
| --- | --- | --- |
| IDD 后端/前端/RAG 引擎 | 停旧栈（`ind-diag stop --all`）→ `npm start`（最新提交：external task manager 任务生命周期/进度轮询/结果文件路径） | 3210 healthy；自带 RAG 检索引擎 8764 healthy |
| RAG 后端 | 停 10-16 旧进程 → ClaudeGPT 树 `.venv python main.py` | 8771 healthy |
| RAG web | 停旧进程 → `npm run dev`（server.mjs，端口 6789） | 200，21 个知识库目录可见 |
| 插件连通性 | rag-bridge / diag-bridge health | 双绿：后端 healthy、web ok、**token accepted=true**、kb aw-industrial 在册、IDD remote ok |
| 平台/产线 | 3001 沿用（含 10-16 通知护栏修复构建）；线/配方 v3/频道/数采总控（66 节点在线）在册 | 样本新鲜（30s 桶 12-14 点） |

## 二、DOE 参数实验（真实写穿）

协议：2 因子 × 2 水平 + 中心点，每条件驻留 4 分钟；同节点步进 ≥66s（写间隔治理），每步回读校验。

| 条件 | 保压 A(bar) | 机筒一区 B(℃) | 写回读 | 制品重量均值(g, 末 90s) |
| --- | --- | --- | --- | --- |
| C1 基线 | 45 | 240 | — | 31.234 (n=17) |
| C2 | 51 | 240 | 45→48→51 均一致 | **31.554 (n=17) 最优** |
| C3 | 51 | 250 | 240→245→250 均一致 | 31.542 (n=17) |
| C4 | 45 | 250 | 51→48→45 均一致 | 31.213 (n=17) |
| C5 中心 | 48 | 245 | 均一致 | 31.391 (n=18) |

- 10 次阶跃写入全部回读一致；实验窗 09:52–10:24（协议落盘 `tmp-e2e/_doe-protocol-20261018.json`）。
- 开线请求被既有批次 rr-93e6ee43 拦截（`CONFLICT: 请先停止当前数据采集`）——**一线一活跃批次守卫按设计工作**；样本已带该批次打标，不影响实验与导出。

## 三、数据落盘（文件夹证据）

- 工具：`daq_export`（分析师，line_id + 实验窗）→ `daqexp-20261018102646-fc7c64`
- 目录：`.AgentWorkShop/data/daq-exports/daqexp-20261018102646-fc7c64/`
  - `manifest.json`（7 节点映射/单位/量程/语义，含 runId/配方版本）
  - `nodes/` 7 个节点 CSV：928 行 ×5 + 371 行 ×2 = **5382 行**
  - `frames/`（向量/图像帧面，本线标量无帧）
- 导出即 IDD 多文件分析输入（manifest + 全节点 CSV）。

## 四、IDD 场景化异步分析（doe-analysis）

- `diag_run(export_id, analysis_intent='doe-analysis', mode='async')` **1.66s 受理即返** run `093c38c0`；
- 后台真实执行 **31 分钟**（02:26:48→02:57:34），期间 diag_status 持续可见 running，结束后显式 completed；
- 报告（industrial-doe-analyzer，designed/full_factorial，证据等级 A）：自建 **00_input/doe_table.csv（185 行 = 5 条件 × 37 制品）**；
  - 主效应：**保压压力→制品重量 Pareto 第 1（partial η²=0.919，+0.05241 g/bar，q≈9×10⁻¹⁰⁰）**；机筒温度→熔体温度 η²=0.967；A×B 对重量不显著（q=0.841），曲率不显著；
  - **推荐窗口：保压 50.25–51.0 bar（51 为设计边界/外推，需工艺确认），温度 240–250℃**；
  - 诚实披露：每条件一次运行（37 制品为伪重复，p/q 偏乐观）、顺序未随机化、成型周期零方差无法给效率代价；下游 `recommendations.json` 合同化输出。

## 五、结果存系统（analysis_reports 台账）

- `analysis_save` 留痕 **`ar-881ee996`**（分类 DOE分析，绑定线/配方 v3/实验窗，metrics 含 runId/exportId/各条件水平）；
- `analysis_query(report_id)` 回读全文 ✅；`analysis_query(line_id)` 按线列表命中 ✅。

## 六、RAG 查询与入库

- `kb_agent(async)` 入库 DOE 报告（读取 IDD 报告文件全文）→ task `kbt_mvd8jioq_ae51bc55` **完成**；
- 检索面双证：rag-bridge `/search` 直查 **48 条命中**；`kb_agent(sync)` 检索命中 DOE 条目 ✅。

## 七、DOE 推荐参数闭环下发（治理链）

- 定量选优（平台 TSDB 独立计算）：C2（保压 51/机筒 240）最优 → `recipe_update` → **v4 固化**（服务端成功；客户端 invoke 回包超时丢帧，以版本史 v4 + 参数 51/240 为准）；
- `recipe_apply`（在飞 HITL 并行批准，附言"批准下发 DOE 最优工况 C2"）→ 整批下发 → **设备回读证实：保压 51 / 机筒 240**；
- 响应实测：制品重量 31.507 → **31.564 g**（C2 窗实测 31.554g，方向一致）。

## 八、过程中的发现（如实记录）

1. **活 Agent 自动唤醒**：diag 完成回执投递频道信箱触发空闲唤醒，频道工艺工程师自主跑了一次 trial（rr-10518，保压 48→50.25）并提交固化申请（50.25bar）——异步回执→唤醒→自主作业链路是活的；测试收线时人工拒绝了该提案（保持脚本确定性），并轮询到 pending=0。
2. **HITL 卡创建延迟**：与活 Agent 并发时 recipe_update 的卡创建被配方门串行化到 ~5.5 分钟，脚本 150s 认领窗口过短导致 invoke 客户端超时——产品行为正确（服务端 v4 已落），测试脚本需 240-300s 窗口（已修）。
3. **导出目录布局**：`manifest.json + nodes/*.csv + frames/`（脚本初版断言只扫顶层，已修正）。
4. 一线一活跃批次守卫、写间隔治理、HITL 附言回流、版本非破坏递增（v3→v4）均在真实链路中生效。

## 九、复现入口

- `tmp-e2e/doe-experiment-20261018.mjs`（实验+协议）
- `tmp-e2e/doe-chain-20261018.mjs`（导出/分析/台账/RAG/闭环；E1b 断言已按 nodes/ 布局修正）
- `tmp-e2e/doe-closure-20261018.mjs`（v4 下发 + 响应实测）
- 关键 id：`daqexp-20261018102646-fc7c64` · run `093c38c0` · `ar-881ee996` · kb task `kbt_mvd8jioq_ae51bc55` · 配方 v4
