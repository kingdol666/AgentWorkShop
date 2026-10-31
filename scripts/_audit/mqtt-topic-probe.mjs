// MQTT 主题探针:订阅指定 broker/topic 6s,打印报文数与首条(验证设备端发布活性)
import mqtt from 'mqtt'

const [, , url = 'mqtt://127.0.0.1:1883', topic = 'aw/proto/doc/env'] = process.argv
const c = mqtt.connect(url, { connectTimeout: 3000 })
const got = []
c.on('connect', () => { c.subscribe(topic, { qos: 0 }) })
c.on('error', (e) => { console.log('conn err:', String(e).slice(0, 120)) })
c.on('message', (t, p) => got.push(p.toString().slice(0, 160)))
setTimeout(() => {
  console.log(`topic=${topic} messages in 6s: ${got.length}`)
  if (got[0]) console.log('first:', got[0])
  c.end(true)
  process.exit(0)
}, 6000)
