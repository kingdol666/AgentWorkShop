/**
 * 寄存器编码(信号值 → 1~2 word) —— 与 AgentWorkShop daq/drivers.ts decodeRegisters
 * 完全对称的编码侧。字节序约定(寄存器字 w0=[A B], w1=[C D]):
 *   big     = ABCD(w0 高字在前,w0/w1 各自大端)—— Modbus 标准大端,最常用
 *   little  = DCBA(全小端:w1 字节反转在前)
 *   wordSwap = CDAB(字交换:每字内部仍大端,低字在前)
 */
export const WORDS_OF: Record<string, number> = { int16: 1, uint16: 1, int32: 2, uint32: 2, float32: 2 }

/** 信号值 → 寄存器 words(按 dataType/byteOrder 编码) */
export function encodeRegisters(value: number, dataType: string, byteOrder: string): number[] {
  if (dataType === 'int16' || dataType === 'uint16') {
    const raw = dataType === 'int16' ? (Math.round(value) << 16) >> 16 : Math.round(value) & 0xFFFF
    return [raw & 0xFFFF]
  }
  // 4 字节缓冲(writeFloatBE 大端 → [A,B,C,D])
  const buf = Buffer.alloc(4)
  if (dataType === 'float32') buf.writeFloatBE(value, 0)
  else if (dataType === 'uint32') buf.writeUInt32BE(Math.round(value) >>> 0, 0)
  else buf.writeInt32BE(Math.round(value), 0)
  const [A, B, C, D] = [buf[0], buf[1], buf[2], buf[3]]
  // 与主项目 decodeRegisters 逐字配对(已用其公式反推):
  //   big     → w0=[A,B] w1=[C,D]
  //   little  → w0=[B,A] w1=[D,C](每字内部小端,高字装 [D,C])
  //   wordSwap → w0=[C,D] w1=[A,B]
  switch (byteOrder) {
    case 'little': return [((B << 8) | A) & 0xFFFF, ((D << 8) | C) & 0xFFFF]
    case 'wordSwap': return [((C << 8) | D) & 0xFFFF, ((A << 8) | B) & 0xFFFF]
    default: return [((A << 8) | B) & 0xFFFF, ((C << 8) | D) & 0xFFFF]
  }
}

/** 寄存器 words → 信号值(与主项目 decodeRegisters 对称;外部写回灌用) */
export function decodeRegisters(words: number[], dataType: string, byteOrder: string): number {
  if (dataType === 'int16' || dataType === 'uint16') {
    const raw = words[0] ?? 0
    return dataType === 'int16' ? (raw << 16) >> 16 : raw
  }
  const hi = (x: number) => (x >> 8) & 0xFF
  const lo = (x: number) => x & 0xFF
  let b: number[]
  if (byteOrder === 'little') b = [hi(words[1]!), lo(words[1]!), hi(words[0]!), lo(words[0]!)].reverse()
  else if (byteOrder === 'wordSwap') b = [hi(words[1]!), lo(words[1]!), hi(words[0]!), lo(words[0]!)]
  else b = [hi(words[0]!), lo(words[0]!), hi(words[1]!), lo(words[1]!)]
  const buf = Buffer.from(b)
  if (dataType === 'float32') return buf.readFloatBE(0)
  if (dataType === 'uint32') return buf.readUInt32BE(0)
  return buf.readInt32BE(0)
}

/** 4xxxx 保持寄存器 → 协议偏移(40001 → 0);3xxxx 输入寄存器同理(与主项目同约定) */
export function registerOffset(addr: number, area: string): number {
  if (area === 'input') return addr >= 30001 ? addr - 30001 : addr
  return addr >= 40001 ? addr - 40001 : addr
}

/** CRC16(Modbus RTU,多项式 0xA001)—— raw-rtu 模式用 */
export function crc16(buf: Buffer): number {
  let crc = 0xFFFF
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i]
    for (let b = 0; b < 8; b++) {
      if (crc & 0x0001) { crc >>= 1; crc ^= 0xA001 }
      else crc >>= 1
    }
  }
  return crc
}
