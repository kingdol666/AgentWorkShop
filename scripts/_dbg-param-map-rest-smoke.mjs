/**
 * 工艺参数映射 REST 冒烟(真实 dev server):
 * ①params 列表(登录态 + 产线可见性过滤) ②建节点自动生成参数面(REST 视图无寄存器细节)
 * ③param 写/读路由 ④param 基准限界 → 越界 400 ⑤产品限界落库 → 运行期产品层拦截
 * ⑥清理(产线 purge)。mock 驱动,不依赖外部模拟器。
 * 运行: node scripts/_dbg-param-map-rest-smoke.mjs(ROOT/E2E_USER/E2E_PASS 可覆盖)
 */
const ROOT = process.env.E2E_ROOT ?? 'http://127.0.0.1:3001'
let failed = 0
const check = (name, ok, detail = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); if (!ok) failed++ }

/** 认证:AW_E2E_TOKEN 直用(隔离实例首注册 token);否则 E2E_USER/E2E_PASS 登录(docs/full-test-plan.md 测试账号) */
let __token = process.env.AW_E2E_TOKEN
if (!__token) {
  const login = await fetch(`${ROOT}/api/users/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: process.env.E2E_USER ?? 'admin@awshop.local', password: process.env.E2E_PASS ?? 'admin123' }) }).then(r => r.json())
  __token = login.data?.token
  check('登录', !!__token, login.message ?? '')
}
else {
  check('使用 AW_E2E_TOKEN', true)
}
const H = { authorization: `Bearer ${__token}`, 'content-type': 'application/json' }
const j = (u, m = 'GET', b) => fetch(ROOT + u, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined }).then(r => r.json())

try {
  // ① 列表路由
  const list = await j('/api/workshop/dcw/params?limits=1')
  check('GET /dcw/params 路由可用(含 limits 剖面)', Array.isArray(list.data?.params) && list.data.limits != null, `params=${list.data?.params?.length}`)

  // ② 建线 + 建节点(mock)→ 自动参数面
  const line = (await j('/api/workshop/dcw/lines', 'POST', { name: `PP冒烟线-${Date.now().toString(36)}` })).data?.line
  check('创建产线', !!line?.id)
  const node = (await j('/api/workshop/dcw', 'POST', { templateRef: 'dcw-pressure-sp', name: 'PP冒烟·熔体压力', driver: 'mock', driverConfig: { key: `pp-rest-${Date.now()}` }, readIntervalMs: 0, writeLockSeconds: 0, lineId: line.id })).data?.node
  check('创建执行节点(mock)', !!node?.id)
  const after = await j('/api/workshop/dcw/params')
  const pv = after.data.params.find(p => p.nodeId === node.id)
  check('节点创建自动生成参数面(pressure-sp)', pv?.key === 'pressure-sp', pv?.id)
  check('REST 参数视图不含寄存器/数据类型细节', !JSON.stringify(pv).includes('register') && !JSON.stringify(pv).includes('dataType'))

  // ③④ 参数写/读 + 基准限界
  const w1 = (await j(`/api/workshop/dcw/params/${pv.id}/write`, 'POST', { value: 0.9 })).data?.outcome
  check('param write 0.9MPa 成功(mock 回读一致)', w1?.ok === true, w1?.message)
  const rd = (await j(`/api/workshop/dcw/params/${pv.id}/read`, 'POST', {})).data?.read
  check('param read 返回物理值', rd?.ok === true && Math.abs((rd.value ?? 0) - 0.9) < 0.01, `value=${rd?.value}`)
  await j(`/api/workshop/dcw/params/${pv.id}`, 'PATCH', { min: 0.7, max: 1.1 })
  const w2 = await j(`/api/workshop/dcw/params/${pv.id}/write`, 'POST', { value: 1.15 })
  check('越基准限界 1.15 → 400 点名参数层', w2.code === 'VALIDATION_ERROR' && w2.message?.includes('基准限界'), w2.message?.slice(0, 80))

  // ⑤ 产品限界 → 运行期产品层拦截
  const product = (await j('/api/workshop/dcw/products', 'POST', { name: 'PP冒烟产品', lineId: line.id, paramLimits: { 'pressure-sp': { min: 0.8, max: 1.0 } } })).data?.product
  check('产品限界落库(0.8~1.0)', product?.paramLimits?.['pressure-sp']?.max === 1.0)
  const recipe = (await j('/api/workshop/dcw/recipes', 'POST', { productId: product.id, name: 'PP冒烟配方', params: [{ nodeId: node.id, value: 0.9, min: 0.75, max: 1.05 }] })).data?.recipe
  const start = await j(`/api/workshop/dcw/lines/${line.id}/start`, 'POST', { recipeId: recipe.id })
  check('产线开跑', !!start.data?.run?.id, start.message)
  const w3 = await j(`/api/workshop/dcw/params/${pv.id}/write`, 'POST', { value: 1.05 })
  check('1.05 超产品上限 1.0 → 400 点名产品层', w3.code === 'VALIDATION_ERROR' && w3.message?.includes('产品'), w3.message?.slice(0, 80))
  const w4 = (await j(`/api/workshop/dcw/params/${pv.id}/write`, 'POST', { value: 0.95 })).data?.outcome
  check('0.95 交集内 → 通过', w4?.ok === true)
  await j(`/api/workshop/dcw/lines/${line.id}/stop`, 'POST', {})

  // ⑥ 清理
  const del = await j(`/api/workshop/dcw/lines/${line.id}?purge=1`, 'DELETE')
  check('产线 purge 清理', del.code === 0 || del.removed != null || del.data != null, JSON.stringify(del).slice(0, 80))
  const afterDel = await j('/api/workshop/dcw/params')
  check('purge 后参数面同步清理', !afterDel.data.params.some(p => p.id === pv.id))
}
catch (err) {
  failed += 1
  console.error('冒烟异常中断:', err)
}

console.log(`\n${failed === 0 ? '✅ REST 冒烟全部通过' : `❌ ${failed} 项失败`}`)
process.exit(failed === 0 ? 0 : 1)
