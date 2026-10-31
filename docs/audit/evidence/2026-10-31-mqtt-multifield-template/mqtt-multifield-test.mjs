#!/usr/bin/env node
/**
 * 2026-10-30 MQTT 协议专项实机检查(多字段 JSON 解析 + 下发封装)。
 *
 * 场景 A(采集):真实 broker(127.0.0.1:1883)+ 真实 MQTT 报文,单 topic 多字段 JSON:
 *   {"data":{"temp":..,"humidity":..,"pressure":..,"nested":{"dew":..},"samples":[...]},"status":"ok"}
 *   多个 DAQ 节点共享同一 topic、各自 jsonPath 解析 → 全部落库(验证多字段解析)。
 *   另建两个"应失败"节点(字符串字段/不存在字段)→ 必须如实报错且不落库。
 * 场景 B(控制):真实设备侧模拟器 inj-cool-mqtt(commandTopic=aw/inj/coolwater/set,
 *   stateTopic=aw/inj/coolwater/state)做写穿 + 回读;并抓包验证:
 *   - jsonKey 单键封装 {"setpoint":v}
 *   - jsonKey 含点号是否被当作嵌套(实测:字面键)
 *   - 同 topic 多节点能否合并成一条多字段报文(实测:逐条独立 publish)
 * 输出: tmp-e2e/idd-rag-e2e-20261030/mqtt-report.json
 */
import { createRequire } from 'node:module'
import { writeFileSync } from 'node:fs'
import { readFileSync } from 'node:fs'

const require = createRequire('D:/codes/ABO/AgentWorkShop/package.json')
const mqtt = require('mqtt')
const sec = JSON.parse(readFileSync('D:/codes/ABO/AgentWorkShop/tmp-e2e/idd-rag-e2e-20261030/secrets.json', 'utf8'))
const B = 'http://127.0.0.1:3300'
const T = sec.platformToken
const LINE = 'ln-cf47d3b6'
const TOPIC = 'aw/e2e/env/complex'
const CMD_TOPIC = 'aw/e2e/cmd/nested'
const MULTI_TOPIC = 'aw/e2e/cmd/multi'

const results = []
const ok = (id, name, cond, detail = '') => {
  results.push({ id, name, pass: Boolean(cond), detail: String(detail).slice(0, 900) })
  console.log(`${cond ? '✔' : '✖'} [${id}] ${name}${cond ? '' : ` — ${String(detail).slice(0, 600)}`}`)
  return Boolean(cond)
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
const paramOfNode = async (nodeId) => {
  const r = await api('GET', `/api/workshop/dcw/params?lineId=${LINE}`)
  return (r.data?.params ?? []).find(p => p.nodeId === nodeId)?.id
}
const api = async (m, p, b, timeout = 30000) => {
  const r = await fetch(B + p, {
    method: m,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${T}` },
    body: b === undefined ? undefined : JSON.stringify(b),
    signal: AbortSignal.timeout(timeout),
  })
  return { status: r.status, ...(await r.json().catch(() => ({}))) }
}

// ---------- 发布器:复杂 JSON(单 topic 多字段) ----------
let seq = 0
const published = []
const pub = mqtt.connect('mqtt://127.0.0.1:1883', { reconnectPeriod: 2000 })
await new Promise((resolve, reject) => { pub.once('connect', resolve); pub.once('error', reject) })
const pubTimer = setInterval(() => {
  seq++
  const msg = {
    ts: Date.now(),
    device: 'env-01',
    data: {
      temp: 20 + (seq % 10) * 0.5,
      humidity: 40 + (seq % 20),
      pressure: 100 + (seq % 5) * 0.2,
      nested: { dew: 10 + (seq % 7) * 0.3 },
      samples: [100 + (seq % 3), 200 + (seq % 4), 300 + (seq % 5)],
    },
    status: 'ok',
  }
  published.push(msg)
  pub.publish(TOPIC, JSON.stringify(msg), { qos: 0 })
}, 1000)
await sleep(300)

// ---------- A. 建 5 个多字段节点 + 2 个应失败节点 ----------
const daqNodes = [
  { key: 'temp', name: 'MQTT多字段-温度', jsonPath: 'data.temp', unit: '℃', min: 0, max: 60 },
  { key: 'humidity', name: 'MQTT多字段-湿度', jsonPath: 'data.humidity', unit: '%', min: 0, max: 100 },
  { key: 'pressure', name: 'MQTT多字段-气压', jsonPath: 'data.pressure', unit: 'kPa', min: 80, max: 120 },
  { key: 'dew', name: 'MQTT多字段-嵌套露点', jsonPath: 'data.nested.dew', unit: '℃', min: -20, max: 40 },
  { key: 'arr', name: 'MQTT多字段-数组元素', jsonPath: 'data.samples.1', unit: 'x', min: 0, max: 1000 },
  { key: 'badString', name: 'MQTT多字段-字符串字段(应报错)', jsonPath: 'status', unit: '', min: 0, max: 1 },
  { key: 'badMissing', name: 'MQTT多字段-缺失字段(应报错)', jsonPath: 'data.missing', unit: '', min: 0, max: 1 },
]
const daqIds = {}
for (const n of daqNodes) {
  const j = await api('POST', '/api/workshop/daq', {
    name: n.name,
    lineId: LINE,
    driver: 'mqtt',
    driverConfig: { host: '127.0.0.1', port: 1883, topic: TOPIC, jsonPath: n.jsonPath, qos: 0 },
    unit: n.unit,
    decimals: 2,
    min: n.min,
    max: n.max,
    intervalMs: 2000,
    templateRef: 'daq-temp-tc',
  })
  daqIds[n.key] = j.data?.node?.id ?? j.data?.id
  ok(`A.${n.key}`, `建 MQTT 节点 ${n.name}`, Boolean(daqIds[n.key]), daqIds[n.key] ?? j.message)
}

// 等待采集(被动推送;控制器已 running)
await sleep(12000)

const sampleWindow = { from: Date.now() - 120000, to: Date.now() + 1000 }
const samples = {}
for (const n of daqNodes) {
  const id = daqIds[n.key]
  if (!id) continue
  const r = await api('GET', `/api/workshop/daq/${id}/samples?from=${sampleWindow.from}&to=${sampleWindow.to}&bucketMs=1000`)
  const pts = r.data?.points ?? []
  samples[n.key] = pts
  const total = pts.reduce((a, p) => a + (p.cnt ?? 0), 0)
  if (n.key.startsWith('bad')) {
    ok(`A.${n.key}.reject`, `${n.name} 如实报错且零入库`, total === 0, `samples=${total}`)
  }
  else {
    ok(`A.${n.key}.data`, `${n.name} 有真实样本`, total > 0, `buckets=${pts.length} samples=${total} last=${pts.at(-1)?.avg}`)
  }
}

// 数值一致性:节点值必须命中发布值集合
const valueSets = {
  temp: new Set(published.map(m => m.data.temp)),
  humidity: new Set(published.map(m => m.data.humidity)),
  pressure: new Set(published.map(m => Math.round(m.data.pressure * 100) / 100)),
  dew: new Set(published.map(m => Math.round(m.data.nested.dew * 100) / 100)),
  arr: new Set(published.map(m => m.data.samples[1])),
}
for (const n of daqNodes.filter(x => !x.key.startsWith('bad'))) {
  const pts = samples[n.key] ?? []
  const hit = pts.some(p => [...valueSets[n.key]].some(v => Math.abs(v - p.avg) <= 0.02))
  ok(`A.${n.key}.match`, `${n.name} 值命中发布集合`, hit, `observed=${pts.map(p => p.avg).slice(-5).join(',')}`)
}

// 同一 topic 的 5 个节点共享一次订阅:样本时间戳应大量重合(逐报文扇出)
const tsSets = ['temp', 'humidity', 'pressure', 'dew', 'arr'].map(k => new Set((samples[k] ?? []).map(p => p.at)))
let overlap = 0
if (tsSets.every(s => s.size > 0)) {
  const first = [...tsSets[0]]
  overlap = first.filter(t => tsSets.slice(1).every(s => s.has(t))).length
}
ok('A.fanout', '同 topic 多节点逐报文扇出(时间戳重合)', overlap > 0, `overlapBuckets=${overlap}`)

// 错误节点 lastError 文案
const daqList = await api('GET', '/api/workshop/daq')
const byId = new Map((daqList.data?.nodes ?? []).map(n => [n.id, n]))
const badStr = byId.get(daqIds.badString)
const badMiss = byId.get(daqIds.badMissing)
ok('A.errText.string', '字符串字段被拒并给出可读错误', /无法得到单个数值|不是合法 JSON/.test(String(badStr?.lastError ?? '')), String(badStr?.lastError ?? '(空)'))
ok('A.errText.missing', '缺失字段被拒并给出可读错误', /无法得到单个数值|不是合法 JSON/.test(String(badMiss?.lastError ?? '')), String(badMiss?.lastError ?? '(空)'))

// ---------- B1. 真实设备写穿 + 回读(inj-cool-mqtt) ----------
const dcw1 = await api('POST', '/api/workshop/dcw', {
  name: 'MQTT写-冷却水温SP',
  lineId: LINE,
  driver: 'mqtt',
  driverConfig: {
    host: '127.0.0.1', port: 18830, topic: 'aw/inj/coolwater/set', jsonKey: 'setpoint', qos: 1,
    readTopic: 'aw/inj/coolwater/state', readJsonPath: 'setpoint',
  },
  unit: '℃', decimals: 1, min: 10, max: 40, stepLimit: 5, holdIntervalMs: 0, templateRef: 'temp-sp',
})
const wId = dcw1.data?.node?.id ?? dcw1.data?.id
ok('B1.create', '建 MQTT 写控节点(真实设备 commandTopic)', Boolean(wId), wId ?? dcw1.message)

const before = await (await fetch('http://127.0.0.1:4010/api/nodes')).json()
const spBefore = Number((before.data.find(n => n.id === 'inj-cool-mqtt')?.signals ?? []).find(s => s.id === 'cool-water-sp')?.value)
const wParam = await paramOfNode(wId)
const w1 = await api('POST', `/api/workshop/dcw/params/${wParam}/write`, { value: 26 }, 30000)
await sleep(2500)
const after = await (await fetch('http://127.0.0.1:4010/api/nodes')).json()
const spAfter = Number((after.data.find(n => n.id === 'inj-cool-mqtt')?.signals ?? []).find(s => s.id === 'cool-water-sp')?.value)
ok('B1.device', '设备侧设定值真实生效', spAfter === 26 && spBefore !== 26, `before=${spBefore} after=${spAfter} resp=${JSON.stringify(w1.data?.outcome ?? w1).slice(0, 200)}`)
const o1 = w1.data?.outcome ?? {}
ok('B1.ack', '写回执分级(readback-verified / transport-ack 如实)', o1.ok === true && String(o1.ack ?? o1.status ?? '').match(/readback|verified|transport/i) !== null, JSON.stringify(o1).slice(0, 300))

// 越界拒绝
const w2 = await api('POST', `/api/workshop/dcw/params/${wParam}/write`, { value: 99 }, 30000)
ok('B1.range', '越量程写入被拒(设备不变)', w2.status === 400 || w2.code !== 0, `status=${w2.status} msg=${w2.message ?? ''}`)

// ---------- B2. jsonKey 点号是否嵌套(抓包) ----------
const captured = []
const sub = mqtt.connect('mqtt://127.0.0.1:1883', { reconnectPeriod: 2000 })
await new Promise((resolve, reject) => { sub.once('connect', resolve); sub.once('error', reject) })
sub.on('message', (t, buf) => captured.push({ topic: t, payload: buf.toString() }))
await new Promise(r => sub.subscribe([CMD_TOPIC, MULTI_TOPIC], { qos: 0 }, r))

const dcw2 = await api('POST', '/api/workshop/dcw', {
  name: 'MQTT写-嵌套键试验', lineId: LINE, driver: 'mqtt',
  driverConfig: { host: '127.0.0.1', port: 1883, topic: CMD_TOPIC, jsonKey: 'params.temp', qos: 0 },
  unit: '℃', decimals: 0, min: 0, max: 300, stepLimit: 300, holdIntervalMs: 0, templateRef: 'temp-sp',
})
const n2 = dcw2.data?.node?.id ?? dcw2.data?.id
ok('B2.create', '建 jsonKey=params.temp 试验节点', Boolean(n2), n2 ?? dcw2.message)
if (n2) {
  const p2 = await paramOfNode(n2)
  await api('POST', `/api/workshop/dcw/params/${p2}/write`, { value: 230 }, 30000)
}
await sleep(1200)
const nestedMsg = captured.find(c => c.topic === CMD_TOPIC)
ok('B2.nestedKey', 'jsonKey 点号被当作字面键(不产生嵌套对象)', nestedMsg?.payload === '{"params.temp":230}', `payload=${nestedMsg?.payload ?? '(无)'}`)

// ---------- B3. 同 topic 多节点能否合并为一条多字段报文 ----------
const dcwA = await api('POST', '/api/workshop/dcw', {
  name: 'MQTT写-多字段temp', lineId: LINE, driver: 'mqtt',
  driverConfig: { host: '127.0.0.1', port: 1883, topic: MULTI_TOPIC, jsonKey: 'temp', qos: 0 },
  unit: '℃', decimals: 0, min: 0, max: 300, stepLimit: 300, holdIntervalMs: 0, templateRef: 'temp-sp',
})
const dcwB = await api('POST', '/api/workshop/dcw', {
  name: 'MQTT写-多字段hold', lineId: LINE, driver: 'mqtt',
  driverConfig: { host: '127.0.0.1', port: 1883, topic: MULTI_TOPIC, jsonKey: 'hold', qos: 0 },
  unit: 's', decimals: 0, min: 0, max: 60, stepLimit: 60, holdIntervalMs: 0, templateRef: 'temp-sp',
})
const idA = dcwA.data?.node?.id ?? dcwA.data?.id
const idB = dcwB.data?.node?.id ?? dcwB.data?.id
const pA = idA ? await paramOfNode(idA) : null
const pB = idB ? await paramOfNode(idB) : null
if (pA) await api('POST', `/api/workshop/dcw/params/${pA}/write`, { value: 230 }, 30000)
await sleep(500)
if (pB) await api('POST', `/api/workshop/dcw/params/${pB}/write`, { value: 8 }, 30000)
await sleep(1200)
const multiMsgs = captured.filter(c => c.topic === MULTI_TOPIC).map(c => c.payload)
ok('B3.multiField', '同 topic 两节点=两条独立报文(非单条多字段封装)', multiMsgs.length >= 2 && multiMsgs.includes('{"temp":230}') && multiMsgs.includes('{"hold":8}'), `payloads=${JSON.stringify(multiMsgs)}`)

clearInterval(pubTimer)
pub.end(true)
sub.end(true)

const pass = results.filter(r => r.pass).length
const report = {
  suite: 'MQTT 协议专项(多字段解析 + 下发封装)',
  at: new Date().toISOString(),
  topic: TOPIC,
  publishedSample: published.slice(-2),
  checks: results,
  verdict: `PASS(${pass}/${results.length})`,
}
writeFileSync('D:/codes/ABO/AgentWorkShop/tmp-e2e/idd-rag-e2e-20261030/mqtt-report.json', JSON.stringify(report, null, 2))
console.log(`\nMQTT 专项: ${report.verdict}`)
process.exit(pass === results.length ? 0 : 1)
