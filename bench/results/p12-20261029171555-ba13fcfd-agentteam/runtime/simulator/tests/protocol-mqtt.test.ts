/**
 * 协议自测 —— 全部走真实客户端库(mqtt v5 客户端语义与主项目一致)。
 * 前置:模拟器已运行(4010)并已应用 film-line 预设。
 * 覆盖:订阅设备主题收发布 / 命令主题回灌(DCW 写语义)。
 */
import mqtt from 'mqtt'

let passed = 0
let failed = 0
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { passed++; console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`) }
  else { failed++; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`) }
}

const nodes = (await (await fetch('http://127.0.0.1:4010/api/nodes')).json()).data as Array<{ id: string, protocol: string, signals: Array<{ id: string, value: number }> }>
const dev = nodes.find(n => n.protocol === 'mqtt')
if (!dev) throw new Error('FAIL 无 MQTT 设备(先应用 film-line 预设)')

const client = await mqtt.connectAsync('mqtt://127.0.0.1:18830', { connectTimeout: 4000 })
check('broker 连接(内置 18830)', client.connected)

// 1) 订阅设备主题 → 收到周期发布
const got = new Promise<{ topic: string, payload: string }>((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('5s 内未收到 aw/sim/temp 发布')), 5000)
  client.on('message', (topic, payload) => { clearTimeout(t); resolve({ topic, payload: payload.toString() }) })
})
await client.subscribeAsync('aw/sim/temp', { qos: 1 })
const msg = await got
let json: { data?: { temp?: number } } | null = null
try { json = JSON.parse(msg.payload) } catch { /* 非 JSON */ }
check('收到设备发布 aw/sim/temp', msg.topic === 'aw/sim/temp' && typeof json?.data?.temp === 'number', msg.payload.slice(0, 40))

// 2) 命令主题 → DCW 写语义回灌(tempSP manual 信号)+ 状态主题立即回显
const before = dev.signals.find(s => s.id === 'mqtt-sp')?.value ?? 0
const target = before >= 60 ? 55 : 62
const states: Array<Record<string, unknown>> = []
client.on('message', (topic, payload) => {
  if (topic !== 'aw/sim/state') return
  try { states.push(JSON.parse(payload.toString())) } catch { /* 忽略非 JSON */ }
})
await client.subscribeAsync('aw/sim/state', { qos: 1 })
await client.publishAsync('aw/sim/setpoint', JSON.stringify({ setpoint: target }), { qos: 1 })
await new Promise(r => setTimeout(r, 600))
const echo = states[states.length - 1] ?? {}
const after2 = (await (await fetch('http://127.0.0.1:4010/api/nodes')).json()).data
  .find((n: { id: string }) => n.id === dev.id).signals
  .find((s: { id: string }) => s.id === 'mqtt-sp').value
check('命令回灌 setpoint → tempSP', Math.abs(after2 - target) < 0.01, `write=${target} → value=${after2}`)
check('命令生效 → 状态主题立即回显', Number(echo.setpoint) === target, JSON.stringify(echo).slice(0, 80))

// 3) retained 状态:晚订阅的第二个客户端立即拿到当前值(不必等下一次发布)
{
  const late = await mqtt.connectAsync('mqtt://127.0.0.1:18830', { connectTimeout: 4000 })
  let retained: Record<string, unknown> | null = null
  const t0 = Date.now()
  late.on('message', (topic, payload) => {
    if (topic !== 'aw/sim/state') return
    try { retained = JSON.parse(payload.toString()) } catch { retained = {} }
  })
  await late.subscribeAsync('aw/sim/state', { qos: 1 })
  await new Promise(r => setTimeout(r, 1200))
  check('状态主题 retained(晚订阅即时可取)', retained != null && Number.isFinite(Number((retained as Record<string, unknown>).setpoint)) && Date.now() - t0 < 1500, JSON.stringify(retained).slice(0, 80))
  await late.endAsync()
}

await client.endAsync()
console.log(`\nmqtt 自测: ${passed} passed / ${failed} failed`)
process.exitCode = failed > 0 ? 1 : 0
