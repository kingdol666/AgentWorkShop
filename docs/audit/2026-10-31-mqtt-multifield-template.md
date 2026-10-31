# MQTT 单 topic 多字段采集 + jsonTemplate 下发 —— 实施与验收（2026-10-31）

## 1. 需求

1. **采集**：同一 MQTT topic 的 JSON 报文含多个字段（温度/湿度/压力…）时，通过**一次配置**
   把各字段都解析并写入时序库，而不是逐点手工建节点。
2. **下发**：MQTT 写控制支持**JSON 拼接模板**（`{{value}}` 插值、可嵌套/带静态字段），
   确保上位机发出的报文与设备客户端解析约定一致。

## 2. 实现

### 2.1 采集：`driverConfig.fields` → 多子信号节点

- 入口：`POST /api/workshop/daq`（`server/api/workshop/daq/index.post.ts`）识别
  `driverConfig.fields` / 顶层 `fields`，调用纯构建器
  `server/services/workshop/daq/field-group.ts:buildMqttFieldGroup()`。
- 语义：**一个字段 = 一个 scalar 节点**（独立单位/量程/预警带/入库/告警/面板），
  子节点共享同一 topic；驱动层按 `(broker, topic)` 只建**一次订阅**（`mqtt.ts` 的
  `consumers: Set` 逐节点解码），因此同一报文到达时各子节点时间戳一致。
- 写法：
  - 对象：`{"temp":"data.temp","humidity":{"path":"data.humidity","unit":"%","min":0,"max":100,"warnLow":20,"warnHigh":80}}`
  - 数组：`["data.temp","data.humidity"]`（字段名取路径末段；对象项可带 `name/unit/min/max/...`）
  - `fieldsBase` 提供公共前缀（已含前缀不重复拼接）。
- 响应：`{nodes, groupId, count, node}`；子节点名 `<父名>·<字段名>`，视图新增
  `fieldGroup`/`fieldLabel`（`shared/daq-protocol.ts` + `daq-node.ts:toView`）。
- 约束与安全：
  - 仅 `mqtt` 驱动；仅 `scalar` 模板；
  - 与 `pointsPath`/`metricsPath`/`imagePath`/`decoder` 互斥；
  - 最多 64 字段、字段名去重、量程/预警带/decimals 校验；
  - 任一字段非法 → **整组回滚**（API 已回滚已建节点），不会留下半套；
  - 未知键/空白/控制字符路径拒绝；不做任何动态求值。
- UI：`shared/daq-protocol.ts` 的 MQTT `configFields` 增加「多字段解析」「多字段公共前缀」。

### 2.2 下发：`jsonTemplate`

- 纯函数：`server/services/workshop/dcw/mqtt-payload.ts:renderMqttWritePayload()`
  - 三档优先级：`jsonTemplate` > `jsonKey`（`{"键":值}`）> 裸数值；
  - `{{value}}` 可多处出现，替换为**有限数字**；模板长度 ≤4KB、渲染结果 ≤64KB；
  - 渲染后 `JSON.parse` 校验并规范化再发布（坏模板不会发给设备）；
  - `jsonTemplate` 与 `jsonKey` 互斥。
- 接入：`server/services/workshop/dcw/drivers/mqtt.ts` 发布前渲染；创建/PATCH 期同样校验
  （`dcw-controller/crud.ts` 调 `validateMqttWriteConfig`），失败 400。
- 回读：`readTopic` + `readJsonPath` 不变；单点手动写回执 `transport-ack`（如实分级），
  批次/配方写由 `write-verify` 的 `readNow` 提升为 `readback-verified`。
- UI：`shared/dcw-protocol/catalog.ts` 的 MQTT 写节点增加「JSON 模板」字段。

### 2.3 文档

- `docs/site/guide/daq-protocols.md` / `en/...`：新增「单 topic 多字段」章节；
- `docs/site/guide/dcw-read-write.md` / `en/...`：新增「MQTT 下发报文模板」章节；
- `npm run docs:check` → 89 通过 / 0 失败。

## 3. 单元测试（15/15）

`npx tsx --tsconfig .nuxt/tsconfig.server.json --test --test-force-exit tests/mqtt-field-group.test.ts tests/mqtt-dcw-template.test.ts`

- 多字段：对象/数组写法、fieldsBase、per-field 单位/量程/预警、scalar 模板约束、互斥项、
  重复/超限拒绝、子节点 driverConfig 清理；
- 模板：嵌套多字段、多处占位符、数组形态、缺占位符/非 JSON/互斥/NaN/超长拒绝、jsonKey/裸值兼容。

## 4. 实机验收（21/21）

脚本：`mqtt-feature-live.mjs`（真实 broker 1883 + 真实 MQTT 报文 + 模拟器设备端），
结果：`report.json`。

- **A 采集**：一次 `fields` 配置展开 4 个子节点（temp/humidity/嵌套 dew/数组下标 arr1）；
  4 路全部有真实样本且值命中发布 JSON；**8 个桶时间戳完全重合**（共享一次订阅）；
  字段级 `warnHigh` 生效（节点 `state=warn`）。
  Timescale 直查：每组 4 个节点行数与 `max(ts)` 完全一致（14/15 行，同 ts）。
- **B 下发**：`jsonTemplate='{"cmd":"set","params":{"temp":{{value}},"hold":8},"ts":123}'`
  抓包为合法 JSON 且嵌套字段正确；真实设备（模拟器 `commandTopic` 解析 `setpoint`）
  收到 `{"cmd":"set","setpoint":30,"src":"awshop"}` 并生效（28→30）；
  状态主题回读 = 30；缺占位符/坏 JSON/与 jsonKey 互斥均在创建期 400。
- **C 兼容**：`jsonKey` 单键下发仍为 `{"setpoint":27}`。

回归：既有 MQTT 专项 29/29（多字段解析、错误字段拒绝、单键/嵌套/多消息边界）
见 `regression-29.json`。

## 5. 能力边界（未变）

- **单节点多命名字段**仍未支持：多字段展开是"一字段一节点"（可独立告警/查询，符合现有
  时序模型）；若业务需要"一个节点里 N 个命名字段"，需要改 `daq_samples` 维度/查询模型。
- **一条报文多个动态值**：`jsonTemplate` 支持一个动态值 + 任意静态字段；两个动态值需
  扩展多值写 API。
- **字符串/枚举**仍不入时序库（数值模型）；建议走事件/告警通道或后续新增 `signalKind=text`。

## 6. 复现命令

```bash
# 单元
npx tsx --tsconfig .nuxt/tsconfig.server.json --test --test-force-exit tests/mqtt-field-group.test.ts tests/mqtt-dcw-template.test.ts
# 实机（需要平台 3300 / broker 1883 / 模拟器 4010+18830）
node docs/audit/evidence/2026-10-31-mqtt-multifield-template/mqtt-feature-live.mjs
```
