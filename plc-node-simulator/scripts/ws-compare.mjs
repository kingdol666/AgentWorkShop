import { WebSocket } from 'ws'
const nodes = (await (await fetch('http://127.0.0.1:4010/api/nodes')).json()).data
const apiIds = {}
for (const n of nodes) apiIds[n.id] = (n.signals ?? []).map(s => s.id)
console.log('=== /api/nodes ===')
for (const [k, v] of Object.entries(apiIds)) console.log('  ' + k.padEnd(22) + v.join(', '))

const ws = new WebSocket('ws://127.0.0.1:4010/ws')
const seen = {}
ws.on('message', (d) => {
  const f = JSON.parse(String(d))
  if (f.type !== 'signal.update') return
  const id = f.payload.nodeId
  seen[id] = seen[id] ?? new Set()
  for (const s of f.payload.signals) seen[id].add(s.id + '=' + s.value)
})
setTimeout(() => {
  console.log('')
  console.log('=== WS 推送(12 秒内见过的 nodeId / 信号) ===')
  for (const [k, v] of Object.entries(seen)) {
    const inApi = apiIds[k] ? 'API 有此设备' : '❌ API 里没有这个 nodeId'
    console.log('  ' + k.padEnd(22) + '[' + inApi + ']  ' + Array.from(v).slice(0, 6).join('  '))
  }
  const missing = Object.keys(seen).filter(k => !apiIds[k])
  console.log('')
  console.log('WS 里出现但设备列表里没有的 nodeId:', missing.length ? missing.join(', ') : '(无)')
  const neverPushed = Object.keys(apiIds).filter(k => !seen[k])
  console.log('有设备但 12 秒内没推送的:', neverPushed.length ? neverPushed.join(', ') : '(无)')
  process.exit(0)
}, 12000)
