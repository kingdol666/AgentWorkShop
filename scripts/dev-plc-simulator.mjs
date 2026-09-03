/**
 * PLC 工艺过程模拟器 —— 真实场景接入用(Modbus TCP 从站,modbus-serial ServerTCP)。
 *
 * 仿真对象:涂布产线烘干单元。与「只摆寄存器」的演示从站不同,本模拟器带工艺动力学:
 *   - 过程值 PV 对设定值 SP 呈一阶惯性响应(PV' = PV + (SP−PV)·(1−e^(−dt/τ)) + 噪声)
 *   - SP 变更按斜率限制爬升(驱动/加热器执行器速率)——真实 PLC 变频器语义
 *   - 停机(线圈0=false)时 PV 自由衰减;环境温度慢漂移
 *   - 状态字 40011(uint16):bit0 运行 / bit1 加热中 / bit2 报警(温度偏差 >12℃)
 *
 * 寄存器布局(float32 大端,4xxxx 保持寄存器,协议偏移 = 地址 − 40001):
 *   40001 温度PV  40003 速度PV  40005 张力PV   40011 状态字(uint16)   40031 环境温度
 *   40021 温度SP  40023 速度SP  40025 张力SP(可写)
 *   线圈: 0=运行使能(on)  1=加热使能(on)
 *
 * 设计:工艺状态 = JS 数值(每 tick 刷新进字数组);Modbus 写只改 SP 字并解包回状态。
 * 运行: node scripts/dev-plc-simulator.mjs [--port 15040]
 */
import ModbusRTU from 'modbus-serial'

const args = process.argv.slice(2)
const portIx = args.indexOf('--port')
const PORT = portIx >= 0 ? Number(args[portIx + 1]) : 15040

// ---- 字镜像(协议偏移 → uint16;与 dev-modbus-simulator 同构的数组载体) ----
const HOLDING = new Array(100).fill(0)
const COILS = [true, true] // 0=运行使能 1=加热使能

// ---- 工艺回路(τ 一阶时间常数;rate 执行器斜率/秒;sigma 过程噪声) ----
const CIRCUITS = [
  { name: '温度', pvOff: 0, spOff: 20, pv: 0, sp: 0, ramped: 0, tau: 8, rate: 5, sigma: 0.25 },
  { name: '速度', pvOff: 2, spOff: 22, pv: 0, sp: 0, ramped: 0, tau: 4, rate: 8, sigma: 0.6 },
  { name: '张力', pvOff: 4, spOff: 24, pv: 0, sp: 0, ramped: 0, tau: 6, rate: 3, sigma: 0.15 },
]
const DT_MS = 500
const AMBIENT = 24 + Math.random() * 3
CIRCUITS[0].pv = AMBIENT

const wordsOf = (v) => {
  const b = Buffer.alloc(4)
  b.writeFloatBE(Number.isFinite(v) ? v : 0, 0)
  return [b.readUInt16BE(0), b.readUInt16BE(2)]
}
const valOf = (off) => {
  const b = Buffer.alloc(4)
  b.writeUInt16BE(HOLDING[off] ?? 0, 0)
  b.writeUInt16BE(HOLDING[off + 1] ?? 0, 2)
  return b.readFloatBE(0)
}

// 初始化:SP=0;温度 PV 从环境温度起步
for (const c of CIRCUITS) {
  const [hi, lo] = wordsOf(c.sp)
  HOLDING[c.spOff] = hi
  HOLDING[c.spOff + 1] = lo
}
{
  const [hi, lo] = wordsOf(CIRCUITS[0].pv)
  HOLDING[0] = hi
  HOLDING[1] = lo
}

const ramped = new Map(CIRCUITS.map(c => [c.name, 0]))
let ambient = AMBIENT
let tickN = 0
let statusWord = 1

function step() {
  const dt = DT_MS / 1000
  tickN++
  ambient = AMBIENT + Math.sin(tickN / 600) * 1.2
  const run = COILS[0]
  const heat = COILS[1]
  for (const c of CIRCUITS) {
    // 执行器斜率限制(设定值爬坡)
    const target = run ? c.sp : 0
    const r = ramped.get(c.name)
    if (Math.abs(target - r) <= c.rate * dt) ramped.set(c.name, target)
    else ramped.set(c.name, r + Math.sign(target - r) * c.rate * dt)
    // 加热线圈断开 → 温度回路失去能量,目标回落环境温度
    const eff = c.name === '温度' && !heat ? ambient : ramped.get(c.name)
    // 一阶惯性 + 过程噪声
    const gain = 1 - Math.exp(-dt / c.tau)
    const noise = (Math.random() - 0.5) * 2 * c.sigma * Math.sqrt(dt * 2)
    c.pv = Math.max(-50, c.pv + (eff - c.pv) * gain + noise)
    const [hi, lo] = wordsOf(c.pv)
    HOLDING[c.pvOff] = hi
    HOLDING[c.pvOff + 1] = lo
  }
  const t = CIRCUITS[0]
  statusWord = (run ? 1 : 0) | (heat && t.sp - t.pv > 0.5 ? 2 : 0) | (run && Math.abs(t.sp - t.pv) > 12 ? 4 : 0)
  HOLDING[40011 - 40001] = statusWord
  const [ah, al] = wordsOf(ambient)
  HOLDING[40031 - 40001] = ah
  HOLDING[40031 - 40001 + 1] = al
}
setInterval(step, DT_MS)

// ---- SP 写入 → 解包回工艺状态(下次 step 以新 SP 爬坡) ----
const CIRCUIT_SP = new Map([[20, CIRCUITS[0]], [22, CIRCUITS[1]], [24, CIRCUITS[2]]])
function resyncPair(off) {
  const c = CIRCUIT_SP.get(off)
  if (c) {
    c.sp = valOf(off)
    console.log(`[plc] WRITE ${c.name}SP ${40001 + off} ← ${c.sp.toFixed(3)}`)
  }
}

// ---- Modbus 从站载体(与 dev-modbus-simulator 同构) ----
const vector = {
  getHoldingRegister: addr => HOLDING[addr] ?? 0,
  getMultipleHoldingRegisters: (addr, length) => HOLDING.slice(addr, addr + length),
  setRegister: (addr, value) => {
    console.log(`[plc:dbg] setRegister addr=${addr} value=${value} → HOLDING[${addr}]=${value & 0xFFFF}`)
    HOLDING[addr] = value & 0xFFFF
    resyncPair(addr)
    resyncPair(addr - 1) // 本字可能是某 SP 对的低位字
  },
  setMultipleRegisters: (addr, values) => {
    for (let i = 0; i < values.length; i++) HOLDING[addr + i] = values[i] & 0xFFFF
    resyncPair(addr)
  },
  readCoils: () => COILS.slice(),
  readDiscreteInputs: () => new Array(16).fill(false),
  readInputRegisters: (addr, length) => HOLDING.slice(addr, addr + length),
  writeCoil: (addr, value) => { COILS[addr] = value },
  writeMultipleCoils: () => {},
}

const server = new ModbusRTU.ServerTCP(vector, { host: '0.0.0.0', port: PORT, debug: false })
server.on('initialized', () => {
  console.log(`[plc] 烘干单元模拟器就绪 pid=${process.pid} 0.0.0.0:${PORT} unitId=1`)
  console.log(`[plc] 回路: ${CIRCUITS.map(c => `${c.name}(PV 4${40001 + c.pvOff}/SP 4${40021 + c.spOff - 20},τ=${c.tau}s,rate=${c.rate}/s)`).join(' | ')}`)
  console.log(`[plc] 环境温度 ${AMBIENT.toFixed(1)}℃ · 线圈 0=运行(on) 1=加热(on)`)
})
server.on('socket', () => {})
process.on('SIGINT', () => {
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 500)
})
