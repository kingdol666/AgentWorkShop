#!/usr/bin/env node
/**
 * 2026-10-31 文档驱动虚拟验证用 MQTT 发布器。
 * 每秒向 127.0.0.1:18830 的 aw/proto/doc/env 发布多字段 JSON:
 *   { ts, data: { temp, humidity } }
 * 用于验证同一 topic 多字段解析(两个 DAQ 节点各取 data.temp / data.humidity)。
 */
import { createRequire } from 'node:module'

const require = createRequire('D:/codes/ABO/AgentWorkShop/package.json')
const mqtt = require('mqtt')

const url = process.env.DOC_MQTT_URL ?? 'mqtt://127.0.0.1:18830'
const topic = process.env.DOC_MQTT_TOPIC ?? 'aw/proto/doc/env'
const client = mqtt.connect(url, { reconnectPeriod: 2000 })

let seq = 0
client.on('connect', () => {
  console.log(`[proto-doc-mqtt] connected ${url} topic=${topic}`)
  setInterval(() => {
    seq += 1
    const msg = {
      ts: Date.now(),
      data: {
        temp: Number((22 + Math.sin(seq / 10) * 1.5).toFixed(2)),
        humidity: Number((55 + Math.sin(seq / 7) * 5).toFixed(1)),
      },
    }
    client.publish(topic, JSON.stringify(msg), { qos: 0 })
  }, 1000)
})
client.on('error', err => console.error('[proto-doc-mqtt]', err.message))
