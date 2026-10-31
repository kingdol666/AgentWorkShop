# 协议与数据形态能力矩阵

> 事实源:`shared/daq-protocol.ts`(DAQ 驱动目录/字段)、`shared/dcw-protocol/catalog.ts`(DCW 驱动目录/字段)、`server/services/workshop/daq/drivers/*`。插件可在运行期追加任意 kind,以 `GET /api/workshop/daq` / `/api/workshop/dcw` 返回的 `drivers[]` 为准。

## 1. 采集(DAQ)内置协议

| kind | 状态 | 标量 | 数组 | 图像 | 关键 driverConfig |
| --- | --- | --- | --- | --- | --- |
| `mock` | builtin | ✅ | ✅ | ✅ | 无;按模板 signalKind 生成 |
| `modbus-tcp` | real | ✅ | ❌ | ❌ | host/port(502)/unitId/register/registerType/dataType/scale/byteOrder |
| `modbus-rtu` | real | ✅ | ❌ | ❌ | 同 Modbus TCP,host 指向串口网关 |
| `opcua` | real | ✅ | ❌ | ❌ | endpoint/nodeId/securityMode/username/password/证书 |
| `mqtt` | real | ✅ | ✅ | ✅ | host/port/topic;`jsonPath`/`pointsPath`/`metricsPath`/`imagePath`/`fields`/`decoder` |
| `http` | real | ✅ | ✅ | ✅ | url/method/bodyTemplate/jsonPath/headersJSON/authType/secretRef/allowPrivateHost |
| `s7` | planned | ❌ | ❌ | ❌ | 占位 stub;需要插件或核心实现 |

HTTP 的 vector 用 `jsonPath`(缺省 `points`),image 用响应 `Content-Type: image/*` 或 JSON `png`/`blob`;它不支持 MQTT 的 `pointsPath`/`imagePath` 字段名,按矩阵配会读到空路径。

MQTT 多字段:`driverConfig.fields` 一次展开为 N 个 scalar 节点,共享同一 `(broker, topic)` 订阅;`fieldsBase` 提供公共前缀。字段项可带 `unit/min/max/warnLow/warnHigh/decimals/templateRef/name/semantics`。与 `pointsPath/metricsPath/imagePath/decoder` 互斥。

插件驱动示例:`serial`(串口 Modbus RTU + ASCII 行协议),`matrix-thermo`(自定义 HTTP 设备 + 补偿算法),以及 `daq-vector-demo`/`daq-sink-verify` 等测试插件。

## 2. 写控(DCW)内置协议

| kind | 状态 | 写 | 读回 | 历史 | 关键 driverConfig |
| --- | --- | --- | --- | --- | --- |
| `mock` | builtin | ✅ | — | — | 无 |
| `modbus-tcp` | real | ✅ | ✅ 同址回读 | — | host/port/unitId/register/dataType/byteOrder/engMin~rawMin 映射 |
| `modbus-rtu` | real | ✅ | ✅ | — | 同上,host 指向网关 |
| `opcua` | real | ✅ | ✅ | — | endpoint/nodeId/securityMode/证书 |
| `mqtt` | real | ✅ | ✅ 需 `readTopic` | — | host/port/topic/jsonKey/jsonTemplate/qos/readTopic/readJsonPath |
| `http` | real | ✅ | — | — | url/bodyKey/headersJSON/authType/secretRef/allowPrivateHost |
| `mes-rest` | real | ✅ | ✅ readMap | ✅ historyMap | baseUrl/authType/secretRef/readMap/writeMap/historyMap/writeHook/writeCheckHook |

MQTT 写载荷三档:`jsonTemplate`(带 `{{value}}` 的 JSON 模板,可嵌套/多静态字段)> `jsonKey`(`{"键":值}`)> 裸数值。模板渲染后必须是合法 JSON,与 `jsonKey` 互斥;创建/PATCH 期即校验。

HTTP 写载荷:`bodyKey` 留空 → `{"value": 设定值}`;填写 → `{"键": 设定值}`。需要多字段/自定义结构时用 `mes-rest` 的 `writeMap`/`writeHook`,或写插件 `DcwWriteDriver`。

## 3. 数据形态与硬限制

| 形态 | 载体 | 限制 |
| --- | --- | --- |
| scalar | `daq_samples.value` double | 有限数值;状态 ok/warn/alarm/offline |
| vector | `daq_frames.meta.points` JSONB | 1~4096 个有限数;`points` 列存点数;`metrics` 存派生指标 |
| image | 对象存储 blob + `daq_frames.meta` | **限制按入口不同**:MQTT/decoder 路径 ≤10MB、≤1600 万像素、单边 ≤16384、仅 PNG/JPEG/WebP/BMP/GIF/TIFF(拒绝 SVG);外部 ingest 仅查 ≤10MB 且 `image/*`(**当前允许 SVG,是缺口**);HTTP DAQ 不限大小、Content-Type 以 `image/` 为准;驱动直接返回的帧绕过这些检查。`meta={objectKey,thumbKey,mime,width,height,sha256,size}` |
| metrics | `daq_frames.metrics` JSONB | 数值字段 ≤64 个 |
| text/enum/boolean | — | **不支持**时序存储 |
| 任意文件/音频/视频/表格 | — | **不支持**;MES `table/event` 走数据集 CSV/JSONL,不进 DAQ TSDB |

时间窗参数:`/samples` 与 `/frames` 用 `from`/`to`(epoch ms);MES `mes_fetch` 用 `from`/`to`(ISO 字符串),不要混。

## 4. 能力匹配 → 扩展面

| 文档里的形态 | 可用内置? | 缺口 | 扩展面 |
| --- | --- | --- | --- |
| Modbus 单寄存器/多寄存器标量 | ✅ | — | — |
| Modbus 一次读一块寄存器成数组 | ❌ | 批量读+组帧 | 插件 `DaqDriver.sample()` 返回 vector 帧 |
| OPC UA 单 nodeId | ✅ | — | — |
| OPC UA 数组/结构体 | ❌ | 解析数组 | 插件 `DaqDriver` 或 `decoder` |
| MQTT 单字段 | ✅ `jsonPath` | — | — |
| MQTT 同 topic 多字段 | ✅ `fields` | — | 每字段一个节点 |
| MQTT 数组 | ✅ `pointsPath` + vector 模板 | — | — |
| HTTP 数组 | ✅ `jsonPath` + vector 模板 | — | — |
| MQTT 图像 | ✅ `imagePath`/binary | — | — |
| HTTP 图像 | ✅ Content-Type `image/*` 或 JSON `png`/`blob` | — | — |
| 私有二进制帧(校验和/会话) | ❌ | 解帧 | 插件 `decoder`(同步纯函数)或 `DaqDriver` |
| 私有写帧(多动态值/CRC/握手) | ❌ | 组帧+应答 | 插件 `DcwWriteDriver.write()` |
| MES REST 标量/向量/图像/table/event | ✅ `historyMap.response.format` | — | — |
| 串口 Modbus RTU / ASCII | ✅ `serial-bridge` 插件 | — | — |
| S7 / 其它 PLC 协议 | ❌(stub) | 协议栈 | 插件 `DaqDriver`/`DcwWriteDriver` |
| 文本/枚举/文件 | ❌ | 新 signalKind + 存储/查询 | **核心扩展,不是插件面** |

## 5. 关键 API 与工具

| 用途 | REST | MCP |
| --- | --- | --- |
| 实例/鉴权 | `GET /api/health` | `aw_status`、`aw_login` |
| 驱动目录/节点 | `GET /api/workshop/daq`、`GET /api/workshop/dcw` | `aw_request` |
| 连通测试 | `POST /api/workshop/daq/test-driver`、`mes-test-read` | `aw_request` |
| 建线/节点/配方 | `POST /api/workshop/dcw/lines`、`POST /api/workshop/daq`、`POST /api/workshop/dcw` | `aw_line_create`、`aw_daq_create`、`aw_dcw_create`、`aw_recipe_create` |
| 样本/帧 | `GET /api/workshop/daq/:id/samples`、`/frames` | `aw_daq_samples`、`aw_request` |
| 外部推送 | `POST /api/workshop/daq/:id/ingest` | `aw_request` |
| 插件 | `GET /api/plugins/manifest` | `aw_plugin_list`、`aw_plugin_toggle` |

## 6. 常见失败语义

| 现象 | 含义 | 处置 |
| --- | --- | --- |
| 400 `templateRef 必填` | 建节点缺模板 | 补 `templateRef`(内置如 `daq-temp-tc` / `temp-sp`) |
| 400 `未知数采模板` | 模板 key 不存在 | 先 `GET /api/workshop/daq` 的 `templates[]` |
| 400 `fields 与 pointsPath 互斥` | 多字段与数组/图像混用 | 拆成两组节点 |
| 401 | 鉴权/产线权限不足 | `aw_login`;确认对该线有 operate/readonly |
| 404 `工艺参数不存在` | 写到了 `dw-` 执行节点而非 `pp-` 参数映射 | 用 `/api/workshop/dcw/params?lineId=` 解析 `pp-` id |
| 409 | 重名/在飞写/单实例锁 | 查既有资源;不要重启 |
| 采样恒值/超时 | 端点不可达、量纲错、模拟器 tick 死 | 先连通测试;再看驱动 `lastError` |
| `transport-ack` | 仅链路受理,设备未证实 | 配 `readTopic` 或独立 DAQ 观测点做物理跟随 |
