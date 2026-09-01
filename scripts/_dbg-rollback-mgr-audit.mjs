/**
 * 调控闭环 M1/M2 审计:RecipeRollBackManager + Repo + 设定历史在册 + 窗口归属 + 判定/回退/护栏。
 * 全 REST 真链路;对齐 _dbg-dcw-audit 风格。用法:AW_PAGE_TOKEN=<token> node scripts/_dbg-rollback-mgr-audit.mjs
 */
const BASE = process.env.AW_PAGE_BASE ?? 'http://127.0.0.1:3000'
const TOKEN = process.env.AW_PAGE_TOKEN ?? ''
const H = { 'authorization': `Bearer ${process.env.ADMIN_TOKEN ?? TOKEN}`, 'content-type': 'application/json' }
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
  if (!r.ok || j.code !== 0) console.log(`  [debug] POST ${p} → ${r.status} ${JSON.stringify(j).slice(0, 200)}`)
  return j
}
const jpatch = (p, b) => fetch(`${BASE}/api/workshop/dcw${p}`, { method: 'PATCH', headers: H, body: JSON.stringify(b ?? {}) }).then(r => r.json())
const inv = async (agentId, tool, args) => {
  const r = await fetch(`${BASE}/api/workshop/agent-tools/invoke`, { method: 'POST', headers: H, body: JSON.stringify({ agentId, tool, args }) })
  const j = await r.json().catch(() => ({}))
  if (!r.ok || j.code !== 0) console.log(`  [debug] invoke ${tool} → ${r.status} ${JSON.stringify(j).slice(0, 200)}`)
  return j
}
const rand = () => Math.random().toString(36).slice(2, 7)
const AGENT1 = `rb-agent-${rand()}`
const AGENT2 = `rb-agent-${rand()}`

// ---- 0) 网关确保运行 ----
{
  const r = await fetch(`${BASE}/api/workshop/dcw`, { headers: H }).then(x => x.json())
  if (!r?.data?.controller?.running)
    await fetch(`${BASE}/api/workshop/dcw/controller?action=resume`, { method: 'POST', headers: H }).then(x => x.json())
}
const ctrl = await jget('')
ok(ctrl?.data?.controller?.running === true, '网关运行中')

// ---- 1) 造实体:产线 L + 数控节点 N1/N2 + 产品 P + 配方 R ----
const line = (await jpost('/lines', { name: `RB审计线-${rand()}` })).data.line
const n1 = (await jpost('', { templateRef: 'dcw-temp-sp', name: `RB审计-温度设定-${rand()}`, lineId: line.id })).data.node
const n2 = (await jpost('', { templateRef: 'dcw-temp-sp', name: `RB审计-压力设定-${rand()}`, lineId: line.id })).data.node
ok(!!line?.id && !!n1?.id && !!n2?.id, `实体创建(线 ${line.id} / 节点 ${n1.id},${n2.id})`)
const product = (await jpost('/products', { lineId: line.id, name: `RB审计产品-${rand()}` })).data.product
const recipe = (await jpost('/recipes', { productId: product.id, name: `RB审计配方-${rand()}`, params: [{ nodeId: n1.id, value: 175, min: 160, max: 180 }] })).data.recipe
ok(!!product?.id && !!recipe?.id, '产品/配方创建')

// ---- 2) 手动写 → 锚在册(AC1.1/1.3) ----
const w1 = await jpost(`/${n1.id}/write`, { value: 170 })
ok(w1.data?.outcome?.ok === true, `手动写 170 ACK(锚 ${w1.data?.outcome?.anchorId ?? '-'})`)
const w2 = await jpost(`/${n1.id}/write`, { value: 172 })
ok(w2.data?.outcome?.ok === true && w2.data?.outcome?.anchorId, '手动写 172 ACK + 锚')
let journal = (await jget(`/journal?nodeId=${n1.id}&limit=50`)).data.anchors
const a170 = journal.find(a => a.prevValue == null && a.newValue === 170)
const a172 = journal.find(a => a.prevValue === 170 && a.newValue === 172)
ok(!!a170 && !!a172 && a170.source === 'manual' && a172.source === 'manual', `手动写锚在册(source=manual;首写 prevValue=null)`)
// 心跳/同值 5s 内不重复记锚(AC1.2):立刻同值再写 → 锚数不变
await jpost(`/${n1.id}/write`, { value: 172 })
const journal2 = (await jget(`/journal?nodeId=${n1.id}&limit=50`)).data.anchors
ok(journal2.length === journal.length, '同值 5s 内重复写不产生新锚')

// ---- 3) 配方 apply → recipe 锚 + run.paramsSnapshot(AC1.4) ----
const applyRes = await jpost(`/recipes/${recipe.id}/apply`, {})
const run1 = applyRes.data?.run
ok(!!run1?.id && Array.isArray(run1.paramsSnapshot) && run1.paramsSnapshot[0]?.nodeId === n1.id && run1.paramsSnapshot[0]?.value === 175, 'apply 建批 + paramsSnapshot 冻结')
journal = (await jget(`/journal?nodeId=${n1.id}&limit=50`)).data.anchors
ok(journal.some(a => a.source === 'recipe' && a.newValue === 175 && a.recipeRunId === run1.id), '配方路径锚在册(source=recipe,带 runId)')

// ---- 4) Agent 路径:auto 绑定 → dcw_control 开记录(AC1.4) ----
await fetch(`${BASE}/api/workshop/agent-tools/bindings`, { method: 'POST', headers: H, body: JSON.stringify({ agentId: AGENT1, nodeId: n1.id, kind: 'dcw', mode: 'auto' }) }).then(r => r.json())
const c1 = await inv(AGENT1, 'dcw_control', { node_id: n1.id, value: 176, hypothesis: 'RB审计假设:提温 1℃ 预期张力 +2%' })
ok(/下发成功/.test(c1.data?.result?.text ?? '') && /优化记录/.test(c1.data?.result?.text ?? ''), `dcw_control 成功 + 闭环回包(${(c1.data?.result?.text ?? '').slice(0, 40)}...)`)
const recId = (c1.data?.result?.text.match(/优化记录 (opt-[0-9a-f]+)/) ?? [])[1]
ok(!!recId, `优化记录 id 回包(${recId})`)
let records = (await jget(`/optimizations?nodeId=${n1.id}`)).data.records
const rec = records.find(r => r.id === recId)
ok(rec?.status === 'open' && rec?.agentId === AGENT1 && rec?.policy === 'auto_rollback' && rec?.params[0]?.from === 175 && rec?.params[0]?.to === 176, '记录字段完整(open/agentId/policy/from→to)')
ok(rec?.hypothesis?.includes('RB审计假设'), '假设入册(hypothesis)')

// ---- 5) 窗口归属:再次设定 → 旧记录关闭 + windowAgg 异步补齐(AC1.5) ----
await sleep(1500)
const c2 = await inv(AGENT1, 'dcw_control', { node_id: n1.id, value: 177 })
const recId2 = (c2.data?.result?.text.match(/优化记录 (opt-[0-9a-f]+)/) ?? [])[1]
await sleep(2500)
records = (await jget(`/optimizations?nodeId=${n1.id}`)).data.records
const recClosed = records.find(r => r.id === recId)
ok(recClosed?.status === 'superseded' && recClosed?.closedBy === 'superseded' && !!recClosed?.closedAt, '旧记录被新设定关闭(superseded)')
ok(recClosed?.aggPending === false && Array.isArray(recClosed?.windowAgg?.channels), `windowAgg 异步回填完成(aggPending=false,通道 ${recClosed?.windowAgg?.channels?.length ?? 0})`)

// ---- 6) series 接口(AC2.6 部分) ----
const series = (await jget(`/optimizations/${recId}/series`)).data
ok(Array.isArray(series?.channels) && series.channels.length >= 0 && !!series?.record, `series 接口可用(通道 ${series?.channels?.length ?? 0})`)

// ---- 7) dcw_judge keep → lastGood(AC2.1 部分) ----
const judge = await inv(AGENT1, 'dcw_judge', { record_id: recId2, verdict: 'keep', reason: 'RB审计:窗口内张力 +2.1%,收敛达标' })
ok(/判定已入册/.test(judge.data?.result?.text ?? ''), 'dcw_judge keep 入册')
records = (await jget(`/optimizations?nodeId=${n1.id}`)).data.records
ok(records.find(r => r.id === recId2)?.status === 'judged-keep', 'keep 后记录状态 judged-keep')
// lineStart(开跑按 T4 语义重下发配方值)后:再走一轮 keep → markGood 生效(active run 才能标记)
const startRes = await jpost(`/lines/${line.id}/start`, { recipeId: recipe.id })
ok(startRes.code === 0, `产线开跑(${startRes.code})`)
const cKeep = await inv(AGENT1, 'dcw_control', { node_id: n1.id, value: 177, hypothesis: 'RB审计:二次微调' })
const recIdK = (cKeep.data?.result?.text.match(/优化记录 (opt-[0-9a-f]+)/) ?? [])[1]
const jk = await inv(AGENT1, 'dcw_judge', { record_id: recIdK, verdict: 'keep', reason: 'RB审计:开跑后复测收敛' })
console.log(`  [debug] keep-judge: ${(jk.data?.result?.text ?? '').slice(0, 90)} | recIdK=${recIdK}`)
const goodCheck = (await jget('/recipes')).data.recipes.find(r => r.id === recipe.id)
console.log(`  [debug] recipe.lastGoodRunId=${goodCheck?.lastGoodRunId}`)
const ledger = (await jget(`/${n1.id}/param-ledger`)).data.ledger
ok(ledger?.current != null && ledger?.recipeTarget != null && ledger?.lastGood != null, `参数台账三值(current=${ledger?.current},target=${ledger?.recipeTarget},lastGood=${ledger?.lastGood})`)
ok(ledger?.journal?.length > 0 && ledger?.records?.length > 0, '台账含 journal + records')

// ---- 8) judge rollback + dcw_rollback 执行 → 回退记录 + 冷却(AC2.1/2.3/2.4) ----
const c3 = await inv(AGENT1, 'dcw_control', { node_id: n1.id, value: 179 })
const recId3 = (c3.data?.result?.text.match(/优化记录 (opt-[0-9a-f]+)/) ?? [])[1]
ok(!!recId3, '第三条优化记录开出')
const jr = await inv(AGENT1, 'dcw_judge', { record_id: recId3, verdict: 'rollback', reason: 'RB审计:张力越窗,判应回退' })
ok(/判定已入册/.test(jr.data?.result?.text ?? ''), 'judge rollback 入册(不执行)')
const beforeVal = (await jget(`/${n1.id}/param-ledger`)).data.ledger.current
const rbRes = await inv(AGENT1, 'dcw_rollback', { record_id: recId3 })
ok(/回退已执行/.test(rbRes.data?.result?.text ?? ''), `dcw_rollback 执行(${(rbRes.data?.result?.text ?? '').slice(0, 50)})`)
records = (await jget(`/optimizations?nodeId=${n1.id}`)).data.records
ok(records.find(r => r.id === recId3)?.status === 'rolled-back', '原记录 rolled-back')
const rbRecord = records.find(r => r.rollbackOf === recId3)
const origFrom = records.find(r => r.id === recId3)?.params[0]?.from
ok(!!rbRecord && rbRecord.params[0]?.from === beforeVal && rbRecord.params[0]?.to === origFrom, `回退新记录在册(rollbackOf 回指,${beforeVal} → ${rbRecord?.params[0]?.to},目标=原记录基线 ${origFrom})`)
// 冷却:agent 立即同向写 → 409
const c4 = await inv(AGENT1, 'dcw_control', { node_id: n1.id, value: 179 })
ok(/冷却/.test(c4.data?.result?.text ?? ''), `冷却护栏生效(${(c4.data?.result?.text ?? '').slice(0, 60)})`)

// ---- 9) Agent 互斥(F):agent2 未判定时写同节点 → 409 ----
const bindDebug = await fetch(`${BASE}/api/workshop/agent-tools/bindings`, { method: 'POST', headers: H, body: JSON.stringify({ agentId: AGENT2, nodeId: n2.id, kind: 'dcw', mode: 'auto' }) })
console.log(`  [debug] bind AGENT2→n2: ${bindDebug.status} ${(await bindDebug.text()).slice(0, 120)}`)
const bindDebug2 = await fetch(`${BASE}/api/workshop/agent-tools/bindings`, { method: 'POST', headers: H, body: JSON.stringify({ agentId: AGENT1, nodeId: n2.id, kind: 'dcw', mode: 'auto' }) })
console.log(`  [debug] bind AGENT1→n2: ${bindDebug2.status} ${(await bindDebug2.text()).slice(0, 120)}`)
const a1n2 = await inv(AGENT1, 'dcw_control', { node_id: n2.id, value: 171 })
console.log(`  [debug] AGENT1→n2: ${(a1n2.data?.result?.text ?? '').slice(0, 100)}`)
const mutex = await inv(AGENT2, 'dcw_control', { node_id: n2.id, value: 172 })
ok(/正在优化试验中/.test(mutex.data?.result?.text ?? ''), `Agent 互斥护栏(第二 Agent 被拒:${(mutex.data?.result?.text ?? '').slice(0, 50)})`)
// 手动写不被阻塞但 supersede(AC2.4 部分)
const mw = await jpost(`/${n2.id}/write`, { value: 173 })
ok(mw.data?.outcome?.ok === true, '手动写不被互斥阻塞')
records = (await jget(`/optimizations?nodeId=${n2.id}`)).data.records
ok(records[0]?.status === 'superseded-manual', `手动写 supersede open 记录(${records[0]?.closedBy})`)

// ---- 10) Recipe 版本化(AC1.5) ----
const beforeVersion = (await jget('/recipes')).data.recipes.find(r => r.id === recipe.id).version ?? 1
await jpatch(`/recipes/${recipe.id}`, { params: [{ nodeId: n1.id, value: 176, min: 160, max: 180 }] })
const afterRecipe = (await jget('/recipes')).data.recipes.find(r => r.id === recipe.id)
ok((afterRecipe.version ?? 1) === beforeVersion + 1 && (afterRecipe.paramsHistory?.length ?? 0) > 0, `参数版本化(version ${beforeVersion}→${afterRecipe.version},history ${afterRecipe.paramsHistory?.length})`)

// ---- 11) lineStop 封窗 + mark-good/rollback-good ----
await jpost(`/lines/${line.id}/stop`, {})
records = (await jget(`/optimizations?lineId=${line.id}&status=open`)).data.records
ok(records.length === 0, 'lineStop 封窗(open 记录清零)')
await jpost(`/recipes/${recipe.id}/mark-good`, { runId: run1.id })
const goodRecipe = (await jget('/recipes')).data.recipes.find(r => r.id === recipe.id)
ok(goodRecipe?.lastGoodRunId === run1.id, 'mark-good 标记良好批次')
await jpost(`/lines/${line.id}/start`, { recipeId: recipe.id })
const rg = await jpost(`/recipes/${recipe.id}/rollback-good`, {})
const rgOut = rg.data?.outcomes ?? []
ok(rgOut.length > 0 && rgOut.every(o => o.ok), `基准恢复执行(${rgOut.length} 参数全 ACK)`)

// ---- 12) 清场(非破坏:停线;节点删除走 purge 既有级联) ----
await jpost(`/lines/${line.id}/stop`, {})
console.log(`\n=== 结果:${pass} PASS / ${fail} FAIL ===`)
process.exit(fail > 0 ? 1 : 0)
