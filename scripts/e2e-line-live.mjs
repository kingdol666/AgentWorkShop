/**
 * 产线管理 + 数控(DCW) + 数采(DAQ) 真实端到端(PLC 工艺模拟器):
 *   node scripts/e2e-line-live.mjs [--base http://127.0.0.1:3000]
 *
 * 链路:建产线 → 挂数采/数控节点 → 产品+配方 → 开跑 → 数采出数 →
 *       数控下发(write,带回读校验)→ 越界拒绝 → 产线查询打标 → 清理。
 */
const BASE = (() => {
  const i = process.argv.indexOf('--base')
  return i > 0 ? process.argv[i + 1] : 'http://127.0.0.1:3000'
})()
const TAG = Date.now().toString(36)

let failures = 0
let passed = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (ok) passed += 1
  else failures += 1
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function waitUntil(name, cond, timeoutMs = 30_000, intervalMs = 1000) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    try {
      last = await cond()
      if (last) return last
    }
    catch (e) { last = e }
    await sleep(intervalMs)
  }
  throw new Error(`waitUntil timeout: ${name} (last=${String(last).slice(0, 160)})`)
}

const api = async (method, path, { body, token } = {}) => {
  const headers = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined })
  return { status: res.status, ...(await res.json().catch(() => ({}))) }
}

async function main() {
  console.log(`\n━━━ 产线/数控/数采 真实端到端 @ ${BASE} ━━━`)

  const reg = await api('POST', '/api/users/register', {
    body: { email: `line-e2e-${TAG}@test.local`, password: 'Passw0rd!123', name: `line-e2e-${TAG}` },
  })
  const token = reg.data?.token
  if (!token) throw new Error(`注册失败: ${JSON.stringify(reg).slice(0, 160)}`)

  // ── 1. 产线 + 节点 + 产品 + 配方 ──
  const line = (await api('POST', '/api/workshop/dcw/lines', { body: { name: `线-e2e-${TAG}` }, token })).data?.line
  check('1.1 建产线', Boolean(line?.id), `id=${line?.id?.slice(0, 8)}`)

  const dq = (await api('POST', '/api/workshop/daq', {
    body: { templateRef: 'daq-temp-tc', name: `温度采集-${TAG}`, lineId: line.id, intervalMs: 500 },
    token,
  })).data?.node
  check('1.2 挂数采节点(daq-temp-tc)', Boolean(dq?.id), `id=${dq?.id?.slice(0, 8)}`)

  const dw = (await api('POST', '/api/workshop/dcw', {
    body: { templateRef: 'dcw-temp-sp', name: `温度设定-${TAG}`, lineId: line.id },
    token,
  })).data?.node
  check('1.3 挂数控节点(dcw-temp-sp)', Boolean(dw?.id), `id=${dw?.id?.slice(0, 8)}`)

  const prod = (await api('POST', '/api/workshop/dcw/products', {
    body: { name: `产品-${TAG}`, lineId: line.id },
    token,
  })).data?.product
  check('1.4 建产品', Boolean(prod?.id))

  const recipe = (await api('POST', '/api/workshop/dcw/recipes', {
    body: {
      productId: prod.id,
      name: `配方-${TAG}`,
      params: [{ templateRef: 'dcw-temp-sp', nodeId: dw.id, value: 180, min: 176, max: 188 }],
      daqWindows: [{ nodeId: dq.id, min: 100, max: 260 }],
    },
    token,
  })).data?.recipe
  check('1.5 建配方(SP=180 窗口 176-188 + 数采窗口)', Boolean(recipe?.id))

  // ── 2. 开跑 → 数采出数 ──
  const start = await api('POST', `/api/workshop/dcw/lines/${line.id}/start`, { body: { recipeId: recipe.id }, token })
  check('2.1 产线开跑(配方激活)', start.code === 0 && (start.data?.line?.active ?? start.data?.run?.active ?? true), start.message ?? '')

  console.log('  … 等待 PLC 工艺模拟器产出样本(10s)…')
  await sleep(10_000)
  const samples = await api('GET', `/api/workshop/daq/${dq.id}/samples`, { token, query: undefined })
  const pts = samples.data?.points ?? samples.data ?? []
  check('2.2 数采时序出数(模拟器)', Array.isArray(pts) && pts.length >= 3, `points=${Array.isArray(pts) ? pts.length : 'n/a'}`)
  const latest = Array.isArray(pts) && pts.length > 0 ? pts.at(-1) : null
  const latestVal = latest?.value ?? latest?.v
  check('2.3 样本含工程量数值', Number.isFinite(Number(latestVal)), `latest=${JSON.stringify(latest)?.slice(0, 80)}`)

  // ── 3. 数控下发(带回读校验) + 越界拒绝 ──
  const write = await api('POST', `/api/workshop/dcw/${dw.id}/write`, { body: { value: 182 }, token })
  check('3.1 手动下发 SP=182(写+回读校验 ACK)', write.code === 0 && write.data?.outcome?.ok !== false, JSON.stringify(write.data?.outcome ?? write.message)?.slice(0, 100))

  const inRange = await waitUntil('3.2 设定值收敛到 182±2(工艺响应)', async () => {
    const list = await api('GET', '/api/workshop/dcw', { token })
    const nodes = Array.isArray(list.data) ? list.data : (list.data?.nodes ?? [])
    const node = nodes.find(n => n.id === dw.id)
    const v = Number(node?.readValue ?? node?.value ?? NaN)
    return Number.isFinite(v) && Math.abs(v - 182) <= 2 ? v : null
  }, 30_000, 1500).catch(() => null)
  check('3.2 设定值收敛(182±2)', inRange !== null, `value=${inRange}`)

  const bad = await api('POST', `/api/workshop/dcw/${dw.id}/write`, { body: { value: 999 }, token })
  check('3.3 越界下发被拒(400 量程校验)', bad.status === 400 || bad.code === 400 || bad.code === 'VALIDATION_ERROR', `status=${bad.status} code=${bad.code}`)

  // ── 4. 产线查询(工艺打标)──
  // lineQuery 的 productId/recipeId 是过滤器:带上产品/配方过滤仍能查到样本,
  // 即证明数采样本确实按「产品+配方」打标(开跑激活窗口后逐样本打标)
  const lineData = await waitUntil('4.1 产线查询返回打标样本', async () => {
    const q = await api('GET', `/api/workshop/dcw/line/query?lineId=${line.id}&nodeId=${dq.id}&from=${Date.now() - 600_000}`, { token })
    const d = q.data ?? {}
    const pts = (d.channels ?? []).reduce((acc, c) => acc + (c.points?.length ?? 0), 0)
    return pts >= 1 ? d : null
  }, 30_000, 2000).catch(() => null)
  check('4.1 产线查询返回工艺样本(channels.points)', Boolean(lineData), lineData ? `channels=${lineData.channels?.length}` : 'empty')

  const tagged = await api('GET', `/api/workshop/dcw/line/query?lineId=${line.id}&nodeId=${dq.id}&from=${Date.now() - 600_000}&productId=${prod.id}&recipeId=${recipe.id}`, { token })
  const taggedPts = ((tagged.data?.channels ?? [])[0]?.points ?? []).length
  check('4.2 按产品+配方过滤仍命中(样本打标验证)', taggedPts >= 1, `taggedPoints=${taggedPts}`)

  // ── 清理 ──
  await api('POST', `/api/workshop/dcw/lines/${line.id}/stop`, { token }).catch(() => {})
  for (const [p, id] of [['/api/workshop/daq', dq.id], ['/api/workshop/dcw', dw.id]]) {
    await api('DELETE', `${p}/${id}`, { token }).catch(() => {})
  }
  await api('DELETE', `/api/workshop/dcw/lines/${line.id}`, { token }).catch(() => {})

  console.log(`\n━━━ 结果: ${passed} passed / ${failures} failed ━━━`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('FATAL', err.message)
  process.exit(1)
})
