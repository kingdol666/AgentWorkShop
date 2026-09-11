/**
 * 视觉走查夹具(demo data seeder)—— 给设计评审准备"有内容的界面"。
 *
 * 为什么需要它:空态只能验证排版骨架,验证不了**信息密度 / 表格节奏 / 图表色序 / 玻璃层次**
 * ——那些恰恰是设计评审要判的东西。所以这里建一套**最小但真实**的工业夹具:
 * 产线 → 产品 → 配方 → 数采节点(scalar/vector/image)→ 数控节点 → 开采集 → 跑一个批次,
 * 让仪表盘/数采/数控三页都有活数据。全部走真实 REST,不写库、不造假字段。
 *
 * 用法:node scripts/_audit/seed-demo.mjs [base]
 */
const BASE = (process.argv[2] ?? process.env.AW_BASE ?? 'http://127.0.0.1:3111').replace(/\/$/, '')
const ADMIN_EMAIL = process.env.AW_ADMIN_EMAIL ?? 'admin@awshop.local'
const ADMIN_PASS = process.env.AW_ADMIN_PASS ?? 'admin123'

const sleep = ms => new Promise(r => setTimeout(r, ms))
let token = ''
let pass = 0
const fail = []
const ok = (name, cond, detail = '') => {
  if (cond) {
    pass++
    console.log(`  ✔ ${name}${detail ? ` — ${detail}` : ''}`)
  }
  else {
    fail.push(name)
    console.log(`  ✘ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

async function api(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const json = await res.json().catch(() => null)
  return { status: res.status, data: json?.data, code: json?.code, message: json?.message }
}

async function main() {
  console.log(`\n=== 视觉走查夹具 @ ${BASE} ===`)

  // 1. 管理员(空实例首位注册即 admin;已有则登录)
  const setup = await api('GET', '/api/users/setup-status')
  if (setup.data?.needsSetup) {
    const reg = await api('POST', '/api/users/register', { name: 'admin', email: ADMIN_EMAIL, password: ADMIN_PASS })
    token = reg.data?.token ?? ''
    ok('注册管理员(空实例首位)', Boolean(token), `role=${reg.data?.user?.role}`)
  }
  else {
    const lg = await api('POST', '/api/users/login', { email: ADMIN_EMAIL, password: ADMIN_PASS })
    token = lg.data?.token ?? ''
    ok('登录管理员', Boolean(token), lg.message ?? '')
    if (!token) {
      const reg = await api('POST', '/api/users/register', { name: `demo-${Date.now().toString(36)}`, email: `demo-${Date.now().toString(36)}@awshop.local`, password: 'admin123' })
      token = reg.data?.token ?? ''
      console.log(`    ⚠ 已知管理员不存在,改用新账号(role=${reg.data?.user?.role},非 admin 时部分页面会 403)`)
    }
  }
  if (!token) {
    console.error('无法取得 token,退出')
    process.exit(1)
  }

  const suffix = Date.now().toString(36).slice(-5)

  // 2. 产线 / 产品 / 配方
  const line = await api('POST', '/api/workshop/dcw/lines', { name: `热轧一线 · ${suffix}` })
  const lineId = line.data?.line?.id
  ok('产线', Boolean(lineId), lineId)

  const product = await api('POST', '/api/workshop/dcw/products', { lineId, name: `低碳钢板 Q235 · ${suffix}` })
  const productId = product.data?.product?.id
  ok('产品', Boolean(productId), productId)

  const dcwTpl = await api('POST', '/api/workshop/dcw/templates', {
    key: `cw-demo-${suffix}`, name: '炉温设定', ch: '烘箱温度', unit: '℃', min: 120, max: 260, decimals: 1,
  })
  const dcwTplKey = dcwTpl.data?.template?.key
  ok('数控模板', Boolean(dcwTplKey), dcwTplKey)

  const mkDcw = async (name) => {
    const r = await api('POST', '/api/workshop/dcw', {
      name, templateRef: dcwTplKey, driver: 'mock', unit: '℃', min: 120, max: 260, decimals: 1, lineId, holdIntervalMs: 0,
    })
    return r.data?.node?.id
  }
  const dw1 = await mkDcw('一段炉温')
  const dw2 = await mkDcw('二段炉温')
  ok('数控节点 ×2', Boolean(dw1 && dw2), `${dw1} / ${dw2}`)

  const recipe = await api('POST', '/api/workshop/dcw/recipes', {
    productId,
    name: `Q235 标准工艺 · ${suffix}`,
    description: '夹具配方',
    params: [
      { nodeId: dw1, value: 190, min: 175, max: 205 },
      { nodeId: dw2, value: 205, min: 190, max: 225 },
    ],
  })
  const recipeId = recipe.data?.recipe?.id
  ok('配方(2 参数)', Boolean(recipeId), recipeId)

  // 3. 数采节点:scalar / vector / image(覆盖三种信号形态 → 三种图表与帧形态)
  const mkDaq = async (label, body) => {
    const r = await api('POST', '/api/workshop/daq', { driver: 'mock', lineId, intervalMs: 1000, publishIntervalMs: 0, ...body })
    ok(`数采节点 ${label}`, Boolean(r.data?.node?.id), r.data?.node?.id ?? r.message)
    return r.data?.node?.id
  }
  const dnTemp = await mkDaq('scalar 炉温', { name: `炉温测温 · ${suffix}`, templateRef: 'daq-temp-tc' })
  const dnPress = await mkDaq('scalar 压力', { name: `出口压力 · ${suffix}`, templateRef: 'daq-pressure-tx' })
  const dnProf = await mkDaq('vector 轮廓', { name: `测厚轮廓 · ${suffix}`, templateRef: 'daq-thickness-scan' })
  const dnTension = await mkDaq('scalar 张力', { name: `膜张力 · ${suffix}`, templateRef: 'daq-tension-cell' })
  const dnSpeed = await mkDaq('scalar 速度', { name: `产线速度 · ${suffix}`, templateRef: 'daq-line-encoder' })
  const dnCcd = await mkDaq('image CCD', { name: `表面相机 · ${suffix}`, templateRef: 'daq-ccd-image' })
  const DAQ_NODES = [dnTemp, dnPress, dnProf, dnTension, dnSpeed, dnCcd].filter(Boolean)

  // 4. 启动采集(网关 + 逐节点),让仪表盘/数采页有实时值
  await api('POST', '/api/workshop/daq/gateway/start', {})
  for (const id of DAQ_NODES) {
    await api('POST', `/api/workshop/daq/${id}/enable`, {})
    await api('POST', `/api/workshop/daq/${id}/start`, {})
  }
  ok('数采网关已启动', true, `${DAQ_NODES.length} 个节点在采`)

  // 5. 跑一个批次(激活批次窗口 → 仪表盘"当前批次"与 DCW 联锁有内容)
  if (recipeId) {
    const start = await api('POST', `/api/workshop/dcw/lines/${lineId}/start`, { recipeId })
    ok('产线开跑', start.status === 200, start.message ?? '')
  }

  // 让采样攒够样本(图表才有曲线,不是单点)
  console.log('  · 采集样本中(22s)…')
  await sleep(22_000)

  // 6. 数控写入若干次 → 参数账本/回退账本/优化记录有历史
  for (const [id, v] of [[dw1, 188], [dw1, 191], [dw2, 203], [dw2, 207]]) {
    if (id) await api('POST', `/api/workshop/dcw/${id}/write`, { value: v })
    await sleep(400)
  }
  ok('数控写入历史已生成', true)

  // 7. 停线并停采集(留下已落库的数据,不让夹具持续占用 CPU)
  await api('POST', `/api/workshop/dcw/lines/${lineId}/stop`, {})
  for (const id of DAQ_NODES) {
    await api('POST', `/api/workshop/daq/${id}/stop`, {})
  }

  // 8. 一个 channel + agent(控制台页需要)
  const ch = await api('POST', '/api/workshop/channels', {
    name: `产线值守 · ${suffix}`,
    scenarioPrompt: '监视热轧一线温度与压力,异常时给出处置建议。',
    leadAgent: { name: '值班长', harness: 'mock', config: { delayMs: 400 } },
  })
  const channelId = ch.data?.channelId ?? ch.data?.id
  ok('channel + lead agent', Boolean(channelId), channelId)

  console.log(`\n夹具完成:${pass} 项就绪${fail.length ? `,${fail.length} 项失败(${fail.join('、')})` : ''}`)
  console.log(`提示:仪表盘/数采/数控三页现在有活数据;其余页面无需夹具。`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
