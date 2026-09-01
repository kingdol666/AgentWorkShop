/**
 * MQTT 驱动真连探针:真实驱动代码路径打本地模拟器(mqtt://127.0.0.1:1883)。
 * 运行:npx tsx scripts/_mqtt-driver-probe.mjs(需 dev-protocol-simulators 已启动)
 */
import { mqttDaqDriver } from '../server/services/workshop/daq/drivers.ts'
import { mqttDcwDriver } from '../server/services/workshop/dcw/drivers.ts'

// 1) 数采:test 连接订阅 + 读数(jsonPath data.temp)
const daqCfg = { host: '127.0.0.1', port: Number(process.env.MQTT_PORT ?? 1883), topic: 'aw/sim/temp', jsonPath: 'data.temp' }
const t1 = await mqttDaqDriver.test(daqCfg)
console.log('[DAQ test]', t1.ok ? 'PASS' : 'FAIL', '|', t1.message, `(${t1.latencyMs}ms)`, '| sampleValue:', t1.sampleValue)
const v1 = await mqttDaqDriver.sample({ ctx: { nodeId: 'probe', now: Date.now(), ageMs: 0 }, config: { base: 0, amp: 0, min: 0, max: 0 }, driverConfig: daqCfg })
console.log('[DAQ sample]', v1, Number.isFinite(v1) ? 'PASS' : 'FAIL')

// 2) 数控:发布设定值 55.5 到 aw/sim/setpoint(模拟器订阅并打印 = 人工/日志核验)
const w = await mqttDcwDriver.write({
  driverConfig: { host: '127.0.0.1', port: Number(process.env.MQTT_PORT ?? 1883), topic: 'aw/sim/setpoint', jsonKey: 'setpoint', qos: 1 },
  eng: 55.5,
  tolerance: 0.1,
  domain: { min: 0, max: 100 },
})
console.log('[DCW publish]', w.ok ? 'PASS' : 'FAIL', '|', w.message)

// 3) test 语义:Broker 可达即 PASS(不发布)
const t2 = await mqttDcwDriver.test({ host: '127.0.0.1', port: Number(process.env.MQTT_PORT ?? 1883), topic: 'aw/sim/setpoint' })
console.log('[DCW test]', t2.ok ? 'PASS' : 'FAIL', '|', t2.message)

const all = t1.ok && Number.isFinite(v1) && w.ok && t2.ok
console.log('=== 结果:', all ? 'MQTT 驱动真连 ALL PASS' : 'FAIL', '===')
process.exit(all ? 0 : 1)
