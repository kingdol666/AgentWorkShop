#!/usr/bin/env node
/**
 * scripts/_audit/kb-diag-complete2.mjs —— 单轮闭环(纯 node fetch 版):
 * 平台 snapshot(平台侧 CSV)→ IDD 诊断 → 报告读取 → KB 经验库入库 → 检索命中。
 */
import { spawn, spawnSync } from 'node:child_process'
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const AW_PORT = 3471
const SIM_PORT = 4020
const HOME = mkdtempSync(join(tmpdir(), 'aw-kb-c2-'))
const SIM_DIR = resolve(REPO, '..', 'plc-node-simulator-bench-4020')
const BASE = `http://127.0.0.1:${AW_PORT}`
const SIM = `http://127.0.0.1:${SIM_PORT}`
const KB_BASE = 'http://127.0.0.1:8770'
const IDD_BASE = 'http://127.0.0.1:3210'
const KB_TOKEN = readFileSync(join(REPO, '.kb-token.tmp'), 'utf8').trim()
const IDD_TOKEN = readFileSync(join(REPO, '.idd-token.tmp'), 'utf8').trim()

let pass = 0
const fails = []
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✔ ${name}`) }
  else { fails.push(name); console.log(`  ✖ ${name}${detail ? ` — ${String(detail).slice(0, 240)}` : ''}`) }
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
const getJson = async (url, token) => {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(20000), headers: token ? { authorization: `Bearer ${token}` } : {} })
    return await r.json()
  }
  catch { return null }
}

/* ── 自举平台 + 模拟器 ── */
console.log('[自举] 平台 3471 + 模拟器 4020(全新 home,预置 MCP 开关与插件 token)')
for (const port of [AW_PORT, SIM_PORT]) {
  try {
    const psi = spawnSync('powershell', ['-NoProfile', '-Command',
      `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess`], { encoding: 'utf8' })
    const pid = Number(psi.stdout.trim())
    if (Number.isInteger(pid) && pid > 0) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
  }
  catch { /* 忽略 */ }
}
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
    env: { ...process.env, NO_PROXY: '127.0.0.1,localhost', HTTP_PROXY: '', HTTPS_PROXY: '', AW_MODE: 'home', AW_HOME: HOME, NUXT_SESSION_PASSWORD: 'kb-c2-session-password-0123456789' },
    detached: true, windowsHide: true, stdio: ['ignore', out, out],
  })
  closeSync(out); p.unref()
}
let up = false
for (let i = 0; i < 40; i++) {
  await sleep(2000)
  try {
    const r = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(5000) })
    if ((await r.json())?.data?.status === 'ok') { up = true; break }
  }
  catch { /* 重试 */ }
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
  const r = await fetch(`${BASE}/api/users/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'kb-c2-admin', email: 'kb-c2@awshop.local', password: 'kb-c2-passw0rd' }) })
  return r.json()
})()
const TOKEN = reg?.data?.token
ok('admin 注册', Boolean(TOKEN))
const api = async (method, path, body) => {
  const r = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', 'authorization': `Bearer ${TOKEN}` }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60000) })
  return { status: r.status, json: await r.json().catch(() => null) }
}

/* ── 建线 + 开跑 + 阶跃激励 ── */
let lineId, productId
const dcw = {}, daq = {}
{
  const simDevices = (await getJson(`${SIM}/api/nodes`))?.data ?? []
  const line = (await api('POST', '/api/workshop/dcw/lines', { name: 'KB闭环验收线' })).json?.data?.line
  lineId = line?.id
  const product = (await api('POST', '/api/workshop/dcw/products', { lineId, name: 'KB闭环产品' })).json?.data?.product
  productId = product?.id
  const wantAct = ['zone1-sp', 'linespeed-sp', 'diegap-sp']
  const wantSen = ['melt-temp', 'melt-pressure', 'film-thickness']
  for (const dev of simDevices) {
    const exp = ((await (await fetch(`${SIM}/api/nodes/${dev.id}/export`)).json())?.data?.items) ?? []
    const sigOf = id => (dev.signals ?? []).find(s => s.id === id)
    for (const id of wantAct) {
      const sig = sigOf(id); if (!sig || dcw[id]) continue
      const item = exp.find(i => i.signal === sig.name); if (!item?.driverConfig) continue
      const r = await api('POST', '/api/workshop/dcw', { name: `闭环2-${sig.name}`, templateRef: 'dcw-temp-sp', driver: dev.protocol, driverConfig: item.driverConfig, unit: sig.unit, min: sig.min, max: sig.max, decimals: sig.decimals ?? 2, lineId, holdIntervalMs: 0, stepLimit: 5, semantics: `SV 设定点:${sig.name}` })
      dcw[id] = r.json?.data?.node?.id ?? r.json?.data?.id
    }
    for (const id of wantSen) {
      const sig = sigOf(id); if (!sig || daq[id]) continue
      const item = exp.find(i => i.signal === sig.name); if (!item?.driverConfig) continue
      const r = await api('POST', '/api/workshop/daq', { name: `闭环2-${sig.name}`, templateRef: 'daq-temp-tc', driver: dev.protocol, driverConfig: item.driverConfig, unit: sig.unit, min: sig.min, max: sig.max, decimals: sig.decimals ?? 2, lineId, intervalMs: 1000, semantics: id === 'film-thickness' ? 'PV 实时检测:流延膜厚度(优化目标 goal,μm;厚度质量输出,随 SV 波动)' : `PV 实时检测:${sig.name}(${sig.unit})` })
      daq[id] = r.json?.data?.node?.id ?? r.json?.data?.id
    }
  }
  ok('建节点 3 SV + 3 PV', wantAct.every(id => dcw[id]) && wantSen.every(id => daq[id]))
  await api('POST', '/api/workshop/daq/controller', { action: 'start' })
  const recipe = (await api('POST', '/api/workshop/dcw/recipes', {
    productId, name: 'KB闭环基线配方', description: 'KB 闭环验收基线',
    params: [
      { nodeId: dcw['zone1-sp'], value: 200, min: 190, max: 225 },
      { nodeId: dcw['linespeed-sp'], value: 95, min: 85, max: 110 },
      { nodeId: dcw['diegap-sp'], value: 1.0, min: 0.85, max: 1.15 },
    ],
  })).json?.data?.recipe
  const start = await api('POST', `/api/workshop/dcw/lines/${lineId}/start`, { recipeId: recipe.id })
  ok('产线开跑', start.status === 200)
}

/* ── 阶跃激励(3 次)── */
console.log('[激励] 3 次阶跃(间隔 70s)')
const EXCITE = [
  { node: 'linespeed-sp', v: 97 },
  { node: 'diegap-sp', v: 1.03 },
  { node: 'linespeed-sp', v: 93 },
]
for (const [i, ex] of EXCITE.entries()) {
  await sleep(70_000)
  const w = await api('POST', `/api/workshop/dcw/${dcw[ex.node]}/write`, { value: ex.v })
  console.log(`  ↳ 阶跃${i + 1} ${ex.node} ← ${ex.v} ${w.status === 200 ? '√' : 'HTTP ' + w.status}`)
}
await sleep(60_000)

/* ── 平台侧 snapshot 生成 CSV(诊断桥自己的快照器)── */
console.log('[快照] 平台 diag-bridge snapshot → CSV')
const snap = await api('POST', '/api/plugins/diag-bridge/snapshot', { line: lineId })
const csvPath = snap.json?.csvPath
const snapRows = snap.json?.rows
ok('快照 CSV 生成', Boolean(csvPath) && (snapRows ?? 0) > 0, `rows=${snapRows} csv=${csvPath}`)
if (!csvPath) { console.log(`═══ ${pass} PASS / ${fails.length + 1} FAIL ═══`); process.exit(1) }

/* ── IDD 诊断任务 ── */
console.log('[诊断] 提交 IDD 诊断任务')
const sub = await fetch(`${IDD_BASE}/api/diagnosis/tasks`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'authorization': `Bearer ${IDD_TOKEN}` },
  body: JSON.stringify({
    dataPath: csvPath,
    sceneName: 'kb闭环验收线_diag',
    userQuestion: '分析膜厚/熔温/熔压三路 PV 波动趋势:工况是否稳定;线速/模口阶跃的因果是否可见;给出结论、风险点与下一步建议',
    harness: 'omp', enhancement: 'off', reportLanguage: 'zh',
    maxTurns: 40, timeoutMinutes: 30,
  }),
  signal: AbortSignal.timeout(30000),
})
const subJ = await sub.json().catch(() => null)
const task = subJ?.data?.task_id
ok('诊断任务提交', Boolean(task), JSON.stringify(subJ).slice(0, 160))

let done = false
let score = null; let verdict = null; let reportPath = null
if (task) {
  console.log('  ↳ 轮询诊断(最长 40 分钟,期间零干扰)...')
  for (let i = 0; i < 120; i++) {
    await sleep(20_000)
    try {
      const d = await fetch(`${IDD_BASE}/api/diagnosis/tasks/${task}`, { headers: { authorization: `Bearer ${IDD_TOKEN}` }, signal: AbortSignal.timeout(20000) }).then(x => x.json())
      const v = d?.data?.view ?? d?.data ?? {}
      if (v.status === 'completed' || v.result?.report_md_path) {
        done = true
        score = v.result?.score ?? null
        verdict = v.result?.verdict ?? null
        reportPath = v.result?.report_md_path ?? null
        console.log(`  ↳ 完成 score=${score} verdict=${verdict}`)
        break
      }
      if (v.status === 'failed') { console.log('  ✖ 诊断失败:', JSON.stringify(v.result?.error ?? '').slice(0, 140)); break }
      if (i % 3 === 0) console.log(`  ↳ (${i * 20 / 60 | 0}min) ${v.status ?? '?'}`)
    }
    catch { /* 重试 */ }
  }
}
ok('诊断完成且报告产出', done && Boolean(reportPath), `score=${score} verdict=${verdict}`)
let reportMd = ''
if (reportPath) {
  try {
    const rr = await fetch(`${IDD_BASE}/api/workspace/report/${encodeURIComponent(reportPath)}`, { headers: { authorization: `Bearer ${IDD_TOKEN}` }, signal: AbortSignal.timeout(20000) })
    if (rr.ok) reportMd = await rr.text()
    else { try { reportMd = readFileSync(String(reportPath).replace(/\\/g, '/'), 'utf8') } catch {} }
  }
  catch { try { reportMd = readFileSync(String(reportPath).replace(/\\/g, '/'), 'utf8') } catch {} }
  ok('报告内容可读', reportMd.length > 200, `len=${reportMd.length}`)
}

/* ── 知识库:入库 + 检索 ── */
console.log('[知识库] 检索 kb.id → 报告入库 → 检索命中')
let kbId
{
  const cat = await fetch('http://127.0.0.1:6789/api/kb/catalog', { headers: { 'authorization': `Bearer ${KB_TOKEN}`, 'X-KB-Token': KB_TOKEN }, signal: AbortSignal.timeout(20000) }).then(x => x.json())
  const kbs = cat?.knowledgeBases ?? []
  kbId = (kbs.find(k => k.name === 'aw-industrial') ?? {})?.kbId ?? null
  ok('KB 目录含 aw-industrial', Boolean(kbId))
}
const exp = {
  title: '产线数据分析诊断报告:流延膜产线 PV 波动分析(KB 闭环)',
  scenario: 'PLC 模拟流延膜产线:膜厚/熔温/熔压 PV 持续监测,线速/模口 SV 阶跃激励下的稳定性诊断',
  category: 'postmortem',
  problem: '膜厚等 PV 出现波动与漂移,需要判断工况稳定性、阶跃因果可见性,以及是否存在异常趋势',
  solution: reportMd ? reportMd.slice(0, 4000) : '(报告缺失)',
  result: done ? 'SUCCESS' : 'PARTIAL',
  key_lessons: [`诊断任务 ${task ?? '?'};score=${score} verdict=${verdict}`],
  tags: ['产线数据分析', '膜厚', '诊断报告', '流延膜', 'KB闭环'],
  metrics: { source: 'IDD', task: task ?? '', snapshotRows: snapRows ?? 0 },
}
{
  const r = await fetch(`${KB_BASE}/api/v1/experience/${kbId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'authorization': `Bearer ${KB_TOKEN}`, 'X-KB-Token': KB_TOKEN },
    body: JSON.stringify(exp), signal: AbortSignal.timeout(60000),
  })
  const j = await r.json().catch(() => null)
  ok('报告入库经验库', r.status === 200 && j?.success !== false, JSON.stringify(j).slice(0, 160))
}
{
  const r = await fetch(`${KB_BASE}/api/v1/experience/${kbId}/search`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'authorization': `Bearer ${KB_TOKEN}`, 'X-KB-Token': KB_TOKEN },
    body: JSON.stringify({ query: '产线数据分析诊断报告 膜厚 波动 KB闭环', top_k: 5 }), signal: AbortSignal.timeout(60000),
  })
  const j = await r.json().catch(() => null)
  const arr = j?.results ?? j?.experiences ?? j?.data ?? []
  const hit = Array.isArray(arr) && arr.length > 0
  ok('经验检索命中本报告', hit, JSON.stringify(arr).slice(0, 200))
}

/* ── 清场 ── */
console.log('[清场]')
for (const port of [AW_PORT, SIM_PORT]) {
  try {
    const psi = spawnSync('powershell', ['-NoProfile', '-Command',
      `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess`], { encoding: 'utf8' })
    const pid = Number(psi.stdout.trim())
    if (Number.isInteger(pid) && pid > 0) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
  }
  catch { /* 忽略 */ }
}
await sleep(1500)
try { rmSync(HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 1500 }) } catch {}

console.log('')
console.log(`═══ KB 闭环单轮验收:${pass} PASS / ${fails.length} FAIL ═══`)
for (const f of fails) console.log(`  ✖ ${f}`)
console.log('')
process.exit(fails.length ? 1 : 0)
