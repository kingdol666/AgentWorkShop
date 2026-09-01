/**
 * OPC UA 驱动真连探针:用真实驱动代码路径(daq opcUaDriver.test / dcw opcUaDcwDriver.write)
 * 打真实模拟器(opc.tcp://127.0.0.1:4840,ns=2;s=AW.Temp / AW.SetTemp)。
 * 运行:npx tsx scripts/_opcua-driver-probe.mjs(需 dev-opcua-simulator 已启动)
 */
import { opcUaDriver } from '../server/services/workshop/daq/drivers.ts'
import { opcUaDcwDriver } from '../server/services/workshop/dcw/drivers.ts'

const endpoint = 'opc.tcp://127.0.0.1:4840'
const daqCfg = { endpoint, nodeId: 'ns=2;s=AW.Temp', securityMode: 'None' }

// 1) 数采:test 连接 + 读数
const t1 = await opcUaDriver.test(daqCfg)
console.log('[DAQ test]', t1.ok ? 'PASS' : 'FAIL', '|', t1.message, `(${t1.latencyMs}ms)`)
const v1 = await opcUaDriver.sample({ ctx: { nodeId: 'probe', now: Date.now(), ageMs: 0 }, config: { base: 0, amp: 0, min: 0, max: 0 }, driverConfig: daqCfg })
console.log('[DAQ sample]', v1, Number.isFinite(v1) ? 'PASS' : 'FAIL')

// 2) 数控:写 183.5 → 回读校验
const dcwCfg = { endpoint, nodeId: 'ns=2;s=AW.SetTemp', securityMode: 'None' }
const w = await opcUaDcwDriver.write({
  driverConfig: dcwCfg,
  eng: 183.5,
  tolerance: 0.5,
  scale: { engMin: 0, engMax: 200 },
})
console.log('[DCW write]', w.ok ? 'PASS' : 'FAIL', '|', w.message, '| raw:', w.raw, 'readback:', w.readback)
const t2 = await opcUaDcwDriver.test(dcwCfg)
console.log('[DCW test]', t2.ok ? 'PASS' : 'FAIL', '|', t2.message)

console.log('=== 结果:', t1.ok && Number.isFinite(v1) && w.ok ? 'OPC UA 驱动真连 ALL PASS' : 'FAIL', '===')
process.exit(t1.ok && Number.isFinite(v1) && w.ok ? 0 : 1)
