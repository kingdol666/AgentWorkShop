#!/usr/bin/env node
/* eslint-disable @stylistic/max-statements-per-line */
/**
 * Optimizer / Process-Model 全功能 Live E2E(2026-10-23)。
 *
 * 覆盖"真正开发到位"的判定面:
 *  R1 REST 全链:spec → dataset → eligibility → train → model → profile → binding → solve → runs
 *  R2 负例/契约:版本不可变、stage 工况拒绝、作用域错配、模板 id 拒绝、撤权即拒、RBAC
 *  R3 Agent 工具面:optimizer_capabilities/solve/plan_get/status/cancel(真实 dispatch)
 *  U1 真实浏览器 /optimizer:五 tab 全流程(规格→数据集→资格→训练→Profile→绑定→求解)
 *
 * 运行:node scripts/e2e-optimizer-live.mjs
 * 证据:docs/audit/evidence/2026-10-23-optimizer-live/{report.json,*.png}
 *
 * 隔离:tmp home + 独立端口;AML venv 用 junction 复用本机真实环境(不联网安装)。
 */
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { mkdirSync, writeFileSync, existsSync, symlinkSync, openSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir, homedir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ROOT = join(tmpdir(), `aw-optimizer-live-e2e-${Date.now()}`)
const HOME = join(ROOT, 'home')
const EVID = resolve(process.env.AW_E2E_EVIDENCE_DIR || join(REPO, 'docs', 'audit', 'evidence', '2026-10-23-optimizer-live'))
mkdirSync(HOME, { recursive: true })
mkdirSync(EVID, { recursive: true })

const TAG = `opt${Date.now().toString(36).slice(-4)}`
const BEAT = 5000
const H = 24
const F = 6
const N_STEPS = 160
const N_RUNS = 6
const DELAY_STEPS = 2

process.env.AW_MODE = 'home'
process.env.AW_HOME = HOME
process.env.AW_AML_DIR = join(HOME, 'aml')
process.env.NO_PROXY = '127.0.0.1,localhost'

// 先连接已安装环境;运行时装配会创建 .venv 目录,之后再连接会遇到 EEXIST。
mkdirSync(join(HOME, 'aml'), { recursive: true })
const realVenv = join(homedir(), '.AgentWorkShop', 'aml', '.venv')
let venvLinked = false
if (existsSync(join(realVenv, 'Scripts', 'python.exe'))) {
  symlinkSync(realVenv, join(HOME, 'aml', '.venv'), 'junction')
  venvLinked = true
}

const results = []
function check(id, name, cond, detail = '') {
  const pass = Boolean(cond)
  results.push({ id, name, pass, detail: String(detail).slice(0, 600) })
  console.log(`${pass ? '✔' : '✘'} [${id}] ${name}${detail ? ` — ${String(detail).slice(0, 220)}` : ''}`)
  return pass
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

// ════════════════════════════════════════════════════════════════
// 0. 预置数据(与 acceptance 同构:4 个已完结历史批次 + 网格样本)
// ════════════════════════════════════════════════════════════════
console.log('\n=== 0. seed ===')
const { getDcwLineRepo } = await import('../server/services/workshop/dcw/dcw-line.repo')
const { getDcwProductRepo } = await import('../server/services/workshop/dcw/dcw-product.repo')
const { getDcwRecipeRepo } = await import('../server/services/workshop/dcw/dcw-recipe.repo')
const { getDcwNodeRepo } = await import('../server/services/workshop/dcw/dcw-node.repo')
const { DcwNode } = await import('../server/services/workshop/dcw/dcw-node')
const { getDaqNodeRepo } = await import('../server/services/workshop/daq/daq-node.repo')
const { DaqNode } = await import('../server/services/workshop/daq/daq-node')
const { SqliteTimeSeriesAdapter } = await import('../server/services/workshop/daq/storage/sqlite.adapter')
const { getContextSegmentRepo, recipeContentHash } = await import('../server/services/workshop/process-model/context-segments.repo')
const { openWorkshopDb } = await import('../server/services/workshop/db/database/open')
const { configureAmlRuntime } = await import('../server/services/workshop/aml/runtime')
const { bindOpsRepos } = await import('../server/services/workshop/ops/ops')
const { createAuditRepo } = await import('../server/services/workshop/db/ops.repo')
// seed 段直连服务仓储(不经 HTTP):本地装配 AML 运行时与审计面
const seedDb = openWorkshopDb(join(HOME, 'data', 'workshop.sqlite'))
configureAmlRuntime(seedDb)
try {
  bindOpsRepos({ audit: createAuditRepo(seedDb) })
}
catch { /* 重复装配无害 */ }

const line = getDcwLineRepo().create({ name: `优化验收线-${TAG}`, simulated: true })
const product = getDcwProductRepo().create({ name: `优化验收产品-${TAG}`, lineId: line.id })
getDcwNodeRepo().insert(new DcwNode({
  id: `dcw-${TAG}-mv`, templateRef: 'dcw-temp-sp', driver: 'mock',
  name: `优化验收控制-${TAG}`, lineId: line.id, min: 0, max: 100, unit: 'bar',
}))
// 治理下发门 ⑥ 需要执行节点有当前实测值(mock 驱动无控制器循环;种子直置 50 = 配方初值)
const dcwMvSeed = getDcwNodeRepo().byId(`dcw-${TAG}-mv`)
if (dcwMvSeed) {
  dcwMvSeed.readValue = 50
  getDcwNodeRepo().flushNow()
}
getDaqNodeRepo().insert(DaqNode.fromRow({
  id: `dn-${TAG}-mv`, templateRef: 'tpl-live-mv', name: `优化MV-${TAG}`, unit: 'bar',
  min: 0, max: 100, lineId: line.id, driver: 'mock',
}))
getDaqNodeRepo().insert(DaqNode.fromRow({
  id: `dn-${TAG}-cv`, templateRef: 'tpl-live-cv', name: `优化CV-${TAG}`, unit: 'μm',
  min: 0, max: 200, lineId: line.id, driver: 'mock',
}))
const MV_ID = `dn-${TAG}-mv`
const CV_ID = `dn-${TAG}-cv`
const recipe = getDcwRecipeRepo().create({
  name: `优化验收配方-${TAG}`, productId: product.id,
  params: [{ nodeId: `dcw-${TAG}-mv`, value: 50, min: 0, max: 100 }],
  daqWindows: [{ nodeId: MV_ID, min: 0, max: 100 }],
})

const now0 = Date.now()
const runStartBase = now0 - 3 * 3600_000
const seededRuns = []
const sampleRows = []
const segRepo = getContextSegmentRepo()
const seedHash = recipeContentHash(recipe)
for (let r = 0; r < N_RUNS; r++) {
  const start = runStartBase + r * (N_STEPS * BEAT + 120_000)
  const end = start + (N_STEPS - 1) * BEAT
  const run = getDcwRecipeRepo().createRun(recipe)
  run.startedAt = new Date(start).toISOString()
  run.endedAt = new Date(end).toISOString()
  getDcwRecipeRepo().updateRun(run)
  seededRuns.push({ id: run.id, start, end })
  // D18/SW2.4:每个 seeded run 建 confirmed context segment(版本+hash 匹配)→ 数据集 lineage_verified=1
  segRepo.insert({ lineId: line.id, runId: run.id, fromTs: start, toTs: end, recipeId: recipe.id, recipeVersion: recipe.version ?? 1, recipeContentHash: seedHash, conditionId: 'c-live', source: 'line_run', confirmed: true })
  let y = 52
  const uq = []
  for (let k = 0; k < N_STEPS; k++) {
    const u = 50 + 20 * Math.sin((k + r * 11) / 9) + 6 * Math.sin((k + r * 3) / 4)
    uq.push(u)
    const delayed = uq[Math.max(0, uq.length - 1 - DELAY_STEPS)]
    y = 0.3 * y + 0.7 * delayed + 8 + 0.02 * Math.sin((k + r) / 3)
    const ts = start + k * BEAT
    const tags = { lineId: line.id, productId: product.id, recipeId: recipe.id, runId: run.id }
    sampleRows.push({ nodeId: MV_ID, tsMs: ts, value: u, state: 'ok', ...tags })
    sampleRows.push({ nodeId: CV_ID, tsMs: ts, value: y, state: 'ok', ...tags })
  }
}

// ── 场景 B:双 MV / 双 CV + 单位换算(L/min → m3/h) ──
const line2 = getDcwLineRepo().create({ name: `优化验收线B-${TAG}`, simulated: true })
const product2 = getDcwProductRepo().create({ name: `优化验收产品B-${TAG}`, lineId: line2.id })
for (const [i, unit] of [['a', 'L/min'], ['b', 'L/min']]) {
  getDcwNodeRepo().insert(new DcwNode({
    id: `dcw-${TAG}-2${i}`, templateRef: 'dcw-temp-sp', driver: 'mock',
    name: `B控制-${i}-${TAG}`, lineId: line2.id, min: 0, max: 150, unit,
  }))
}
for (const [id, unit, max] of [[`dn-${TAG}-2a`, 'L/min', 150], [`dn-${TAG}-2b`, 'L/min', 150], [`dn-${TAG}-2c`, 'μm', 60], [`dn-${TAG}-2d`, 'mm', 80]]) {
  getDaqNodeRepo().insert(DaqNode.fromRow({
    id, templateRef: `tpl-live-${id}`, name: `B节点-${id}-${TAG}`, unit, min: 0, max, lineId: line2.id, driver: 'mock',
  }))
}
const MV2A = `dn-${TAG}-2a`
const MV2B = `dn-${TAG}-2b`
const CV2A = `dn-${TAG}-2c`
const CV2B = `dn-${TAG}-2d`
const recipe2 = getDcwRecipeRepo().create({
  name: `优化验收配方B-${TAG}`, productId: product2.id,
  params: [{ nodeId: `dcw-${TAG}-2a`, value: 60, min: 0, max: 120 }, { nodeId: `dcw-${TAG}-2b`, value: 40, min: 0, max: 80 }],
  daqWindows: [{ nodeId: MV2A, min: 0, max: 150 }, { nodeId: MV2B, min: 0, max: 150 }],
})
const seededRuns2 = []
for (let r = 0; r < N_RUNS; r++) {
  const start = runStartBase + r * (N_STEPS * BEAT + 120_000)
  const end = start + (N_STEPS - 1) * BEAT
  const run = getDcwRecipeRepo().createRun(recipe2)
  run.startedAt = new Date(start).toISOString()
  run.endedAt = new Date(end).toISOString()
  getDcwRecipeRepo().updateRun(run)
  seededRuns2.push({ id: run.id, start, end })
  segRepo.insert({ lineId: line2.id, runId: run.id, fromTs: start, toTs: end, recipeId: recipe2.id, recipeVersion: recipe2.version ?? 1, recipeContentHash: recipeContentHash(recipe2), conditionId: 'c-live', source: 'line_run', confirmed: true })
  let y1 = 35
  let y2 = 45
  const u1q = []
  const u2q = []
  for (let k = 0; k < N_STEPS; k++) {
    const u1 = 60 + 20 * Math.sin((k + r * 7) / 11) + 5 * Math.sin((k + r) / 5)
    const u2 = 40 + 15 * Math.sin((k + r * 5) / 8) + 4 * Math.cos((k + r) / 4)
    u1q.push(u1)
    u2q.push(u2)
    const d1 = u1q[Math.max(0, u1q.length - 1 - DELAY_STEPS)]
    const d2 = u2q[Math.max(0, u2q.length - 1 - DELAY_STEPS)]
    y1 = 0.5 * y1 + 0.2 * d1 + 0.1 * d2 + 5 + 0.01 * Math.sin((k + r) / 3)
    y2 = 0.4 * y2 + 0.1 * d1 + 0.2 * d2 + 10 + 0.01 * Math.cos((k + r) / 4)
    const ts = start + k * BEAT
    const tags = { lineId: line2.id, productId: product2.id, recipeId: recipe2.id, runId: run.id }
    sampleRows.push({ nodeId: MV2A, tsMs: ts, value: u1, state: 'ok', ...tags })
    sampleRows.push({ nodeId: MV2B, tsMs: ts, value: u2, state: 'ok', ...tags })
    sampleRows.push({ nodeId: CV2A, tsMs: ts, value: y1, state: 'ok', ...tags })
    sampleRows.push({ nodeId: CV2B, tsMs: ts, value: y2, state: 'ok', ...tags })
  }
}

// ── 场景 C:静态响应面(退火式稳态,CV = f(MV),无动态记忆) ──
const line3 = getDcwLineRepo().create({ name: `优化验收线C-${TAG}`, simulated: true })
const product3 = getDcwProductRepo().create({ name: `优化验收产品C-${TAG}`, lineId: line3.id })
getDcwNodeRepo().insert(new DcwNode({
  id: `dcw-${TAG}-3m`, templateRef: 'dcw-temp-sp', driver: 'mock',
  name: `C控制-${TAG}`, lineId: line3.id, min: 0, max: 120, unit: 'bar',
}))
getDaqNodeRepo().insert(DaqNode.fromRow({
  id: `dn-${TAG}-3m`, templateRef: 'tpl-live-3m', name: `C-MV-${TAG}`, unit: 'bar', min: 0, max: 120, lineId: line3.id, driver: 'mock',
}))
getDaqNodeRepo().insert(DaqNode.fromRow({
  id: `dn-${TAG}-3c`, templateRef: 'tpl-live-3c', name: `C-CV-${TAG}`, unit: 'μm', min: 0, max: 120, lineId: line3.id, driver: 'mock',
}))
const MV3 = `dn-${TAG}-3m`
const CV3 = `dn-${TAG}-3c`
const recipe3 = getDcwRecipeRepo().create({
  name: `优化验收配方C-${TAG}`, productId: product3.id,
  params: [{ nodeId: `dcw-${TAG}-3m`, value: 60, min: 0, max: 120 }],
  daqWindows: [{ nodeId: MV3, min: 0, max: 120 }],
})
const seededRuns3 = []
for (let r = 0; r < N_RUNS; r++) {
  const start = runStartBase + r * (N_STEPS * BEAT + 120_000)
  const end = start + (N_STEPS - 1) * BEAT
  const run = getDcwRecipeRepo().createRun(recipe3)
  run.startedAt = new Date(start).toISOString()
  run.endedAt = new Date(end).toISOString()
  getDcwRecipeRepo().updateRun(run)
  seededRuns3.push({ id: run.id, start, end })
  segRepo.insert({ lineId: line3.id, runId: run.id, fromTs: start, toTs: end, recipeId: recipe3.id, recipeVersion: recipe3.version ?? 1, recipeContentHash: recipeContentHash(recipe3), conditionId: 'c-live', source: 'line_run', confirmed: true })
  for (let k = 0; k < N_STEPS; k++) {
    // 慢变 MV:静态响应面按"未来时域均值"拟合,F=1 时相邻拍差异≈0.5(量程 20 的 2.5%)
    const u = 60 + 20 * Math.sin((k + r * 30) / 40) + 0.5 * Math.sin(k / 5)
    const y = 50 + 0.45 * (u - 50) - 0.005 * (u - 50) ** 2 + 0.02 * Math.sin((k + r) * 1.7)
    const ts = start + k * BEAT
    const tags = { lineId: line3.id, productId: product3.id, recipeId: recipe3.id, runId: run.id }
    sampleRows.push({ nodeId: MV3, tsMs: ts, value: u, state: 'ok', ...tags })
    sampleRows.push({ nodeId: CV3, tsMs: ts, value: y, state: 'ok', ...tags })
  }
}

const seedTsdb = new SqliteTimeSeriesAdapter()
await seedTsdb.init()
await seedTsdb.writeSamples(sampleRows)
await seedTsdb.close()
console.log(`seed: line=${line.id} product=${product.id} recipe=${recipe.id} runs=${seededRuns.length} samples=${sampleRows.length}`)
console.log(`seed B: line=${line2.id} product=${product2.id} recipe=${recipe2.id} runs=${seededRuns2.length}`)

console.log(`venv: ${venvLinked ? 'junction → ' + realVenv : '未复用(可能触发联网安装)'}`)

// 新鲜上下文尾巴(每次 solve 前刷新;context 只接受 ≤1.5×beat 的点)
function insertSamples(rows) {
  if (!rows.length) return
  const db = new DatabaseSync(join(HOME, 'data', 'daq-timeseries.sqlite'))
  db.exec('PRAGMA busy_timeout=8000')
  const ins = db.prepare(`INSERT OR IGNORE INTO daq_samples
    (node_id, ts_ms, value, state, line_id, product_id, recipe_id, run_id, ingested_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  db.exec('BEGIN')
  for (const r of rows) ins.run(r.nodeId, r.tsMs, r.value, r.state ?? 'ok', r.lineId ?? null, r.productId ?? null, r.recipeId ?? null, r.runId ?? null, r.ingestedAt ?? Date.now())
  db.exec('COMMIT')
  db.close()
}

function writeFreshTail() {
  const tEnd = Math.floor(Date.now() / BEAT) * BEAT
  const runId = seededRuns[seededRuns.length - 1].id
  const rows = []
  for (let i = 0; i < H; i++) {
    const t = tEnd - (H - 1 - i) * BEAT
    const u = 50 + 5 * Math.sin(i / 3)
    const y = 50 + 2 * Math.sin(i / 3 - 1)
    rows.push({ nodeId: MV_ID, tsMs: t, value: u, lineId: line.id, productId: product.id, recipeId: recipe.id, runId })
    rows.push({ nodeId: CV_ID, tsMs: t, value: y, lineId: line.id, productId: product.id, recipeId: recipe.id, runId })
  }
  insertSamples(rows)
  return tEnd
}

function writeTailFor(tEnd, runId, tags) {
  const rows = []
  for (const [nodeId, values] of Object.entries(tags.values)) {
    for (let i = 0; i < H; i++) {
      rows.push({
        nodeId, tsMs: tEnd - (H - 1 - i) * BEAT, value: values[i],
        lineId: tags.lineId, productId: tags.productId, recipeId: tags.recipeId, runId,
      })
    }
  }
  insertSamples(rows)
  return tEnd
}

// 隔离实例强制 SQLite 时序(宿主机真实 Timescale 在线时,插件会切到 Timescale,
// 看不到本用例预置的 SQLite 样本);MQTT 指到关闭端口 → 进程内队列。
const { saveSettings } = await import('../shared/config/engine.mjs')
saveSettings({
  'daq.timescale.host': '127.0.0.1',
  'daq.timescale.port': 6543,
  'daq.mqtt.host': '127.0.0.1',
  'daq.mqtt.port': 18830,
  'daq.startInfrastructure': 'never',
}, join(HOME, 'runtime-settings.json'))

// ════════════════════════════════════════════════════════════════
// 1. 启动隔离实例
// ════════════════════════════════════════════════════════════════
let port = 0
for (const p of [3997, 3996, 3995, 3994, 3993]) {
  try {
    const r = await fetch(`http://127.0.0.1:${p}/api/health`, { signal: AbortSignal.timeout(1000) })
    if (r.ok) continue
  }
  catch { /* 空闲 */ }
  port = p
  break
}
if (!port) throw new Error('无空闲端口')
const BASE = `http://127.0.0.1:${port}`
console.log(`\n=== 1. boot ${BASE} ===`)
const logFd = openSync(join(ROOT, 'dev.log'), 'a')
const child = spawn(process.execPath, [join(REPO, 'bin', 'aw.mjs'), 'dev', '--port', String(port)], {
  cwd: REPO,
  env: {
    ...process.env,
    AW_MODE: 'home',
    AW_HOME: HOME,
    AW_RATE_LIMIT_OFF: '1',
    NUXT_SESSION_PASSWORD: 'OptimizerLive#2026-e2e-session-key',
    NO_PROXY: '127.0.0.1,localhost',
  },
  stdio: ['ignore', logFd, logFd],
  windowsHide: true,
})

async function api(method, path, body, token, timeoutMs = 180_000) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  let json = null
  try { json = await res.json() }
  catch { /* 非 JSON */ }
  return { status: res.status, ...(json ?? {}) }
}
const data = r => r?.data
const errCode = r => r?.data?.error?.code ?? r?.code ?? r?.data?.code ?? ''

let healthy = false
for (let i = 0; i < 120; i++) {
  await sleep(1500)
  try {
    const h = await api('GET', '/api/health', undefined, undefined, 3000)
    if (h?.data?.status === 'ok' && h?.data?.workshop === 'ready') { healthy = true; break }
  }
  catch { /* 未就绪 */ }
}
check('BOOT', '隔离实例启动 + workshop ready', healthy, `port=${port}`)
if (!healthy) {
  child.kill()
  throw new Error('实例未就绪,见 ' + join(ROOT, 'dev.log'))
}

const email = `opt-${TAG}@awshop.local`
const reg = await api('POST', '/api/users/register', { name: `优化验收-${TAG}`, email, password: 'OptLive#2026' })
const token = data(reg)?.token
check('BOOT', '管理员注册/登录', Boolean(token), `status=${reg.status}`)
if (!token) { child.kill(); throw new Error('注册失败:' + JSON.stringify(reg).slice(0, 300)) }
const me = await api('GET', '/api/users/me', undefined, token)
check('BOOT', '首注册用户为 admin', data(me)?.user?.role === 'admin' || data(me)?.role === 'admin', JSON.stringify(data(me)?.user ?? data(me)).slice(0, 120))

// ════════════════════════════════════════════════════════════════
// 2. Process Model REST 全链
// ════════════════════════════════════════════════════════════════
console.log('\n=== 2. process-model REST ===')
function specBody(id, extra = {}) {
  return {
    schemaVersion: 2, id, version: 1,
    lineId: line.id, productId: product.id, recipeId: recipe.id, recipeVersion: recipe.version ?? 1,
    conditions: [{ id: 'c1', match: [{ field: 'recipeId', op: 'eq', value: recipe.id }] }],
    variables: [
      { id: 'mv1', nodeId: MV_ID, role: 'mv', field: 'value', unit: 'bar', scale: 1, offset: 0, delayMs: DELAY_STEPS * BEAT, min: 0, max: 100, maxStep: 20, controlNodeId: `dcw-${TAG}-mv` },
      { id: 'cv1', nodeId: CV_ID, role: 'cv', field: 'value', unit: 'μm', scale: 1, offset: 0, min: 0, max: 200 },
    ],
    timing: { beatMs: BEAT, historySteps: H, horizonSteps: F, fixedDt: true },
    trainer: { ref: 'linear_arx@1', config: { arOrder: 1, inputOrder: 1, ridgeLambda: 1e-6, standardize: true } },
    datasetPolicy: { split: { valRatio: 0.4, testRatio: 0.4, seed: 42 }, cleaning: { hampelK: 0 } },
    gatePolicyRef: 'process-model.gates@1',
    modelInterface: { id: 'linear_state_space', version: 1, inputSemantics: 'setpoint', mode: 'state_space' },
    effectiveDomain: { mv: { mv1: { min: 0, max: 100, maxStep: 20 } }, cv: { cv1: { min: 0, max: 200 } } },
    purpose: 'mpc_surrogate',
    ...extra,
  }
}
const SPEC = `pms-${TAG}`
const spec = specBody(SPEC)
let trainedModelId
let dynamicDatasetId
let staticModelId
let workspaceId
let channelId
let leadAgentId
let bindingId
let lastRecId

{
  const empty = await api('GET', '/api/workshop/process-model/specs', undefined, token)
  check('R1.1', 'GET /process-model/specs 初始可用', empty.status === 200 && Array.isArray(data(empty)?.specs), `status=${empty.status} n=${data(empty)?.specs?.length}`)
  const created = await api('POST', '/api/workshop/process-model/specs', spec, token)
  check('R1.2', 'POST /specs 登记 draft', created.status === 200 && data(created)?.spec?.status === 'draft', JSON.stringify(data(created)?.spec ?? created).slice(0, 160))
  const list = await api('GET', `/api/workshop/process-model/specs?lineId=${encodeURIComponent(line.id)}`, undefined, token)
  check('R1.3', 'GET /specs?lineId 回读与可见性', (data(list)?.specs ?? []).some(s => s.id === SPEC && s.version === 1), `n=${(data(list)?.specs ?? []).length}`)
  const dup = await api('POST', '/api/workshop/process-model/specs', specBody(SPEC, { note: 'mutated' }), token)
  check('R2.1', '同版本改内容 → 409 SPEC_VERSION_IMMUTABLE', dup.status === 409 && String(errCode(dup)).includes('SPEC_VERSION_IMMUTABLE'), `${dup.status}/${errCode(dup)}`)
  const stage = await api('POST', '/api/workshop/process-model/specs', specBody(`pms-stage-${TAG}`, {
    conditions: [{ id: 's', match: [{ field: 'stage', op: 'eq', value: 'low' }] }],
  }), token)
  check('R2.2', 'stage 工况 → 422 CONDITION_FIELD_UNSUPPORTED', stage.status === 422 && String(errCode(stage)).includes('CONDITION_FIELD_UNSUPPORTED'), `${stage.status}/${errCode(stage)}`)
  const publish = await api('POST', `/api/workshop/process-model/specs/${encodeURIComponent(SPEC)}/publish?version=1`, undefined, token)
  check('R1.4', 'POST /specs/:id/publish 发布不可变', publish.status === 200 && data(publish)?.spec?.status === 'published', `${publish.status}/${data(publish)?.spec?.status}`)
  const ds = await api('POST', '/api/workshop/process-model/datasets', spec, token)
  const datasetId = data(ds)?.datasetId
  dynamicDatasetId = datasetId
  check('R1.5', 'POST /datasets 构建 manifest v2', ds.status === 200 && datasetId && data(ds).rowCount > 200, `id=${datasetId} rows=${data(ds)?.rowCount} runs=${(data(ds)?.runIds ?? []).length} msg=${ds.message ?? ''}`)
  const dsGet = await api('GET', `/api/workshop/aml/datasets/${encodeURIComponent(datasetId)}`, undefined, token)
  check('R1.6', 'GET /aml/datasets/:id manifest v2 可读', dsGet.status === 200 && data(dsGet)?.manifest?.version === 2, `v=${data(dsGet)?.manifest?.version} hash=${String(data(dsGet)?.dataset?.sha256 ?? '').slice(0, 10)}`)
  const elig = await api('POST', '/api/workshop/process-model/eligibility', { specId: SPEC, specVersion: 1, datasetId, scope: 'simulation' }, token)
  check('R1.7', 'POST /eligibility 模拟数据具备优化资格', elig.status === 200 && data(elig)?.report?.optimizationEligible === true, `gaps=${(data(elig)?.report?.gaps ?? []).map(g => g.code).join(',') || 'none'} evidence=${data(elig)?.report?.evidenceVersion}`)
  const eligGet = await api('GET', `/api/workshop/process-model/eligibility?specId=${encodeURIComponent(SPEC)}`, undefined, token)
  check('R1.8', 'GET /eligibility 最新+历史', eligGet.status === 200 && data(eligGet)?.report?.optimizationEligible === true && (data(eligGet)?.history ?? []).length >= 1, `history=${(data(eligGet)?.history ?? []).length}`)
  const badScope = await api('POST', '/api/workshop/process-model/eligibility', { specId: SPEC, specVersion: 1, datasetId, scope: 'real' }, token)
  check('R2.3', '模拟线申请 real 作用域 → 422 ELIGIBILITY_SCOPE_MISMATCH', badScope.status === 422 && String(errCode(badScope)).includes('ELIGIBILITY_SCOPE_MISMATCH'), `${badScope.status}/${errCode(badScope)} msg=${badScope.message ?? ''}`)

  const train = await api('POST', '/api/workshop/process-model/train', { spec, datasetId, modelName: `优化验收模型-${TAG}` }, token)
  const jobId = data(train)?.job?.id
  check('R1.9', 'POST /train 提交内置训练作业', train.status === 200 && Boolean(jobId), `job=${jobId}`)
  let job = null
  const terminal = new Set(['done', 'failed', 'cancelled', 'timeout', 'interrupted'])
  for (let i = 0; i < 240; i++) {
    const jr = await api('GET', `/api/workshop/aml/jobs/${encodeURIComponent(jobId)}`, undefined, token)
    job = data(jr)?.job
    if (job && terminal.has(job.status)) break
    await sleep(500)
  }
  const modelId = job?.modelId
  trainedModelId = modelId ?? ''
  check('R1.10', '训练作业 done + 两阶段登记 model_id', job?.status === 'done' && Boolean(modelId), `status=${job?.status} model=${modelId} err=${job?.error ?? ''}`)
  const models = await api('GET', `/api/workshop/aml/models?recipeId=${encodeURIComponent(recipe.id)}`, undefined, token)
  const model = (data(models)?.models ?? []).find(m => m.id === modelId)
  check('R1.11', '模型注册表:linear_state_space@1 + 接口/哈希', model?.artifactKind === 'linear_state_space@1' && model?.modelInterface === 'linear_state_space' && String(model?.artifactHash ?? '').length === 64, `${model?.artifactKind}/${model?.modelInterface}/${String(model?.artifactHash ?? '').slice(0, 10)}`)
}

// ════════════════════════════════════════════════════════════════
// 3. Optimizer REST:Profile → Binding → Solve → Runs
// ════════════════════════════════════════════════════════════════
console.log('\n=== 3. optimization REST ===')
const ws = await api('POST', '/api/workshop/workspaces', { name: `优化验收工作区-${TAG}` }, token)
workspaceId = data(ws)?.id
const ch = await api('POST', '/api/workshop/channels', { name: `优化验收频道-${TAG}`, leadAgent: { name: `优化lead-${TAG}`, harness: 'mock' } }, token)
channelId = data(ch)?.channelId
leadAgentId = data(ch)?.leadAgentId
check('R1.12', '创建 workspace/channel(lead 实例)', Boolean(workspaceId && channelId && leadAgentId), `ws=${workspaceId} ch=${channelId} lead=${leadAgentId}`)
const mount = workspaceId && channelId ? await api('POST', `/api/workshop/workspaces/${encodeURIComponent(workspaceId)}/channels/${encodeURIComponent(channelId)}`, undefined, token) : null
check('R1.13', '挂载 channel 到 workspace', mount?.status === 200, `status=${mount?.status}`)

const profileId = `optp-${TAG}`
const profileBody = {
  schemaVersion: 1, id: profileId, version: 1,
  modelRef: { modelId: trainedModelId, artifactKind: 'linear_state_space@1', artifactHash: '', modelInterface: 'linear_state_space', stage: 'candidate' },
  problemTemplateRef: 'linear_mpc_quadratic@1',
  problemConfig: { linear_mpc_quadratic: { cvWeights: { cv1: 1 }, duWeights: { mv1: 0.1 }, terminalWeight: 2, targets: { cv1: 50 } } },
  solverRef: 'osqp_mpc@1', solverVersion: '1',
  processSpecRef: `${SPEC}@1`, conditionIds: [], status: 'draft',
}
{
  const badProfile = await api('POST', '/api/workshop/optimization/profiles', {
    ...profileBody, id: `${profileId}-bad`, solverRef: 'osqp_mpc@1', problemTemplateRef: 'steady_response@1',
  }, token)
  check('R2.4', 'solver/模板不兼容 → 422 PROFILE_INCOMPATIBLE', badProfile.status === 422 && String(errCode(badProfile)).includes('PROFILE_INCOMPATIBLE'), `${badProfile.status}/${errCode(badProfile)}`)
  const created = await api('POST', '/api/workshop/optimization/profiles', profileBody, token)
  const row = data(created)?.profile
  check('R1.14', 'POST /profiles draft(工件字段由服务端回填)', created.status === 200 && row?.status === 'draft' && row?.modelArtifactKind === 'linear_state_space@1' && row?.modelArtifactHash?.length === 64, `${created.status}/${row?.status}/${row?.modelArtifactKind}/${String(row?.modelArtifactHash ?? '').slice(0, 10)} msg=${created.message ?? ''}`)
  const pub = await api('POST', `/api/workshop/optimization/profiles/${encodeURIComponent(profileId)}/publish?version=1`, undefined, token)
  check('R1.15', 'POST /profiles/:id/publish 发布', pub.status === 200 && data(pub)?.profile?.status === 'published', `${pub.status}/${data(pub)?.profile?.status}`)

  const bind = await api('POST', '/api/workshop/optimization/bindings', {
    workspaceId, channelId, agentInstanceId: leadAgentId, profileId, profileVersion: 1, mode: 'recommendation',
  }, token)
  bindingId = data(bind)?.binding?.id ?? ''
  check('R1.16', 'POST /bindings 创建(revision=1)', bind.status === 200 && Boolean(bindingId) && data(bind)?.binding?.revision === 1, `id=${bindingId} rev=${data(bind)?.binding?.revision}`)
  const bindList = await api('GET', `/api/workshop/optimization/bindings?agentInstanceId=${encodeURIComponent(leadAgentId)}`, undefined, token)
  check('R1.17', 'GET /bindings?agentInstanceId 隔离回读', (data(bindList)?.bindings ?? []).some(b => b.id === bindingId), `n=${(data(bindList)?.bindings ?? []).length}`)
  const caps = await api('GET', `/api/workshop/optimization/capabilities?agentInstanceId=${encodeURIComponent(leadAgentId)}`, undefined, token)
  const capObj = data(caps)?.capabilities
  check('R1.18', 'GET /capabilities 环境/求解器/绑定总览', caps.status === 200 && (capObj?.bindings ?? []).length >= 1 && Number(capObj?.solver?.size) >= 1 && Boolean(capObj?.environment?.pythonPath), `bindings=${(capObj?.bindings ?? []).length} solverSize=${capObj?.solver?.size} py=${String(capObj?.environment?.pythonPath ?? '').slice(-30)}`)

  const writesPath = join(HOME, 'data', 'dcw-writes.json')
  const writesBefore = existsSync(writesPath) ? String(await import('node:fs').then(m => m.readFileSync(writesPath, 'utf8'))).length : 0
  writeFreshTail()
  const solve = await api('POST', '/api/workshop/optimization/solve', { agentInstanceId: leadAgentId }, token)
  const outcome = data(solve)
  const runId = outcome?.runId
  check('R1.19', 'POST /solve optimal + 建议带证据状态(verified|unverified 由 UQ 证据决定)', solve.status === 200 && outcome?.result?.status === 'optimal' && ['verified', 'unverified'].includes(outcome?.recommendation?.status), `status=${outcome?.result?.status} run=${runId} rec=${outcome?.recommendation?.status} reason=${outcome?.recommendation?.statusLabel ?? ''} http=${solve.status}`)
  lastRecId = String(outcome?.recommendation?.id ?? '')
  const writesAfter = existsSync(writesPath) ? String(await import('node:fs').then(m => m.readFileSync(writesPath, 'utf8'))).length : 0
  check('R1.20', '求解零 DCW 写入(写入账本不变)', writesBefore === writesAfter, `${writesBefore}→${writesAfter}`)
  const runs = await api('GET', `/api/workshop/optimization/runs?bindingId=${encodeURIComponent(bindingId)}`, undefined, token)
  const runRow = (data(runs)?.runs ?? []).find(r => r.id === runId)
  check('R1.21', 'GET /runs 台账:IR hash + 建议 + 载荷', runs.status === 200 && runRow && String(runRow.problemIrHash ?? '').length === 64 && ['verified', 'unverified'].includes(runRow.recommendation?.status) && (runRow.problemIr?.problem?.cvOrder ?? []).length >= 1, `hash=${String(runRow?.problemIrHash ?? '').slice(0, 10)} rec=${runRow?.recommendation?.status} cvOrder=${(runRow?.problemIr?.problem?.cvOrder ?? []).join(',')}`)
}

// ════════════════════════════════════════════════════════════════
// 4. Agent 工具面(optimization channel + 真实 dispatch)
// ════════════════════════════════════════════════════════════════
console.log('\n=== 4. agent tools ===')
{
  const tpl = await api('POST', '/api/workshop/channel-templates/chtpl-aml-optimization-default/instantiate', {
    name: `优化工具频道-${TAG}`, toolProfile: 'aml_optimization', optimizationMode: 'exploration',
  }, token)
  const optCh = data(tpl)
  const optChannelId = optCh?.channelId
  const optLead = optCh?.leadAgentId ?? optCh?.agents?.find(a => a.role === 'lead')?.id
  check('R3.1', '实例化 aml_optimization 频道', tpl.status === 200 && Boolean(optChannelId && optLead), `ch=${optChannelId} lead=${optLead}`)
  if (optChannelId && optLead) {
    const ws2 = await api('POST', '/api/workshop/workspaces', { name: `优化工具工作区-${TAG}` }, token)
    const ws2Id = data(ws2)?.id
    await api('POST', `/api/workshop/workspaces/${encodeURIComponent(ws2Id)}/channels/${encodeURIComponent(optChannelId)}`, undefined, token)
    const templateId = (optCh?.agents ?? []).find(a => a.templateId)?.templateId
    const badBind = templateId
      ? await api('POST', '/api/workshop/optimization/bindings', {
          workspaceId: ws2Id, channelId: optChannelId, agentInstanceId: templateId, profileId, profileVersion: 1,
        }, token)
      : null
    check('R2.5', '模板 id 绑定 → 422 AGENT_TEMPLATE_ID_NOT_ALLOWED', badBind?.status === 422 && String(errCode(badBind)).includes('AGENT_TEMPLATE_ID_NOT_ALLOWED'), `${badBind?.status}/${errCode(badBind)} tpl=${templateId ?? 'none'}`)
    const b2 = await api('POST', '/api/workshop/optimization/bindings', {
      workspaceId: ws2Id, channelId: optChannelId, agentInstanceId: optLead, profileId, profileVersion: 1,
    }, token)
    check('R3.2', '优化频道 lead 绑定 Profile', b2.status === 200 && Boolean(data(b2)?.binding?.id), `${b2.status}/${errCode(b2)}`)

    const list = await api('GET', `/api/workshop/agent-tools/list?agentId=${encodeURIComponent(optLead)}`, undefined, token)
    const names = (data(list)?.tools ?? []).map(t => t.name)
    check('R3.3', '工具注入面含 5 个 optimizer_*', ['optimizer_capabilities', 'optimizer_solve', 'optimizer_status', 'optimizer_cancel', 'optimizer_plan_get'].every(n => names.includes(n)), names.filter(n => n.startsWith('optimizer_')).join(','))

    const inv = async (tool, args = {}) => api('POST', '/api/workshop/agent-tools/invoke', { agentId: optLead, tool, args }, token)
    const cap = await inv('optimizer_capabilities')
    const capText = String(data(cap)?.result?.text ?? '')
    check('R3.4', 'optimizer_capabilities 返回求解器/环境 JSON', /osqp|scipy|solver/i.test(capText) && !data(cap)?.result?.isError, capText.slice(0, 160))

    writeFreshTail()
    const sol = await inv('optimizer_solve', {})
    const solText = String(data(sol)?.result?.text ?? '')
    let solJson = null
    try { solJson = JSON.parse(solText) }
    catch { /* 非 JSON */ }
    const toolRunId = solJson?.runId ?? solJson?.run_id ?? ''
    check('R3.5', 'optimizer_solve 真实求解(optimal)', !data(sol)?.result?.isError && solJson?.status === 'optimal' && Boolean(toolRunId), `run=${toolRunId} status=${solJson?.status} text=${solText.slice(0, 120)}`)

    const plan = await inv('optimizer_plan_get', toolRunId ? { run_id: toolRunId } : {})
    const planText = String(data(plan)?.result?.text ?? '')
    check('R3.6', 'optimizer_plan_get 返回带证据状态的建议(verified|unverified)', !data(plan)?.result?.isError && /verified|unverified|已验证|未验证/.test(planText), planText.slice(0, 160))

    const status = await inv('optimizer_status', toolRunId ? { run_id: toolRunId } : {})
    const statusText = String(data(status)?.result?.text ?? '')
    check('R3.7', 'optimizer_status 返回终态', !data(status)?.result?.isError && /optimal|completed|done|succeeded/i.test(statusText), statusText.slice(0, 140))

    const cancel = await inv('optimizer_cancel', toolRunId ? { run_id: toolRunId } : {})
    const cancelText = String(data(cancel)?.result?.text ?? '')
    let cancelJson = null
    try { cancelJson = JSON.parse(cancelText) }
    catch { /* 非 JSON */ }
    check('R3.8', 'optimizer_cancel 对终态返回 cancelled=false(非 500)', !data(cancel)?.result?.isError && cancelJson?.cancelled === false, cancelText.slice(0, 140))
  }
}

// ════════════════════════════════════════════════════════════════
// 5. RBAC / 撤权
// ════════════════════════════════════════════════════════════════
console.log('\n=== 5. rbac ===')
{
  const email2 = `opt-viewer-${TAG}@awshop.local`
  const created2 = await api('POST', '/api/users', { name: `优化只读-${TAG}`, email: email2, password: 'OptView#2026', role: 'user' }, token)
  const login2 = await api('POST', '/api/users/login', { email: email2, password: 'OptView#2026' })
  const token2 = data(login2)?.token
  check('R2.6', '管理员创建第二用户并登录(非 admin)', Boolean(token2) && data(login2)?.user?.role === 'user', `create=${created2.status} login=${login2.status}`)
  const p = await api('GET', '/api/workshop/optimization/profiles', undefined, token2)
  check('R2.7', '非 editor 读 Profile → 403', p.status === 403, `${p.status}/${errCode(p)}`)
  const b = await api('GET', '/api/workshop/optimization/bindings', undefined, token2)
  check('R2.8', '非 admin 读全局绑定 → 403', b.status === 403, `${b.status}/${errCode(b)}`)
  const r = await api('GET', '/api/workshop/optimization/runs', undefined, token2)
  check('R2.9', '非 admin 读全局运行 → 403', r.status === 403, `${r.status}/${errCode(r)}`)
  const s = await api('GET', `/api/workshop/process-model/specs?lineId=${encodeURIComponent(line.id)}`, undefined, token2)
  check('R2.10', '无产线授权用户看不到规格(过滤为空)', s.status === 200 && (data(s)?.specs ?? []).length === 0, `n=${(data(s)?.specs ?? []).length}`)
  const deny = await api('POST', '/api/workshop/process-model/specs', specBody(`pms-deny-${TAG}`), token2)
  check('R2.11', '无产线授权用户登记规格 → 403', deny.status === 403, `${deny.status}/${errCode(deny)}`)

  const revoke = await api('DELETE', `/api/workshop/optimization/bindings/${encodeURIComponent(bindingId)}`, undefined, token)
  check('R2.12', 'DELETE /bindings/:id 撤权', revoke.status === 200 && data(revoke)?.revoked === true, `${revoke.status}`)
  const after = await api('GET', `/api/workshop/optimization/bindings?agentInstanceId=${encodeURIComponent(leadAgentId)}`, undefined, token)
  check('R2.13', '撤权后绑定列表为空', (data(after)?.bindings ?? []).length === 0, `n=${(data(after)?.bindings ?? []).length}`)
  const solveAfter = await api('POST', '/api/workshop/optimization/solve', { agentInstanceId: leadAgentId }, token)
  check('R2.14', '撤权后 solve → 409 BINDING_NOT_FOUND', solveAfter.status >= 400 && String(errCode(solveAfter)).includes('BINDING_NOT_FOUND'), `${solveAfter.status}/${errCode(solveAfter)}`)
}

// ════════════════════════════════════════════════════════════════
// 6. 真实浏览器 UI 全流程
// ════════════════════════════════════════════════════════════════
console.log('\n=== 6. UI /optimizer ===')
process.env.AW_BASE = BASE
process.env.AW_UI_SCALE = '1'
const { launch, openPage, gotoReady } = await import('./ui/lib.mjs')
const browser = await launch({ width: 1600, height: 1000 })
const page = await openPage(browser, { token, width: 1600, height: 1000, deviceScaleFactor: 1 })
const pageErrors = []
page.on('pageerror', e => pageErrors.push(`${e.message} | ${String(e.stack ?? '').split('\n').slice(0, 4).join(' <- ')}`.slice(0, 500)))
const shot = name => page.screenshot({ path: join(EVID, `${name}.png`), fullPage: true })

async function clickText(selector, text) {
  const ok = await page.evaluate((sel, txt) => {
    const el = Array.from(document.querySelectorAll(sel)).find(e => (e.textContent || '').trim().includes(txt))
    if (!el) return false
    el.click()
    return true
  }, selector, text)
  if (!ok) throw new Error(`找不到可点击元素 ${selector} 含「${text}」`)
  await sleep(300)
}
async function setInputByLabel(labelTextArg, value, tag = 'input') {
  const ok = await page.evaluate((targetLabel, val, elTag) => {
    const labels = Array.from(document.querySelectorAll('label'))
    const field = labels.find(l => (l.textContent || '').trim().startsWith(targetLabel))
    const el = field?.querySelector(elTag)
    if (!el) return false
    const proto = elTag === 'select'
      ? window.HTMLSelectElement.prototype
      : elTag === 'textarea' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set
    setter.call(el, String(val))
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  }, labelTextArg, value, tag)
  if (!ok) throw new Error(`找不到字段「${labelTextArg}」`)
  await sleep(150)
}
async function waitNotice(fragment, timeout = 180_000) {
  const t0 = Date.now()
  for (;;) {
    const state = await page.evaluate(frag => ({
      ok: document.querySelector('.banner.ok')?.textContent ?? '',
      err: document.querySelector('.banner.error')?.textContent ?? '',
      seen: (window.__awBanners ?? []).some(x => String(x.txt).includes(frag)),
    }), fragment)
    if (state.ok.includes(fragment) || state.seen) return state.ok || fragment
    if (Date.now() - t0 > timeout) {
      const hist = await page.evaluate(() => (window.__awBanners ?? []).slice(-6))
      throw new Error(`等待提示「${fragment}」超时;ok=${state.ok};error=${state.err};history=${JSON.stringify(hist)}`)
    }
    await sleep(200)
  }
}

try {
  // 控制页:确认 unhead dispose 报错是否平台级(与本次新增页面无关)
  const control = await openPage(browser, { token, width: 1280, height: 900, deviceScaleFactor: 1 })
  const controlErrors = []
  control.on('pageerror', e => controlErrors.push(String(e.message)))
  await gotoReady(control, '/tokens', { wait: 1200 })
  await control.close().catch(() => {})

  await gotoReady(page, '/optimizer', { wait: 2500 })
  // 记录 banner 历史:提示只存活 4s,轮询偶发错过的取证依据
  await page.evaluate(() => {
    window.__awBanners = []
    new MutationObserver(() => {
      document.querySelectorAll('.banner').forEach((b) => {
        const txt = String(b.textContent ?? '')
        if (txt && !window.__awBanners.some(x => x.txt === txt)) window.__awBanners.push({ t: Date.now(), cls: b.className, txt })
      })
    }).observe(document.body, { subtree: true, childList: true, characterData: true })
  })
  const title = await page.evaluate(() => document.querySelector('.aw-page-head h1')?.textContent?.trim() ?? '')
  const tabs = await page.evaluate(() => Array.from(document.querySelectorAll('.tabs button')).map(b => b.textContent.trim()))
  check('U1.1', '/optimizer 可打开(标题+五 tab)', title.includes('优化器') && tabs.length === 5, `title=${title} tabs=${tabs.join('|')}`)
  check('U1.2', '首屏无 pageerror(平台级 unhead dispose 已单列)', pageErrors.length === 0 || pageErrors.every(e => e.includes('dispose')), `${pageErrors.slice(0, 2).join(';')} | control=${controlErrors.slice(0, 1).join(';')}`)
  await shot('ui-01-spec-empty')

  // 规格 tab:填身份 + 两个变量
  await setInputByLabel('产线', line.id)
  await setInputByLabel('产品', product.id)
  await setInputByLabel('配方', recipe.id)
  await setInputByLabel('配方版本', recipe.version ?? 1)
  await setInputByLabel('采样节拍', BEAT)
  await setInputByLabel('历史步数', H)
  await setInputByLabel('预测时域', F)
  // 变量 1(mv)
  await setInputByLabel('变量 id', 'mv1')
  await setInputByLabel('节点 id', MV_ID)
  await setInputByLabel('单位', 'bar')
  await setInputByLabel('延迟', DELAY_STEPS * BEAT)
  await setInputByLabel('下限', 0)
  await setInputByLabel('上限', 100)
  await setInputByLabel('单步限幅', 20)
  await clickText('button', '添加变量')
  // 变量 2(cv)
  await setInputByLabel('变量 id', 'cv1')
  await setInputByLabel('角色', 'cv', 'select')
  await setInputByLabel('节点 id', CV_ID)
  await setInputByLabel('单位', 'μm')
  await setInputByLabel('下限', 0)
  await setInputByLabel('上限', 200)
  await clickText('button', '添加变量')
  const varRows = await page.evaluate(() => document.querySelectorAll('.tbl tbody tr').length)
  check('U1.3', 'UI 添加 MV/CV 两行变量', varRows >= 2, `rows=${varRows}`)
  await clickText('button', '登记规格')
  const specNotice = await waitNotice('规格已登记', 60_000)
  const savedSpecId = /规格已登记:([^\s@(]+)@(\d+)/.exec(specNotice)?.[1] ?? ''
  check('U1.4', 'UI 登记规格 → 后端 draft 回读', Boolean(savedSpecId), `${specNotice}`)

  await setInputByLabel('采样节拍', BEAT)
  await clickText('button', '构建数据集')
  const dsNotice = await waitNotice('数据集已构建', 180_000)
  check('U1.5', 'UI 构建数据集(v2)成功', /数据集已构建:[^\s(]+\(\d+ 窗\)/.test(dsNotice), dsNotice)

  await clickText('.tabs button', '资格报告')
  await clickText('button', '评估资格')
  await waitNotice('资格评估完成', 120_000)
  await sleep(400)
  const eligText = await page.evaluate(() => document.querySelector('.panel')?.textContent ?? '')
  check('U1.6', 'UI 资格报告渲染(具备资格 + simulation + 证据)', eligText.includes('具备优化资格') && eligText.includes('simulation') && !eligText.includes('尚未评估'), eligText.replace(/\s+/g, ' ').slice(0, 160))
  await shot('ui-02-eligibility')

  await clickText('.tabs button', '模型规格')
  await clickText('button', '提交训练')
  const trainNotice = await waitNotice('训练作业已提交', 60_000)
  const uiJobId = /训练作业已提交:([^\s]+)/.exec(trainNotice)?.[1] ?? ''
  check('U1.7', 'UI 提交训练作业', Boolean(uiJobId), trainNotice)
  let uiJob = null
  for (let i = 0; i < 240; i++) {
    const jr = await api('GET', `/api/workshop/aml/jobs/${encodeURIComponent(uiJobId)}`, undefined, token)
    uiJob = data(jr)?.job
    if (uiJob && ['done', 'failed', 'cancelled', 'timeout', 'interrupted'].includes(uiJob.status)) break
    await sleep(500)
  }
  check('U1.8', 'UI 训练作业完成并产出模型', uiJob?.status === 'done' && Boolean(uiJob?.modelId), `status=${uiJob?.status} model=${uiJob?.modelId}`)
  const uiModelId = uiJob?.modelId

  await clickText('.tabs button', 'Profile / Solver')
  await setInputByLabel('id', `optp-ui-${TAG}`)
  await setInputByLabel('模型 id', uiModelId)
  await setInputByLabel('processSpecRef', `${savedSpecId}@1`)
  await clickText('button', '登记 Profile')
  await waitNotice('Profile 已登记', 60_000)
  const pubBtn = await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button')).find(b => (b.textContent || '').trim() === '发布')
    if (btn) { btn.click(); return true }
    return false
  })
  check('U1.9', 'UI 登记 Profile 并出现发布按钮', pubBtn)
  await waitNotice('Profile 已发布', 60_000)
  const profileRowText = await page.evaluate(() => document.querySelector('.tbl tbody')?.textContent ?? '')
  check('U1.10', 'UI Profile 表格显示 published', profileRowText.includes('published') && profileRowText.includes(uiModelId), profileRowText.replace(/\s+/g, ' ').slice(0, 160))
  await shot('ui-03-profile')

  await clickText('.tabs button', 'Agent 绑定')
  await setInputByLabel('workspaceId', workspaceId)
  await setInputByLabel('channelId', channelId)
  await setInputByLabel('Agent 实例 id', leadAgentId)
  await setInputByLabel('profileId', `optp-ui-${TAG}`)
  await setInputByLabel('profileVersion', 1)
  await clickText('button', '创建绑定')
  await waitNotice('绑定已创建', 60_000)
  const bindRow = await page.evaluate(() => document.querySelector('.tbl tbody')?.textContent ?? '')
  check('U1.11', 'UI 创建绑定并回读行', bindRow.includes(leadAgentId) && bindRow.includes(`optp-ui-${TAG}`), bindRow.replace(/\s+/g, ' ').slice(0, 140))
  await shot('ui-04-binding')

  await clickText('.tabs button', '运行 / 建议')
  await setInputByLabel('Agent 实例 id', leadAgentId)
  writeFreshTail()
  await clickText('button', '求解一次')
  await waitNotice('求解完成', 180_000)
  await sleep(800)
  const runRowText = await page.evaluate(() => document.querySelector('.tbl tbody')?.textContent ?? '')
  const unverified = await page.evaluate(() => document.querySelector('.unverified')?.textContent ?? '')
  check('U1.12', 'UI 求解成功并渲染运行/建议行(状态徽章二态)', runRowText.includes('optimal') && /未验证|已验证/.test(runRowText), runRowText.replace(/\s+/g, ' ').slice(0, 200))
  check('U1.13', '建议状态徽章醒目标识(.unverified)', /未验证|已验证/.test(unverified), unverified.slice(0, 80))
  await shot('ui-05-runs')

  // 前端错误面:非法 JSON 必须在本地被拦住并给出可读提示
  await clickText('.tabs button', 'Profile / Solver')
  await setInputByLabel('id', `optp-ui-bad-${TAG}`)
  await setInputByLabel('问题配置', '{invalid', 'textarea')
  await clickText('button', '登记 Profile')
  let errText = ''
  for (let i = 0; i < 60; i++) {
    errText = await page.evaluate(() => document.querySelector('.banner.error')?.textContent ?? '')
    if (errText) break
    await sleep(100)
  }
  check('U1.15', '非法 JSON → 前端错误提示(不崩溃)', /JSON|Unexpected|Syntax/i.test(errText), errText.replace(/\s+/g, ' ').slice(0, 160))
  check('U1.16', 'UI 全流程(含错误路径)无 pageerror', pageErrors.length === 0, pageErrors.join(';'))
}
catch (err) {
  check('UI', 'UI 流程异常', false, err instanceof Error ? err.message : String(err))
  try { await shot('ui-failure') }
  catch { /* 截图失败 */ }
}
finally {
  await browser.close().catch(() => {})
}

// ════════════════════════════════════════════════════════════════
// 7. AgentChannel 适配矩阵
// ════════════════════════════════════════════════════════════════
console.log('\n=== 7. channel matrix ===')
const toolList = async agentId => data(await api('GET', `/api/workshop/agent-tools/list?agentId=${encodeURIComponent(agentId)}`, undefined, token))?.tools ?? []
const toolNames = list => list.map(t => t.name)
const NEW_OPTIMIZER_TOOLS = ['optimizer_capabilities', 'optimizer_solve', 'optimizer_status', 'optimizer_cancel', 'optimizer_plan_get']
const hasNewOptimizerTool = names => NEW_OPTIMIZER_TOOLS.some(n => names.includes(n))
const invokeTool = (agentId, tool, args = {}) => api('POST', '/api/workshop/agent-tools/invoke', { agentId, tool, args }, token)
const invText = r => String(data(r)?.result?.text ?? '')
const invErr = r => Boolean(data(r)?.result?.isError)

async function mkTemplateChannel(templateId, name, extra = {}) {
  const r = await api('POST', `/api/workshop/channel-templates/${encodeURIComponent(templateId)}/instantiate`, { name, ...extra }, token)
  const d = data(r)
  const lead = d?.leadAgentId ?? d?.agents?.find(a => a.role === 'lead')?.id
  const w = await api('POST', '/api/workshop/workspaces', { name: `${name}-ws` }, token)
  const wid = data(w)?.id
  if (wid && d?.channelId) await api('POST', `/api/workshop/workspaces/${wid}/channels/${d.channelId}`, undefined, token)
  return { status: r.status, channelId: d?.channelId, lead, workspaceId: wid, agents: d?.agents ?? [] }
}
async function bindProfile(ws, ch, agent, pid) {
  return api('POST', '/api/workshop/optimization/bindings', {
    workspaceId: ws, channelId: ch, agentInstanceId: agent, profileId: pid, profileVersion: 1,
  }, token)
}
async function ensureProfile(id, modelId, template, solver, config, specRef) {
  const r = await api('POST', '/api/workshop/optimization/profiles', {
    schemaVersion: 1, id, version: 1,
    modelRef: { modelId, artifactKind: 'linear_state_space@1', artifactHash: '', modelInterface: 'linear_state_space', stage: 'candidate' },
    problemTemplateRef: template, problemConfig: config, solverRef: solver, solverVersion: '1',
    processSpecRef: specRef, conditionIds: [], status: 'draft',
  }, token)
  if (r.status === 200) await api('POST', `/api/workshop/optimization/profiles/${encodeURIComponent(id)}/publish?version=1`, undefined, token)
  return r
}
async function waitJob(jobId) {
  const terminal = new Set(['done', 'failed', 'cancelled', 'timeout', 'interrupted'])
  let job = null
  for (let i = 0; i < 240; i++) {
    job = data(await api('GET', `/api/workshop/aml/jobs/${encodeURIComponent(jobId)}`, undefined, token))?.job
    if (job && terminal.has(job.status)) break
    await sleep(500)
  }
  return job
}

{
  // legacy(无绑定):注入面不含 optimizer_*,直调明确拒绝
  const legacyNames = toolNames(await toolList(leadAgentId))
  check('C1', 'legacy Channel 不注入新 optimizer_*(5 工具)', !hasNewOptimizerTool(legacyNames), legacyNames.filter(n => NEW_OPTIMIZER_TOOLS.includes(n)).join(','))
  const legacyInvoke = await invokeTool(leadAgentId, 'optimizer_solve', {})
  check('C2', 'legacy Channel 直调 optimizer_solve → OPTIMIZER_CHANNEL_DISABLED', invErr(legacyInvoke) && invText(legacyInvoke).includes('OPTIMIZER_CHANNEL_DISABLED'), invText(legacyInvoke).slice(0, 120))

  // 训练 Channel:训练面可用,求解面拒绝
  const trainCh = await mkTemplateChannel('chtpl-aml-training-default', `训练频道-${TAG}`)
  const trainNames = toolNames(await toolList(trainCh.lead))
  check('C3', 'aml_training:不注入新 optimizer_*,保留训练工具', trainCh.status === 200 && !hasNewOptimizerTool(trainNames) && trainNames.includes('aml_job_submit'), `n=${trainNames.length}`)
  const trainInvoke = await invokeTool(trainCh.lead, 'optimizer_solve', {})
  check('C4', 'aml_training 直调 optimizer_solve → OPTIMIZER_PROFILE_DENIED', invErr(trainInvoke) && invText(trainInvoke).includes('OPTIMIZER_PROFILE_DENIED'), invText(trainInvoke).slice(0, 120))

  // 观察面:无求解工具
  const minerCh = await mkTemplateChannel('chtpl-exp-miner-default', `经验工程师-${TAG}`)
  const minerNames = toolNames(await toolList(minerCh.lead))
  const minerInvoke = await invokeTool(minerCh.lead, 'optimizer_solve', {})
  check('C5', 'exp-miner 观察面:无新 optimizer_* 且直调拒绝', minerCh.status === 200 && !hasNewOptimizerTool(minerNames) && invErr(minerInvoke) && invText(minerInvoke).includes('OPTIMIZER_PROFILE_DENIED'), `${minerNames.filter(n => NEW_OPTIMIZER_TOOLS.includes(n)).join(',')}|${invText(minerInvoke).slice(0, 60)}`)

  // hybrid_twin:绑定后可注入且可求解
  const hybridCh = await mkTemplateChannel('chtpl-hybrid-twin-mpc-default', `孪生频道-${TAG}`)
  const hb = await bindProfile(hybridCh.workspaceId, hybridCh.channelId, hybridCh.lead, profileId)
  const hybridNames = toolNames(await toolList(hybridCh.lead))
  check('C6', 'hybrid_twin + 绑定:注入 optimizer_* 且 solve 带 binding_id', hb.status === 200 && hybridNames.includes('optimizer_solve') && JSON.stringify((await toolList(hybridCh.lead)).find(t => t.name === 'optimizer_solve')?.parameters ?? {}).includes('binding_id'), `bind=${hb.status}`)
  writeFreshTail()
  const hybridSolve = await invokeTool(hybridCh.lead, 'optimizer_solve', {})
  let hybridSol = null
  try { hybridSol = JSON.parse(invText(hybridSolve)) }
  catch { /* 非 JSON */ }
  const hybridRunId = hybridSol?.runId ?? ''
  check('C7', 'hybrid_twin 真实求解 optimal', !invErr(hybridSolve) && hybridSol?.status === 'optimal', `run=${hybridRunId} status=${hybridSol?.status}`)

  // 同 Channel 两 Agent:不同 Profile 互不可见;无绑定者只有 capabilities
  const workerRow = data(await api('POST', `/api/workshop/channels/${hybridCh.channelId}/agents`, { name: `孪生worker-${TAG}`, harness: 'mock', role: 'worker' }, token))
  const workerId = workerRow?.id ?? workerRow?.agent?.id
  const unboundNames = toolNames(await toolList(workerId))
  check('C8', '同 Channel 未绑定 Agent:有 capabilities、无 solve', Boolean(workerId) && unboundNames.includes('optimizer_capabilities') && !unboundNames.includes('optimizer_solve'), `names=${unboundNames.filter(n => n.startsWith('optimizer_')).join(',')}`)
  const workerProfileId = `optp-worker-${TAG}`
  await ensureProfile(workerProfileId, trainedModelId, 'linear_mpc_quadratic@1', 'osqp_mpc@1', {
    linear_mpc_quadratic: { cvWeights: { cv1: 1 }, duWeights: { mv1: 0.1 }, terminalWeight: 2, targets: { cv1: 48 } },
  }, `${SPEC}@1`)
  const wb = await bindProfile(hybridCh.workspaceId, hybridCh.channelId, workerId, workerProfileId)
  const boundNames = toolNames(await toolList(workerId))
  check('C9', '同 Channel 两 Agent 各自绑定:worker 获得 solve', wb.status === 200 && boundNames.includes('optimizer_solve'), `bind=${wb.status}`)
  writeFreshTail()
  const workerSolve = await invokeTool(workerId, 'optimizer_solve', {})
  let workerSol = null
  try { workerSol = JSON.parse(invText(workerSolve)) }
  catch { /* 非 JSON */ }
  check('C10', 'worker 用自己的绑定求解 optimal', !invErr(workerSolve) && workerSol?.status === 'optimal', `run=${workerSol?.runId} status=${workerSol?.status}`)
  const crossStatus = await invokeTool(workerId, 'optimizer_status', { run_id: hybridRunId })
  check('C11', 'worker 读他人 run → BINDING_NOT_OWNED/不属于', invErr(crossStatus) && /NOT_OWNED|不属于|无权/.test(invText(crossStatus)), invText(crossStatus).slice(0, 120))
  const wbRevoke = await api('DELETE', `/api/workshop/optimization/bindings/${encodeURIComponent(wb?.data?.binding?.id ?? '')}`, undefined, token)
  const afterRevokeNames = toolNames(await toolList(workerId))
  check('C12', '撤权后工具面立即收回 solve', wbRevoke.status === 200 && !afterRevokeNames.includes('optimizer_solve') && afterRevokeNames.includes('optimizer_capabilities'), `n=${afterRevokeNames.filter(n => n.startsWith('optimizer_')).join(',')}`)
}

// ════════════════════════════════════════════════════════════════
// 8. 静态响应面场景端到端(static_response@1 + scipy_slsqp@1)
// ════════════════════════════════════════════════════════════════
console.log('\n=== 8. static response scenario ===')
{
  const sSpecId = `pms-static-${TAG}`
  const sSpecBody = {
    schemaVersion: 2, id: sSpecId, version: 1,
    lineId: line3.id, productId: product3.id, recipeId: recipe3.id, recipeVersion: recipe3.version ?? 1,
    conditions: [{ id: 'c1', match: [{ field: 'recipeId', op: 'eq', value: recipe3.id }] }],
    variables: [
      { id: 'mv1', nodeId: MV3, role: 'mv', field: 'value', unit: 'bar', scale: 1, offset: 0, delayMs: 0, min: 30, max: 90, maxStep: 10 },
      { id: 'cv1', nodeId: CV3, role: 'cv', field: 'value', unit: 'μm', scale: 1, offset: 0, min: 20, max: 80 },
    ],
    timing: { beatMs: BEAT, historySteps: H, horizonSteps: 1, fixedDt: true },
    trainer: { ref: 'static_response@1', config: { order: 2, ridgeLambda: 1e-3, standardize: true } },
    datasetPolicy: { split: { valRatio: 0.4, testRatio: 0.4, seed: 42 }, cleaning: { hampelK: 0 } },
    gatePolicyRef: 'process-model.gates@1',
    modelInterface: { id: 'static_response', version: 1, inputSemantics: 'setpoint', mode: 'static' },
    effectiveDomain: { mv: { mv1: { min: 30, max: 90, maxStep: 10 } }, cv: { cv1: { min: 20, max: 80 } } },
    purpose: 'mpc_surrogate',
  }
  const sSpec = await api('POST', '/api/workshop/process-model/specs', sSpecBody, token)
  await api('POST', `/api/workshop/process-model/specs/${encodeURIComponent(sSpecId)}/publish?version=1`, undefined, token)
  const sDs = await api('POST', '/api/workshop/process-model/datasets', sSpecBody, token)
  const sDatasetId = data(sDs)?.datasetId
  const sElig = await api('POST', '/api/workshop/process-model/eligibility', { specId: sSpecId, specVersion: 1, datasetId: sDatasetId, scope: 'simulation' }, token)
  check('S1', '静态场景:规格/数据集/资格链', sSpec.status === 200 && Boolean(sDatasetId) && data(sElig)?.report?.optimizationEligible === true, `rows=${data(sDs)?.rowCount} gaps=${(data(sElig)?.report?.gaps ?? []).map(g => g.code).join(',') || 'none'} msg=${sDs.message ?? ''}`)
  const sTrain = await api('POST', '/api/workshop/process-model/train', { spec: sSpecBody, datasetId: sDatasetId, modelName: `静态响应模型-${TAG}` }, token)
  const sJob = await waitJob(data(sTrain)?.job?.id)
  const sModelId = sJob?.modelId
  staticModelId = sModelId ?? ''
  const sModels = await api('GET', `/api/workshop/aml/models?recipeId=${encodeURIComponent(recipe3.id)}`, undefined, token)
  const sModel = (data(sModels)?.models ?? []).find(m => m.id === sModelId)
  check('S2', '静态训练器完成 + static_response@1 工件', sJob?.status === 'done' && sModel?.artifactKind === 'static_response@1' && sModel?.modelInterface === 'static_response', `status=${sJob?.status} kind=${sModel?.artifactKind} err=${sJob?.error ?? ''}`)
  const sProfileId = `optp-static-${TAG}`
  const sProf = await ensureProfile(sProfileId, sModelId, 'steady_response@1', 'scipy_slsqp@1', {
    steady_response: { economicWeights: { mv1: -0.01 }, cvWeights: { cv1: 1 }, targets: { cv1: 55 } },
  }, `${sSpecId}@1`)
  const sOsqp = await api('POST', '/api/workshop/optimization/profiles', {
    schemaVersion: 1, id: `optp-static-bad-${TAG}`, version: 1,
    modelRef: { modelId: sModelId, artifactKind: 'linear_state_space@1', artifactHash: '', modelInterface: 'linear_state_space', stage: 'candidate' },
    problemTemplateRef: 'linear_mpc_quadratic@1', problemConfig: { linear_mpc_quadratic: { cvWeights: { cv1: 1 }, duWeights: { mv1: 0.1 }, terminalWeight: 1, targets: { cv1: 50 } } },
    solverRef: 'osqp_mpc@1', solverVersion: '1', processSpecRef: `${sSpecId}@1`, conditionIds: [], status: 'draft',
  }, token)
  check('S3', '静态工件 + OSQP → 422 UNSUPPORTED_MODEL_SOLVER', sOsqp.status === 422 && String(errCode(sOsqp)).includes('UNSUPPORTED_MODEL_SOLVER'), `${sOsqp.status}/${errCode(sOsqp)}`)
  const sCh = await mkTemplateChannel('chtpl-aml-optimization-default', `静态优化频道-${TAG}`)
  const sb = await bindProfile(sCh.workspaceId, sCh.channelId, sCh.lead, sProfileId)
  const sTEnd = Math.floor(Date.now() / BEAT) * BEAT
  writeTailFor(sTEnd, seededRuns3[seededRuns3.length - 1].id, {
    lineId: line3.id, productId: product3.id, recipeId: recipe3.id,
    values: { [MV3]: Array(H).fill(60), [CV3]: Array(H).fill(50) },
  })
  const sSolve = await invokeTool(sCh.lead, 'optimizer_solve', {})
  let sSol = null
  try { sSol = JSON.parse(invText(sSolve)) }
  catch { /* 非 JSON */ }
  const smv = sSol?.firstMove?.mv1
  check('S4', '静态场景 Agent 求解(SLSQP) optimal 且命中目标', sProf.status === 200 && sb.status === 200 && !invErr(sSolve) && sSol?.status === 'optimal' && Number.isFinite(smv) && smv >= 55 && smv <= 75, `profile=${sProf.status} bind=${sb.status} status=${sSol?.status} mv=${smv} msg=${invText(sSolve).slice(0, 80)}`)
}

// ════════════════════════════════════════════════════════════════
// 9. 第三留出场景:双 MV / 双 CV + 单位换算,全链无代码训练→求解
// ════════════════════════════════════════════════════════════════
console.log('\n=== 9. scenario B (2 MV / 2 CV + unit conversion) ===')
{
  const bSpecId = `pms-b-${TAG}`
  const bSpecBody = {
    schemaVersion: 2, id: bSpecId, version: 1,
    lineId: line2.id, productId: product2.id, recipeId: recipe2.id, recipeVersion: recipe2.version ?? 1,
    conditions: [
      { id: 'c-low', match: [{ field: 'recipeId', op: 'eq', value: recipe2.id }, { field: 'recipeVersion', op: 'eq', value: 1 }] },
      { id: 'c-high', match: [{ field: 'recipeId', op: 'eq', value: recipe2.id }, { field: 'recipeVersion', op: 'range', value: [2, 3] }] },
    ],
    variables: [
      { id: 'flow_a', nodeId: MV2A, role: 'mv', field: 'value', unit: 'L/min', modelUnit: 'm3/h', scale: 0.06, offset: 0, delayMs: DELAY_STEPS * BEAT, min: 1, max: 7.2, maxStep: 0.6 },
      { id: 'flow_b', nodeId: MV2B, role: 'mv', field: 'value', unit: 'L/min', modelUnit: 'm3/h', scale: 0.06, offset: 0, delayMs: DELAY_STEPS * BEAT, min: 1, max: 4.8, maxStep: 0.6 },
      { id: 'thick', nodeId: CV2A, role: 'cv', field: 'value', unit: 'μm', scale: 1, offset: 0, min: 20, max: 60 },
      { id: 'width', nodeId: CV2B, role: 'cv', field: 'value', unit: 'mm', scale: 1, offset: 0, min: 20, max: 80 },
    ],
    timing: { beatMs: BEAT, historySteps: H, horizonSteps: F, fixedDt: true },
    trainer: { ref: 'linear_arx@1', config: { arOrder: 1, inputOrder: 1, ridgeLambda: 1e-6, standardize: true } },
    datasetPolicy: { split: { valRatio: 0.4, testRatio: 0.4, seed: 42 }, cleaning: { hampelK: 0 } },
    gatePolicyRef: 'process-model.gates@1',
    modelInterface: { id: 'linear_state_space', version: 1, inputSemantics: 'setpoint', mode: 'state_space' },
    effectiveDomain: {
      mv: { flow_a: { min: 1, max: 6, maxStep: 0.6 }, flow_b: { min: 1, max: 4.8, maxStep: 0.6 } },
      cv: { thick: { min: 20, max: 60 }, width: { min: 20, max: 80 } },
    },
    purpose: 'mpc_surrogate',
  }
  const bSpec = await api('POST', '/api/workshop/process-model/specs', bSpecBody, token)
  await api('POST', `/api/workshop/process-model/specs/${encodeURIComponent(bSpecId)}/publish?version=1`, undefined, token)
  const bDs = await api('POST', '/api/workshop/process-model/datasets', bSpecBody, token)
  const bDatasetId = data(bDs)?.datasetId
  const bElig = await api('POST', '/api/workshop/process-model/eligibility', { specId: bSpecId, specVersion: 1, datasetId: bDatasetId, scope: 'simulation' }, token)
  const bTrain = await api('POST', '/api/workshop/process-model/train', { spec: bSpecBody, datasetId: bDatasetId, modelName: `双变量模型-${TAG}` }, token)
  const bJob = await waitJob(data(bTrain)?.job?.id)
  const bModelId = bJob?.modelId
  const bModels = await api('GET', `/api/workshop/aml/models?recipeId=${encodeURIComponent(recipe2.id)}`, undefined, token)
  const bModel = (data(bModels)?.models ?? []).find(m => m.id === bModelId)
  check('B1', '双变量场景:无代码训练完成 + 2MV/2CV 工件', bSpec.status === 200 && data(bElig)?.report?.optimizationEligible === true && bJob?.status === 'done' && bModel?.artifactKind === 'linear_state_space@1', `rows=${data(bDs)?.rowCount} status=${bJob?.status} model=${bModelId}`)
  const bProfileId = `optp-b-${TAG}`
  await ensureProfile(bProfileId, bModelId, 'linear_mpc_quadratic@1', 'osqp_mpc@1', {
    linear_mpc_quadratic: {
      cvWeights: { thick: 1, width: 1 }, duWeights: { flow_a: 0.1, flow_b: 0.1 }, terminalWeight: 2,
      targets: { thick: 45, width: 45 },
    },
  }, `${bSpecId}@1`)
  const bCh = await mkTemplateChannel('chtpl-aml-optimization-default', `双变量频道-${TAG}`)
  const bb = await bindProfile(bCh.workspaceId, bCh.channelId, bCh.lead, bProfileId)
  const bRunId = seededRuns2[seededRuns2.length - 1].id
  const tEnd = Math.floor(Date.now() / BEAT) * BEAT
  writeTailFor(tEnd, bRunId, {
    lineId: line2.id, productId: product2.id, recipeId: recipe2.id,
    values: {
      // TSDB 存物理单位;context 按 spec.scale(0.06) 转成模型单位 m3/h
      [MV2A]: Array.from({ length: H }, (_, i) => 60 + 5 * Math.sin(i / 3)),
      [MV2B]: Array.from({ length: H }, (_, i) => 40 + 4 * Math.sin(i / 4)),
      [CV2A]: Array.from({ length: H }, (_, i) => 42 + 0.5 * Math.sin(i / 5)),
      [CV2B]: Array.from({ length: H }, (_, i) => 40 + 0.5 * Math.cos(i / 5)),
    },
  })
  const bSolve = await invokeTool(bCh.lead, 'optimizer_solve', {})
  let bSol = null
  try { bSol = JSON.parse(invText(bSolve)) }
  catch { /* 非 JSON */ }
  const fm = bSol?.firstMove ?? {}
  check('B2', '双变量场景 Agent 求解 optimal(模型单位 m3/h)', bb.status === 200 && !invErr(bSolve) && bSol?.status === 'optimal' && Number.isFinite(fm.flow_a) && Number.isFinite(fm.flow_b) && fm.flow_a >= 1 && fm.flow_a <= 6 && fm.flow_b >= 1 && fm.flow_b <= 4.8, `bind=${bb.status} status=${bSol?.status} first=${JSON.stringify(fm)} msg=${invText(bSolve).slice(0, 140)}`)
  const bSpecList = await api('GET', `/api/workshop/process-model/specs?lineId=${encodeURIComponent(line2.id)}`, undefined, token)
  const bRow = (data(bSpecList)?.specs ?? []).find(s => s.id === bSpecId)
  const scaleOk = (bRow?.spec?.variables ?? []).some(v => v.id === 'flow_a' && v.modelUnit === 'm3/h' && v.scale === 0.06)
  check('B3', '单位换算随规格持久化(scale=0.06/模型单位 m3/h)', scaleOk, JSON.stringify((bRow?.spec?.variables ?? []).map(v => [v.id, v.unit, v.modelUnit, v.scale])))
}

// ════════════════════════════════════════════════════════════════
// 10. AML 数字孪生模型适配(Twin Gate / 通道绑定 / 旧工件边界)
// ════════════════════════════════════════════════════════════════
console.log('\n=== 10. AML twin adaptation ===')
{
  // 把流程模型补齐 Twin Gate 证据并晋升 production(模拟 AML 评审后产物)
  const db = new DatabaseSync(join(HOME, 'data', 'workshop.sqlite'))
  db.exec('PRAGMA busy_timeout=8000')
  db.prepare('UPDATE aml_models SET stage = ?, metrics_json = ? WHERE id = ?').run(
    'production',
    JSON.stringify({ twinEligibility: { recommendationEligible: true, uqPassed: true, oodPassed: true, physicsPassed: true }, nrmse: 0.01 }),
    trainedModelId,
  )
  db.close()
  const twinCh = await mkTemplateChannel('chtpl-aml-optimization-default', `孪生适配频道-${TAG}`, {
    optimizationMode: 'exploration',
    scene: { sceneId: `acc-twin-${TAG}`, sceneVersion: '1.0.0', lineId: line.id },
  })
  const bindModel = await api('PATCH', `/api/workshop/channels/${twinCh.channelId}/twin-profile`, { boundModelId: trainedModelId }, token)
  const bindModelData = data(bindModel)
  check('T1', 'Channel 绑定 Twin Gate 通过的 AML 模型(aml 模式)', bindModel.status === 200 && bindModelData?.mode === 'model_backed' && bindModelData?.profile?.boundModelId === trainedModelId, `${bindModel.status}/${bindModelData?.mode}/${errCode(bindModel)}`)
  const twinNames = toolNames(await toolList(twinCh.lead))
  check('T2', '模型受控 Channel 注入 mpc/twin 工具', twinNames.includes('mpc_optimize') && twinNames.includes('twin_trial_run'), twinNames.filter(n => /mpc|twin_trial/.test(n)).join(','))

  // 未通过 Twin Gate/仍为 candidate 的模型不得绑定
  const badBindModel = await api('PATCH', `/api/workshop/channels/${twinCh.channelId}/twin-profile`, { boundModelId: staticModelId }, token)
  check('T3', 'candidate/Twin Gate 未过 → 409 拒绝', badBindModel.status === 409 && /AML_MODEL_(STAGE|GATE)/.test(String(errCode(badBindModel))), `${badBindModel.status}/${errCode(badBindModel)}`)

  // 旧 ONNX 孪生工件:可绑 Channel 走旧工具,但不能被新求解器消费
  const legacyModelId = `mdl-legacy-${TAG}`
  const mdb = new DatabaseSync(join(HOME, 'data', 'workshop.sqlite'))
  mdb.exec('PRAGMA busy_timeout=8000')
  const expRow = mdb.prepare('SELECT id FROM aml_experiments ORDER BY created_at DESC LIMIT 1').get()
  mdb.prepare(`INSERT INTO aml_models (id, experiment_id, dataset_id, product_id, recipe_id, purpose, stage,
      io_spec_json, metrics_json, path, created_by, note, label, description, line_id, objective_id,
      artifact_kind, schema_version, model_interface, artifact_hash, legacy, created_at)
    VALUES (?, ?, ?, ?, ?, 'mpc_surrogate', 'production', '{}', ?, '', 'acceptance', '', '旧ONNX孪生模型', 'legacy twin fixture', ?, '',
      'onnx_one_step@1', 1, 'one_step', ?, '', ?)`)
    .run(legacyModelId, expRow?.id ?? '', dynamicDatasetId, product.id, recipe.id,
      JSON.stringify({ twinEligibility: { recommendationEligible: true, uqPassed: true, oodPassed: true, physicsPassed: true } }),
      line.id, 'b'.repeat(64), new Date().toISOString())
  mdb.close()
  const legacyProfile = await api('POST', '/api/workshop/optimization/profiles', {
    schemaVersion: 1, id: `optp-legacy-${TAG}`, version: 1,
    modelRef: { modelId: legacyModelId, artifactKind: 'linear_state_space@1', artifactHash: '', modelInterface: 'linear_state_space', stage: 'candidate' },
    problemTemplateRef: 'linear_mpc_quadratic@1', problemConfig: { linear_mpc_quadratic: { cvWeights: { cv1: 1 }, duWeights: { mv1: 0.1 }, terminalWeight: 1, targets: { cv1: 50 } } },
    solverRef: 'osqp_mpc@1', solverVersion: '1', processSpecRef: `${SPEC}@1`, conditionIds: [], status: 'draft',
  }, token)
  check('T4', '旧 ONNX 孪生工件 → 新求解器 422 UNSUPPORTED_MODEL_SOLVER', legacyProfile.status === 422 && String(errCode(legacyProfile)).includes('UNSUPPORTED_MODEL_SOLVER'), `${legacyProfile.status}/${errCode(legacyProfile)}`)
  const bindLegacyModel = await api('PATCH', `/api/workshop/channels/${twinCh.channelId}/twin-profile`, { boundModelId: legacyModelId }, token)
  check('T5', '旧 ONNX 工件仍可绑定 Channel(旧工具面兼容)', bindLegacyModel.status === 200, `${bindLegacyModel.status}/${errCode(bindLegacyModel)}`)

  // 通道绑定模型 ≠ 优化器授权:无 optimizer binding 时 optimizer_solve 仍拒绝
  const noBindSolve = await invokeTool(twinCh.lead, 'optimizer_solve', {})
  check('T6', 'Channel 绑定模型不自动授权 optimizer_*', invErr(noBindSolve) && invText(noBindSolve).includes('BINDING_NOT_FOUND'), invText(noBindSolve).slice(0, 120))
  await bindProfile(twinCh.workspaceId, twinCh.channelId, twinCh.lead, profileId)
  writeFreshTail()
  const afterBindSolve = await invokeTool(twinCh.lead, 'optimizer_solve', {})
  let afterBindSol = null
  try { afterBindSol = JSON.parse(invText(afterBindSolve)) }
  catch { /* 非 JSON */ }
  check('T7', '补 optimizer binding 后同一 Channel 可求解(双闸门分离)', !invErr(afterBindSolve) && afterBindSol?.status === 'optimal', `status=${afterBindSol?.status}`)
}

// ════════════════════════════════════════════════════════════════
// 11. 数值求解的“真实收益”Live 闭环(仅应用首步,对照保持 50)
// ════════════════════════════════════════════════════════════════
console.log('\n=== 11. live closed-loop value ===')
{
  const valueProfileId = `optp-value-${TAG}`
  await ensureProfile(valueProfileId, trainedModelId, 'linear_mpc_quadratic@1', 'osqp_mpc@1', {
    linear_mpc_quadratic: { cvWeights: { cv1: 1 }, duWeights: { mv1: 0.1 }, terminalWeight: 2, targets: { cv1: 55 } },
  }, `${SPEC}@1`)
  const vCh = await mkTemplateChannel('chtpl-aml-optimization-default', `收益验证频道-${TAG}`)
  const vb = await bindProfile(vCh.workspaceId, vCh.channelId, vCh.lead, valueProfileId)
  const runId = seededRuns[seededRuns.length - 1].id
  const VALUE_STEPS = 12
  const TARGET = 55
  let y = 45
  const uq = Array(H).fill(50)
  const yq = Array(H).fill(45)
  const mpcErr = []
  const baseErr = []
  let baseY = 45
  let solveFail = ''
  for (let k = 0; k < VALUE_STEPS; k++) {
    const tEnd = Math.floor(Date.now() / BEAT) * BEAT
    writeTailFor(tEnd, runId, {
      lineId: line.id, productId: product.id, recipeId: recipe.id,
      values: { [MV_ID]: uq.slice(-H), [CV_ID]: yq.slice(-H) },
    })
    const r = await invokeTool(vCh.lead, 'optimizer_solve', {})
    let sol = null
    try { sol = JSON.parse(invText(r)) }
    catch { /* 非 JSON */ }
    if (invErr(r) || sol?.status !== 'optimal' || !Number.isFinite(sol?.firstMove?.mv1)) {
      solveFail = `step ${k}: ${invText(r).slice(0, 100)}`
      break
    }
    const prev = uq[uq.length - 1]
    const u = sol.firstMove.mv1
    if (u < -1e-6 || u > 100 + 1e-6 || Math.abs(u - prev) > 20 + 1e-6) {
      solveFail = `step ${k}: raw firstMove violates bounds/maxStep (${prev} → ${u})`
      break
    }
    uq.push(u)
    const delayed = uq[Math.max(0, uq.length - 1 - DELAY_STEPS)]
    const noise = 0.03 * Math.sin((k + 1) * 1.7)
    y = 0.3 * y + 0.7 * delayed + 8 + noise
    yq.push(y)
    const bDelayed = 50
    baseY = 0.3 * baseY + 0.7 * bDelayed + 8 + noise
    if (k >= DELAY_STEPS + 2) {
      mpcErr.push(Math.abs(y - TARGET))
      baseErr.push(Math.abs(baseY - TARGET))
    }
    await sleep(Math.max(200, tEnd + BEAT - Date.now() + 250))
  }
  const median = (xs) => {
    if (!xs.length) return Number.NaN
    const s = [...xs].sort((a, b) => a - b)
    return s[Math.floor(s.length / 2)]
  }
  const mpcMed = median(mpcErr)
  const baseMed = median(baseErr)
  const improve = (baseMed - mpcMed) / baseMed
  check('V1', 'Live 闭环:求解器首步驱动真实轨迹(仅首步,逐拍刷新上下文)', !solveFail && mpcErr.length >= 5 && vb.status === 200, solveFail || `steps=${VALUE_STEPS} samples=${mpcErr.length} bind=${vb.status}`)
  check('V2', '相对保持方案中位质量误差改善 ≥15%', improve >= 0.15 && Number.isFinite(improve), `base=${baseMed.toFixed(2)} mpc=${mpcMed.toFixed(2)} improve=${(improve * 100).toFixed(1)}%`)
  check('V3', '闭环 MV 始终在工艺窗口[0,100]', uq.every(v => v >= 0 && v <= 100), `min=${Math.min(...uq).toFixed(1)} max=${Math.max(...uq).toFixed(1)}`)
}

// ════════════════════════════════════════════════════════════════
// 11.5 治理下发集成流(W):互校 → 建卡 → HITL 批准 → D13 重验 → 设备写入
// ════════════════════════════════════════════════════════════════
{
  console.log('\n=== 11.5 governed dispatch (W) ===')
  const governedCh = await mkTemplateChannel('chtpl-aml-optimization-default', `治理下发频道-${TAG}`)
  const governedBinding = await bindProfile(governedCh.workspaceId, governedCh.channelId, governedCh.lead, profileId)
  writeFreshTail()
  const freshSolve = await api('POST', '/api/workshop/optimization/solve', { agentInstanceId: governedCh.lead }, token)
  const freshOutcome = data(freshSolve)
  const governedRecId = String(freshOutcome?.recommendation?.id ?? '')
  const mv = spec.variables.find(variable => variable.id === 'mv1')
  const firstMoveEngineering = (Number(freshOutcome?.result?.firstMove?.mv1) - mv.offset) / mv.scale
  check('W0', '下发使用新求解建议(避免旧建议超时/撤权)', governedBinding.status === 200 && freshSolve.status === 200 && freshOutcome?.result?.status === 'optimal' && Boolean(governedRecId) && governedRecId !== lastRecId && Number.isFinite(firstMoveEngineering), `bind=${governedBinding.status} solve=${freshSolve.status} status=${freshOutcome?.result?.status}`)
  const recPath = `/api/workshop/optimization/recommendations/${encodeURIComponent(governedRecId)}`
  const xcheck = await api('POST', `${recPath}/crosscheck`, {}, token)
  const xrow = data(xcheck)?.crosscheck
  check('W1', 'POST crosscheck:worker vs typed predictor 一致(pass)', xcheck.status === 200 && xrow?.verdict === 'pass', `${xcheck.status}/verdict=${xrow?.verdict} maxDev=${JSON.stringify(xrow?.maxDevDimensionless ?? xrow?.maxDev)}`)
  check('W2', '互校后 dual=true(verified+pass+fresh)', data(xcheck)?.dual?.dual === true, JSON.stringify(data(xcheck)?.dual?.latest ?? data(xcheck)?.dual).slice(0, 160))

  const smuggle = await api('POST', `${recPath}/dispatch`, { coverage: 0.99, uq: { qhat: 1 } }, token)
  check('W3', 'dispatch body 携带证据字段 → 422(D11 防伪)', smuggle.status === 422 && errCode(smuggle) === 'DISPATCH_BODY_EVIDENCE_FORBIDDEN', `${smuggle.status}/${errCode(smuggle)}`)

  const disp = await api('POST', `${recPath}/dispatch`, { note: '集成验收:申请下发' }, token)
  const cardId = String(data(disp)?.dispatch?.cardId ?? '')
  check('W4', 'dispatch 建卡成功(optimizer-recipe: 前缀)', disp.status === 200 && cardId.startsWith('optimizer-recipe:'), `${disp.status}/${cardId || errCode(disp)}`)

  const disp2 = await api('POST', `${recPath}/dispatch`, {}, token)
  check('W5', '同配方在飞卡阻止重复建卡 → 409 DISPATCH_RECIPE_IN_FLIGHT', disp2.status === 409 && errCode(disp2) === 'DISPATCH_RECIPE_IN_FLIGHT', `${disp2.status}/${errCode(disp2)}`)

  const pending = await api('GET', '/api/workshop/agent-tools/approvals', undefined, token)
  const card = (data(pending)?.approvals ?? []).find(a => a.nodeId === cardId && a.agentId === governedCh.lead && a.payload?.recommendationId === governedRecId)
  const cardMove = card?.payload?.packages?.[0]?.params?.find(param => param.nodeId === mv.controlNodeId)
  check('W6', '审批面精确返回当前下发卡及首步工程值', pending.status === 200 && Boolean(card) && Number.isFinite(cardMove?.to) && Math.abs(cardMove.to - firstMoveEngineering) <= 1e-6 && card.payload?.modelFirstMove?.mv1 === freshOutcome?.result?.firstMove?.mv1, `id=${card?.id ?? 'none'} nodeId=${card?.nodeId ?? 'none'} expected=${firstMoveEngineering} card=${cardMove?.to}`)

  if (card) {
    // 运行门前置(S7 加固):治理下发批准时要求产线在跑目标配方(活动批次)。
    // 治理 profile 绑定线A(line/recipe)—— 开跑线A(配方A 参数整批下发)。
    const wStart = await api('POST', `/api/workshop/dcw/lines/${line.id}/start`, { recipeId: recipe.id }, token)
    check('W6b', '治理下发的运行门前置:线A 开跑(活动批次=配方A)', wStart.status === 200, `status=${wStart.status} msg=${String(wStart?.message ?? '').slice(0, 140)}`)
    const decide = await api('POST', `/api/workshop/agent-tools/approvals/${encodeURIComponent(card.id)}/decide`, { approved: true, choice: 0, comment: '集成验收批准' }, token)
    const decided = data(decide)
    const dispatchResult = decided?.dispatch
    const acks = dispatchResult?.execution?.acks
    check('W7', 'HITL 批准 → 单一咽喉 D13 重验 → 整批下发', decide.status === 200 && dispatchResult?.approved === true && acks?.total === 1 && acks?.verified === 1 && acks?.failed === 0 && acks?.unverified === 0, `${decide.status}/${JSON.stringify(decided ?? decide).slice(0, 200)}`)
    await sleep(1500)
    const dcwState = await api('GET', '/api/workshop/dcw', undefined, token)
    const executedNode = (data(dcwState)?.nodes ?? []).find(node => node.id === mv.controlNodeId)
    const readback = executedNode?.readValue
    // 写入按节点小数位量化(DcwNode.applyRead toFixed(decimals));容差=仪表分辨率级,非浮点噪声级
    const tolerance = Math.max(0.5, Math.abs(firstMoveEngineering) * 1e-6)
    check('W8', '执行节点回读等于建议首步工程值(写入落设备,按节点分辨率量化)', dcwState.status === 200 && Number.isFinite(readback) && Math.abs(readback - firstMoveEngineering) <= tolerance, `node=${mv.controlNodeId} expected=${firstMoveEngineering} readValue=${readback} tolerance=${tolerance}`)
    const writesLedger = await api('GET', '/api/workshop/ops-logs?scope=all&limit=500', undefined, token)
    const recActions = (data(writesLedger)?.logs ?? []).filter(entry => entry.targetId === governedRecId).map(entry => entry.action)
    check('W9', '当前建议 request 与 execute 审计齐备', writesLedger.status === 200 && ['optimizer.dispatch.request', 'optimizer.dispatch.execute'].every(action => recActions.includes(action)), `status=${writesLedger.status} actions=${recActions.join(',')}`)
  }
  else {
    for (const id of ['W7', 'W8', 'W9']) check(id, '当前建议的精确审批卡缺失,下游验证失败', false, `cardId=${cardId} recommendationId=${governedRecId}`)
  }
}

// ════════════════════════════════════════════════════════════════
// 11.6 MCP 桥(M):optimizer 工具经 stdio MCP 可发现、可调用
// ════════════════════════════════════════════════════════════════
{
  console.log('\n=== 11.6 MCP bridge (M) ===')
  const mcpCh = await mkTemplateChannel('chtpl-aml-optimization-default', `MCP优化频道-${TAG}`)
  const mcpBinding = await bindProfile(mcpCh.workspaceId, mcpCh.channelId, mcpCh.lead, profileId)
  const agentTokenRow = seedDb.prepare('SELECT token AS t FROM channel_agents WHERE id = ?').get(mcpCh.lead)
  const agentToken = String(agentTokenRow?.t ?? '')
  check('M1', '已绑定优化频道 lead 实例 token 存在', mcpBinding.status === 200 && agentToken.length >= 16, `bind=${mcpBinding.status} tokenPresent=${Boolean(agentToken)}`)
  if (agentToken) {
    const mcpChild = spawn(process.execPath, [join(REPO, 'server', 'harness', 'aw-mcp-bridge.mjs')], {
      cwd: REPO,
      env: { ...process.env, NO_PROXY: '127.0.0.1,localhost', HTTP_PROXY: '', HTTPS_PROXY: '', AW_BASE_URL: BASE, AW_AGENT_ID: mcpCh.lead, AW_AGENT_TOKEN: agentToken, AW_MCP_TOOL_TIMEOUT_MS: '120000' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const pendingRpc = new Map()
    let nextId = 1
    const rl = createInterface({ input: mcpChild.stdout })
    let bridgeStderr = ''
    mcpChild.stderr.on('data', (chunk) => { bridgeStderr = (bridgeStderr + String(chunk)).slice(-2000) })
    const drainPending = () => {
      for (const resolve of pendingRpc.values()) resolve({ error: { message: 'MCP bridge exited' } })
      pendingRpc.clear()
    }
    mcpChild.on('error', drainPending)
    mcpChild.on('exit', drainPending)
    mcpChild.stdin.on('error', drainPending)
    rl.on('line', (line) => {
      try {
        const msg = JSON.parse(line)
        if (msg.id != null && pendingRpc.has(msg.id)) {
          pendingRpc.get(msg.id)(msg)
          pendingRpc.delete(msg.id)
        }
      }
      catch { /* 非协议行 */ }
    })
    const rpc = (method, params, timeoutMs = 30_000) => new Promise((resolve) => {
      const id = nextId++
      const timer = setTimeout(() => { pendingRpc.delete(id); resolve({ error: { message: `MCP ${method} timeout` } }) }, timeoutMs)
      pendingRpc.set(id, (msg) => { clearTimeout(timer); resolve(msg) })
      mcpChild.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
    const init = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'optimizer-usage-e2e', version: '1' } })
    check('M2', 'MCP initialize 会话建立', !init.error && init?.result?.protocolVersion === '2024-11-05' && init?.result?.serverInfo?.name === 'aw-host-tools' && init?.result?.capabilities?.tools?.listChanged === true, JSON.stringify(init?.result ?? init.error ?? {}).slice(0, 120))
    mcpChild.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
    const list = await rpc('tools/list', {})
    const names = (list?.result?.tools ?? []).map(t => t.name)
    check('M3', 'MCP tools/list 含 5 个 optimizer_* 工具', !list.error && ['optimizer_capabilities', 'optimizer_solve', 'optimizer_status', 'optimizer_cancel', 'optimizer_plan_get'].every(n => names.includes(n)), names.filter(n => n.startsWith('optimizer_')).join(',') || `total=${names.length} error=${JSON.stringify(list.error)}`)
    writeFreshTail()
    const call = await rpc('tools/call', { name: 'optimizer_solve', arguments: {} }, 120_000)
    const content = call?.result?.content ?? []
    const text = content.map(c => c.text ?? '').join('')
    let solveStatus = ''
    try { solveStatus = String(JSON.parse(text).status ?? '') }
    catch { /* 文本非 JSON */ }
    check('M4', 'MCP optimizer_solve 真实求解 optimal', !call.error && call?.result?.isError !== true && solveStatus === 'optimal', `status=${solveStatus} text=${text.slice(0, 140)} stderr=${bridgeStderr.slice(0, 100)}`)
    rl.close()
    mcpChild.stdin.end()
    mcpChild.kill()
  }
  else {
    for (const id of ['M2', 'M3', 'M4']) check(id, '优化频道 token 缺失,桥接验证失败', false)
  }
}

// ════════════════════════════════════════════════════════════════
// 12. 证据 + 收尾
// ════════════════════════════════════════════════════════════════
const pass = results.filter(r => r.pass).length
const total = results.length
const report = {
  at: new Date().toISOString(),
  base: BASE,
  seed: { lineId: line.id, productId: product.id, recipeId: recipe.id, runs: seededRuns.map(r => r.id), mv: MV_ID, cv: CV_ID },
  env: { node: process.version, platform: `${process.platform}-${process.arch}`, venvLinked, home: HOME },
  pass,
  total,
  results,
  pageErrors,
}
writeFileSync(join(EVID, 'report.json'), JSON.stringify(report, null, 2))
console.log(`\n${pass}/${total} 通过;证据:${join(EVID, 'report.json')}`)

// 验收联动:保留实例给 Playwright 业务交互阶段(优化器 UI 真实求解/建议徽章)。
// 父进程必须存活,否则 Windows 进程树回收会带走 dev server —— 这里挂起不退出,
// 由联调脚本完成 UI 断言后按端口整树终止。
if (process.env.AW_KEEP_ALIVE === '1') {
  const contextPath = join(REPO, '.omc', 'optimizer-live-keepalive.json')
  writeFileSync(contextPath, JSON.stringify({
    at: new Date().toISOString(), base: BASE, token, leadAgentId, workspaceId, channelId, bindingId,
  }, null, 2))
  console.log(`KEEPALIVE ${BASE} (context=${contextPath})`)
  await new Promise(() => { setInterval(() => {}, 1 << 30) })
}
else {
  try { child.kill() }
  catch { /* 已退出 */ }
  await sleep(500)
  process.exit(pass === total ? 0 : 1)
}
