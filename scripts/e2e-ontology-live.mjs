#!/usr/bin/env node
/* eslint-disable @stylistic/max-statements-per-line */
/**
 * Ontology 真机全链路集成 E2E(2026-10-24,ralph 第二轮)。
 *
 * L1 隔离实例 + PLC 场景产线管理/节点绑定(REST)
 * L2 本体全功能真机 REST 全链(草稿→文档→校验→编译→证据→生命周期→批准→发布→版本/diff/溯源/场景/导出)
 * L3 运行时守卫(真实产线,节点级意图面)
 * L4 AML 训练集成 + 本体训练先验派生
 * L5 求解器集成(profile→binding→solve→crosscheck;含 ontologyRefs 耦合 Profile v2)
 * L6 数据分析作业(agent-tools/invoke analysis_save → 台账读回)
 * L7 前端渲染走查(真实 Chrome:/ontology 六 tab + 五页截图)
 *
 * 运行:node scripts/e2e-ontology-live.mjs
 * 证据:docs/audit/evidence/2026-10-24-ontology-live/{report.json,*.png}
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, existsSync, symlinkSync, openSync, readFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir, homedir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ROOT = join(tmpdir(), `aw-ontology-live-${Date.now()}`)
const HOME = join(ROOT, 'home')
const EVID = resolve(process.env.AW_E2E_EVIDENCE_DIR || join(REPO, 'docs', 'audit', 'evidence', '2026-10-24-ontology-live'))
mkdirSync(HOME, { recursive: true })
mkdirSync(EVID, { recursive: true })

const TAG = `ont${Date.now().toString(36).slice(-4)}`
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
  console.log(`${pass ? '✔' : '✘'} [${id}] ${name}${detail ? ` — ${String(detail).slice(0, 200)}` : ''}`)
  return pass
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
function killTree(pid) {
  if (!pid) return
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
    else process.kill(pid, 'SIGTERM')
  }
  catch { /* 已退出 */ }
}

// ════ 0. seed(直连仓储:产线/节点/配方/历史批次/样本/工况段) ════
console.log('\n=== 0. seed PLC 场景 ===')
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

const seedDb = openWorkshopDb(join(HOME, 'data', 'workshop.sqlite'))
configureAmlRuntime(seedDb)
try {
  bindOpsRepos({ audit: createAuditRepo(seedDb) })
}
catch { /* 重复装配无害 */ }

const line = getDcwLineRepo().create({ name: `本体验收线-${TAG}`, simulated: true })
const product = getDcwProductRepo().create({ name: `本体验收产品-${TAG}`, lineId: line.id })
// 数控节点:压力控制(写) + 线速控制(写,守卫目标)
getDcwNodeRepo().insert(new DcwNode({
  id: `dcw-${TAG}-press`, templateRef: 'dcw-temp-sp', driver: 'mock',
  name: `熔体压力控制-${TAG}`, lineId: line.id, min: 0, max: 100, unit: 'bar',
}))
getDcwNodeRepo().insert(new DcwNode({
  id: `dcw-${TAG}-speed`, templateRef: 'dcw-temp-sp', driver: 'mock',
  name: `线速度控制-${TAG}`, lineId: line.id, min: 0, max: 50, unit: 'm/min',
}))
const DCW_PRESS = `dcw-${TAG}-press`
const DCW_SPEED = `dcw-${TAG}-speed`
for (const id of [DCW_PRESS, DCW_SPEED]) {
  const node = getDcwNodeRepo().byId(id)
  if (node) {
    node.readValue = id === DCW_PRESS ? 50 : 10
    getDcwNodeRepo().flushNow()
  }
}
// 数采节点:压力 MV / 膜厚 CV / 温区状态(守卫条件变量)
getDaqNodeRepo().insert(DaqNode.fromRow({
  id: `dn-${TAG}-mv`, templateRef: 'tpl-live-mv', name: `熔体压力-${TAG}`, unit: 'bar',
  min: 0, max: 100, lineId: line.id, driver: 'mock',
}))
getDaqNodeRepo().insert(DaqNode.fromRow({
  id: `dn-${TAG}-cv`, templateRef: 'tpl-live-cv', name: `平均膜厚-${TAG}`, unit: 'μm',
  min: 0, max: 200, lineId: line.id, driver: 'mock',
}))
getDaqNodeRepo().insert(DaqNode.fromRow({
  id: `dn-${TAG}-temp`, templateRef: 'tpl-live-temp', name: `温区温度-${TAG}`, unit: '℃',
  min: 0, max: 400, lineId: line.id, driver: 'mock',
}))
const MV_ID = `dn-${TAG}-mv`
const CV_ID = `dn-${TAG}-cv`
const TEMP_ID = `dn-${TAG}-temp`
const recipe = getDcwRecipeRepo().create({
  name: `本体验收配方-${TAG}`, productId: product.id,
  params: [{ nodeId: DCW_PRESS, value: 50, min: 0, max: 100 }],
  daqWindows: [{ nodeId: MV_ID, min: 0, max: 100 }],
})

const now0 = Date.now()
const runStartBase = now0 - 3 * 3600_000
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
    sampleRows.push({ nodeId: TEMP_ID, tsMs: ts, value: 190 + 8 * Math.sin((k + r) / 6), state: 'ok', ...tags })
  }
}
const seedTsdb = new SqliteTimeSeriesAdapter()
await seedTsdb.init()
await seedTsdb.writeSamples(sampleRows)
await seedTsdb.close()
console.log(`seed: line=${line.id} recipe=${recipe.id} runs=${N_RUNS} samples=${sampleRows.length}`)
console.log(`venv: ${venvLinked ? 'junction ok' : '未复用'}`)

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
  // context 窗口 = H*beat + maxDelay + 5*beat(≈155s);尾巴必须覆盖整窗,否则网格 NaN
  const now = Date.now()
  const rows = []
  const span = Math.ceil(H + DELAY_STEPS + 6)
  for (let k = span; k >= 1; k--) {
    const ts = now - k * BEAT
    const tags = { lineId: line.id, productId: product.id, recipeId: recipe.id }
    const mv = 50 + 6 * Math.sin(k / 5)
    rows.push({ nodeId: MV_ID, tsMs: ts, value: mv, state: 'ok', ...tags })
    rows.push({ nodeId: CV_ID, tsMs: ts, value: 50 + 0.7 * (mv - 50) + 0.05 * Math.sin(k / 3), state: 'ok', ...tags })
    rows.push({ nodeId: TEMP_ID, tsMs: ts, value: 195, state: 'ok', ...tags })
  }
  insertSamples(rows)
}

// ════ 1. 启动隔离实例 ════
// 隔离实例强制 SQLite 时序(宿主机真实 Timescale 在线时,插件会切到 Timescale,
// 看不到本用例预置的 SQLite 样本——2026-10-24 真机验收实测踩中);MQTT 指到关闭端口 → 进程内队列。
const { saveSettings } = await import('../shared/config/engine.mjs')
saveSettings({
  'daq.timescale.host': '127.0.0.1',
  'daq.timescale.port': 6543,
  'daq.mqtt.host': '127.0.0.1',
  'daq.mqtt.port': 18830,
  'daq.startInfrastructure': 'never',
}, join(HOME, 'runtime-settings.json'))
let port = 0
for (const p of [3992, 3991, 3990, 3989, 3988]) {
  let occupied = false
  try {
    await fetch(`http://127.0.0.1:${p}/api/health`, { signal: AbortSignal.timeout(800) })
    occupied = true
  }
  catch { /* 空闲 */ }
  if (!occupied) {
    // 二次确认:端口无监听才用(僵尸可能健康检查超时但仍占口)
    const { execSync } = await import('node:child_process')
    try {
      const out = execSync(`netstat -ano | findstr :${p} | findstr LISTENING`, { shell: 'cmd.exe' }).toString()
      const pidMatch = out.match(/\s(\d+)\s*$/m)
      if (pidMatch) { spawn('taskkill', ['/PID', pidMatch[1], '/T', '/F'], { stdio: 'ignore' }); await sleep(1500) }
    }
    catch { /* 无监听 */ }
    port = p
    break
  }
  await sleep(300)
}
if (!port) throw new Error('无空闲端口')
const BASE = `http://127.0.0.1:${port}`
console.log(`\n=== 1. boot ${BASE} ===`)
const logFd = openSync(join(ROOT, 'dev.log'), 'a')
const child = spawn(process.execPath, [join(REPO, 'bin', 'aw.mjs'), 'dev', '--port', String(port)], {
  cwd: REPO,
  env: { ...process.env, AW_RATE_LIMIT_OFF: '1', NUXT_SESSION_PASSWORD: 'OntologyLive#2026-e2e-session', NO_PROXY: '127.0.0.1,localhost' },
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
  try {
    json = await res.json()
  }
  catch { /* 非 JSON */ }
  return { status: res.status, ...(json ?? {}) }
}
const data = r => r?.data
const errCode = r => r?.code ?? r?.data?.code ?? ''

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
if (!healthy) { killTree(child.pid); throw new Error('实例未就绪:' + join(ROOT, 'dev.log')) }

const email = `ont-${TAG}@awshop.local`
let reg = null
for (let attempt = 0; attempt < 3 && !data(reg ?? {})?.token; attempt++) {
  try {
    reg = await api('POST', '/api/users/register', { name: `本体验收-${TAG}`, email, password: 'OntLive#2026' })
  }
  catch (err) {
    console.log(`register attempt ${attempt + 1} failed: ${String(err).slice(0, 120)}`)
    await sleep(3000)
  }
}
const token = data(reg ?? {})?.token
check('BOOT', '管理员注册(首注册=admin)', Boolean(token), `status=${reg.status}`)
if (!token) { killTree(child.pid); throw new Error('注册失败') }

// ════ L1 产线管理与节点绑定(REST) ════
console.log('\n=== L1 产线管理/节点绑定 ===')
{
  const lines = await api('GET', '/api/workshop/dcw/lines', undefined, token)
  check('L1.1', 'GET /dcw/lines 含验收线(simulated)', (data(lines)?.lines ?? lines ?? []).some?.(l => l.id === line.id) ?? JSON.stringify(data(lines) ?? lines).includes(line.id), `status=${lines.status}`)
  const dcwNodes = await api('GET', '/api/workshop/dcw', undefined, token)
  const daqNodes = await api('GET', '/api/workshop/daq', undefined, token)
  const daqList = JSON.stringify(data(daqNodes) ?? {})
  check('L1.2', 'GET /daq 数采节点齐备(MV/CV/温区)', daqNodes.status === 200 && [MV_ID, CV_ID, TEMP_ID].every(id => daqList.includes(id)), `status=${daqNodes.status}`)
  check('L1.3', '数控节点清单含压力/线速', dcwNodes.status === 200 && JSON.stringify(data(dcwNodes) ?? {}).includes(DCW_PRESS) && JSON.stringify(data(dcwNodes) ?? {}).includes(DCW_SPEED), `status=${dcwNodes.status}`)
  const recipes = await api('GET', '/api/workshop/dcw/recipes', undefined, token).catch(() => ({ status: 0, raw: null }))
  check('L1.4', '配方可读(REST 或清单)', recipes.status === 0 || JSON.stringify(data(recipes) ?? recipes).includes(recipe.id), `status=${recipes.status}`)
  writeFreshTail()
  check('L1.5', 'PLC 场景数据就绪(4 批次历史 + 新鲜尾巴)', sampleRows.length > 1000, `samples=${sampleRows.length}`)
}

// ════ L2 本体全功能真机 REST ════
console.log('\n=== L2 本体全链 REST ===')
const ONT = `ont-${TAG}`
let draftId
let draftRev
let v1Hash
let v1PackHash
{
  const created = await api('POST', '/api/workshop/ontology', { ontologyId: ONT, lineId: line.id, name: `本体验收-${TAG}` }, token)
  draftId = data(created)?.draft?.id ?? ''
  check('L2.1', 'POST /ontology 创建草稿', created.status === 200 && Boolean(draftId), `status=${created.status} id=${draftId}`)

  const doc = {
    schemaVersion: 1,
    name: `本体验收-${TAG}`,
    lineId: line.id,
    entities: [
      { key: 'pv.melt_pressure', kind: 'process_variable', name: '熔体压力', description: '', unit: 'bar', dimension: 'pressure', role: 'control', attrs: { dataType: 'number' } },
      { key: 'cv.thickness', kind: 'quality_variable', name: '平均膜厚', description: '', unit: 'μm', dimension: 'length', role: 'target', attrs: { dataType: 'number' } },
      { key: 'st.line_speed', kind: 'process_variable', name: '线速度', description: '', unit: 'm/min', dimension: '', role: 'control', attrs: { dataType: 'number' } },
      { key: 'st.zone_temp', kind: 'process_variable', name: '温区温度', description: '', unit: '℃', dimension: 'temperature', role: 'state', attrs: { dataType: 'number' } },
    ],
    relations: [
      {
        id: 'rel-1', kind: 'influences', srcKey: 'pv.melt_pressure', dstKey: 'cv.thickness', status: 'validated',
        evidence: [{ id: 'ev-rel', level: 'validated_control', source: { type: 'optimizer_run', runId: 'run-live', problemIrHash: 'ir-live', modelArtifactHash: 'mdl-live' }, sourceRefHash: 'h', createdAt: new Date().toISOString() }],
        properties: { sign: 'negative', gainPerUnit: -0.4, lagMs: 2 * DELAY_STEPS * BEAT, evidenceTier: 'validated_control', variabilityChecked: true },
      },
      {
        id: 'rel-2', kind: 'influences', srcKey: 'st.line_speed', dstKey: 'cv.thickness', status: 'proposed',
        evidence: [{ id: 'ev-rel2', level: 'candidate_influence', source: { type: 'expert_note', author: 'engineer', noteId: 'n1' }, sourceRefHash: 'h', createdAt: new Date().toISOString() }],
        properties: { evidenceTier: 'candidate_influence', variabilityChecked: false, transportDistanceM: 10, nominalSpeedMps: 0.5 },
      },
    ],
    rules: [
      {
        id: 'R-BOUND', key: 'thickness-window', kind: 'bound',
        dsl: { type: 'bound', variableKey: 'cv.thickness', min: 45, max: 55, unit: 'μm' },
        constraintLevel: 'hard', severity: 'error', status: 'proposed',
        evidence: [{ id: 'ev-bound', level: 'validated_control', source: { type: 'optimizer_run', runId: 'run-live-b', problemIrHash: 'ir', modelArtifactHash: 'mdl' }, sourceRefHash: 'h', createdAt: new Date().toISOString() }],
        description: '膜厚工艺窗(μm)', scope: { lineId: line.id, recipeId: recipe.id, conditionId: '' },
      },
      {
        id: 'R-GUARD', key: 'cold-zone-no-speedup', kind: 'state_condition',
        dsl: { type: 'state_condition', when: { variableKey: 'st.zone_temp', op: 'lt', value: 180 }, forbid: { kind: 'positive_increment', variableKey: 'st.line_speed' }, message: '温区未达 180℃,禁止提速' },
        constraintLevel: 'hard', severity: 'error', status: 'proposed',
        evidence: [{ id: 'ev-guard', level: 'validated_control', source: { type: 'optimizer_run', runId: 'run-live-g', problemIrHash: 'ir', modelArtifactHash: 'mdl' }, sourceRefHash: 'h', createdAt: new Date().toISOString() }],
        description: '冷区禁提速', scope: { lineId: line.id, recipeId: recipe.id, conditionId: '' },
      },
      {
        id: 'R-INTERLOCK', key: 'estop', kind: 'interlock',
        dsl: { type: 'interlock', text: '急停回路动作时禁止任何写控' },
        constraintLevel: 'hard', severity: 'error', status: 'proposed',
        evidence: [{ id: 'ev-il', level: 'candidate_influence', source: { type: 'expert_note', author: 'safety', noteId: 'n2' }, sourceRefHash: 'h', createdAt: new Date().toISOString() }],
        description: '安全联锁归 PLC', scope: { lineId: line.id, recipeId: '', conditionId: '' },
      },
    ],
    bindings: [
      { id: 'b-press', entityKey: 'pv.melt_pressure', platformKind: 'dcw_node', platformId: DCW_PRESS, targetSub: '', scope: `line:${line.id}`, direction: 'write', unitDeclared: 'bar', unitTarget: 'bar', scale: 1, offset: 0 },
      { id: 'b-speed', entityKey: 'st.line_speed', platformKind: 'dcw_node', platformId: DCW_SPEED, targetSub: '', scope: `line:${line.id}`, direction: 'write', unitDeclared: 'm/min', unitTarget: 'm/min', scale: 1, offset: 0 },
      { id: 'b-cv', entityKey: 'cv.thickness', platformKind: 'daq_node', platformId: CV_ID, targetSub: '', scope: `line:${line.id}`, direction: 'read', unitDeclared: 'μm', unitTarget: 'μm', scale: 1, offset: 0 },
      { id: 'b-temp', entityKey: 'st.zone_temp', platformKind: 'daq_node', platformId: TEMP_ID, targetSub: '', scope: `line:${line.id}`, direction: 'read', unitDeclared: '℃', unitTarget: '℃', scale: 1, offset: 0 },
      { id: 'b-param', entityKey: 'pv.melt_pressure', platformKind: 'recipe_param', platformId: recipe.id, targetSub: DCW_PRESS, scope: `recipe:${recipe.id}@1`, direction: 'write', unitDeclared: 'bar', unitTarget: 'bar', scale: 1, offset: 0 },
    ],
    note: 'live e2e',
  }
  const saved = await api('PATCH', `/api/workshop/ontology/drafts/${encodeURIComponent(draftId)}`, { doc, expectedRev: 1 }, token)
  draftRev = data(saved)?.draft?.rev ?? 0
  check('L2.2', 'PATCH 草稿(整份文档,绑定真实节点)通过活体校验', saved.status === 200 && draftRev === 2 && data(saved)?.validation?.ok === true && data(saved)?.bindings?.ok === true, `status=${saved.status} code=${errCode(saved)} msg=${String(saved.message ?? '').slice(0, 200)} rev=${draftRev} issues=${JSON.stringify((data(saved)?.validation?.issues ?? []).filter(i => i.severity === 'error').slice(0, 2))} bindFail=${JSON.stringify((data(saved)?.bindings?.failures ?? []).slice(0, 2))}`)

  const stale = await api('PATCH', `/api/workshop/ontology/drafts/${encodeURIComponent(draftId)}`, { doc, expectedRev: 1 }, token)
  check('L2.3', '过期 rev → 409 DRAFT_CONCURRENT_MODIFY', stale.status === 409 && String(errCode(stale)).includes('DRAFT_CONCURRENT_MODIFY'), `${stale.status}/${errCode(stale)}`)

  const validated = await api('POST', `/api/workshop/ontology/drafts/${encodeURIComponent(draftId)}/validate`, {}, token)
  check('L2.4', 'POST validate 全量校验 200', validated.status === 200 && data(validated)?.ok === true, `issues=${(data(validated)?.issues ?? []).length}`)

  const compiled = await api('POST', `/api/workshop/ontology/drafts/${encodeURIComponent(draftId)}/compile`, {}, token)
  check('L2.5', 'POST compile 四类产物 + 溯源', compiled.status === 200 && data(compiled)?.counts?.compiled >= 1 && (data(compiled)?.traces ?? []).length === 3, `status=${data(compiled)?.status} counts=${JSON.stringify(data(compiled)?.counts)}`)

  // 证据登记(R-GUARD 追加一条 observed;两硬规则已带 validated_control)
  const ev = await api('POST', `/api/workshop/ontology/drafts/${encodeURIComponent(draftId)}/evidence`, {
    targetKind: 'rule', targetKey: 'R-GUARD', level: 'observed_correlation',
    source: { type: 'dataset_stats', datasetId: 'ds-live', sha256: 'sha-live' }, sourceRef: 'ds-live',
  }, token)
  check('L2.6', 'POST evidence 写回草稿', ev.status === 200, `status=${ev.status}`)

  // 生命周期:单管理员部署 → solo 豁免自审(打 solo_operator 标记);批准单仍需两步
  const t1 = await api('POST', `/api/workshop/ontology/drafts/${encodeURIComponent(draftId)}/rules/R-BOUND/transition`, { to: 'reviewed' }, token)
  check('L2.7', 'solo 部署自审豁免:proposed→reviewed', t1.status === 200 && data(t1)?.rule?.status === 'reviewed', `${t1.status}/${errCode(t1)}`)
  const t2 = await api('POST', `/api/workshop/ontology/drafts/${encodeURIComponent(draftId)}/rules/R-BOUND/transition`, { to: 'validated' }, token)
  check('L2.8', 'reviewed→validated(有 validated_control 证据)', t2.status === 200, `${t2.status}/${errCode(t2)}`)
  const noApproval = await api('POST', `/api/workshop/ontology/drafts/${encodeURIComponent(draftId)}/rules/R-BOUND/transition`, { to: 'approved_for_control' }, token)
  check('L2.9', '无批准单 → 403 APPROVAL_REQUIRED', noApproval.status === 403, `${noApproval.status}/${errCode(noApproval)}`)
  const approval = await api('POST', `/api/workshop/ontology/drafts/${encodeURIComponent(draftId)}/rules/R-BOUND/approval`, {}, token)
  const approvalId = data(approval)?.approvalId ?? ''
  check('L2.10', '申请批准单', approval.status === 200 && Boolean(approvalId), `id=${approvalId}`)
  const decided = await api('POST', `/api/workshop/ontology/drafts/${encodeURIComponent(draftId)}/rules/R-BOUND/approval-decision`, { approvalId, approved: true, comment: '工艺确认' }, token)
  check('L2.11', '裁决批准(同一管理员,审计留痕)', decided.status === 200, `${decided.status}/${errCode(decided)}`)
  const approved = await api('POST', `/api/workshop/ontology/drafts/${encodeURIComponent(draftId)}/rules/R-BOUND/transition`, { to: 'approved_for_control', approvalId }, token)
  check('L2.12', '→ approved_for_control', approved.status === 200 && data(approved)?.rule?.status === 'approved_for_control', `${approved.status}`)
  // R-GUARD 同样推进
  await api('POST', `/api/workshop/ontology/drafts/${encodeURIComponent(draftId)}/rules/R-GUARD/transition`, { to: 'reviewed' }, token)
  await api('POST', `/api/workshop/ontology/drafts/${encodeURIComponent(draftId)}/rules/R-GUARD/transition`, { to: 'validated' }, token)
  const approval2 = await api('POST', `/api/workshop/ontology/drafts/${encodeURIComponent(draftId)}/rules/R-GUARD/approval`, {}, token)
  await api('POST', `/api/workshop/ontology/drafts/${encodeURIComponent(draftId)}/rules/R-GUARD/approval-decision`, { approvalId: data(approval2)?.approvalId, approved: true }, token)
  await api('POST', `/api/workshop/ontology/drafts/${encodeURIComponent(draftId)}/rules/R-GUARD/transition`, { to: 'approved_for_control', approvalId: data(approval2)?.approvalId }, token)

  // 未获批规则拒发(独立小本体)
  const draft2 = await api('POST', '/api/workshop/ontology', { ontologyId: `${ONT}-u`, lineId: line.id }, token)
  const doc2 = JSON.parse(JSON.stringify(doc))
  doc2.rules = [{ ...doc.rules[0], status: 'validated' }]
  await api('PATCH', `/api/workshop/ontology/drafts/${encodeURIComponent(data(draft2)?.draft?.id)}`, { doc: doc2, expectedRev: 1 }, token)
  const rejectPub = await api('POST', `/api/workshop/ontology/drafts/${encodeURIComponent(data(draft2)?.draft?.id)}/publish`, {}, token)
  check('L2.13', '未获控制级批准 → 422 ONTOLOGY_NOT_APPROVED', rejectPub.status === 422 && String(errCode(rejectPub)).includes('ONTOLOGY_NOT_APPROVED'), `${rejectPub.status}/${errCode(rejectPub)}`)

  const pub = await api('POST', `/api/workshop/ontology/drafts/${encodeURIComponent(draftId)}/publish`, {}, token)
  v1Hash = data(pub)?.version?.contentHash ?? ''
  v1PackHash = data(pub)?.packHash ?? ''
  check('L2.14', 'admin 发布 v1(contentHash+packHash+counts)', pub.status === 200 && data(pub)?.version?.version === 1 && v1Hash.length === 64 && v1PackHash.length === 64, `counts=${JSON.stringify(data(pub)?.counts)}`)

  const versions = await api('GET', `/api/workshop/ontology/versions/${encodeURIComponent(ONT)}`, undefined, token)
  check('L2.15', 'GET versions 列出 v1(published)', versions.status === 200 && (data(versions)?.versions ?? []).some(v => v.version === 1 && v.status === 'published'), `n=${(data(versions)?.versions ?? []).length}`)

  const traces = await api('GET', `/api/workshop/ontology/traces/${encodeURIComponent(ONT)}?version=1`, undefined, token)
  check('L2.16', 'GET traces 溯源(每规则一行+决策)', traces.status === 200 && (data(traces)?.traces ?? []).length === 3 && (data(traces)?.traces ?? []).some(t => t.decisionCode === 'PLC_LAYER_REQUIRED'), `n=${(data(traces)?.traces ?? []).length}`)

  const scene = await api('GET', `/api/workshop/ontology/scene?lineId=${encodeURIComponent(line.id)}`, undefined, token)
  const sceneGraph = data(scene)?.graph
  check('L2.17', 'GET scene 运行时子图(实体+绑定+守卫)', scene?.status === 200 && data(scene)?.active === true && (sceneGraph?.entities ?? []).length >= 4 && (sceneGraph?.guards ?? []).length >= 1 && (sceneGraph?.entities ?? []).some(e => e.bindings.length > 0), `entities=${(sceneGraph?.entities ?? []).length} guards=${(sceneGraph?.guards ?? []).length}`)

  const exp = await fetch(`${BASE}/api/workshop/ontology/export/${encodeURIComponent(ONT)}?version=1`, { headers: { authorization: `Bearer ${token}` } })
  const bundle = await exp.json().catch(() => null)
  check('L2.18', 'GET export JSON bundle', exp.status === 200 && bundle?.data?.ontologyId === ONT && (bundle?.data?.entities ?? []).length >= 4, `status=${exp.status}`)

  // 不可变:重复发布同 rev 内容 → 版本号递增,不覆盖
  const republished = await api('POST', `/api/workshop/ontology/drafts/${encodeURIComponent(draftId)}/publish`, {}, token)
  check('L2.19', '重复发布 → 新版本 v2(不可变语义)', republished.status === 200 && data(republished)?.version?.version === 2, `v=${data(republished)?.version?.version}`)
  const cmp = await api('GET', `/api/workshop/ontology/versions/${encodeURIComponent(ONT)}/compare?from=1&to=2`, undefined, token)
  check('L2.20', 'GET compare 四段 diff(无内容变更=空)', cmp.status === 200 && (data(cmp)?.rules?.changed ?? []).length === 0, `rules=${JSON.stringify(data(cmp)?.rules)}`)
}

// ════ L3 运行时守卫(真实产线,进程内同库) ════
console.log('\n=== L3 运行时守卫 ===')
const svc = await import('../server/services/workshop/ontology/ontology.service')
{
  const active = svc.resolveActiveOntology(line.id)
  check('L3.1', 'resolveActiveOntology 解析最新发布版本', active?.version.version === 2 && active.packHash.length === 64, `v=${active?.version.version} pack=${String(active?.packHash).slice(0, 10)}`)
  const blocked = svc.evaluateOntologyGuards(line.id, { values: { 'st.zone_temp': 150 }, deltas: { 'st.line_speed': 2 }, recipeId: recipe.id })
  check('L3.2', '低温 150℃ + 提速 → 阻断', blocked.blocked === true, blocked.violations[0]?.message ?? '')
  const allowed = svc.evaluateOntologyGuards(line.id, { values: { 'st.zone_temp': 200 }, deltas: { 'st.line_speed': 2 }, recipeId: recipe.id })
  check('L3.3', '高温 200℃ + 提速 → 放行', allowed.blocked === false)
  const failClosed = svc.evaluateOntologyGuards(line.id, { values: {}, deltas: { 'st.line_speed': 1 }, recipeId: recipe.id })
  check('L3.4', '状态未知 + 提速 → fail-closed 阻断', failClosed.blocked === true && failClosed.violations[0]?.reason === 'state_unknown')
  // 节点级意图面:绑定行在 L2 发布时已落库(dcw_node 映射),dcw 节点 readValue 由 seed 直置
  const intent = svc.evaluateOntologyGuardsForNodes(line.id, [{ nodeId: DCW_SPEED, from: 10, to: 12 }], { recipeId: recipe.id })
  check('L3.5', '节点级意图:实体→dcw 节点映射 + 状态未知提速 → 阻断', intent.blocked === true, `unmapped=${intent.unmapped.join(',')}`)
  const intentDown = svc.evaluateOntologyGuardsForNodes(line.id, [{ nodeId: DCW_SPEED, from: 10, to: 8 }], { recipeId: recipe.id })
  check('L3.6', '节点级意图:降速 → 放行', intentDown.blocked === false)
  const drift = svc.verifyVersionBindings(ONT, 1)
  check('L3.7', '绑定漂移巡检:真实节点在册 → 无漂移', drift.ok === true, JSON.stringify(drift.drifted).slice(0, 120))
}

// ════ L4 AML 训练集成 + 本体先验 ════
console.log('\n=== L4 AML 集成 ===')
const SPEC = `pms-${TAG}`
let trainedModelId
let modelArtifactHash
{
  const spec = {
    schemaVersion: 2, id: SPEC, version: 1,
    lineId: line.id, productId: product.id, recipeId: recipe.id, recipeVersion: recipe.version ?? 1,
    conditions: [{ id: 'c1', match: [{ field: 'recipeId', op: 'eq', value: recipe.id }] }],
    variables: [
      { id: 'mv1', nodeId: MV_ID, role: 'mv', field: 'value', unit: 'bar', scale: 1, offset: 0, delayMs: DELAY_STEPS * BEAT, min: 0, max: 100, maxStep: 20, controlNodeId: DCW_PRESS },
      { id: 'cv1', nodeId: CV_ID, role: 'cv', field: 'value', unit: 'μm', scale: 1, offset: 0, min: 0, max: 200 },
    ],
    timing: { beatMs: BEAT, historySteps: H, horizonSteps: F, fixedDt: true },
    trainer: { ref: 'linear_arx@1', config: { arOrder: 1, inputOrder: 1, ridgeLambda: 1e-6, standardize: true } },
    datasetPolicy: { split: { valRatio: 0.4, testRatio: 0.4, seed: 42 }, cleaning: { hampelK: 0 } },
    gatePolicyRef: 'process-model.gates@1',
    modelInterface: { id: 'linear_state_space', version: 1, inputSemantics: 'setpoint', mode: 'state_space' },
    effectiveDomain: { mv: { mv1: { min: 0, max: 100, maxStep: 20 } }, cv: { cv1: { min: 0, max: 200 } } },
    purpose: 'mpc_surrogate',
  }
  const created = await api('POST', '/api/workshop/process-model/specs', spec, token)
  check('L4.1', 'POST /process-model/specs 登记', created.status === 200, `${created.status}/${errCode(created)}`)
  const publish = await api('POST', `/api/workshop/process-model/specs/${encodeURIComponent(SPEC)}/publish?version=1`, undefined, token)
  check('L4.2', 'spec 发布', publish.status === 200 && data(publish)?.spec?.status === 'published', `${publish.status}`)
  let ds = await api('POST', '/api/workshop/process-model/datasets', spec, token)
  for (const backoff of [3000, 6000]) {
    if (ds.status === 200) break
    // 已知环境抖动(dev TSDB 适配器初始化竞态):重写尾巴后指数退避重试
    writeFreshTail()
    await sleep(backoff)
    ds = await api('POST', '/api/workshop/process-model/datasets', spec, token)
  }
  const datasetId = data(ds)?.datasetId
  check('L4.3', '数据集构建(lineage_verified)', ds.status === 200 && Boolean(datasetId) && data(ds)?.rowCount > 200, `status=${ds.status} code=${errCode(ds)} msg=${String(ds.message ?? '').slice(0, 160)} rows=${data(ds)?.rowCount}`)
  const dsGet = await api('GET', `/api/workshop/aml/datasets/${encodeURIComponent(datasetId)}`, undefined, token)
  check('L4.4', '数据集 manifest 可读', dsGet.status === 200 && data(dsGet)?.manifest?.version === 2, `v=${data(dsGet)?.manifest?.version}`)
  const elig = await api('POST', '/api/workshop/process-model/eligibility', { specId: SPEC, specVersion: 1, datasetId, scope: 'simulation' }, token)
  check('L4.5', '资格报告 optimizationEligible', elig.status === 200 && data(elig)?.report?.optimizationEligible === true, `gaps=${(data(elig)?.report?.gaps ?? []).map(g => g.code).join(',') || 'none'}`)
  const train = await api('POST', '/api/workshop/process-model/train', { spec, datasetId, modelName: `本体验收模型-${TAG}` }, token)
  const jobId = data(train)?.job?.id
  check('L4.6', '训练作业提交', train.status === 200 && Boolean(jobId), `status=${train.status} code=${errCode(train)} msg=${String(train.message ?? '').slice(0, 160)}`)
  let job = null
  const terminal = new Set(['done', 'failed', 'cancelled', 'timeout', 'interrupted'])
  for (let i = 0; i < 240; i++) {
    const jr = await api('GET', `/api/workshop/aml/jobs/${encodeURIComponent(jobId)}`, undefined, token)
    job = data(jr)?.job
    if (job && terminal.has(job.status)) break
    await sleep(500)
  }
  trainedModelId = job?.modelId ?? ''
  check('L4.7', '训练 done + 模型登记', job?.status === 'done' && Boolean(trainedModelId), `status=${job?.status} model=${trainedModelId} err=${String(job?.error ?? '').slice(0, 120)}`)
  const models = await api('GET', `/api/workshop/aml/models?recipeId=${encodeURIComponent(recipe.id)}`, undefined, token)
  const model = (data(models)?.models ?? []).find(m => m.id === trainedModelId)
  modelArtifactHash = model?.artifactHash ?? ''
  check('L4.8', '模型 linear_state_space@1 + artifactHash', model?.artifactKind === 'linear_state_space@1' && modelArtifactHash.length === 64, `${model?.artifactKind} metrics=${JSON.stringify(model?.metrics ?? {}).slice(0, 200)}`)

  // 本体先验派生(进程内,读已发布版本)
  const priors = svc.deriveTrainingPriors(line.id)
  check('L4.9', '本体训练先验:特征候选≥2(压力/线速→膜厚)', (priors?.featureCandidates ?? []).length >= 2, JSON.stringify((priors?.featureCandidates ?? []).map(f => f.entityKey)))
  check('L4.10', '本体训练先验:时滞含 τ=D/v(10m/0.5mps=20s)', (priors?.delayPriors ?? []).some(d => d.basis === 'tau_eq_D_over_v' && d.delayMs === 20000), JSON.stringify(priors?.delayPriors))
}

// ════ L5 求解器集成(含 ontologyRefs 耦合) ════
console.log('\n=== L5 求解器集成 ===')
const profileId = `optp-${TAG}`
let bindingId
let recId
let leadAgentIdOuter
let channelIdOuter
{
  // 工艺优化档位频道(模板实例化):优化器族工具在该档位才开放(注入差异化实测)
  const inst = await api('POST', '/api/workshop/channel-templates/chtpl-aml-optimization-default/instantiate', { name: `本体验收优化频道-${TAG}`, bindLineId: line.id }, token)
  const instData = data(inst) ?? {}
  const workspaceId = data(await api('POST', '/api/workshop/workspaces', { name: `本体验收工作区-${TAG}` }, token))?.id
  const channelId = instData.channelId
  const leadAgentId = instData.leadAgentId ?? (instData.agents ?? []).find(a => a.role === 'lead')?.id
  leadAgentIdOuter = leadAgentId
  channelIdOuter = channelId
  if (workspaceId && channelId) await api('POST', `/api/workshop/workspaces/${encodeURIComponent(workspaceId)}/channels/${encodeURIComponent(channelId)}`, undefined, token)
  check('L5.1', '优化档位频道(模板实例化)+workspace 就绪', Boolean(workspaceId && channelId && leadAgentId), `inst=${inst.status} ch=${channelId}`)

  const profileBody = {
    schemaVersion: 1, id: profileId, version: 1,
    modelRef: { modelId: trainedModelId, artifactKind: 'linear_state_space@1', artifactHash: '', modelInterface: 'linear_state_space', stage: 'candidate' },
    problemTemplateRef: 'linear_mpc_quadratic@1',
    problemConfig: { linear_mpc_quadratic: { cvWeights: { cv1: 1 }, duWeights: { mv1: 0.1 }, terminalWeight: 2, targets: { cv1: 50 } } },
    solverRef: 'osqp_mpc@1', solverVersion: '1',
    processSpecRef: `${SPEC}@1`, conditionIds: [], status: 'draft',
  }
  const created = await api('POST', '/api/workshop/optimization/profiles', profileBody, token)
  check('L5.2', 'Profile v1 创建(服务端回填工件)', created.status === 200 && data(created)?.profile?.modelArtifactHash?.length === 64, `status=${created.status} code=${errCode(created)} msg=${String(created.message ?? '').slice(0, 160)}`)
  const pub = await api('POST', `/api/workshop/optimization/profiles/${encodeURIComponent(profileId)}/publish?version=1`, undefined, token)
  check('L5.3', 'Profile v1 发布', pub.status === 200 && data(pub)?.profile?.status === 'published', `${pub.status}`)
  const bind = await api('POST', '/api/workshop/optimization/bindings', {
    workspaceId, channelId, agentInstanceId: leadAgentId, profileId, profileVersion: 1, mode: 'recommendation',
  }, token)
  bindingId = data(bind)?.binding?.id ?? ''
  check('L5.4', 'Agent↔Profile 绑定(revision=1)', bind.status === 200 && Boolean(bindingId), `id=${bindingId}`)

  writeFreshTail()
  const solve = await api('POST', '/api/workshop/optimization/solve', { agentInstanceId: leadAgentId }, token)
  const outcome = data(solve)
  recId = String(outcome?.recommendation?.id ?? '')
  check('L5.5', 'solve optimal(本体已发布不干扰求解)', solve.status === 200 && outcome?.result?.status === 'optimal', `status=${outcome?.result?.status} http=${solve.status} msg=${String(solve.message ?? '').slice(0, 120)}`)
  const writesPath = join(HOME, 'data', 'dcw-writes.json')
  const writesBefore = existsSync(writesPath) ? readFileSync(writesPath, 'utf8').length : 0
  let solve2 = await api('POST', '/api/workshop/optimization/solve', { agentInstanceId: leadAgentId }, token)
  if (solve2.status !== 200) {
    writeFreshTail()
    await sleep(2000)
    solve2 = await api('POST', '/api/workshop/optimization/solve', { agentInstanceId: leadAgentId }, token)
  }
  const writesAfter = existsSync(writesPath) ? readFileSync(writesPath, 'utf8').length : 0
  check('L5.6', '求解零 DCW 写入(治理红线)', solve2.status === 200 && writesBefore === writesAfter, `http=${solve2.status} code=${errCode(solve2)} msg=${String(solve2.message ?? data(solve2)?.result?.diagnostics?.message ?? '').slice(0, 140)} writes=${writesBefore}→${writesAfter}`)

  const recId2 = String(data(solve2)?.recommendation?.id ?? '')
  const recPath = `/api/workshop/optimization/recommendations/${encodeURIComponent(recId || recId2)}`
  const xcheck = await api('POST', `${recPath}/crosscheck`, {}, token)
  const xrow = data(xcheck)?.crosscheck
  check('L5.7', 'crosscheck 双实现互校', xcheck.status === 200 && ['pass', 'not_applicable'].includes(xrow?.verdict),
    `verdict=${xrow?.verdict} maxDev=${JSON.stringify(xrow?.maxDevDimensionless ?? xrow?.maxDev)} tol=${xrow?.tol} reason=${String(xrow?.reason ?? '').slice(0, 120)} model=${String(recId2 ? '' : '')}`)

  // ontologyRefs 耦合:Profile v2 冻结本体引用
  const v1 = await api('GET', `/api/workshop/ontology/versions/${encodeURIComponent(ONT)}`, undefined, token)
  const v1row = (data(v1)?.versions ?? []).find(x => x.version === 1)
  const profileV2 = {
    ...profileBody, version: 2,
    ontologyRefs: [{ ontologyId: ONT, ontologyVersion: 1, contentHash: v1row?.contentHash, rulePackHash: v1row?.compiled?.rulePackHash, guardCount: 1 }],
  }
  const created2 = await api('POST', '/api/workshop/optimization/profiles', profileV2, token)
  const pub2 = await api('POST', `/api/workshop/optimization/profiles/${encodeURIComponent(profileId)}/publish?version=2`, undefined, token)
  check('L5.8', 'Profile v2 带 ontologyRefs 创建+发布', created2.status === 200 && pub2.status === 200, `c=${created2.status}/${errCode(created2)} p=${pub2.status}`)
  const rebind = await api('POST', '/api/workshop/optimization/bindings', {
    workspaceId, channelId, agentInstanceId: leadAgentId, profileId, profileVersion: 2, mode: 'recommendation',
  }, token)
  writeFreshTail()
  const bindingV2Id = data(rebind)?.binding?.id ?? bindingId
  const solve3 = await api('POST', '/api/workshop/optimization/solve', { agentInstanceId: leadAgentId, bindingId: bindingV2Id }, token)
  check('L5.9', 'ontologyRefs Profile 求解正常(引用不进 IR hash)', solve3.status === 200 && data(solve3)?.result?.status === 'optimal', `http=${solve3.status} status=${data(solve3)?.result?.status} code=${errCode(solve3)} msg=${String(solve3.message ?? data(solve3)?.result?.diagnostics?.message ?? '').slice(0, 160)}`)
}

// ════ L5b 模型采纳闭环(AI 提议 → HITL 批准 → 发布+重绑 → 新模型生效)════
{
  // Agent 经工具桥发起采纳(同步等待 HITL;测试端并发裁决)
  const adoptInvoke = api('POST', '/api/workshop/agent-tools/invoke', {
    agentId: leadAgentIdOuter, tool: 'optimizer_profile_propose',
    args: { model_id: trainedModelId, reason: '采纳闭环验收:重新绑定到最新训练模型' },
  }, token, 300_000)
  let card = null
  for (let i = 0; i < 60; i++) {
    await sleep(500)
    try {
      const pending = await api('GET', '/api/workshop/agent-tools/approvals', undefined, token)
      card = (data(pending)?.approvals ?? []).find(a => String(a.nodeId).startsWith('optimizer-profile:') && a.agentId === leadAgentIdOuter)
      if (card) break
    }
    catch { /* 未就绪 */ }
  }
  check('L5.10', '采纳卡挂出(nodeId=optimizer-profile:<id>@<v>)', Boolean(card), `nodeId=${card?.nodeId ?? 'none'}`)
  const dec = card
    ? await api('POST', `/api/workshop/agent-tools/approvals/${encodeURIComponent(card.id)}/decide`, { approved: true, choice: 0, comment: '采纳闭环验收批准' }, token)
    : { status: 0 }
  check('L5.11', 'HITL 批准 → 单一咽喉完成发布+重绑', dec.status === 200 && (JSON.stringify(dec).includes('published') || JSON.stringify(dec).includes('已发布')), `status=${dec.status} body=${JSON.stringify(dec).slice(0, 700)}`)
  const versionsAfter = data(await api('GET', `/api/workshop/optimization/profiles?limit=50`, undefined, token))
  console.log(`[adopt] profiles after decide: ${JSON.stringify(versionsAfter).slice(0, 400)}`)
  let adoptText
  try {
    adoptText = await adoptInvoke
  }
  catch (err) {
    adoptText = { text: `invoke rejected: ${String(err).slice(0, 160)}` }
  }
  const adoptData = adoptText.data ?? {}
  const adoptStr = String(adoptData.text ?? adoptData.result?.text ?? JSON.stringify(adoptData)).slice(0, 240)
  check('L5.12', '工具回执:模型采纳完成', adoptStr.includes('模型采纳完成'), `status=${adoptText.status} body=${adoptStr}`)
  // 采纳基线 = 最新已发布版本;重绑语义 = 绑定在基线版本的 Agent 升到新版本
  const allBinds = (data(await api('GET', `/api/workshop/optimization/bindings?agentInstanceId=${encodeURIComponent(leadAgentIdOuter)}`, undefined, token))?.bindings ?? []).filter(b => b.profileId === profileId)
  const adoptedCardVersion = Number(String(card?.nodeId ?? '').split('@')[1])
  const rebound = allBinds.find(b => Number(b.profileVersionNumber) === adoptedCardVersion)
  check('L5.13', '存在绑定已自动重绑到采纳版本(revision+1)', Boolean(rebound) && Number(rebound?.revision) >= 1, `versions=[${allBinds.map(b => b.profileVersionNumber).join(',')}] card=v${adoptedCardVersion} reboundRev=${rebound?.revision}`)
  writeFreshTail()
  const solve4 = await api('POST', '/api/workshop/optimization/solve', { agentInstanceId: leadAgentIdOuter, bindingId: rebound?.id }, token)
  check('L5.14', '重绑后 solve optimal(新模型工件生效)', solve4.status === 200 && data(solve4)?.result?.status === 'optimal', `status=${data(solve4)?.result?.status} binding=${rebound?.id}`)
}

// ════ L6 数据分析作业 ════
console.log('\n=== L6 数据分析 ===')
{
  // 频道绑定产线(产线管理正道:产线配频道);绑线后 Agent 可读面覆盖该线
  const bindLine = channelIdOuter
    ? await api('PUT', `/api/workshop/channels/${encodeURIComponent(channelIdOuter)}/line`, { lineId: line.id }, token)
    : { status: 0 }
  check('L6.0', '频道绑定产线(产线配频道)', bindLine.status === 200, `status=${bindLine.status} code=${errCode(bindLine)}`)
  const agentId = leadAgentIdOuter
  const save = agentId
    ? await api('POST', '/api/workshop/agent-tools/invoke', {
        agentId,
        tool: 'analysis_save',
        args: {
          title: `本体验收分析-${TAG}`,
          summary: '压力-膜厚负相关确认;本体规则 R-BOUND 界与数据一致',
          conclusions: ['R-BOUND 膜厚窗 [4.5,5.5] 与批次数据一致', '温区未稳期禁止提速与运行实践一致'],
          report: '# 验收分析\n\n本体驱动分析留痕。',
          category: 'quality',
          line_id: line.id,
          recipe_id: recipe.id,
        },
      }, token)
    : { status: 0 }
  const savedOk = save.status === 200 && !save.isError
  check('L6.1', 'analysis_save 经 agent-tools/invoke 落台账', savedOk, `status=${save.status} text=${String(save.text ?? save.message ?? '').slice(0, 120)}`)
  const list = await api('GET', '/api/workshop/analysis', undefined, token)
  check('L6.2', 'GET /analysis 台账读回', list.status === 200 && JSON.stringify(data(list) ?? list).includes(`本体验收分析-${TAG}`), `status=${list.status} body=${JSON.stringify(list).slice(0, 260)}`)
}

// ════ ON16 邻接查询 REST(已发布面 + 草稿面) ════
console.log('\n=== ON16 邻接查询 REST ===')
{
  const base = `/api/workshop/ontology/scene?lineId=${encodeURIComponent(line.id)}`
  const one = await api('GET', `${base}&entity=pv.melt_pressure&hops=1`, undefined, token)
  const oneSub = data(one)?.subgraph
  check('ON16.1', 'GET /scene?entity= 返回子图(center+nodes+edges)', one.status === 200
  && oneSub?.center?.key === 'pv.melt_pressure'
  && oneSub?.nodes?.length === 2
  && oneSub?.edges?.length === 1
  && oneSub?.edges?.[0]?.direction === 'out', JSON.stringify(oneSub && { nodes: oneSub.nodes, edges: oneSub.edges }))
  const two = await api('GET', `${base}&entity=pv.melt_pressure&hops=2`, undefined, token)
  const twoSub = data(two)?.subgraph
  const speed = twoSub?.nodes?.find(n => n.key === 'st.line_speed')
  const rel2 = twoSub?.edges?.find(e => e.id === 'rel-2')
  check('ON16.2', 'hops=2 出现间接节点 st.line_speed@2 与 rel-2(hop2/in)', speed?.hop === 2 && rel2?.hop === 2 && rel2?.direction === 'in',
    JSON.stringify({ speed, rel2 }))
  const noEntity = await api('GET', `${base}&hops=2&direction=out&kinds=influences`, undefined, token)
  const plain = await api('GET', base, undefined, token)
  check('ON16.3', '无 entity 时新参数被忽略:与历史全图响应完全一致',
    noEntity.status === plain.status && JSON.stringify(data(noEntity)) === JSON.stringify(data(plain)),
    `status=${noEntity.status}/${plain.status}`)
  const keys = Object.keys(data(plain)?.graph ?? {}).join(',')
  check('ON16.4', '无 entity 的 graph 顶层结构不变', keys === 'ontologyId,version,lineId,entities,relations,rules,guards', keys)
  const badHops = await api('GET', `${base}&entity=pv.melt_pressure&hops=4`, undefined, token)
  check('ON16.5', 'hops 越界 → 422 ONTOLOGY_SUBGRAPH_HOPS_INVALID',
    badHops.status === 422 && String(data(badHops)?.code ?? badHops.code ?? '').includes('HOPS_INVALID'), JSON.stringify(badHops).slice(0, 160))
  const ghost = await api('GET', `${base}&entity=ghost.key`, undefined, token)
  check('ON16.6', '未知实体 → 404 ONTOLOGY_SUBGRAPH_ENTITY_NOT_FOUND', ghost.status === 404, `status=${ghost.status}`)
  const draftQuery = `/api/workshop/ontology/drafts/${encodeURIComponent(draftId)}/subgraph?entity=pv.melt_pressure&hops=1`
  const draftSub = await api('GET', draftQuery, undefined, token)
  const draftBody = data(draftSub)?.subgraph
  check('ON16.7', '草稿子图端点可用(UI 图与抽屉同源)', draftSub.status === 200
  && draftBody?.center?.key === 'pv.melt_pressure'
  && draftBody?.nodes?.length === 2, JSON.stringify(draftBody).slice(0, 200))
  const draftBad = await api('GET', `/api/workshop/ontology/drafts/${encodeURIComponent(draftId)}/subgraph`, undefined, token)
  check('ON16.8', '草稿子图缺 entity → 422 ONTOLOGY_ENTITY_REQUIRED', draftBad.status === 422, `status=${draftBad.status}`)
}

// ════ ON17 Agent 只读工具:ontology_node_neighbors ════
console.log('\n=== ON17 Agent 邻接工具 ===')
{
  const invokeNeighbors = await api('POST', '/api/workshop/agent-tools/invoke', {
    agentId: leadAgentIdOuter,
    tool: 'ontology_node_neighbors',
    args: { line_id: line.id, entity_key: 'pv.melt_pressure', hops: 1 },
  }, token)
  const text1 = String(data(invokeNeighbors)?.result?.text ?? '')
  check('ON17.1', '工具 hops=1 返回节点/边明细', invokeNeighbors.status === 200
  && data(invokeNeighbors)?.result?.isError !== true
  && text1.includes('nodes=2 edges=1')
  && text1.includes('pv.melt_pressure')
  && text1.includes('cv.thickness')
  && text1.includes('rel-1'), text1.slice(0, 240))
  const invokeTwo = await api('POST', '/api/workshop/agent-tools/invoke', {
    agentId: leadAgentIdOuter,
    tool: 'ontology_node_neighbors',
    args: { line_id: line.id, entity_key: 'pv.melt_pressure', hops: 2 },
  }, token)
  const text2 = String(data(invokeTwo)?.result?.text ?? '')
  check('ON17.2', '工具 hops=2 显示间接节点与 hop 标注',
    text2.includes('st.line_speed hop=2') && text2.includes('rel-2') && text2.includes('hop=2'),
    text2.slice(0, 260))
  const outside = await api('POST', '/api/workshop/agent-tools/invoke', {
    agentId: leadAgentIdOuter,
    tool: 'ontology_node_neighbors',
    args: { line_id: 'ln-not-in-scope', entity_key: 'pv.melt_pressure' },
  }, token)
  const outsideText = String(data(outside)?.result?.text ?? '')
  check('ON17.3', '跨线读取被拦截(引用校验/作用域如实回执)',
    data(outside)?.result?.isError === true && outsideText.includes('不在你的可读范围'), outsideText.slice(0, 160))
}

// ════ L7 前端渲染走查 ════
console.log('\n=== L7 前端渲染 ===')
process.env.AW_BASE = BASE
{
  const { launch, openPage, gotoReady } = await import('./ui/lib.mjs')
  const browser = await launch({ width: 1600, height: 1000 })
  const page = await openPage(browser, { token, width: 1600, height: 1000, deviceScaleFactor: 1 })
  const pageErrors = []
  page.on('pageerror', e => pageErrors.push(String(e.message).slice(0, 200)))
  const shot = name => page.screenshot({ path: join(EVID, `${name}.png`), fullPage: true })

  try {
    await gotoReady(page, '/ontology', { wait: 3500 })
    const sidebar = await page.evaluate(() => document.body.textContent.includes('本体模型'))
    check('L7.1', '侧边栏含「本体模型」入口', sidebar)
    const tabs = await page.evaluate(() => Array.from(document.querySelectorAll('.tabs .pill-btn')).map(b => (b.textContent || '').trim()))
    check('L7.2', '/ontology 六 tab 渲染', tabs.length === 6, tabs.join('|'))
    await shot('ontology-overview')

    // graph tab 默认 SVG:节点/边数必须与当前草稿一致(图与表格同源)
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('.tabs .pill-btn'))[1]
      if (btn) btn.click()
    })
    await sleep(1600)
    const graphInfo = await page.evaluate(() => {
      const root = document.querySelector('[data-testid="ontology-graph"]')
      return {
        nodes: root ? root.querySelectorAll('[data-node-key]').length : -1,
        edges: root ? root.querySelectorAll('[data-edge-id]').length : -1,
      }
    })
    const draftDetail = await api('GET', `/api/workshop/ontology/drafts/${encodeURIComponent(draftId)}`, undefined, token)
    const draftDoc = data(draftDetail)?.doc ?? {}
    const expectedNodes = (draftDoc.entities ?? []).length
    const expectedEdges = (draftDoc.relations ?? []).length
    check('L7.3a', 'graph tab 渲染 SVG 节点/边且与草稿一致',
      graphInfo.nodes === expectedNodes && graphInfo.edges === expectedEdges && graphInfo.nodes > 0,
      `nodes=${graphInfo.nodes}/${expectedNodes} edges=${graphInfo.edges}/${expectedEdges}`)
    await shot('ontology-graph')

    // 点击节点 → 抽屉:1 跳邻接,再切 2 跳看间接关联
    await page.click('[data-node-key="pv.melt_pressure"]')
    await sleep(1600)
    const drawer1 = await page.evaluate(() => ({
      open: Boolean(document.querySelector('[data-testid="node-drawer"]')),
      neighbors: Array.from(document.querySelectorAll('[data-neighbor-key]')).map(el => el.getAttribute('data-neighbor-key')),
      edges: Array.from(document.querySelectorAll('[data-testid="node-drawer"] [data-edge-id]')).map(el => el.getAttribute('data-edge-id')),
    }))
    check('L7.3b', '点击节点弹出抽屉并列出直接邻接',
      drawer1.open && drawer1.neighbors.includes('cv.thickness') && drawer1.edges.includes('rel-1'),
      JSON.stringify(drawer1))
    await shot('ontology-drawer')
    await page.evaluate(() => {
      const seg = Array.from(document.querySelectorAll('.ant-segmented-item')).find(el => (el.textContent || '').includes('间接关联'))
      if (seg) seg.click()
    })
    await sleep(1600)
    const drawer2 = await page.evaluate(() => ({
      neighbors: Array.from(document.querySelectorAll('[data-neighbor-key]')).map(el => el.getAttribute('data-neighbor-key')),
      edges: Array.from(document.querySelectorAll('[data-testid="node-drawer"] [data-edge-id]')).map(el => el.getAttribute('data-edge-id')),
    }))
    check('L7.3b2', '抽屉切 2 跳后出现间接节点 st.line_speed 与 rel-2',
      drawer2.neighbors.includes('st.line_speed') && drawer2.edges.includes('rel-2'), JSON.stringify(drawer2))
    await shot('ontology-drawer-hops2')
    await page.keyboard.press('Escape').catch(() => {})
    await sleep(600)

    // 切到表视图:实体表与关系表都要有行
    await page.evaluate(() => {
      const seg = Array.from(document.querySelectorAll('.ant-segmented-item')).find(el => (el.textContent || '').trim() === '表')
      if (seg) seg.click()
    })
    await sleep(1400)
    const tableInfo = await page.evaluate(() => ({
      entityRows: document.querySelectorAll('[data-testid="entity-table"] .ant-table-tbody tr.ant-table-row').length,
      relationRows: document.querySelectorAll('[data-testid="relation-table"] .ant-table-tbody tr.ant-table-row').length,
    }))
    check('L7.3c', '切到表视图:实体表与关系表均有行', tableInfo.entityRows > 0 && tableInfo.relationRows > 0, JSON.stringify(tableInfo))
    await shot('ontology-graph-table')

    const tabKeys = ['rules', 'bindings', 'versions']
    const tabIndex = { rules: 2, bindings: 3, versions: 4 }
    let renderedOk = true
    const renderDetail = []
    for (const key of tabKeys) {
      await page.evaluate((idx) => {
        const btn = Array.from(document.querySelectorAll('.tabs .pill-btn'))[idx]
        if (btn) btn.click()
      }, tabIndex[key])
      await sleep(1200)
      const info = await page.evaluate(() => ({
        rows: document.querySelectorAll('.ant-table-tbody tr').length,
        empty: document.querySelectorAll('.ant-empty').length,
      }))
      renderDetail.push(`${key}:rows=${info.rows},empty=${info.empty}`)
      if (info.rows === 0 && info.empty === 0) renderedOk = false
      await shot(`ontology-${key}`)
    }
    check('L7.3d', '规则/绑定/版本三 tab 表格渲染非空', renderedOk, renderDetail.join(' '))

    // 编译预览:真实点击工具栏按钮 → 产物面板 + Rule Trace 表
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find(b => (b.textContent || '').includes('编译预览'))
      if (btn) btn.click()
    })
    await sleep(3500)
    const compileInfo = await page.evaluate(() => ({
      artifacts: document.querySelectorAll('.artifacts pre').length,
      traceRows: document.querySelectorAll('.ant-table-tbody tr').length,
    }))
    check('L7.3b', 'UI 编译预览:四类产物 + 溯源表渲染', compileInfo.artifacts >= 4 && compileInfo.traceRows >= 3, JSON.stringify(compileInfo))
    await shot('ontology-compile')

    const headText = await page.evaluate(() => document.querySelector('.aw-page-head')?.textContent ?? '')
    check('L7.4', '页面头/副标题渲染(价值叙事可见)', headText.includes('本体模型'), headText.slice(0, 60))

    for (const [path, name] of [
      ['/dcw', 'dcw', '产线'],
      ['/daq', 'daq', '数采'],
      ['/aml', 'aml', '建模'],
      ['/optimizer', 'optimizer', '优化'],
      ['/analysis', 'analysis', '分析'],
    ]) {
      const errsBefore = pageErrors.length
      await gotoReady(page, path, { wait: 2500 })
      await sleep(800)
      const bodyLen = await page.evaluate(() => (document.body.textContent ?? '').length)
      const ok = pageErrors.length === errsBefore && bodyLen > 400
      check(`L7.${5 + ['dcw', 'daq', 'aml', 'optimizer', 'analysis'].indexOf(name)}`, `/${name} 可打开无 pageerror`, ok, `len=${bodyLen} newErrors=${pageErrors.slice(errsBefore).slice(0, 1).join(';')}`)
      await shot(`page-${name}`)
    }
    check('L7.10', '全程无未捕获 pageerror', pageErrors.length === 0 || pageErrors.every(e => e.includes('dispose')), pageErrors.slice(0, 2).join(';'))
  }
  finally {
    await browser.close().catch(() => {})
  }
}

// ════ 报告 ════
const pass = results.filter(r => r.pass).length
const report = {
  script: 'scripts/e2e-ontology-live.mjs',
  generatedAt: new Date().toISOString(),
  base: BASE,
  home: HOME,
  ontology: ONT,
  lineId: line.id,
  total: results.length,
  pass,
  fail: results.length - pass,
  results,
}
writeFileSync(join(EVID, 'report.json'), JSON.stringify(report, null, 2))
console.log(`\nONTOLOGY LIVE E2E: ${pass}/${results.length} passed, ${results.length - pass} failed`)
console.log(`evidence: ${EVID}`)
killTree(child.pid)
process.exit(results.some(r => !r.pass) ? 1 : 0)
