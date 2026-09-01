/**
 * 运维日志(OpsLog)e2e:全操作入册 + 维度隔离查询 + 实时帧 + 人工记录。
 * 链路:夹具产线开跑 → 手动下发 → 越限告警 → 人工记录 → 按产线/Recipe/分类/来源过滤。
 * 前置:dev server + DAQ/DCW 网关运行;mock 驱动节点即可(无需真机)。
 * 运行:ADMIN_TOKEN=<token> node scripts/_dbg-opslog-e2e.mjs
 */
const BASE = process.env.AW_PAGE_BASE ?? 'http://127.0.0.1:3000'
const H = { authorization: `Bearer ${process.env.ADMIN_TOKEN ?? process.env.AW_PAGE_TOKEN ?? ''}`, 'content-type': 'application/json' }
let pass = 0
let fail = 0
const ok = (cond, label) => {
  if (cond) { pass++; console.log(`PASS ${label}`) }
  else { fail++; console.log(`FAIL ${label}`) }
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
const rand = Math.random().toString(36).slice(2, 7)
const jget = async p => (await fetch(`${BASE}${p}`, { headers: H })).json()
const jpost = async (p, b) => (await fetch(`${BASE}${p}`, { method: 'POST', headers: H, body: JSON.stringify(b ?? {}) })).json()
const jpatch = async (p, b) => (await fetch(`${BASE}${p}`, { method: 'PATCH', headers: H, body: JSON.stringify(b ?? {}) })).json()

// ---- WS 实时帧监听(ops.log / daq.alarm 直推验证;Node 24 全局 WebSocket) ----
let wsSeen = []
let wsClose = null
async function startWs() {
  const token = H.authorization.split(' ')[1]
  const sock = new WebSocket(`ws://127.0.0.1:3000/api/workshop/ws?token=${token}`)
  await new Promise((resolve, reject) => { sock.addEventListener('open', resolve, { once: true }); sock.addEventListener('error', reject, { once: true }) })
  sock.addEventListener('message', (ev) => {
    try {
      const f = JSON.parse(String(ev.data))
      if (f.type === 'ops.log' || f.type === 'daq.alarm') wsSeen.push(f.type)
    }
    catch { /* 忽略非 JSON 帧 */ }
  })
  wsClose = () => sock.close()
}

// ---- 0) 网关运行 ----
{
  const r = await jget('/api/workshop/dcw')
  if (!r?.data?.controller?.running)
    await fetch(`${BASE}/api/workshop/dcw/controller?action=resume`, { method: 'POST', headers: H })
  const d = await jget('/api/workshop/daq')
  if (!d?.data?.controller?.running)
    await jpost('/api/workshop/daq/controller', { action: 'resume' })
}

// ---- 1) 夹具:产线 + 数控 + 产品 + 配方 + 数采节点(mock 温度 ~165-180) ----
const line = (await jpost('/api/workshop/dcw/lines', { name: `OpsLog线-${rand}` })).data.line
const dw = (await jpost('/api/workshop/dcw', { templateRef: 'dcw-temp-sp', name: `OpsLog设定-${rand}`, lineId: line.id })).data.node
const product = (await jpost('/api/workshop/dcw/products', { lineId: line.id, name: `OpsLog产品-${rand}` })).data.product
const recipe = (await jpost('/api/workshop/dcw/recipes', { productId: product.id, name: `OpsLog配方-${rand}`, params: [{ nodeId: dw.id, value: 175 }] })).data.recipe
const dq = (await jpost('/api/workshop/daq', { templateRef: 'daq-temp-tc', name: `OpsLog采集-${rand}`, lineId: line.id, intervalMs: 500 })).data.node
ok(!!line?.id && !!dq?.id, '夹具创建(产线/数控/配方/数采)')

// ---- 2) WS 先连上,覆盖后续全部操作(直推验证) ----
await startWs()

// ---- 3) 产线开跑 → ops 日志应有 line.start(携带产线/产品/Recipe) ----
const start = await jpost(`/api/workshop/dcw/lines/${line.id}/start`, { recipeId: recipe.id })
ok(start.code === 0, '产线开跑')
await sleep(700)
{
  const r = await jget(`/api/workshop/ops-logs?lineId=${line.id}&kind=line&limit=20`)
  const row = (r.data?.logs ?? []).find(x => x.action === 'line.start')
  ok(!!row, '开跑入册(line.start)')
  ok(row?.lineId === line.id && row?.productId === product.id && row?.recipeId === recipe.id, '开跑维度三联正确(line/product/recipe)')
}

// ---- 3) 手动下发 → write 入册 ----
{
  const w = await jpost(`/api/workshop/dcw/${dw.id}/write`, { value: 176 })
  ok(w.data?.outcome?.ok !== false, '手动下发 176')
  await sleep(600)
  const r = await jget(`/api/workshop/ops-logs?lineId=${line.id}&kind=write&limit=20`)
  const writes = (r.data?.logs ?? []).filter(x => x.action === 'dcw.write.manual')
  ok(writes.length >= 1, `下发入册(dcw.write.manual ×${writes.length})`)
  ok(writes.every(x => x.recipeId === recipe.id), '下发条目携带活动批次 Recipe')
}

// ---- 4) 越限告警:配方窗 [900,950](mock 温度必越)→ alarm 沿 → raise → ops 入册 ----
{
  const p = await jpatch(`/api/workshop/dcw/recipes/${recipe.id}`, { daqWindows: [{ nodeId: dq.id, min: 900, max: 950 }] })
  ok(p.code === 0, '配方追加越限监控窗 [900,950]')
  await sleep(4500)
  const alarms = await jget('/api/workshop/daq/alarms?scope=open&limit=50')
  const hit = (alarms.data?.alarms ?? []).find(a => a.nodeId === dq.id)
  ok(!!hit, `越窗告警已产生(node=${hit?.nodeName ?? '—'})`)
  await sleep(400)
  const r = await jget(`/api/workshop/ops-logs?lineId=${line.id}&kind=alarm&limit=10`)
  ok((r.data?.logs ?? []).some(x => x.action === 'daq.alarm.raise'), '告警入册(daq.alarm.raise)')
}

// ---- 5) 人工记录(带产线/产品/Recipe)→ kind=manual 按 Recipe 可查 ----
{
  const post = await jpost('/api/workshop/ops-logs', { summary: `OpsLog e2e 人工事件 ${rand}:现场处置留痕`, lineId: line.id, productId: product.id, recipeId: recipe.id })
  ok(post.code === 0, '人工记录入册成功')
  const r = await jget(`/api/workshop/ops-logs?recipeId=${recipe.id}&kind=manual&limit=10`)
  const hit = (r.data?.logs ?? []).find(x => x.kind === 'manual')
  ok(!!hit && (hit.summary ?? '').includes(rand), '按 Recipe 过滤命中人工记录')
}

// ---- 6) WS 实时帧:监听器全程在线,应已收到 ops.log 与 daq.alarm ----
{
  await sleep(800)
  wsClose?.()
  ok(wsSeen.includes('ops.log'), `WS 收到 ops.log 帧(×${wsSeen.filter(t => t === 'ops.log').length})`)
  ok(wsSeen.includes('daq.alarm'), `WS 收到 daq.alarm 帧(×${wsSeen.filter(t => t === 'daq.alarm').length})`)
}

// ---- 7) 组合过滤:来源=system + 产线隔离 ----
{
  const r = await jget(`/api/workshop/ops-logs?lineId=${line.id}&actorKind=system&limit=50`)
  const rows = r.data?.logs ?? []
  ok(rows.length >= 2 && rows.every(x => x.actorKind === 'system' && x.lineId === line.id), `来源+产线组合过滤(×${rows.length})`)
}

// ---- 8) 清场:停线 ----
await jpost(`/api/workshop/dcw/lines/${line.id}/stop`, {})
console.log(`\n=== 结果:${pass} PASS / ${fail} FAIL ===`)
process.exit(fail > 0 ? 1 : 0)
