/**
 * serial-bridge —— 纯协议层(零 I/O,可独立单测)。
 *
 * 串口链路上的两种报文语义:
 *  - modbus-rtu:Modbus RTU over RS-485/232(CRC16 帧;寄存器读 FC03/FC04,写 FC06/FC16);
 *    帧的收发与超时由 modbus-serial 承担,本层提供 CRC/编解码与寄存器↔工程量换算,
 *    与内置 modbus-tcp / dcw 写驱动逐字节兼容(big/little/wordSwap 同一字节序约定)。
 *  - ascii-line:设备每行输出一个数值(裸数字或 JSON,如 `{"temp":25.3}`);按 jsonPath 取值。
 *
 * 本文件不 import 任何宿主模块 —— 测试脚本直接以 ESM 引入即可。
 */

// ============================================================
// 配置规范化(driverConfig → 强类型连接参数)
// ============================================================

const MODES = new Set(['modbus-rtu', 'ascii-line'])
const PARITIES = new Set(['none', 'even', 'odd'])
const DATA_TYPES = new Set(['int16', 'uint16', 'int32', 'uint32', 'float32'])
const BYTE_ORDERS = new Set(['big', 'little', 'wordSwap'])
export const WORDS_OF = { int16: 1, uint16: 1, int32: 2, uint32: 2, float32: 2 }

/**
 * 规范化并校验串口驱动配置;返回 { cfg, errors }。
 * errors 非空时 cfg 仍给出(缺省补齐),调用方决定是否以 errors 拒绝。
 */
export function normalizeSerialConfig(raw = {}) {
  const errors = []
  const s = v => String(v ?? '').trim()
  const cfg = {
    mode: MODES.has(s(raw.mode)) ? s(raw.mode) : 'modbus-rtu',
    path: s(raw.path),
    baudRate: Number(raw.baudRate) > 0 ? Number(raw.baudRate) : 9600,
    dataBits: [7, 8].includes(Number(raw.dataBits)) ? Number(raw.dataBits) : 8,
    stopBits: [1, 2].includes(Number(raw.stopBits)) ? Number(raw.stopBits) : 1,
    parity: PARITIES.has(s(raw.parity)) ? s(raw.parity) : 'none',
    unitId: Number(raw.unitId) > 0 ? Math.min(247, Math.floor(Number(raw.unitId))) : 1,
    register: Number.isFinite(Number(raw.register)) ? Number(raw.register) : 0,
    registerType: s(raw.registerType) === 'input' ? 'input' : 'holding',
    dataType: DATA_TYPES.has(s(raw.dataType)) ? s(raw.dataType) : 'float32',
    byteOrder: BYTE_ORDERS.has(s(raw.byteOrder)) ? s(raw.byteOrder) : 'big',
    scale: Number.isFinite(Number(raw.scale)) && Number(raw.scale) !== 0 ? Number(raw.scale) : 1,
    jsonPath: s(raw.jsonPath),
    /** ascii-line 写模板({v} 替换为数值;行尾 \n 自动补) */
    writeTemplate: s(raw.writeTemplate),
    /** ascii-line 数据保鲜窗(超过视为停发,采样返回 null 跳帧,不重复消费陈旧值) */
    staleMs: Number(raw.staleMs) > 0 ? Number(raw.staleMs) : 30_000,
    /** 单次串口事务超时(建连/响应共用;半开链路防悬挂) */
    timeoutMs: Number(raw.timeoutMs) > 0 ? Math.min(10_000, Number(raw.timeoutMs)) : 3000,
  }
  if (!cfg.path) errors.push('缺少串口路径 path(Windows 如 COM3,Linux 如 /dev/ttyUSB0)')
  if (!MODES.has(s(raw.mode)) && s(raw.mode)) errors.push(`mode 非法: ${s(raw.mode)}(仅 modbus-rtu / ascii-line)`)
  if (cfg.mode === 'modbus-rtu' && raw.register == null) errors.push('modbus-rtu 模式缺少寄存器地址 register(如 40001)')
  return { cfg, errors }
}

/** 4xxxx 保持寄存器 → 协议偏移(40001 → 0);3xxxx 输入寄存器同理(与内置 modbus 驱动同规约) */
export function registerOffset(addr, area) {
  if (area === 'input') return addr >= 30001 ? addr - 30001 : addr
  return addr >= 40001 ? addr - 40001 : addr
}

// ============================================================
// Modbus RTU 帧(CRC16;诊断/探针与单测用 —— 常规收发走 modbus-serial)
// ============================================================

/** Modbus CRC16(多项式 0xA001 反射;返回 16 位无符号) */
export function crc16Modbus(buf) {
  let crc = 0xFFFF
  for (const byte of buf) {
    crc ^= byte & 0xFF
    for (let i = 0; i < 8; i++) {
      if (crc & 1) crc = (crc >> 1) ^ 0xA001
      else crc >>= 1
    }
  }
  return crc & 0xFFFF
}

/** 构造 RTU 请求帧:addr + func + payload + CRC(lo hi) */
export function buildRtuFrame(addr, func, payload = []) {
  const body = Buffer.from([addr & 0xFF, func & 0xFF, ...payload])
  const crc = crc16Modbus(body)
  return Buffer.concat([body, Buffer.from([crc & 0xFF, (crc >> 8) & 0xFF])])
}

/**
 * 解析 RTU 响应帧(不含地址校验——单从站总线由调用方关注):
 * 返回 { addr, func, data:Buffer } | { error:'crc'|'short' }
 */
export function parseRtuFrame(buf) {
  if (!buf || buf.length < 4) return { error: 'short' }
  const crc = buf.readUInt16LE(buf.length - 2)
  if (crc !== crc16Modbus(buf.subarray(0, buf.length - 2))) return { error: 'crc' }
  return { addr: buf[0], func: buf[1] & 0x7F, data: buf.subarray(2, buf.length - 2) }
}

// ============================================================
// 寄存器字 ↔ 数值(与内置数采 decodeRegisters / 写控 encodeWords 逐字节一致)
// ============================================================

const hi = x => (x >> 8) & 0xFF
const lo = x => x & 0xFF

/** 寄存器字序 → 数值(1~2 word;big=ABCD / little=DCBA / wordSwap=CDAB) */
export function decodeRegisters(data, dataType, byteOrder) {
  if (dataType === 'int16' || dataType === 'uint16') {
    const raw = data[0] ?? 0
    return dataType === 'int16' ? (raw << 16) >> 16 : raw
  }
  let b
  if (byteOrder === 'little') b = [hi(data[1]), lo(data[1]), hi(data[0]), lo(data[0])].reverse()
  else if (byteOrder === 'wordSwap') b = [hi(data[1]), lo(data[1]), hi(data[0]), lo(data[0])]
  else b = [hi(data[0]), lo(data[0]), hi(data[1]), lo(data[1])]
  const buf = Buffer.from(b)
  if (dataType === 'float32') return buf.readFloatBE(0)
  if (dataType === 'uint32') return buf.readUInt32BE(0)
  return buf.readInt32BE(0)
}

/** 数值 → 寄存器字序(decodeRegisters 的逆;写驱动 FC06/FC16 用) */
export function encodeWords(raw, dataType, byteOrder) {
  if (dataType === 'int16' || dataType === 'uint16') return [raw & 0xFFFF]
  const buf = Buffer.alloc(4)
  if (dataType === 'float32') buf.writeFloatBE(raw, 0)
  else if (dataType === 'uint32') buf.writeUInt32BE(raw, 0)
  else buf.writeInt32BE(raw, 0)
  const B = [buf[0], buf[1], buf[2], buf[3]]
  const word = (a, b) => ((a & 0xFF) << 8) | (b & 0xFF)
  if (byteOrder === 'little') return [word(B[1], B[0]), word(B[3], B[2])]
  if (byteOrder === 'wordSwap') return [word(B[2], B[3]), word(B[0], B[1])]
  return [word(B[0], B[1]), word(B[2], B[3])]
}

// ============================================================
// 工程量 ↔ 原始值(写控线性映射;与 dcw/drivers.ts 同语义)
// ============================================================

const num = (v) => {
  const n = Number(v)
  return v !== '' && v != null && Number.isFinite(n) ? n : undefined
}

/** 工程量 → 原始值(未提供 rawMin/rawMax 时直传) */
export function engToRaw(eng, cfg, domain = { min: 0, max: 100 }) {
  const rawMin = num(cfg.rawMin)
  const rawMax = num(cfg.rawMax)
  if (rawMin === undefined || rawMax === undefined || rawMax === rawMin) return eng
  const engMin = num(cfg.engMin) ?? domain.min
  const engMax = num(cfg.engMax) ?? domain.max
  if (engMax === engMin) return rawMin
  return rawMin + ((eng - engMin) / (engMax - engMin)) * (rawMax - rawMin)
}

/** 原始值 → 工程量(engToRaw 的逆;回读换算用) */
export function rawToEng(raw, cfg, domain = { min: 0, max: 100 }) {
  const rawMin = num(cfg.rawMin)
  const rawMax = num(cfg.rawMax)
  if (rawMin === undefined || rawMax === undefined || rawMax === rawMin) return raw
  const engMin = num(cfg.engMin) ?? domain.min
  const engMax = num(cfg.engMax) ?? domain.max
  if (rawMax === rawMin) return engMin
  return engMin + ((raw - rawMin) / (rawMax - rawMin)) * (engMax - engMin)
}

// ============================================================
// ASCII 行取值(裸数字直取;JSON 按 jsonPath 点分路径,含数组下标)
// ============================================================

/** 从一行报文提取数值;无法提取返回 null(不抛,采样循环靠 null 跳帧) */
export function extractLineValue(text, jsonPath) {
  const trimmed = String(text ?? '').trim()
  if (!trimmed) return null
  const direct = Number(trimmed)
  if (Number.isFinite(direct)) return direct
  let parsed
  try {
    parsed = JSON.parse(trimmed)
  }
  catch {
    return null
  }
  const target = jsonPath
    ? String(jsonPath).split('.').reduce((acc, k) => (acc == null ? undefined : acc[k]), parsed)
    : parsed
  const n = typeof target === 'number' ? target : Number(target)
  return Number.isFinite(n) ? n : null
}

// ============================================================
// 通信故障分类(与内置 classifyCommError 同风格;串口特化)
// ============================================================

export function classifySerialError(err) {
  const raw = err instanceof Error ? err.message : String(err)
  const m = raw.toLowerCase()
  if (/no such file|device not found|file not found|access denied|拒绝访问|找不到/.test(m))
    return `串口不存在或被占用——检查设备插入/驱动与路径拼写,关闭占用该口的程序(${raw})`
  if (/timeout|timed out/.test(m))
    return `串口响应超时——检查波特率/校验位/从站地址与接线(${raw})`
  if (/crc/.test(m))
    return `CRC 校验失败——线路干扰或波特率/校验位不匹配(${raw})`
  if (/illegal|exception|function code/.test(m))
    return `设备拒绝该操作——功能码或寄存器地址不被支持(${raw})`
  if (/port is not open|closing|closed/.test(m))
    return `串口已断开——将自动重建,若持续失败请检查线缆(${raw})`
  return raw
}
