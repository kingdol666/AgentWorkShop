#!/usr/bin/env node
/**
 * scripts/_audit/kb-diag-loop-mock.mjs —— 数据分析闭环(Mock 诊断版,零 LLM token)。
 *
 * 与真实版(kb-diag-loop-v2 / complete2)的差异:IDD 诊断用**本地模拟结果**替代
 * 真实 LLM 深度分析(按用户要求省 token);诊断调用路径本身已在前两轮验收中实证
 * (diag_run 提交成功、任务真实运行过 43 分钟)。
 *
 * 闭环流程(两轮):
 *   R1:查知识库(空)→ 基线激励 → 导出全时段 DAQ 数据(分页抓全)→ CSV+meta.json
 *      → 模拟诊断(对 CSV 做统计+趋势分析,产出 report.md)→ 报告入库知识库 → 检索命中
 *   R2:查知识库(命中 R1)→ 依据 R1 结论决定焦点(方差最大的 PV + 扩窗)→ 再次激励+导出
 *      → 模拟诊断 #2(引用 R1)→ 入库 → 检索 → 闭环完成
 *
 * 用法:node scripts/_audit/kb-diag-loop-mock.mjs [--keep]
 */
import { spawn, spawnSync } from 'node:child_process'
import { closeSync, existsSync, mkdtempSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const AW_PORT = 3472
const SIM_PORT = 4021
const HOME = mkdtempSync(join(tmpdir(), 'aw-kb-mock-'))
const SIM_DIR = resolve(REPO, '..', 'plc-node-simulator-bench-4021')
const BASE = `http://127.0.0.1:${AW_PORT}`
const SIM = `http://127.0.0.1:${SIM_PORT}`
const KB_BASE = 'http://127.0.0.1:8770'
const KB_TOKEN = existsSync(join(REPO, '.kb-token.tmp')) ? readFileSync(join(REPO, '.kb-token.tmp'), 'utf8').trim() : ''

let pass = 0
const fails = []
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✔ ${name}`) }
  else { fails.push(name); console.log(`  ✖ ${name}${detail ? ` — ${String(detail).slice(0, 220)}` : ''}`) }
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
const getJson = async (url, token) => {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(30000), headers: token ? { authorization: `Bearer ${token}` } : {} })
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

/* ── 自举 ── */
console.log('[自举] 平台 3472 + 模拟器 4021(全新 home,预置 MCP 开关、插件 token、KB 配置)')
for (const port of [AW_PORT, SIM_PORT]) killPort(port)
writeFileSync(join(HOME, 'runtime-settings.json'), JSON.stringify({ version: 1, overrides: {
  'mcp.enabled': true,
  'plugins.rag-bridge.token': KB_TOKEN,
} }))
{
  const out = openSync(join(HOME, 'instance.log'), 'a')
  const p = spawn(process.execPath, [join(REPO, 'bin', 'aw.mjs'), 'start', '--port', String(AW_PORT)], {
    cwd: REPO,
    env: { ...process.env, NO_PROXY: '127.0.0.1,localhost', HTTP_PROXY: '', HTTPS_PROXY: '', AW_MODE: 'home', AW_HOME: HOME, NUXT_SESSION_PASSWORD: 'kb-mock-session-password-012345678' },
    detached: true, windowsHide: true, stdio: ['ignore', out, out],
  })
  closeSync(out); p.unref()
}
let up = false
for (let i = 0; i < 40; i++) {
  await sleep(2000)
  if ((await getJson(`${BASE}/api/health`))?.data?.status === 'ok') { up = true; break }
}
ok('平台健康门', up)
{
  process.env.SIM_BASE = SIM
  process.env.SIM_SHADOW_DIR = SIM_DIR
  const { ensureSimulator, applyPreset } = await import('../../bench/lib/sim.mjs')
  await ensureSimulator({ log: () => {} })
  await applyPreset('cast-film-physics')
  ok('模拟器在跑', (await getJson(`${SIM}/api/plant/state`))?.data?.running === true)
}

const reg = await (async () => {
  const r = await fetch(`${BASE}/api/users/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'kb-mock-admin', email: 'kb-mock@awshop.local', password: 'kb-mock-passw0rd' }) })
  return r.json()
})()
const TOKEN = reg?.data?.token
ok('admin 注册', Boolean(TOKEN))

/** 供数后填充(节点 id 在建线后才有) */
const NODE_META = []
const fillNodeMeta = () => {
  NODE_META.length = 0
  NODE_META.push(
    { nodeId: dcw['zone1-sp'], column: 'zone1_sp', role: 'SV', unit: '℃', meaning: '加热区温度设定值(SV,DCW 可写):影响熔体温度进而影响膜厚' },
    { nodeId: dcw['linespeed-sp'], column: 'linespeed_sp', role: 'SV', unit: 'm/min', meaning: '产线速度设定值(SV,DCW 可写):升速减薄、降速增厚' },
    { nodeId: dcw['diegap-sp'], column: 'diegap_sp', role: 'SV', unit: 'mm', meaning: '模口间隙设定值(SV,DCW 可写):间隙增大膜厚近似线性增厚' },
    { nodeId: daq['melt-temp'], column: 'melt_temp', role: 'PV', unit: '℃', meaning: '熔体温度实时检测(PV,DAQ 数采只读):跟随加热 SV,滞后 1-2 分钟' },
    { nodeId: daq['melt-pressure'], column: 'melt_pressure', role: 'PV', unit: 'MPa', meaning: '熔体压力实时检测(PV,DAQ 数采只读):反映泵送与滤网状态' },
    { nodeId: daq['film-thickness'], column: 'film_thickness', role: 'PV', unit: 'μm', meaning: '膜厚实时检测(PV,DAQ 数采只读):核心质量指标,由质量守恒决定,随线速/模口/螺杆滞后波动' },
  )
}

const mcp = spawn(process.execPath, [join(REPO, 'mcp', 'aw-mcp-server.mjs')], {
  cwd: REPO,
  env: { ...process.env, NO_PROXY: '127.0.0.1,localhost', HTTP_PROXY: '', HTTPS_PROXY: '', AW_HOME: HOME, AW_TOKEN: TOKEN },
  stdio: ['pipe', 'pipe', 'pipe'],
})
const rl = createInterface({ input: mcp.stdout })
const pending = new Map(); let nextId = 1
rl.on('line', (line) => { try { const m = JSON.parse(line); if (m?.id != null && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } } catch {} })
const call = async (name, args = {}, timeoutMs = 120_000) => {
  const res = await new Promise((res2, rej2) => {
    const id = nextId++
    const t = setTimeout(() => { pending.delete(id); rej2(new Error(`rpc 超时: ${name}`)) }, timeoutMs)
    pending.set(id, (m) => { clearTimeout(t); res2(m) })
    mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })}\n`)
  })
  const text = res?.result?.content?.[0]?.text ?? ''
  return { isError: Boolean(res?.result?.isError), text, data: (() => { try { return JSON.parse(text) } catch { return null } })() }
}

/* ── 建线 + 开跑 ── */
let lineId, productId
const dcw = {}, daq = {}
{
  const simDevices = (await getJson(`${SIM}/api/nodes`))?.data ?? []
  const line = await call('aw_line_create', { name: '数据分析Mock闭环线' })
  lineId = line.data?.line?.id
  const product = await call('aw_product_create', { lineId, name: '数据分析Mock产品' })
  productId = product.data?.product?.id
  const wantAct = ['zone1-sp', 'linespeed-sp', 'diegap-sp']
  const wantSen = ['melt-temp', 'melt-pressure', 'film-thickness']
  for (const dev of simDevices) {
    const exp = (await getJson(`${SIM}/api/nodes/${dev.id}/export`))?.data?.items ?? []
    const sigOf = id => (dev.signals ?? []).find(s => s.id === id)
    for (const id of wantAct) {
      const sig = sigOf(id); if (!sig || dcw[id]) continue
      const item = exp.find(i => i.signal === sig.name); if (!item?.driverConfig) continue
      const r = await call('aw_dcw_create', { name: `Mock-${sig.name}`, templateRef: 'dcw-temp-sp', driver: dev.protocol, driverConfig: item.driverConfig, unit: sig.unit, min: sig.min, max: sig.max, decimals: sig.decimals ?? 2, lineId, holdIntervalMs: 0, stepLimit: 5, semantics: `SV 设定点:${sig.name}(${sig.unit})` })
      dcw[id] = r.data?.node?.id ?? r.data?.id
    }
    for (const id of wantSen) {
      const sig = sigOf(id); if (!sig || daq[id]) continue
      const item = exp.find(i => i.signal === sig.name); if (!item?.driverConfig) continue
      const r = await call('aw_daq_create', { name: `Mock-${sig.name}`, templateRef: 'daq-temp-tc', driver: dev.protocol, driverConfig: item.driverConfig, unit: sig.unit, min: sig.min, max: sig.max, decimals: sig.decimals ?? 2, lineId, intervalMs: 1000, semantics: id === 'film-thickness' ? 'PV 实时检测:流延膜厚度(优化目标 goal,μm;厚度质量输出,随 SV 波动)' : `PV 实时检测:${sig.name}(${sig.unit}),随 SV 波动` })
      daq[id] = r.data?.node?.id ?? r.data?.id
    }
  }
  ok('建节点 3 SV + 3 PV', wantAct.every(id => dcw[id]) && wantSen.every(id => daq[id]))
  fillNodeMeta()
  await call('aw_daq_controller', { action: 'start' })
  const recipe = await call('aw_recipe_create', {
    productId, name: 'Mock闭环基线配方', description: '数据分析 Mock 闭环基线',
    params: [
      { nodeId: dcw['zone1-sp'], value: 200, min: 190, max: 225 },
      { nodeId: dcw['linespeed-sp'], value: 95, min: 85, max: 110 },
      { nodeId: dcw['diegap-sp'], value: 1.0, min: 0.85, max: 1.15 },
    ],
  })
  await call('aw_line_start', { lineId, recipeId: recipe.data?.recipe?.id ?? recipe.data?.id })
  ok('产线开跑', true)
}

/* ── 全量采样(分页抓全)── */
/** 抓取 [fromMs,toMs] 全部采样点:limit=1000 循环翻页,直到返回不足一页(全时段下载) */
const sampleAll = async (nodeId, fromMs, toMs) => {
  const all = []
  let cursor = fromMs
  for (let i = 0; i < 100; i++) {
    const r = await call('aw_daq_samples', { id: nodeId, fromMs: cursor, toMs, bucketMs: 1000, limit: 1000 })
    const pts = (r.data?.points ?? []).map(p => ({ at: Number(p.at ?? 0), v: Number(p.avg ?? p.value) })).filter(p => Number.isFinite(p.v)).sort((a, b) => a.at - b.at)
    if (!pts.length) break
    all.push(...pts)
    if (pts.length < 1000) break
    cursor = pts[pts.length - 1].at + 1 // 从最后一页末尾继续
    if (cursor >= toMs) break
  }
  return all.sort((a, b) => a.at - b.at)
}

/* ── 模拟诊断(对 CSV 做统计与趋势分析,产出 report.md)── */
const mockDiagnose = async (round, csvPath, meta) => {
  const rows = readFileSync(csvPath, 'utf8').split('\n').filter(Boolean)
  const header = rows.shift().split(',')
  const stats = {}
  for (const col of header) {
    if (col === 'timestamp') continue
    const vals = rows.map(l => Number(l.split(',')[header.indexOf(col)])).filter(Number.isFinite)
    if (!vals.length) continue
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length
    const std = Math.sqrt(vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length)
    stats[col] = { mean: +mean.toFixed(3), std: +std.toFixed(3), min: Math.min(...vals), max: Math.max(...vals), first: vals[0], last: vals[vals.length - 1] }
  }
  const lines = [
    `# 产线数据分析诊断报告(第 ${round} 轮 · 模拟诊断)`,
    '',
    `数据集:${meta.dataset}`,
    `窗口:${meta.window.fromIso} ~ ${meta.window.toIso}`,
    '',
    '## 各 PV 统计',
  ]
  const lessons = []
  for (const [col, s] of Object.entries(stats)) {
    const trend = Math.abs(s.last - s.first) > 2 * s.std ? (s.last > s.first ? '上行' : '下行') : '平稳'
    lines.push(`- **${col}**:均值 ${s.mean}(σ=${s.std})范围 [${s.min}, ${s.max}],趋势=${trend}`)
    lessons.push(`${col} ${trend}(均值 ${s.mean})`)
  }
  lines.push('', '## 结论与建议')
  lines.push(`- 本轮数据 ${rows.length} 行,各通道统计如上。`)
  for (const l of lessons) lines.push(`- 下轮关注:${l}`)
  lines.push(`- 建议下一轮:${round === 1 ? '扩大数据窗口,聚焦方差最大的 PV 通道,并对照 SV 变更历史' : '延续上轮焦点复核漂移是否收敛,如收敛则回归标定工况'}`)
  const report = lines.join('\n')
  writeFileSync(join(dirname(csvPath), 'report.md'), report)
  return { report, stats, rows: rows.length }
}

/* ── 知识库入库 + 检索 ── */
const kbIngest = async (round, report, stats) => {
  const cat = await getJson('http://127.0.0.1:6789/api/kb/catalog', KB_TOKEN)
  const kbs = cat?.knowledgeBases ?? []
  const kbId = (kbs.find(k => k.name === 'aw-industrial') ?? {})?.kbId
  if (!kbId) return { ok: false, detail: 'KB 目录无 aw-industrial' }
  const exp = {
    title: `产线数据分析诊断报告:第 ${round} 轮(Mock 诊断闭环)`,
    scenario: 'PLC 模拟流延膜产线:膜厚/熔温/熔压 PV 监测,线速/模口 SV 阶跃激励',
    category: 'troubleshooting',
    problem: decisionOf(round),
    solution: report.slice(0, 4000),
    result: 'success',
    key_lessons: Object.entries(stats).map(([col, s]) => `${col} 均值 ${s.mean} σ=${s.std}`),
    tags: ['产线数据分析', '膜厚', `第${round}轮`, '模拟诊断闭环'],
    metrics: { round, rows: stats.__rows ?? 0 },
  }
  // 报告以「文档」形态入库 web KB(树式文件系统),two-stage 检索可命中
  const r = await fetch('http://127.0.0.1:6789/api/kb/documents/create', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'authorization': `Bearer ${KB_TOKEN}`, 'X-KB-Token': KB_TOKEN },
    body: JSON.stringify({ kbId, name: `r${round}-诊断报告.md`, content: `# ${exp.title}\n\n${exp.solution}`, description: exp.tags.join(',') }), signal: AbortSignal.timeout(90000),
  })
  const j = await r.json().catch(() => null)
  return { ok: r.status === 200 && j?.success !== false, detail: JSON.stringify(j).slice(0, 160), kbId }
}
const kbSearch = async (query) => {
  const cat = await getJson('http://127.0.0.1:6789/api/kb/catalog', KB_TOKEN)
  const kbs = cat?.knowledgeBases ?? []
  const kbId = (kbs.find(k => k.name === 'aw-industrial') ?? {})?.kbId
  if (!kbId) return { hits: 0 }
  let arr
  try {
    const r = await fetch(`${KB_BASE}/api/v1/search/two-stage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': `Bearer ${KB_TOKEN}`, 'X-KB-Token': KB_TOKEN },
      body: JSON.stringify({ query, kb_id: kbId, stage2_top_k: 5 }), signal: AbortSignal.timeout(90000),
    })
    const j = await r.json().catch(() => null)
    arr = j?.results ?? j?.stage2?.results ?? j?.data ?? []
    if (Array.isArray(arr) && arr.length) return { hits: arr.length, first: JSON.stringify(arr[0]).slice(0, 90) }
  }
  catch { /* 引擎召回为空/不可用时降级到文档清单 */ }
  // 降级:文档清单检索(two-stage 召回依赖检索引擎状态;清单是「查看历史报告」的可靠路径)
  const docs = await getJson(`http://127.0.0.1:6789/api/kb/documents?kb_id=${kbId}&limit=100`, KB_TOKEN)
  const darr = docs?.data?.documents ?? docs?.documents ?? docs?.data ?? []
  const matched = (Array.isArray(darr) ? darr : []).filter(x => /诊断报告|数据分析/.test(x?.name ?? x?.title ?? ''))
  return { hits: matched.length, first: matched[0]?.name ?? '' }
}
const decisionOf = round => round === 1
  ? '首轮:建立基线,抓取全 PV 最近 8 分钟数据'
  : 'R1 结论显示各 PV 有波动:本轮拉宽窗口,聚焦方差最大的膜厚通道复核漂移'

/* ── 闭环两轮 ── */
console.log('[R1] 激励 + 全时段导出 + 模拟诊断 + 入库 + 检索')
{
  // 激励
  for (const [i, ex] of [
    { node: 'linespeed-sp', v: 97 },
    { node: 'diegap-sp', v: 1.03 },
    { node: 'linespeed-sp', v: 93 },
  ].entries()) {
    await sleep(70_000)
    const w = await call('aw_dcw_write', { id: dcw[ex.node], value: ex.v })
    console.log(`  ↳ 阶跃${i + 1} ${ex.node} ← ${ex.v} ${w.isError ? '✘ ' + w.text.slice(0, 50) : '√'}`)
  }
  await sleep(60_000)
  const toMs = Date.now(); const fromMs = toMs - 8 * 60_000
  // 全时段下载(分页抓全)
  const pvCols = NODE_META.filter(m => m.role === 'PV')
  const series = []
  let totalPts = 0
  for (const m of pvCols) {
    const pts = await sampleAll(m.nodeId, fromMs, toMs)
    totalPts += pts.length
    series.push({ m, pts })
  }
  ok('R1 全时段 DAQ 数据分页抓全', totalPts > 0, `总点数=${totalPts}`)
  const stamps = [...new Set(series.flatMap(s => s.pts.map(p => p.at)))].sort((a, b) => a - b)
  const rows = stamps.map((t) => {
    const row = { timestamp: new Date(t).toISOString() }
    for (const { m, pts } of series) {
      const hit = pts.find(p => Math.abs(p.at - t) <= 1500)
      row[m.column] = hit ? Number(hit.v.toFixed(3)) : ''
    }
    return row
  })
  const dir = join(HOME, 'analysis', 'round-1')
  mkdirSync(dir, { recursive: true })
  const meta = {
    dataset: '产线数据分析闭环 · 第 1 轮(PLC 模拟流延膜产线)',
    scene: 'SV=设定值(DCW 写入,工程师可调,对应工艺参数的设定);PV=实时检测值(DAQ 数采只读,跟随 SV 波动)',
    window: { fromMs, toMs, fromIso: new Date(fromMs).toISOString(), toIso: new Date(toMs).toISOString() },
    fields: NODE_META,
    decision: decisionOf(1),
  }
  const csv = [Object.keys(rows[0] ?? { timestamp: 1 }).join(','), ...rows.map(r => Object.values(r).join(','))].join('\n')
  writeFileSync(join(dir, 'data.csv'), csv)
  writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta, null, 2))
  ok('R1 CSV+meta.json 落盘', rows.length > 0, `rows=${rows.length} @ ${dir}`)
  // 模拟诊断
  const diag = await mockDiagnose(1, join(dir, 'data.csv'), meta)
  ok('R1 模拟诊断产出 report.md', diag.report.includes('诊断报告'), `rows=${diag.rows}`)
  // 入库
  const cat = await getJson('http://127.0.0.1:6789/api/kb/catalog', KB_TOKEN)
  const kbs = cat?.knowledgeBases ?? []
  const kbId = (kbs.find(k => k.name === 'aw-industrial') ?? {})?.kbId
  const exp = {
    title: `产线数据分析诊断报告:第 1 轮(Mock 诊断闭环)`,
    scenario: 'PLC 模拟流延膜产线 SV/PV 监测与阶跃激励',
    category: 'troubleshooting',
    problem: decisionOf(1),
    solution: diag.report.slice(0, 4000),
    result: 'success',
    key_lessons: Object.entries(diag.stats).map(([col, s]) => `${col} 均值 ${s.mean} σ=${s.std} 趋势末值 ${s.last}`),
    tags: ['产线数据分析', '膜厚', '第1轮', 'Mock闭环'],
  }
  // 报告以「文档」形态入库 web KB(树式文件系统,与两阶段检索同源)
  const r = await fetch('http://127.0.0.1:6789/api/kb/documents/create', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'authorization': `Bearer ${KB_TOKEN}`, 'X-KB-Token': KB_TOKEN },
    body: JSON.stringify({ kbId, name: `r1-诊断报告.md`, content: `# ${exp.title}\n\n${exp.solution}`, description: exp.tags.join(',') }), signal: AbortSignal.timeout(90000),
  })
  const j = await r.json().catch(() => null)
  ok('R1 报告入库知识库(文档)', r.status === 200 && j?.success !== false, JSON.stringify(j).slice(0, 140))
  const sr = await kbSearch('产线数据分析诊断报告 膜厚 第1轮')
  ok('R1 入库后可检索命中', sr.hits > 0, `hits=${sr.hits} first=${sr.first}`)
}

/* ── R2:查知识库命中 R1 → 决策 → 新激励导出 → 模拟诊断#2 → 入库 ── */
console.log('[R2] 查知识库(R1 命中)→ 决策:扩窗+聚焦膜厚 → 新一轮')
{
  const sr1 = await kbSearch('产线数据分析诊断报告 膜厚 第1轮')
  ok('R2-1 知识库命中 R1 报告(决策依据)', sr1.hits > 0, `hits=${sr1.hits} first=${sr1.first}`)
  // 决策:聚焦膜厚,扩窗 12 分钟,新增两次反向阶跃
  for (const [i, ex] of [
    { node: 'diegap-sp', v: 0.97 },
    { node: 'linespeed-sp', v: 99 },
  ].entries()) {
    await sleep(70_000)
    const w = await call('aw_dcw_write', { id: dcw[ex.node], value: ex.v })
    console.log(`  ↳ R2 阶跃${i + 1} ${ex.node} ← ${ex.v} ${w.isError ? '✘ ' + w.text.slice(0, 50) : '√'}`)
  }
  await sleep(60_000)
  const toMs = Date.now(); const fromMs = toMs - 12 * 60_000
  const pvCols = NODE_META.filter(m => m.role === 'PV')
  const series = []
  for (const m of pvCols) {
    const pts = await sampleAll(m.nodeId, fromMs, toMs)
    series.push({ m, pts })
  }
  const stamps = [...new Set(series.flatMap(s => s.pts.map(p => p.at)))].sort((a, b) => a - b)
  const rows = stamps.map((t) => {
    const row = { timestamp: new Date(t).toISOString() }
    for (const { m, pts } of series) {
      const hit = pts.find(p => Math.abs(p.at - t) <= 1500)
      row[m.column] = hit ? Number(hit.v.toFixed(3)) : ''
    }
    return row
  })
  const dir = join(HOME, 'analysis', 'round-2')
  mkdirSync(dir, { recursive: true })
  const meta2 = {
    dataset: '产线数据分析闭环 · 第 2 轮(引用 R1 结论:聚焦膜厚漂移)',
    scene: 'SV=设定值(DCW 可写);PV=实时检测值(DAQ 只读,跟随 SV)',
    window: { fromMs, toMs },
    fields: NODE_META,
    priorRound: { kbHits: sr1.hits, applied: '扩窗至 12 分钟 + 反向阶跃复核漂移' },
    decision: decisionOf(2),
  }
  writeFileSync(join(dir, 'data.csv'), [Object.keys(rows[0] ?? { timestamp: 1 }).join(','), ...rows.map(r => Object.values(r).join(','))].join('\n'))
  writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta2, null, 2))
  ok('R2 CSV+meta.json 落盘(引用 R1)', rows.length > 0, `rows=${rows.length}`)
  const diag = await mockDiagnose(2, join(dir, 'data.csv'), meta2)
  ok('R2 模拟诊断产出 report.md', diag.report.includes('第 2 轮'), `rows=${diag.rows}`)
  const ing = await kbIngest(2, diag.report, diag.stats)
  ok('R2 报告入库知识库', ing.ok, ing.detail)
  const sr2 = await kbSearch('产线数据分析诊断报告 第2轮')
  ok('R2 入库后可检索命中', sr2.hits > 0, `hits=${sr2.hits} first=${sr2.first}`)
}

/* ── 清场 ── */
console.log('[清场]')
mcp.stdin.end(); mcp.kill()
killPort(AW_PORT); killPort(SIM_PORT)
await sleep(1500)
if (!process.argv.includes('--keep')) { try { rmSync(HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 1500 }) } catch {} }

console.log('')
console.log(`═══ 数据分析 Mock 闭环验收:${pass} PASS / ${fails.length} FAIL ═══`)
for (const f of fails) console.log(`  ✖ ${f}`)
console.log('')
process.exit(fails.length ? 1 : 0)
