/**
 * 多协议模拟器(dev)—— MQTT Broker(最小实现)+ HTTP 端点,供驱动真连测试/演示。
 *   MQTT:mqtt://127.0.0.1:1883  broker 每 2s 发布 aw/sim/temp = {"data":{"temp":…}}
 *        (基于 mqtt-packet 编解码 —— mqtt.js 客户端同源参考实现;支持 QoS0 + +/# 通配)
 *   HTTP:http://127.0.0.1:1889/api/value(GET JSON)/ http://127.0.0.1:1889/api/setpoint(POST)
 * Modbus TCP 模拟器见 dev-modbus-simulator.mjs(1502);OPC UA 见 dev-opcua-simulator.mjs(4840)。
 */
import net from 'node:net'
import http from 'node:http'
import { createRequire } from 'node:module'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'

const reqRoot = createRequire(import.meta.url)
// pnpm 严格布局:mqtt-packet 是 mqtt 的传递依赖,从 mqtt 包入口路径解析
const reqMqtt = createRequire(reqRoot.resolve('mqtt'))
const mqttPacket = reqMqtt('mqtt-packet')

/** MQTT 主题过滤匹配(+ 单层 / # 多层) */
function topicMatch(filter, topic) {
  const f = filter.split('/')
  const t = topic.split('/')
  let i = 0
  for (; i < f.length; i++) {
    if (f[i] === '#') return true
    if (t[i] === undefined) return false
    if (f[i] !== '+' && f[i] !== t[i]) return false
  }
  return i === t.length
}

const clients = new Set()

function brokerPublish(topic, payload) {
  const frame = mqttPacket.generate({ cmd: 'publish', topic, payload, qos: 0 })
  console.log(`[mqtt-sim] route topic=${topic} clients=${clients.size} filters=[${[...clients].map(c => c.filters.join('|')).join(' ; ')}]`)
  // 控制下行审计:broker 真实收到的路由落盘(供 e2e 做确定性验收,不依赖订阅端时序)
  if (topic.startsWith('aw/sim/setpoint')) {
    try {
      appendFileSync(join(process.env.AW_SIM_AUDIT_DIR ?? '.AgentWorkShop/data', 'sim-setpoint-routes.log'), `${new Date().toISOString()} ${topic} ${payload.toString()}\n`)
    }
    catch { /* 审计失败不影响路由 */ }
  }
  for (const c of clients) {
    if (c.filters.some(f => topicMatch(f, topic))) {
      try {
        c.sock.write(frame)
      }
      catch { clients.delete(c) }
    }
  }
}

const mqttServer = net.createServer((sock) => {
  const client = { sock, filters: [] }
  clients.add(client)
  const parser = mqttPacket.parser({ protocolVersion: 4 })
  sock.on('data', (d) => {
    // 畸形帧(截断/坏头字节)只弃帧断该链,不许杀掉整个模拟工况
    try {
      parser.parse(d)
    }
    catch (err) {
      console.error('[mqtt-sim] 弃帧(解析异常):', err instanceof Error ? err.message : err)
      try {
        sock.destroy()
      }
      catch { /* 已断 */ }
      clients.delete(client)
    }
  })
  sock.on('error', () => clients.delete(client))
  sock.on('close', () => clients.delete(client))
  parser.on('packet', (packet) => {
    try {
      switch (packet.cmd) {
        case 'connect': {
          sock.write(mqttPacket.generate({ cmd: 'connack', returnCode: 0, sessionPresent: false }))
          break
        }
        case 'subscribe': {
          client.filters = packet.subscriptions.map(s => s.topic)
          sock.write(mqttPacket.generate({
            cmd: 'suback',
            messageId: packet.messageId,
            granted: packet.subscriptions.map(() => 0),
          }))
          break
        }
        case 'publish': {
          // 先回确认(QoS1 必须 puback,QoS0 无需),再路由
          if (packet.qos === 1) {
            sock.write(mqttPacket.generate({ cmd: 'puback', messageId: packet.messageId }))
          }
          brokerPublish(packet.topic, Buffer.from(packet.payload))
          break
        }
        case 'pubrel': {
          sock.write(mqttPacket.generate({ cmd: 'pubcomp', messageId: packet.messageId }))
          break
        }
        case 'puback': {
          // 客户端确认我方 QoS1 下行:无需动作
          break
        }
        case 'pingreq': {
          sock.write(mqttPacket.generate({ cmd: 'pingresp' }))
          break
        }
        case 'disconnect': {
          sock.end()
          break
        }
      }
    }
    catch { /* 单帧异常不断链 */ }
  })
})
mqttServer.listen(Number(process.env.MQTT_SIM_PORT ?? 1883), '127.0.0.1', () => {
  console.log('[mqtt-sim] broker mqtt://127.0.0.1:1883 就绪(每 2s 发布 aw/sim/temp)')
})

mqttServer.on('error', (err) => {
  console.error('[mqtt-sim] server error:', err.message)
})
// 周期发布模拟量(供数采驱动订阅)
let temp = 51.2
setInterval(() => {
  temp = Number(Math.max(40, Math.min(60, temp + (Math.random() - 0.48) * 0.6)).toFixed(2))
  brokerPublish('aw/sim/temp', Buffer.from(JSON.stringify({ data: { temp } })))
}, 2000)

// ---- HTTP 端点 ----
const httpServer = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => {
    body += c
  })
  req.on('end', () => {
    if (req.method === 'POST' && req.url === '/api/setpoint') {
      console.log('[http-sim] 收到下发:', body)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, received: JSON.parse(body || '{}') }))
      return
    }
    if (req.url?.startsWith('/api/value')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ code: 0, data: { value: Number((42.5 + (Math.random() - 0.5)).toFixed(2)) } }))
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found' }))
  })
})
httpServer.listen(Number(process.env.HTTP_SIM_PORT ?? 1889), '127.0.0.1', () => {
  console.log('[http-sim] GET http://127.0.0.1:1889/api/value / POST http://127.0.0.1:1889/api/setpoint 就绪')
})

mqttServer.on('error', err => console.error('[mqtt-sim] server error:', err.message))
httpServer.on('error', err => console.error('[http-sim] server error:', err.message))
process.on('unhandledRejection', err => console.error('[sim] unhandledRejection:', err instanceof Error ? err.message : err))
process.on('uncaughtException', err => console.error('[sim] uncaughtException:', err instanceof Error ? err.message : err))

process.on('SIGINT', () => {
  mqttServer.close()
  httpServer.close()
  process.exit(0)
})
