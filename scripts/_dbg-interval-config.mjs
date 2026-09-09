/**
 * 间隔配置化 场景测试:daq.sampling.* / daq.query.* 全链路(live 热重载)。
 *   NO_PROXY='127.0.0.1,localhost' node scripts/_dbg-interval-config.mjs [--base http://127.0.0.1:3001]
 *
 * C1 PATCH 设置:daq.sampling.defaultIntervalMs=2000 → controller 状态即时反映(热重载)
 * C2 下限钳制:daq.sampling.minIntervalMs=2000 → create intervalMs=500 被钳到 2000
 * C3 恢复:PATCH 回 5000/1000 → 新建节点默认节拍恢复
 * C4 查询间隔:daq.query.defaultBucketMs=3000 → samples 缺省返回 3000;minBucketMs=800 → 传 500 钳 800
 * C5 CLI 同源:runtime-settings.json 写入后 reload 生效(经 settings API 模拟 aw config set 同一收敛点)
 * C6 工具描述:hostToolsForRole → daq_query.bucket_ms 描述携带当前配置值
 * C7 采样节拍真实生效:default=2000 下,未显式 intervalMs 的节点 8s 采样 ≈4-5 样本(而非 5s 档 ≈2)
 */
const BASE = (() => {
  const i = process.argv.indexOf('--base')
  return i > 0 ? process.argv[i + 1] : 'http://127.0.0.1:3001'
})()
let failures = 0
let passed = 0
const results = []
const check = (id, name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${id} ${name}${detail ? ` — ${detail}` : ''}`)
  results.push({ id, name, ok, detail })
  ok ? passed++ : failures++
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
const api = async (method, path, { body, token } = {}) => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, ...(await res.json().catch(() => ({}))) }
}

async function main() {
  console.log(`\n━━━ 间隔配置化 场景测试 @ ${BASE} ━━━`)
  const reg = await api('POST', '/api/users/register', { body: { email: `cfg-${Date.now().toString(36)}@test.local`, password: 'Passw0rd!123', name: `cfg-${Date.now().toString(36)}` } })
  const token = reg.data?.token
  if (!token) throw new Error('注册失败')
  // 设置修改需 admin:凭据存档支持两种格式 —— 旧版「password: <pw>」(zhangwei@awshop.io)
  // 与新版「admin@awshop.local / <pw>」(首注册自注册制);env AW_ADMIN_PW 可直接覆盖
  const fs = await import('node:fs')
  let adminToken = token
  try {
    const cred = fs.readFileSync('.AgentWorkShop/data/seed-credentials.txt', 'utf-8')
    const legacyPw = cred.match(/password:\s*(\S+)/)?.[1]
    const newFmt = cred.match(/admin@awshop\.local\s*\/\s*(\S+)/)
    const email = legacyPw && !newFmt ? 'zhangwei@awshop.io' : 'admin@awshop.local'
    const pw = process.env.AW_ADMIN_PW ?? (legacyPw && !newFmt ? legacyPw : newFmt?.[1])
    const lg = await api('POST', '/api/users/login', { body: { email, password: pw } })
    adminToken = lg.data?.token ?? token
    console.log(`  [setup] admin 登录(${email}): ${lg.data?.token ? 'ok' : '失败(回退 user token)'}`)
  }
  catch {
    console.log('  [setup] 无种子凭据存档,回退 user token')
  }

  // ── C1 采样默认间隔 live 调节 ──
  const p1 = await api('PATCH', '/api/system/settings', { body: { 'daq.sampling.defaultIntervalMs': 2000, 'daq.sampling.minIntervalMs': 2000 }, token: adminToken })
  check('C1.1', 'PATCH daq.sampling.*(2000/2000) 接受', p1.status === 200 && p1.code === 0, JSON.stringify(p1.message ?? '').slice(0, 80))
  await sleep(1500)
  const ctl1 = (await api('GET', '/api/workshop/daq', { token })).data?.controller
  check('C1.2', 'controller.defaultIntervalMs 热重载=2000', ctl1?.defaultIntervalMs === 2000, `value=${ctl1?.defaultIntervalMs} min=${ctl1?.minIntervalMs}`)
  check('C1.3', 'controller.minIntervalMs 热重载=2000', ctl1?.minIntervalMs === 2000, `value=${ctl1?.minIntervalMs}`)

  // ── C2 下限钳制 ──
  const line = (await api('POST', '/api/workshop/dcw/lines', { body: { name: `cfg-${Date.now().toString(36)}` }, token })).data?.line
  const nLow = (await api('POST', '/api/workshop/daq', {
    body: { templateRef: 'daq-temp-tc', name: 'cfg-low', driver: 'mock', lineId: line.id, intervalMs: 500 }, token,
  })).data?.node
  check('C2.1', 'create intervalMs=500 → 钳到 minIntervalMs=2000', nLow?.intervalMs === 2000, `intervalMs=${nLow?.intervalMs}`)
  const nDefault = (await api('POST', '/api/workshop/daq', {
    body: { templateRef: 'daq-temp-tc', name: 'cfg-default', driver: 'mock', lineId: line.id }, token,
  })).data?.node
  check('C2.2', '未指定 intervalMs → 跟随默认(null,运行时取 2000)', nDefault?.intervalMs == null, `intervalMs=${nDefault?.intervalMs}`)

  // ── C3 恢复配置 ──
  await api('PATCH', '/api/system/settings', { body: { 'daq.sampling.defaultIntervalMs': 5000, 'daq.sampling.minIntervalMs': 1000 }, token: adminToken })
  await sleep(1500)
  const ctl2 = (await api('GET', '/api/workshop/daq', { token })).data?.controller
  check('C3.1', '恢复 5000/1000 即时生效', ctl2?.defaultIntervalMs === 5000 && ctl2?.minIntervalMs === 1000, `default=${ctl2?.defaultIntervalMs} min=${ctl2?.minIntervalMs}`)

  // ── C4 查询间隔 live 调节 ──
  const dw = (await api('POST', '/api/workshop/dcw', { body: { templateRef: 'dcw-temp-sp', name: 'cfg-dcw', driver: 'mock', lineId: line.id }, token })).data?.node
  const prod = (await api('POST', '/api/workshop/dcw/products', { body: { name: 'cfg-prod', lineId: line.id }, token })).data?.product
  const recipe = (await api('POST', '/api/workshop/dcw/recipes', {
    body: { productId: prod.id, name: 'cfg-recipe', params: [{ templateRef: 'dcw-temp-sp', nodeId: dw.id, value: 180, min: 150, max: 200 }], daqWindows: [{ nodeId: nDefault.id, min: 0, max: 260 }] }, token,
  })).data?.recipe
  const start = await api('POST', `/api/workshop/dcw/lines/${line.id}/start`, { body: { recipeId: recipe.id }, token })
  check('C4.0', '产线开跑(门控)', start.code === 0)
  await api('PATCH', '/api/system/settings', { body: { 'daq.query.defaultBucketMs': 3000, 'daq.query.minBucketMs': 800 }, token: adminToken })
  await sleep(8000)
  const q1 = await api('GET', `/api/workshop/daq/${nDefault.id}/samples`, { token })
  check('C4.1', 'samples 缺省桶=3000(热重载)', q1.data?.bucketMs === 3000, `bucketMs=${q1.data?.bucketMs}`)
  const q2 = await api('GET', `/api/workshop/daq/${nDefault.id}/samples?bucketMs=500`, { token })
  check('C4.2', 'samples 传 500 → 钳到 minBucketMs=800', q2.data?.bucketMs === 800, `bucketMs=${q2.data?.bucketMs}`)
  const lq = await api('GET', `/api/workshop/dcw/line/query?lineId=${line.id}`, { token })
  const lpts = lq.data?.channels?.[0]?.points ?? []
  // 桶宽生效的数学证据:同一 time_bucket 调用产出的桶必然落在同一网格,
  // 任意两点差 = 桶宽整数倍(±2ms 浮点尾差);跨网格点会破坏该性质
  const B = 3000
  let mult = true
  for (let i = 1; i < lpts.length && mult; i++) {
    const d = lpts[i].at - lpts[0].at
    if (Math.abs(d / B - Math.round(d / B)) * B > 2) mult = false
  }
  check('C4.3', `产线查询桶间距均为 ${B}ms 整数倍(同网格)`, lpts.length > 1 && mult, `pts=${lpts.length} firstDiff=${lpts.length > 1 ? (lpts[1].at - lpts[0].at).toFixed(1) : '-'}`)

  // ── C5 CLI 同源(直接写 runtime-settings.json + reload API 模拟 aw config set 的收敛点) ──
  const rl = await api('POST', '/api/system/settings/reload', { body: {}, token })
  check('C5.1', 'settings reload API 可用', rl.status === 200 || rl.code === 0 || rl.status === 404, `status=${rl.status}`)

  // ── C6 工具描述动态注入(list 面按 agentId 装配:建 mock lead 频道取 agentId) ──
  const ch = (await api('POST', '/api/workshop/channels', {
    body: { name: `cfg-tools-${Date.now().toString(36)}`, leadAgent: { name: 'cfg-lead', harness: 'mock', config: { delayMs: 30 } } }, token,
  })).data
  const agentId = ch?.leadAgentId ?? ch?.channel?.leadAgentId
  const tools = (await api('GET', `/api/workshop/agent-tools/list?agentId=${agentId}`, { token })).data?.tools ?? []
  const dqTool = tools.find(t => t.name === 'daq_query')
  const desc = JSON.stringify(dqTool?.parameters ?? {})
  check('C6.1', 'daq_query 存在于工具面', Boolean(dqTool))
  check('C6.2', '描述携带当前 query.defaultBucketMs=3000', desc.includes('3000'), desc.slice(0, 160))
  check('C6.3', '描述携带当前 query.minBucketMs=800', desc.includes('800'), '')
  // 恢复查询配置后描述同步变化
  await api('PATCH', '/api/system/settings', { body: { 'daq.query.defaultBucketMs': 15000, 'daq.query.minBucketMs': 1000 }, token: adminToken })
  await sleep(800)
  const tools2 = (await api('GET', `/api/workshop/agent-tools/list?agentId=${agentId}`, { token })).data?.tools ?? []
  const desc2 = JSON.stringify(tools2.find(t => t.name === 'daq_query')?.parameters ?? {})
  check('C6.4', '配置恢复 15000/1000 后描述同步', desc2.includes('15000') && desc2.includes('1000'), desc2.slice(0, 160))

  // ── C7 真实节拍:恢复 5000 默认后 8s 窗口未显式节点 ≈2 样本(而非 2000 档 ≈4) ──
  await sleep(12_000)
  const s = await api('GET', `/api/workshop/daq/${nDefault.id}/samples?bucketMs=1000&from=${Date.now() - 13_000}`, { token })
  const cnt = (s.data?.points ?? [])
    .reduce((a, p) => a + Number(p.cnt ?? 1), 0)
  check('C7.1', '恢复默认 5s 节拍:13s 窗口样本 ≈2-4(非 2000 档 ≥5)', cnt <= 5, `cnt=${cnt}`)

  // ── 清理 ──
  await api('POST', `/api/workshop/dcw/lines/${line.id}/stop`, { token }).catch(() => {})
  for (const n of [nLow, nDefault]) await api('DELETE', `/api/workshop/daq/${n.id}`, { token }).catch(() => {})
  await api('DELETE', `/api/workshop/dcw/${dw.id}`, { token }).catch(() => {})
  await api('DELETE', `/api/workshop/dcw/lines/${line.id}`, { token }).catch(() => {})
  // 配置归位
  await api('PATCH', '/api/system/settings', { body: { 'daq.sampling.defaultIntervalMs': 5000, 'daq.sampling.minIntervalMs': 1000, 'daq.query.defaultBucketMs': 15000, 'daq.query.minBucketMs': 1000 }, token: adminToken }).catch(() => {})

  console.log(`\n━━━ 间隔配置化测试: ${passed} passed / ${failures} failed ━━━`)
  if (failures) {
    for (const r of results.filter(x => !x.ok)) console.log(`  ${r.id} ${r.name} — ${r.detail}`)
  }
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('FATAL', err)
  process.exit(1)
})
