// 最终验收·补测:产线开跑完整链路(产品→配方→start→stop)+ 团队 events 断言 + 计数器核对
const BASE = process.argv[2] ?? 'http://127.0.0.1:3001'
const ADMIN_PASS = process.argv[3] ?? 'admin123'
const CHANNEL_ID = process.argv[4]
let pass = 0, fail = 0
const ok = (name, cond, detail = '') => { cond ? pass++ : fail++; console.log(`${cond ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`) }
const api = async (path, opts = {}, tok) => {
  const res = await fetch(`${BASE}${path}`, { ...opts, headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}), ...opts.headers } })
  return { status: res.status, body: await res.json().catch(() => null) }
}
const adminTok = (await api('/api/users/login', { method: 'POST', body: JSON.stringify({ email: 'admin@awshop.local', password: ADMIN_PASS }) })).body?.data?.token

const dcw = (await api('/api/workshop/dcw', {}, adminTok)).body?.data
const line2 = dcw.lines[1]
ok('目标产线(第2条)', Boolean(line2), line2?.id)

// 1) 产品挂产线2
const prod = (await api('/api/workshop/dcw/products', { method: 'POST', body: JSON.stringify({ name: '验收产品', lineId: line2.id }) }, adminTok)).body?.data?.product
ok('产品创建并挂产线', Boolean(prod?.id) && prod?.lineId === line2.id, prod?.id)

// 2) 配方挂产品,参数指向该线写控节点(mock)
const wNode = dcw.nodes.find(n => n.lineId === line2.id && n.driver === 'mock')
ok('产线2 mock 写控节点', Boolean(wNode), wNode?.id)
const target = Math.round(((wNode.min ?? 150) + (wNode.max ?? 200)) / 2)
const recipe = (await api('/api/workshop/dcw/recipes', { method: 'POST', body: JSON.stringify({
  name: '验收配方', productId: prod.id,
  params: [{ nodeId: wNode.id, name: wNode.name, value: target, ch: wNode.templateKey }],
}) }, adminTok)).body?.data?.recipe
ok('配方创建(含工艺参数)', Boolean(recipe?.id), recipe?.id)

// 3) 开跑(配方参数 → 真实写 PLC 闭环)
const rStart = await api(`/api/workshop/dcw/lines/${line2.id}/start`, { method: 'POST', body: JSON.stringify({ recipeId: recipe.id }) }, adminTok)
ok('产线开跑(配方参数下发写控)', rStart.status === 200 && rStart.body?.data?.run != null, JSON.stringify(rStart.body?.data?.run ?? rStart.body?.message).slice(0, 80))
const activeRun = rStart.body?.data?.run?.id
// 采样打标窗口生效验证:数采样本应携带 run 标记(tsdb/历史入口)
await new Promise(r => setTimeout(r, 4000))
// 4) 停止
const rStop = await api(`/api/workshop/dcw/lines/${line2.id}/stop`, { method: 'POST', body: '{}' }, adminTok)
ok('产线停止', rStop.status === 200)
// 5) 批次数据视图(窗口内写历史+数采汇总)
const rd = await api(`/api/workshop/dcw/runs/${activeRun}/data`, {}, adminTok)
ok('批次数据视图(开跑→停止 闭环产物)', rd.status === 200 && rd.body?.data?.run?.id === activeRun, `writes=${rd.body?.data?.writes?.length} daq=${rd.body?.data?.daq?.length}`)

// 6) 团队闭环 events 断言(codex 回复落 artifact/delta)
if (CHANNEL_ID) {
  const evs = (await api(`/api/workshop/channels/${CHANNEL_ID}/events?limit=200`, {}, adminTok)).body?.data ?? []
  const list = Array.isArray(evs) ? evs : (evs.items ?? [])
  const kinds = {}
  for (const e of list) kinds[e.type ?? '?'] = (kinds[e.type ?? '?'] ?? 0) + 1
  const codexOk = list.some(e => e.type === 'agent.delta' && /codex ok/i.test(JSON.stringify(e.delta ?? e)))
    || list.some(e => e.type === 'a2a.artifact' && /codex ok/i.test(JSON.stringify(e)))
  ok('worker(codex) 回复(agent.delta/a2a.artifact)', codexOk, JSON.stringify(kinds))
  const mockOk = list.some(e => (e.type === 'a2a.message' || e.type === 'agent.delta') && /mock/i.test(JSON.stringify(e)))
  ok('worker(mock) 回复可见', mockOk)
}

// 7) controller 计数字段核对(信息性)
const ctrl = (await api('/api/workshop/daq', {}, adminTok)).body?.data?.controller
console.log('controller 全量计数:', JSON.stringify(ctrl))

console.log(`\n===== 补测: ${pass} 通过 / ${fail} 失败 =====`)
process.exit(fail > 0 ? 1 : 0)
