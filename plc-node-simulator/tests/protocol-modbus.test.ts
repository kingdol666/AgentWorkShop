/**
 * 协议自测 —— Modbus TCP + RTU(真实 modbus-serial 客户端,与主项目驱动同栈)。
 * 覆盖:FC03 读 float32 big / FC16 写 SP → 同址回读一致(DCW 语义) / first-order SP 回灌。
 */
import ModbusRTU from 'modbus-serial'

let passed = 0
let failed = 0
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { passed++; console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`) }
  else { failed++; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`) }
}

/** 与主项目 daq/drivers.ts decodeRegisters 同约定 */
function decodeRegisters(data: number[], dataType: string, byteOrder: string): number {
  if (dataType === 'int16' || dataType === 'uint16') {
    const raw = data[0] ?? 0
    return dataType === 'int16' ? (raw << 16) >> 16 : raw
  }
  const hi = (x: number) => (x >> 8) & 0xFF
  const lo = (x: number) => x & 0xFF
  let b: number[]
  if (byteOrder === 'little') b = [hi(data[1]!), lo(data[1]!), hi(data[0]!), lo(data[0]!)].reverse()
  else if (byteOrder === 'wordSwap') b = [hi(data[1]!), lo(data[1]!), hi(data[0]!), lo(data[0]!)]
  else b = [hi(data[0]!), lo(data[0]!), hi(data[1]!), lo(data[1]!)]
  const buf = Buffer.from(b)
  if (dataType === 'float32') return buf.readFloatBE(0)
  if (dataType === 'uint32') return buf.readUInt32BE(0)
  return buf.readInt32BE(0)
}

const nodes = (await (await fetch('http://127.0.0.1:4010/api/nodes')).json()).data as Array<{ id: string, protocol: string, signals: Array<{ id: string, value: number }> }>

// ── Modbus TCP 从站(16040) ──
{
  const dev = nodes.find(n => n.protocol === 'modbus-tcp')
  if (!dev) throw new Error('FAIL 无 modbus-tcp 设备')
  const client = new ModbusRTU()
  client.setTimeout(3000)
  await client.connectTCP('127.0.0.1', { port: 16040 })
  client.setID(1)
  check('TCP 从站连接 16040', true)

  const pv = decodeRegisters((await client.readHoldingRegisters(0, 2)).data as number[], 'float32', 'big')
  check('FC03 读 温度PV(40001 float32)', pv >= 0 && pv <= 260, `value=${pv.toFixed(1)}℃`)
  const pressure = decodeRegisters((await client.readHoldingRegisters(2, 2)).data as number[], 'float32', 'big')
  check('FC03 读 压力PV(40003 float32)', pressure >= 0 && pressure <= 2, `value=${pressure.toFixed(3)}MPa`)

  // DCW 语义:FC16 写 SP → 同址回读一致(SP 取当前 PV +10:不论模拟器已运行多久,PV 都有上升空间)
  const target = Math.round(pv + 10)
  const buf = Buffer.alloc(4)
  buf.writeFloatBE(target, 0)
  await client.writeRegisters(20, [buf.readUInt16BE(0), buf.readUInt16BE(2)])
  const readback = decodeRegisters((await client.readHoldingRegisters(20, 2)).data as number[], 'float32', 'big')
  check('FC16 写 SP=PV+10 → 同址回读一致', Math.abs(readback - target) < 0.01, `readback=${readback}`)

  // first-order 回灌:PV 应随 SP 收敛(等待 3s;τ=8s 下 3s 收敛约 31% 间隙 ≈ +3.1℃,远超噪声)
  const pvBefore = pv
  await new Promise(r => setTimeout(r, 3000))
  const pvAfter = decodeRegisters((await client.readHoldingRegisters(0, 2)).data as number[], 'float32', 'big')
  check('SP 回灌 → PV 一阶收敛趋势', pvAfter > pvBefore + 1, `pv ${pvBefore.toFixed(1)} → ${pvAfter.toFixed(1)}(SP=${target})`)
  await client.close()
}

// ── Modbus RTU over TCP 从站(15041,主项目 connectTcpRTUBuffered 同语义) ──
{
  const dev = nodes.find(n => n.protocol === 'modbus-rtu')
  if (!dev) throw new Error('FAIL 无 modbus-rtu 设备')
  const client = new ModbusRTU()
  client.setTimeout(3000)
  await client.connectTcpRTUBuffered('127.0.0.1', { port: 15041 })
  client.setID(1)
  const v = decodeRegisters((await client.readHoldingRegisters(0, 2)).data as number[], 'float32', 'big')
  check('RTU-over-TCP 读 炉温(40001 float32)', v >= 0 && v <= 100, `value=${v.toFixed(1)}℃`)
  await client.close()
}

console.log(`\nmodbus 自测: ${passed} passed / ${failed} failed`)
process.exitCode = failed > 0 ? 1 : 0
