/**
 * DAQ 协议驱动族(mock / Modbus TCP / OPC UA / Modbus RTU / MQTT / HTTP)与注册表
 *
 * 由原单文件按职责拆分而来;此处保持**原文件的公开 API 与 import 路径不变**
 * (目录 index 解析),外部调用方无需改动。
 *
 * 模块划分:
 *   shared.ts              模块头 / 依赖注入类型 / 驱动接口(DaqDriver 等)
 *   mock.ts                mock 内置模拟源
 *   modbus-tcp.ts          Modbus TCP 真实驱动(连接池按 host:port:unitId 复用)
 *   opcua.ts               OPC UA 真实驱动(会话池按 endpoint+账号 复用)
 *   modbus-rtu.ts          Modbus RTU over TCP 真实驱动(串口网关透传)
 *   mqtt.ts                MQTT 真实驱动(broker 连接池 + 订阅缓存)
 *   http.ts                HTTP/REST 轮询真实驱动
 *   s7-stub.ts             S7 预留(未安装栈时的显式拒绝桩)
 *   registry.ts            驱动注册表与旧命名归一解析
 */
export type { DaqSampleCtx, DaqDriverInput, DaqFrameSample, DaqDriver } from './shared'
export { mockDaqDriver } from './mock'
export { evictModbusConn, closeModbusSafely, withModbusConn, modbusKey, getModbusConn, decodeRegisters, registerOffset, classifyCommError, WORDS_OF, modbusTcpDriver } from './modbus-tcp'
export type { ModbusConn, ModbusTransport } from './modbus-tcp'
export { opcuaKey, getOpcUaConn, evictOpcUaConn, opcUaDriver } from './opcua'
export type { OpcUaConn } from './opcua'
export { modbusRtuDriver } from './modbus-rtu'
export { extractNumeric, parseHeaders, mqttDaqDriver } from './mqtt'
export type { MqttConn } from './mqtt'
export { httpDaqDriver } from './http'
export { registerPluginDriver, listPluginDrivers, clearPluginDrivers, listPluginDriverMetas, normalizeDriverKind, resolveDaqDriver, probeDriverAvailability, driverCatalog } from './registry'
export type { PluginDriverMeta } from './registry'
