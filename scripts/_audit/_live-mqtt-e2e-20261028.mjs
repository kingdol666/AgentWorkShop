#!/usr/bin/env node
/**
 * MQTT 全链真实 E2E(2026-10-28;真实 broker 127.0.0.1:1883):
 *  场景:独立平台实例 + 模拟网关(node 客户端,复用仓库 mqtt 依赖)
 *   - 网关每 2s 向 mqtte2e/<TAG>/temp 发布 {"data":{"temperature":X,"humidity":Y}}(温度缓升,湿度乱摆——验证 jsonPath 单字段提取)
 *   - 网关订阅 mqtte2e/<TAG>/setpoint(控制主题),收到设定值后向 mqtte2e/<TAG>/state 回显 {"data":{"setpoint":X}}(模拟设备回显,供写后回读升级 verified)
 *  断言:
 *   T1 DAQ:平台订阅 temp 主题,jsonPath=data.temperature 提取入库;daq_query 点数随发布增长,数值=温度序列(非湿度)
 *   T2 DCW:recipe_trial(手动 HITL 批准)下发 238 → 网关控制主题收到 {"setpoint":238}(jsonKey 封装)→ 回显 → 写后回读升级 readback-verified(设备证实✓)
 *   T3 稳定性:持续 90s 泡水,daq 点数单调增长、节点保持在线、journal 锚点齐全
 * 运行:node scripts/_audit/_live-mqtt-e2e-20261028.mjs
 */
import { spawn } from 'node:child_process'
import net from 'node:net'
import { mkdirSync, openSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const EVID = join(REPO, 'docs', 'audit', 'evidence', '2026-10-28-mqtt-live')
mkdirSync(EVID, { recursive: true })
const ROOT = join(tmpdir(), 'aw-mqtt-e2e')
rmSync(join(ROOT, 'home'), { recursive: true, force: true })
mkdirSync(join(ROOT, 'home'), { recursive: true })
const TAG = `mq${Date.now().toString(36).slice(-4)}`
const T_TEMP = `mqtte2e/${TAG}/temp`
const T_SET = `mqtte2e/${TAG}/setpoint`
const T_STATE = `mqtte2e/${TAG}/state`
const BASE = 'http://127.0.0.1:3986'
const log = (s) => { console.log(`[${new Date().toISOString().slice(11, 19)}] ${s}`) }
const sleep = ms => new Promise(r => setTimeout(r, ms))

// ── 前置:broker 探活 ──
const brokerUp = await new Promise((res) => {
  const s = net.connect(1883, '127.0.0.1')
  s.setTimeout(2000)
  s.on('connect', () => { s.end(); res(true) })
  s.on('error', () => res(false))
  s.on('timeout', () => { s.destroy(); res(false) })
})
if (!brokerUp) {
  console.log('✖ 127.0.0.1:1883 无 MQTT broker —— 先启动 broker(mosquitto -v -p 1883)')
  process.exit(1)
}
log('broker 127.0.0.1:1883 在线')

// ── 模拟网关:发布温度 JSON + 订阅控制主题回显状态 ──
const mqtt = (await import('mqtt')).default
const receivedWrites = []
let tempVal = 22.5
const gateway = mqtt.connect('mqtt://127.0.0.1:1883', { connectTimeout: 4000 })
await new Promise((res, rej) => { gateway.once('connect', res); gateway.once('error', rej) })
gateway.subscribe(T_SET, { qos: 1 })
gateway.on('message', (topic, payload) => {
  if (topic !== T_SET) return
  try {
    const msg = JSON.parse(payload.toString())
    receivedWrites.push({ at: Date.now(), raw: payload.toString(), setpoint: msg.setpoint })
    gateway.publish(T_STATE, JSON.stringify({ data: { setpoint: msg.setpoint } }), { qos: 1 })
    log(`网关收到控制令牌:${payload.toString()} → 回显状态主题`)
  }
  catch { /* 非 JSON */ }
})
// 温度缓升(22.5 起 +0.3/次),湿度独立乱摆——两者可区分
const pubTimer = setInterval(() => {
  tempVal = Math.round((tempVal + 0.3) * 100) / 100
  const hum = Math.round(40 + Math.random() * 20)
  gateway.publish(T_TEMP, JSON.stringify({ data: { temperature: tempVal, humidity: hum } }), { qos: 1 })
}, 2000)
log(`模拟网关上线:每 2s → ${T_TEMP} = {"data":{"temperature":…,"humidity":…}};订阅 ${T_SET}`)

// ── 平台实例 ──
process.env.NO_PROXY = '127.0.0.1,localhost'
const logFd = openSync(join(ROOT, 'dev.log'), 'a')
// build 产物跑(无 nitro 文件监听):并行会话写盘不再触发 HMR 重载风暴(验收 skill 标准跑法)
const child = spawn(process.execPath, [join(REPO, '.output', 'server', 'index.mjs')], {
  cwd: REPO,
  env: { ...process.env, AW_MODE: 'home', AW_HOME: join(ROOT, 'home'), PORT: '3986', AW_RATE_LIMIT_OFF: '1', NUXT_SESSION_PASSWORD: 'MqttE2e#2026-session-key-0321', NO_PROXY: '127.0.0.1,localhost' },
  stdio: ['ignore', logFd, logFd],
  windowsHide: true,
})
let healthy = false
for (let i = 0; i < 90; i++) {
  await sleep(2000)
  try {
    const h = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(3000) }).then(r => r.json()).catch(() => null)
    if (h?.data?.status === 'ok' && h?.data?.workshop === 'ready') { healthy = true; break }
  }
  catch { /* 未就绪 */ }
}
log(`平台实例:${healthy ? '就绪' : '未就绪'}`)
if (!healthy) process.exit(1)

const reg = await fetch(`${BASE}/api/users/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: `mq-admin-${TAG}`, email: `mq-${TAG}@awshop.local`, password: 'MqE2e#2026' }) }).then(r => r.json())
const H = () => reg.data.token
const api = async (method, path, body, timeoutMs = 120_000) => {
  // 兼容旧调用形参:第 4 参可能传的是 token(H())——非数字视为缺省超时
  const timeout = typeof timeoutMs === 'number' ? timeoutMs : 120_000
  const res = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', 'authorization': `Bearer ${H()}` }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeout) })
  let json = null
  try { json = await res.json() } catch { /* 非 JSON */ }
  return { status: res.status, ...json }
}
const invText = r => String(r?.data?.result?.text ?? r?.data?.text ?? '')
const invErr = r => Boolean(r?.data?.result?.isError ?? r?.data?.isError)
let lead = ''
const invoke = (tool, args) => api('POST', '/api/workshop/agent-tools/invoke', { agentId: lead, tool, args }, H())
const results = []
const ok = (id, name, cond, detail = '') => {
  results.push({ id, pass: Boolean(cond) })
  console.log(`${cond ? '✔' : '✖'} [${id}] ${name}${cond ? '' : ` — ${String(detail).slice(0, 260)}`}`)
}

try {
  // ── 场景供给 ──
  const line = (await api('POST', '/api/workshop/dcw/lines', { name: `MQTT实测线-${TAG}` }, H())).data?.line?.id
  const spNode = (await api('POST', '/api/workshop/dcw', {
    templateRef: 'dcw-temp-sp', name: `MQTT设定-${TAG}`, driver: 'mqtt', lineId: line,
    min: 160, max: 300, stepLimit: 20,
    driverConfig: { host: '127.0.0.1', port: 1883, topic: T_SET, jsonKey: 'setpoint', qos: 1, readTopic: T_STATE, readJsonPath: 'data.setpoint' },
  }, H())).data?.node?.id
  const pvNode = (await api('POST', '/api/workshop/daq', {
    templateRef: 'daq-temp-tc', name: `MQTT温度-${TAG}`, driver: 'mqtt', lineId: line, intervalMs: 2000, publishIntervalMs: 0,
    min: 10, max: 60,
    driverConfig: { host: '127.0.0.1', port: 1883, topic: T_TEMP, jsonPath: 'data.temperature', qos: 1 },
  }, H())).data?.node?.id
  const product = (await api('POST', '/api/workshop/dcw/products', { lineId: line, name: `MQTT产品-${TAG}` }, H())).data?.product?.id
  const recipe = (await api('POST', '/api/workshop/dcw/recipes', { productId: product, name: `MQTT配方-${TAG}`, params: [{ nodeId: spNode, value: 240, min: 160, max: 300 }] }, H())).data?.recipe?.id
  await api('POST', '/api/workshop/dcw/controller', { action: 'start' }, H())
  await api('POST', '/api/workshop/daq/controller', { action: 'start' }, H())
  const ch = (await api('POST', '/api/workshop/channels', { name: `MQTT频道-${TAG}`, leadAgent: { name: `mq-lead-${TAG}`, harness: 'omp' } }, H())).data
  lead = ch.leadAgentId
  await api('PUT', `/api/workshop/channels/${ch.channelId}/line`, { lineId: line }, H())
  await api('POST', `/api/workshop/channels/${ch.channelId}/activate`, {}, H())
  await api('POST', '/api/workshop/agent-tools/bindings', { agentId: ch.leadAgentId, nodeId: pvNode, kind: 'daq' }, H())
  const rb = await api('POST', '/api/workshop/agent-tools/bindings', { agentId: ch.leadAgentId, nodeId: recipe, kind: 'recipe' }, H())
  const bindingId = rb?.data?.binding?.id
  ok('S1', '场景供给(线/MQTT 数采节点/MQTT 设定节点/配方/频道/绑定)', Boolean(line && spNode && pvNode && recipe && ch?.channelId && bindingId),
    JSON.stringify({ line, spNode, pvNode, recipe }).slice(0, 200))

  // ── T0 开线(HITL):配方参数 240 会经 MQTT 驱动发布到控制主题 ──
  const known0 = new Set((await api('GET', '/api/workshop/hitl/pending', undefined, H())).data?.items?.map(x => x.id) ?? [])
  const p0 = invoke('line_start', { recipe_id: recipe, reason: `MQTT E2E 开线(${TAG})` })
  let card0 = null
  for (let i = 0; i < 40 && !card0; i++) {
    await sleep(1000)
    card0 = ((await api('GET', '/api/workshop/hitl/pending', undefined, H())).data?.items ?? []).find(x => !known0.has(x.id))
  }
  if (card0) await api('POST', '/api/workshop/hitl/respond', { kind: 'dcw-approval', id: card0.id, confirmed: true, choice: 0, comment: 'MQTT E2E 批准开线' }, H())
  const r0 = await p0
  ok('T0', '开线成功且参数设备证实(readback-verified:网关回显经 readTopic)', !invErr(r0) && /readback|设备证实|verified/.test(invText(r0)), invText(r0).slice(0, 200))
  const sawLineStartWrite = receivedWrites.find(w => w.setpoint === 240)
  ok('T0b', '开线下发经 jsonKey 封装为 JSON 到控制主题({"setpoint":240})', Boolean(sawLineStartWrite), JSON.stringify(receivedWrites.slice(0, 3)))

  // ── T1 DAQ:jsonPath 单字段提取实时入库 ──
  await sleep(16_000)
  const q1 = await api('GET', `/api/workshop/daq/query?node_ids=${pvNode}&last_minutes=1`, undefined, H())
  const pts1 = (q1.data?.series ?? []).reduce((n, s) => n + (s.points?.length ?? 0), 0)
  const pointOf = p => Number(p?.v ?? p?.avg ?? p?.value ?? Number.NaN)
  if (pts1 > 0) writeFileSync(join(EVID, `daq-point-shape-${TAG}.json`), JSON.stringify((q1.data?.series ?? [])[0]?.points?.slice(0, 2) ?? []))
  const vals1 = (q1.data?.series ?? []).flatMap(s => (s.points ?? []).map(pointOf)).filter(Number.isFinite)
  // 数值应落在温度序列区间(22.5 起缓升),而非湿度区间(40-60)
  const inTempRange = vals1.filter(v => v >= 22 && v <= 40).length
  ok('T1a', `DAQ jsonPath 提取:单条 JSON 报文取 data.temperature 入库(${pts1} 点)`, pts1 > 0, `points=${pts1}`)
  ok('T1b', '取的是温度字段而非同报文湿度字段(22~40 区间)', pts1 > 0 && inTempRange === pts1, `vals=${vals1.slice(0, 6)} humidity-range hits=${pts1 - inTempRange}`)

  // ── T2 DCW:recipe_trial 手动批准 → JSON 下发 + 回读升级 verified ──
  const writesBefore = receivedWrites.length
  const known = new Set((await api('GET', '/api/workshop/hitl/pending', undefined, H())).data?.items?.map(x => x.id) ?? [])
  const p = invoke('recipe_trial', { recipe_id: recipe, params: [{ node_id: spNode, value: 238 }], hypothesis: `MQTT E2E:试 238℃(${TAG})` })
  let card = null
  for (let i = 0; i < 40 && !card; i++) {
    await sleep(1000)
    card = ((await api('GET', '/api/workshop/hitl/pending', undefined, H())).data?.items ?? []).find(x => !known.has(x.id))
  }
  ok('T2a', 'recipe_trial 生成 HITL 审批卡(recipe 只管参数值,封装交给节点配置)', Boolean(card), card?.id ?? '未出现')
  if (card) await api('POST', '/api/workshop/hitl/respond', { kind: 'dcw-approval', id: card.id, confirmed: true, choice: 0, comment: 'MQTT E2E 批准 238' }, H())
  const r = await p
  const txt = invText(r)
  ok('T2b', '批准后执行:写后回读经状态主题升级 readback-verified(设备证实✓)', !invErr(r) && /设备证实|readback/.test(txt), txt.slice(0, 220))
  await sleep(1500)
  const w238 = receivedWrites.filter(w => w.setpoint === 238)
  ok('T2c', '我方订阅端收到 JSON 写报文 {"setpoint":238}', w238.length > 0 && w238[0].raw === '{"setpoint":238}', JSON.stringify(receivedWrites.slice(writesBefore).map(w => w.raw)))
  writeFileSync(join(EVID, `received-writes-${TAG}.json`), JSON.stringify(receivedWrites, null, 2))

  // ── T3 稳定性泡水 90s:点数持续增长、节点在线 ──
  const qA = await api('GET', `/api/workshop/daq/query?node_ids=${pvNode}&last_minutes=10`, undefined, H())
  const nA = (qA.data?.series ?? []).reduce((n, s) => n + (s.points?.length ?? 0), 0)
  let staleErr = 0
  for (let i = 0; i < 9; i++) {
    await sleep(10_000)
    const d = await api('GET', '/api/workshop/daq', undefined, H())
    const node = (d.data?.nodes ?? []).find(x => x.id === pvNode)
    if (node && (node.state === 'offline' || node.lastError)) staleErr++
    log(`泡水 ${((i + 1) * 10)}s:已入库点数 ${((await api('GET', `/api/workshop/daq/query?node_ids=${pvNode}&last_minutes=10`, undefined, H())).data?.series ?? []).reduce((n, s) => n + (s.points?.length ?? 0), 0)}`)
  }
  const qB = await api('GET', `/api/workshop/daq/query?node_ids=${pvNode}&last_minutes=10`, undefined, H())
  const nB = (qB.data?.series ?? []).reduce((n, s) => n + (s.points?.length ?? 0), 0)
  const valsB = (qB.data?.series ?? []).flatMap(s => (s.points ?? []).map(pointOf)).filter(Number.isFinite)
  ok('T3a', `90s 泡水:点数持续增长(${nA} → ${nB})`, nB > nA + 20, `delta=${nB - nA}`)
  ok('T3b', '泡水期间节点无 offline/无 lastError(陈值看门狗未误报)', staleErr === 0, `offline polling hits=${staleErr}`)
  ok('T3c', '长程数值仍为温度序列且严格递增(缓升序列无乱序/无冻值)', valsB.length > 10 && valsB.every((v, i) => i === 0 || v >= valsB[i - 1]), `head=${valsB.slice(0, 5)} tail=${valsB.slice(-5)}`)

  // 归档
  writeFileSync(join(EVID, `summary-${TAG}.json`), JSON.stringify({ tag: TAG, topics: { temp: T_TEMP, setpoint: T_SET, state: T_STATE }, line, spNode, pvNode, recipe, receivedWrites, daqPoints: { atT1: pts1, atT3: nB }, results }, null, 2))
  const pass = results.every(r => r.pass)
  console.log(`\n===== MQTT 全链实测:${results.filter(r => r.pass).length}/${results.length} PASS =====`)
  process.exitCode = pass ? 0 : 1
}
catch (err) {
  log(`FATAL ${err instanceof Error ? err.message : String(err)}`)
  process.exitCode = 1
}
finally {
  clearInterval(pubTimer)
  try { gateway.end(true) } catch { /* ignore */ }
  try { child.kill() } catch { /* ignore */ }
}
