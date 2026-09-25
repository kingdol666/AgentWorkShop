/**
 * 临时验收:daq_query 默认作用域 = 当前活动批次(配方)
 *
 * 步骤:停线 → 用配方 A 开跑 35s → 停线 → 用配方 B 开跑 35s
 *      (同一时间窗内因此存在 A、B 两轮配方的带标样本)
 * 断言(直调工具桥,零 LLM token):
 *  · 不传过滤            → 只返回当前活动配方 B 的样本(与显式 recipe_id=B 一致)
 *  · 结果头/文末必须打印生效口径(活动批次 run + 配方)
 *  · scope='all'         → 返回窗口内全部样本(A+B,点数更多)
 *  · 显式 recipe_id=A    → 仍按显式值过滤(不被默认覆盖)
 *  · 显式 run_id=<B run> → 批次级精确过滤
 * 用法:AW_BASE=http://127.0.0.1:3300 AW_LINE=ln-f1b1c060 node scripts/_probe-daq-scope-default.mjs
 */
const BASE = process.env.AW_BASE ?? 'http://127.0.0.1:3300'
const LINE = process.env.AW_LINE ?? 'ln-f1b1c060'

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

const dcwSnap = async () => (await j('GET', '/api/workshop/dcw', undefined, token)).data
const stopLine = async () => {
  const r = await j('POST', `/api/workshop/dcw/lines/${LINE}/stop`, {}, token)
  console.log(`  停线: status=${r.status} ${r.code ?? ''} ${r.message ?? 'ok'}`)
  await sleep(2000)
}
const startLine = async (recipeId) => {
  const r = await j('POST', `/api/workshop/dcw/lines/${LINE}/start`, { recipeId }, token)
  console.log(`  开跑 ${recipeId}: status=${r.status} ${r.code ?? ''} ${r.message ?? 'ok'}`)
  return r
}

const snap0 = await dcwSnap()
const recipes = snap0.recipes.filter(r => r.lineId === LINE)
if (recipes.length < 2) {
  console.error(`该线配方不足 2 个(${recipes.length}),无法演示换配方`)
  process.exit(1)
}
const A = recipes[0]
const B = recipes[recipes.length - 1]
console.log(`配方 A=${A.id} / B=${B.id}`)

const windowFrom = Date.now()
console.log('\n[1] 配方 A 运行窗口')
await stopLine()
await startLine(A.id)
await sleep(35_000)
console.log('\n[2] 配方 B 运行窗口(换配方)')
await stopLine()
await startLine(B.id)
await sleep(35_000)

// ── agent + 绑定 ──
const daq = (await j('GET', '/api/workshop/daq', undefined, token)).data
const all = daq.nodes.filter(n => n.lineId === LINE)
const node = all.find(n => /melt-temp|part-weight/i.test(n.name)) ?? all[0]
const ch = await j('POST', '/api/workshop/channels', { name: `DAQ默认作用域-${Date.now().toString(36).slice(-4)}`, leadAgent: { name: 'scope-lead', harness: 'mock', config: { delayMs: 50 } } }, token)
const channelId = ch.data.channelId
const tpl = await j('POST', '/api/workshop/agents', { name: `scope-agent-${Date.now().toString(36).slice(-4)}`, harness: 'omp', config: {} }, token)
const agentId = (await j('POST', `/api/workshop/channels/${channelId}/agents`, { agentId: tpl.data.id, role: 'worker' }, token)).data.id
await j('POST', '/api/workshop/agent-tools/bindings', { agentId, nodeId: node.id, kind: 'daq', mode: 'auto' }, token)
const invoke = async (args) => {
  // 窗口取"最近 8 分钟"(而非探针启动时刻):足以同时覆盖 A、B 两轮配方的样本,
  // 且不受"新批次刚开跑、首个 30s 桶尚未刷盘"的影响
  const r = await j('POST', '/api/workshop/agent-tools/invoke', { agentId, tool: 'daq_query', args: { node_id: node.id, from_ms: Date.now() - 8 * 60_000, to_ms: Date.now(), bucket_ms: 30_000, limit: 400, ...args } }, token)
  return r.data?.result?.text ?? JSON.stringify(r).slice(0, 200)
}
const pts = (t) => {
  const m = t.match(/样本 (\d+) 点/)
  return m ? Number(m[1]) : (t.includes('窗口内无数据') ? 0 : -1)
}

console.log(`\n节点=${node.name}(${node.id})  时间窗起=${new Date(windowFrom).toISOString().slice(11, 19)}`)

const byDefault = await invoke({})
const activeRecipe = (byDefault.match(/\((rc-[a-z0-9]+)\)/) ?? [])[1] ?? ''
const activeRun = (byDefault.match(/run=([a-z0-9-]+)/) ?? [])[1] ?? ''
const other = [A.id, B.id].find(id => id !== activeRecipe) ?? A.id
const byActive = await invoke({ recipe_id: activeRecipe })
const allScope = await invoke({ scope: 'all' })
const explicitOther = await invoke({ recipe_id: other })
const explicitRun = await invoke({ run_id: activeRun })

console.log('\n── 默认(不传过滤)──\n' + byDefault.slice(0, 620))
console.log('\n── scope=all ──\n' + allScope.slice(0, 380))
console.log('\n── 显式另一配方 ──\n' + explicitOther.slice(0, 320))

let pass = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (ok) pass += 1
}
check('默认口径 = 当前活动配方(头部打印 run/配方)', activeRecipe === B.id && activeRun.startsWith('rr-'), `recipe=${activeRecipe} run=${activeRun}`)
// 默认作用域是**批次级**(活动 run),比"仅配方"更紧:同一配方多次开跑时只取当前这一次。
// 因此与显式 run_id 逐点一致;与显式 recipe_id(该配方在窗口内的全部批次)则应为子集。
check('默认 = 当前活动批次(与显式 run_id 一致)',
  pts(byDefault) > 0 && pts(byDefault) === pts(explicitRun),
  `默认=${pts(byDefault)} 显式run=${pts(explicitRun)}`)
check('默认是"仅配方"口径的子集(同配方历史批次被排除)',
  pts(byDefault) <= pts(byActive), `默认(批次)=${pts(byDefault)} 仅配方=${pts(byActive)}`)
check('默认排除了上一轮配方(点数 < scope=all)', pts(byDefault) < pts(allScope), `默认=${pts(byDefault)} all=${pts(allScope)}`)
check('scope=all 返回窗口内全部样本(含两轮配方)', pts(allScope) > pts(byDefault) && pts(allScope) > 0, `all=${pts(allScope)}`)
check('显式 recipe_id=另一配方 不被默认覆盖', explicitOther.includes(other) || pts(explicitOther) >= 0, `另一配方点数=${pts(explicitOther)}`)
check('显式 run_id=活动批次 精确过滤生效', pts(explicitRun) > 0 && explicitRun.includes(activeRun), `run点数=${pts(explicitRun)}`)
check('文末声明默认作用域与跨配方入口', /默认作用域:仅当前活动批次/.test(byDefault) && /scope=all/.test(byDefault))

// ── 回归:停线后不再限定批次(保持原有语义,历史数据照样可查) ──
await stopLine()
const afterStop = await invoke({})
const afterStopAll = await invoke({ scope: 'all' })
check('停线后不做过滤(未开跑 → 无活动批次可限定,历史样本照样可查)',
  /未过滤\(该产线当前未开跑/.test(afterStop) && Math.abs(pts(afterStop) - pts(afterStopAll)) <= 1,
  `停线后=${pts(afterStop)} all=${pts(afterStopAll)} · ${(afterStop.split('\n').find(l => /未过滤|当前活动批次|全量/.test(l)) ?? '').trim()}`)

console.log(`\n★ 结果: ${pass}/7 断言通过`)
console.log(`频道=${channelId} agent=${agentId} 节点=${node.id}(现场保留,便于复验)`)
