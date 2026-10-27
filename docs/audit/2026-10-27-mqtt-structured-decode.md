# MQTT 结构化数据解析与用户 sink 验收报告(2026-10-27)

**结论:可实现,且已实现并实测通过。** broker 传来的结构化 JSON 可以在**节点创建时**配置
解析方式,得到单个类型化样本:`scalar`(单个数字)/ `vector`(数值数组)/ `image`(图像);
解析结果经模板 sink 下沉处理后,与节点/模板/产线/批次元信息一起入库(标量→`daq_samples`,
数组/图像→`daq_frames`)。复杂解析/加工通过统一接口交给用户插件:

- `ctx.daq.registerDecoder(name, fn)` —— 原始报文 → 类型化样本(自定义解析/sink 入口);
- `ctx.daq.registerProcessor(kind, name, fn)` —— 类型化帧 → 加工后帧(模板 `sink.processors` 引用)。

验收:E2E **53/53 通过**(新增 L0–L11 结构化组),全量单测 **602/602 通过**。

- 分支:`feat/mqtt-structured-decode`
- 证据:`docs/audit/evidence/2026-10-27-mqtt-structured-decode/`(`e2e-run.txt`、`assertions.json`、`unit-tests.txt`)
- 复跑:`npm run build && node scripts/e2e-mqtt-protocol.mjs`(脚本会启动全新隔离实例并装载测试插件)

---

## 1. 能力边界与答案

| 问题 | 答案 |
|---|---|
| 是否支持对 broker 结构化数据自定义解析? | 支持。节点 `driverConfig` 声明 `jsonPath`/`pointsPath`/`imagePath` 等;或 `decoder=<插件解码器名>` 完全自定义。 |
| 能否在节点创建时设定? | 能。上述字段已加入 MQTT 驱动目录 `configFields`,前端"添加节点"动态表单直接渲染;模板(含 vector/image 与 sink)可由用户经 `POST /api/workshop/daq/templates` 创建后在下拉中选择。 |
| 解析结果能否是单个数字/数组/图片? | 能。结果与节点模板 `signalKind` 强校验:scalar/vector/image;形态不一致会以可读 `lastError` 拒绝,绝不把数组写进标量链路。 |
| 能否拼接时间与节点元信息入库? | 能。样本时间=报文到达时刻;帧行带模板键、产线/产品/配方/批次打标、点列/指标;图像另存对象键、宽高、MIME、sha256、字节数。 |
| sink 是否留给用户? | 是。两层:解码器(raw→typed)与处理器(typed→typed)都可插件注册;模板 `sink.processors` 是声明式编排。 |
| 是否真实测试过? | 是。E2E 用真实 MQTT broker 发布结构化 JSON,验证数组/图像/自定义解码器/坏结构负例。 |

## 2. 配置与数据流

### 2.1 节点创建配置(声明式)

| 模板形态 | driverConfig 字段 | 入库 |
|---|---|---|
| scalar | `jsonPath`(如 `data.temperature`;纯数字报文留空) | `daq_samples` |
| vector | `pointsPath`(缺省 `points`,1~4096 个有限数)、`metricsPath`(可选指标对象) | `daq_frames`(点列 + 指标) |
| image | `imageFormat=json|binary`、`imagePath`(缺省 `png`)、`imageMime`、`imageWidthPath`/`imageHeightPath`(可选,非 PNG 用) | `daq_frames`(对象键/宽高/MIME/sha256/size/指标) |

示例载荷 `{"data":{"points":[10,20,30,40,50],"metrics":{"avg":30}}}` + 数组模板 +
`pointsPath=data.points` → 5 点帧;模板 `sink.processors` 依次执行。

### 2.2 用户自定义解析(统一接口)

插件 `setup(ctx)` 中:

```js
ctx.daq.registerDecoder('my-json', (input) => {
  // input: { raw, bytes, json, config, signalKind, nodeId }
  const j = JSON.parse(input.raw)
  return { kind: 'scalar', value: j.a + j.b }
  // 或 { kind:'vector', points:[...], metrics?:{...} }
  // 或 { kind:'image', blob:Buffer, mime:'image/png', width?, height?, metrics?:{...} }
})
```

节点 `driverConfig.decoder = 'my-json'` 即启用(优先于声明式路径)。解码器是**同步纯函数**,
运行在平台进程(插件=受信代码);结果必须与模板 `signalKind` 一致。

更重的帧加工用处理器(模板 sink 引用):

```js
ctx.daq.registerProcessor('vector', 'my-smooth', (frame /*, args */) => ({
  ...frame,
  points: frame.points.map((v, i, a) => (i === 0 ? v : (a[i - 1] + v) / 2)),
}))
// 模板: { sink: { processors: [{ name: 'derive-metric', args: { name:'avg', op:'avg' } }, { name:'my-smooth' }] } }
```

### 2.3 数据流

```
MQTT 报文 ──decode(声明式/用户 decoder)──► scalar | vector | image
   scalar ──► 统一队列 ──► runtime.onSample ──► daq_samples(+批次打标)
   vector/image ──► 模板 sink 管线 ──► (图像落对象存储) ──► 队列帧信封
        ──► runtime.onSample ──► daq_frames(点列/指标/对象键/sha256 + 批次打标)
```

- 帧后处理与轮询驱动共用同一 `processFrameSample`(sink + 对象存储),不是两条实现。
- 连接测试按节点模板形态解码:scalar 报数值,vector 报点数,image 报 MIME/字节。
- 解析失败:`onError` 更新节点 `lastError`,下一帧成功即自愈;坏结构不入库。

## 3. 验收矩阵(53/53)

在原有 41 条 MQTT 传输/治理验收全部通过的基础上,新增结构化组:

| 断言 | 内容 | 结果 |
|---|---|---|
| L0 | 节点创建表单暴露 `pointsPath/metricsPath/imageFormat/imagePath/decoder` 字段 | PASS |
| L1 | 自定义 vector 模板 + 节点创建(数组路径配置) | PASS |
| L2 | 结构化 JSON 数组 → 5 点 vector 帧入库(5 帧) | PASS |
| L3 | 模板 sink 生效:avg=30、zone1_avg=15、zone2_avg=40;帧带 line/run 批次元信息 | PASS |
| L4 | 用户注册的 sink 处理器 `e2e-tag` 生效(metrics.e2e_tag=1) | PASS |
| L5 | 自定义 image 模板 + 节点创建(base64 字段) | PASS |
| L6 | base64 PNG → image 帧:4×4、image/png、sha256(64)、size=85B | PASS |
| L7 | 图像 sink `quality-gate` 派生 brightness=122 | PASS |
| L8 | 帧内容端点回取 PNG(200、image/png、85B 与 meta.size 一致) | PASS |
| L9 | 坏结构 `{}` → 0 帧 + 可读 lastError("缺少点列数组 pointsPath=data.points");恢复发布自愈 | PASS |
| L10 | 用户 decoder(`e2e-sum-xy`)→ scalar 42.5 入库 | PASS |
| L11 | 用户 decoder(`e2e-vec-add`)→ vector [11,22,33,44,55] 入库 | PASS |

合计 **53 passed / 0 failed / 0 skipped**;全量单测 **602 passed / 0 failed**
(新增 `tests/mqtt-structured-decode.test.ts` 7 条:scalar/vector/image/形态校验/自定义 decoder/
自动识别/用户 sink 处理器)。证据中 L3/L6 的原始行可直接核对指标与元数据。

## 4. 边界(如实说明)

- **不解析 XML/HTML**:结构化解析只支持 JSON/纯文本;避免外部实体与 XXE 面。
- **图像上限** 10MB(可配 `imageMaxBytes`);非 PNG 图像需显式宽高或 `imageWidthPath`/`imageHeightPath`
  (PNG 自动读 IHDR);图像像素不入 LLM/队列,只落对象存储并按引用入库。
- **自定义解码器是同步纯函数**,运行在平台进程(插件为受信代码);异步/外部依赖型解析请用自定义驱动。
- **帧在停线期间不缓存**(图像可能很大):停线期间的 retained 帧不会在开跑后补种;标量有补种。
- **数组点数** 1~4096;超出/非有限值报错,不入库。
- 未覆盖:XML、JPEG 尺寸自动解析、解码器热更新后的历史节点重放、跨进程插件沙箱。
- 安全扫描未给出完整结论,**不宣称已通过安全审计**。

## 5. 关键文件

- 解码器注册表:`server/services/workshop/daq/decoders.ts`
- MQTT 声明式解码:`server/services/workshop/daq/drivers/mqtt-decode.ts`
- 推送帧管线:`server/services/workshop/daq/daq-controller/push.ts` + `state.ts::processFrameSample`
- 插件接口:`server/services/workshop/plugins/host/load.mjs`(`ctx.daq.registerDecoder`)
- 节点创建字段:`shared/daq-protocol.ts`(MQTT `configFields`)
- 模板/sink:`server/services/workshop/daq/frames.ts`、`daq-templates.ts`
- E2E:`scripts/e2e-mqtt-protocol.mjs`(L 组;测试插件在临时 home 的 `plugins/mqtt-e2e-sink`)
- 文档:`docs/site/guide/daq-protocols.md` / `docs/site/en/guide/daq-protocols.md`(结构化解析章节)
