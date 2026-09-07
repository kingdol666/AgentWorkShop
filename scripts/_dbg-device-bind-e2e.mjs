/**
 * 节点 ↔ 设备 多对多绑定 E2E(隔离实例 :3021)
 *
 * 验证:
 *  1) legacy 单绑 POST bind {deviceId} → deviceIds=[d1](迁移语义)
 *  2) PUT bindings [d1,d2] → 两台设备;重复设定不产生重复对
 *  3) 数采回写:节点采样值同时出现在 d1/d2 的 telemetry(多对多回写)
 *  4) 摘除 d2 → 仅 d1 继续回写;d2 的 telemetry 冻结在摘除时刻
 *  5) 级联:删除 d1 → 节点 deviceIds 自动移除 d1(保留 d2)
 *  6) dcw 同模型:PUT bindings 双设备 + legacy 兼容
 *  7) 负向:绑定不存在的设备 404
 * 用法:NO_PROXY='127.0.0.1,localhost' node scripts/_dbg-device-bind-e2e.mjs [base]
 */
const BASE = process.argv[2] ?? 'http://127.0.0.1:3021'
const TAG = `db${Math.random().toString(36).slice(2, 6)}`
let pass = 0
let fail = 0
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name} ${extra}`) }
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
const api = async (method, path, { body, token } = {}) => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  })
  return { status: res.status, ...(await res.json().catch(() => ({}))) }
}

async function main() {
  console.log(`━━━ 节点↔设备多对多绑定 E2E @ ${BASE} (tag=${TAG}) ━━━`)
  const login = await api('POST', '/api/users/login', { body: { email: 'admin', password: 'admin123' } })
  const token = login.data?.token
  ok(Boolean(token), 'admin 登录')

  // ── 夹具:2 设备 + 1 数采节点(mock)+ 1 数控节点(mock)──
  const d1 = (await api('POST', '/api/workshop/device-twins', { body: { name: `dev1-${TAG}`, kind: 'device' }, token })).data?.twin
  const d2 = (await api('POST', '/api/workshop/device-twins', { body: { name: `dev2-${TAG}`, kind: 'device' }, token })).data?.twin
  ok(Boolean(d1?.id && d2?.id), '两台设备孪生创建')
  const line = (await api('POST', '/api/workshop/dcw/lines', { body: { name: `bindline-${TAG}` }, token })).data?.line
  const node = (await api('POST', '/api/workshop/daq', {
    body: { name: `daq-${TAG}`, templateRef: 'temp-tc', driver: 'mock', intervalMs: 1000, min: 0, max: 200, lineId: line.id },
    token,
  })).data?.node
  const dcw = (await api('POST', '/api/workshop/dcw', {
    body: { name: `dcw-${TAG}`, templateRef: 'temp-sp', driver: 'mock', driverConfig: { key: `${TAG}` }, min: 0, max: 200, unit: '℃' },
    token,
  })).data?.node
  ok(Boolean(node?.id && dcw?.id), '数采/数控节点创建')
  // 采样门控:开跑产线(产品/配方非必需?start 需要 recipeId —— 先建最小产品+配方)
  const product = (await api('POST', '/api/workshop/dcw/products', { body: { name: `bindprod-${TAG}`, lineId: line.id }, token })).data?.product
  const recipe = (await api('POST', '/api/workshop/dcw/recipes', { body: { name: `bindrec-${TAG}`, productId: product.id, params: [{ nodeId: dcw.id, value: 50 }] }, token })).data?.recipe
  const st = await api('POST', `/api/workshop/dcw/lines/${line.id}/start`, { body: { recipeId: recipe.id }, token })
  ok(st.status === 200, '产线开跑(采样门控放行)')

  const nodeById = async (id) => (await api('GET', '/api/workshop/daq', { token })).data?.nodes?.find(n => n.id === id)
  const dcwById = async (id) => (await api('GET', '/api/workshop/dcw', { token })).data?.nodes?.find(n => n.id === id)
  const twinById = async (id) => (await api('GET', '/api/workshop/device-twins', { token })).data?.twins?.find(t => t.id === id)
    ?? (await api('GET', '/api/workshop/device-twins', { token })).data?.find?.(t => t.id === id)

  // ── 1. legacy 单绑 ──
  let n = (await api('POST', `/api/workshop/daq/${node.id}/bind`, { body: { deviceId: d1.id }, token })).data?.node
  ok(Array.isArray(n?.deviceIds) && n.deviceIds.length === 1 && n.deviceIds[0] === d1.id && n.deviceBindingId === d1.id,
    `legacy 单绑 → deviceIds=[d1](实际 ${JSON.stringify(n?.deviceIds)})`)

  // ── 2. PUT bindings 双设备 + 唯一对 ──
  n = (await api('PUT', `/api/workshop/daq/${node.id}/bindings`, { body: { deviceIds: [d1.id, d2.id, d1.id] }, token })).data?.node
  ok(n?.deviceIds?.length === 2 && n.deviceIds.includes(d1.id) && n.deviceIds.includes(d2.id),
    `PUT bindings 去重 → [d1,d2](实际 ${JSON.stringify(n?.deviceIds)})`)
  n = (await api('PUT', `/api/workshop/daq/${node.id}/bindings`, { body: { deviceIds: [d1.id, d2.id] }, token })).data?.node
  ok(n?.deviceIds?.length === 2, '重复设定仍为 2 台(无重复对)')

  // ── 3. 采样回写双设备 ──
  await sleep(6000)
  const t1 = await twinById(d1.id)
  const t2 = await twinById(d2.id)
  const key1 = Object.keys(t1?.telemetry ?? {})
  ok(key1.length > 0 && Object.keys(t2?.telemetry ?? {}).length > 0,
    `采样回写双设备(d1 keys=${key1.join(',')} | d2 keys=${Object.keys(t2?.telemetry ?? {}).join(',')})`)

  // ── 4. 摘除 d2 → 仅 d1 继续回写 ──
  n = (await api('PUT', `/api/workshop/daq/${node.id}/bindings`, { body: { deviceIds: [d1.id] }, token })).data?.node
  ok(n?.deviceIds?.length === 1, '摘除 d2 → deviceIds=[d1]')
  const t2frozen = JSON.stringify((await twinById(d2.id))?.telemetry ?? {})
  await sleep(5000)
  const t2after = JSON.stringify((await twinById(d2.id))?.telemetry ?? {})
  ok(t2frozen === t2after, `d2 摘除后遥测冻结(不再回写)`)
  const t1b = JSON.stringify((await twinById(d1.id))?.telemetry ?? {})
  await sleep(5000)
  const t1c = JSON.stringify((await twinById(d1.id))?.telemetry ?? {})
  ok(t1b !== t1c, 'd1 绑定保留,持续回写')

  // ── 5. 级联:删除 d1 → 节点自动解绑 d1 ──
  await api('DELETE', `/api/workshop/device-twins/${d1.id}`, { token })
  n = await nodeById(node.id)
  ok(Array.isArray(n?.deviceIds) && !n.deviceIds.includes(d1.id), `删除 d1 → 节点级联解绑(deviceIds=${JSON.stringify(n?.deviceIds)})`)

  // ── 6. dcw 同模型 ──
  let dcn = (await api('PUT', `/api/workshop/dcw/${dcw.id}/bindings`, { body: { deviceIds: [d2.id] }, token })).data?.node
  ok(dcn?.deviceIds?.[0] === d2.id, '[dcw] PUT bindings 单设备')
  dcn = (await api('POST', `/api/workshop/dcw/${dcw.id}/bind`, { body: { deviceId: null }, token })).data?.node
  ok((dcn?.deviceIds ?? []).length === 0, '[dcw] legacy bind null → 清空')
  dcn = (await api('PUT', `/api/workshop/dcw/${dcw.id}/bindings`, { body: { deviceIds: [d2.id] }, token })).data?.node
  ok(dcn?.deviceIds?.length === 1, '[dcw] 恢复绑定')

  // ── 7. 负向:不存在的设备 ──
  const bad = await api('PUT', `/api/workshop/daq/${node.id}/bindings`, { body: { deviceIds: ['no-such-device'] }, token })
  ok(bad.status === 404, `负向:不存在设备 404(实际 ${bad.status})`)

  // ── 清理 ──
  await api('POST', `/api/workshop/dcw/lines/${line.id}/stop`, { body: {}, token }).catch(() => {})
  await api('DELETE', `/api/workshop/daq/${node.id}`, { token }).catch(() => {})
  await api('DELETE', `/api/workshop/dcw/${dcw.id}`, { token }).catch(() => {})
  await api('DELETE', `/api/workshop/dcw/recipes/${recipe.id}`, { token }).catch(() => {})
  await api('DELETE', `/api/workshop/dcw/products/${product.id}`, { token }).catch(() => {})
  await api('DELETE', `/api/workshop/dcw/lines/${line.id}`, { token }).catch(() => {})
  await api('DELETE', `/api/workshop/device-twins/${d2.id}`, { token }).catch(() => {})

  console.log(`\n━━━ DeviceBind E2E: ${pass} passed / ${fail} failed ━━━`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('E2E 异常:', err)
  process.exit(1)
})
