/**
 * Modbus TCP 从站模拟器 —— 真实驱动的数据源(产线 PLC 仿真)。
 * 保持寄存器 40001~40008:40001/40002 = float32 大端"熔体压力"(MPa,0.60~1.10 波动),
 * 40003/40004 = float32"温度"(℃ 165~175)。端口 1502。
 * 用途:开发/验收环境跑真实 Modbus 驱动链路(非 mock 路径)。
 */
import ModbusRTU from 'modbus-serial'

const HOLDING = new Array(100).fill(0)
let t = 0

function float32BE_WORDS(value) {
  const buf = Buffer.alloc(4)
  buf.writeFloatBE(value, 0)
  // Modbus 保持寄存器按字传输,每字大端:word0 = 高 16 位
  return [buf.readUInt16BE(0), buf.readUInt16BE(2)]
}

setInterval(() => {
  t += 1
  const pressure = 0.85 + Math.sin(t * 0.05) * 0.12 + (Math.random() - 0.5) * 0.04
  const temp = 170 + Math.sin(t * 0.03) * 3 + (Math.random() - 0.5) * 1.2
  const [p0, p1] = float32BE_WORDS(Number(pressure.toFixed(3)))
  const [t0, t1] = float32BE_WORDS(Number(temp.toFixed(2)))
  HOLDING[0] = p0
  HOLDING[1] = p1
  HOLDING[2] = t0
  HOLDING[3] = t1
}, 1000)

const vector = {
  getHoldingRegister(addr) {
    return HOLDING[addr] ?? 0
  },
  getMultipleHoldingRegisters(addr, length) {
    return HOLDING.slice(addr, addr + length)
  },
}

const server = new ModbusRTU.ServerTCP(vector, { host: '0.0.0.0', port: 1502, debug: false })
server.on('initialized', () => console.log('[modbus-sim] 从站就绪 0.0.0.0:1502(40001 压力 float32 / 40003 温度 float32)'))
server.on('socket', () => {})

process.on('SIGINT', () => {
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 500)
})
