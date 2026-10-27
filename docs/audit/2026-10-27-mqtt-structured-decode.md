# MQTT 结构化数据解析与用户 sink 验收报告(2026-10-27)

**结论:可实现,且已实现并实测通过。** broker 传来的结构化 JSON 可以在**节点创建时**配置
解析方式,得到单个类型化样本:`scalar`(单个数字)/ `vector`(数值数组)/ `image`(图像);
解析结果经模板 sink 下沉处理后,与节点/模板/产线/批次元信息一起入库(标量→`daq_samples`,
数组/图像→`daq_frames`)。复杂解析/加工通过统一接口交给用户插件:

- `ctx.daq.registerDecoder(name, fn)` —— 原始报文 → 类型化样本(自定义解析入口);
- `ctx.daq.registerProcessor(kind, name, fn)` —— 类型化帧 → 加工后帧(模板 `sink.processors` 引用)。

验收:E2E **60/60 通过**(新增 L0–L12 结构化组),全量单测 **603/603 通过**。

- 分支/PR:`feat/mqtt-structured-decode` / PR #14
- 证据:`docs/audit/evidence/2026-10-27-mqtt-structured-decode/`(`e2e-run.txt`、`assertions.json`、`unit-tests.txt`)
- 复跑:`npm run build && node scripts/e2e-mqtt-protocol.mjs`(脚本自起全新隔离实例并装载测试插件)

---

## 1. 能力答案

| 问题 | 答案 |
|---|---|
| 是否支持对 broker 结构化数据自定义解析? | 支持。节点 `driverConfig` 声明 `jsonPath`/`pointsPath`/`imagePath` 等;或 `decoder=<插件解码器名>` 完全自定义。 |
| 能否在节点创建时设定? | 能。字段已加入 MQTT 驱动目录 `configFields`,前端"添加节点"动态表单渲染;vector/image 模板与 sink 可由用户经 `POST /api/workshop/daq/templates` 创建后选用。 |
| 解析结果能否是单个数字/数组/图片? | 能。结果与模板 `signalKind` 强校验;不一致以可读 `lastError` 拒绝,绝不把数组写进标量链路。 |
| 能否拼接时间与节点元信息入库? | 能。时间=报文到达时刻(同毫秒单调修正);帧行带模板键、产线/产品/配方/批次打标、点列/指标;图像另存对象键、宽高、MIME、sha256、字节数。 |
| sink 是否留给用户? | 是。解码器(raw→typed)与处理器(typed→typed)均可插件注册;模板 `sink.processors` 是声明式编排。 |
| 是否真实测试过? | 是。真实 broker 发布结构化 JSON/二进制 PNG;数组/图像/IHDR/二进制/自定义解码器/坏结构/配置变更全部覆盖。 |

## 2. 配置与数据流

### 2.1 节点创建配置(声明式)

| 模板形态 | driverConfig 字段 | 入库 |
|---|---|---|
| scalar | `jsonPath`(如 `data.temperature`;纯数字/数字字符串报文可留空) | `daq_samples` |
| vector | `pointsPath`(缺省 `points`,1~4096 个有限数)、`metricsPath`(可选指标对象) | `daq_frames`(点列 + 指标) |
| image | `imageFormat=json|binary`、`imagePath`(缺省 `png`)、`imageMime`/`mimePath`、`imageWidthPath`/`imageHeightPath`(可选;PNG 自动读 IHDR) | `daq_frames`(对象键/宽高/MIME/sha256/size/指标) |

`metricsPath`/`imageMime`/`mimePath` 等字段均在驱动目录中;`pointsPath` 等解码相关字段
纳入订阅指纹 —— **PATCH 解析配置会重建订阅立即生效**(L12 验证)。

### 2.2 用户自定义解析与 sink(统一接口)

```js
// 插件 setup(ctx)
ctx.daq.registerDecoder('my-json', (input) => {
  // input: { raw, bytes, json(已解析/失败为 null), config, signalKind, nodeId }
  const j = input.json
  return { kind: 'scalar', value: j.a + j.b }
  // 或 { kind:'vector', points:[...], metrics?:{...} }
  // 或 { kind:'image', blob:Buffer, mime:'image/png', width?, height?, metrics?:{...} }
})

ctx.daq.registerProcessor('vector', 'my-smooth', (frame) => ({
  ...frame,
  points: frame.points.map((v, i, a) => (i === 0 ? v : (a[i - 1] + v) / 2)),
}))
```

- 节点 `driverConfig.decoder = 'my-json'` 启用(优先于声明式路径)。
- 解码器必须**同步纯函数**;返回 Promise 会被明确拒绝。返回结果受类型/点数/图像/指标校验。
- 解码器按插件归属注册:插件重载/停用会撤销(owner 清理);跨插件重名告警。
- 模板 `sink.processors` 引用处理器;内置 `derive-metric`/`zones`/`thumbnail`/`quality-gate`,
  插件可注册任意处理器。

### 2.3 数据流

```
MQTT 报文 ──decode(声明式/用户 decoder)──► scalar | vector | image
   scalar ──► 队列 ──► runtime.onSample ──► daq_samples(+批次打标)
   vector/image ──► 模板 sink 管线 ──► (图像落对象存储) ──► 队列帧信封
        ──► runtime.onSample ──► daq_frames(点列/指标/对象键/sha256 + 批次打标)
```

- 推送帧与轮询采样共用 `processFrameSample`(sink + 对象存储),不是两套实现。
- 帧时间戳使用**单调到达时刻**(同毫秒 +1),避免 runtime 迟到丢弃与对象键覆盖;
  帧处理按节点单飞(在飞时丢弃后续帧并计数),防高码率图像无界并发;
  异步处理完成时复核绑定与批次 runId,不把帧错标到新批次。
- 解析失败:`onError` 更新节点 `lastError`,坏结构不入库;下一帧成功自愈。
- 图像落对象存储后队列只传引用;对象键扩展名跟随 MIME。

### 2.4 验证与安全

- 数字严格:null/boolean/空串/数组/对象不会被静默转成 0;数字字符串可接受。
- 图像:MIME 允许 PNG/JPEG/WebP/BMP/GIF/TIFF(**拒绝 SVG/HTML**);base64 上限 10MB
  (`imageMaxBytes`);单边 ≤16384、像素 ≤16M;PNG 签名 + IHDR 校验;
  `decodeGrayPng` 解压上限=预期像素字节(防压缩炸弹);data URL MIME 优先于缺省值。
- 内容端点:`X-Content-Type-Options: nosniff` + `Content-Disposition: attachment`;
  未授权访问 401(L8b)。
- 自定义解码器输出同样校验:点列数组/有限数、metrics 对象且有限、blob 必须 Buffer、MIME 允许表、
  尺寸/字节上限。

## 3. 验收矩阵(60/60)

原有 41 条 MQTT 传输/治理断言全部继续通过;新增结构化组:

| 断言 | 内容 | 结果 |
|---|---|---|
| L0 | 节点创建目录暴露 pointsPath/metricsPath/imageFormat/imagePath/decoder 等字段 | PASS |
| L1 | 自定义 vector 模板 + 节点创建(数组路径) | PASS |
| L2 | 结构化 JSON 数组 → 5 点 vector 帧入库(5 帧) | PASS |
| L0b | 保存节点测试按模板形态解码 → "vector 5 点" | PASS |
| L3 | 模板 sink:avg=30、zone1_avg=15、zone2_avg=40;帧带 line/run 批次元信息 | PASS |
| L2b | 帧管线本组 produced=consumed(23=23;全局 late 含 retained 重放,非帧丢失) | PASS |
| L4 | 用户注册 sink 处理器 `e2e-tag` 生效 | PASS |
| L5 | 自定义 image 模板 + 节点创建(base64 字段) | PASS |
| L6 | base64 PNG → image 帧:4×4、image/png、sha256(64)、size=85B | PASS |
| L7 | 图像 sink quality-gate brightness=122 | PASS |
| L8 | 内容端点回取 PNG(200、85B=meta.size) | PASS |
| L8b | 未授权访问内容端点 → 401 | PASS |
| L6b | 未配置宽高路径 → PNG IHDR 自动 4×4(2 帧) | PASS |
| L6c | MQTT 二进制 PNG 报文 → image 帧 4×4/image/png(2 帧) | PASS |
| L9 | 坏结构 → 0 帧 + 可读 lastError(缺少点列 pointsPath=data.points);恢复自愈 | PASS |
| L10 | 用户 decoder `e2e-sum-xy` → scalar 42.5 入库 | PASS |
| L10b | 自定义 decoder 异常 → 0 行 + 可读 lastError;恢复自愈 | PASS |
| L11 | 用户 decoder `e2e-vec-add` → vector [11,22,33,44,55] | PASS |
| L12 | PATCH pointsPath → 订阅重建:旧路径 0 帧+错误;改回后恢复 1 帧 | PASS |

合计 **60 passed / 0 failed / 0 skipped**;全量单测 **603 passed / 0 failed**
(`tests/mqtt-structured-decode.test.ts` 8 条:scalar/vector/image、严格数值、IHDR、data URL、
binary、MIME/上限、自定义 decoder/异步拒绝/坏输出、owner 生命周期、自动识别、sink 处理器)。

## 4. 独立评审修复(首轮 CHANGES_REQUIRED → 已关闭)

| 评审问题 | 修复 |
|---|---|
| 修改解码配置不重建订阅(保存的节点仍用旧 decoder/path) | 解码相关字段纳入 MQTT 订阅指纹;L12 实测 PATCH 后旧路径立即失效、改回即恢复 |
| 帧使用原始到达时刻、同毫秒覆盖对象键、无在飞限制 | 帧使用单调 `bind.lastAt`;单节点帧单飞(超额丢弃计数);对象键按 MIME 扩展名 |
| 插件 decoder 停用/重载不撤销 | 注册按 owner;插件重载前 `clearDecoders()`;owner 单测 |
| null/boolean/空串被静默转为 0 | `asNumber` 严格化;点列/metrics/宽高 null 全部拒绝;单测覆盖 |
| 图像解压/尺寸无上限(压缩炸弹) | 像素/单边上限、PNG 签名+IHDR 校验、`inflateSync maxOutputLength`;内容端点 nosniff/attachment;MIME 白名单 |
| 自定义 decoder 的 `json` 字段恒 null | 解码入口统一解析并传入 |
| 自定义 decoder 异常/异步/坏输出提示不清 | 异步明确拒绝;输出类型/blob/metrics/尺寸校验;节点 lastError 可读 |
| 图像内容未授权路径未测 | L8b 401 |
| 二进制图像/IHDR/配置变更未测 | L6b/L6c/L12 |
| 节点测试(保存后)未按模板形态解码 | `testNode` 传 signalKind;L0b |

## 5. 边界(如实说明)

- **不解析 XML/HTML**(规避 XXE/外部实体);结构化解析仅 JSON/纯文本/二进制。
- **SVG 等非栅格 MIME 拒绝**;图像上限 10MB、单边 16384、16M 像素;解压有上限。
- **非 PNG 图像**需显式 `imageMime` 与宽高(或 `mimePath`/`imageWidthPath`/`imageHeightPath`);
  图像 sink 的 `quality-gate`/`thumbnail` 只理解本仓 8-bit 灰度 PNG,RGB/JPEG 可能不产生
  brightness/缩略图(不报错);真实相机图像建议先用 decoder 转灰度 PNG 或只做存储。
- **帧在停线期间不缓存**(图像可能很大):标量有停线补种,帧等下一次发布;帧在飞时新帧丢弃
  (计数不对外暴露,日志可见)。
- **自定义 decoder 同步、运行在平台进程**(插件为受信代码);异步/外部依赖解析请用自定义驱动。
- 浏览器端的"添加节点/详情表单"由驱动目录动态渲染(代码路径);E2E 只验证目录字段与 REST 创建,
  未做逐字段浏览器截图。
- 未覆盖:插件 disable/reload 的端到端 decoder 撤销(代码+owner 单测)、真实相机 PNG 兼容性、
  跨进程插件沙箱。安全扫描未给出完整结论,**不宣称已通过安全审计**。

## 6. 关键文件

- 解码器注册表:`server/services/workshop/daq/decoders.ts`
- MQTT 声明式解码:`server/services/workshop/daq/drivers/mqtt-decode.ts`
- 推送帧管线:`server/services/workshop/daq/daq-controller/push.ts` + `state.ts::processFrameSample`
- 插件接口:`server/services/workshop/plugins/host/load.mjs`(`ctx.daq.registerDecoder`)；
  插件重载撤销:`plugins/host/reload.mjs`
- 节点创建字段:`shared/daq-protocol.ts`(MQTT `configFields`)
- 模板/sink:`server/services/workshop/daq/frames.ts`、`daq-templates.ts`
- 内容端点:`server/api/workshop/daq/[id]/frames/content.get.ts`
- E2E:`scripts/e2e-mqtt-protocol.mjs`(L 组;测试插件在临时 home 的 `plugins/mqtt-e2e-sink`)
- 文档:`docs/site/guide/daq-protocols.md` / `docs/site/en/guide/daq-protocols.md`
