// 3# 吹瓶产线(BC-3)设备模拟器 —— 严格按 docs/audit/2026-10-31-b3-blowline-protocol-manual.md v1.4 合同实现
// HTTP 4021: GET /api/v1/melt/pressure | GET /api/v1/preform/temp | GET /api/v1/wall/profile | PUT+GET /api/v1/head/temp/sp
// MQTT 18830: publish aw/blow/b3/env(2s, temp+humidity 同报文) | subscribe aw/blow/b3/cmd/pressure → 应用后 publish aw/blow/b3/sp/pressure
import http from 'node:http'
import mqtt from 'mqtt'
import { appendFileSync } from 'node:fs'

const LOG = 'D:/tmp/proto-b3-device-4021.log'
const log = (s) => { try { appendFileSync(LOG, `${new Date().toISOString()} ${s}\n`) } catch {} }
const PORT = 4021
const MQTT_URL = 'mqtt://127.0.0.1:18830'

const state = { headSp: 210.0, blowSp: 2.6 }
const noise = a => (Math.random() - 0.5) * 2 * a
const now = () => Date.now()

// 工况曲线(文档 §2/§6 期望带内)
const meltPressure = () => +(23.5 + 1.5 * Math.sin(Date.now() / 60000) + noise(0.05)).toFixed(2)
const preformTemp = () => +(105 + 2 * Math.sin(Date.now() / 120000) + noise(0.2)).toFixed(1)
const envTemp = () => +(22.3 + 0.5 * Math.sin(Date.now() / 300000) + noise(0.05)).toFixed(1)
const envHumidity = () => +(52 + 1.5 * Math.sin(Date.now() / 240000) + noise(0.1)).toFixed(1)
const wallProfile = () => Array.from({ length: 16 }, (_, i) =>
  +(1.4 + 0.3 * Math.sin((i / 16) * Math.PI * 2) + 0.05 * Math.sin(Date.now() / 45000) + noise(0.005)).toFixed(3))

// ── HTTP 面 ──
const server = http.createServer((req, res) => {
  const url = (req.url ?? '').split('?')[0]
  const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
  if (req.method === 'GET' && url === '/api/v1/melt/pressure')
    return send(200, { code: 0, data: { pressure: meltPressure(), ts: now() } })
  if (req.method === 'GET' && url === '/api/v1/preform/temp')
    return send(200, { code: 0, data: { temp: preformTemp(), ts: now() } })
  if (req.method === 'GET' && url === '/api/v1/wall/profile')
    return send(200, { code: 0, data: { points: wallProfile(), ts: now() } })
  if (req.method === 'GET' && url === '/api/v1/head/temp/sp')
    return send(200, { code: 0, data: { sp: state.headSp, applied: true } })
  // 集成注记 v1.4.1:平台 http 写驱动仅发 POST(硬编码,dcw/drivers/http.ts:47);网关为集成兼容
  // 同时接受 POST 别名(合同原生语义仍为 PUT,厂家设备不变)
  if ((req.method === 'PUT' || req.method === 'POST') && url === '/api/v1/head/temp/sp') {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      try {
        const body = JSON.parse(raw || '{}')
        const sp = Number(body.sp)
        if (!Number.isFinite(sp)) return send(400, { code: 4001, message: 'BAD_PAYLOAD: sp 非数值' })
        if (sp < 150 || sp > 260) return send(400, { code: 4002, message: `OUT_OF_RANGE: ${sp} 超出 150~260` })
        state.headSp = +sp.toFixed(1)
        log(`HTTP SP head-temp → ${state.headSp}`)
        // 集成注记 v1.4.1(续):写应答按平台 http 写驱动合同平铺设定值字段(顶层 bodyKey);
        // 合同原文的嵌套信封保留在 GET 读取面。两点均为网关别名,厂家设备原生不变。
        send(200, { sp: state.headSp, applied: true })
      } catch (e) { send(400, { code: 4003, message: `BAD_JSON: ${String(e).slice(0, 60)}` }) }
    })
    return
  }
  if (req.method === 'GET' && url === '/health') return send(200, { ok: true, port: PORT, blowSp: state.blowSp, headSp: state.headSp })
  send(404, { code: 404, message: `NOT_FOUND: ${url}` })
})

// ── MQTT 面 ──
const client = mqtt.connect(MQTT_URL, { connectTimeout: 4000, reconnectPeriod: 2000 })
client.on('connect', () => {
  log(`mqtt connected ${MQTT_URL}`)
  client.subscribe('aw/blow/b3/cmd/pressure', { qos: 1 })
  setInterval(() => {
    const payload = JSON.stringify({ temp: envTemp(), humidity: envHumidity(), ts: now() })
    client.publish('aw/blow/b3/env', payload, { qos: 0 })
  }, 2000)
})
client.on('message', (_topic, payload) => {
  try {
    const body = JSON.parse(payload.toString())
    const sp = Number(body.sp)
    if (!Number.isFinite(sp) || sp < 0 || sp > 3.0) {
      log(`MQTT cmd REJECT sp=${sp}(量程 0~3.0 预警线)`)
      return
    }
    // 文档 §3.2:设备应用后(延迟 <1s)发布确认报文
    setTimeout(() => {
      state.blowSp = +sp.toFixed(2)
      const confirm = JSON.stringify({ sp: state.blowSp, applied: true, ts: now() })
      client.publish('aw/blow/b3/sp/pressure', confirm, { qos: 1 })
      log(`MQTT cmd APPLIED sp=${state.blowSp} → confirm published`)
    }, 250)
  } catch (e) { log(`MQTT cmd parse err: ${String(e).slice(0, 80)}`) }
})
client.on('error', e => log(`mqtt err: ${String(e).slice(0, 100)}`))

server.listen(PORT, () => log(`HTTP listening :${PORT} (合同=2026-10-31-b3-blowline-protocol-manual.md v1.4)`))
