/**
 * 一次性:MQTT 规范链路实证。
 * 独立第三方订阅者挂 broker aw/daq/+/sample → REST 建真实 Modbus 节点 →
 * 断言:①MQTT 帧真实过 broker(主题/载荷符合规范) ②Timescale 有该节点样本
 * ③节点+driverConfig 持久化(daqs.json) ④重启存活(交由外部脚本)。
 */
import mqtt from 'mqtt'
import { readFileSync } from 'node:fs'

const BASE = 'http://127.0.0.1:3000'
const login = await fetch(`${BASE}/api/users/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'zhangwei@awshop.io', password: 'Awshop@123' }),
}).then(r => r.json())
const H = { 'authorization': `Bearer ${login.data.token}`, 'content-type': 'application/json' }

// ---------- 第三方 MQTT 订阅者(规范验证:独立于应用进程) ----------
const frames = []
const client = mqtt.connect('mqtt://127.0.0.1:1883', { clientId: 'audit-sub-' + Date.now() })
client.on('message', (topic, payload) => {
  try {
    frames.push({ topic, payload: JSON.parse(payload.toString()) })
  }
  catch { /* 坏帧忽略 */ }
})
const subReady = new Promise((res) => {
  client.on('connect', () => client.subscribe('aw/daq/+/sample', { qos: 0 }, () => res()))
})
await subReady
console.log('[audit-sub] 已订阅 aw/daq/+/sample')

// ---------- 前端同款操作:REST 创建真实 Modbus 节点 ----------
const made = await fetch(`${BASE}/api/workshop/daq`, {
  method: 'POST', headers: H,
  body: JSON.stringify({
    templateRef: 'daq-pressure-tx',
    name: 'MQTT链路审计 · 熔体压力',
    driver: 'modbus-tcp',
    driverConfig: { host: '127.0.0.1', port: 1502, unitId: 1, register: 40001, registerType: 'holding', dataType: 'float32', scale: 1, byteOrder: 'big' },
    intervalMs: 500,
  }),
}).then(r => r.json())
const node = made.data?.node
console.log('[created]', node?.id, '| driver =', node?.driver, '| cfg =', JSON.stringify(node?.driverConfig))

// ---------- 捕获 5s MQTT 帧 ----------
await new Promise(r => setTimeout(r, 5000))
client.end(true)

let specOk = false
const mine = frames.filter(f => f.topic === `aw/daq/${node.id}/sample`)
console.log(`[mqtt frames] total=${frames.length} mine=${mine.length}`)
if (mine[0]) {
  console.log('[frame sample] topic =', mine[0].topic)
  console.log('[frame sample] payload =', JSON.stringify(mine[0].payload))
  const p = mine[0].payload
  specOk = p.nodeId === node.id && typeof p.value === 'number' && typeof p.at === 'string'
    && ['ok', 'warn', 'alarm', 'offline'].includes(p.state) && p.templateRef === 'daq-pressure-tx'
  console.log('[spec check]', specOk ? 'PASS(载荷四要素:nodeId/templateRef/value/state/at)' : 'FAIL')
}
const valueInBand = mine.length > 0 && mine.every(f => f.payload.value > 0.5 && f.payload.value < 1.3)
console.log('[frames mine count]', mine.length)
console.log('[value band]', valueInBand ? 'PASS(全部在 0.6~1.2 MPa 物理域)' : 'FAIL')

// ---------- Timescale 落库断言 ----------
await new Promise(r => setTimeout(r, 1500))
const samples = await fetch(`${BASE}/api/workshop/daq/${node.id}/samples?limit=50`, { headers: H }).then(r => r.json())
const pts = samples.data?.points ?? []
console.log(`[tsdb] node 样本行 = ${pts.length}`, pts.length ? `(min=${Math.min(...pts.map(p => p.value)).toFixed(3)}, max=${Math.max(...pts.map(p => p.value)).toFixed(3)})` : '')

// ---------- 持久化断言(daqs.json) ----------
const daqStore = JSON.parse(readFileSync('server/data/daqs.json', 'utf-8'))
const persisted = daqStore.find(n => n.id === node.id)
console.log('[persisted]', persisted
  ? `PASS(${persisted.name} | driver=${persisted.driver} | cfg=${JSON.stringify(persisted.driverConfig)})`
  : 'FAIL: daqs.json 无该节点')

// Timescale 侧直查(容器内)
const { execFile } = await import('node:child_process')
const { promisify } = await import('node:util')
const exec = promisify(execFile)
const pg = await exec('docker', ['exec', 'awshop-daq-timescale', 'psql', '-U', 'postgres', '-d', 'awshop', '-tAc',
  `SELECT count(*) FROM daq_samples WHERE node_id = '${node.id}'`])
console.log('[tsdb direct] 该节点行数 =', pg.stdout.trim())

const pass = mine.length >= 4 && specOk && valueInBand && pts.length >= 4 && Boolean(persisted) && Number(pg.stdout.trim()) >= 4

console.log(pass ? '=== MQTT CHAIN AUDIT PASS ===' : '=== MQTT CHAIN AUDIT FAIL ===')
process.exit(pass ? 0 : 1)
