/**
 * MQTT 模拟数据发布器:向真实 mosquitto(1883)每 2s 发布 aw/sim/temp = {"data":{"temp":…}},
 * 供 daq mqtt 驱动节点订阅采样(与 dev-protocol-simulators 的载荷形状一致)。
 * 用法:node scripts/_dbg-mqtt-publisher.mjs  (前台常驻;SIGINT 退出)
 */
import { createRequire } from 'node:module'
const req = createRequire(import.meta.url)
const mqtt = req('mqtt')

const client = mqtt.connect('mqtt://127.0.0.1:1883', { reconnectPeriod: 3000 })
let temp = 51.2
client.on('connect', () => console.log('[mqtt-pub] 已连接 mosquitto 1883,开始发布 aw/sim/temp'))
client.on('error', (e) => console.error('[mqtt-pub] error:', e.message))
setInterval(() => {
  temp = Number(Math.max(40, Math.min(60, temp + (Math.random() - 0.48) * 0.6)).toFixed(2))
  client.publish('aw/sim/temp', JSON.stringify({ data: { temp } }), { qos: 0 })
}, 2000)
