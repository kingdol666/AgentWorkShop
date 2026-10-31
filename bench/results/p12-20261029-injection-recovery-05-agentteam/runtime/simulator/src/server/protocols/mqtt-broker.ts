/**
 * 内置 MQTT mini-broker —— QoS0/1 + 通配订阅,基于 mqtt-packet 编解码。
 * 用途:模拟器 MQTT 设备默认发布到本 broker(18830),不依赖外部基础设施;
 * 主项目 mqtt 驱动也可直接订阅本 broker 的设备主题联调。
 * (抄自主项目 dev-protocol-simulators.mjs 已验证实现,含畸形帧弃帧不断链策略)
 */
import net from 'node:net'
import { createRequire } from 'node:module'

type Publish = { topic: string, payload: Buffer, qos: 0 | 1, retain: boolean }
type Sub = { topic: string, qos: 0 | 1, socket: net.Socket }

const clients = new Map<net.Socket, { subs: Sub[], clientId: string }>()
/** 保留消息(topic → 最后一条 retain 报文):上位机晚订阅也能立即拿到当前值 */
const retained = new Map<string, Publish>()

function topicMatch(pattern: string, topic: string): boolean {
  const p = pattern.split('/')
  const t = topic.split('/')
  for (let i = 0; i < p.length; i++) {
    if (p[i] === '#') return true
    if (p[i] === '+') continue
    if (p[i] !== t[i]) return false
  }
  return p.length === t.length
}

function deliver(pub: Publish, from: net.Socket): void {
  for (const [sock, st] of clients) {
    if (sock === from) continue
    for (const s of st.subs) {
      if (!topicMatch(s.topic, pub.topic)) continue
      const packet: Record<string, unknown> = { cmd: 'publish', topic: pub.topic, payload: pub.payload, qos: pub.qos, retain: pub.retain }
      if (pub.qos > 0) packet.messageId = nextMsgId(sock)
      const req = mqttPacket.generate(packet)
      sock.write(req)
      break
    }
  }
}

const msgIdCounters = new WeakMap<net.Socket, number>()
function nextMsgId(sock: net.Socket): number {
  const cur = (msgIdCounters.get(sock) ?? 0) % 65535 + 1
  msgIdCounters.set(sock, cur)
  return cur
}

// mqtt-packet 是 mqtt 包的传递依赖,经 createRequire 双跳解析(npm/pnpm 布局均兼容)
let mqttPacket: { parser: (opt?: unknown) => { parse: (d: Buffer) => void, on: (ev: string, fn: (p: never) => void) => void }, generate: (p: unknown, opt?: unknown) => Buffer }
try {
  const req = createRequire(import.meta.url)
  try {
    mqttPacket = req('mqtt-packet') as never
  }
  catch {
    const reqMqtt = createRequire(req.resolve('mqtt'))
    mqttPacket = reqMqtt('mqtt-packet') as never
  }
}
catch {
  mqttPacket = undefined as never
}

let server: net.Server | null = null

export async function startBroker(port = 18830, host = '127.0.0.1'): Promise<void> {
  if (server) return
  if (!mqttPacket) throw new Error('mqtt-packet 不可用(检查 mqtt 依赖)')
  server = net.createServer((sock) => {
    const st = { subs: [] as Sub[], clientId: '' }
    clients.set(sock, st)
    // mqtt-packet 的 parser 是带 .parse() 的对象(非 stream);必须显式 protocolVersion 4
    const parser = mqttPacket.parser({ protocolVersion: 4 })
    sock.on('error', () => { clients.delete(sock) })
    sock.on('close', () => { clients.delete(sock) })
    parser.on('packet', (packet: Record<string, unknown> & { cmd: string }) => {
      try {
        switch (packet.cmd) {
          case 'connect': {
            sock.write(mqttPacket.generate({ cmd: 'connack', returnCode: 0, sessionPresent: false }))
            break
          }
          case 'publish': {
            const pub: Publish = {
              topic: String(packet.topic ?? ''),
              payload: Buffer.from(packet.payload as Buffer),
              qos: (packet.qos ?? 0) as 0 | 1,
              retain: Boolean(packet.retain),
            }
            // 先回确认(QoS1 必须 puback),再路由
            if (pub.qos > 0) sock.write(mqttPacket.generate({ cmd: 'puback', messageId: packet.messageId }))
            // 保留消息:空载荷 = 清除该 topic 的保留值(MQTT 3.1.1 语义)
            if (pub.retain) {
              if (pub.payload.length === 0) retained.delete(pub.topic)
              else retained.set(pub.topic, pub)
            }
            deliver(pub, sock)
            break
          }
          case 'subscribe': {
            const subs = (packet.subscriptions ?? []) as Array<{ topic: string, qos: 0 | 1 }>
            for (const s of subs) st.subs.push({ topic: s.topic, qos: s.qos, socket: sock })
            sock.write(mqttPacket.generate({
              cmd: 'suback',
              messageId: packet.messageId,
              granted: subs.map(() => 0),
            }))
            // 保留消息补发:订阅建立后立即推送匹配的 retain 报文(上位机晚连也能拿到当前值)
            for (const [topic, pub] of retained) {
              if (!subs.some(s => topicMatch(s.topic, topic))) continue
              sock.write(mqttPacket.generate({
                cmd: 'publish',
                topic,
                payload: pub.payload,
                qos: 0,
                retain: true,
              }))
            }
            break
          }
          case 'unsubscribe': {
            const topics = (packet.unsubscriptions ?? []) as string[]
            st.subs = st.subs.filter(s => !topics.includes(s.topic))
            sock.write(mqttPacket.generate({ cmd: 'unsuback', messageId: packet.messageId }))
            break
          }
          case 'pubrel':
            sock.write(mqttPacket.generate({ cmd: 'pubcomp', messageId: packet.messageId }))
            break
          case 'puback':
            break // 客户端确认我方 QoS1 下行
          case 'pingreq':
            sock.write(mqttPacket.generate({ cmd: 'pingresp' }))
            break
          case 'disconnect':
            sock.end()
            break
          default:
            break // 未知帧弃置不断链
        }
      }
      catch (err) {
        console.error('[mqtt-broker] 帧处理异常:', (err as Error).message)
      }
    })
    sock.on('data', (d) => {
      // 畸形帧(截断/坏头)只断该链,不影响 broker 其他客户端
      try {
        parser.parse(d)
      }
      catch {
        try { sock.destroy() } catch { /* 已断 */ }
        clients.delete(sock)
      }
    })
  })
  await new Promise<void>((resolve, reject) => {
    server!.once('error', reject)
    server!.listen(port, host, () => resolve())
    setTimeout(() => reject(new Error(`mqtt-broker ${host}:${port} 监听超时`)), 8000)
  })
  console.log(`[mqtt-broker] 内置 broker 就绪 mqtt://${host}:${port}`)
}

export async function stopBroker(): Promise<void> {
  if (!server) return
  for (const [sock] of clients) sock.destroy()
  clients.clear()
  retained.clear()
  server.close(() => {})
  server = null
}
