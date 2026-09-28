# v0.7.52 全局包全功能验收(模拟器+mock,无 LLM 额度) — 2026-09-29

## 环境

- 被测对象:**npm 全局安装的 agentworkshop@0.7.52**(发布产物,非 repo 检出),实例 3460,AW_HOME=global-home
- PLC 模拟器 4010(injection/wwtp/anneal 三引擎);rag-knowledge web 6789 + 后端 8770(既存)
- 模拟 IDD 服务:`.e2e-tmp/mock-idd.mjs`(3210,实现 diag-bridge 依赖的最小任务面)
- harness 一律 mock/无 LLM(omp 无额度)

## 验收结果

| # | 项 | 结果 | 证据 |
|---|---|---|---|
| 1 | 三场景产线供给+开跑 | ✅ | injection-g52(11DCW+14DAQ)/wwtp-g52(7+13)/anneal-g52(7+12) 全部运行,打标 1369/1327/1190 |
| 2 | DAQ 获取 | ✅ | 39/39 节点、4552 样本;三场景 PV 读取全通(31.32g/0.22mg/L/134.6HV=场景起点工况) |
| 3 | 数据参数下发 | ✅ | 三场景治理写控全绿:保压 47bar/风机 26.5Hz/三区 732℃——回读校验+anchorId 入册(stepLimit 1.8/0.6/5 逐场景尊重) |
| 4 | 知识库入库 | ✅ | web `documents/create` 200(success),docId=27864884(带唯一标记 g52验收-*) |
| 5 | 知识库检索 | ✅(降级口径) | 文档清单检索命中✓;two-stage 引擎 0 命中(后端索引态问题,旧文档同样 0 命中,与平台无关,如实记录) |
| 6 | 数据诊断(模拟 IDD) | ⚠️ 受阻 | 模拟 IDD 服务已就绪(3210,health=healthy);diag-bridge health/路由✓;**自动派发未能在验收窗内触发**——当晚进程清理器连续击杀实例(MQTT 重连风暴+会话修复失败),长观察窗不可得。派发链路(diag_run 工具/sweep 轮询/快照上传)的契约面已逐行核对并实现于模拟服务 |
| 7 | AML 集成 | ✅(核心链) | 数据集构建✓(隔离三元组+byRun,ds-mul7n4mz)→ 作业编排✓ → **真实 torch 训练+ONNX 导出✓**(loss 0.0005,artifacts/model.onnx 落盘)→ 评估阶段「test 切分为空」=byRun 需 ≥2 已完结批次(数据量条件;补批尝试被进程击杀截断) |
| 8 | mock 闭环 | ✅ | [mock:complex] 根任务→委派→子任务→父收口 COMPLETED |
| 9 | UI 交互 | ✅ | 登录/产线运营三线卡片/数采中心实时/产线详情写控表格(含 Δ≤限幅徽章)真实截图验收 |

## 发现的问题(如实)

1. **插件 settings 热应用在包模式 home 下不生效**:`plugins.rag-bridge.token` 经设置 PATCH 正确落盘(override 文件确认),但插件 ctx.config.get 读不到(疑似插件命名空间键未进插件 host 启动时的 effective 快照,热更新订阅亦未覆盖);kv 回退文件(kb.token)同样未生效——**待修复候选**。验收期间 KB 走直连 web/后端 REST(带 token)完成全功能验证,不受阻。
2. **AML 单批次评估**:byRun 切分需 ≥2 已完结批次,单批次评估直接失败(可给出更友好指引+自动补批建议)。
3. **环境**:当晚存在针对 node 进程的周期性清理(计划任务独立启动亦被杀,伴随 MQTT 重连风暴/OPC UA 会话修复失败),diag 自动派发与 AML 补批评估的观察窗被截断——非产品缺陷。

## 复现要点

```bash
npm i -g agentworkshop@0.7.52
AW_HOME=<test-home> aw start --port 3460
# 场景供给/写控/数采:bench/lib/scenarios.mjs(ensureScenarioLine+provisionScenarioLine)
# KB:web /api/kb/documents/create(token)→ backend /api/v1/search/two-stage → documents 清单兜底
# 模拟 IDD:.e2e-tmp/mock-idd.mjs(3210)
# AML:停线闭批 → aml/datasets → aml/jobs(inline code 走 amlkit 契约,须产出 model.onnx)
```
