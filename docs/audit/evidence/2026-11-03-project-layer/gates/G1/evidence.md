# G1 — Schema/迁移/Repo（unit 全量）

> 生成时间：2026-11-04T08:28:01.318Z
# G1 — Schema/迁移/Repo（unit 全量）

> 生成时间：2026-11-04T08:20:42.036Z
# G1 — Schema/迁移/Repo（unit 全量）

> 生成时间：2026-11-04T07:14:11.474Z
# G1 — Schema/迁移/Repo（unit 全量）

> 生成时间：2026-11-04T07:04:42.027Z
# G1 — Schema/迁移/Repo（unit 全量）

> 生成时间：2026-11-04T06:58:30.305Z

## `npm run test:unit` — FAIL (0s, exit=1)

```
node:internal/modules/cjs/loader:1520
  throw err;
  ^

Error: Cannot find module 'D:\codes\ABO\AgentWorkShop-project\node_modules\npm\bin\npx-cli.js'
    at Module._resolveFilename (node:internal/modules/cjs/loader:1517:15)
    at wrapResolveFilename (node:internal/modules/cjs/loader:1071:27)
    at defaultResolveImplForCJSLoading (node:internal/modules/cjs/loader:1095:10)
    at resolveForCJSWithHooks (node:internal/modules/cjs/loader:1122:12)
    at Module._load (node:internal/modules/cjs/loader:1294:5)
    at wrapModuleLoad (node:internal/modules/cjs/loader:255:19)
    at Module.executeUserEntryPoint [as runMain] (node:internal/modules/run_main:154:5)
    at node:internal/main/run_main_module:33:47 {
  code: 'MODULE_NOT_FOUND',
  requireStack: []
}

Node.js v24.19.0
```

## `npm run test:unit` — PASS (31s, exit=0)

```
1 plugin=1 unavailable=0 total=122 (test-idempotent)"}
{"t":"2026-11-04T07:00:33.888Z","level":"info","scope":"workshop.tool-registry","msg":"synced builtin=121 plugin=1 unavailable=1 total=122 (test-unregister)"}
{"t":"2026-11-04T07:00:33.890Z","level":"info","scope":"workshop.plugin-tools","msg":"[omp-tools] 插件工具注册:「trp_plugin_echo」(trp-test-plugin)"}
{"t":"2026-11-04T07:00:33.920Z","level":"info","scope":"workshop.tool-registry","msg":"synced builtin=121 plugin=1 unavailable=0 total=122 (test-reregister)"}
{"t":"2026-11-04T07:00:34.142Z","level":"info","scope":"workshop.plugin-tools","msg":"[omp-tools] 插件工具注册:「report_progress」(trp-test-plugin)"}
{"t":"2026-11-04T07:00:34.145Z","level":"info","scope":"workshop.plugin-tools","msg":"[omp-tools] 插件工具注册:「trp_plugin_echo」(trp-test-plugin)"}
{"t":"2026-11-04T07:00:34.180Z","level":"info","scope":"workshop.tool-registry","msg":"synced builtin=121 plugin=1 unavailable=0 total=122 (test-cleanup)"}
✔ registry sync:幂等且 hash 未变不推进 updated_at (51.7082ms)
✔ registry sync:插件卸载后 available=0,重新注册恢复 (73.8493ms)
✔ all 模式:停用 daq_query 后注入面/执行闸门同时生效,重置恢复 (95.23ms)
✔ selected 模式:仅勾选工具注入,缺省即停用 (59.9156ms)
✔ 硬规则:observer 档位不能通过 Channel 选择打开写工具 (60.7649ms)
✔ 硬规则:worker 的 lead-only 工具记录 ROLE_DENIED,lead 正常 (2.1856ms)
✔ 透明化视图:全局目录含内置与插件工具,统计一致 (2.8811ms)
✔ 快照构建:插件同名内置时内置优先 (38.6073ms)
✔ 策略仓储:removeForChannel 清理策略与行 (41.7895ms)
✔ 折叠确定性:同一输入两次输出逐字节相同(乱序输入排序后一致) (1.0286ms)
✔ 预算:小绑定面不折叠;超预算折叠为前 N 项 + 总数 + 查询引导 (0.5404ms)
✔ 折叠回滚开关:AW_DESC_BUDGET=0 → 全量输出 (0.2636ms)
✔ 单条超预算:首项必须保留(不得产出空「等 N 项」折叠) (0.175ms)
✔ 分页:确定性排序(kind→id)、query 过滤、limit 钳制、offset 越界 (1.0267ms)
✔ user scenario: worker 绑 1 号节点、传 2 号节点(他线)→ 拒绝且文案列出绑定面 (2.7263ms)
✔ user scenario: 同线但未绑定的 2 号节点、且频道未绑线 → 同样拒绝(未绑定不等于可见) (0.3929ms)
✔ 绑定面内节点放行(node/line 引用均通过) (0.3526ms)
✔ 不存在的节点:拒绝文案与「未授权」区分(提示核对 id) (0.3236ms)
✔ 频道绑线只读扩权:绑线数采节点(未绑定)可读;他线节点仍拒 (0.5994ms)
✔ nodes[] 深路径与 arrays:aml_dataset_build 逐节点校验 (1.0548ms)
✔ 配方面:绑定配方可操作;他线配方(未绑定/不可读)拒 (0.4855ms)
✔ dcw_journal:无参(此前返回全量记录)与越界 node_id 均拒,越界文案列可查对象 (0.2903ms)
✔ 形状:引用参数非字符串 → 拒绝并说明应为字符串 ID (0.13ms)
✔ 授权性拒绝写入 audit_log(tool.call.denied),形状类拒绝不入册 (0.351ms)
✔ 链式:跨线数据集拒(谱系回溯到产线),本人数据集放行 (1.2357ms)
✔ 无引用参数的工具不受预检影响(my_industrial_nodes 原样进入 handler) (3.5448ms)
✔ resolveRefFaces:绑定面/可读线/配方面/频道绑线面一致 (0.1742ms)
✔ 契约:query() raw 路径时间正序(ASC),窗口超 limit 截取最旧段 (18.1434ms)
✔ 契约:query() bucket 路径时间正序(ASC) (8.7414ms)
✔ 导出:>5000 样本窗口游标续页取全(CSV 行数 == 样本数,不静默截断) (68.0861ms)
✔ 契约:limit<=0 不得变成 SQL 无上限(适配器夹到 1) (9.2943ms)
{"t":"2026-11-04T07:00:34.061Z","level":"info","scope":"daq.tsdb.sqlite","msg":"[daq-tsdb] 保留期清理 1 行(>720h)"}
✔ A15:queryTagged raw 返回真实 state;cleanPoints 实际剔除坏点 (3.0878ms)
✔ A16:同键不同值 → 首值保留且 correctionDropped+1(不静默) (0.9597ms)
✔ A1:逐节点分页稳定 ASC、游标续读、无漏无重 (2.0923ms)
✔ A16 ④:旧数据 ingestedAt 缺失 → 分页点不伪造到达时间 (0.4156ms)
✔ A16 ③:迟到但新鲜的样本不被事件时间误删 (23.0871ms)
✔ 保留期归一:非法值回退、raw 最小 1h、hour 允许 0(永久) (1.9339ms)
✔ 窗口在原始保留期内 → raw(即使桶宽 ≥1h) (0.6658ms)
✔ 窗口早于原始保留期 → 1 分钟聚合;跨边界 → mixed (1.1901ms)
✔ 完全落在旧窗口 + 桶宽 ≥1h → 1 小时聚合(且不 mixed) (0.1707ms)
✔ 桶宽 <1 分钟或聚合未启用 → 绝不用聚合冒充历史 (0.1296ms)
✔ 混合合并:按桶起点升序、同点 raw 优先、超限保留最新段 (0.3202ms)
✔ 运行期新建产线:无需重启即进入聚合与逐线裁剪 (6384.4642ms)
✔ 契约:按 productId 等值过滤,未打标行与异产品行都不出现 (48.7305ms)
✔ 契约:按 runId / recipeId 过滤各自只中目标批次 (16.3708ms)
✔ 契约:lineId 过滤含两个批次但排除未打标段 (1.751ms)
✔ 契约:全留空 = 原始时间窗(含未打标行),分页/游标语义不变 (2.4095ms)
✔ 契约:过滤 + 分页组合 = 只取目标批次的全部点(游标续读不串批) (2.5109ms)
✔ fetchNodeSeries(AML 训练取数)必须把三元组透传给分页接口 (233.8679ms)
✔ tail:桶窗口超 limit 时返回末尾 limit 个桶(升序) (49.2607ms)
✔ tail:桶数 ≤ limit 时原样全量返回(稀疏窗口不丢历史段) (16.6627ms)
✔ tail:桶间有空洞时仍取末尾 limit 个非空桶 (11.3343ms)
✔ tail:limit=1 返回窗口内最后一个桶(不是最旧) (10.6783ms)
✔ tail:多节点每节点各取末尾 limit 个(queryTaggedLatest) (11.2181ms)
✔ 旧契约不变:query() 默认仍取窗口最旧段(导出/训练集依赖) (7.9632ms)
✔ freshnessOf:返回最后一点的时间与滞后 (0.3318ms)
✔ tail:from 缺省(UI 趋势路径)也必须取最新段,不能退化为 epoch 级旧段 (160.5124ms)
✔ tail:limit=5000(适配器单次行数上限)仍能取到最新桶 (132.2585ms)
✔ tail:from 缺省 + 稀疏数据仍取末尾 limit 个非空桶 (14.4938ms)
ℹ tests 1076
ℹ suites 40
ℹ pass 1074
ℹ fail 0
ℹ cancelled 0
ℹ skipped 2
ℹ todo 0
ℹ duration_ms 30386.7649
```

## `npm run test:unit` — PASS (30s, exit=0)

```
21 plugin=1 unavailable=0 total=122 (test-idempotent)"}
{"t":"2026-11-04T07:09:54.467Z","level":"info","scope":"workshop.tool-registry","msg":"synced builtin=121 plugin=1 unavailable=1 total=122 (test-unregister)"}
{"t":"2026-11-04T07:09:54.468Z","level":"info","scope":"workshop.plugin-tools","msg":"[omp-tools] 插件工具注册:「trp_plugin_echo」(trp-test-plugin)"}
{"t":"2026-11-04T07:09:54.492Z","level":"info","scope":"workshop.tool-registry","msg":"synced builtin=121 plugin=1 unavailable=0 total=122 (test-reregister)"}
{"t":"2026-11-04T07:09:54.687Z","level":"info","scope":"workshop.plugin-tools","msg":"[omp-tools] 插件工具注册:「report_progress」(trp-test-plugin)"}
{"t":"2026-11-04T07:09:54.690Z","level":"info","scope":"workshop.plugin-tools","msg":"[omp-tools] 插件工具注册:「trp_plugin_echo」(trp-test-plugin)"}
{"t":"2026-11-04T07:09:54.725Z","level":"info","scope":"workshop.tool-registry","msg":"synced builtin=121 plugin=1 unavailable=0 total=122 (test-cleanup)"}
✔ registry sync:幂等且 hash 未变不推进 updated_at (49.4601ms)
✔ registry sync:插件卸载后 available=0,重新注册恢复 (62.1628ms)
✔ all 模式:停用 daq_query 后注入面/执行闸门同时生效,重置恢复 (83.8856ms)
✔ selected 模式:仅勾选工具注入,缺省即停用 (56.1382ms)
✔ 硬规则:observer 档位不能通过 Channel 选择打开写工具 (47.8825ms)
✔ 硬规则:worker 的 lead-only 工具记录 ROLE_DENIED,lead 正常 (2.108ms)
✔ 透明化视图:全局目录含内置与插件工具,统计一致 (3.0458ms)
✔ 快照构建:插件同名内置时内置优先 (38.3109ms)
✔ 策略仓储:removeForChannel 清理策略与行 (23.3302ms)
✔ 折叠确定性:同一输入两次输出逐字节相同(乱序输入排序后一致) (0.9873ms)
✔ 预算:小绑定面不折叠;超预算折叠为前 N 项 + 总数 + 查询引导 (0.6437ms)
✔ 折叠回滚开关:AW_DESC_BUDGET=0 → 全量输出 (0.2788ms)
✔ 单条超预算:首项必须保留(不得产出空「等 N 项」折叠) (0.1815ms)
✔ 分页:确定性排序(kind→id)、query 过滤、limit 钳制、offset 越界 (0.9026ms)
✔ user scenario: worker 绑 1 号节点、传 2 号节点(他线)→ 拒绝且文案列出绑定面 (3.4853ms)
✔ user scenario: 同线但未绑定的 2 号节点、且频道未绑线 → 同样拒绝(未绑定不等于可见) (0.9731ms)
✔ 绑定面内节点放行(node/line 引用均通过) (0.3515ms)
✔ 不存在的节点:拒绝文案与「未授权」区分(提示核对 id) (0.3346ms)
✔ 频道绑线只读扩权:绑线数采节点(未绑定)可读;他线节点仍拒 (0.4301ms)
✔ nodes[] 深路径与 arrays:aml_dataset_build 逐节点校验 (0.651ms)
✔ 配方面:绑定配方可操作;他线配方(未绑定/不可读)拒 (0.4427ms)
✔ dcw_journal:无参(此前返回全量记录)与越界 node_id 均拒,越界文案列可查对象 (0.4606ms)
✔ 形状:引用参数非字符串 → 拒绝并说明应为字符串 ID (0.181ms)
✔ 授权性拒绝写入 audit_log(tool.call.denied),形状类拒绝不入册 (0.4835ms)
✔ 链式:跨线数据集拒(谱系回溯到产线),本人数据集放行 (1.5885ms)
✔ 无引用参数的工具不受预检影响(my_industrial_nodes 原样进入 handler) (4.2068ms)
✔ resolveRefFaces:绑定面/可读线/配方面/频道绑线面一致 (0.2368ms)
✔ 契约:query() raw 路径时间正序(ASC),窗口超 limit 截取最旧段 (21.3316ms)
✔ 契约:query() bucket 路径时间正序(ASC) (13.8732ms)
✔ 导出:>5000 样本窗口游标续页取全(CSV 行数 == 样本数,不静默截断) (78.1918ms)
✔ 契约:limit<=0 不得变成 SQL 无上限(适配器夹到 1) (12.7464ms)
{"t":"2026-11-04T07:09:54.839Z","level":"info","scope":"daq.tsdb.sqlite","msg":"[daq-tsdb] 保留期清理 1 行(>720h)"}
✔ A15:queryTagged raw 返回真实 state;cleanPoints 实际剔除坏点 (2.4387ms)
✔ A16:同键不同值 → 首值保留且 correctionDropped+1(不静默) (0.854ms)
✔ A1:逐节点分页稳定 ASC、游标续读、无漏无重 (1.5386ms)
✔ A16 ④:旧数据 ingestedAt 缺失 → 分页点不伪造到达时间 (0.498ms)
✔ A16 ③:迟到但新鲜的样本不被事件时间误删 (32.8998ms)
✔ 保留期归一:非法值回退、raw 最小 1h、hour 允许 0(永久) (1.5345ms)
✔ 窗口在原始保留期内 → raw(即使桶宽 ≥1h) (0.2947ms)
✔ 窗口早于原始保留期 → 1 分钟聚合;跨边界 → mixed (1.1252ms)
✔ 完全落在旧窗口 + 桶宽 ≥1h → 1 小时聚合(且不 mixed) (0.1849ms)
✔ 桶宽 <1 分钟或聚合未启用 → 绝不用聚合冒充历史 (0.1394ms)
✔ 混合合并:按桶起点升序、同点 raw 优先、超限保留最新段 (0.2801ms)
✔ 运行期新建产线:无需重启即进入聚合与逐线裁剪 (6519.3384ms)
✔ 契约:按 productId 等值过滤,未打标行与异产品行都不出现 (42.6556ms)
✔ 契约:按 runId / recipeId 过滤各自只中目标批次 (15.4059ms)
✔ 契约:lineId 过滤含两个批次但排除未打标段 (1.927ms)
✔ 契约:全留空 = 原始时间窗(含未打标行),分页/游标语义不变 (2.2484ms)
✔ 契约:过滤 + 分页组合 = 只取目标批次的全部点(游标续读不串批) (3.0007ms)
✔ fetchNodeSeries(AML 训练取数)必须把三元组透传给分页接口 (201.1046ms)
✔ tail:桶窗口超 limit 时返回末尾 limit 个桶(升序) (45.9098ms)
✔ tail:桶数 ≤ limit 时原样全量返回(稀疏窗口不丢历史段) (18.4472ms)
✔ tail:桶间有空洞时仍取末尾 limit 个非空桶 (9.88ms)
✔ tail:limit=1 返回窗口内最后一个桶(不是最旧) (8.9393ms)
✔ tail:多节点每节点各取末尾 limit 个(queryTaggedLatest) (11.9304ms)
✔ 旧契约不变:query() 默认仍取窗口最旧段(导出/训练集依赖) (7.7007ms)
✔ freshnessOf:返回最后一点的时间与滞后 (0.3457ms)
✔ tail:from 缺省(UI 趋势路径)也必须取最新段,不能退化为 epoch 级旧段 (174.1196ms)
✔ tail:limit=5000(适配器单次行数上限)仍能取到最新桶 (136.8635ms)
✔ tail:from 缺省 + 稀疏数据仍取末尾 limit 个非空桶 (12.2846ms)
ℹ tests 1076
ℹ suites 40
ℹ pass 1074
ℹ fail 0
ℹ cancelled 0
ℹ skipped 2
ℹ todo 0
ℹ duration_ms 29272.7315
```

## `npm run test:unit` — PASS (34s, exit=0) [retry]

```
1 plugin=1 unavailable=0 total=122 (test-idempotent)"}
{"t":"2026-11-04T08:20:22.981Z","level":"info","scope":"workshop.tool-registry","msg":"synced builtin=121 plugin=1 unavailable=1 total=122 (test-unregister)"}
{"t":"2026-11-04T08:20:22.982Z","level":"info","scope":"workshop.plugin-tools","msg":"[omp-tools] 插件工具注册:「trp_plugin_echo」(trp-test-plugin)"}
{"t":"2026-11-04T08:20:23.009Z","level":"info","scope":"workshop.tool-registry","msg":"synced builtin=121 plugin=1 unavailable=0 total=122 (test-reregister)"}
{"t":"2026-11-04T08:20:23.169Z","level":"info","scope":"workshop.plugin-tools","msg":"[omp-tools] 插件工具注册:「report_progress」(trp-test-plugin)"}
{"t":"2026-11-04T08:20:23.172Z","level":"info","scope":"workshop.plugin-tools","msg":"[omp-tools] 插件工具注册:「trp_plugin_echo」(trp-test-plugin)"}
{"t":"2026-11-04T08:20:23.191Z","level":"info","scope":"workshop.tool-registry","msg":"synced builtin=121 plugin=1 unavailable=0 total=122 (test-cleanup)"}
✔ registry sync:幂等且 hash 未变不推进 updated_at (37.3521ms)
✔ registry sync:插件卸载后 available=0,重新注册恢复 (73.9576ms)
✔ all 模式:停用 daq_query 后注入面/执行闸门同时生效,重置恢复 (75.3122ms)
✔ selected 模式:仅勾选工具注入,缺省即停用 (40.149ms)
✔ 硬规则:observer 档位不能通过 Channel 选择打开写工具 (35.8926ms)
✔ 硬规则:worker 的 lead-only 工具记录 ROLE_DENIED,lead 正常 (3.7093ms)
✔ 透明化视图:全局目录含内置与插件工具,统计一致 (3.2216ms)
✔ 快照构建:插件同名内置时内置优先 (22.82ms)
✔ 策略仓储:removeForChannel 清理策略与行 (29.7293ms)
✔ 折叠确定性:同一输入两次输出逐字节相同(乱序输入排序后一致) (1.1648ms)
✔ 预算:小绑定面不折叠;超预算折叠为前 N 项 + 总数 + 查询引导 (0.4653ms)
✔ 折叠回滚开关:AW_DESC_BUDGET=0 → 全量输出 (0.3082ms)
✔ 单条超预算:首项必须保留(不得产出空「等 N 项」折叠) (0.1936ms)
✔ 分页:确定性排序(kind→id)、query 过滤、limit 钳制、offset 越界 (1.2898ms)
✔ user scenario: worker 绑 1 号节点、传 2 号节点(他线)→ 拒绝且文案列出绑定面 (3.0912ms)
✔ user scenario: 同线但未绑定的 2 号节点、且频道未绑线 → 同样拒绝(未绑定不等于可见) (1.1101ms)
✔ 绑定面内节点放行(node/line 引用均通过) (0.5368ms)
✔ 不存在的节点:拒绝文案与「未授权」区分(提示核对 id) (0.5817ms)
✔ 频道绑线只读扩权:绑线数采节点(未绑定)可读;他线节点仍拒 (0.6729ms)
✔ nodes[] 深路径与 arrays:aml_dataset_build 逐节点校验 (0.766ms)
✔ 配方面:绑定配方可操作;他线配方(未绑定/不可读)拒 (0.7567ms)
✔ dcw_journal:无参(此前返回全量记录)与越界 node_id 均拒,越界文案列可查对象 (0.8783ms)
✔ 形状:引用参数非字符串 → 拒绝并说明应为字符串 ID (1.0103ms)
✔ 授权性拒绝写入 audit_log(tool.call.denied),形状类拒绝不入册 (0.6429ms)
✔ 链式:跨线数据集拒(谱系回溯到产线),本人数据集放行 (3.3171ms)
✔ 无引用参数的工具不受预检影响(my_industrial_nodes 原样进入 handler) (5.7158ms)
✔ resolveRefFaces:绑定面/可读线/配方面/频道绑线面一致 (0.317ms)
✔ 契约:query() raw 路径时间正序(ASC),窗口超 limit 截取最旧段 (17.8549ms)
✔ 契约:query() bucket 路径时间正序(ASC) (10.5157ms)
✔ 导出:>5000 样本窗口游标续页取全(CSV 行数 == 样本数,不静默截断) (85.1997ms)
✔ 契约:limit<=0 不得变成 SQL 无上限(适配器夹到 1) (9.4946ms)
{"t":"2026-11-04T08:20:23.499Z","level":"info","scope":"daq.tsdb.sqlite","msg":"[daq-tsdb] 保留期清理 1 行(>720h)"}
✔ A15:queryTagged raw 返回真实 state;cleanPoints 实际剔除坏点 (2.6362ms)
✔ A16:同键不同值 → 首值保留且 correctionDropped+1(不静默) (0.8804ms)
✔ A1:逐节点分页稳定 ASC、游标续读、无漏无重 (1.5051ms)
✔ A16 ④:旧数据 ingestedAt 缺失 → 分页点不伪造到达时间 (0.5542ms)
✔ A16 ③:迟到但新鲜的样本不被事件时间误删 (27.8653ms)
✔ 保留期归一:非法值回退、raw 最小 1h、hour 允许 0(永久) (2.6891ms)
✔ 窗口在原始保留期内 → raw(即使桶宽 ≥1h) (0.3699ms)
✔ 窗口早于原始保留期 → 1 分钟聚合;跨边界 → mixed (1.1901ms)
✔ 完全落在旧窗口 + 桶宽 ≥1h → 1 小时聚合(且不 mixed) (0.1778ms)
✔ 桶宽 <1 分钟或聚合未启用 → 绝不用聚合冒充历史 (0.1385ms)
✔ 混合合并:按桶起点升序、同点 raw 优先、超限保留最新段 (0.314ms)
✔ 运行期新建产线:无需重启即进入聚合与逐线裁剪 (6604.5026ms)
✔ 契约:按 productId 等值过滤,未打标行与异产品行都不出现 (36.9325ms)
✔ 契约:按 runId / recipeId 过滤各自只中目标批次 (28.206ms)
✔ 契约:lineId 过滤含两个批次但排除未打标段 (2.0618ms)
✔ 契约:全留空 = 原始时间窗(含未打标行),分页/游标语义不变 (2.3975ms)
✔ 契约:过滤 + 分页组合 = 只取目标批次的全部点(游标续读不串批) (2.9249ms)
✔ fetchNodeSeries(AML 训练取数)必须把三元组透传给分页接口 (236.0865ms)
✔ tail:桶窗口超 limit 时返回末尾 limit 个桶(升序) (41.9736ms)
✔ tail:桶数 ≤ limit 时原样全量返回(稀疏窗口不丢历史段) (18.8907ms)
✔ tail:桶间有空洞时仍取末尾 limit 个非空桶 (10.1542ms)
✔ tail:limit=1 返回窗口内最后一个桶(不是最旧) (8.8649ms)
✔ tail:多节点每节点各取末尾 limit 个(queryTaggedLatest) (15.7659ms)
✔ 旧契约不变:query() 默认仍取窗口最旧段(导出/训练集依赖) (8.5159ms)
✔ freshnessOf:返回最后一点的时间与滞后 (0.3198ms)
✔ tail:from 缺省(UI 趋势路径)也必须取最新段,不能退化为 epoch 级旧段 (260.8305ms)
✔ tail:limit=5000(适配器单次行数上限)仍能取到最新桶 (155.2922ms)
✔ tail:from 缺省 + 稀疏数据仍取末尾 limit 个非空桶 (13.6502ms)
ℹ tests 1084
ℹ suites 40
ℹ pass 1082
ℹ fail 0
ℹ cancelled 0
ℹ skipped 2
ℹ todo 0
ℹ duration_ms 33135.0311
```

## `npm run test:unit` — PASS (36s, exit=0)

```
plugin=1 unavailable=0 total=122 (test-idempotent)"}
{"t":"2026-11-04T08:22:41.726Z","level":"info","scope":"workshop.tool-registry","msg":"synced builtin=121 plugin=1 unavailable=1 total=122 (test-unregister)"}
{"t":"2026-11-04T08:22:41.727Z","level":"info","scope":"workshop.plugin-tools","msg":"[omp-tools] 插件工具注册:「trp_plugin_echo」(trp-test-plugin)"}
{"t":"2026-11-04T08:22:41.755Z","level":"info","scope":"workshop.tool-registry","msg":"synced builtin=121 plugin=1 unavailable=0 total=122 (test-reregister)"}
{"t":"2026-11-04T08:22:41.901Z","level":"info","scope":"workshop.plugin-tools","msg":"[omp-tools] 插件工具注册:「report_progress」(trp-test-plugin)"}
{"t":"2026-11-04T08:22:41.903Z","level":"info","scope":"workshop.plugin-tools","msg":"[omp-tools] 插件工具注册:「trp_plugin_echo」(trp-test-plugin)"}
{"t":"2026-11-04T08:22:41.931Z","level":"info","scope":"workshop.tool-registry","msg":"synced builtin=121 plugin=1 unavailable=0 total=122 (test-cleanup)"}
✔ registry sync:幂等且 hash 未变不推进 updated_at (37.3407ms)
✔ registry sync:插件卸载后 available=0,重新注册恢复 (64.5469ms)
✔ all 模式:停用 daq_query 后注入面/执行闸门同时生效,重置恢复 (54.4506ms)
✔ selected 模式:仅勾选工具注入,缺省即停用 (49.4507ms)
✔ 硬规则:observer 档位不能通过 Channel 选择打开写工具 (34.7203ms)
✔ 硬规则:worker 的 lead-only 工具记录 ROLE_DENIED,lead 正常 (2.3008ms)
✔ 透明化视图:全局目录含内置与插件工具,统计一致 (3.1007ms)
✔ 快照构建:插件同名内置时内置优先 (31.2134ms)
✔ 策略仓储:removeForChannel 清理策略与行 (32.4524ms)
✔ 折叠确定性:同一输入两次输出逐字节相同(乱序输入排序后一致) (1.0842ms)
✔ 预算:小绑定面不折叠;超预算折叠为前 N 项 + 总数 + 查询引导 (0.6146ms)
✔ 折叠回滚开关:AW_DESC_BUDGET=0 → 全量输出 (0.4791ms)
✔ 单条超预算:首项必须保留(不得产出空「等 N 项」折叠) (0.2361ms)
✔ 分页:确定性排序(kind→id)、query 过滤、limit 钳制、offset 越界 (1.175ms)
✔ user scenario: worker 绑 1 号节点、传 2 号节点(他线)→ 拒绝且文案列出绑定面 (3.5215ms)
✔ user scenario: 同线但未绑定的 2 号节点、且频道未绑线 → 同样拒绝(未绑定不等于可见) (0.4847ms)
✔ 绑定面内节点放行(node/line 引用均通过) (0.3182ms)
✔ 不存在的节点:拒绝文案与「未授权」区分(提示核对 id) (0.3481ms)
✔ 频道绑线只读扩权:绑线数采节点(未绑定)可读;他线节点仍拒 (0.8031ms)
✔ nodes[] 深路径与 arrays:aml_dataset_build 逐节点校验 (0.5605ms)
✔ 配方面:绑定配方可操作;他线配方(未绑定/不可读)拒 (0.5383ms)
✔ dcw_journal:无参(此前返回全量记录)与越界 node_id 均拒,越界文案列可查对象 (0.326ms)
✔ 形状:引用参数非字符串 → 拒绝并说明应为字符串 ID (0.1408ms)
✔ 授权性拒绝写入 audit_log(tool.call.denied),形状类拒绝不入册 (0.3924ms)
✔ 链式:跨线数据集拒(谱系回溯到产线),本人数据集放行 (1.4044ms)
✔ 无引用参数的工具不受预检影响(my_industrial_nodes 原样进入 handler) (9.5673ms)
✔ resolveRefFaces:绑定面/可读线/配方面/频道绑线面一致 (0.2741ms)
✔ 契约:query() raw 路径时间正序(ASC),窗口超 limit 截取最旧段 (19.9076ms)
✔ 契约:query() bucket 路径时间正序(ASC) (8.4421ms)
✔ 导出:>5000 样本窗口游标续页取全(CSV 行数 == 样本数,不静默截断) (74.4909ms)
✔ 契约:limit<=0 不得变成 SQL 无上限(适配器夹到 1) (11.4451ms)
{"t":"2026-11-04T08:22:42.236Z","level":"info","scope":"daq.tsdb.sqlite","msg":"[daq-tsdb] 保留期清理 1 行(>720h)"}
✔ A15:queryTagged raw 返回真实 state;cleanPoints 实际剔除坏点 (2.4213ms)
✔ A16:同键不同值 → 首值保留且 correctionDropped+1(不静默) (0.8427ms)
✔ A1:逐节点分页稳定 ASC、游标续读、无漏无重 (1.7932ms)
✔ A16 ④:旧数据 ingestedAt 缺失 → 分页点不伪造到达时间 (0.451ms)
✔ A16 ③:迟到但新鲜的样本不被事件时间误删 (19.0787ms)
✔ 保留期归一:非法值回退、raw 最小 1h、hour 允许 0(永久) (1.9509ms)
✔ 窗口在原始保留期内 → raw(即使桶宽 ≥1h) (0.322ms)
✔ 窗口早于原始保留期 → 1 分钟聚合;跨边界 → mixed (1.2637ms)
✔ 完全落在旧窗口 + 桶宽 ≥1h → 1 小时聚合(且不 mixed) (0.2067ms)
✔ 桶宽 <1 分钟或聚合未启用 → 绝不用聚合冒充历史 (0.1693ms)
✔ 混合合并:按桶起点升序、同点 raw 优先、超限保留最新段 (0.2791ms)
✔ 运行期新建产线:无需重启即进入聚合与逐线裁剪 (6889.2337ms)
✔ 契约:按 productId 等值过滤,未打标行与异产品行都不出现 (35.7295ms)
✔ 契约:按 runId / recipeId 过滤各自只中目标批次 (18.7588ms)
✔ 契约:lineId 过滤含两个批次但排除未打标段 (1.8429ms)
✔ 契约:全留空 = 原始时间窗(含未打标行),分页/游标语义不变 (2.1037ms)
✔ 契约:过滤 + 分页组合 = 只取目标批次的全部点(游标续读不串批) (2.9398ms)
✔ fetchNodeSeries(AML 训练取数)必须把三元组透传给分页接口 (274.1195ms)
✔ tail:桶窗口超 limit 时返回末尾 limit 个桶(升序) (38.2224ms)
✔ tail:桶数 ≤ limit 时原样全量返回(稀疏窗口不丢历史段) (16.4664ms)
✔ tail:桶间有空洞时仍取末尾 limit 个非空桶 (9.1099ms)
✔ tail:limit=1 返回窗口内最后一个桶(不是最旧) (9.2835ms)
✔ tail:多节点每节点各取末尾 limit 个(queryTaggedLatest) (14.4636ms)
✔ 旧契约不变:query() 默认仍取窗口最旧段(导出/训练集依赖) (9.5617ms)
✔ freshnessOf:返回最后一点的时间与滞后 (0.6928ms)
✔ tail:from 缺省(UI 趋势路径)也必须取最新段,不能退化为 epoch 级旧段 (158.6779ms)
✔ tail:limit=5000(适配器单次行数上限)仍能取到最新桶 (175.5344ms)
✔ tail:from 缺省 + 稀疏数据仍取末尾 limit 个非空桶 (14.3225ms)
ℹ tests 1084
ℹ suites 40
ℹ pass 1082
ℹ fail 0
ℹ cancelled 0
ℹ skipped 2
ℹ todo 0
ℹ duration_ms 35058.4961
```
