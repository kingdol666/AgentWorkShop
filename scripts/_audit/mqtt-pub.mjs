// MQTT 一次性发布器:node mqtt-pub.mjs <url> <topic> <json>
import mqtt from 'mqtt'

const [, , url = 'mqtt://127.0.0.1:18830', topic = 'aw/blow/b3/cmd/pressure', json = '{"sp":2.6}'] = process.argv
const c = mqtt.connect(url, { connectTimeout: 3000, reconnectPeriod: 0 })
c.on('connect', () => {
  c.publish(topic, json, { qos: 1 }, (err) => {
    console.log(err ? `pub err: ${err.message}` : `published → ${topic} ${json}`)
    c.end(true, () => process.exit(err ? 1 : 0))
  })
})
c.on('error', (e) => { console.log(`conn err: ${String(e).slice(0, 120)}`); process.exit(1) })
setTimeout(() => { console.log('timeout'); process.exit(1) }, 8000).unref()
