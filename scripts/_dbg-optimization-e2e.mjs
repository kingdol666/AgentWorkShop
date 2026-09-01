/**
 * M3 e2e:系统兜底自动回退全链(越配方监控窗 → sweep 评估 → 自动回退 → 冷却)。
 * 需要短窗 env:DCW_ROLLBACK_MIN_WINDOW_MS=6000 DCW_ROLLBACK_COOLDOWN_MS=8000(由启动方注入)。
 * 用法:ADMIN_TOKEN=<token> node scripts/_dbg-optimization-e2e.mjs
 */
const BASE = process.env.AW_PAGE_BASE ?? 'http://127.0.0.1:3000'
const H = { 'authorization': `Bearer ${process.env.ADMIN_TOKEN ?? process.env.AW_PAGE_TOKEN ?? ''}`, 'content-type': 'application/json' }
let pass = 0
let fail = 0
const ok = (cond, label) => {
  if (cond) { pass++; console.log(`PASS ${label}`) }
  else { fail++; console.log(`FAIL ${label}`) }
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
const jget = p => fetch(`${BASE}/api/workshop/dcw${p}`, { headers: H }).then(r => r.json())
const jpost = async (p, b) => {
  const r = await fetch(`${BASE}/api/workshop/dcw${p}`, { method: 'POST', headers: H, body: JSON.stringify(b ?? {}) })
  const j = await r.json().catch(() => ({}))
  if (!r.ok || j.code !== 0) console.log(`  [debug] POST ${p} → ${r.status} ${JSON.stringify(j).slice(0, 160)}`)
  return j
}
const rand = () => Math.random().toString(36).slice(2, 7)
const AGENT = `opt-agent-${rand()}`

// ---- 0) 网关运行 ----
{
  const r = await jget('')
  if (!r?.data?.controller?.running)
    await fetch(`${BASE}/api/workshop/dcw/controller?action=resume`, { method: 'POST', headers: H }).then(x => x.json())
}

// ---- 1) 夹具:产线 + 产品 + 配方(daqWindows 设为不可达区间 → 全样本越限) ----
const line = (await jpost('/lines', { name: `OptE2E线-${rand()}` })).data.line
const product = (await jpost('/products', { lineId: line.id, name: `OptE2E产品-${rand()}` })).data.product
const devList = (await fetch(`${BASE}/api/workshop/device-twins`, { headers: H }).then(r => r.json())).data?.twins ?? []
const device = devList.find(t => t.kind !== 'daq' && typeof t.posX === 'number')
ok(!!device?.id, `设备孪生可用(${device?.id})`)

// 数采节点(绑定同设备 → 优化记录通道选择命中)
const daqCreate = await fetch(`${BASE}/api/workshop/daq`, { method: 'POST', headers: H, body: JSON.stringify({ templateRef: 'daq-temp-tc', name: `OptE2E温度采集-${rand()}`, lineId: line.id, intervalMs: 500, deviceBindingId: device.id, posX: (device.posX ?? 0) + 30, posZ: (device.posZ ?? 0) + 30 }) }).then(r => r.json())
const dq = daqCreate.data?.node
ok(!!dq?.id, `数采节点创建(${dq?.id})`)
const dcwCreate = await jpost('', { templateRef: 'dcw-temp-sp', name: `OptE2E温度设定-${rand()}`, lineId: line.id, deviceBindingId: device.id, posX: (device.posX ?? 0) - 30, posZ: (device.posZ ?? 0) - 30 })
const dw = dcwCreate.data?.node
ok(!!dw?.id, `数控节点创建(${dw?.id})`)

// 配方:参数 175 + 监控窗 [900, 950](mock 数采温度 ~165-180 → 全越限 → 必触发)
const recipe = (await jpost('/recipes', { productId: product.id, name: `OptE2E配方-${rand()}`, params: [{ nodeId: dw.id, value: 175 }], daqWindows: [{ nodeId: dq.id, min: 900, max: 950 }] })).data.recipe
ok(!!recipe?.id, '配方创建(含越限监控窗)')

// ---- 2) Agent 绑定(auto)→ 开跑 → dcw_control 开记录 ----
const bind = await fetch(`${BASE}/api/workshop/agent-tools/bindings`, { method: 'POST', headers: H, body: JSON.stringify({ agentId: AGENT, nodeId: dw.id, kind: 'dcw', mode: 'auto' }) })
ok(bind.status === 200, 'Agent 绑定(auto)')
const start = await jpost(`/lines/${line.id}/start`, { recipeId: recipe.id })
ok(start.code === 0, '产线开跑(数采门控开启,样本带 recipeId 打标)')

const c1 = await fetch(`${BASE}/api/workshop/agent-tools/invoke`, { method: 'POST', headers: H, body: JSON.stringify({ agentId: AGENT, tool: 'dcw_control', args: { node_id: dw.id, value: 176, hypothesis: 'OptE2E:提温 1℃(预期越窗触发系统回退)' } }) }).then(r => r.json())
const recId = (c1.data?.result?.text.match(/优化记录 (opt-[0-9a-f]+)/) ?? [])[1]
ok(!!recId, `dcw_control 开记录(${recId})`)

// ---- 3) 等 sweep 兜底评估(MIN_WINDOW 6s + 余量)→ 系统自动回退 ----
console.log('  等待系统兜底评估(约 10s)…')
let rolled = null
for (let i = 0; i < 20; i++) {
  await sleep(1500)
  const records = (await jget(`/optimizations?nodeId=${dw.id}`)).data.records
  rolled = records.find(r => r.id === recId)
  if (rolled?.status === 'rolled-back') break
}
ok(rolled?.status === 'rolled-back', `记录被系统回退(rolled-back)`)
ok(rolled?.judge?.by === 'system' && rolled?.judge?.verdict === 'rollback' && /越配方监控窗/.test(rolled.judge.reason), `系统判定入册(by=system,越窗证据:${rolled?.judge?.reason.slice(0, 40)}…)`)
ok((rolled?.windowAgg?.channels ?? []).some(c => c.breaches >= 3), `窗口聚合含越限计数(breaches=${rolled?.windowAgg?.channels?.map(c => c.breaches)?.join('/')})`)

// 回退后设定值 = 记录 from 值
const ledger = (await jget(`/${dw.id}/param-ledger`)).data.ledger
ok(ledger.current === rolled.params[0]?.from, `PLC 设定已恢复基线(${ledger.current} = from ${rolled.params[0]?.from})`)

// ---- 4) 冷却内同向重写被拒 ----
const c2 = await fetch(`${BASE}/api/workshop/agent-tools/invoke`, { method: 'POST', headers: H, body: JSON.stringify({ agentId: AGENT, tool: 'dcw_control', args: { node_id: dw.id, value: 176 } }) }).then(r => r.json())
ok(/冷却/.test(c2.data?.result?.text ?? ''), `冷却护栏生效(${(c2.data?.result?.text ?? '').slice(0, 46)}…)`)
// 反向写不受冷却限制(写回更低值)
const c3 = await fetch(`${BASE}/api/workshop/agent-tools/invoke`, { method: 'POST', headers: H, body: JSON.stringify({ agentId: AGENT, tool: 'dcw_control', args: { node_id: dw.id, value: 174 } }) }).then(r => r.json())
ok(/下发成功/.test(c3.data?.result?.text ?? ''), '反向调整不受冷却限制')

// ---- 5) 持久化:dcw-rollback.json 落盘在册 ----
const fs = await import('node:fs')
const path = process.cwd().endsWith('server') ? 'data/dcw-rollback.json' : 'server/data/dcw-rollback.json'
const db = JSON.parse(fs.readFileSync(path, 'utf-8'))
ok(db.records.some(r => r.id === recId) && db.anchors.length > 0, `持久化在册(records ${db.records.length}/anchors ${db.anchors.length})`)

// ---- 6) 清场:停线 ----
await jpost(`/lines/${line.id}/stop`, {})
console.log(`\n=== 结果:${pass} PASS / ${fail} FAIL ===`)
process.exit(fail > 0 ? 1 : 0)
