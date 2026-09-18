const BASE = process.env.AW_BASE ?? 'http://127.0.0.1:3021'
const api = async (m, p, body, token) => {
  const h = { 'content-type': 'application/json' }
  if (token) h.authorization = 'Bearer ' + token
  const r = await fetch(BASE + p, { method: m, headers: h, body: body ? JSON.stringify(body) : undefined })
  const t = await r.text()
  try {
    return JSON.parse(t)
  }
  catch {
    return { code: -1, message: 'HTTP ' + r.status }
  }
}
const token = (await api('POST', '/api/users/login', { email: 'admin@awshop.local', password: 'admin123' })).data.token
const nodes = (await api('GET', '/api/workshop/daq', null, token)).data.nodes
const simPorts = [16040, 15041, 5840, 18830, 4010]
const sim = nodes.filter(n => simPorts.some(p => JSON.stringify(n).includes(String(p))))
const good = sim.filter(n => n.state === 'ok' || n.state === 'warn')
console.log('在线且有值的模拟器节点:', good.length, '/', sim.length)
const seen = new Set()
for (const n of good) {
  const key = n.driver
  if (seen.has(key) && seen.size > 4) continue
  seen.add(key)
  const c = n.config ?? {}
  console.log('  ' + String(n.name).padEnd(22) + String(n.driver).padEnd(12) + 'state=' + String(n.state).padEnd(6) + 'val=' + String(n.value).padStart(10) + ' ' + String(n.unit ?? '').padEnd(6) + '| ' + JSON.stringify({ host: c.host, port: c.port, unitId: c.unitId, register: c.register, dataType: c.dataType, topic: c.topic, nodeId: c.nodeId, url: c.url }).slice(0, 150))
}
console.log('')
console.log('按驱动看最后更新时间(判断是否还在采):')
const byDrv = {}
for (const n of good) {
  byDrv[n.driver] = byDrv[n.driver] ?? { n: 0, last: '' }
  byDrv[n.driver].n++
  const t = n.lastSampleAt ?? n.updatedAt ?? ''
  if (t > byDrv[n.driver].last) byDrv[n.driver].last = t
}
for (const [k, v] of Object.entries(byDrv)) console.log('   ' + k.padEnd(14) + ' 在线 ' + String(v.n).padStart(4) + '  最近采样 ' + v.last)
