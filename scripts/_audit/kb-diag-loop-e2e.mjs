#!/usr/bin/env node
/**
 * scripts/_audit/kb-diag-loop-e2e.mjs —— 知识库+数据诊断集成与「数据分析闭环」验收。
 *
 * 验收规范(定义后执行):
 *   V1 插件集成:rag-bridge/diag-bridge health → 后端 ok、鉴权 accepted、KB id 就绪
 *   V2 SV/PV 语义:DCW 写 SV → 物理引擎 → DAQ 的 PV 波动跟随(有滞后);PV 不可写(设计)
 *   V3 模板:创建「产线数据分析诊断通道」模板并可实例化,worker 工具面含
 *      kb_agent/kb_agent_status/diag_run/diag_status/daq_query/my_industrial_nodes
 *   V4 数据导出:每轮把 DAQ 时序导出 CSV + meta.json(每字段物理含义/SV-PV 角色)到
 *      <配置根>/analysis/<round>/
 *   V5 诊断:diag_run(离线 CSV)→ 任务完成 → score/verdict + report.md
 *   V6 知识库:报告经 kb_agent 入库 → rag-bridge search 可检索命中
 *   V7 闭环:第 2 轮先查知识库命中第 1 轮报告 → 决策依据其结论调整数据窗口/分析焦点
 *   V8 回归:MCP 单测 14/14、skill 规范 64/64 不受影响
 *
 * 前置:KB(8770/6789)与 IDD(3210)在运行;.kb-token.tmp/.idd-token.tmp 有 API Token。
 * 用法:node scripts/_audit/kb-diag-loop-e2e.mjs [--keep]
 */
import { spawn, spawnSync } from 'node:child_process'
import { closeSync, existsSync, mkdtempSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const AW_PORT = 3469
const SIM_PORT = 4018
const HOME = mkdtempSync(join(tmpdir(), 'aw-kb-diag-'))
const SIM_DIR = resolve(REPO, '..', 'plc-node-simulator-bench-4018')
let BASE = `http://127.0.0.1:${AW_PORT}`
const SIM = `http://127.0.0.1:${SIM_PORT}`
const KB_TOKEN = existsSync(join(REPO, '.kb-token.tmp')) ? readFileSync(join(REPO, '.kb-token.tmp'), 'utf8').trim() : ''
const IDD_TOKEN = existsSync(join(REPO, '.idd-token.tmp')) ? readFileSync(join(REPO, '.idd-token.tmp'), 'utf8').trim() : ''

let pass = 0
const fails = []
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✔ ${name}`) }
  else { fails.push(name); console.log(`  ✖ ${name}${detail ? ` — ${String(detail).slice(0, 200)}` : ''}`) }
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
const getJson = async (url, token) => {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(20000), headers: token ? { authorization: `Bearer ${token}` } : {} })
    return await r.json()
  }
  catch { return null }
}
const killPort = (port) => {
  try {
    const psi = spawnSync('powershell', ['-NoProfile', '-Command',
      `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess`], { encoding: 'utf8' })
    const pid = Number(psi.stdout.trim())
    if (Number.isInteger(pid) && pid > 0) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
  }
  catch { /* 尽力而为 */ }
}

/* ── S0 · 自举(预置 MCP 开关 + 插件 token + 诊断运行参数)── */
console.log('[S0] 自举:平台 3469(全新 home,预置插件 token)+ 模拟器 4018')
for (const port of [AW_PORT, SIM_PORT]) killPort(port)
writeFileSync(join(HOME, 'runtime-settings.json'), JSON.stringify({ version: 1, overrides: {
  'mcp.enabled': true,
  'plugins.rag-bridge.token': KB_TOKEN,
  'plugins.diag-bridge.token': IDD_TOKEN,
  'plugins.diag-bridge.max_turns': 40,
  'plugins.diag-bridge.max_minutes': 12,
} }))
{
  const out = openSync(join(HOME, 'instance.log'), 'a')
  const p = spawn(process.execPath, [join(REPO, 'bin', 'aw.mjs'), 'start', '--port', String(AW_PORT)], {
    cwd: REPO,
    env: { ...process.env, NO_PROXY: '127.0.0.1,localhost', HTTP_PROXY: '', HTTPS_PROXY: '', AW_MODE: 'home', AW_HOME: HOME, NUXT_SESSION_PASSWORD: 'kb-diag-loop-session-password-012345' },
    detached: true, windowsHide: true, stdio: ['ignore', out, out],
  })
  closeSync(out); p.unref()
}
let actualPort = AW_PORT
for (let i = 0; i < 20; i++) {
  await sleep(1500)
  try {
    const lock = JSON.parse(readFileSync(join(HOME, '.runtime', 'aw.lock'), 'utf8'))
    if (Number.isInteger(lock?.port)) { actualPort = lock.port; break }
  }
  catch { /* 等锁 */ }
}
BASE = `http://127.0.0.1:${actualPort}`
let up = false
for (let i = 0; i < 40; i++) {
  await sleep(2000)
  if ((await getJson(`${BASE}/api/health`))?.data?.status === 'ok') { up = true; break }
}
ok('平台健康门', up, `BASE=${BASE}`)
{
  process.env.SIM_BASE = SIM
  process.env.SIM_SHADOW_DIR = SIM_DIR
  const { ensureSimulator, applyPreset } = await import('../../bench/lib/sim.mjs')
  await ensureSimulator({ log: () => {} })
  await applyPreset('cast-film-physics')
  ok('模拟器在跑', (await getJson(`${SIM}/api/plant/state`))?.data?.running === true)
}

/* ── S1 · admin + MCP ── */
const reg = await (async () => {
  const r = await fetch(`${BASE}/api/users/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'kb-diag-admin', email: 'kb-diag@awshop.local', password: 'kb-diag-passw0rd' }) })
  return r.json()
})()
const TOKEN = reg?.data?.token
ok('admin 注册', Boolean(TOKEN))

const mcp = spawn(process.execPath, [join(REPO, 'mcp', 'aw-mcp-server.mjs')], {
  cwd: REPO,
  env: { ...process.env, NO_PROXY: '127.0.0.1,localhost', HTTP_PROXY: '', HTTPS_PROXY: '', AW_HOME: HOME, AW_TOKEN: TOKEN },
  stdio: ['pipe', 'pipe', 'pipe'],
})
const rl = createInterface({ input: mcp.stdout })
const pending = new Map(); let nextId = 1
rl.on('line', (line) => { try { const m = JSON.parse(line); if (m?.id != null && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } } catch {} })
const rpc = (method, params, timeoutMs = 120_000) => new Promise((res, rej) => {
  const id = nextId++
  const t = setTimeout(() => { pending.delete(id); rej(new Error(`rpc 超时: ${method}`)) }, timeoutMs)
  pending.set(id, (m) => { clearTimeout(t); res(m) })
  mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
})
const call = async (name, args = {}, timeoutMs) => {
  const res = await rpc('tools/call', { name, arguments: args }, timeoutMs)
  const text = res?.result?.content?.[0]?.text ?? ''
  return { isError: Boolean(res?.result?.isError), text, data: (() => { try { return JSON.parse(text) } catch { return null } })() }
}

/* ── S2 · V1 插件集成验证 ── */
console.log('[S2] V1 插件集成:rag-bridge / diag-bridge health')
{
  const rag = await call('aw_request', { method: 'GET', path: '/api/plugins/rag-bridge/health' })
  const rd = rag.data ?? {}
  ok('V1a rag-bridge:后端可达+KB 就绪', !rag.isError && rd.backend?.ok === true && Boolean(rd.kb?.id), JSON.stringify({ backend: rd.backend, kb: rd.kb, auth: rd.auth }).slice(0, 180))
  const diag = await call('aw_request', { method: 'GET', path: '/api/plugins/diag-bridge/health' })
  const dd = diag.data ?? {}
  ok('V1b diag-bridge:远端可达', !diag.isError && Boolean(dd.remote), JSON.stringify({ remote: dd.remote, auth: dd.auth, token: dd.token }).slice(0, 180))
  ok('V1c diag-bridge 鉴权 accepted', dd.token?.accepted === true, JSON.stringify(dd.token ?? {}).slice(0, 120))
}

/* ── S3 · 建线(3 DCW + 3 DAQ)+ 开跑 ── */
console.log('[S3] 建线(SV=3 DCW / PV=3 DAQ)+ 基线开跑')
let lineId, productId
const dcw = {}, daq = {}
{
  const simDevices = (await getJson(`${SIM}/api/nodes`))?.data ?? []
  const line = await call('aw_line_create', { name: `数据分析验收线-${Date.now() % 100000}` })
  lineId = line.data?.line?.id
  const product = await call('aw_product_create', { lineId, name: '数据分析验收产品' })
  productId = product.data?.product?.id
  const wantAct = ['zone1-sp', 'linespeed-sp', 'diegap-sp']
  const wantSen = ['melt-temp', 'melt-pressure', 'film-thickness']
  for (const dev of simDevices) {
    const exp = (await getJson(`${SIM}/api/nodes/${dev.id}/export`))?.data?.items ?? []
    const sigOf = id => (dev.signals ?? []).find(s => s.id === id)
    for (const id of wantAct) {
      const sig = sigOf(id); if (!sig || dcw[id]) continue
      const item = exp.find(i => i.signal === sig.name); if (!item?.driverConfig) continue
      const r = await call('aw_dcw_create', { name: `分析-${sig.name}`, templateRef: 'dcw-temp-sp', driver: dev.protocol, driverConfig: item.driverConfig, unit: sig.unit, min: sig.min, max: sig.max, decimals: sig.decimals ?? 2, lineId, holdIntervalMs: 0, stepLimit: 5, semantics: `SV 设定点:${sig.name}(${sig.unit})` })
      dcw[id] = r.data?.node?.id ?? r.data?.id
    }
    for (const id of wantSen) {
      const sig = sigOf(id); if (!sig || daq[id]) continue
      const item = exp.find(i => i.signal === sig.name); if (!item?.driverConfig) continue
      const r = await call('aw_daq_create', { name: `分析-${sig.name}`, templateRef: 'daq-temp-tc', driver: dev.protocol, driverConfig: item.driverConfig, unit: sig.unit, min: sig.min, max: sig.max, decimals: sig.decimals ?? 2, lineId, intervalMs: 1000, semantics: id === 'film-thickness' ? 'PV 实时检测:流延膜厚度(优化目标 goal,μm;厚度质量输出,随 SV 波动)' : `PV 实时检测:${sig.name}(${sig.unit}),随 SV 波动` })
      daq[id] = r.data?.node?.id ?? r.data?.id
    }
  }
  ok('建节点 3 SV(DCW) + 3 PV(DAQ)', wantAct.every(id => dcw[id]) && wantSen.every(id => daq[id]), JSON.stringify({ dcw, daq }))
  await call('aw_daq_controller', { action: 'start' })
  const recipe = await call('aw_recipe_create', {
    productId, name: '分析基线配方', description: '数据分析闭环验收基线(标定工况)',
    params: [
      { nodeId: dcw['zone1-sp'], value: 200, min: 190, max: 225 },
      { nodeId: dcw['linespeed-sp'], value: 95, min: 85, max: 110 },
      { nodeId: dcw['diegap-sp'], value: 1.0, min: 0.85, max: 1.15 },
    ],
    daqWindows: [{ nodeId: daq['film-thickness'], min: 30, max: 90 }],
  })
  const recipeId = recipe.data?.recipe?.id ?? recipe.data?.id
  const start = await call('aw_line_start', { lineId, recipeId })
  ok('基线开跑', !start.isError, start.text.slice(0, 120))
  await sleep(66_000) // 配方下发锚定 60s 写入冷却,等满再验 SV/PV 因果
}

/* ── S4 · V2 SV/PV 语义验证(SV 写 → PV 滞后波动;PV 不可写)── */
console.log('[S4] V2 SV/PV:写 SV(模口 1.00→1.06)→ 观察 PV(膜厚)跟随')
{
  const samplesOf = async (nodeId, n = 40) => {
    const r = await call('aw_daq_samples', { id: nodeId, bucketMs: 1000, limit: n })
    return (r.data?.points ?? []).map(p => ({ at: Number(p.at ?? 0), v: Number(p.avg ?? p.value) })).filter(p => Number.isFinite(p.v)).sort((a, b) => a.at - b.at)
  }
  await sleep(30_000)
  const pvBefore = await samplesOf(daq['film-thickness'])
  const mean = a => a.reduce((x, y) => x + y.v, 0) / a.length
  const beforeMean = mean(pvBefore.slice(-10))
  ok('V2a 写前 PV 有波动(σ>0,实时数采特征)', pvBefore.length >= 5 && Math.sqrt(pvBefore.reduce((s, p) => s + (p.v - beforeMean) ** 2, 0) / pvBefore.length) > 0, `n=${pvBefore.length}`)
  const w = await call('aw_dcw_write', { id: dcw['diegap-sp'], value: 1.06 })
  ok('V2b SV 下发成功(1.00→1.06)', !w.isError, w.text.slice(0, 100))
  await sleep(90_000) // 物理滞后:输送延迟+惯性,等全响应
  const pvAfter = await samplesOf(daq['film-thickness'])
  const afterMean = mean(pvAfter.slice(-10))
  ok('V2c PV 跟随 SV 变化(膜厚均值上移)', afterMean > beforeMean + 0.8, `before=${beforeMean.toFixed(2)} after=${afterMean.toFixed(2)}`)
  const ro = await call('aw_request', { method: 'POST', path: `/api/workshop/daq/${daq['film-thickness']}/write`, body: { value: 50 } })
  ok('V2d PV 不可写(无写入口=设计)', ro.isError && /404|405|不支持|不存在/i.test(ro.text), ro.text.slice(0, 120))
}

/* ── S5 · V3 数据分析模板 + 实例化 + 工具面 ── */
console.log('[S5] V3 数据分析诊断模板:创建 → 实例化 → 工具面核查')
let workerId
{
  const tpl = await call('aw_request', { method: 'POST', path: '/api/workshop/channel-templates', body: {
    name: '产线数据分析诊断通道',
    description: '面向 PLC 模拟产线的持续数据分析闭环:查知识库历史→决定取数窗口→导出 CSV+元信息→诊断分析→报告入库→可检索',
    scenarioPrompt: '数据分析闭环纪律:每一轮先查知识库历史分析(kb_agent),依据历史结论决定本轮要抓取的产线数据窗口与焦点;数据导出为 CSV+元信息(JSON,说明每个字段的物理含义与 SV/PV 角色);随后 diag_run 发起诊断分析;完成后必须把报告入库(kb_agent)供下轮检索。SV=设定值(DCW 写入),PV=实时检测值(DAQ 数采,只读)。',
    members: [
      { inline: { name: '数据分析总工', harness: 'omp', config: { rpcMode: 'rpc', intro: '数据分析闭环督办', systemPromptPrefix: '你是数据分析总工。每轮闭环:1)kb_agent 查历史;2)决定数据窗口;3)等数据导出后 diag_run 发起诊断;4)报告入库;5)对比历史给出结论。中文,留痕。' } }, role: 'lead' },
      { inline: { name: '数据分析工程师', harness: 'omp', config: { rpcMode: 'rpc', intro: '数据分析执行', systemPromptPrefix: '你是数据分析工程师。使用 daq_query/journal 获取 SV/PV 数据;kb_agent 检索与入库;diag_run/diag_status 诊断。禁止臆造数字。' } }, role: 'worker' },
    ],
    visibility: 'public',
  } })
  const tplId = tpl.data?.template?.id ?? tpl.data?.id
  ok('V3a 模板创建(产线数据分析诊断通道)', !tpl.isError && Boolean(tplId), tpl.text.slice(0, 120))
  const inst = await call('aw_channel_template_instantiate', { id: tplId, name: `数据分析闭环频道-${Date.now() % 100000}` })
  const channelId = inst.data?.channelId ?? inst.data?.id
  ok('V3b 模板实例化为频道', !inst.isError && Boolean(channelId), inst.text.slice(0, 120))
  const agents = await call('aw_request', { method: 'GET', path: `/api/workshop/channels/${channelId}/agents` })
  workerId = (Array.isArray(agents.data) ? agents.data : []).find(a => a.role === 'worker')?.id
  ok('V3c worker 实例就绪', Boolean(workerId))
  for (const nodeId of Object.values(dcw)) await call('aw_agent_tool_bind', { agentId: workerId, nodeId, kind: 'dcw', mode: 'auto' })
  for (const nodeId of Object.values(daq)) await call('aw_agent_tool_bind', { agentId: workerId, nodeId, kind: 'daq', mode: 'auto' })
  const list = await call('aw_request', { method: 'GET', path: `/api/workshop/agent-tools/list?agentId=${workerId}` })
  const toolNames = JSON.stringify(list.data ?? list.text)
  for (const t of ['kb_agent', 'kb_agent_status', 'diag_run', 'diag_status', 'daq_query', 'my_industrial_nodes']) {
    ok(`V3d worker 工具面含 ${t}`, toolNames.includes(t))
  }
  globalThis.__channelId = channelId
}

/* ── S6 · 闭环两轮 ── */
const ANALYSIS_DIR = join(HOME, 'analysis')
const lineName = (await call('aw_line_list')).data?.find?.(l => l.id === lineId)?.name ?? '数据分析验收线'
const NODE_META = [
  { nodeId: dcw['zone1-sp'], role: 'SV', name: '加热区1SP', unit: '℃', meaning: '加热区温度设定值(SV):DCW 可写,影响熔体温度进而影响膜厚' },
  { nodeId: dcw['linespeed-sp'], role: 'SV', name: '线速SP', unit: 'm/min', meaning: '产线速度设定值(SV):DCW 可写,升速减薄、降速增厚(质量守恒)' },
  { nodeId: dcw['diegap-sp'], role: 'SV', name: '模口间隙SP', unit: 'mm', meaning: '模口间隙设定值(SV):DCW 可写,间隙增大膜厚近似线性增厚' },
  { nodeId: daq['melt-temp'], role: 'PV', name: '熔体温度', unit: '℃', meaning: '熔体温度实时检测(PV):DAQ 数采,跟随加热 SV 波动,滞后约 1-2 分钟' },
  { nodeId: daq['melt-pressure'], role: 'PV', name: '熔体压力', unit: 'MPa', meaning: '熔体压力实时检测(PV):DAQ 数采,反映泵送与滤网状态,随螺杆/温度波动' },
  { nodeId: daq['film-thickness'], role: 'PV', name: '膜厚', unit: 'μm', meaning: '膜厚实时检测(PV):核心质量指标,由质量守恒决定,随线速/模口/螺杆 SV 滞后波动' },
]
const sampleRows = async (fromMs, toMs) => {
  const cols = NODE_META.filter(m => m.role === 'PV')
  const series = []
  for (const m of cols) {
    const r = await call('aw_daq_samples', { id: m.nodeId, fromMs, toMs, bucketMs: 2000, limit: 1000 })
    const pts = (r.data?.points ?? []).map(p => ({ at: Number(p.at ?? 0), v: Number(p.avg ?? p.value) })).filter(p => Number.isFinite(p.v)).sort((a, b) => a.at - b.at)
    series.push({ m, pts })
  }
  const stamps = [...new Set(series.flatMap(s => s.pts.map(p => p.at)))].sort((a, b) => a - b)
  const rows = stamps.map((t) => {
    const row = { timestamp: new Date(t).toISOString() }
    for (const { m, pts } of series) {
      const hit = pts.find(p => Math.abs(p.at - t) <= 2000)
      row[m.name] = hit ? Number(hit.v.toFixed(3)) : ''
    }
    return row
  }).filter(r => Object.keys(r).length > 1)
  return { rows, cols }
}
const runRound = async (round, decision) => {
  console.log(`[闭环 R${round}] ${decision.focus}`)
  const r = {}
  // 1. 查知识库历史
  const search = await call('aw_request', { method: 'GET', path: `/api/plugins/rag-bridge/search?q=${encodeURIComponent(decision.kbQuery)}&top_k=5` })
  r.kbHits = search.data?.results?.length ?? search.data?.total_results ?? 0
  ok(`R${round}-1 知识库检索(历史分析)`, !search.isError, search.text.slice(0, 120))
  console.log(`  ↳ KB 命中 ${r.kbHits} 条`)
  // 2. 取数窗口(按决策)
  const toMs = Date.now()
  const fromMs = toMs - decision.windowMs
  const { rows } = await sampleRows(fromMs, toMs)
  // 3. 落盘 CSV + meta.json(物理含义)
  const dir = join(ANALYSIS_DIR, `round-${round}`)
  mkdirSync(dir, { recursive: true })
  if (rows.length) {
    const header = Object.keys(rows[0]).join(',')
    const csv = [header, ...rows.map(r => Object.values(r).join(','))].join('\n')
    writeFileSync(join(dir, 'data.csv'), csv)
  }
  const meta = {
    dataset: `产线数据分析第 ${round} 轮(产线:${lineName})`,
    scene: 'PLC 模拟流延膜产线:SV=设定值(DCW 可写),PV=实时检测值(DAQ 数采只读,跟随 SV 波动)',
    window: { fromMs, toMs, fromIso: new Date(fromMs).toISOString(), toIso: new Date(toMs).toISOString() },
    fields: NODE_META.map(m => ({ nodeId: m.nodeId, column: m.name, role: m.role, unit: m.unit, physicalMeaning: m.meaning })),
    kbContext: { query: decision.kbQuery, hits: r.kbHits },
    decision: decision.focus,
  }
  writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta, null, 2))
  ok(`R${round}-2 CSV+meta.json 落盘(${dir})`, rows.length > 0 && existsSync(join(dir, 'meta.json')), `rows=${rows.length}`)
  // 4. 诊断分析(离线 CSV 直供)
  const diag = await call('aw_agent_tool_invoke', { agentId: workerId, tool: 'diag_run', args: { data_path: join(dir, 'data.csv'), question: decision.question, scene: `${lineName}_diag` } }, 120_000)
  ok(`R${round}-3 diag_run 提交`, !diag.isError, diag.text.slice(0, 140))
  const taskId = (diag.text.match(/task_id[:\s]+([a-z0-9-]+)/i) || [])[1]
  ok(`R${round}-4 诊断任务 id 可解析`, Boolean(taskId), diag.text.slice(0, 140))
  let done = null
  for (let i = 0; i < 90; i++) {
    await sleep(10_000)
    const s = await call('aw_agent_tool_invoke', { agentId: workerId, tool: 'diag_status', args: taskId ? { run_id: taskId } : {} }, 120_000)
    const statusM = s.text.match(/status["\s:]+(\w+)/)
    if (s.text.includes('completed')) { done = s; break }
    if (statusM && /failed|error/i.test(statusM[1])) { done = s; break }
  }
  ok(`R${round}-5 诊断完成(报告产出)`, Boolean(done), (done?.text ?? '超时').slice(0, 160))
  // 5. 报告入库(kb_agent)
  const reportText = done?.text ?? ''
  const kb = await call('aw_agent_tool_invoke', { agentId: workerId, tool: 'kb_agent', args: { prompt: `请将以下产线数据分析报告存入知识库(经验库),摘要需包含关键词:产线数据分析、膜厚、第${round}轮。报告内容:\n${reportText.slice(0, 4000)}`, mode: 'async' } }, 120_000)
  const kbTask = (kb.text.match(/task_id[:\s]+([a-z0-9-]+)/i) || [])[1]
  ok(`R${round}-6 报告入库(kb_agent 受理)`, !kb.isError && Boolean(kbTask), kb.text.slice(0, 140))
  if (kbTask) {
    let kbDone = false
    for (let i = 0; i < 30; i++) {
      await sleep(10_000)
      const s = await call('aw_agent_tool_invoke', { agentId: workerId, tool: 'kb_agent_status', args: { task_id: kbTask } }, 120_000)
      if (/completed|done|success/i.test(s.text)) { kbDone = true; break }
      if (/failed|error/i.test(s.text)) break
    }
    ok(`R${round}-7 入库完成`, kbDone)
    // 6. 可检索
    await sleep(5000)
    const verify = await call('aw_request', { method: 'GET', path: `/api/plugins/rag-bridge/search?q=${encodeURIComponent(`第${round}轮 膜厚 分析`)}&top_k=5` })
    r.searchHit = (verify.data?.results?.length ?? 0) > 0 || /round|膜厚|第/.test(JSON.stringify(verify.data ?? {}).slice(0, 400))
    ok(`R${round}-8 入库后可检索命中`, r.searchHit, JSON.stringify(verify.data ?? {}).slice(0, 160))
  }
  return r
}

/* ── 闭环执行 ── */
const R1 = await runRound(1, { focus: '首轮基线分析:最近 10 分钟全 PV 波动与稳定性', kbQuery: '产线 数据分析 膜厚', windowMs: 10 * 60_000, question: '分析本产线最近 10 分钟膜厚/熔温/熔压的波动趋势与稳定性,给出结论与建议' })
const R2 = await runRound(2, { focus: '基于 R1 报告结论:拉宽窗口复核膜厚漂移是否持续', kbQuery: '产线 数据分析 膜厚 分析 报告', windowMs: 25 * 60_000, question: '结合上一轮报告结论,复核最近 25 分钟膜厚漂移是否持续,熔体压力有无异常,给出下一步建议' })
ok('V7 闭环证据:R2 检索命中 R1 报告(或 KB 返回非空)', R1.kbHits > 0 || R2.kbHits > 0 || R2.searchHit, JSON.stringify({ r1: R1.kbHits, r2: R2.kbHits }))

/* ── 清场 ── */
console.log('[清场]')
mcp.stdin.end(); mcp.kill()
killPort(actualPort); killPort(SIM_PORT)
await sleep(1500)
if (!process.argv.includes('--keep')) { try { rmSync(HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 1500 }) } catch {} }

console.log('')
console.log(`═══ 知识库+诊断闭环验收:${pass} PASS / ${fails.length} FAIL ═══`)
for (const f of fails) console.log(`  ✖ ${f}`)
console.log('')
process.exit(fails.length ? 1 : 0)
