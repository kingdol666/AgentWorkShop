/**
 * Modbus RTU over TCP 驱动真连探针:官方 ServerTCP 从站(modbus-serial 自带)
 * + 真实驱动代码路径(daq modbusRtuDriver / dcw modbusRtuDcwDriver)全链验证。
 * 运行:npx tsx scripts/_rtu-driver-probe.mjs
 */
import { createRequire } from 'node:module'

import { modbusRtuDriver } from '../server/services/workshop/daq/drivers.ts'
import { modbusRtuDcwDriver } from '../server/services/workshop/dcw/drivers.ts'

const req = createRequire(process.cwd() + '/package.json')
const { ServerTCP } = req('modbus-serial')

const PORT = 15030
// 官方 vector:holding 寄存器读写(FC03/FC06/FC10 由 ServerTCP 内部处理)
const holding = new Map()
const vector = {
  getHoldingRegister: addr => holding.get(addr) ?? 0,
  setRegister: (addr, value) => { holding.set(addr, value & 0xffff) },
}

const server = new ServerTCP(vector, { host: '127.0.0.1', port: PORT, unitID: 1 })
console.log(`[rtu-sim] ServerTCP 从站 127.0.0.1:${PORT} 就绪`)

const cfg = { host: '127.0.0.1', port: PORT, unitId: 1, register: 40001, dataType: 'float32', byteOrder: 'big' }

// 数采:test + 读(初始 0)
const t1 = await modbusRtuDriver.test(cfg)
console.log('[DAQ test]', t1.ok ? 'PASS' : 'FAIL', '|', t1.message, `(${t1.latencyMs}ms)`)
const v0 = await modbusRtuDriver.sample({ ctx: { nodeId: 'probe', now: Date.now(), ageMs: 0 }, config: { base: 0, amp: 0, min: 0, max: 0 }, driverConfig: cfg })
console.log('[DAQ sample]', v0)

// 预置寄存器值(float32 45.5 big 端 words)→ 数采读回
holding.set(0, 0x4236)
holding.set(1, 0x0000)
const v1 = await modbusRtuDriver.sample({ ctx: { nodeId: 'probe', now: Date.now(), ageMs: 0 }, config: { base: 0, amp: 0, min: 0, max: 0 }, driverConfig: cfg })
console.log('[DAQ sample]', v1, Math.abs(v1 - 45.5) < 0.1 ? 'PASS(读回 45.5)' : 'FAIL')

// 数控:写 48.25 → ServerTCP 内部 setRegister 落 vector → 读回验证
const w = await modbusRtuDcwDriver.write({
  driverConfig: cfg,
  eng: 48.25,
  tolerance: 0.1,
  domain: { min: 0, max: 100 },
})
console.log('[DCW write]', w.ok ? 'PASS' : 'FAIL', '|', w.message)
const v2 = await modbusRtuDriver.sample({ ctx: { nodeId: 'probe', now: Date.now(), ageMs: 0 }, config: { base: 0, amp: 0, min: 0, max: 0 }, driverConfig: cfg })
console.log('[DAQ sample after write]', v2, Math.abs(v2 - 48.25) < 0.1 ? 'PASS(写后读回一致)' : 'FAIL')

server.close()
const all = t1.ok && Math.abs(v1 - 45.5) < 0.1 && w.ok && Math.abs(v2 - 48.25) < 0.1
console.log('=== 结果:', all ? 'Modbus RTU over TCP 驱动真连 ALL PASS' : 'FAIL', '===')
process.exit(all ? 0 : 1)
