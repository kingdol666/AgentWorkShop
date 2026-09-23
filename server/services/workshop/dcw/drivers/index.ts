/**
 * DCW 写控制驱动族(mock / Modbus TCP / Modbus RTU / OPC UA / MQTT / HTTP)与注册表
 *
 * 由原单文件按职责拆分而来;此处保持**原文件的公开 API 与 import 路径不变**
 * (目录 index 解析),外部调用方无需改动。
 *
 * 模块划分:
 *   shared.ts              模块头 / 写读输入输出类型 / 工程量↔原始值纯函数
 *   mock.ts                mock 内置 PLC 模拟写驱动(确定性 ACK + 回读)
 *   modbus.ts              Modbus 读原语(TCP/RTU 共用)与 Modbus TCP 写驱动
 *   opcua.ts               OPC UA 写驱动(会话池复用 + 重试)
 *   modbus-rtu.ts          Modbus RTU over TCP 写驱动(串口网关透传)
 *   mqtt.ts                MQTT 写驱动(一次性连接发布,无回读)
 *   http.ts                HTTP/REST 写驱动(POST JSON;2xx 视为受理)
 *   registry.ts            内置驱动注册表 + 插件写驱动注册 + 目录/归一解析
 */
export { supportsDcwRead, engToRaw, rawToEng, encodeWords } from './shared'
export type { DcwWriteInput, DcwWriteResult, DcwWriteDriver, DcwReadInput, DcwReadResult } from './shared'
export { mockDcwDriver } from './mock'
export { modbusTcpDcwDriver } from './modbus'
export { opcUaDcwDriver } from './opcua'
export { modbusRtuDcwDriver } from './modbus-rtu'
export { mqttDcwDriver } from './mqtt'
export { httpDcwDriver } from './http'
export { registerPluginWriteDriver, listPluginWriteDrivers, listPluginWriteDriverMetas, clearPluginWriteDrivers, dcwDriverCatalog, normalizeDcwDriverKind, resolveDcwDriver } from './registry'
export type { PluginWriteDriverMeta } from './registry'
