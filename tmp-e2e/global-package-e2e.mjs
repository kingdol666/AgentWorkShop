#!/usr/bin/env node
/**
 * tmp-e2e/global-package-e2e.mjs —— npm 全局包(agentworkshop@0.7.59)验收:
 * 全新 home 实例(3111) → 注册 admin → 双插件桥健康 → PLC 模拟(4029) → 建线(3SV+3PV)
 * → 优化频道装配 → 数采自动抓取 → 阶跃激励 → 产线报告 skill R1 → KB 入库/检索
 * → 新工况 R2 → skill → 入库 → 双报告可检索。
 *
 * 前置:aw(global) 已安装;rag 8770/6789 与 IDD 8764 在线;NUXT_SESSION_PASSWORD 由启动方注入。
 * 用法:node tmp-e2e/global-package-e2e.mjs [--keep]
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BASE = 'http://127.0.0.1:3111'
const SIM_PORT = 4029
const SIM = `http://127.0.0.1:${SIM_PORT}`
const KB_BASE = 'http://127.0.0.1:8770'
const KB_WEB = 'http://127.0.0.1:6789'
const KB_TOKEN = readFileSync(join(REPO, '.kb-token.tmp'), 'utf8').trim()
const IDD_PROJECT = 'D:/codes/myskills/industrial-deep-diagnostic'
const SKILL = join(IDD_PROJECT, '.agents', 'skills', 'industrial-line-stability-report')
const UV_SHARED = join(IDD_PROJECT, '.claude', 'shared', 'scripts')
const OUT = join(REPO, '.AgentWorkShop', 'analysis', 'global-0758-e2e')
// 全局包解析(npm -g 安装位置)
const npmRoot = (spawnSync('npm', ['root', '-g'], { encoding: 'utf8', shell: true }).stdout ?? '').trim().split('\n').pop()?.trim() ?? ''
const GLOBAL_ROOT = join(npmRoot, 'agentworkshop')
const GLOBAL_AW = join(GLOBAL_ROOT, 'bin', 'aw.mjs')
if (!existsSync(GLOBAL_AW)) {
  console.error(`[global-e2e] 全局包未安装或路径不对: ${GLOBAL_ROOT}`)
  process.exit(2)
}
process.env.NO_PROXY = '127.0.0.1,localhost'
process.env.HTTP_PROXY = ''
process.env.HTTPS_PROXY = ''

let pass = 0
const fails = []
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✔ ${name}`) }
  else { fails.push(name); console.log(`  ✖ ${name}${detail ? ` — ${String(detail).slice(0, 200)}` : ''}`) }
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
const api = async (method, path, body) => {
  const r = await fetch(BASE + path, {
    method, headers: { 'content-type': 'application/json', 'authorization': `Bearer ${TOKEN}` },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(120_000),
  })
  return { status: r.status, ...(await r.json().catch(() => ({}))) }
}
const py = (script, args, timeoutMs = 240_000) => {
  const r = spawnSync('uv', ['run', '--project', UV_SHARED, 'python', join(SKILL, 'scripts', script), ...args],
    { encoding: 'utf8', timeout: timeoutMs })
  return { code: r.status, out: `${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim() }
}

let TOKEN = ''

/* ── G0 平台门 + 全局包身份 ── */
console.log('\n[G0] 平台门(全局包 3111 实例)')
const health = await fetch(`${BASE}/api/health`).then(r => r.json()).catch(() => null)
ok('平台健康', health?.data?.status === 'ok', `v=${health?.data?.version} mode=${health?.data?.mode}`)
const verOut = spawnSync(process.execPath, [GLOBAL_AW, '--version'], { encoding: 'utf8', timeout: 60_000 })
ok('全局包版本 = 0.7.59(与远端一致)', /0\.7\.59/.test(verOut.stdout ?? ''), (verOut.stdout ?? verOut.stderr ?? '').trim().slice(0, 60))
let reg = await api('POST', '/api/users/login', { email: 'global0758@awshop.local', password: 'Global@0758Test' })
if (!reg?.data?.token) reg = await api('POST', '/api/users/register', { name: '全局包验收管理员', email: 'global0758@awshop.local', password: 'Global@0758Test' })
TOKEN = reg?.data?.token ?? ''
ok('首注册即 admin(全新 home)', !!TOKEN, reg?.message ?? '')
const mf = await fetch(`${BASE}/api/plugins/manifest`, { headers: { authorization: `Bearer ${TOKEN}` } }).then(r => r.json()).catch(() => null)
const pl = mf?.plugins ?? []
const names = pl.map(x => x.name)
ok('内置插件装载(含三桥)', pl.length >= 7 && ['rag-bridge', 'diag-bridge', 'serial-bridge'].every(n => names.includes(n)), `plugins=${pl.length}: ${names.join(',')}`)
for (const p of ['rag-bridge', 'diag-bridge']) {
  const s = await fetch(`${BASE}/api/plugins/${p}/health`, { headers: { authorization: `Bearer ${TOKEN}` } }).then(r => r.json()).catch(() => null)
  const d = s?.data ?? s ?? {}
  ok(`${p} 桥(token 接受+上游 ok)`, d?.token?.accepted === true && (d?.remote?.status === 'ok' || d?.backend?.status === 'healthy' || d?.backend?.ok === true),
    JSON.stringify({ token: d?.token, remote: d?.remote?.status, backend: d?.backend?.status ?? d?.backend?.ok }).slice(0, 110))
}

/* ── MCP(全局包:走 `aw mcp` CLI 入口 —— 直连脚本文件在 nvm-windows junction 下 isMain 失配静默退出,0.7.59 实测) ── */
const mcp = spawn(process.execPath, [GLOBAL_AW, 'mcp'], {
  cwd: dirname(GLOBAL_AW),
  env: { ...process.env, NO_PROXY: '127.0.0.1,localhost', HTTP_PROXY: '', HTTPS_PROXY: '', AW_TOKEN: TOKEN, AW_MODE: 'home', AW_HOME: 'D:/codes/ABO/aw-global-0758/.AgentWorkShop' },
  stdio: ['pipe', 'pipe', 'pipe'],
})
const rl = createInterface({ input: mcp.stdout })
const pending = new Map(); let nextId = 1
rl.on('line', (line) => {
  try { const m = JSON.parse(line); if (m?.id != null && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
  catch { /* 忽略 */ }
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
const ping = await call('aw_status', {}, 60_000)
ok('全局包 MCP 通道(aw_status)', !ping.isError, ping.text.slice(0, 80))

/* ── G1 PLC 模拟器(4029) ── */
console.log('\n[G1] PLC 模拟器(4029, cast-film-physics)')
{
  const psi = spawnSync('powershell', ['-NoProfile', '-Command',
    `Get-NetTCPConnection -LocalPort ${SIM_PORT} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess`], { encoding: 'utf8' })
  const pid = Number(psi.stdout.trim())
  if (Number.isInteger(pid) && pid > 0) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
  await sleep(1500)
  process.env.SIM_BASE = SIM
  process.env.SIM_SHADOW_DIR = `D:/codes/ABO/plc-node-simulator-bench-${SIM_PORT}`
  const { ensureSimulator, applyPreset } = await import('../bench/lib/sim.mjs')
  await ensureSimulator({ log: () => {} })
  await applyPreset('cast-film-physics')
}
const simState = await fetch(`${SIM}/api/plant/state`).then(r => r.json()).catch(() => null)
ok('模拟器运行中', simState?.data?.running === true, JSON.stringify(simState?.data ?? {}).slice(0, 80))
const simDevices = (await fetch(`${SIM}/api/nodes`).then(r => r.json()).catch(() => null))?.data ?? []
ok('模拟器节点在册', Array.isArray(simDevices) && simDevices.length > 0, `nodes=${simDevices.length}`)

/* ── G2 建线 ── */
console.log('\n[G2] 建线 + 配方 + 开跑')
const line = await call('aw_line_create', { name: `全局包验收线-${Date.now().toString(36)}` })
const lineId = line.data?.line?.id ?? line.data?.id
ok('产线创建', !!lineId, line.text.slice(0, 100))
const product = await call('aw_product_create', { lineId, name: '全局包验收产品' })
const productId = product.data?.product?.id ?? product.data?.id
ok('产品创建', !!productId, product.text.slice(0, 80))
const dcw = {}, daq = {}
const wantAct = [
  { id: 'zone1-sp', sem: 'SV:一区加热温度' },
  { id: 'linespeed-sp', sem: 'SV:产线速度' },
  { id: 'diegap-sp', sem: 'SV:模口间隙' },
]
const wantSen = [
  { id: 'melt-temp', sem: 'PV:熔体温度' },
  { id: 'melt-pressure', sem: 'PV:熔体压力' },
  { id: 'film-thickness', sem: 'PV:流延膜厚度(质量目标)' },
]
for (const dev of simDevices) {
  const exp = (await fetch(`${SIM}/api/nodes/${dev.id}/export`).then(r => r.json()).catch(() => null))?.data?.items ?? []
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
ok('建节点 3 SV + 3 PV', wantAct.every(w => dcw[w.id]) && wantSen.every(w => daq[w.id]), `dcw=${Object.keys(dcw).length} daq=${Object.keys(daq).length}`)
const recipe = await call('aw_recipe_create', {
  productId, name: '全局包基线配方', description: '全局包验收基线',
  params: [
    { nodeId: dcw['zone1-sp'], value: 200, min: 190, max: 225 },
    { nodeId: dcw['linespeed-sp'], value: 95, min: 85, max: 110 },
    { nodeId: dcw['diegap-sp'], value: 1.0, min: 0.85, max: 1.15 },
  ],
})
const recipeId = recipe.data?.recipe?.id ?? recipe.data?.id
ok('基线配方创建', !!recipeId, recipe.text.slice(0, 90))
const ctl = await call('aw_daq_controller', { action: 'start' })
ok('数采控制器启动', !ctl.isError, ctl.text.slice(0, 70))
const ls0 = await call('aw_line_start', { lineId, recipeId })
ok('产线开跑', !ls0.isError, ls0.text.slice(0, 70))
const lineStartAt = Date.now()

/* ── G3 优化频道 ── */
console.log('\n[G3] 优化作业频道')
const inst = await api('POST', '/api/workshop/channel-templates/chtpl-generic-optimize-default/instantiate',
  { name: `全局包优化频道-${Date.now().toString(36)}`, bindLineId: lineId, enableKnowledgeBase: true })
const channelId = inst?.data?.channelId ?? inst?.data?.channel?.id ?? ''
ok('频道实例化(KB 开+绑线)', !!channelId, JSON.stringify(inst?.message ?? inst?.data ?? {}).slice(0, 100))
const chListOf = async () => {
  const d = (await api('GET', '/api/workshop/channels'))?.data
  return d?.items ?? (Array.isArray(d) ? d : [])
}
let leadId = inst?.data?.leadAgentId ?? ''
for (let i = 0; i < 15 && !leadId; i++) { await sleep(2000); leadId = (await chListOf()).find(c => c.id === channelId)?.leadAgentId ?? '' }
ok('lead 身份可读', !!leadId, String(leadId).slice(0, 10))
let members = []
for (let i = 0; i < 10; i++) {
  const raw = (await api('GET', `/api/workshop/channels/${channelId}/agents`))?.data
  members = raw?.items ?? (Array.isArray(raw) ? raw : raw?.agents ?? [])
  if (members.length >= 4) break
  await sleep(2000)
}
ok('四成员编成', members.length >= 4, members.map(m => m.name).join('/'))
const byName = n => members.find(m => String(m.name).includes(n))?.agentId ?? members.find(m => String(m.name).includes(n))?.id ?? ''
const analystId = byName('数据分析师'); const procEngId = byName('工艺工程师')
let bindOk = 0
for (const [nodeId, kind] of [[recipeId, 'recipe'], ...Object.values(daq).map(id => [id, 'daq'])]) {
  const g = await api('POST', '/api/workshop/agent-tools/bindings', { agentId: leadId, nodeId, kind, mode: 'manual' })
  if (g?.code === 0 || g?.status === 200) bindOk++
}
ok('lead 绑定(recipe+3 DAQ)', bindOk === 4, `${bindOk}/4`)
const gp = await api('POST', '/api/workshop/agent-tools/bindings/grant', { channelId, agentId: procEngId, nodeIds: [recipeId, ...Object.values(daq)], mode: 'manual' })
const ga = await api('POST', '/api/workshop/agent-tools/bindings/grant', { channelId, agentId: analystId, nodeIds: Object.values(daq), mode: 'manual' })
ok('委托(工艺工程师+数据分析师)', gp?.code === 0 && ga?.code === 0, `${gp?.code}/${ga?.code}`)
const act = await api('POST', `/api/workshop/channels/${channelId}/activate`, {})
ok('频道激活', act?.code === 0 || act?.status === 200, act?.message ?? '')

/* ── G4 数采验证 + 激励 + R1 ── */
console.log('\n[G4] 数采自动抓取 + R1 激励')
await sleep(75_000)
let sampleOk = 0
for (const w of wantSen) {
  const s = await call('aw_daq_samples', { id: daq[w.id], from: lineStartAt, to: Date.now(), bucketMs: 5000, limit: 200 })
  if ((s.data?.points ?? []).length > 0) sampleOk++
}
ok('3 路 PV 自动样本', sampleOk === 3, `${sampleOk}/3`)
const w1 = await call('aw_dcw_write', { id: dcw['linespeed-sp'], value: 97 })
ok('R1 激励:线速 95→97', !w1.isError, w1.text.slice(0, 70))
await sleep(150_000)
const exportCsv = async (fromMs, toMs, file) => {
  const series = []
  for (const [col, id] of [['melt_temp', daq['melt-temp']], ['melt_pressure', daq['melt-pressure']], ['film_thickness', daq['film-thickness']]]) {
    const r = await call('aw_daq_samples', { id, from: fromMs, to: toMs, bucketMs: 2000, limit: 1000 })
    const pts = (r.data?.points ?? []).map(p => ({ at: Number(p.at ?? 0), v: Number(p.avg ?? p.value) })).filter(p => Number.isFinite(p.v)).sort((a, b) => a.at - b.at)
    series.push({ col, pts })
  }
  const stamps = [...new Set(series.flatMap(s => s.pts.map(p => p.at)))].sort((a, b) => a - b)
  const rows = stamps.map((t) => {
    const row = { timestamp: new Date(t).toISOString() }
    for (const { col, pts } of series) {
      const hit = pts.find(p => Math.abs(p.at - t) <= 2000)
      row[col] = hit ? Number(hit.v.toFixed(3)) : ''
    }
    return row
  })
  writeFileSync(file, [Object.keys(rows[0] ?? { timestamp: '' }).join(','), ...rows.map(r => Object.values(r).join(','))].join('\n'))
  return { rows: rows.length, first: rows[0]?.timestamp, last: rows[rows.length - 1]?.timestamp }
}
mkdirSync(join(OUT, 'round-1'), { recursive: true })
const r1To = Date.now(); const r1From = r1To - 4 * 60_000
const r1 = await exportCsv(r1From, r1To, join(OUT, 'round-1', 'data.csv'))
ok(`R1 窗口导出(rows=${r1.rows},末点新鲜)`, r1.rows >= 50 && Date.parse(r1.last) > r1To - 120_000, `${r1.first} → ${r1.last}`)

/* ── G5 R1 skill + KB ── */
console.log('\n[G5] R1 产线报告 skill + KB 入库/检索')
const runSkill = async (dataCsv, outDir) => {
  const a = py('stability_analyzer.py', ['analyze', '--data', dataCsv, '--time-col', 'timestamp', '--out-dir', outDir])
  const repPath = join(outDir, 'stability_report.json')
  const rep = existsSync(repPath) ? JSON.parse(readFileSync(repPath, 'utf8')) : null
  const b = py('report_builder.py', ['--report', repPath, '--charts', join(outDir, 'charts.json')])
  const g = spawnSync('node', [join(SKILL, 'scripts', 'quality_gate.mjs'), repPath, outDir], { encoding: 'utf8', timeout: 120_000 })
  return { rep, htmlOk: existsSync(join(outDir, 'line_stability_report.html')), gate: g.status, analyzeExit: a.code }
}
const r1s = await runSkill(join(OUT, 'round-1', 'data.csv'), join(OUT, 'round-1'))
ok('R1 skill(分析+HTML+门禁)', (r1s.analyzeExit === 0 || r1s.analyzeExit === 1) && r1s.htmlOk && r1s.gate === 0 && Number.isFinite(r1s.rep?.conclusion?.score),
  `score=${r1s.rep?.conclusion?.score} grade=${r1s.rep?.conclusion?.grade} gate=${r1s.gate}`)
console.log(`    ↳ R1: score=${r1s.rep?.conclusion?.score} grade=${r1s.rep?.conclusion?.grade}`)
const cat = await fetch(`${KB_WEB}/api/kb/catalog`, { headers: { authorization: `Bearer ${KB_TOKEN}` } }).then(r => r.json()).catch(() => null)
const kbId = ((cat?.knowledgeBases ?? []).find(k => k.name === 'aw-industrial') ?? {})?.kbId ?? ''
ok('KB aw-industrial 在册', !!kbId)
const searchKB = async (query) => {
  const j = await fetch(`${KB_BASE}/api/v1/experience/${kbId}/search`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'authorization': `Bearer ${KB_TOKEN}`, 'X-KB-Token': KB_TOKEN },
    body: JSON.stringify({ query, top_k: 5 }), signal: AbortSignal.timeout(60_000),
  }).then(r => r.json()).catch(() => null)
  return j?.experiences ?? j?.results ?? []
}
const ingestExp = async (body) => {
  const j = await fetch(`${KB_BASE}/api/v1/experience/${kbId}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'authorization': `Bearer ${KB_TOKEN}`, 'X-KB-Token': KB_TOKEN },
    body: JSON.stringify(body), signal: AbortSignal.timeout(60_000),
  }).then(r => r.json()).catch(e => ({ err: e.message }))
  return { id: j?.id ?? j?.experience?.id ?? '', raw: j }
}
const mkSolution = rep => [
  `综合评分 ${rep?.conclusion?.score}(${rep?.conclusion?.grade} 级),发现 ${rep?.conclusion?.n_findings} 条。`,
  ...(rep?.findings ?? []).slice(0, 6).map(f => `- [${f.severity}] ${f.title ?? f.summary ?? ''}(置信度 ${f.confidence})`),
].join('\n')
const g1 = await ingestExp({
  title: `全局包验收 R1 稳定性报告:线速阶跃(${lineId.slice(0, 10)})`,
  scenario: 'npm 全局包 0.7.59 全新实例,PLC 模拟流延膜产线,线速 95→97 阶跃后稳定性评估',
  category: 'troubleshooting', problem: '线速阶跃后产线是否稳定',
  solution: mkSolution(r1s.rep), result: ['A', 'B'].includes(r1s.rep?.conclusion?.grade) ? 'success' : 'partial',
  key_lessons: [`score=${r1s.rep?.conclusion?.score} grade=${r1s.rep?.conclusion?.grade}`],
  tags: ['全局包验收', '流延膜', '稳定性报告', 'R1'], metrics: { source: 'global-e2e', rows: r1.rows },
})
ok('R1 入库(拿到 id)', !!g1.id, g1.id || JSON.stringify(g1.raw).slice(0, 100))
let hit1 = []
for (let i = 0; i < 6; i++) {
  await sleep(10_000)
  hit1 = await searchKB('全局包验收 R1 稳定性报告 线速阶跃')
  if (hit1.some(h => /全局包验收 R1/.test(String(h.title ?? '')))) break
}
ok('R1 检索命中', hit1.some(h => /全局包验收 R1/.test(String(h.title ?? ''))), `hits=${hit1.length}`)

/* ── G6 R2(检索定口径 → 新工况 → skill → KB) ── */
console.log('\n[G6] R2:检索定口径 → 模口强阶跃 → skill → KB')
const r1Hits = await searchKB('全局包验收 R1 稳定性报告')
const r1Own = r1Hits.find(h => /全局包验收 R1/.test(String(h.title ?? ''))) ?? {}
ok('R2 前置检索命中 R1(定口径)', /全局包验收 R1/.test(String(r1Own?.title ?? '')), String(r1Own?.title ?? '').slice(0, 60))
const w2 = await call('aw_dcw_write', { id: dcw['diegap-sp'], value: 0.94 })
ok('R2 激励:模口 1.0→0.94', !w2.isError, w2.text.slice(0, 70))
await sleep(150_000)
mkdirSync(join(OUT, 'round-2'), { recursive: true })
const r2To = Date.now(); const r2From = r2To - 3 * 60_000
const r2 = await exportCsv(r2From, r2To, join(OUT, 'round-2', 'data.csv'))
ok(`R2 窗口导出(rows=${r2.rows},末点新鲜)`, r2.rows >= 50 && Date.parse(r2.last) > r2To - 120_000, `${r2.first} → ${r2.last}`)
const r2s = await runSkill(join(OUT, 'round-2', 'data.csv'), join(OUT, 'round-2'))
ok('R2 skill(分析+HTML+门禁)', (r2s.analyzeExit === 0 || r2s.analyzeExit === 1) && r2s.htmlOk && r2s.gate === 0 && Number.isFinite(r2s.rep?.conclusion?.score),
  `score=${r2s.rep?.conclusion?.score} grade=${r2s.rep?.conclusion?.grade} gate=${r2s.gate}`)
console.log(`    ↳ R2: score=${r2s.rep?.conclusion?.score} grade=${r2s.rep?.conclusion?.grade}`)
const g2 = await ingestExp({
  title: `全局包验收 R2 稳定性报告:模口强阶跃(引用 R1 结论)`,
  scenario: 'npm 全局包 0.7.59,检索 R1 定口径后,模口 1.0→0.94 强阶跃新窗口继续分析',
  category: 'troubleshooting', problem: '模口强阶跃下稳定性变化;与 R1 对比',
  solution: `前置口径(R1):${String(r1Own?.solution ?? '').slice(0, 150)}\n${mkSolution(r2s.rep)}`,
  result: ['A', 'B'].includes(r2s.rep?.conclusion?.grade) ? 'success' : 'partial',
  key_lessons: [`score=${r2s.rep?.conclusion?.score} grade=${r2s.rep?.conclusion?.grade}`, '先检索后分析闭环'],
  tags: ['全局包验收', '流延膜', '稳定性报告', 'R2'], metrics: { source: 'global-e2e', rows: r2.rows },
})
ok('R2 入库(拿到 id)', !!g2.id, g2.id || JSON.stringify(g2.raw).slice(0, 100))
let hitBoth = []
for (let i = 0; i < 6; i++) {
  await sleep(10_000)
  hitBoth = await searchKB('全局包验收 稳定性报告 流延膜')
  const s = JSON.stringify(hitBoth)
  if (s.includes('全局包验收 R1') && s.includes('全局包验收 R2')) break
}
const sBoth = JSON.stringify(hitBoth)
ok('两轮报告均可持续检索', sBoth.includes('全局包验收 R1') && sBoth.includes('全局包验收 R2'), `hits=${hitBoth.length}`)

/* ── 收尾 ── */
console.log('\n[收尾]')
mcp.stdin.end(); mcp.kill()
console.log(`产物目录:${OUT}`)
console.log('')
console.log('════════════════════════════════════════')
console.log(`  全局包(npm 0.7.59)验收:${pass} PASS / ${fails.length} FAIL`)
for (const f of fails) console.log(`  ✖ ${f}`)
console.log('════════════════════════════════════════')
console.log(`实例: ${BASE}(全新 home)  产线: ${lineId}  频道: ${channelId}`)
console.log(`R1: score=${r1s.rep?.conclusion?.score} grade=${r1s.rep?.conclusion?.grade} | R2: score=${r2s.rep?.conclusion?.score} grade=${r2s.rep?.conclusion?.grade}`)
process.exit(fails.length ? 1 : 0)
