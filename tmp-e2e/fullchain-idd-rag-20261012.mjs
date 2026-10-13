#!/usr/bin/env node
/**
 * tmp-e2e/fullchain-idd-rag-20261012.mjs —— 全链路真实场景验收(在 3001 生产实例上):
 *   PLC 模拟(cast-film-physics) → 建线(3 SV + 3 PV) → 优化作业频道(通用闭环优化模板+KB 开关)
 *   → 数采自动抓取 → 阶跃激励 → 导出 → IDD 诊断(R1) → 经验入库(RAG) → 检索命中
 *   → 检索既往结论定口径 → 续采新工况 → IDD 诊断(R2,引用 R1) → 入库 → 检索命中
 *   → 频道在线分析(数据分析师 daq_query) → 优化闭环(recipe_propose → HITL 批准 → 设备证实)。
 *
 * 前置:3001 平台(0.7.58);IDD 3210/8764;rag 8770/6789;token 落 .idd-token.tmp/.kb-token.tmp;
 *       admin 账号 admin@awshop.local 已注册。
 * 用法:node tmp-e2e/fullchain-idd-rag-20261012.mjs [--keep]
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BASE = 'http://127.0.0.1:3001'
const SIM_PORT = 4019
const SIM = `http://127.0.0.1:${SIM_PORT}`
const SIM_DIR = resolve(REPO, '..', 'plc-node-simulator-bench-4019')
const IDD_BASE = 'http://127.0.0.1:3210'
const KB_BASE = 'http://127.0.0.1:8770'
const KB_WEB = 'http://127.0.0.1:6789'
const IDD_TOKEN = readFileSync(join(REPO, '.idd-token.tmp'), 'utf8').trim()
const KB_TOKEN = readFileSync(join(REPO, '.kb-token.tmp'), 'utf8').trim()
const OUT_DIR = join(REPO, '.AgentWorkShop', 'analysis', 'fullchain-20261012')
// 本机 7890 代理会拦 localhost,进程级豁免
process.env.NO_PROXY = '127.0.0.1,localhost'
process.env.HTTP_PROXY = ''
process.env.HTTPS_PROXY = ''

let pass = 0
const fails = []
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✔ ${name}`) }
  else { fails.push(name); console.log(`  ✖ ${name}${detail ? ` — ${String(detail).slice(0, 220)}` : ''}`) }
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
const getJson = async (url, token) => {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(20000), headers: token ? { authorization: `Bearer ${token}` } : {} })
    return await r.json()
  }
  catch { return null }
}
const api = async (method, path, body, token) => {
  try {
    const r = await fetch(BASE + path, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    })
    return { status: r.status, ...(await r.json().catch(() => ({}))) }
  }
  catch (e) { return { status: 0, message: e.message } }
}
/** Agent 工具桥直调(返回 { text, isError }) */
const inv = async (agentId, tool, args, timeoutMs = 400_000) => {
  const res = await fetch(BASE + '/api/workshop/agent-tools/invoke', {
    method: 'POST', headers: { 'content-type': 'application/json', 'authorization': `Bearer ${TOKEN}` },
    body: JSON.stringify({ agentId, tool, args }), signal: AbortSignal.timeout(timeoutMs),
  })
  const j = await res.json().catch(() => ({}))
  return j?.data?.result ?? { text: JSON.stringify(j?.data ?? j).slice(0, 200), isError: j?.code !== 0 }
}

/* ═══ P0 平台健康门 ═══ */
console.log('\n[P0] 平台健康门')
const health = await getJson(`${BASE}/api/health`)
ok('平台 3001 健康(0.7.58)', health?.data?.status === 'ok' && String(health?.data?.version).startsWith('0.7.5'), `v=${health?.data?.version}`)
const login = await api('POST', '/api/users/login', { email: 'admin@awshop.local', password: 'Admin@2026Closed' })
const TOKEN = login?.data?.token ?? ''
ok('admin 登录', !!TOKEN, login?.message ?? '')
const bridgeH = await getJson(`${BASE}/api/plugins/diag-bridge/health`, TOKEN)
ok('IDD 插件桥(token 接受+远端 ok)', bridgeH?.token?.accepted === true && bridgeH?.remote?.status === 'ok', JSON.stringify(bridgeH?.remote ?? {}).slice(0, 100))
const ragH = await getJson(`${BASE}/api/plugins/rag-bridge/health`, TOKEN)
ok('RAG 插件桥(token 接受+后端 ok)', ragH?.token?.accepted === true && ragH?.backend?.ok === true, `kb=${ragH?.kb?.name}`)

/* ═══ P1 PLC 模拟器 ═══ */
console.log('\n[P1] PLC 模拟器(4019, cast-film-physics)')
{
  const psi = spawnSync('powershell', ['-NoProfile', '-Command',
    `Get-NetTCPConnection -LocalPort ${SIM_PORT} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess`], { encoding: 'utf8' })
  const pid = Number(psi.stdout.trim())
  if (Number.isInteger(pid) && pid > 0) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
  await sleep(1500)
  process.env.SIM_BASE = SIM
  process.env.SIM_SHADOW_DIR = SIM_DIR
  const { ensureSimulator, applyPreset } = await import('../bench/lib/sim.mjs')
  await ensureSimulator({ log: () => {} })
  await applyPreset('cast-film-physics')
}
const simState = await getJson(`${SIM}/api/plant/state`)
ok('模拟器运行中(cast-film-physics)', simState?.data?.running === true, JSON.stringify(simState?.data ?? {}).slice(0, 100))
const simDevices = (await getJson(`${SIM}/api/nodes`))?.data ?? []
ok('模拟器节点在册', Array.isArray(simDevices) && simDevices.length > 0, `nodes=${simDevices.length}`)

/* ═══ MCP 通道 ═══ */
console.log('\n[MCP] 启动 stdio MCP(39 工具)')
const mcp = spawn(process.execPath, [join(REPO, 'mcp', 'aw-mcp-server.mjs')], {
  cwd: REPO,
  env: { ...process.env, NO_PROXY: '127.0.0.1,localhost', HTTP_PROXY: '', HTTPS_PROXY: '', AW_TOKEN: TOKEN },
  stdio: ['pipe', 'pipe', 'pipe'],
})
const rl = createInterface({ input: mcp.stdout })
const pending = new Map(); let nextId = 1
rl.on('line', (line) => {
  try { const m = JSON.parse(line); if (m?.id != null && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
  catch { /* 跳过非 JSON 行 */ }
})
const call = async (name, args = {}, timeoutMs = 120_000) => {
  const res = await new Promise((res2, rej2) => {
    const id = nextId++
    const t = setTimeout(() => { pending.delete(id); rej2(new Error(`rpc 超时: ${name}`)) }, timeoutMs)
    pending.set(id, (m) => { clearTimeout(t); res2(m) })
    mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })}\n`)
  })
  const text = res?.result?.content?.[0]?.text ?? ''
  return { isError: Boolean(res?.result?.isError), text, data: (() => {
    try { return JSON.parse(text) }
    catch { return null }
  })() }
}

/* ═══ P2 建线(3 SV + 3 PV)+ 配方 + 开跑 + 数采自启 ═══ */
console.log('\n[P2] 建线 + 数采自动抓取')
const line = await call('aw_line_create', { name: `流延膜全链验收线-${Date.now().toString(36)}` })
const lineId = line.data?.line?.id ?? line.data?.id
ok('产线创建', !!lineId, line.text.slice(0, 120))
const product = await call('aw_product_create', { lineId, name: '流延膜全链验收产品' })
const productId = product.data?.product?.id ?? product.data?.id
ok('产品创建', !!productId, product.text.slice(0, 100))

const dcw = {}, daq = {}
const wantAct = [
  { id: 'zone1-sp', col: 'zone1_sp', unit: '℃', sem: 'SV 设定点:一区加热温度,影响熔体温度进而影响膜厚' },
  { id: 'linespeed-sp', col: 'linespeed_sp', unit: 'm/min', sem: 'SV 设定点:产线速度,升速减薄、降速增厚' },
  { id: 'diegap-sp', col: 'diegap_sp', unit: 'mm', sem: 'SV 设定点:模口间隙,间隙增大膜厚近似线性增厚' },
]
const wantSen = [
  { id: 'melt-temp', col: 'melt_temp', unit: '℃', sem: 'PV 实时检测:熔体温度,跟随加热 SV 滞后 1-2 分钟' },
  { id: 'melt-pressure', col: 'melt_pressure', unit: 'MPa', sem: 'PV 实时检测:熔体压力,反映泵送与滤网状态' },
  { id: 'film-thickness', col: 'film_thickness', unit: 'μm', sem: 'PV 实时检测:流延膜厚度(核心质量指标,优化目标 goal),随线速/模口滞后波动' },
]
for (const dev of simDevices) {
  const exp = (await getJson(`${SIM}/api/nodes/${dev.id}/export`))?.data?.items ?? []
  const sigOf = id => (dev.signals ?? []).find(s => s.id === id)
  for (const w of wantAct) {
    const sig = sigOf(w.id); if (!sig || dcw[w.id]) continue
    const item = exp.find(i => i.signal === sig.name); if (!item?.driverConfig) continue
    const r = await call('aw_dcw_create', { name: `验收-${sig.name}`, templateRef: 'dcw-temp-sp', driver: dev.protocol, driverConfig: item.driverConfig, unit: sig.unit, min: sig.min, max: sig.max, decimals: sig.decimals ?? 2, lineId, holdIntervalMs: 0, stepLimit: 5, semantics: w.sem })
    dcw[w.id] = r.data?.node?.id ?? r.data?.id
  }
  for (const w of wantSen) {
    const sig = sigOf(w.id); if (!sig || daq[w.id]) continue
    const item = exp.find(i => i.signal === sig.name); if (!item?.driverConfig) continue
    const r = await call('aw_daq_create', { name: `验收-${sig.name}`, templateRef: 'daq-temp-tc', driver: dev.protocol, driverConfig: item.driverConfig, unit: sig.unit, min: sig.min, max: sig.max, decimals: sig.decimals ?? 2, lineId, intervalMs: 1000, semantics: w.sem })
    daq[w.id] = r.data?.node?.id ?? r.data?.id
  }
}
ok('建节点 3 SV(DCW)+ 3 PV(DAQ)', wantAct.every(w => dcw[w.id]) && wantSen.every(w => daq[w.id]),
  `dcw=${Object.keys(dcw).length} daq=${Object.keys(daq).length}`)

const recipe = await call('aw_recipe_create', {
  productId, name: '全链验收基线配方', description: '流延膜全链验收基线(zone 200℃ / 线速 95 / 模口 1.0)',
  params: [
    { nodeId: dcw['zone1-sp'], value: 200, min: 190, max: 225 },
    { nodeId: dcw['linespeed-sp'], value: 95, min: 85, max: 110 },
    { nodeId: dcw['diegap-sp'], value: 1.0, min: 0.85, max: 1.15 },
  ],
})
const recipeId = recipe.data?.recipe?.id ?? recipe.data?.id
ok('基线配方创建(3 参数)', !!recipeId, recipe.text.slice(0, 120))
const ctl = await call('aw_daq_controller', { action: 'start' })
ok('数采控制器启动(自动抓取)', !ctl.isError, ctl.text.slice(0, 100))
const lineStart = await call('aw_line_start', { lineId, recipeId })
ok('产线开跑(配方生效)', !lineStart.isError, lineStart.text.slice(0, 100))
const lineStartAt = Date.now()

/* ═══ P3 优化作业频道(通用闭环优化模板 + KB 开关 + 绑线) ═══ */
console.log('\n[P3] 优化作业频道')
const chName = `流延膜优化频道-${Date.now().toString(36)}`
const inst = await api('POST', '/api/workshop/channel-templates/chtpl-generic-optimize-default/instantiate',
  { name: chName, bindLineId: lineId, enableKnowledgeBase: true }, TOKEN)
const channelId = inst?.data?.channelId ?? inst?.data?.channel?.id ?? ''
ok('频道实例化(generic-optimize,KB 开,绑线)', !!channelId, JSON.stringify(inst?.data ?? inst?.message ?? {}).slice(0, 140))
// lead 身份在实例化后异步装配,轮询等待(最长 30s);注意列表 data 可能直接是数组
const chListOf = async () => {
  const d = (await api('GET', '/api/workshop/channels', undefined, TOKEN))?.data
  return d?.items ?? (Array.isArray(d) ? d : [])
}
let leadId = inst?.data?.leadAgentId ?? ''
for (let i = 0; i < 15 && !leadId; i++) {
  await sleep(2000)
  leadId = (await chListOf()).find(c => c.id === channelId)?.leadAgentId ?? ''
}
ok('lead 身份可读', !!leadId, `lead=${String(leadId).slice(0, 10)}`)
let members = []
for (let i = 0; i < 10; i++) {
  const membersRaw = (await api('GET', `/api/workshop/channels/${channelId}/agents`, undefined, TOKEN))?.data
  members = membersRaw?.items ?? (Array.isArray(membersRaw) ? membersRaw : membersRaw?.agents ?? [])
  if (members.length >= 4) break
  await sleep(2000)
}
ok('四成员编成在册(lead+3 worker)', members.length >= 4, `members=${members.length}: ${members.map(m => m.name).join('/')}`)
const byName = n => members.find(m => String(m.name).includes(n))?.agentId ?? members.find(m => String(m.name).includes(n))?.id ?? ''
const analystId = byName('数据分析师')
const kbEngId = byName('知识调优工程师')
const procEngId = byName('工艺工程师')

let bindOk = 0; const bindErrs = []
// 权限 v2:DCW 节点不直接绑定 —— 写走 recipe(kind='recipe')操作面;DAQ 只读面按节点绑
for (const [nodeId, kind] of [[recipeId, 'recipe'], ...Object.values(daq).map(id => [id, 'daq'])]) {
  const g = await api('POST', '/api/workshop/agent-tools/bindings', { agentId: leadId, nodeId, kind, mode: 'manual' }, TOKEN)
  if (g?.code === 0 || g?.status === 200) bindOk += 1
  else bindErrs.push(`${kind}:${String(nodeId).slice(0, 8)} ${g?.message ?? g?.code}`)
}
ok('lead 绑定(recipe + 3 DAQ, v2 面)', bindOk === 4, bindOk === 4 ? '4/4' : bindErrs.join(' | ').slice(0, 160))
const grantProc = await api('POST', '/api/workshop/agent-tools/bindings/grant', { channelId, agentId: procEngId, nodeIds: [recipeId, ...Object.values(daq)], mode: 'manual' }, TOKEN)
const grantAnalyst = await api('POST', '/api/workshop/agent-tools/bindings/grant', { channelId, agentId: analystId, nodeIds: Object.values(daq), mode: 'manual' }, TOKEN)
ok('lead→工艺工程师/数据分析师 委托', (grantProc?.code === 0) && (grantAnalyst?.code === 0), `${grantProc?.code}/${grantAnalyst?.code}`)
const act = await api('POST', `/api/workshop/channels/${channelId}/activate`, {}, TOKEN)
ok('频道激活', act?.code === 0 || act?.status === 200, act?.message ?? '')

/* ═══ P4 数采自动抓取验证 ═══ */
console.log('\n[P4] 数采自动抓取(等 75s 验证样本流)')
await sleep(75_000)
let sampleOk = 0
for (const w of wantSen) {
  const s = await call('aw_daq_samples', { id: daq[w.id], fromMs: lineStartAt, toMs: Date.now(), bucketMs: 5000, limit: 200 })
  const n = s.data?.points?.length ?? 0
  if (n > 0) sampleOk++
  console.log(`    ↳ ${w.col}: ${n} pts`)
}
ok('3 路 PV 全部有自动样本', sampleOk === 3, `${sampleOk}/3`)

/* ═══ P5 阶跃激励(真实工况扰动) ═══ */
console.log('\n[P5] 3 次阶跃激励(间隔 70s)')
const EXCITE = [
  { key: 'linespeed-sp', v: 97 },
  { key: 'diegap-sp', v: 1.03 },
  { key: 'linespeed-sp', v: 93 },
]
for (const [i, ex] of EXCITE.entries()) {
  await sleep(70_000)
  const w = await call('aw_dcw_write', { id: dcw[ex.key], value: ex.v })
  console.log(`  ↳ 阶跃${i + 1} ${ex.key} ← ${ex.v} ${w.isError ? '✘ ' + w.text.slice(0, 80) : '√'}`)
  if (w.isError) fails.push(`阶跃${i + 1} 写入`)
  else pass++
}
await sleep(60_000)

/* ═══ P6 导出 R1 数据 ═══ */
console.log('\n[P6] 导出 R1 窗口数据(CSV+meta)')
mkdirSync(join(OUT_DIR, 'round-1'), { recursive: true })
const NODE_META = [
  ...wantAct.map(w => ({ nodeId: dcw[w.id], column: w.col, role: 'SV', unit: w.unit, meaning: w.sem })),
  ...wantSen.map(w => ({ nodeId: daq[w.id], column: w.col, role: 'PV', unit: w.unit, meaning: w.sem })),
]
const r1To = Date.now(); const r1From = r1To - 8 * 60_000
let r1Rows = 0
{
  const series = []
  for (const m of NODE_META.filter(m => m.role === 'PV')) {
    const r = await call('aw_daq_samples', { id: m.nodeId, from: new Date(r1From).toISOString(), to: new Date(r1To).toISOString(), bucketMs: 2000, limit: 1000 })
    const pts = (r.data?.points ?? []).map(p => ({ at: Number(p.at ?? 0), v: Number(p.avg ?? p.value) })).filter(p => Number.isFinite(p.v)).sort((a, b) => a.at - b.at)
    series.push({ m, pts })
  }
  const stamps = [...new Set(series.flatMap(s => s.pts.map(p => p.at)))].sort((a, b) => a - b)
  const rows = stamps.map((t) => {
    const row = { timestamp: new Date(t).toISOString() }
    for (const { m, pts } of series) {
      const hit = pts.find(p => Math.abs(p.at - t) <= 2000)
      row[m.column] = hit ? Number(hit.v.toFixed(3)) : ''
    }
    return row
  })
  const csv = [Object.keys(rows[0] ?? { timestamp: '' }).join(','), ...rows.map(r => Object.values(r).join(','))].join('\n')
  writeFileSync(join(OUT_DIR, 'round-1', 'data.csv'), csv)
  r1Rows = rows.length
  writeFileSync(join(OUT_DIR, 'round-1', 'meta.json'), JSON.stringify({
    dataset: '流延膜全链验收 · R1(PLC 模拟产线,3 次阶跃激励)',
    scene: 'SV=设定值(DCW);PV=实时检测(DAQ)',
    window: { fromIso: new Date(r1From).toISOString(), toIso: new Date(r1To).toISOString() },
    fields: NODE_META, excitations: EXCITE.map((e, i) => ({ seq: i + 1, node: e.key, value: e.v })),
  }, null, 2))
}
ok(`R1 CSV+meta 落盘(rows=${r1Rows})`, r1Rows > 50, join(OUT_DIR, 'round-1'))

/* ═══ P7 R1 诊断(IDD,diag_run 走 lead 的 omp 工具) ═══ */
console.log('\n[P7] R1 IDD 诊断')
const r1Q = '分析本流延膜产线最近 8 分钟膜厚/熔温/熔压三路 PV 波动:工况是否稳定;膜厚波动与线速/模口三次阶跃的因果是否可见;给出结论、风险点与下一步建议'
const diag1 = await inv(leadId, 'diag_run', { line: lineId, from_ms: r1From, to_ms: r1To, question: r1Q, scene: '流延膜全链验收_diag' })
const task1 = (String(diag1.text ?? '').match(/task_id=([\w-]+)/) || [])[1] ?? ''
ok('R1 诊断提交', !diag1.isError && !!task1, String(diag1.text ?? '').slice(0, 160))
let r1Done = false; let r1Report = ''; let r1Verdict = ''
if (task1) {
  for (let i = 0; i < 90; i++) {
    await sleep(20_000)
    const d = await getJson(`${IDD_BASE}/api/diagnosis/tasks/${task1}`, IDD_TOKEN)
    const v = d?.data?.view ?? d?.data ?? {}
    if (v.status === 'completed' || v.result?.report_md_path) {
      r1Done = true
      r1Verdict = `score=${v.result?.score ?? '?'} verdict=${v.result?.verdict ?? '?'}`
      try { r1Report = readFileSync(String(v.result.report_md_path).replace(/\\/g, '/'), 'utf8') }
      catch { /* 读报告失败容错 */ }
      console.log(`  ↳ R1 完成:${r1Verdict} report=${(v.result?.report_md_path ?? '').slice(-50)}`)
      break
    }
    if (v.status === 'failed') { r1Verdict = v.result?.error ?? 'failed'; console.log(`  ✖ R1 失败:${r1Verdict}`); break }
    if (i % 4 === 0) console.log(`  ↳ (${i * 15 / 60 | 0}min) ${v.status ?? '?'}`)
  }
}
ok('R1 诊断完成且报告产出', r1Done && r1Report.length > 200, `${r1Verdict}; reportLen=${r1Report.length}`)

/* ═══ P8 R1 经验入库(RAG)+ 检索命中 ═══ */
console.log('\n[P8] R1 经验入库 + 检索')
const cat = await getJson(`${KB_WEB}/api/kb/catalog`, KB_TOKEN)
const kbId = ((cat?.knowledgeBases ?? []).find(k => k.name === 'aw-industrial') ?? {})?.kbId ?? ''
ok('KB 目录含 aw-industrial', !!kbId, `kbId=${kbId}`)
const exp1 = {
  title: '流延膜全链验收 R1 诊断报告:阶跃激励下 PV 波动分析',
  scenario: 'PLC 模拟流延膜产线:膜厚/熔温/熔压 PV 监测,线速/模口三次阶跃激励下的稳定性诊断',
  category: 'troubleshooting',
  problem: '膜厚等 PV 在阶跃激励后出现波动与漂移,需判断工况稳定性、阶跃因果可见性与异常趋势',
  solution: r1Report.slice(0, 4000) || '(报告缺失)',
  result: r1Done ? 'SUCCESS' : 'PARTIAL',
  key_lessons: [`诊断任务 ${task1 ?? '?'};CSV rows=${r1Rows}`],
  tags: ['流延膜', '膜厚', '阶跃激励', '全链验收', 'R1'],
  metrics: { source: 'IDD', task: task1 ?? '', csvRows: r1Rows },
}
const ing1 = await fetch(`${KB_BASE}/api/v1/experience/${kbId}`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'authorization': `Bearer ${KB_TOKEN}`, 'X-KB-Token': KB_TOKEN },
  body: JSON.stringify(exp1), signal: AbortSignal.timeout(60_000),
}).then(r => r.json()).catch(e => ({ err: e.message }))
const exp1Id = ing1?.id ?? ing1?.experience_id ?? ing1?.data?.id ?? ''
ok('R1 报告入库经验库', /success/i.test(JSON.stringify(ing1).slice(0, 200)) || !!exp1Id, JSON.stringify(ing1).slice(0, 140))
const searchKB = async (query) => {
  const j = await fetch(`${KB_BASE}/api/v1/experience/${kbId}/search`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'authorization': `Bearer ${KB_TOKEN}`, 'X-KB-Token': KB_TOKEN },
    body: JSON.stringify({ query, top_k: 5 }), signal: AbortSignal.timeout(60_000),
  }).then(r => r.json()).catch(e => ({ err: e.message }))
  return j?.results ?? j?.experiences ?? j?.data ?? []
}
// 检索命中(向量化索引就绪有秒级延迟,重试最多 60s)
let hit1 = []
for (let i = 0; i < 6; i++) {
  await sleep(10_000)
  hit1 = await searchKB('流延膜全链验收 R1 膜厚 阶跃 稳定性 诊断')
  if (hit1.length > 0 && JSON.stringify(hit1).includes('R1')) break
}
ok('R1 检索命中本报告', hit1.length > 0 && JSON.stringify(hit1).includes('R1'), `hits=${hit1.length}`)

/* ═══ P9 频道在线分析(数据分析师)+ 平台侧 RAG 桥检索 ═══ */
console.log('\n[P9] 频道在线分析 + 平台 RAG 桥检索')
const ls = await inv(analystId, 'line_status', {})
ok('数据分析师 line_status(产线上下文)', !ls.isError && /产线|配方|运行/.test(String(ls.text ?? '')), String(ls.text ?? '').split('\n')[0]?.slice(0, 90))
const obs = await inv(analystId, 'daq_query', { node_id: daq['film-thickness'], from_ms: r1From, to_ms: Date.now(), bucket_ms: 5000 })
ok('数据分析师 daq_query(膜厚观测)', !obs.isError && /\d/.test(String(obs.text ?? '')), String(obs.text ?? '').split('\n')[0]?.slice(0, 90))
const bridgeSearch = await fetch(`${BASE}/api/plugins/rag-bridge/search?q=${encodeURIComponent('流延膜 膜厚 波动 诊断 R1')}&top_k=3`, {
  method: 'GET', headers: { authorization: `Bearer ${TOKEN}` }, signal: AbortSignal.timeout(60_000),
}).then(r => r.json()).catch(e => ({ err: e.message }))
const bridgeBody = bridgeSearch?.data ?? bridgeSearch ?? {}
const bridgeHits = bridgeBody?.results ?? []
ok('平台 RAG 桥检索命中(rag-bridge→8770 two-stage)', Array.isArray(bridgeHits) && bridgeHits.length > 0 && JSON.stringify(bridgeHits).includes('R1'), `hits=${Array.isArray(bridgeHits) ? bridgeHits.length : JSON.stringify(bridgeSearch).slice(0, 100)}`)

/* ═══ P10 R2 续采新工况 → 检索定口径 → IDD 续诊 → 入库 → 检索 ═══ */
console.log('\n[P10] R2:检索定口径 → 新工况 → 续诊 → 入库')
// ① 检索既往结论(R1)定口径:优先命中本轮 R1 报告,退而取最相关既往经验
const r1Hits = await searchKB('流延膜全链验收 R1 膜厚 阶跃 稳定性 诊断')
const r1Own = r1Hits.find(h => /R1/.test(String(h.title ?? ''))) ?? r1Hits[0] ?? {}
const r1Top = r1Own?.solution ?? r1Own?.content ?? r1Own?.text ?? ''
const r1Digest = String(r1Top).replace(/\s+/g, ' ').slice(0, 500)
ok('R2 前置检索:取到 R1 结论摘要', r1Digest.length > 100 && /R1/.test(String(r1Own?.title ?? '')), `title=${String(r1Own?.title ?? '').slice(0, 60)} | ${r1Digest.slice(0, 90)}`)
// ② 新工况激励(第 4 次阶跃)
const ex4 = await call('aw_dcw_write', { id: dcw['diegap-sp'], value: 0.97 })
ok('R2 新工况阶跃(diegap 1.03→0.97)', !ex4.isError, ex4.text.slice(0, 100))
await sleep(120_000)
// ③ 导出 R2 窗口
mkdirSync(join(OUT_DIR, 'round-2'), { recursive: true })
const r2To = Date.now(); const r2From = r2To - 4 * 60_000
let r2Rows = 0
{
  const series = []
  for (const m of NODE_META.filter(m => m.role === 'PV')) {
    const r = await call('aw_daq_samples', { id: m.nodeId, from: new Date(r2From).toISOString(), to: new Date(r2To).toISOString(), bucketMs: 2000, limit: 600 })
    const pts = (r.data?.points ?? []).map(p => ({ at: Number(p.at ?? 0), v: Number(p.avg ?? p.value) })).filter(p => Number.isFinite(p.v)).sort((a, b) => a.at - b.at)
    series.push({ m, pts })
  }
  const stamps = [...new Set(series.flatMap(s => s.pts.map(p => p.at)))].sort((a, b) => a - b)
  const rows = stamps.map((t) => {
    const row = { timestamp: new Date(t).toISOString() }
    for (const { m, pts } of series) {
      const hit = pts.find(p => Math.abs(p.at - t) <= 2000)
      row[m.column] = hit ? Number(hit.v.toFixed(3)) : ''
    }
    return row
  })
  writeFileSync(join(OUT_DIR, 'round-2', 'data.csv'), [Object.keys(rows[0] ?? { timestamp: '' }).join(','), ...rows.map(r => Object.values(r).join(','))].join('\n'))
  r2Rows = rows.length
  writeFileSync(join(OUT_DIR, 'round-2', 'meta.json'), JSON.stringify({
    dataset: '流延膜全链验收 · R2(引用 R1 结论,模口阶跃 0.97 后复核)',
    prior_round: { task: task1, digest: r1Digest },
    window: { fromIso: new Date(r2From).toISOString(), toIso: new Date(r2To).toISOString() },
    fields: NODE_META,
  }, null, 2))
}
ok(`R2 CSV+meta 落盘(rows=${r2Rows})`, r2Rows > 30, '')
// ④ R2 诊断(问题中显式引用 R1 结论 —— 「检索并继续分析」)
const r2Q = `上一轮(R1,任务 ${task1})诊断结论要点:${r1Digest.slice(0, 300)}。请基于本窗(模口间隙 1.03→0.97 新阶跃后 4 分钟)数据复核:R1 结论是否仍成立;膜厚对新阶跃的响应方向与幅度;给出趋势研判与调整建议`
const diag2 = await inv(leadId, 'diag_run', { line: lineId, from_ms: r2From, to_ms: r2To, question: r2Q, scene: '流延膜全链验收_diag' })
const task2 = (diag2.text.match(/(\d{6,})/) || [])[1]
ok('R2 诊断提交(引用 R1 结论)', !diag2.isError && !!task2, diag2.text.slice(0, 140))
let r2Done = false; let r2Report = ''; let r2Verdict = ''
if (task2) {
  for (let i = 0; i < 90; i++) {
    await sleep(20_000)
    const d = await getJson(`${IDD_BASE}/api/diagnosis/tasks/${task2}`, IDD_TOKEN)
    const v = d?.data?.view ?? d?.data ?? {}
    if (v.status === 'completed' || v.result?.report_md_path) {
      r2Done = true
      r2Verdict = `score=${v.result?.score ?? '?'} verdict=${v.result?.verdict ?? '?'}`
      try { r2Report = readFileSync(String(v.result.report_md_path).replace(/\\/g, '/'), 'utf8') }
      catch { /* 容错 */ }
      console.log(`  ↳ R2 完成:${r2Verdict}`)
      break
    }
    if (v.status === 'failed') { r2Verdict = v.result?.error ?? 'failed'; console.log(`  ✖ R2 失败:${r2Verdict}`); break }
    if (i % 4 === 0) console.log(`  ↳ (${i * 15 / 60 | 0}min) ${v.status ?? '?'}`)
  }
}
ok('R2 诊断完成且报告产出', r2Done && r2Report.length > 200, `${r2Verdict}; reportLen=${r2Report.length}`)
// ⑤ R2 入库 + 检索命中(且能看到 R1)
const exp2 = {
  title: '流延膜全链验收 R2 诊断报告:引用 R1 结论的新阶跃复核',
  scenario: 'PLC 模拟流延膜产线:检索 R1 结论定口径后,模口间隙 0.97 新阶跃下的继续分析',
  category: 'troubleshooting',
  problem: '验证 R1 结论在新工况(模口间隙收窄)下是否成立,评估膜厚响应方向与幅度',
  solution: r2Report.slice(0, 4000) || '(报告缺失)',
  result: r2Done ? 'SUCCESS' : 'PARTIAL',
  key_lessons: [`R2 任务 ${task2 ?? '?'};前置检索命中 R1 报告(expId=${exp1Id})`],
  tags: ['流延膜', '膜厚', '模口间隙', '全链验收', 'R2', '续诊'],
  metrics: { source: 'IDD', task: task2 ?? '', csvRows: r2Rows, prior_task: task1 ?? '' },
}
const ing2 = await fetch(`${KB_BASE}/api/v1/experience/${kbId}`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'authorization': `Bearer ${KB_TOKEN}`, 'X-KB-Token': KB_TOKEN },
  body: JSON.stringify(exp2), signal: AbortSignal.timeout(60_000),
}).then(r => r.json()).catch(e => ({ err: e.message }))
ok('R2 报告入库经验库', /success/i.test(JSON.stringify(ing2).slice(0, 200)) || !!(ing2?.id ?? ing2?.experience_id), JSON.stringify(ing2).slice(0, 120))
let hit2 = []
for (let i = 0; i < 6; i++) {
  await sleep(10_000)
  hit2 = await searchKB('流延膜全链验收 R2 模口间隙 复核 R1 结论')
  if (hit2.length > 0 && JSON.stringify(hit2).includes('R2')) break
}
ok('R2 检索命中本报告', hit2.length > 0 && JSON.stringify(hit2).includes('R2'), `hits=${hit2.length}`)
let hitBoth = []
for (let i = 0; i < 6; i++) {
  await sleep(10_000)
  hitBoth = await searchKB('流延膜 全链验收 诊断')
  if (JSON.stringify(hitBoth).includes('R1') && JSON.stringify(hitBoth).includes('R2')) break
}
ok('两轮报告均可持续检索(闭环沉淀)', JSON.stringify(hitBoth).includes('R1') && JSON.stringify(hitBoth).includes('R2'), `hits=${hitBoth.length}`)

/* ═══ P11 优化闭环:recipe_propose → HITL 批准 → 设备证实 ═══ */
console.log('\n[P11] 优化闭环(HITL 治理下发)')
let propTxt = ''; let okDispatch = false
for (let attempt = 1; attempt <= 3 && !okDispatch; attempt++) {
  const pkg = {
    name: `AC-线速微升(全链验收 ${attempt})`,
    params: [{ node_id: dcw['linespeed-sp'], to: 96, basis: `R2 诊断建议方向:线速微升验证膜厚响应(95→96,≤步限 5,有界单变量);依据 R1/R2 报告`, exp_ref: `KB:R1(${task1})/R2(${task2}) 诊断报告` }],
  }
  const propP = inv(procEngId, 'recipe_propose', { recipe_id: recipeId, packages: [pkg], emergency: true })
  // 并行裁决:等审批卡出现后批准
  let card = null
  for (let i = 0; i < 60 && !card; i++) {
    await sleep(2000)
    const pend = await api('GET', '/api/workshop/hitl/pending', undefined, TOKEN)
    const items = pend?.data?.items ?? pend?.data?.cards ?? []
    card = items.filter(x => x.kind === 'dcw-approval' && /recipe-propose:/.test(String(x.nodeId ?? '')))
      .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))[0]
  }
  if (card) await api('POST', '/api/workshop/hitl/respond', { kind: 'dcw-approval', id: card.id, confirmed: true, comment: '全链验收:批准该有界微调(依据 R1/R2 诊断)', choice: 0 }, TOKEN)
  const prop = await propP
  propTxt = String(prop.text ?? '')
  const flying = /已有在飞方案审批单\((ap-[\w-]+)\)/.exec(propTxt)?.[1]
  if (flying) {
    await api('POST', '/api/workshop/hitl/respond', { kind: 'dcw-approval', id: flying, confirmed: true, comment: '验收:批准在飞单收敛', choice: 0 }, TOKEN)
    await sleep(5000)
    const prop2 = await inv(procEngId, 'recipe_propose', { recipe_id: recipeId, packages: [pkg], emergency: true }, 300_000)
    propTxt = String(prop2.text ?? '')
  }
  okDispatch = /已获批/.test(propTxt) && /runId|下发/.test(propTxt) && !/未获批准|超时未批/.test(propTxt)
  if (!okDispatch) {
    const waitSec = Number(/请等待约?\s*(\d+)s/.exec(propTxt)?.[1] ?? 0)
    if (waitSec > 0 && attempt < 3) { console.log(`  ⏳ 治理窗未放行,等 ${waitSec + 10}s 重提…`); await sleep((waitSec + 10) * 1000); continue }
    break
  }
}
ok('提案→批准→整批下发(已获批并受理)', okDispatch, propTxt.split('\n')[0]?.slice(0, 140))
// 设备证实:工具同步回执的证实窗口偏短,主动轮询设备读回(最长 60s)
let devVal = null
for (let i = 0; i < 12; i++) {
  await sleep(5000)
  const rd = await call('aw_dcw_read', { id: dcw['linespeed-sp'] })
  const v = Number(rd.data?.value ?? rd.data?.node?.value ?? NaN)
  devVal = v
  if (Number.isFinite(v) && Math.abs(v - 96) < 0.01) break
}
ok('设备证实:PLC 读回线速=96(写穿生效)', Math.abs(Number(devVal) - 96) < 0.01, `device=${devVal}`)
const runId = /runId[:：]\s*(rr-[\w-]+)/.exec(propTxt)?.[1] ?? ''
ok('回执携带 runId(可回访)', !!runId, runId)
const audit = await api('GET', `/api/workshop/audit?limit=50`, undefined, TOKEN)
const apprRow = (audit?.data?.entries ?? []).find(l => /approv/i.test(String(l.action ?? '')) && String(JSON.stringify(l.detail ?? {})).includes(channelId))
ok('HITL 审批留痕入审计台账', !!apprRow, apprRow ? `${apprRow.action}@${String(apprRow.at ?? '').slice(11, 19)}` : `(audit ${(audit?.data?.entries ?? []).length} 条)`)

/* ═══ 清场 ═══ */
console.log('\n[清场]')
mcp.stdin.end(); mcp.kill()
if (!process.argv.includes('--keep')) {
  console.log(`(保留产物目录:${OUT_DIR} —— 含两轮 CSV/meta;模拟器与频道保留供查验)`)
}

console.log('')
console.log('════════════════════════════════════════')
console.log(`  全链路验收:${pass} PASS / ${fails.length} FAIL`)
for (const f of fails) console.log(`  ✖ ${f}`)
console.log('════════════════════════════════════════')
console.log(`频道: ${channelId}`)
console.log(`产线: ${lineId}`)
console.log(`R1 诊断: ${task1}  R2 诊断: ${task2}`)
console.log(`KB: aw-industrial(${kbId})`)
process.exit(fails.length ? 1 : 0)
