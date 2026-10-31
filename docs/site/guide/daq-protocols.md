# 六协议数采与数控

AgentWorkShop 的数采(DAQ)与写控(DCW)驱动面覆盖六种现场协议(5 内置 + 内置串口插件),
采集与下发同一套驱动注册表,连接池、故障分类诊断、逐驱动连接测试开箱即用。
`mock` 驱动用于演示与 CI;**协议即插件**——经 `ctx.daq.registerDriver` / `ctx.dcw.registerWriteDriver`
注入的驱动会自动出现在前端协议下拉与动态参数表单(⌁ 徽标),前端零改动。

## 协议矩阵

| 协议 | 数采 | 数控 | 关键配置 |
|---|---|---|---|
| Modbus TCP | ✅ 保持/输入寄存器,int16~float32,big/little/wordSwap | ✅ 写保持寄存器 + 回读校验 | `host` `port` `unitId` `register`(40001 风格) |
| Modbus RTU(串口网关透传)| ✅ 同上(connectTcpRTUBuffered)| ✅ FC10 写 + FC03 回读 | 同 TCP,端口指向网关 |
| OPC UA | ✅ 会话池,任意 NodeId,匿名/Sign | ✅ 写 Double 节点 + 回读 | `endpoint` `nodeId` |
| MQTT | ✅ **被动订阅**(连上 broker 即入库,报文到达时刻为样本时间;非轮询) + jsonPath;**同 topic 多字段**用 `fields` 一次展开 | ✅ 发布 `{jsonKey: 值}` 或 `jsonTemplate`(`{{value}}` 插值,支持嵌套/多字段);配置 `readTopic`/`readJsonPath` 时写后回读可判 readback-verified | `host` `port` `topic` `jsonPath`/`fields` `qos` `staleMs`;写侧另加 `jsonKey`/`jsonTemplate` `readTopic` `readJsonPath` |
| HTTP | ✅ GET + jsonPath | ✅ POST `{bodyKey: 值}` + 响应回读 | `url` `jsonPath` / `bodyKey` |
| **串口 Serial(serial-bridge 插件)** | ✅ Modbus RTU(FC03/FC04)+ ASCII 行协议(数值/JSON + 保鲜窗) | ✅ Modbus RTU 写保持寄存器(FC06/FC16)+ 同址回读校验;ASCII 模板下行 | `path` `baudRate` `parity` `unitId` `register` `dataType` `byteOrder`;[插件文档](/plugins/guide)(见「通信协议插件(自定义接口连接方式)」) |

## 字节序(32 位类型)

`dataType` 为 32 位(int32/uint32/float32)时,`byteOrder` 决定两个寄存器如何拼装
(值的 4 个字节按 MSB→LSB 记作 A B C D):

| `byteOrder` | 布局 | 寄存器 | 典型适用 |
|---|---|---|---|
| `big`(缺省) | **ABCD** | w0=[A B], w1=[C D] | Modbus 标准大端,最常见 |
| `wordSwap` | **CDAB** | w0=[C D], w1=[A B] | 只交换字序(部分仪表/PLC) |
| `little` | **DCBA** | w0=[D C], w1=[B A] | 整 32 位小端(每字字节反转 + 字序反转) |

- 采集解码与写控编码**严格互逆**:按某序写下去的值,按同序一定能读回同一个数。
- 0.8.6 起 `little` 的语义是**标准 DCBA**;旧版本该选项实际解出的是非标准的 BADC 位序。
  升级后若节点此前按旧行为标定过,请先用已知值做一次写读比对再投入生产。
- 选错序的症状是"数值极小(1e-38 量级)或极大",不会报错 —— 首次接入务必核对。

## 连通性测试

创建节点前先测驱动(前端向导内置「测试连接」步骤):

```bash
# 按参数直测(不经节点)
curl -X POST $API/api/workshop/daq/test-driver \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"driver":"modbus-tcp","driverConfig":{"host":"127.0.0.1","port":1502,"unitId":1,"register":40001,"registerType":"holding","dataType":"float32"}}'

# 已建节点自测
curl -X POST $API/api/workshop/daq/$NODE_ID/test -H "Authorization: Bearer $TOKEN"
```

## 采样模型

- **每节点独立边缘运行时**:采集节拍(`intervalMs`)与 WS 下发节拍(`publishIntervalMs`)分离,
  单节点慢/停不波及邻居。
- **推送式协议(MQTT)不走采样轮询**:控制器对节点建立常驻订阅,每条报文到达即进入
  队列→入库(时间戳=到达时刻);设备停发时不写任何样本,超过 `staleMs`(默认 300s,
  建议设为设备发布周期的 2–3 倍)置 offline 并在 `lastError` 说明原因;恢复发布自动续采。
- **产线门控**:节点挂到产线(lineId)且产线开跑(绑定产品/配方批次)后才开始采集;
  停线即 offline。未分配节点不采集。
- **批次打标**:运行中的每个样本自动携带 `product/recipe/runId`,数据按批次隔离查询。

## MQTT 结构化解析与用户 sink

MQTT 节点可以把 broker 传来的**结构化 JSON**(或纯数字/二进制图像)解析为单个类型化样本:
`scalar`(单个数字)、`vector`(数值数组)或 `image`(图像)。解析在**节点创建时**经
`driverConfig` 声明,结果自动拼接节点模板/产线/批次元信息入库:
标量 → `daq_samples`;数组/图像 → `daq_frames`(数组存点列+指标,图像存对象键+尺寸+sha256+指标)。

| 模板形态 | driverConfig(节点创建时填写) | 入库 |
|---|---|---|
| scalar | `jsonPath`(如 `data.temperature`;纯数字报文留空) | `daq_samples` |
| vector | `pointsPath`(缺省 `points`)、`metricsPath`(可选) | `daq_frames`(points/metrics) |
| image | `imageFormat=json\|binary`、`imagePath`(缺省 `png`)、`imageMime`、`imageWidthPath`/`imageHeightPath` | `daq_frames`(objectKey/mime/宽高/sha256/metrics) |

示例:载荷 `{"data":{"points":[10,20,30,40,50],"metrics":{"avg":30}}}` + 数组模板 +
`pointsPath=data.points` → 5 点帧;模板 `sink.processors`(如 `derive-metric`、`zones`、
`thumbnail`、`quality-gate`)在生产侧执行后再入库,也可由插件注册自定义处理器。

### 单 topic 多字段(一次配置,展开为多个信号节点)

设备在一个 topic 上发多字段 JSON(温度/湿度/压力…)时,不必手工逐个建节点:在 MQTT 节点
`driverConfig.fields` 里一次声明,平台会**展开为多个 scalar 子节点**(每字段一个真实信号:
独立单位/量程/预警带/入库/告警),它们共享**同一次 broker 订阅**,报文按各自 `jsonPath` 扇出:

```json
{
  "name": "环境站",
  "driver": "mqtt",
  "templateRef": "daq-temp-tc",
  "lineId": "ln-xxxx",
  "driverConfig": {
    "host": "127.0.0.1", "port": 1883, "topic": "factory/env/1", "qos": 0,
    "fields": {
      "temp":     { "path": "data.temp", "unit": "℃", "min": 0, "max": 60, "warnHigh": 45 },
      "humidity": { "path": "data.humidity", "unit": "%", "min": 0, "max": 100, "warnLow": 20, "warnHigh": 80 },
      "dew":      "data.nested.dew"
    }
  }
}
```

- `fields` 支持**对象**(键=字段名,值=路径字符串或 `{path,unit,min,max,warnLow,warnHigh,decimals,templateRef,name,semantics}`)
  或**数组**(`["data.temp","data.humidity"]`,字段名取路径末段);`fieldsBase` 可给公共前缀。
- 响应返回 `{nodes, groupId, count}`;子节点 `name = <父名>·<字段名>`,视图额外带
  `fieldGroup`(同组 id)与 `fieldLabel`,查询/告警/面板按普通节点使用。
- 约束:仅 `mqtt` 驱动、仅 `scalar` 模板;与 `pointsPath`/`metricsPath`/`imagePath`/`decoder`
  互斥;最多 64 字段;任一字段非法则整组回滚(不会留下半套节点)。
- 采集侧一次订阅多次解析:同一报文到达时各子节点时间戳一致(可在 `daq_samples` 直接看到
  4 个节点同 ts 落库),避免多份连接/多次订阅。

**自定义解析(统一接口,交给用户)**:插件在 `setup(ctx)` 中注册解码器:

```js
export default {
  name: 'my-mqtt-sink',
  setup(ctx) {
    ctx.daq.registerDecoder('my-json', (input) => {
      const j = JSON.parse(input.raw)                 // input: raw/bytes/json/config/signalKind/nodeId
      return { kind: 'scalar', value: j.a + j.b }     // 或 {kind:'vector',points:[...]} / {kind:'image',blob,mime,width,height}
    })
  },
}
```

节点 `driverConfig.decoder = 'my-json'` 即启用(优先于声明式路径);解码结果必须与节点模板
的 `signalKind` 一致,否则节点 `lastError` 报错且不入库。自定义解码器是**同步纯函数**
(返回 Promise 会被拒绝),按插件归属注册、插件重载/停用自动撤销;`input.json` 已解析。
更重的帧加工请用 `ctx.daq.registerProcessor(kind, name, fn)` + 模板 `sink.processors`。
解析配置(路径/decoder 等)纳入订阅指纹:PATCH 节点解析配置会重建订阅立即生效。

> 边界:不解析 XML/HTML;图像仅接受 PNG/JPEG/WebP/BMP/GIF/TIFF(拒绝 SVG 等可执行内容),
> base64 上限 10MB(`imageMaxBytes`)、单边 ≤16384、像素 ≤16M,解压有界;非 PNG 需显式
> 宽高(`width/height` 或宽高路径;二进制 JPEG 用固定 `width/height`)与 MIME(`mimePath`
> 优先于静态 `imageMime`,data URL MIME 优先);null/boolean/空串不会被静默转成 0,
> 显式给出的宽高必须为正;保存后的节点测试按模板形态解码(添加向导按载荷自动识别);
> 图像 sink 的亮度/缩略图只理解本仓 8-bit 灰度 PNG(RGB/JPEG 可能不产生指标)。

## 写控安全链

所有下发(手动 REST / 配方批次 / Agent 工具)共用单一入口,顺序经过:

1. 网关/节点启停门控(停用节点一律拒绝);
2. 产线写控权限(operate 权限);
3. Agent 互斥与回退冷却(调控闭环护栏);
4. 安全量程 ∩ 活动配方工艺窗口联锁;
5. (manual 绑定模式)HITL 人工审批;
6. PLC 写入 → 回读校验(超容差判失败)→ 签名写历史。

> MQTT 写控:broker 的 QoS1 puback 只代表**链路受理**(transport-ack)。设备若在状态主题
> 回显设定值,节点配置 `readTopic`(如 `aw/sim/state`)+ `readJsonPath`(如 `setpoint`)
> 后,网关会在写后独立回读并判 `readback-verified`;未配置回读主题则如实记为
> `unverified`,不虚报设备生效。

配方参数引用的节点若已删除/停用/解绑,下发时自动跳过并在批次结果中记明原因,
界面与 Agent 侧同步显示「已停用 / 已取消绑定 / 已删除」。
