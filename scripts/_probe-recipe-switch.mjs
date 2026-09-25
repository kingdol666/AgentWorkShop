/**
 * 临时:验证「产线换配方后,数采样本只带当前运行配方的 id」+ daq_query 的配方过滤
 *  1) 用配方 A 开跑(start)-> 采样 ~40s -> 统计 Timescale 里 recipe_id 分布
 *  2) 建配方 B(同线,不同 SP)并切换到 B -> 采样 ~40s -> 再统计
 *  3) 打印两个时间窗内的样本数与 tag,证明"逐样本打标当轮配方",并演示按 recipe 过滤查询
 * 用法:AW_BASE=http://127.0.0.1:3300 node scripts/_probe-recipe-switch.mjs
 */
const BASE = process.env.AW_BASE ?? 'http://127.0.0.1:3300'
const LINE = process.env.AW_LINE ?? 'ln-f1b1c060'
const PG = { host: '127.0.0.1', port: 5432, user: 'postgres', password: 'awshop', database: 'awshop' }

const j = async (method, path, body, token) => {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: r.status, ...(await r.json().catch(() => ({}))) }
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

const token = (await j('POST', '/api/users/login', { email: 'admin@awshop.local', password: 'admin123' })).data?.token
const { Client } = await import('pg')
const pg = new Client(PG)
await pg.connect()
const dist = async (label, fromMs) => {
  const r = await pg.query(
    `SELECT recipe_id, run_id, node_id, COUNT(*)::int AS n, MAX(ts) AS last
     FROM daq_samples WHERE line_id = $1 AND ts >= to_timestamp($2/1000.0)
     GROUP BY recipe_id, run_id, node_id ORDER BY last DESC LIMIT 12`, [LINE, fromMs])
  console.log(`\n[${label}] from=${new Date(fromMs).toISOString().slice(11, 19)} 行数=${r.rowCount}`)
  for (const x of r.rows) console.log(`   recipe=${x.recipe_id ?? '(null)'} run=${String(x.run_id ?? '-').slice(0, 12)} node=${x.node_id} n=${x.n} last=${new Date(x.last).toISOString().slice(11, 19)}`)
}
const sampleCount = async (fromMs, extra = '', params = []) => {
  const r = await pg.query(`SELECT COUNT(*)::int AS n FROM daq_samples WHERE line_id = $1 AND ts >= to_timestamp($2/1000.0) ${extra}`, [LINE, fromMs, ...params])
  return r.rows[0].n
}

// ── 配方 A 开跑 ──
const recipes = (await j('GET', '/api/workshop/dcw', undefined, token)).data.recipes.filter(r => r.lineId === LINE)
const A = recipes[0]
if (!A) {
  console.error('该线无配方可用')
  process.exit(1)
}
console.log(`配方 A = ${A.id} ${A.name}`)
const startA = await j('POST', `/api/workshop/dcw/lines/${LINE}/start`, { recipeId: A.id }, token)
console.log('start A:', startA.status, startA.code, startA.message ?? 'ok')
const tA = Date.now()
await sleep(40_000)
await dist('配方 A 运行窗口', tA)

// ── 建配方 B(同线同产品,SP 不同)并切换 ──
const snap = (await j('GET', '/api/workshop/dcw', undefined, token)).data
const dcwNodes = snap.nodes.filter(n => n.lineId === LINE).slice(0, 3)
const productId = (snap.products ?? []).find(p => p.lineId === LINE)?.id ?? A.productId
const params = dcwNodes.map((n) => {
  const v = Number(n.readValue ?? n.value ?? 100)
  return { nodeId: n.id, value: Number.isFinite(v) ? Math.min(Number(n.max ?? v + 5), v + 2) : 100 }
})
const B = await j('POST', '/api/workshop/dcw/recipes', {
  lineId: LINE,
  productId,
  name: `换配方演示-B-${Date.now().toString(36).slice(-4)}`,
  params,
  daqWindows: [],
}, token)
const bId = B.data?.recipe?.id ?? B.data?.id
console.log(`\n配方 B = ${bId} (status=${B.status} ${B.message ?? 'ok'}) productId=${productId} params=${JSON.stringify(params.map(p => `${p.nodeId.slice(0, 10)}=${p.value}`))}`)
if (bId) {
  // 换配方必须先停当前批次(服务端 409 明确要求)
  const stop = await j('POST', `/api/workshop/dcw/lines/${LINE}/stop`, {}, token)
  console.log('stop 当前批次:', stop.status, stop.code, stop.message ?? 'ok')
  await sleep(2000)
  const startB = await j('POST', `/api/workshop/dcw/lines/${LINE}/start`, { recipeId: bId }, token)
  console.log('start B:', startB.status, startB.code, startB.message ?? 'ok')
}
const tB = Date.now()
await sleep(40_000)
await dist('配方 B 运行窗口', tB)

// ── 过滤查询演示(等价于 daq_query 的 recipe_id 分支) ──
const total = await sampleCount(tA)
const onlyA = await sampleCount(tA, 'AND recipe_id = $3', [A.id])
const onlyB = await sampleCount(tB, 'AND recipe_id = $3', [bId])
console.log(`\n窗口A 总样本=${total} 其中 recipe=${A.id} 的=${onlyA}`)
console.log(`窗口B 其中 recipe=${bId} 的=${onlyB}`)
const cross = await pg.query(
  `SELECT recipe_id, COUNT(*)::int AS n FROM daq_samples WHERE line_id = $1 AND ts >= to_timestamp($2/1000.0) GROUP BY recipe_id`,
  [LINE, tA])
console.log('窗口A 起全部样本按配方分组:', JSON.stringify(cross.rows))
await pg.end()
