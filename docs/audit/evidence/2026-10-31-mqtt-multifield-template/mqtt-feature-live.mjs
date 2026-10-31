#!/usr/bin/env node
/**
 * 2026-10-31 MQTT 新能力实机验收:
 *  A) 单 topic 多字段 fields 配置 → 展开多子信号节点 → 真实 JSON 报文 → 全部入 Timescale;
 *     同一报文在子节点上时间戳重合(共享一次订阅);字段级告警限生效。
 *  B) jsonTemplate 下发:嵌套多字段报文(抓包校验 JSON 结构)、真实设备端生效(模拟器
 *     commandTopic 解析 setpoint)、状态主题回读;坏模板/互斥配置在创建期 400。
 *  C) 兼容:jsonKey 单键下发仍工作。
 * 输出: tmp-e2e/idd-rag-e2e-20261030/mqtt-feature-report.json
 */
import { createRequire } from 'node:module'
import { readFileSync, writeFileSync } from 'node:fs'

const require = createRequire('D:/codes/ABO/AgentWorkShop/package.json')
const mqtt = require('mqtt')
const sec = JSON.parse(readFileSync('D:/codes/ABO/AgentWorkShop/tmp-e2e/idd-rag-e2e-20261030/secrets.json', 'utf8'))
const B = 'http://127.0.0.1:3300'
const T = sec.platformToken
const LINE = 'ln-cf47d3b6'
const TOPIC = 'aw/e2e/env/multi'
const CMD_TOPIC = 'aw/e2e/cmd/tpl'
const TPL_TOPIC = 'aw/e2e/cmd/tpl-real' // 抓包用(不接设备)

const results = []
const ok = (id, name, cond, detail = '') => {
  results.push({ id, name, pass: Boolean(cond), detail: String(detail).slice(0, 1200) })
  console.log(`${cond ? '✔' : '✖'} [${id}] ${name}${cond ? '' : ` — ${String(detail).slice(0, 700)}`}`)
  return Boolean(cond)
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
const api = async (m, p, b, timeout = 30000) => {
  const r = await fetch(B + p, {
    method: m,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${T}` },
    body: b === undefined ? undefined : JSON.stringify(b),
    signal: AbortSignal.timeout(timeout),
  })
  return { status: r.status, ...(await r.json().catch(() => ({}))) }
}
const paramOfNode = async (nodeId) => {
  const r = await api('GET', `/api/workshop/dcw/params?lineId=${LINE}`)
  return (r.data?.params ?? []).find(p => p.nodeId === nodeId)?.id
}
const simSignal = async (deviceId, signalId) => {
  const j = await (await fetch('http://127.0.0.1:4010/api/nodes')).json()
  const dev = (j.data ?? []).find(n => n.id === deviceId)
  return dev ? Number((dev.signals ?? []).find(s => s.id === signalId)?.value) : null
}

// ---------- 发布器:单 topic 多字段 + 告警触发值 ----------
let seq = 0
const published = []
const pub = mqtt.connect('mqtt://127.0.0.1:1883', { reconnectPeriod: 2000 })
await new Promise((resolve, reject) => { pub.once('connect', resolve); pub.once('error', reject) })
const pubTimer = setInterval(() => {
  seq++
  const msg = {
    ts: Date.now(),
    data: {
      temp: 20 + (seq % 5),          // 20..24;warnHigh=18 → 必触发 warn
      humidity: 40 + (seq % 10),     // 40..49
      nested: { dew: 10 + (seq % 3) },
      samples: [100 + (seq % 3), 200 + (seq % 4)],
    },
    status: 'ok',
  }
  published.push(msg)
  pub.publish(TOPIC, JSON.stringify(msg), { qos: 0 })
}, 1000)
await sleep(500)

// ---------- A. 多字段展开 ----------
const create = await api('POST', '/api/workshop/daq', {
  name: 'E2E-MQTT-多字段站',
  lineId: LINE,
  driver: 'mqtt',
  templateRef: 'daq-temp-tc',
  intervalMs: 2000,
  driverConfig: {
    host: '127.0.0.1', port: 1883, topic: TOPIC, qos: 0,
    fields: {
      temp: { path: 'data.temp', unit: '℃', min: 0, max: 60, warnHigh: 18 },
      humidity: { path: 'data.humidity', unit: '%', min: 0, max: 100, warnLow: 20, warnHigh: 80 },
      dew: { path: 'data.nested.dew', unit: '℃', min: -20, max: 40 },
      arr1: { path: 'data.samples.1', unit: 'x', min: 0, max: 1000 },
    },
  },
}, 30000)
const nodes = create.data?.nodes ?? []
ok('A.create', '一次 fields 配置展开 4 个子信号节点', create.status === 200 && nodes.length === 4, `status=${create.status} count=${nodes.length} msg=${create.message ?? ''}`)
const groupId = create.data?.groupId
ok('A.group', '同一 groupId + 字段标签暴露到节点视图', nodes.length === 4 && nodes.every(n => n.fieldGroup === groupId && n.fieldLabel), `groupId=${groupId} labels=${nodes.map(n => n.fieldLabel).join(',')}`)
ok('A.names', '子节点命名带父名+字段名', nodes.every(n => String(n.name).startsWith('E2E-MQTT-多字段站·')), nodes.map(n => n.name).join(','))

await sleep(10000)

const byLabel = Object.fromEntries(nodes.map(n => [n.fieldLabel, n]))
const sampleSets = {}
for (const [label, node] of Object.entries(byLabel)) {
  const from = Date.now() - 120000
  const r = await api('GET', `/api/workshop/daq/${node.id}/samples?from=${from}&to=${Date.now() + 1000}&bucketMs=1000`)
  const pts = r.data?.points ?? []
  sampleSets[label] = pts
  const total = pts.reduce((a, p) => a + (p.cnt ?? 0), 0)
  ok(`A.${label}.data`, `子信号 ${label} 有真实样本入库`, total > 0, `buckets=${pts.length} samples=${total} last=${pts.at(-1)?.avg}`)
}
const valueSets = {
  temp: new Set(published.map(m => m.data.temp)),
  humidity: new Set(published.map(m => m.data.humidity)),
  dew: new Set(published.map(m => m.data.nested.dew)),
  arr1: new Set(published.map(m => m.data.samples[1])),
}
for (const label of Object.keys(valueSets)) {
  const pts = sampleSets[label] ?? []
  const hit = pts.some(p => [...valueSets[label]].some(v => Math.abs(v - p.avg) <= 0.02))
  ok(`A.${label}.match`, `子信号 ${label} 值与发布 JSON 一致`, hit, `observed=${pts.map(p => p.avg).slice(-4).join(',')}`)
}
// 共享订阅:同报文时间戳重合
const tsSets = ['temp', 'humidity', 'dew', 'arr1'].map(k => new Set((sampleSets[k] ?? []).map(p => p.at)))
const overlap = tsSets.every(s => s.size > 0) ? [...tsSets[0]].filter(t => tsSets.slice(1).every(s => s.has(t))).length : 0
ok('A.fanout', '4 子节点共享一次订阅(同报文时间戳重合)', overlap > 0, `overlapBuckets=${overlap}`)

// 字段级告警(节点视图 warnHigh=18,值 20..24)
const alarms = await api('GET', '/api/workshop/daq/alarms?scope=all&limit=200')
const alarmList = alarms.data?.alarms ?? []
const tempAlarm = alarmList.find(a => a.nodeId === byLabel.temp?.id)
const daqNow = await api('GET', '/api/workshop/daq')
const tempNode = (daqNow.data?.nodes ?? []).find(n => n.id === byLabel.temp?.id)
ok('A.alarm', '字段级告警限生效(温度子信号 warn/告警)',
  Boolean(tempAlarm) || tempNode?.state === 'warn',
  tempAlarm ? JSON.stringify(tempAlarm).slice(0, 220) : `state=${tempNode?.state} value=${tempNode?.value} alarms=${alarmList.length}`)

// ---------- B. jsonTemplate 下发 ----------
const captured = []
const sub = mqtt.connect('mqtt://127.0.0.1:1883', { reconnectPeriod: 2000 })
await new Promise((resolve, reject) => { sub.once('connect', resolve); sub.once('error', reject) })
sub.on('message', (t, buf) => captured.push({ topic: t, payload: buf.toString() }))
await new Promise(r => sub.subscribe([CMD_TOPIC, TPL_TOPIC], { qos: 0 }, r))

const d1 = await api('POST', '/api/workshop/dcw', {
  name: 'E2E-MQTT-模板下发', lineId: LINE, driver: 'mqtt',
  driverConfig: {
    host: '127.0.0.1', port: 1883, topic: CMD_TOPIC, qos: 0,
    jsonTemplate: '{"cmd":"set","params":{"temp":{{value}},"hold":8},"ts":123}',
  },
  unit: '℃', decimals: 0, min: 0, max: 300, stepLimit: 300, holdIntervalMs: 0, templateRef: 'temp-sp',
})
const n1 = d1.data?.node?.id
ok('B.tpl-create', '建 jsonTemplate 节点(嵌套/多字段)', Boolean(n1), n1 ?? d1.message)
if (n1) {
  const p1 = await paramOfNode(n1)
  const w = await api('POST', `/api/workshop/dcw/params/${p1}/write`, { value: 230 }, 30000)
  await sleep(1200)
  const msg = captured.filter(c => c.topic === CMD_TOPIC).at(-1)
  let parsedOk = false
  try {
    const j = JSON.parse(msg?.payload ?? '')
    parsedOk = j?.cmd === 'set' && j?.params?.temp === 230 && j?.params?.hold === 8 && j?.ts === 123
  }
  catch { /* 非法 JSON */ }
  ok('B.tpl-payload', '下发报文为合法 JSON 且嵌套字段正确', parsedOk, `payload=${msg?.payload ?? '(无)'} ack=${JSON.stringify(w.data?.outcome?.ack ?? w.data?.outcome ?? {}).slice(0, 120)}`)
}

// 真实设备端:模拟器 commandTopic 解析 setpoint
const spBefore = await simSignal('inj-cool-mqtt', 'cool-water-sp')
const target = spBefore === 30 ? 29 : 30
const d2 = await api('POST', '/api/workshop/dcw', {
  name: 'E2E-MQTT-真机模板', lineId: LINE, driver: 'mqtt',
  driverConfig: {
    host: '127.0.0.1', port: 18830, topic: 'aw/inj/coolwater/set', qos: 1,
    jsonTemplate: '{"cmd":"set","setpoint":{{value}},"src":"awshop"}',
    readTopic: 'aw/inj/coolwater/state', readJsonPath: 'setpoint',
  },
  unit: '℃', decimals: 1, min: 10, max: 40, stepLimit: 10, holdIntervalMs: 0, templateRef: 'temp-sp',
})
const n2 = d2.data?.node?.id
if (n2) {
  const p2 = await paramOfNode(n2)
  const w2 = await api('POST', `/api/workshop/dcw/params/${p2}/write`, { value: target }, 30000)
  await sleep(2000)
  const spAfter = await simSignal('inj-cool-mqtt', 'cool-water-sp')
  ok('B.device', `设备端解析模板报文并生效(setpoint ${target})`, spAfter === target && spBefore !== target, `before=${spBefore} after=${spAfter}`)
  const rd = await api('POST', `/api/workshop/dcw/params/${p2}/read`, {})
  ok('B.readback', '状态主题回读模板下发值', rd.data?.read?.ok === true && Number(rd.data?.read?.value) === target, JSON.stringify(rd.data?.read ?? rd).slice(0, 220))
}
else ok('B.device', '建真机模板节点', false, d2.message)

// 坏模板 / 互斥 → 创建期 400
const bad1 = await api('POST', '/api/workshop/dcw', {
  name: 'E2E-MQTT-坏模板', lineId: LINE, driver: 'mqtt',
  driverConfig: { host: '127.0.0.1', port: 1883, topic: TPL_TOPIC, jsonTemplate: '{"sp":1}' },
  unit: '℃', decimals: 0, min: 0, max: 100, stepLimit: 10, holdIntervalMs: 0, templateRef: 'temp-sp',
})
ok('B.bad-no-placeholder', '缺 {{value}} 模板创建期拒绝', bad1.status === 400, `status=${bad1.status} msg=${bad1.message ?? ''}`)
const bad2 = await api('POST', '/api/workshop/dcw', {
  name: 'E2E-MQTT-互斥', lineId: LINE, driver: 'mqtt',
  driverConfig: { host: '127.0.0.1', port: 1883, topic: TPL_TOPIC, jsonKey: 'sp', jsonTemplate: '{"sp":{{value}}}' },
  unit: '℃', decimals: 0, min: 0, max: 100, stepLimit: 10, holdIntervalMs: 0, templateRef: 'temp-sp',
})
ok('B.conflict', 'jsonKey 与 jsonTemplate 互斥(创建期 400)', bad2.status === 400, `status=${bad2.status} msg=${bad2.message ?? ''}`)
const bad3 = await api('POST', '/api/workshop/dcw', {
  name: 'E2E-MQTT-坏JSON', lineId: LINE, driver: 'mqtt',
  driverConfig: { host: '127.0.0.1', port: 1883, topic: TPL_TOPIC, jsonTemplate: '{"sp":{{value}},}' },
  unit: '℃', decimals: 0, min: 0, max: 100, stepLimit: 10, holdIntervalMs: 0, templateRef: 'temp-sp',
})
ok('B.bad-json', '渲染后非 JSON 模板创建期拒绝', bad3.status === 400, `status=${bad3.status} msg=${bad3.message ?? ''}`)

// ---------- C. jsonKey 兼容 ----------
const d3 = await api('POST', '/api/workshop/dcw', {
  name: 'E2E-MQTT-兼容jsonKey', lineId: LINE, driver: 'mqtt',
  driverConfig: { host: '127.0.0.1', port: 1883, topic: TPL_TOPIC, jsonKey: 'setpoint', qos: 0 },
  unit: '℃', decimals: 0, min: 0, max: 300, stepLimit: 300, holdIntervalMs: 0, templateRef: 'temp-sp',
})
const n3 = d3.data?.node?.id
if (n3) {
  const p3 = await paramOfNode(n3)
  await api('POST', `/api/workshop/dcw/params/${p3}/write`, { value: 27 }, 30000)
  await sleep(1000)
  const msg = captured.filter(c => c.topic === TPL_TOPIC).at(-1)
  ok('C.jsonKey', 'jsonKey 单键下发保持兼容', msg?.payload === '{"setpoint":27}', `payload=${msg?.payload ?? '(无)'}`)
}
else ok('C.jsonKey', '建 jsonKey 兼容节点', false, d3.message)

// ---------- 清理 ----------
clearInterval(pubTimer); pub.end(true); sub.end(true)
const list = await api('GET', '/api/workshop/daq')
const mine = (list.data?.nodes ?? []).filter(n => String(n.name).startsWith('E2E-MQTT-'))
for (const n of mine) await api('DELETE', `/api/workshop/daq/${n.id}`)
const dcwList = await api('GET', '/api/workshop/dcw')
const mineDcw = (dcwList.data?.nodes ?? []).filter(n => String(n.name).startsWith('E2E-MQTT-'))
for (const n of mineDcw) await api('DELETE', `/api/workshop/dcw/${n.id}`)
console.log(`cleanup: daq=${mine.length} dcw=${mineDcw.length}`)

const pass = results.filter(r => r.pass).length
const report = { suite: 'MQTT 多字段采集 + jsonTemplate 下发(实机)', at: new Date().toISOString(), checks: results, verdict: `PASS(${pass}/${results.length})` }
writeFileSync('D:/codes/ABO/AgentWorkShop/tmp-e2e/idd-rag-e2e-20261030/mqtt-feature-report.json', JSON.stringify(report, null, 2))
console.log(`\nMQTT 新能力: ${report.verdict}`)
process.exit(pass === results.length ? 0 : 1)
