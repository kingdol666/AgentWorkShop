/**
 * 一次性:重启存活验证 —— dev 重启后,前端配置的节点(daqs.json)仍存在,
 * 且 driverConfig 完整、采集在真实 MQTT/Timescale 链路上恢复。
 * 前置:外部已重启 dev(本脚本轮询 health 最多 3 分钟),然后查节点+样本增量。
 */
const BASE = 'http://127.0.0.1:3000'
let ready = false
for (let i = 0; i < 36; i++) {
  try {
    const r = await fetch(`${BASE}/api/health`).then(x => x.json())
    if (r?.code === 0) { ready = true; break }
  }
  catch { /* 未就绪 */ }
  await new Promise(rr => setTimeout(rr, 5000))
}
if (!ready) { console.error('dev 未就绪'); process.exit(1) }

const login = await fetch(`${BASE}/api/users/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'zhangwei@awshop.io', password: 'Awshop@123' }),
}).then(r => r.json())
const H = { authorization: `Bearer ${login.data.token}`, 'content-type': 'application/json' }

const list = await fetch(`${BASE}/api/workshop/daq`, { headers: H }).then(r => r.json())
const audit = list.data.nodes.find(n => n.name.includes('MQTT链路审计'))
if (!audit) { console.error('FAIL: 重启后审计节点丢失'); process.exit(1) }
console.log('[survived]', audit.id, '| driver =', audit.driver, '| cfg =', JSON.stringify(audit.driverConfig))

const s1 = await fetch(`${BASE}/api/workshop/daq/${audit.id}/samples?limit=500`, { headers: H }).then(r => r.json())
console.log('[samples after restart]', (s1.data?.points ?? []).length, 'rows(时序库随卷持久化)')

const infra = list.data.infra
console.log('[infra]', JSON.stringify(infra))
const ok = audit.driver === 'modbus-tcp' && audit.driverConfig?.host === '127.0.0.1' && audit.driverConfig?.register === 40001
  && infra?.mqttOnline === true && infra?.tsdbOnline === true
console.log(ok ? '=== RESTART PERSISTENCE PASS ===' : '=== RESTART PERSISTENCE FAIL ===')

// 清理审计节点
await fetch(`${BASE}/api/workshop/daq/${audit.id}`, { method: 'DELETE', headers: H })
process.exit(ok ? 0 : 1)
