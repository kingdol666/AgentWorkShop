/** 一次性:真实 Modbus-TCP 驱动 e2e —— 测试连接 → 建节点 → 采集入库 Timescale */
const BASE = 'http://127.0.0.1:3000'
const login = await fetch(`${BASE}/api/users/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'zhangwei@awshop.io', password: 'Awshop@123' }),
}).then(r => r.json())
const H = { authorization: `Bearer ${login.data.token}`, 'content-type': 'application/json' }

// 1) 连接测试:真实协议打到模拟器(1502),读 40001 float32 压力
const t = await fetch(`${BASE}/api/workshop/daq/test-driver`, {
  method: 'POST', headers: H,
  body: JSON.stringify({
    driver: 'modbus-tcp',
    driverConfig: { host: '127.0.0.1', port: 1502, unitId: 1, register: 40001, registerType: 'holding', dataType: 'float32', scale: 1, byteOrder: 'big' },
  }),
}).then(r => r.json())
console.log('[test-driver]', JSON.stringify(t.data?.test))
if (!t.data?.test?.ok) process.exit(1)

// 2) 创建真实驱动节点(测试通过 → 直接采集)
const made = await fetch(`${BASE}/api/workshop/daq`, {
  method: 'POST', headers: H,
  body: JSON.stringify({
    templateRef: 'daq-pressure-tx',
    name: '产线 Modbus 真源 · 熔体压力',
    driver: 'modbus-tcp',
    driverConfig: { host: '127.0.0.1', port: 1502, unitId: 1, register: 40001, registerType: 'holding', dataType: 'float32', scale: 1, byteOrder: 'big' },
    intervalMs: 1000,
  }),
}).then(r => r.json())
const node = made.data?.node
console.log('[created]', node?.id, node?.driver, 'cfg =', JSON.stringify(node?.driverConfig))
if (!node) process.exit(1)

// 3) 等待采集窗口,验证节点读数与模板域一致(0.6~1.2 MPa 波动)
await new Promise(r => setTimeout(r, 5000))
const snap = await fetch(`${BASE}/api/workshop/daq`, { headers: H }).then(r => r.json())
const live = snap.data.nodes.find(x => x.id === node.id)
console.log('[live]', 'value =', live?.value, live?.unit, '| state =', live?.state)

// 4) 时序库样本(真实协议数据入库)
await new Promise(r => setTimeout(r, 2000))
const samples = await fetch(`${BASE}/api/workshop/daq/${node.id}/samples?limit=10`, { headers: H }).then(r => r.json())
const pts = samples.data?.points ?? []
console.log('[tsdb samples]', pts.length, pts.slice(0, 3).map(p => p.value))

const pass = (live?.value ?? 0) > 0.5 && (live?.value ?? 0) < 1.3 && pts.length >= 3
  && pts.every(p => p.value > 0.5 && p.value < 1.3)

// 5) 清理
await fetch(`${BASE}/api/workshop/daq/${node.id}`, { method: 'DELETE', headers: H })
console.log('[cleanup] removed')
console.log(pass ? '=== REAL DRIVER E2E PASS ===' : '=== REAL DRIVER E2E FAIL ===')
process.exit(pass ? 0 : 1)
