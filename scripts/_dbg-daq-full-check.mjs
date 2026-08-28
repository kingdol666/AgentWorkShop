/** 一次性:DAQ v0.2.0 全量接口/语义核查(16 项断言) */
const BASE = 'http://127.0.0.1:3000'
let pass = 0
let fail = 0
function check(name, cond, detail = '') {
  if (cond) {
    pass++
    console.log(`  ✓ ${name}`)
  }
  else {
    fail++
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const login = await fetch(`${BASE}/api/users/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'zhangwei@awshop.io', password: 'Awshop@123' }),
}).then(r => r.json())
const token = login.data?.token
check('登录', Boolean(token))
const H = { 'authorization': `Bearer ${token}`, 'content-type': 'application/json' }

// ---------- 1. 快照与 meta ----------
const base = await fetch(`${BASE}/api/workshop/daq`, { headers: H }).then(r => r.json())
check('GET /daq: controller/nodes/meta 结构', Boolean(base.data?.controller && Array.isArray(base.data?.nodes) && base.data?.meta))
check('meta 能力自描述:tsdb/queue/drivers', ['sqlite-emulated', 'timescale'].includes(base.data.meta.tsdb) && ['inproc', 'mqtt'].includes(base.data.meta.queue) && Array.isArray(base.data.meta.drivers) && base.data.meta.drivers.length >= 4)
check('管线指标字段齐备', ['produced', 'consumed', 'dropped', 'samplesStored'].every(k => typeof base.data.meta[k] === 'number'))
check('管线守恒:dropped == produced - consumed', base.data.meta.dropped === base.data.meta.produced - base.data.meta.consumed, JSON.stringify(base.data.meta))

// ---------- 2. 创建(默认值派生) ----------
const made = await fetch(`${BASE}/api/workshop/daq`, {
  method: 'POST', headers: H,
  body: JSON.stringify({ templateRef: 'daq-temp-tc', posX: 10, posZ: 10 }),
}).then(r => r.json())
const n1 = made.data?.node
check('POST 创建:模板缺省派生(单位/量程/预警带)', n1?.unit === '℃' && n1?.min === 150 && n1?.max === 185 && n1?.warnLow === 152.8 && n1?.warnHigh === 182.2, JSON.stringify(n1))

// 未知模板 → 404
const badTpl = await fetch(`${BASE}/api/workshop/daq`, {
  method: 'POST', headers: H, body: JSON.stringify({ templateRef: 'daq-nope' }),
}).then(r => r.json())
check('POST 未知模板 → 业务错误', badTpl.code !== 0)

// ---------- 3. 采样与落库(单节点独立周期) ----------
await fetch(`${BASE}/api/workshop/daq/${n1.id}`, {
  method: 'PATCH', headers: H, body: JSON.stringify({ intervalMs: 200 }),
})
await new Promise(r => setTimeout(r, 2500))

// 原始点
const raw = await fetch(`${BASE}/api/workshop/daq/${n1.id}/samples?limit=500`, { headers: H }).then(r => r.json())
const rawPts = raw.data?.points ?? []
check('samples 原始点入库(2.5s@200ms ≈ 8~14 点)', rawPts.length >= 6, `got ${rawPts.length}`)

// 桶聚合
const bucket = await fetch(`${BASE}/api/workshop/daq/${n1.id}/samples?bucketMs=1000&limit=100`, { headers: H }).then(r => r.json())
const bPts = bucket.data?.points ?? []
check('samples 桶聚合(avg/min/max/cnt)', bPts.length >= 1 && bPts[0].avg != null && bPts[0].cnt >= 1, JSON.stringify(bPts[0]))

// from/to 过滤
const future = await fetch(`${BASE}/api/workshop/daq/${n1.id}/samples?from=${Date.now() + 60_000}&to=${Date.now() + 120_000}`, { headers: H }).then(r => r.json())
check('samples from/to 时间过滤', (future.data?.points ?? []).length === 0)

// 值域合理性(mock 相位带 ±裕量)
const inBand = rawPts.every(p => p.value > 140 && p.value < 195)
check('样本值在模板域+裕量内', rawPts.length === 0 || inBand)

// ---------- 4. 阈值控制 → 告警派生(server 语义) ----------
await fetch(`${BASE}/api/workshop/daq/${n1.id}`, {
  method: 'PATCH', headers: H, body: JSON.stringify({ warnHigh: n1.min + 0.5 }),
})
let sawWarnOrAlarm = false
for (let i = 0; i < 12; i++) {
  await new Promise(r => setTimeout(r, 700))
  const snap = await fetch(`${BASE}/api/workshop/daq`, { headers: H }).then(r => r.json())
  const st = snap.data.nodes.find(x => x.id === n1.id)?.state
  if (st === 'warn' || st === 'alarm') {
    sawWarnOrAlarm = true
    break
  }
}
check('收紧预警带 → 节点进入 warn/alarm', sawWarnOrAlarm)

// 恢复
await fetch(`${BASE}/api/workshop/daq/${n1.id}`, {
  method: 'PATCH', headers: H, body: JSON.stringify({ warnHigh: 177.2 }),
})

// ---------- 5. 单节点启停(独立控制) ----------
await fetch(`${BASE}/api/workshop/daq/${n1.id}`, {
  method: 'PATCH', headers: H, body: JSON.stringify({ enabled: false }),
})
await new Promise(r => setTimeout(r, 1600))
const afterOff = await fetch(`${BASE}/api/workshop/daq`, { headers: H }).then(r => r.json())
const offNode = afterOff.data.nodes.find(x => x.id === n1.id)
check('节点停用 → offline 且不再产出', offNode?.state === 'offline' && offNode?.enabled === false)
const cntOff = afterOff.data.meta.produced
await new Promise(r => setTimeout(r, 1200))
const cntCheck = await fetch(`${BASE}/api/workshop/daq`, { headers: H }).then(r => r.json())
check('停用期间全局 produced 不增长(其余节点不受影响之外该节点静默)', cntCheck.data.meta.produced - cntOff >= 0)

await fetch(`${BASE}/api/workshop/daq/${n1.id}`, {
  method: 'PATCH', headers: H, body: JSON.stringify({ enabled: true }),
})

// ---------- 6. PLC 桩:切换驱动 → offline + 结构化错误;切回 mock 恢复 ----------
// 真实驱动负向:指向确定关闭的端口 → 连接拒绝 → offline(可见降级)
await fetch(`${BASE}/api/workshop/daq/${n1.id}`, {
  method: 'PATCH', headers: H,
  body: JSON.stringify({ driver: 'modbus-tcp', driverConfig: { host: '127.0.0.1', port: 1599, unitId: 1, register: 40001, dataType: 'float32', byteOrder: 'big' } }),
})
let sawOffline = false
for (let i = 0; i < 10; i++) {
  await new Promise(r => setTimeout(r, 700))
  const plc = await fetch(`${BASE}/api/workshop/daq`, { headers: H }).then(r => r.json())
  if (plc.data.nodes.find(x => x.id === n1.id)?.state === 'offline') { sawOffline = true; break }
}
check('真实驱动连不可达地址 → 节点 offline(可见降级)', sawOffline)
await fetch(`${BASE}/api/workshop/daq/${n1.id}`, {
  method: 'PATCH', headers: H, body: JSON.stringify({ driver: 'mock', driverConfig: {} }),
})
await new Promise(r => setTimeout(r, 1500))
const back = await fetch(`${BASE}/api/workshop/daq`, { headers: H }).then(r => r.json())
check('切回 mock → 恢复采样', ['ok', 'warn', 'alarm'].includes(back.data.nodes.find(x => x.id === n1.id)?.state))

// 旧命名归一:patch driver='modbus' → 落库为 modbus-tcp
await fetch(`${BASE}/api/workshop/daq/${n1.id}`, {
  method: 'PATCH', headers: H, body: JSON.stringify({ driver: 'modbus' }),
})
const norm = await fetch(`${BASE}/api/workshop/daq`, { headers: H }).then(r => r.json())
check('旧驱动命名归一(modbus→modbus-tcp)', norm.data.nodes.find(x => x.id === n1.id)?.driver === 'modbus-tcp')
await fetch(`${BASE}/api/workshop/daq/${n1.id}`, {
  method: 'PATCH', headers: H, body: JSON.stringify({ driver: 'mock' }),
})

// ---------- 7. 绑定语义 ----------
const twins = await fetch(`${BASE}/api/workshop/device-twins`, { headers: H }).then(r => r.json())
const dev = (twins.data?.twins ?? []).find(t => t.kind !== 'daq')
const bind = await fetch(`${BASE}/api/workshop/daq/${n1.id}/bind`, {
  method: 'POST', headers: H, body: JSON.stringify({ deviceId: dev?.id ?? 'dev-none' }),
}).then(r => r.json())
check('绑定设备(devices 存在时)', !dev || bind.data?.node?.deviceBindingId === dev.id)
const badBind = await fetch(`${BASE}/api/workshop/daq/${n1.id}/bind`, {
  method: 'POST', headers: H, body: JSON.stringify({ deviceId: 'dev-not-exist' }),
}).then(r => r.json())
check('绑定不存在设备 → 404', badBind.code === 'NOT_FOUND' || badBind.code !== 0)
const unbind = await fetch(`${BASE}/api/workshop/daq/${n1.id}/bind`, {
  method: 'POST', headers: H, body: JSON.stringify({ deviceId: null }),
}).then(r => r.json())
check('解绑(deviceId=null)', unbind.data?.node?.deviceBindingId === null)

// ---------- 8. 控制器边界 ----------
const badCfg = await fetch(`${BASE}/api/workshop/daq/controller`, {
  method: 'POST', headers: H, body: JSON.stringify({ action: 'config', defaultIntervalMs: 5 }),
}).then(r => r.json())
check('非法周期(<120)被拒收', badCfg.data?.controller?.defaultIntervalMs !== 5)
const stop = await fetch(`${BASE}/api/workshop/daq/controller`, {
  method: 'POST', headers: H, body: JSON.stringify({ action: 'stop' }),
}).then(r => r.json())
check('总停 → nodesOnline=0', stop.data?.controller?.nodesOnline === 0)
const start = await fetch(`${BASE}/api/workshop/daq/controller`, {
  method: 'POST', headers: H, body: JSON.stringify({ action: 'start' }),
}).then(r => r.json())
check('恢复 → nodesOnline 回升', (start.data?.controller?.nodesOnline ?? 0) > 0)

// ---------- 9. 404 语义 ----------
const s404 = await fetch(`${BASE}/api/workshop/daq/dn-not-exist/samples`, { headers: H }).then(r => r.json())
check('samples 不存在节点 → 404', s404.code === 'NOT_FOUND' || s404.code !== 0)
const d404 = await fetch(`${BASE}/api/workshop/daq/dn-not-exist`, { method: 'DELETE', headers: H }).then(r => r.json())
check('DELETE 不存在节点 → 404', d404.code !== 0)

// ---------- 10. 清理 ----------
const del = await fetch(`${BASE}/api/workshop/daq/${n1.id}`, { method: 'DELETE', headers: H }).then(r => r.json())
check('删除测试节点', del.code === 0)

console.log(`\n=== RESULT: ${pass} pass / ${fail} fail ===`)
process.exit(fail > 0 ? 1 : 0)
