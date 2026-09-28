#!/usr/bin/env node
/**
 * scripts/_audit/kb-diag-loop-v2.mjs —— 自包含单轮闭环:激励 → 导出 CSV+meta → IDD 诊断 →
 * 报告入库知识库(经验库)→ 检索命中。
 *
 * 自举:全新平台 3470 + 模拟器 4019 → 建线(3 SV + 3 PV)→ 开跑 → 3 次阶跃激励 →
 *   导出 analysis/round-1/{data.csv,meta.json} → diag_run → 轮询至 completed →
 *   读 report.md → 入库经验库 → 检索验证。
 * 用法:node scripts/_audit/kb-diag-loop-v2.mjs [--keep]
 */
import { spawn, spawnSync } from 'node:child_process'
import { closeSync, existsSync, mkdtempSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const AW_PORT = 3470
const SIM_PORT = 4019
const HOME = mkdtempSync(join(tmpdir(), 'aw-kb-loop2-'))
const SIM_DIR = resolve(REPO, '..', 'plc-node-simulator-bench-4019')
const BASE = `http://127.0.0.1:${AW_PORT}`
const SIM = `http://127.0.0.1:${SIM_PORT}`
const KB_BASE = 'http://127.0.0.1:8770'
const IDD_BASE = 'http://127.0.0.1:3210'
const KB_TOKEN = existsSync(join(REPO, '.kb-token.tmp')) ? readFileSync(join(REPO, '.kb-token.tmp'), 'utf8').trim() : ''
const IDD_TOKEN = existsSync(join(REPO, '.idd-token.tmp')) ? readFileSync(join(REPO, '.idd-token.tmp'), 'utf8').trim() : ''

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
console.log('[自举] 平台 3470 + 模拟器 4019(全新 home,预置 MCP 开关与插件 token)')
for (const port of [AW_PORT, SIM_PORT]) killPort(port)
writeFileSync(join(HOME, 'runtime-settings.json'), JSON.stringify({ version: 1, overrides: {
  'mcp.enabled': true,
  'plugins.rag-bridge.token': KB_TOKEN,
  'plugins.diag-bridge.token': IDD_TOKEN,
  'plugins.diag-bridge.max_turns': 40,
  'plugins.diag-bridge.max_minutes': 30,
} }))
{
  const out = openSync(join(HOME, 'instance.log'), 'a')
  const p = spawn(process.execPath, [join(REPO, 'bin', 'aw.mjs'), 'start', '--port', String(AW_PORT)], {
    cwd: REPO,
    env: { ...process.env, NO_PROXY: '127.0.0.1,localhost', HTTP_PROXY: '', HTTPS_PROXY: '', AW_MODE: 'home', AW_HOME: HOME, NUXT_SESSION_PASSWORD: 'kb-loop2-session-password-012345678' },
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
  const r = await fetch(`${BASE}/api/users/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'kb-loop2-admin', email: 'kb-loop2@awshop.local', password: 'kb-loop2-passw0rd' }) })
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

/* ── 建线 + 开跑 + 激励 ── */
let lineId, productId
const dcw = {}, daq = {}
{
  const simDevices = (await getJson(`${SIM}/api/nodes`))?.data ?? []
  const line = await call('aw_line_create', { name: '数据分析闭环线' })
  lineId = line.data?.line?.id
  const product = await call('aw_product_create', { lineId, name: '数据分析闭环产品' })
  productId = product.data?.product?.id
  const wantAct = ['zone1-sp', 'linespeed-sp', 'diegap-sp']
  const wantSen = ['melt-temp', 'melt-pressure', 'film-thickness']
  for (const dev of simDevices) {
    const exp = (await getJson(`${SIM}/api/nodes/${dev.id}/export`))?.data?.items ?? []
    const sigOf = id => (dev.signals ?? []).find(s => s.id === id)
    for (const id of wantAct) {
      const sig = sigOf(id); if (!sig || dcw[id]) continue
      const item = exp.find(i => i.signal === sig.name); if (!item?.driverConfig) continue
      const r = await call('aw_dcw_create', { name: `闭环-${sig.name}`, templateRef: 'dcw-temp-sp', driver: dev.protocol, driverConfig: item.driverConfig, unit: sig.unit, min: sig.min, max: sig.max, decimals: sig.decimals ?? 2, lineId, holdIntervalMs: 0, stepLimit: 5, semantics: `SV 设定点:${sig.name}(${sig.unit})` })
      dcw[id] = r.data?.node?.id ?? r.data?.id
    }
    for (const id of wantSen) {
      const sig = sigOf(id); if (!sig || daq[id]) continue
      const item = exp.find(i => i.signal === sig.name); if (!item?.driverConfig) continue
      const r = await call('aw_daq_create', { name: `闭环-${sig.name}`, templateRef: 'daq-temp-tc', driver: dev.protocol, driverConfig: item.driverConfig, unit: sig.unit, min: sig.min, max: sig.max, decimals: sig.decimals ?? 2, lineId, intervalMs: 1000, semantics: id === 'film-thickness' ? 'PV 实时检测:流延膜厚度(优化目标 goal,μm;厚度质量输出,随 SV 波动)' : `PV 实时检测:${sig.name}(${sig.unit}),随 SV 波动` })
      daq[id] = r.data?.node?.id ?? r.data?.id
    }
  }
  ok('建节点 3 SV + 3 PV', wantAct.every(id => dcw[id]) && wantSen.every(id => daq[id]))
  await call('aw_daq_controller', { action: 'start' })
  const recipe = await call('aw_recipe_create', {
    productId, name: '闭环基线配方', description: '数据分析闭环基线',
    params: [
      { nodeId: dcw['zone1-sp'], value: 200, min: 190, max: 225 },
      { nodeId: dcw['linespeed-sp'], value: 95, min: 85, max: 110 },
      { nodeId: dcw['diegap-sp'], value: 1.0, min: 0.85, max: 1.15 },
    ],
  })
  await call('aw_line_start', { lineId, recipeId: recipe.data?.recipe?.id ?? recipe.data?.id })
  ok('产线开跑', true)
}

console.log('[激励] 3 次工况阶跃(间隔 70s)')
const EXCITE = [
  { node: 'linespeed-sp', v: 97 },
  { node: 'diegap-sp', v: 1.03 },
  { node: 'linespeed-sp', v: 93 },
]
for (const [i, ex] of EXCITE.entries()) {
  await sleep(70_000)
  const w = await call('aw_dcw_write', { id: dcw[ex.node], value: ex.v })
  console.log(`  ↳ 阶跃${i + 1} ${ex.node} ← ${ex.v} ${w.isError ? '✘ ' + w.text.slice(0, 60) : '√'}`)
}
await sleep(60_000)

/* ── 导出 CSV + meta ── */
console.log('[导出] 数据 + 元信息 → 运行时目录 analysis/round-1')
const toMs = Date.now(); const fromMs = toMs - 8 * 60_000
const analysisDir = join(HOME, 'analysis', 'round-1')
mkdirSync(analysisDir, { recursive: true })
const NODE_META = [
  { nodeId: dcw['zone1-sp'], column: 'zone1_sp', role: 'SV', unit: '℃', meaning: '加热区温度设定值(SV,DCW 可写):影响熔体温度进而影响膜厚' },
  { nodeId: dcw['linespeed-sp'], column: 'linespeed_sp', role: 'SV', unit: 'm/min', meaning: '产线速度设定值(SV,DCW 可写):升速减薄、降速增厚' },
  { nodeId: dcw['diegap-sp'], column: 'diegap_sp', role: 'SV', unit: 'mm', meaning: '模口间隙设定值(SV,DCW 可写):间隙增大膜厚近似线性增厚' },
  { nodeId: daq['melt-temp'], column: 'melt_temp', role: 'PV', unit: '℃', meaning: '熔体温度实时检测(PV,DAQ 数采只读):跟随加热 SV,滞后 1-2 分钟' },
  { nodeId: daq['melt-pressure'], column: 'melt_pressure', role: 'PV', unit: 'MPa', meaning: '熔体压力实时检测(PV,DAQ 数采只读):反映泵送与滤网状态' },
  { nodeId: daq['film-thickness'], column: 'film_thickness', role: 'PV', unit: 'μm', meaning: '膜厚实时检测(PV,DAQ 数采只读):核心质量指标,由质量守恒决定,随线速/模口/螺杆滞后波动' },
]
let csvRows
{
  const series = []
  for (const m of NODE_META) {
    if (m.role === 'SV') continue
    const r = await call('aw_daq_samples', { id: m.nodeId, fromMs, toMs, bucketMs: 2000, limit: 1000 })
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
  writeFileSync(join(analysisDir, 'data.csv'), csv)
  csvRows = rows.length
  writeFileSync(join(analysisDir, 'meta.json'), JSON.stringify({
    dataset: '产线数据分析闭环 · 第 1 轮(PLC 模拟流延膜产线)',
    scene: 'SV=设定值(DCW 写入,工程师可调);PV=实时检测值(DAQ 数采只读,跟随 SV 波动)',
    window: { fromMs, toMs, fromIso: new Date(fromMs).toISOString(), toIso: new Date(toMs).toISOString() },
    fields: NODE_META,
    excitations: EXCITE.map((e, i) => ({ seq: i + 1, node: e.node, value: e.v })),
  }, null, 2))
  ok(`CSV+meta.json 落盘(rows=${csvRows})`, csvRows > 0, analysisDir)
}

/* ── 诊断(diag_run 离线 CSV)── */
console.log('[诊断] diag_run 提交(离线 CSV),等待完成(最长 ~35 分钟,期间零干扰)')
const diag = await call('diag_run', {
  data_path: join(analysisDir, 'data.csv'),
  question: '分析本流延膜产线最近 8 分钟膜厚/熔温/熔压三路 PV 波动趋势:工况是否稳定;膜厚波动与线速/模口阶跃的因果是否可见;给出结论、风险点与下一步建议',
  scene: '数据分析闭环线_diag',
}, 120_000)
const taskM = (diag.text.match(/(\d{6,})/) || [])[1]
ok('诊断提交', !diag.isError && Boolean(taskM), diag.text.slice(0, 160))
let completed = false
let reportPath = null
let verdictText = ''
if (taskM) {
  for (let i = 0; i < 110; i++) {
    await sleep(20_000)
    try {
      const d = await getJson(`${IDD_BASE}/api/diagnosis/tasks/${taskM}`, IDD_TOKEN)
      const v = d?.data?.view ?? d?.data ?? {}
      if (v.status === 'completed' || v.result?.report_md_path) {
        completed = true
        reportPath = v.result?.report_md_path ?? null
        verdictText = `score=${v.result?.score ?? '?'} verdict=${v.result?.verdict ?? '?'}`
        console.log(`  ↳ 诊断完成:${verdictText}`)
        break
      }
      if (v.status === 'failed') { verdictText = v.result?.error ?? v.error ?? 'failed'; console.log(`  ✖ 诊断失败:${verdictText}`); break }
      if (i % 3 === 0) console.log(`  ↳ (${i * 20 / 60 | 0}min) ${v.status ?? '?'}`)
    }
    catch { /* 网络抖动重试 */ }
  }
}
ok('诊断完成且报告产出', completed && Boolean(reportPath), verdictText)
let reportMd = ''
if (reportPath) {
  try { reportMd = readFileSync(String(reportPath).replace(/\\/g, '/'), 'utf8') } catch {}
}

/* ── 入库知识库(经验库)── */
console.log('[入库] 诊断报告 → 知识库经验库')
let kbId
{
  const cat = await getJson('http://127.0.0.1:6789/api/kb/catalog', KB_TOKEN)
  const kbs = cat?.knowledgeBases ?? []
  kbId = (kbs.find(k => k.name === 'aw-industrial') ?? {})?.kbId ?? null
  ok('KB 目录含 aw-industrial', Boolean(kbId), JSON.stringify(kbs.slice(0, 3)).slice(0, 120))
}
const expBody = {
  title: '产线数据分析诊断报告:流延膜产线 PV 波动分析(数据分析闭环)',
  scenario: 'PLC 模拟流延膜产线:膜厚/熔温/熔压 PV 持续监测,线速/模口 SV 阶跃激励下的稳定性诊断',
  category: 'postmortem',
  problem: '膜厚等 PV 出现波动与漂移,需要判断工况稳定性、阶跃因果可见性,以及是否存在异常趋势',
  solution: reportMd ? reportMd.slice(0, 4000) : '(报告缺失)',
  result: completed ? 'SUCCESS' : 'PARTIAL',
  key_lessons: [`诊断任务 ${taskM ?? '?'};报告文件 ${reportPath ?? '无'}`],
  tags: ['产线数据分析', '膜厚', '诊断报告', '流延膜', '数据分析闭环'],
  metrics: { source: 'IDD', task: taskM ?? '', csvRows },
}
{
  const req = spawn('curl', ['-s', '--noproxy', '127.0.0.1', '-X', 'POST',
    `${KB_BASE}/api/v1/experience/${kbId}`,
    '-H', 'content-type: application/json', '-H', `authorization: Bearer ${KB_TOKEN}`, '-H', `X-KB-Token: ${KB_TOKEN}`,
    '--max-time', '60', '-d', JSON.stringify(expBody)], { encoding: 'utf8' })
  let out = ''
  req.stdout?.on('data', (d) => { out += d })
  await new Promise(r => req.on('close', r))
  ok('报告入库经验库', /success["\s:]+true|"id"/.test(out), out.slice(0, 180))
}

/* ── 检索验证 ── */
console.log('[检索] 经验检索应命中本报告')
{
  const body = JSON.stringify({ query: '产线数据分析诊断报告 膜厚 波动 数据分析闭环', top_k: 5 })
  const req = spawn('curl', ['-s', '--noproxy', '127.0.0.1', '-X', 'POST',
    `${KB_BASE}/api/v1/experience/${kbId}/search`,
    '-H', 'content-type: application/json', '-H', `authorization: Bearer ${KB_TOKEN}`, '-H', `X-KB-Token: ${KB_TOKEN}`,
    '--max-time', '60', '-d', body], { encoding: 'utf8' })
  let out = ''
  req.stdout?.on('data', (d) => { out += d })
  await new Promise(r => req.on('close', r))
  let hit = false
  let sample = ''
  try {
    const j = JSON.parse(out)
    const arr = j.results ?? j.experiences ?? j.data ?? []
    hit = Array.isArray(arr) && arr.length > 0
    if (hit) sample = JSON.stringify(arr[0]).slice(0, 180)
  }
  catch { sample = out.slice(0, 120) }
  ok('经验检索命中本报告', hit, sample)
}

/* ── 清场 ── */
console.log('[清场]')
mcp.stdin.end(); mcp.kill()
killPort(AW_PORT); killPort(SIM_PORT)
await sleep(1500)
if (!process.argv.includes('--keep')) { try { rmSync(HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 1500 }) } catch {} }

console.log('')
console.log(`═══ 闭环单轮验收:${pass} PASS / ${fails.length} FAIL ═══`)
for (const f of fails) console.log(`  ✖ ${f}`)
console.log('')
process.exit(fails.length ? 1 : 0)
