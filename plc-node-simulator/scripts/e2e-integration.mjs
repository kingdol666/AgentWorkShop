/**
 * 跨项目集成 E2E —— PLC 节点模拟器 ↔ AgentWorkShop 全链路。
 *
 * 前置:
 *   1. 模拟器已运行且已应用 film-line 预设: NO_PROXY='*' node scripts/e2e-integration.mjs
 *   2. 主项目已运行(env AW_BASE,默认 http://127.0.0.1:3002;admin 账号 admin@awshop.local)
 *
 * 链路:
 *   0. 模拟器五协议端点在跑 + PV 预降(手动覆写 SP=25,等一阶回落)
 *   1. 主项目注册/授权/建产线
 *   2. 从模拟器「对接导出 API」动态取 driverConfig → 主项目 test-driver ×5 协议
 *   3. 创建 DAQ 节点 ×5 + DCW 节点 ×3 → 产品/配方/开跑
 *   4. 采样落库断言(Timescale) ×5
 *   5. DCW 写 SP=182 → 模拟器回读一致 + PV 一阶收敛
 *   6. DCW MQTT 下行 → 模拟器命令主题回灌(tempSP 信号值变化)
 *   7. 断链演练:模拟器停设备 → 主项目 test-driver 拒绝 → 恢复 → 重连成功
 */
const SIM = process.env.SIM_BASE ?? 'http://127.0.0.1:4010'
const BASE = process.env.AW_BASE ?? 'http://127.0.0.1:3002'
const ADMIN_PASS = process.env.AW_ADMIN_PASS ?? 'admin123'
const TAG = Date.now().toString(36)

let failures = 0
let passed = 0
const check = (name, msg, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name} ${msg}${detail ? ` — ${detail}` : ''}`)
  ok ? passed++ : failures++
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

const api = async (base, method, path, { body, token } = {}) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  const j = await res.json().catch(() => ({}))
  return { status: res.status, ...j }
}

/* ── 0. 模拟器前置 ── */
console.log(`\n━━━ 集成 E2E @ 模拟器=${SIM} 主项目=${BASE} (tag=${TAG}) ━━━`)
const simNodes = (await api(SIM, 'GET', '/api/nodes')).data
const byProto = (p) => simNodes.find(n => n.protocol === p && n.enabled)
const mbtcp = byProto('modbus-tcp')
const mbrtu = byProto('modbus-rtu')
const opcua = byProto('opcua')
const mqtt = byProto('mqtt')
const httpDev = byProto('http')
check('0.1', '模拟器五协议设备在跑', Boolean(mbtcp && mbrtu && opcua && mqtt && httpDev),
  [mbtcp, mbrtu, opcua, mqtt, httpDev].map(n => n?.protocol ?? 'MISSING').join(','))

// PV 预降:直接覆写 PV 回路的过程目标(first-order.sp=25,确定性基线),PV 一阶回落
const spSig = mbtcp.signals.find(s => s.id === 'temp-sp')
const pvSig = mbtcp.signals.find(s => s.id === 'temp-pv')
await api(SIM, 'POST', `/api/nodes/${mbtcp.id}/signals/${pvSig.id}/strategy`, {
  body: { strategy: { kind: 'first-order', initial: pvSig.value, tauMs: 8000, sp: 25, noise: 0.25 } },
})
await sleep(20_000) // τ=8s ×2.5,PV 显著回落
const pvNow = ((await api(SIM, 'GET', `/api/nodes`)).data.find(n => n.id === mbtcp.id).signals.find(s => s.id === 'temp-pv')).value
check('0.2', 'PV 预降(<60)', pvNow < 60, `pv=${pvNow}`)

/* ── 1. 主项目 admin 登录 + 建产线 ── */
// 说明:当前主项目已把产线/节点创建收紧为 admin/editor 专属(R3 控制面),故以 admin 身份执行管理面操作。
const token = (await api(BASE, 'POST', '/api/users/login', { body: { email: 'admin@awshop.local', password: ADMIN_PASS } })).data?.token
check('1.1', '主项目 admin 登录', Boolean(token), ADMIN_PASS === 'admin123' ? '' : '')
const line = (await api(BASE, 'POST', '/api/workshop/dcw/lines', { body: { name: `模拟器产线-${TAG}` }, token })).data?.line
check('1.2', '建产线', Boolean(line?.id), line?.id ?? JSON.stringify(line ?? {}).slice(0, 80))

/* ── 2. 从模拟器导出 API 取 driverConfig → test-driver ×5 ── */
const exports = {}
for (const n of [mbtcp, mbrtu, opcua, mqtt, httpDev]) {
  exports[n.protocol] = (await api(SIM, 'GET', `/api/nodes/${n.id}/export`)).data
}
const pick = (proto, signalName) => exports[proto].items.find(i => i.signal === signalName)

const daqDefs = [
  { key: 'mbtcp', driver: 'modbus-tcp', item: pick('modbus-tcp', '温度PV'), templateRef: 'daq-temp-tc', expect: [0, 260] },
  { key: 'mbrtu', driver: 'modbus-rtu', item: pick('modbus-rtu', '炉温'), templateRef: 'daq-temp-tc', expect: [0, 100] },
  { key: 'opcua', driver: 'opcua', item: pick('opcua', 'Temp'), templateRef: 'daq-temp-tc', expect: [0, 260] },
  { key: 'mqtt', driver: 'mqtt', item: pick('mqtt', 'temp'), templateRef: 'daq-temp-tc', expect: [0, 100] },
  { key: 'http', driver: 'http', item: pick('http', '流量'), templateRef: 'daq-temp-tc', expect: [0, 100] },
]
const daqNodes = {}
for (const d of daqDefs) {
  if (!d.item) { check(`2.${d.key}`, `${d.driver} 导出项存在`, false, '导出 items 缺信号'); continue }
  const t = await api(BASE, 'POST', '/api/workshop/daq/test-driver', { body: { driver: d.driver, driverConfig: d.item.driverConfig }, token })
  check(`2.${d.key}`, `${d.driver} 连接测试(模拟器导出配置)`, t.data?.test?.ok === true, JSON.stringify(t.data?.test ?? t.message ?? {}).slice(0, 110))
  const created = await api(BASE, 'POST', '/api/workshop/daq', {
    body: { templateRef: d.templateRef, name: `${d.key}-${TAG}`, driver: d.driver, driverConfig: d.item.driverConfig, lineId: line.id, intervalMs: 800, publishIntervalMs: 0 }, token,
  })
  daqNodes[d.key] = created.data?.node
}

/* ── 3. DCW 节点 ×3 + 产品/配方/开跑 ── */
const dcwDefs = [
  { key: 'plcsp', driver: 'modbus-tcp', item: pick('modbus-tcp', '温度SP') },
  { key: 'ocusp', driver: 'opcua', item: pick('opcua', 'SetTemp') },
  { key: 'mqsp', driver: 'mqtt', item: null, cfg: { host: '127.0.0.1', port: 18830, topic: 'aw/sim/setpoint', jsonKey: 'setpoint', qos: 1 } },
]
const dcwNodes = {}
for (const d of dcwDefs) {
  const cfg = d.cfg ?? d.item?.driverConfig
  const t = await api(BASE, 'POST', '/api/workshop/dcw/test-driver', { body: { driver: d.driver, driverConfig: cfg }, token })
  check(`3.${d.key}-test`, `DCW ${d.driver} 连接测试`, t.data?.test?.ok === true, JSON.stringify(t.data?.test ?? t.message ?? {}).slice(0, 110))
  const created = await api(BASE, 'POST', '/api/workshop/dcw', {
    body: { templateRef: 'dcw-temp-sp', name: `${d.key}-${TAG}`, driver: d.driver, driverConfig: cfg, lineId: line.id }, token,
  })
  dcwNodes[d.key] = created.data?.node
}

const prod = (await api(BASE, 'POST', '/api/workshop/dcw/products', { body: { name: `模拟器产品-${TAG}`, lineId: line.id }, token })).data?.product
const recipe = (await api(BASE, 'POST', '/api/workshop/dcw/recipes', {
  body: {
    productId: prod.id, name: `模拟器配方-${TAG}`,
    params: [{ templateRef: 'dcw-temp-sp', nodeId: dcwNodes.plcsp.id, value: 180, min: 176, max: 188 }],
    daqWindows: [{ nodeId: daqNodes.mbtcp.id, min: 0, max: 260 }],
  }, token,
})).data?.recipe
const start = await api(BASE, 'POST', `/api/workshop/dcw/lines/${line.id}/start`, { body: { recipeId: recipe.id }, token })
check('3.start', '产线开跑(数采门控激活)', start.code === 0, start.message ?? '')

/* ── 4. 采样落库 ×5 ── */
await sleep(9000)
for (const d of daqDefs) {
  const node = daqNodes[d.key]
  if (!node?.id) continue
  const s = await api(BASE, 'GET', `/api/workshop/daq/${node.id}/samples?bucketMs=1000`, { token })
  const points = s.data?.points ?? s.data ?? []
  const n = Array.isArray(points) ? points.length : 0
  const lastVal = n > 0 ? Number(Object.values(points[n - 1] ?? {})[1] ?? NaN) : NaN
  const inRange = Number.isFinite(lastVal) && lastVal >= d.expect[0] && lastVal <= d.expect[1]
  check(`4.${d.key}`, `${d.driver} 持续采样落库`, n >= 4 && inRange, `points=${n} last=${lastVal}`)
}

/* ── 5. DCW 写 SP=182 → 模拟器回读一致 + PV 收敛 ── */
const wPlc = await api(BASE, 'POST', `/api/workshop/dcw/${dcwNodes.plcsp.id}/write`, { body: { value: 182 }, token })
check('5.1', 'DCW 写 SP=182(配方窗内)', wPlc.code === 0 && wPlc.data?.outcome?.ok === true, JSON.stringify(wPlc.data ?? wPlc.message ?? {}).slice(0, 120))
await sleep(1000)
const spAfter = ((await api(SIM, 'GET', '/api/nodes')).data.find(n => n.id === mbtcp.id).signals.find(s => s.id === 'temp-sp')).value
check('5.2', '模拟器侧 SP=写入值(写回读一致)', Math.abs(spAfter - 182) < 0.01, `sim SP=${spAfter}`)
const pvBefore = ((await api(SIM, 'GET', '/api/nodes')).data.find(n => n.id === mbtcp.id).signals.find(s => s.id === 'temp-pv')).value
await sleep(12_000) // τ=8s,PV 应显著爬升
const pvAfter = ((await api(SIM, 'GET', '/api/nodes')).data.find(n => n.id === mbtcp.id).signals.find(s => s.id === 'temp-pv')).value
check('5.3', 'PV 一阶收敛趋势(25→182)', pvAfter > pvBefore + 20, `pv ${pvBefore.toFixed(1)} → ${pvAfter.toFixed(1)}`)

/* ── 6. DCW MQTT 下行 → 模拟器命令回灌 ── */
// 主项目 DCW 写有工艺安全量程门控(dcw-temp-sp 全局量程 150~200),写量程内值
const mqttSpBefore = ((await api(SIM, 'GET', '/api/nodes')).data.find(n => n.id === mqtt.id).signals.find(s => s.id === 'mqtt-sp')).value
const target = mqttSpBefore >= 160 ? 155 : 165
const wMq = await api(BASE, 'POST', `/api/workshop/dcw/${dcwNodes.mqsp.id}/write`, { body: { value: target }, token })
check('6.1', 'DCW MQTT 下发执行', wMq.code === 0 && wMq.data?.outcome?.ok === true, JSON.stringify(wMq.data ?? wMq.message ?? {}).slice(0, 120))
await sleep(800)
const mqttSpAfter = ((await api(SIM, 'GET', '/api/nodes')).data.find(n => n.id === mqtt.id).signals.find(s => s.id === 'mqtt-sp')).value
check('6.2', '模拟器命令主题回灌(tempSP)', Math.abs(mqttSpAfter - target) < 0.01, `write=${target} → sim=${mqttSpAfter}`)

/* ── 7. 断链演练(停设备 → 拒 → 恢复 → 重连) ── */
await api(SIM, 'POST', `/api/nodes/${mbtcp.id}/stop`)
await sleep(500)
const tDown = await api(BASE, 'POST', '/api/workshop/daq/test-driver', { body: { driver: 'modbus-tcp', driverConfig: pick('modbus-tcp', '温度PV').driverConfig }, token }).catch(e => ({ status: 0, data: { test: { ok: false, message: `fetch failed: ${e.message}` } } }))
check('7.1', '停设备 → 主项目连接测试失败', tDown.data?.test?.ok === false, JSON.stringify(tDown.data?.test ?? {}).slice(0, 100))
await api(SIM, 'POST', `/api/nodes/${mbtcp.id}/start`)
await sleep(2000)
const tUp = await api(BASE, 'POST', '/api/workshop/daq/test-driver', { body: { driver: 'modbus-tcp', driverConfig: pick('modbus-tcp', '温度PV').driverConfig }, token }).catch(e => ({ status: 0, data: { test: { ok: false, message: `fetch failed: ${e.message}` } } }))
check('7.2', '恢复设备 → 重连成功', tUp.data?.test?.ok === true, JSON.stringify(tUp.data?.test ?? {}).slice(0, 100))

console.log(`\n━━━ 集成 E2E 结果: ${passed} passed / ${failures} failed ━━━`)
process.exit(failures > 0 ? 1 : 0)
