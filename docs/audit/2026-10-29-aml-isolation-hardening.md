# AML 产品隔离加固：分页标签过滤 + 采纳血缘闸 + 晋升新鲜度提示

- 日期:2026-10-29
- 结论:三处修复落地,单测 757/757,受影响真机套件回归通过。**发现并修复一个比预期更深的缺陷**:训练分页取数在 Timescale/分页路径上完全不过滤批次标签——此前"产品隔离"在 SQL 层只在 `queryTagged` 路径成立。

## 一、修复内容

### 1. queryTaggedPage 批次标签过滤(严重度最高)

**缺陷**:`fetchNodeSeries`(AML/过程模型训练取数)优先走 `queryTaggedPage`,但该接口(两个适配器同病)**只按时间窗翻页,不过滤 product/recipe/run**。后果:Timescale 部署上,数据集构建会把 run 窗口内的**全部样本**当目标批次——产品隔离退化为"时间窗推断",正是隔离三元组要防的串味;若 line-run 登记与实际打标有偏差,训练数据即被污染。

**修复**:
- `tsdb-port.ts`:`TsdbPageQuery` 增加可选 `lineId/productId/recipeId/runId`;提供任一即**等值过滤**(等值天然排除未打标 NULL 行);全留空 = 纯时间窗原始分页(可用性水位等全量观测语义不变)。
- `timescale.adapter.ts` / `sqlite.adapter.ts`:全静态参数化 SQL(`$4..$7 NULL 即不过滤`),无字符串拼接(Mimosa 过闸)。
- `dataset-builder.ts fetchNodeSeries`:分页调用**必须携带三元组+runId**,与 `queryTagged` 退化路径语义等价。
- 连带收益:`process-model/context.ts` 运行时上下文取数(同一函数)现在也按 product/recipe 过滤——求解上下文不会再混入切换产品前后的旧样本。

**测试**:`tests/tsdb-tagged-page.test.ts` 7 条(等值过滤/跨批排除/lineId 含双批/全空原始窗/游标无漏无重/过滤+分页组合/三元组透传),`multiexpert-p1-storage` 桩更新后 6/6。

### 2. Profile 采纳血缘一致性闸(fail-closed)

`proposeProfileAdoption` 此前只查模型存在与 D21 工件兼容,不校验模型训练数据归属。新增(`profile-adopt.service.ts`):

- 解析 Profile 的 `processSpecRef`(与求解同语义)取场景三元组;
- 模型数据集缺失 → 422 `MODEL_LINEAGE_MISSING`;
- 训练产线 ≠ 场景产线 → 422 `MODEL_LINE_MISMATCH`;
- 训练 (product, recipe) ≠ 场景 (product, recipe) → 422 `MODEL_PRODUCT_MISMATCH`(防串味最后一道结构闸)。

**测试**:`optimizer-profile-adopt` 新增 2 条(跨产品 422 不产生草稿 / 跨产线 422),原 9 条全过(规格夹具 `pms-adopt@1` 补齐)。

### 3. 生产晋升新鲜度提示(非阻断)

`transitionModel` 晋升 production 时,若**训练数据集构建时间早于配方当前版本最后一次变更**,返回 `warnings`(`aml_job_tools` 晋升回执以 ⚠ 前缀透出,REST promote 同样返回)。不拦晋升——由 lead 判断是否用新版本批次重训。符合"版本语义大改需重训"的生产纪律,又不给换型流程加硬门。

## 二、标签完整性现状(核实结论)

打标写入语义本就正确(`tsdb-row.ts`):`lineId`=节点配置事实恒写;`product/recipe/run` 只在活动批次窗口写入(**不伪造批次语义**——未开线时段样本留空是对的)。训练侧的保证是:**数据集构建只走打标查询**,本轮把分页路径也拉齐到同一语义后,"未打标数据进训练"在两条路径上都被结构性排除。

## 三、验证

- 单测 **757/757**(新增 7+2 条;http-drivers 一次并发抖动复跑即绿);
- typecheck / lint 过;
- 真机回归:优化器 live 105/105、模型闭环 live 54/54(数据集构建+采纳链路全走新分页语义)。

## 四、残留边界

- 求解运行时上下文(`process-model/context.ts`)现按 product/recipe 过滤,但不带 runId(运行中窗口跨 run 未知)——同产品连批场景可接受,若未来要求单 run 上下文需再收。
- 配方版本隔离仍到 recipe_id 粒度(版本维度靠本提示 + 重训纪律),与本报告第 3 节配套。
