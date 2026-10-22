# EDA 看板/图表渲染缺陷修复与图表保真度优化计划

状态：**已实施（2026-10-22 四项修复落地；Puppeteer 渲染产物验收 8/8 PASS）**
日期：2026-10-22
前置：PR #1 已合入 main（`4e58fc56`）；本轮全部结论来自隔离实例 `http://127.0.0.1:3400`（独立 AW_HOME + seed-demo 夹具）的真实浏览器取证，非代码推断。

> **实施回写（2026-10-22）**：
> 1. F1a/F1b/F2/F3/F4a 全部落地；F4b KV 重试为同步防抖冷路径的异步退避（50/200/800ms，tmp 名加时间戳防并发覆盖），双实例 EPERM 场景的长时间行为验证留待部署侧观察（单实例回归全绿）。
> 2. F2 落地为共享构建器 `app/utils/chart-trend.ts`（studio 趋势分支与看板卡单一实现），board `queryCard` 透传 `run_id` 并恢复按单位双轴；非趋势图型（柱/散/直方）保持 studio 本地实现。
> 3. **验收 8/8 PASS**（`scripts/_audit/eda-ui-fix-acceptance.mjs`，证据 `docs/audit/evidence/2026-10-22-eda-ui-fix/`）：A1 看板卡 canvas + 9405~9988 调色板像素；A1b 冻结数据下卡片段数与 API **精确相等** [942,942]；A2 双轴 yAxis=2=单位数；A3 run 维度卡片 **[2,2] == run 查询 [2,2]**（严格不混入同窗其他批次 940 点）；A4 studio 回归 100011 像素；A5 /data 回归 32944 像素；A6 防重叠配置在位。首跑 A4 失败为 vite 冷编译窗口 15s 超时伪影（页内直查 /daq 正常），暖跑消除。
> 4. 门禁：`npm run lint` 0 error、`npm run typecheck` ✔、`npm run test:unit` **309/309**。
> 5. 遗留（如实）：F1 的隐藏标签页场景由「可见才懒、不可见同步画」代码路径保证 + 隐藏取证曾复现（修复前 canvas 缺失），修复后的隐藏态端到端断言未自动化（headless 页面 visibilityState 恒为 visible，需 CDP 可见性仿真，留作 CI 增强）。

---

## 0. 问题核实结论（先回答"是否真有 bug"）

| # | 上报 | 核实结论 | 证据强度 |
|---|---|---|---|
| P1 | 看板卡片不画数据线 | **确认是真 bug**，但触发条件需修正：数据与 option 全部正确，故障在「绘制从未发生」——`lazyUpdate` 把绘制推迟到 rAF，标签页隐藏/后台时 rAF 不触发，canvas 层永远不创建。同步刷新（`resize()`/`setOption(lazyUpdate:false)`）立即画出 3613/4063 个数据线像素 | 像素级取证 + 实例 `getOption()` |
| P2 | 图表文字重叠 | **确认**：/studio 双轴图例与右轴单位名重叠、x 轴刻度拥挤；看板卡（299×111px）下更严重 | 截图目检（多处） |
| P3 | 多实例共写配置根 EPERM | **确认是部署形态问题**：两个 repo 模式实例共享 `.AgentWorkShop` 时插件 KV 互斥写，单次会话 **1820 次** EPERM 刷屏；隔离 AW_HOME 对照实例 **0 次** | A/B 日志对照 |

### P1 完整证据链（本轮实测）

1. **数据层正常**：`GET /api/workshop/daq/query`（与看板 `queryCard` 同参数）返回两节点各 13 点。
2. **实例状态异常**：`x-vue-echarts` 存在、`_echarts_instance_` 已创建、内部容器 299×111px，但 **无 `<canvas>` 子元素**。
3. **option 正确**：经 `setupState.chart.getOption()` 读回——series 两条（炉温/出口压力）**各含 13 个数据点**，x/y 轴齐备。即 vue-echarts 的 option watcher 已正确执行合并。
4. **唯一缺绘制**：`AwChart.vue:72` 的 `{ notMerge: false, replaceMerge: ['series'], lazyUpdate: true }` 中 `lazyUpdate` 把实际绘制推迟到 zrender 的 rAF；`document.visibilityState === 'hidden'` 时 rAF 停摆 → 永不 flush。
5. **同步刷新即愈**：`chart.resize()`（同步 refresh）后 canvas 立即创建并画出 4063 个调色板像素；同步 `setOption(..., {lazyUpdate:false})` 同样即时出图（3613 px）。
6. **为何只有看板坏**：/data 与 /studio 是「数据就绪才 `v-if` 挂载 AwChart」，组件 mount 流程里 vue-echarts 的 `nextTick(resize())` 会同步刷出首帧；看板卡是「先挂空 option、数据到达后仅走 watcher 的 lazy 更新」，完全依赖那次可能永不发生的 rAF。`lazyUpdate` 由 d097f338（2026-09-12，已在 main）引入，看板页（本分支新增）是其首个「先空后有」消费方。
7. **诚实修正**：前轮「刷新两次复现」的截图均为隐藏标签页取证，触发条件应表述为「rAF 未发生」而非「刷新无效」；修复前基线复现须含可见页场景（见 F1 验收①）。

---

## 1. 修复项（F1-F4，编号≠顺序）

### F1 看板卡片渲染兜底（P1 主体）

**改动**（两条互补，a 必做、b 建议同批）：
- a. `app/components/AwChart.vue`：`lazyUpdate` 改为可见性感知——`document.visibilityState === 'visible'` 时保持 `lazyUpdate: true`（保留合批性能语义），否则 `false`；并监听 `visibilitychange`/`window focus`，恢复可见时对存活实例补一次 `resize()` 强制 flush。
- b. `app/pages/studio/board.vue`：对齐 /data //studio 挂载模式——卡片图表在该卡 option 就绪后再挂载（`v-if` 绑定逐卡就绪态），或 `queryCard` 完成后经组件 exposed API 补一次同步 `resize()`。

**验收（渲染产物断言，不接受截图存在式通过）**：
1. 修复前基线：可见标签页下建板开卡，记录是否必现正常（区分「仅隐藏页坏」与「可见页也有时序坏」）。
2. 修复后：建板→开卡→切走标签页 30s→切回，`echarts.getInstanceByDom` 读 `series[*].data.length` = 查询点数、canvas 存在且非空白（像素扫描 >100 调色板像素）。
3. 回归：/data、/studio、/daq 趋势卡在可见页渲染无退化（像素断言 + 读数合批场景手测无闪烁）。

### F2 看板图表保真度：run_id 丢失 + 双轴编码丢失（同文件顺带修，正确性问题）

**改动**：`board.vue` `queryCard`：
- `ds.runId` 存在于保存的 datasource（`studio/index.vue:716` 写入）但重查未传 → 按批次建立的图表在看板上混入他批样本；
- 只建单 `yAxis`，丢弃保存图表 `encoding.y` 的 L/R 双轴与单位分组（/studio 是按单位双轴）→ 同一图表两处渲染不一致。

**修法**：`queryCard` 透传 `run_id`；按 `encoding.y` 的 unit/axis 重建双轴。更优做法：把 /studio 的 `chartOption` 构建器抽成公共 util（`app/utils/` 或组件域共享），studio 与 board 共用，消除两套 option 组装逻辑的持续漂移。

**验收**：
1. run 维度图表：board 卡数据点数 = `/daq/query?run_id=…` 返回点数（API 对照断言）。
2. 双轴图表：board 渲染 option 的 `yAxis.length` = 数据单位数（`getInstanceByDom` 断言）。
3. 权限不变：跨线越权图表卡仍显式标 `inaccessible`（现有 B4 行为不回归）。

### F3 图表文字重叠与窄容器适配（P2）

**改动**（AwChart 层全局受益）：
- legend 不与绘图区争位：`grid.top` 按 legend 存在自动让位；legend `padding`/`itemGap` 保底。
- x 轴 `axisLabel: { hideOverlap: true }`（ECharts 5 原生防重叠）+ 时间轴 `axisLabel.formatter` 按容器宽度分档（时:分 / 分:秒）。
- 轴单位名与图例间距：`yAxis.nameGap` 或单位并入轴名第一行换行。
- 看板小卡（宽 <360px）降密：刻度稀疏化（`axisLabel.interval`）、隐藏 toolbox。

**验收**：DOM 包围盒断言 legend 矩形与轴名/轴刻度矩形不相交；375px 宽容器截图目检无重叠；/studio、/data、board 三页回归。

### F4 插件 KV 并发写韧性 + 部署口径（P3）

**改动**（文档为主、代码低成本兜底）：
- a. 文档：README×2 与 `docs/site` 部署节新增明确口径——**同一配置根仅允许一个实例；并行实例必须用 `AW_HOME` 隔离**（对齐既有 e2e 隔离方法论）。
- b. 代码：插件 SDK KV 落盘（tmp+rename）对 `EPERM`/`EBUSY` 做有限重试（3 次指数退避 50/200/800ms），仍失败则计数聚合告警（现有逐条 WARN 在共享根场景每分钟可刷上百条，改为每 N 分钟汇总一条）。

**验收**：双实例共享根运行 5 分钟——重试路径消解绝大多数竞争，告警日志 ≤ 每 5 分钟 1 条聚合；单实例回归：KV 写入行为与现有测试全绿不变。

---

## 2. 执行顺序与边界

1. **F1a → F1b**（同批提交，先修渲染主链）；**F2** 随后（同文件，借助 F1 的新断言通道一起验收）；**F3** 独立可并行；**F4** 文档先行、代码兜底随后。
2. 每项独立提交 + 独立验收；UI 断言一律走 `echarts.getInstanceByDom`/像素扫描等**渲染产物通道**（沿用 data-studio 既有标准）。
3. 明确不做（本轮边界）：看板指针拖拽、看板筛选器插值（属 eda-optimization-plan P1-3/P1-9 范畴，待其批准后执行）；不重构 AwChart 为多实例注册表。

## 3. 风险

| 风险 | 缓解 |
|---|---|
| 可见性感知 lazyUpdate 引入新时序 | F1 验收含隐藏/可见双场景 + 三页回归像素断言 |
| 双轴重建与 studio 逻辑漂移 | 抽公共 util 单一实现（F2 修法②） |
| KV 重试掩盖真实权限问题 | 重试仅对 EPERM/EBUSY，且聚合告警保留计数可见性 |

## 4. 本轮证据索引

- 隔离走查实例：`http://127.0.0.1:3400`（独立 AW_HOME，seed-demo 夹具：产线 ln-88e9335f / 6 DAQ 节点 / run rr-20b65525）
- P1：页内 `getOption()` 13+13 pts、canvas 缺失、同步刷新 3613/4063 px（`visibilityState: hidden`）
- P3：共享根日志 1820 次 `kv 落盘失败: EPERM`（line-sentinel kv.json）vs 隔离 0 次
- 相关代码锚点：`app/components/AwChart.vue:72`、`app/pages/studio/board.vue:274-304`（queryCard）、`studio/index.vue:716`（datasource 写入）、`d097f338`（lazyUpdate 引入）
