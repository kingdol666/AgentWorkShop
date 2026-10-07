# MES 区间取数 + TSDB 原始时序全链实测报告(2026-10-07)

> 任务:验证 MES API 是否支持"时间段 + 字段 + 间隔"的区间批量取数(而非逐点拉取);
> 大数据量时序连续数据是否先落 data 文件夹再分析/交 IDD;PLC 原生协议进 TSDB 后
> 原始时序的获取链路。实测取证,问题如实暴露。

## 结论(先行)

1. **MES 区间取数:支持,且无需改平台代码。** `mes-rest` 驱动的 `historyMap` 声明式
   映射可把任意 REST MES 的区间 API 适配进来:时间段(`from`/`to` 由平台注入)、
   字段(`historyMap.query.fields` 按节点声明)、间隔(`requestHook` 把 Agent 传入的
   `param.interval` 注入 query)、游标分页(`nextCursorPath`)。本次以"多字段+时间段+
   间隔聚合"的真实感模拟器端到端实测,Agent 工具面 18/18 断言全过。
2. **大数据量→文件→分析:两条链路都已建成并实测通过。** MES 侧异步数据集
   (`mes_fetch` max_rows>2000 → CSV 落 `<数据根>/datasets/`);TSDB 侧 `daq_export`
   全量原始时序 → `<data>/daq-exports/<id>/`(逐节点 CSV + manifest.json + merged.csv
   宽表)。文件统计与工具面统计一致;行数与 Timescale 对账**精确相等**(6923==6923、
   6924==6924)。
3. **TSDB 原始时序链路:实测抓出 4 处真缺陷(降序契约族),已修复并有单测锁定。**
   修复前:窗口 >5000 样本时 `daq_export` **静默截断**只留最新 5000 行且不标 truncated;
   `daq_query` 的「最新/最近序列」实为**窗口最旧**桶;AML 预测喂的是**过期历史**;
   REST samples 降序靠前端 reverse 补救。修复后:升序契约 + 对账精确相等 +
   契约单测 3/3。

## 一、MES API 自定义设计的适配能力(架构面)

核心机制在 `server/services/workshop/dcw/drivers/mes-rest.ts`:

- **声明式映射**(配置期 safeParse 拒绝坏映射,不进请求链路):
  - `readMap`:当前值(valuePath/tsPath);
  - `writeMap`:写(setpoint);
  - `historyMap`:**历史区间** —— `method/path/query/headers` +
    `response.{rowsPath, tsPath, valuePath, format, nextCursorPath}` + `pageSize/maxPages`。
    平台取数时自动注入 `from`(ISO)/`to`/`pageSize`/`cursor`(mes-rest.ts:619-622),
    游标翻页直到取完或护栏上限。
- **运行时钩子**(用户自写代码,平台沙箱执行):
  - `requestHook(param) => {path?, query?, headers?}`:**Agent 每次调 `mes_fetch` 传的
    `param` 透传进来**,把 `interval` 等调用期参数注入请求(mes-controller.ts:326-345)。
  - `dataHook(param, data)`:取数后下沉处理(CSV 产物等)。
- **Agent 工具面**(`server/services/workshop/mes/mes-controller.ts`,护栏全代码级):
  `mes_catalog`(目录/能力位)/`mes_fetch`(三模式)/`mes_dataset_read`(head/stats/rows)
  /`mes_datasets`(清单)。授权=配方绑定→参数节点;窗口≤7 天、max_rows≤5000、
  每 60s≤6 次;**行级原文永不进 prompt**(只回统计摘要 + ≤3 行采样)。

即:**MES API 契约由用户/集成者自定义设计**(端点、参数名、响应形状、分页方式全部
可配置适配),平台不要求特定 MES 产品。

## 二、实测 A:模拟"真实 MES 区间 API"并接入(Agent 18/18)

### 模拟器扩展(`scripts/dev-mes-simulator.mjs`)

新增典型 MES 历史库形态的端点:

- `GET /api/v1/series?fields=a,b,c&from=ISO&to=ISO&interval=<秒>` —— 多字段+时间段+
  间隔聚合(interval 缺省=raw 1s 拍;聚合=桶内均值,cursor 分页)。
  实测:10min 窗 raw=600 点;interval=60 → 11 行;坏字段 400。
- `GET /api/v1/fields` 字段目录。

### 平台接入(零代码,纯配置)

- 建线 `ln-b67fb187` + 3 个 mes-rest 节点(dw-8bbfd658/dw-80f00e8b/dw-944ba9d7),
  每个: `readMap`→当前值 + `historyMap`→`/api/v1/series`(`query.fields=<本节点字段>`,
  `valuePath: values.<字段>`, `nextCursorPath: data.nextCursor`) + `requestHook` 注入
  `param.interval`。
- 产品 pd-1b44c4c2 → 配方 `rc-2dfa2454`「MES区间取数配方(Fields×Interval)」→
  频道 lead 绑定(kind=recipe)→ 授权闭环(产线隔离闸验证:跨线绑定被
  LINE_SCOPE_MISMATCH 正确拒绝)。

### E2E 断言(`tmp-e2e/mes-range-e2e.mjs`,18/18)

| # | 断言 | 结果 |
|---|------|------|
| A1 | mes_catalog 可见 3 点位+史能力位 | ✓ |
| A2 | 快照模式 3 点当前值 | ✓ |
| A3 | 内联 raw 10min=600 行/点 | ✓ |
| A4 | **param.interval=60 → 11 行/点**(600 raw→10 桶,requestHook 注入实证) | ✓ |
| A5 | 越权成员取数被拒 | ✓ |
| A6 | 8 天窗被拒(≤7 天护栏) | ✓ |
| A7 | max_rows=5001 被拒(≤5000 护栏) | ✓ |
| A8 | 3h×3 点异步作业→CSV 数据集就绪 | ✓ |
| A9 | 异步 interval=60 → 181 行(3h→180 桶) | ✓ |
| A10 | CSV 落 `.AgentWorkShop/datasets/`,文件统计与工具面 mean 一致(±0.01) | ✓ |
| A11 | 数据集可见性隔离(外域成员不可见) | ✓ |

> 过程记录:首次 15/18——本测试供给脚本漏配 `nextCursorPath`,驱动按声明
> "无游标=取完"停在第一页(500 行)。这是**声明式映射的正确行为**、配置方缺陷,
> 补配后全过。该坑已写进 aw-line-onboarding skill(见 §五)。

## 三、实测 B:TSDB 原始时序全链(17/17,含对账)

### 现状链路(PLC 原生协议 → TSDB → 消费)

- **采集落库**:PLC(Modbus/MQTT/OPC UA/HTTP 驱动)→ daq 轮询 → `writeSamples()`
  批写 TimescaleDB(`daq_samples`,ts 为 timestamptz 微秒精度,逐样本打标
  line/product/recipe/run);无 DAQ_TSDB_URL 时降级 SQLite 同契约。
- **消费三面**:
  1. `daq_query`(Agent 文本面):时间窗 + `bucket_ms` 降采样 + 批次打标过滤;
  2. `daq_export`(文件面):**全量原始无降采样**,分页拉全(单查 5000/页 × ≤400 页
     = 200 万点/节点)落 `<data>/daq-exports/<id>/`,manifest.json 含节点语义/量程/
     产线-产品-配方-批次上下文;`merge:true` 附加按秒对齐宽表 merged.csv;
  3. IDD/诊断:`diag_run(export_id=…)` 上传全目录做深度根因;`sentinel_*` 以文件
     路径为输入(exchange_dir 免疫提示);worker 按目录绝对路径直读分析。

### E2E 断言(`tmp-e2e/tsdb-range-e2e.mjs`,17/17,CastFilm 实线 dn-14ce39a9/dn-3c6f8348)

- B1 daq_query 时间窗+默认降采样,批次作用域声明 ✓
- B2 REST samples:2s 桶=297 点 vs 10s 桶=61 点 vs raw=567(10min)——降采样对账 ✓
- B3 2h 窗 export → 目录/manifest/merged.csv ✓
- B4 **对账精确相等**:CSV 6923==PG raw 6923、6924==6924(窗口端点钉在导出前 10s
  消除活线写入竞态后)✓
- B5 worker 直读 merged.csv 统计(6925 行,mean 可算)✓;>5000 行不再截断 ✓
- B6 越权导出被拒 ✓

## 四、实测抓出的真缺陷(降序契约族,已修复)

病根:`server/services/workshop/daq/storage/timescale.adapter.ts` 与 `sqlite.adapter.ts`
的 `query()`(raw+bucket 两条路径)`ORDER BY ts DESC` —— 返回**最新在前**;而全部
消费方按**升序**假设。`queryTagged` 本就是 ASC,两个适配器自相矛盾。前端
`useDaqDetailHistory.ts:37` 注释"接口 DESC 返回 → 图表时间正序"靠 `.reverse()`
补救,是历史意外的契约。

| # | 缺陷(修复前实测取证) | 影响 | 修复 |
|---|------------------------|------|------|
| D1 | `daq_query`「最新 N 点」=`values[values.length-1]`+`slice(-12)`,降序下实为**窗口最旧**桶(实证:显示 55.63,PG 真实最新 54.7) | Agent 按过期读数做 keep/rollback 判读 | 适配器改 ASC 后自动纠正 |
| D2 | `daq_export` 窗口 >5000 样本:首页取最新 5000 行,`lastAt+1` 游标越界,**静默截断**且 truncated 不置位(实证 5000 vs PG 6934) | 用户要的大数据量全量导出恰恰是重灾区 | ASC 续页取全;契约单测 5300 行取全断言 |
| D3 | AML 预测输入 `grid.slice(-H)`(aml-job-tools.ts:416),降序下=**最旧 H 格**,模型吃过期历史 | 预测系统性失真 | 同上 |
| D4 | REST `/samples` 降序,前端 reverse 补救 | 第三方消费方默认升序即中招 | 契约统一 ASC;前端去 reverse |

修复文件:`timescale.adapter.ts` / `sqlite.adapter.ts`(query 两条路径 ORDER BY ASC +
契约注释)、`useDaqDetailHistory.ts`(去 reverse);`queryFrames`/`latest()` 的 DESC
语义经核对为正确用法(最新帧/每节点最新值),不动。

锁定:`tests/tsdb-ordering.test.ts` 3/3(raw ASC+最旧段截取、bucket ASC+桶计数、
导出 5300 行游标续页取全不截断)。回归 184/185(唯一失败=既有 tool-profile-observer
nitro #imports 病根,与本轮无关,隔离运行其余全过)。

## 五、遗留与边界(如实)

1. **historyMap 漏配 nextCursorPath 只取首页**:驱动按"无游标=取完"设计,配置陷阱
   已写进 skill;可考虑 test-driver 试读时对"分页 API 但未配游标"给提示(P2)。
2. **数据集元信息不显式标注截断**:max_rows 截断时 mes_datasets 只显示行数,Agent 需
   自行比对窗口期望行数;可加 truncated 标记(P2)。
3. **MES 侧 interval 聚合在 MES 侧执行**(平台透传);若真实 MES 不支持 interval
   参数,由 requestHook 适配或降级 raw+平台 bucket(daq_query/TSDB 侧才有平台级
   降采样,P3 认知项)。
4. 演示线既有 mes 节点(historyMap 无 nextCursorPath)在小窗取数下无影响,未动受保护线。

## 六、产物清单

- 代码:`scripts/dev-mes-simulator.mjs`(+series/fields 端点)、两适配器 ASC、
  前端 composable、`tests/tsdb-ordering.test.ts`(新)
- 实测脚本:`tmp-e2e/mes-range-provision.mjs` / `mes-range-e2e.mjs` /
  `mes-range-patch-cursor.mjs` / `tsdb-range-e2e.mjs` / `tsdb-ordering-probe.mjs`
- 实测资源:线 ln-b67fb187(节点 dw-8bbfd658/dw-80f00e8b/dw-944ba9d7)、产品
  pd-1b44c4c2、配方 rc-2dfa2454、频道 af4c09a9(MES 区间)/c00a2118(CastFilm 时序)、
  数据集 mesds-*(datasets/)、导出 daqexp-20261007161853-*(daq-exports/)
