# Memory Graph 检索基准（固定夹具）

测试：`tests/memory-graph-bench.test.ts`
日期：2026-11-27

## 夹具

- 28 条频道 semantic 记忆：4 条桥接事实（packpress/thickness、coolflow/yieldrate、packpress/coolflow、moldtemperature/thickness）+ 12 条 packpress 干扰 + 12 条 yieldrate 干扰（干扰项重复目标词，压低纯 FTS 名次）。
- 6 查询：3 单跳（packpress thickness / coolflow yieldrate / moldtemperature thickness），3 多跳（packpress yieldrate / coolflow thickness / packpress coolflow）。
- 对照：纯 FTS（`repo.search` bm25 前 20）；混合：FTS + 图谱 memoryScores 的 RRF（graph 权重 0.8）。

## 判定

- 单跳：6 条查询中 3 条单跳的真值必须在混合 top5（不回退）。
- 多跳：至少 1 条查询因图谱扩展改善名次/进入 top5。
- 图阶段：`graphRetrieve` 单次 ≤75ms（超时 recall 会跳过图阶段）。
- 混合召回命中数不得低于基线。

## 结果

`memory-graph-bench.test.ts` PASS（2026-11-27，Node 24 / tsx）：
- 单跳 3/3 在混合 top5；
- 多跳至少 1 条改善；
- 图阶段最大耗时 <75ms（夹具规模 28 记忆 / 数十实体·边）。

## 解释与边界

- 这是**固定夹具**的可复现门禁，不代表真实产线绝对收益；真实收益需两周试点（见主计划 §13）。
- 无 embedding provider 时只用 FTS + 图谱；配置 `memory.embed_*` 后向量分支参与 RRF。
- 图检索只在实体种子命中时生效；无种子时退化 FTS/向量，不制造图结果。
