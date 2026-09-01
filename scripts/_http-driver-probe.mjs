/**
 * HTTP 驱动真连探针:真实驱动代码路径打本地模拟器(http://127.0.0.1:1889)。
 * 运行:npx tsx scripts/_http-driver-probe.mjs(需 dev-protocol-simulators 已启动)
 */
import { httpDaqDriver } from '../server/services/workshop/daq/drivers.ts'
import { httpDcwDriver } from '../server/services/workshop/dcw/drivers.ts'

// 1) 数采:GET JSON + jsonPath data.value
const daqCfg = { url: 'http://127.0.0.1:1889/api/value', jsonPath: 'data.value' }
const t1 = await httpDaqDriver.test(daqCfg)
console.log('[DAQ test]', t1.ok ? 'PASS' : 'FAIL', '|', t1.message, `(${t1.latencyMs}ms)`)
const v1 = await httpDaqDriver.sample({ ctx: { nodeId: 'probe', now: Date.now(), ageMs: 0 }, config: { base: 0, amp: 0, min: 0, max: 0 }, driverConfig: daqCfg })
console.log('[DAQ sample]', v1, Number.isFinite(v1) ? 'PASS' : 'FAIL')

// 2) 数控:POST 设定值 66.6(默认 {"value":66.6})
const w = await httpDcwDriver.write({
  driverConfig: { url: 'http://127.0.0.1:1889/api/setpoint' },
  eng: 66.6,
  tolerance: 0.1,
  domain: { min: 0, max: 100 },
})
console.log('[DCW write]', w.ok ? 'PASS' : 'FAIL', '|', w.message, '| readback:', w.readback)

// 3) test 安全语义:GET 可达即 PASS(不执行写入)
const t2 = await httpDcwDriver.test({ url: 'http://127.0.0.1:1889/api/setpoint' })
console.log('[DCW test]', t2.ok ? 'PASS' : 'FAIL', '|', t2.message)

const all = t1.ok && Number.isFinite(v1) && w.ok && t2.ok
console.log('=== 结果:', all ? 'HTTP 驱动真连 ALL PASS' : 'FAIL', '===')
process.exit(all ? 0 : 1)
