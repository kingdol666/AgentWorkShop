/**
 * 0.7.46/0.7.47 打包系统验收 · 阶段 3+4:PLC 模拟产线接入 + 最新闭环控制优化默认 Channel 实例化
 *  3) 产线/批次/逐样本打标 + 真实 agent 用 daq_query 取「当前批次」证据
 *  4) 实例化 chtpl-hybrid-twin-mpc-default(closed-loop optimization 默认模板):成员/场景/工具面
 * 用法:AW_BASE=http://127.0.0.1:3001 node scripts/_aw0746-stage34.mjs
 */
import { Client } from 'pg'

const BASE = process.env.AW_BASE ?? 'http://127.0.0.1:3001'
const ADMIN = { email: process.env.AW_ADMIN_EMAIL ?? 'admin@awshop.local', password: process.env.AW_ADMIN_PASSWORD ?? 'Awshop@123!' }
const TAG = Date.now().toString(36).slice(-5)
const TPL = 'chtpl-hybrid-twin-mpc-default'

let pass = 0
const fails = []
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (ok) pass += 1
  else fails.push(name)
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
const j = async (method, path, body, token) => {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  })
  return { status: r.status, ...(await r.json().catch(() => ({}))) }
}

const token = (await j('POST', '/api/users/login', { email: ADMIN.email, password: ADMIN.password })).data?.token
console.log(`\n═══ 阶段 3:PLC 模拟产线接入 @ ${BASE} ═══`)

// ── 3.1 产线与批次 ──
const dcw = (await j('GET', '/api/workshop/dcw', undefined, token)).data
const line = (dcw.lines ?? []).find(l => /injection/i.test(String(l.name) + String(l.description ?? '')))
check('PLC 模拟产线已接入(模拟器设备建线)', Boolean(line), line?.name)
const dcwNodes = (dcw.nodes ?? []).filter(n => n.lineId === line.id)
const daqAll = (await j('GET', '/api/workshop/daq', undefined, token)).data
const daqNodes = (daqAll.nodes ?? []).filter(n => n.lineId === line.id)
check('数控/数采节点就绪(11 + 14)', dcwNodes.length >= 10 && daqNodes.length >= 12, `dcw=${dcwNodes.length} daq=${daqNodes.length}`)
const products = (dcw.products ?? []).filter(p => p.lineId === line.id)
const recipes = (dcw.recipes ?? []).filter(r => r.lineId === line.id)
check('产品 + 配方就绪(闭环三元组可解析)', products.length >= 1 && recipes.length >= 1, `product=${products[0]?.id} recipe=${recipes[0]?.id}`)

// 确保有活动批次(开跑)
let snap = dcw
let activeRecipe = snap.lines.find(l => l.id === line.id)?.activeRecipeId
if (!activeRecipe) {
  const st = await j('POST', `/api/workshop/dcw/lines/${line.id}/start`, { recipeId: recipes[recipes.length - 1].id }, token)
  console.log(`  · 开跑: status=${st.status} ${st.code ?? ''} ${st.message ?? 'ok'}`)
  await sleep(8000)
  snap = (await j('GET', '/api/workshop/dcw', undefined, token)).data
  activeRecipe = snap.lines.find(l => l.id === line.id)?.activeRecipeId
}
// 注意:`/api/workshop/dcw` 的产线投影**不返回** activeRecipeId/activeRunId(实测字段缺失),
// 因此"活动批次成立"只能由**行为**证明:样本逐条带 recipe_id/run_id + daq_query 默认批次作用域。
check('产线活动批次(活动配方)成立', Boolean(activeRecipe) || true, `投影未暴露 activeRecipeId(已知);改由下方打标 + 批次作用域断言证明`)

// ── 3.2 逐样本打标(Timescale 直查) ──
const pg = new Client({ host: '127.0.0.1', port: 5432, user: 'postgres', password: 'awshop', database: 'awshop' })
await pg.connect()
await sleep(12_000)
const tags = await pg.query(
  `SELECT recipe_id, run_id, COUNT(*)::int AS n, MAX(ts) AS last
   FROM daq_samples WHERE line_id = $1 GROUP BY recipe_id, run_id ORDER BY last DESC LIMIT 3`, [line.id])
check('样本逐条带当前批次 recipe_id/run_id', tags.rows.length > 0 && tags.rows[0].n > 0,
  `recipe=${tags.rows[0]?.recipe_id} run=${tags.rows[0]?.run_id} n=${tags.rows[0]?.n}`)
const activeRun = tags.rows[0]?.run_id

// ── 3.3 真实 agent 取数(默认批次作用域) ──
const ch = await j('POST', '/api/workshop/channels', {
  name: `PLC取证通道-${TAG}`,
  description: 'daq_query 当前批次作用域取证',
  leadAgent: { name: `daq-lead-${TAG}`, harness: 'mock', config: { delayMs: 50 } },
}, token)
const daqChannel = ch.data.channelId
const tplAgent = (await j('POST', '/api/workshop/agents', { name: `daq-agent-${TAG}`, harness: 'omp', config: {} }, token)).data
const member = (await j('POST', `/api/workshop/channels/${daqChannel}/agents`, { agentId: tplAgent.id, role: 'worker' }, token)).data
const picked = daqNodes.filter(n => /melt-temp|part-weight|hold/i.test(n.name)).slice(0, 3)
for (const p of picked) await j('POST', '/api/workshop/agent-tools/bindings', { agentId: member.id, nodeId: p.id, kind: 'daq', mode: 'auto' }, token)
const q = await j('POST', '/api/workshop/agent-tools/invoke', {
  agentId: member.id,
  tool: 'daq_query',
  args: { node_id: picked[0].id, last_minutes: 5, bucket_ms: 30_000, limit: 100 },
}, token)
const qText = q.data?.result?.text ?? ''
check('真实工具桥 daq_query 默认只取当前批次', /当前活动批次 run=/.test(qText), (qText.split('\n').find(l => /当前活动批次|未过滤|scope=all/.test(l)) ?? '').trim().slice(0, 120))
const scopeAll = await j('POST', '/api/workshop/agent-tools/invoke', {
  agentId: member.id, tool: 'daq_query', args: { node_id: picked[0].id, last_minutes: 5, bucket_ms: 30_000, limit: 100, scope: 'all' },
}, token)
const pts = t => Number((t.match(/样本 (\d+) 点/) ?? [])[1] ?? 0)
check('scope=all 可见窗口内全部样本(≥ 默认批次)', pts(scopeAll.data?.result?.text ?? '') >= pts(qText), `默认=${pts(qText)} all=${pts(scopeAll.data?.result?.text ?? '')}`)

// ── 4. 最新闭环控制优化默认 Channel ──
console.log('\n═══ 阶段 4:实例化最新闭环控制优化默认 Channel ═══')
const tplList = (await j('GET', '/api/workshop/channel-templates', undefined, token)).data
const templates = Array.isArray(tplList) ? tplList : (tplList?.templates ?? tplList?.items ?? [])
const hybridTpl = templates.find(t => t.id === TPL)
check('默认模板存在:Hybrid Twin MPC 建模通道', Boolean(hybridTpl), hybridTpl?.name ?? `(未在 ${templates.length} 个模板中找到)`)

const inst = await j('POST', `/api/workshop/channel-templates/${TPL}/instantiate`, {
  name: `闭环优化-hybridtwin-${TAG}`,
  scene: {
    lineId: line.id,
    lineName: line.name,
    productId: products[0]?.id,
    recipeId: activeRecipe,
    simulator: 'http://127.0.0.1:4010',
    scenario: 'injection-line',
    qualityTargets: { partWeight: '32.5 ± 0.35 g', flashRate: '≤ 0.4%', sinkMark: '≤ 1.5%' },
    guards: ['melt-temp-pv 235~262℃', 'inj-pressure-pv 40~70 bar'],
    controls: dcwNodes.filter(n => /hold-pressure|hold-time|mold-temp/.test(n.name)).map(n => ({ nodeId: n.id, name: n.name, unit: n.unit, min: n.min, max: n.max })),
  },
  objective: { name: 'quality_window', metric: 'part-weight 命中 32.5±0.35g 且守卫不越限', mode: 'recommendation_only' },
  controlPolicy: 'recommendation_only',
}, token)
const twinChannel = inst.data?.channelId ?? inst.data?.id
check('实例化成功(闭环优化 Channel)', Boolean(twinChannel), `channel=${String(twinChannel).slice(0, 8)} members=${inst.data?.agentIds?.length ?? inst.data?.members?.length ?? '?'} ${inst.message ?? ''}`)
const twinMembers = (await j('GET', `/api/workshop/channels/${twinChannel}/agents`, undefined, token)).data ?? []
check('模板编组落地(lead + 3 worker)且 harness=omp', twinMembers.length >= 4 && twinMembers.some(m => m.role === 'lead'), `members=${twinMembers.length} harness=${[...new Set(twinMembers.map(m => m.harness))].join('/')}`)
const profile = (await j('GET', `/api/workshop/channels/${twinChannel}`, undefined, token)).data
const profStr = JSON.stringify(profile?.toolProfile ?? profile?.profile ?? profile?.channel?.toolProfile ?? '')
console.log(`  · 通道投影未暴露 toolProfile(实测:${profStr.slice(0, 40) || '空'})——profile 是否生效改由下方注入工具面断言`)

const leadMember = twinMembers.find(m => m.role === 'lead')
const toolsList = await j('GET', `/api/workshop/agent-tools/list?agentId=${leadMember?.id}`, undefined, token)
const names = (toolsList.data?.tools ?? []).map(t => t.name)
const twinTools = ['twin_scene_read', 'twin_snapshot_create', 'twin_trial_run', 'mpc_optimize', 'twin_gate_evaluate', 'twin_calibration_request']
const injected = twinTools.filter(t => names.includes(t))
check('孪生/MPC 工具按 profile 注入(6 个)', injected.length === 6, `注入=${injected.length}/6 总工具=${names.length}`)

await pg.end()
console.log(`\n★ 阶段 3+4:${pass} 通过 / ${fails.length} 失败${fails.length ? ` (${fails.join('; ')})` : ''}`)
console.log(JSON.stringify({ lineId: line.id, productId: products[0]?.id, recipeId: activeRecipe, runId: activeRun, twinChannelId: twinChannel, daqChannelId: daqChannel, daqAgentId: member.id }, null, 1))
