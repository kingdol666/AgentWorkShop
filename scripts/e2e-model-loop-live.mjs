#!/usr/bin/env node
/* eslint-disable @stylistic/max-statements-per-line */
/**
 * 模型层闭环真机 E2E(2026-10-24)—— 三层模型的「创建→使用→迭代进化」全链。
 *
 * 目标:验证 Agent 经工具面真正控制/迭代模型(不止参数优化),人类作为管理者
 * 查看/修正,Agent 在持续迭代中把新模型反馈进求解器(模型进化闭环)。
 *
 * M0  hybrid_twin 全功能频道(训练面+孪生面+优化器面同面注入)+ Agent 节点绑定 + 过程 spec
 * M1  本体层:起草→批准→发布 v1;管理者修正规则窗→v2(人类按意愿修正模型)
 * M2  孪生层(虚拟模型创建,全经 Agent 工具):场景发现→SceneContract 编译→冻结(人批准)
 *     →PhysicsSpec 骨架→校验→编译候选→频道谱系重链→真采快照→虚拟试验(recommendation-only)
 * M3  模型进化第 1 轮:训练 A → Profile v1(A)+发布+绑定 → 基线求解 → 训练 B →
 *     optimizer_profile_propose(工具)→ HITL 批准 → 发布 v2+自动重绑 → 新模型 solve optimal
 * M4  模型进化第 2 轮:训练 C → 再采纳 → v3+重绑 → solve optimal(持续进化证据+零设备写入)
 * M5  管理者面 REST:本体版本/四段 diff、Profile 版本、孪生谱系、审计三态留痕
 * M6  前端渲染走查(管理者查看:/optimizer /aml /ontology)
 *
 * 运行:node scripts/e2e-model-loop-live.mjs
 * 证据:docs/audit/evidence/2026-10-24-model-loop-live/{report.json,*.png}
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, existsSync, symlinkSync, openSync, readFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir, homedir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ROOT = join(tmpdir(), `aw-model-loop-live-${Date.now()}`)
const HOME = join(ROOT, 'home')
const EVID = resolve(process.env.AW_E2E_EVIDENCE_DIR || join(REPO, 'docs', 'audit', 'evidence', '2026-10-24-model-loop-live'))
mkdirSync(HOME, { recursive: true })
mkdirSync(EVID, { recursive: true })

const TAG = `mlp${Date.now().toString(36).slice(-4)}`
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
  try {
    spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
  }
  catch { /* 进程已退 */ }
}

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

const line = getDcwLineRepo().create({ name: `模型闭环验收线-${TAG}`, simulated: true })
const product = getDcwProductRepo().create({ name: `模型闭环验收产品-${TAG}`, lineId: line.id })
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
getDaqNodeRepo().insert(DaqNode.fromRow({
  id: `dn-${TAG}-mv`, templateRef: 'tpl-loop-mv', name: `熔体压力-${TAG}`, unit: 'bar',
  min: 0, max: 100, lineId: line.id, driver: 'mock',
}))
getDaqNodeRepo().insert(DaqNode.fromRow({
  id: `dn-${TAG}-cv`, templateRef: 'tpl-loop-cv', name: `膜厚度-${TAG}`, unit: 'μm',
  min: 0, max: 200, lineId: line.id, driver: 'mock',
}))
getDaqNodeRepo().insert(DaqNode.fromRow({
  id: `dn-${TAG}-temp`, templateRef: 'tpl-loop-temp', name: `温区温度-${TAG}`, unit: '℃',
  min: 0, max: 400, lineId: line.id, driver: 'mock',
}))
const MV_ID = `dn-${TAG}-mv`
const CV_ID = `dn-${TAG}-cv`
const TEMP_ID = `dn-${TAG}-temp`
const recipe = getDcwRecipeRepo().create({
  name: `模型闭环验收配方-${TAG}`, productId: product.id,
  params: [
    { nodeId: DCW_PRESS, value: 50, min: 0, max: 100 },
    { nodeId: DCW_SPEED, value: 10, min: 0, max: 50 },
  ],
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
console.log(`venv: ${venvLinked ? 'junction ok' : '未复用(训练将失败,先检查)'}`)
if (!venvLinked) console.warn('⚠ 未找到真实 python venv,训练轮会失败')

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
  // context 窗口 = H*beat + maxDelay + 5*beat;尾巴必须覆盖整窗,否则网格 NaN
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

// ════ 启动隔离实例 ════
// 强制 SQLite 时序(宿主 Timescale 在线时插件会切走,看不到预置样本);MQTT 指向关闭端口。
const { saveSettings } = await import('../shared/config/engine.mjs')
saveSettings({
  'daq.timescale.host': '127.0.0.1',
  'daq.timescale.port': 6543,
  'daq.mqtt.host': '127.0.0.1',
  'daq.mqtt.port': 18830,
  'daq.startInfrastructure': 'never',
}, join(HOME, 'runtime-settings.json'))
let port = 0
for (const p of [3997, 3996, 3995, 3994, 3993]) {
  let occupied = false
  try {
    await fetch(`http://127.0.0.1:${p}/api/health`, { signal: AbortSignal.timeout(800) })
    occupied = true
  }
  catch { /* 空闲 */ }
  if (!occupied) {
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
console.log(`\n=== boot ${BASE} ===`)
const logFd = openSync(join(ROOT, 'dev.log'), 'a')
const child = spawn(process.execPath, [join(REPO, 'bin', 'aw.mjs'), 'dev', '--port', String(port)], {
  cwd: REPO,
  env: { ...process.env, AW_RATE_LIMIT_OFF: '1', NUXT_SESSION_PASSWORD: 'ModelLoopLive#2026-e2e-session', NO_PROXY: '127.0.0.1,localhost' },
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

const email = `mlp-${TAG}@awshop.local`
let reg = null
for (let attempt = 0; attempt < 3 && !data(reg ?? {})?.token; attempt++) {
  try {
    reg = await api('POST', '/api/users/register', { name: `模型闭环验收-${TAG}`, email, password: 'ModelLoop#2026' })
  }
  catch (err) {
    console.log(`register attempt ${attempt + 1} failed: ${String(err).slice(0, 120)}`)
    await sleep(3000)
  }
}
const token = data(reg ?? {})?.token
check('BOOT', '管理员注册(首注册=admin)', Boolean(token), `status=${reg.status}`)
if (!token) { killTree(child.pid); throw new Error('注册失败') }

// ════ M0 hybrid_twin 全功能频道 + 绑定三面 ════
console.log('\n=== M0 频道与三面绑定 ===')
const ONT = `ont-${TAG}`
const SPEC = `pms-${TAG}`
const profileId = `optp-${TAG}`
const SCENE_ID = `scn-${TAG}`
let channelIdOuter
let leadAgentIdOuter
let workspaceIdOuter
let bindingId
let trainedAId
let trainedBId
let trainedCId
let trainedAHash
let trainedBHash
let trainedCHash
let spec
{
  const inst = await api('POST', '/api/workshop/channel-templates/chtpl-hybrid-twin-mpc-default/instantiate', { name: `模型闭环频道-${TAG}`, bindLineId: line.id }, token)
  const instData = data(inst) ?? {}
  workspaceIdOuter = data(await api('POST', '/api/workshop/workspaces', { name: `模型闭环工作区-${TAG}` }, token))?.id
  channelIdOuter = instData.channelId
  leadAgentIdOuter = instData.leadAgentId ?? (instData.agents ?? []).find(a => a.role === 'lead')?.id
  if (workspaceIdOuter && channelIdOuter) await api('POST', `/api/workshop/workspaces/${encodeURIComponent(workspaceIdOuter)}/channels/${encodeURIComponent(channelIdOuter)}`, undefined, token)
  check('M0.1', 'hybrid_twin 频道实例化(全功能档位)+workspace', Boolean(workspaceIdOuter && channelIdOuter && leadAgentIdOuter), `inst=${inst.status} ch=${channelIdOuter} lead=${leadAgentIdOuter}`)

  // 工具面断言(进程内同判:scopeHostToolsForRole 与线上装配同一函数)
  try {
    const { scopeHostToolsForRole } = await import('../server/services/workshop/agents/host-tool-bridge/catalog')
    const scope = scopeHostToolsForRole('lead', channelIdOuter)
    const names = new Set(scope.tools.map(t => t.name))
    const need = ['twin_scene_discover', 'twin_scene_compile', 'twin_scene_freeze', 'twin_physics_spec_draft', 'twin_physics_spec_validate', 'twin_physics_spec_compile', 'twin_snapshot_create', 'twin_trial_run', 'aml_dataset_build', 'aml_job_submit', 'optimizer_solve', 'optimizer_profile_propose', 'ontology_draft_create']
    const missing = need.filter(n => !names.has(n))
    check('M0.2', 'hybrid 档位工具面:训练+孪生+优化器+本体四族同面注入', missing.length === 0, `missing=${missing.join(',')} total=${names.size}`)
  }
  catch (err) {
    check('M0.2', 'hybrid 档位工具面(进程内装配)', false, `err=${String(err).slice(0, 160)}`)
  }

  // Agent 节点绑定:daq 读面(MV/CV/TEMP)+ 配方面(参数写面 → 场景控制面)
  const bindNode = async (nodeId, kind) => api('POST', '/api/workshop/agent-tools/bindings', { agentId: leadAgentIdOuter, nodeId, kind }, token)
  const b1 = await bindNode(MV_ID, 'daq')
  const b2 = await bindNode(CV_ID, 'daq')
  const b3 = await bindNode(TEMP_ID, 'daq')
  const b4 = await bindNode(recipe.id, 'recipe')
  check('M0.3', 'Agent 节点绑定:daq×3 + recipe(参数面)', [b1, b2, b3, b4].every(x => x.status === 200), `daq=${[b1.status, b2.status, b3.status]} recipe=${b4.status}/${errCode(b4)}`)

  // 过程 spec 先登记发布(Profile 的 processSpecRef 谱系前置;Profile 本体在 M3 训练出模型后创建)
  spec = {
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
  const specCreated = await api('POST', '/api/workshop/process-model/specs', spec, token)
  const specPub = await api('POST', `/api/workshop/process-model/specs/${encodeURIComponent(SPEC)}/publish?version=1`, undefined, token)
  check('M0.4', '过程 spec 登记+发布(求解器谱系前置)', specCreated.status === 200 && specPub.status === 200, `create=${specCreated.status}/${errCode(specCreated)} pub=${specPub.status}`)
}

// ════ M1 本体层:v1 发布 → 管理者修正 → v2 ════
console.log('\n=== M1 本体层(管理者修正路径) ===')
let draftId
const ontologyDoc = (overrides = {}) => ({
  schemaVersion: 1,
  name: `模型闭环验收-${TAG}`,
  description: `膜厚闭环控制本体:压力/线速→膜厚,温区守门(${TAG})`,
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
  ],
  rules: [
    {
      id: 'R-BOUND', key: 'thickness-window', kind: 'bound',
      dsl: { type: 'bound', variableKey: 'cv.thickness', min: 45, max: 55, unit: 'μm' },
      constraintLevel: 'hard', severity: 'error', status: 'proposed',
      evidence: [{ id: 'ev-bound', level: 'validated_control', source: { type: 'optimizer_run', runId: 'run-b', problemIrHash: 'ir', modelArtifactHash: 'mdl' }, sourceRefHash: 'h', createdAt: new Date().toISOString() }],
      description: '膜厚工艺窗(μm)', scope: { lineId: line.id, recipeId: recipe.id, conditionId: '' },
    },
    {
      id: 'R-GUARD', key: 'cold-zone-no-speedup', kind: 'state_condition',
      dsl: { type: 'state_condition', when: { variableKey: 'st.zone_temp', op: 'lt', value: 180 }, forbid: { kind: 'positive_increment', variableKey: 'st.line_speed' }, message: '温区未达 180℃,禁止提速' },
      constraintLevel: 'hard', severity: 'error', status: 'proposed',
      evidence: [{ id: 'ev-guard', level: 'validated_control', source: { type: 'optimizer_run', runId: 'run-g', problemIrHash: 'ir', modelArtifactHash: 'mdl' }, sourceRefHash: 'h', createdAt: new Date().toISOString() }],
      description: '冷区禁提速', scope: { lineId: line.id, recipeId: recipe.id, conditionId: '' },
    },
  ],
  bindings: [
    { id: 'b-press', entityKey: 'pv.melt_pressure', platformKind: 'dcw_node', platformId: DCW_PRESS, targetSub: '', scope: `line:${line.id}`, direction: 'write', unitDeclared: 'bar', unitTarget: 'bar', scale: 1, offset: 0 },
    { id: 'b-speed', entityKey: 'st.line_speed', platformKind: 'dcw_node', platformId: DCW_SPEED, targetSub: '', scope: `line:${line.id}`, direction: 'write', unitDeclared: 'm/min', unitTarget: 'm/min', scale: 1, offset: 0 },
    { id: 'b-cv', entityKey: 'cv.thickness', platformKind: 'daq_node', platformId: CV_ID, targetSub: '', scope: `line:${line.id}`, direction: 'read', unitDeclared: 'μm', unitTarget: 'μm', scale: 1, offset: 0 },
    { id: 'b-temp', entityKey: 'st.zone_temp', platformKind: 'daq_node', platformId: TEMP_ID, targetSub: '', scope: `line:${line.id}`, direction: 'read', unitDeclared: '℃', unitTarget: '℃', scale: 1, offset: 0 },
  ],
  note: 'model-loop live e2e',
  ...overrides,
})
async function approveRule(draft, ruleId) {
  await api('POST', `/api/workshop/ontology/drafts/${encodeURIComponent(draft)}/rules/${ruleId}/transition`, { to: 'reviewed' }, token)
  await api('POST', `/api/workshop/ontology/drafts/${encodeURIComponent(draft)}/rules/${ruleId}/transition`, { to: 'validated' }, token)
  const ap = await api('POST', `/api/workshop/ontology/drafts/${encodeURIComponent(draft)}/rules/${ruleId}/approval`, {}, token)
  const apId = data(ap)?.approvalId ?? ''
  await api('POST', `/api/workshop/ontology/drafts/${encodeURIComponent(draft)}/rules/${ruleId}/approval-decision`, { approvalId: apId, approved: true }, token)
  return api('POST', `/api/workshop/ontology/drafts/${encodeURIComponent(draft)}/rules/${ruleId}/transition`, { to: 'approved_for_control', approvalId: apId }, token)
}
{
  const created = await api('POST', '/api/workshop/ontology', { ontologyId: ONT, lineId: line.id, name: `模型闭环验收-${TAG}` }, token)
  draftId = data(created)?.draft?.id ?? ''
  const saved = await api('PATCH', `/api/workshop/ontology/drafts/${encodeURIComponent(draftId)}`, { doc: ontologyDoc(), expectedRev: 1 }, token)
  check('M1.1', '本体起草(活体校验+绑定通过)', created.status === 200 && saved.status === 200 && data(saved)?.validation?.ok === true, `saved=${saved.status} issues=${JSON.stringify((data(saved)?.validation?.issues ?? []).filter(i => i.severity === 'error').slice(0, 2))}`)
  const detail0 = data(await api('GET', `/api/workshop/ontology/drafts/${encodeURIComponent(draftId)}`, undefined, token))
  check('M1.1b', '本体描述可读(用户理解模型代表什么)', String(detail0?.doc?.description ?? '').includes('膜厚闭环控制本体'), String(detail0?.doc?.description ?? '').slice(0, 60))
  await approveRule(draftId, 'R-BOUND')
  await approveRule(draftId, 'R-GUARD')
  const pub1 = await api('POST', `/api/workshop/ontology/drafts/${encodeURIComponent(draftId)}/publish`, {}, token)
  check('M1.2', '本体 v1 发布(contentHash+packHash)', pub1.status === 200 && data(pub1)?.version?.version === 1, `${pub1.status}/${errCode(pub1)}`)

  // 管理者修正:复用草稿(发布不改 rev,草稿仍可编辑;重复发布=新版本不可变语义),
  // 把膜厚窗从 [45,55] 收到 [46,54],重走生命周期后发布 v2
  const detail = data(await api('GET', `/api/workshop/ontology/drafts/${encodeURIComponent(draftId)}`, undefined, token))
  const curRev = detail?.draft?.rev ?? 2
  const doc2 = ontologyDoc()
  doc2.rules[0].dsl.min = 46
  doc2.rules[0].dsl.max = 54
  doc2.rules[0].description = '膜厚工艺窗(管理者修正:收窄到 46-54μm)'
  const saved2 = await api('PATCH', `/api/workshop/ontology/drafts/${encodeURIComponent(draftId)}`, { doc: doc2, expectedRev: curRev }, token)
  await approveRule(draftId, 'R-BOUND')
  await approveRule(draftId, 'R-GUARD')
  const pub2 = await api('POST', `/api/workshop/ontology/drafts/${encodeURIComponent(draftId)}/publish`, {}, token)
  check('M1.3', '管理者修正规则窗 → v2 发布', pub2.status === 200 && data(pub2)?.version?.version === 2, `saved=${saved2.status}/${errCode(saved2)} pub=${pub2.status}/${errCode(pub2)}`)
  const messy = ontologyDoc()
  messy.description = ''
  for (const e of messy.entities) e.description = ''
  for (const r of messy.rules) { r.description = ''; r.scope.lineId = '' }
  for (const b of messy.bindings) b.scope = 'global'
  const createFix = await invokeTool('ontology_draft_create', { ontology_id: `${ONT}-fix`, line_id: line.id, name: `修复验收-${TAG}` })
  const createFixText = String(createFix?.data?.text ?? createFix?.data?.result?.text ?? createFix?.text ?? '')
  const draft3 = (createFixText.match(/已创建草稿\s+(\S+?)\(/) ?? [])[1] ?? ''
  const savedMessy = createFix ? await api('PATCH', `/api/workshop/ontology/drafts/${encodeURIComponent(draft3)}`, { doc: messy, expectedRev: 1 }, token) : { status: 0 }
  const fixRes = await invokeTool('ontology_draft_autofix', { draft_id: draft3 })
  const fixText = String(fixRes?.data?.text ?? fixRes?.data?.result?.text ?? fixRes?.text ?? JSON.stringify(fixRes ?? {}))
  const fixErr = Boolean(fixRes?.isError ?? fixRes?.data?.isError)
  check('M1.5', 'Agent 工具 ontology_draft_autofix:自动修复并落库', !fixErr && /自动修复 \d+ 项/.test(fixText), fixText.slice(0, 180))
  const detail3 = data(await api('GET', `/api/workshop/ontology/drafts/${encodeURIComponent(draft3)}`, undefined, token))
  check('M1.6', '修复后:描述/作用域已补齐且校验通过', Boolean(detail3?.doc?.description) && detail3?.validation?.ok === true && (detail3?.doc?.bindings ?? []).every(b => String(b.scope).startsWith('line:')), `desc=${String(detail3?.doc?.description ?? '').slice(0, 40)} savedMessy=${savedMessy.status}`)
  const cmp = await api('GET', `/api/workshop/ontology/versions/${encodeURIComponent(ONT)}/compare?from=1&to=2`, undefined, token)
  const changed = data(cmp)?.rules?.changed ?? []
  check('M1.4', '四段 diff 反映管理者意志(R-BOUND changed)', cmp.status === 200 && changed.some(c => String(typeof c === 'string' ? c : (c.id ?? c.ruleId ?? '')).includes('R-BOUND')), JSON.stringify(changed).slice(0, 200))
}

// ════ M2 孪生层:Agent 工具创建虚拟模型全链 ════
console.log('\n=== M2 孪生层(Agent 工具创建虚拟模型) ===')
async function invokeTool(tool, args, timeoutMs = 180_000) {
  return api('POST', '/api/workshop/agent-tools/invoke', { agentId: leadAgentIdOuter, tool, args }, token, timeoutMs)
}
const toolText = r => String(r?.data?.text ?? r?.data?.result?.text ?? r?.text ?? r?.message ?? JSON.stringify(r ?? {}).slice(0, 300))
const toolErr = r => Boolean(r?.isError ?? r?.data?.isError)
const artifactPathOf = (text) => {
  const m = String(text).match(/artifact:\s*(\S+)/)
  return m ? m[1] : ''
}
{
  const disc = await invokeTool('twin_scene_discover', {})
  check('M2.1', '工具 twin_scene_discover:从真实绑定发现场景', disc.status === 200 && !toolErr(disc) && toolText(disc).includes('nodeCount'), toolText(disc).slice(0, 160))

  const comp = await invokeTool('twin_scene_compile', { scene_id: SCENE_ID, scene_version: '1.0.0', line_id: line.id, product_id: product.id, recipe_id: recipe.id, prompt: '膜厚闭环验收场景' })
  const compText = toolText(comp)
  check('M2.2', '工具 twin_scene_compile:SceneContract 草稿(controls+artifact)', comp.status === 200 && !toolErr(comp) && compText.includes('SceneContract Draft'), compText.slice(0, 200))

  const { createTwinRepo } = await import('../server/services/workshop/aml/twin/repo')
  const twinRepo = createTwinRepo(seedDb)
  const sceneRow = twinRepo.getScene(SCENE_ID, '1.0.0')
  const sceneJson = sceneRow ? JSON.parse(sceneRow.contractJson) : null
  check('M2.3', '场景草稿持久化(控制面+目标面齐备,谱系可复用)', Boolean(sceneJson) && (sceneJson.controls ?? []).length >= 2 && (sceneJson.observations ?? []).some(v => v.role === 'target'), `controls=${sceneJson?.controls?.length} states=${sceneJson?.states?.length} obs=${sceneJson?.observations?.length}(targets=${(sceneJson?.observations ?? []).filter(v => v.role === 'target').length})`)

  const frz = await invokeTool('twin_scene_freeze', { scene_id: SCENE_ID, scene_version: '1.0.0', approved_by: email, confirmation: 'USER_CONFIRMED_SCENE_CONTRACT' })
  check('M2.4', '工具 twin_scene_freeze:人批准冻结(approvedBy=管理者)', frz.status === 200 && !toolErr(frz) && toolText(frz).includes('"status": "frozen"'), toolText(frz).slice(0, 200))
  const noConfirm = await invokeTool('twin_scene_freeze', { scene_id: `${SCENE_ID}-x`, scene_version: '1.0.0' })
  check('M2.5', '冻结治理红线:缺确认令牌 → 拒绝', toolErr(noConfirm) || toolText(noConfirm).includes('冻结被拒绝'), toolText(noConfirm).slice(0, 120))

  const frozenRow = twinRepo.getScene(SCENE_ID, '1.0.0')
  const frozenScene = JSON.parse(frozenRow.contractJson)

  const draft = await invokeTool('twin_physics_spec_draft', { scene_json: frozenScene, dt_sec: BEAT / 1000 })
  const draftArtifact = artifactPathOf(toolText(draft))
  const physSpec = draftArtifact && existsSync(draftArtifact) ? JSON.parse(readFileSync(draftArtifact, 'utf8')) : null
  check('M2.6', '工具 twin_physics_spec_draft:虚拟模型骨架(状态+参数可校准)', draft.status === 200 && !toolErr(draft) && Boolean(physSpec) && (physSpec.states ?? []).length >= 1 && (physSpec.parameters ?? []).length >= 1, toolText(draft).slice(0, 200))

  const val = await invokeTool('twin_physics_spec_validate', { physics_spec: physSpec })
  const valData = data(val) ?? {}
  const valBody = valData.apiVersion ? valData : (val.data ?? {})
  check('M2.7', '工具 twin_physics_spec_validate:valid=true', val.status === 200 && !toolErr(val) && (valBody.valid === true || String(toolText(val)).includes('"valid": true')), String(toolText(val)).slice(0, 160))

  const compiled = await invokeTool('twin_physics_spec_compile', { physics_spec: physSpec, scene_json: frozenScene })
  const compBody = data(compiled) ?? {}
  check('M2.8', '工具 twin_physics_spec_compile:候选 Provider(candidate_not_registered)', compiled.status === 200 && !toolErr(compiled) && (compBody.status === 'candidate_not_registered' || String(toolText(compiled)).includes('candidate_not_registered')), String(toolText(compiled)).slice(0, 160))

  // 频道谱系重链到真实冻结场景(训练通道冻结、优化通道复用的平台语义;走平台自有服务)。
  // providerId 保留已注册的 injection-greybox-v1:声明式 Provider 仅为 candidate(工具明确
  // 不直接注册投产),物理 rollout 由注入 greybox 承担;其观测 id 与本场景不映射 →
  // 试验约束 fail-closed —— 正是「未注册 provider 不许投产」的治理语义,一并断言。
  const { setHybridChannelProfile, getChannelTwinProfile } = await import('../server/services/workshop/aml/twin/channel-profile')
  const prevProfile = getChannelTwinProfile(channelIdOuter)
  setHybridChannelProfile({
    ...prevProfile,
    sceneId: SCENE_ID,
    sceneVersion: '1.0.0',
    sceneContract: frozenScene,
    scenePackId: SCENE_ID,
    providerId: 'injection-greybox-v1',
    providerVersion: undefined,
    providerHash: undefined,
    createdBy: 'e2e',
  })
  const profAfter = data(await api('GET', `/api/workshop/channels/${encodeURIComponent(channelIdOuter)}/twin-profile`, undefined, token))
  check('M2.9', '频道场景谱系重链(REST 可读)', profAfter?.profile?.sceneId === SCENE_ID && profAfter?.profile?.profile === 'hybrid_twin', `sceneId=${profAfter?.profile?.sceneId}`)

  writeFreshTail()
  const snap = await invokeTool('twin_snapshot_create', { channel_id: channelIdOuter, auto_daq: true, phase: 'exploration' }, 120_000)
  const snapId = (toolText(snap).match(/snapshot_id:\s*(\S+)/) ?? [])[1] ?? ''
  check('M2.10', '工具 twin_snapshot_create:服务端真采快照(auto_daq,fresh)', snap.status === 200 && !toolErr(snap) && Boolean(snapId) && toolText(snap).includes('fresh: true'), toolText(snap).slice(0, 200))

  const targetVars = (frozenScene.observations ?? []).filter(v => v.role === 'target')
  const targetId = targetVars[0]?.id ?? (frozenScene.observations ?? [])[0]?.id ?? 'cv'
  const controlIds = (frozenScene.controls ?? []).map(c => c.id)
  const candidate = {}
  if (controlIds[0]) candidate[controlIds[0]] = 60
  const objective = {
    schemaVersion: 1, createdAt: new Date().toISOString(), createdBy: leadAgentIdOuter, objectiveId: 'loop-e2e',
    targets: { [targetId]: 50 }, weights: { [targetId]: 1 }, controlCosts: {}, horizonSteps: 4, trustRegion: {},
  }
  const trial = await invokeTool('twin_trial_run', { snapshot_id: snapId, objective, candidate_controls: [candidate] }, 120_000)
  const trialText = toolText(trial)
  check('M2.11', '工具 twin_trial_run:虚拟试验完成(模型驱动 rollout)', trial.status === 200 && !toolErr(trial) && trialText.includes('VirtualTrial 已完成'), trialText.slice(0, 220))
  check('M2.12', '虚拟试验治理语义:candidateExecuted=false + 约束 fail-closed(候选 provider 未注册不投产)', trialText.includes('candidateExecuted=false') && trialText.includes('constraints_passed: false'), trialText.split('\n').filter(Boolean).slice(0, 4).join(' | '))
}

// ════ M3/M4 模型进化两轮(训练 → 工具采纳 → HITL → 发布重绑 → 新模型求解) ════
console.log('\n=== M3 模型进化第 1 轮 ===')
async function trainOnce(modelName) {
  let ds = await api('POST', '/api/workshop/process-model/datasets', spec, token)
  for (const backoff of [3000, 6000]) {
    if (ds.status === 200) break
    writeFreshTail()
    await sleep(backoff)
    ds = await api('POST', '/api/workshop/process-model/datasets', spec, token)
  }
  const datasetId = data(ds)?.datasetId
  // 优化资格报告(solve 前置:模型须经资格评估,缺报告 → solve 422 不具备优化资格)
  const elig = await api('POST', '/api/workshop/process-model/eligibility', { specId: SPEC, specVersion: 1, datasetId, scope: 'simulation' }, token)
  const eligOk = data(elig)?.report?.optimizationEligible === true
  const train = await api('POST', '/api/workshop/process-model/train', { spec, datasetId, modelName }, token)
  const jobId = data(train)?.job?.id
  let job = null
  const terminal = new Set(['done', 'failed', 'cancelled', 'timeout', 'interrupted'])
  for (let i = 0; i < 240; i++) {
    const jr = await api('GET', `/api/workshop/aml/jobs/${encodeURIComponent(jobId)}`, undefined, token)
    job = data(jr)?.job
    if (job && terminal.has(job.status)) break
    await sleep(500)
  }
  const models = await api('GET', `/api/workshop/aml/models?recipeId=${encodeURIComponent(recipe.id)}`, undefined, token)
  const model = (data(models)?.models ?? []).find(m => m.id === (job?.modelId ?? ''))
  return { datasetId, rowCount: data(ds)?.rowCount ?? 0, jobId, job, modelId: job?.modelId ?? '', artifactHash: model?.artifactHash ?? '', eligOk }
}
async function adoptRound(modelId, reason, description) {
  const adoptInvoke = invokeTool('optimizer_profile_propose', { model_id: modelId, reason, profile_description: description }, 300_000)
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
  if (!card) {
    const adoptText = await adoptInvoke.catch(err => ({ text: `invoke rejected: ${String(err).slice(0, 120)}` }))
    return { card: null, adoptText, dec: { status: 0 } }
  }
  const dec = await api('POST', `/api/workshop/agent-tools/approvals/${encodeURIComponent(card.id)}/decide`, { approved: true, choice: 0, comment: '模型进化闭环验收批准' }, token)
  let adoptText
  try {
    adoptText = await adoptInvoke
  }
  catch (err) {
    adoptText = { text: `invoke rejected: ${String(err).slice(0, 160)}` }
  }
  return { card, adoptText, dec }
}
let round1RowCount
{
  // ── 第 1 轮:训练 A → Profile v1(A) → 发布 → 绑定 → 基线求解 ──
  const ra = await trainOnce(`模型闭环A-${TAG}`)
  trainedAId = ra.modelId
  trainedAHash = ra.artifactHash
  round1RowCount = ra.rowCount
  const annotate = await invokeTool('aml_model_annotate', { model_id: ra.modelId, label: `膜厚模型A-${TAG}`, description: '产线A 膜厚预测:线性状态空间,适配保压/线速工况' })
  const annotateText = toolText(annotate)
  check('M3.0', 'Agent 工具 aml_model_annotate:补模型名称/描述', !toolErr(annotate) && annotateText.includes('人读身份已更新'), annotateText.slice(0, 140))
  check('M3.1', '第 1 轮训练 done + 模型登记 + 优化资格(artifactHash)', ra.job?.status === 'done' && ra.eligOk && trainedAId && trainedAHash.length === 64, `status=${ra.job?.status} model=${trainedAId} rows=${ra.rowCount} err=${String(ra.job?.error ?? '').slice(0, 100)}`)

  const profileBody = {
    schemaVersion: 1, id: profileId, version: 1,
    modelRef: { modelId: trainedAId, artifactKind: 'linear_state_space@1', artifactHash: trainedAHash, modelInterface: 'linear_state_space', stage: 'candidate' },
    problemTemplateRef: 'linear_mpc_quadratic@1',
    problemConfig: { linear_mpc_quadratic: { cvWeights: { cv1: 1 }, duWeights: { mv1: 0.1 }, terminalWeight: 2, targets: { cv1: 50 } } },
    solverRef: 'osqp_mpc@1', solverVersion: '1',
    processSpecRef: `${SPEC}@1`, conditionIds: [], status: 'draft',
  }
  const profCreated = await api('POST', '/api/workshop/optimization/profiles', profileBody, token)
  const pub1 = await api('POST', `/api/workshop/optimization/profiles/${encodeURIComponent(profileId)}/publish?version=1`, undefined, token)
  check('M3.2', 'Profile v1 创建(模型A 工件回填)+发布', profCreated.status === 200 && pub1.status === 200, `create=${profCreated.status}/${errCode(profCreated)} pub=${pub1.status}/${errCode(pub1)}`)
  const bind = await api('POST', '/api/workshop/optimization/bindings', {
    workspaceId: workspaceIdOuter, channelId: channelIdOuter, agentInstanceId: leadAgentIdOuter, profileId, profileVersion: 1, mode: 'recommendation',
  }, token)
  bindingId = data(bind)?.binding?.id ?? ''
  check('M3.3', 'Agent↔Profile 绑定(revision=1,推荐模式)', bind.status === 200 && Boolean(bindingId), `id=${bindingId} code=${errCode(bind)}`)
  writeFreshTail()
  const solve0 = await api('POST', '/api/workshop/optimization/solve', { agentInstanceId: leadAgentIdOuter, bindingId }, token)
  check('M3.4', '基线模型 A solve optimal', solve0.status === 200 && data(solve0)?.result?.status === 'optimal', `status=${data(solve0)?.result?.status} http=${solve0.status} msg=${String(solve0.message ?? '').slice(0, 120)}`)

  // ── 第 2 轮:训练 B(反馈数据再积累)→ 工具采纳 → HITL → v2+重绑 → 新模型求解 ──
  const rb = await trainOnce(`模型闭环B-${TAG}`)
  trainedBId = rb.modelId
  trainedBHash = rb.artifactHash
  check('M3.5', '第 2 轮训练 done + 资格(数据集不缩水,工件不同)', rb.job?.status === 'done' && rb.eligOk && trainedBId && rb.rowCount >= round1RowCount && trainedBHash !== trainedAHash, `status=${rb.job?.status} rows ${round1RowCount}→${rb.rowCount} hashDiff=${trainedAHash !== trainedBHash}`)

  const adopt1 = await adoptRound(trainedBId, '模型进化第 1 轮采纳:换上新训练模型 B', '产线A 膜厚闭环:线性 MPC(采纳模型B,提升 rollout 精度)')
  check('M3.6', '采纳卡挂出(optimizer-profile:<id>@<v>)', Boolean(adopt1.card), `nodeId=${adopt1.card?.nodeId ?? 'none'}`)
  check('M3.7', 'HITL 批准 → 单一咽喉发布+重绑', adopt1.dec.status === 200 && (JSON.stringify(adopt1.dec).includes('published') || JSON.stringify(adopt1.dec).includes('已发布')), JSON.stringify(adopt1.dec).slice(0, 300))
  const adoptStr1 = String(adopt1.adoptText?.data?.text ?? adopt1.adoptText?.data?.result?.text ?? adopt1.adoptText?.text ?? JSON.stringify(adopt1.adoptText)).slice(0, 240)
  check('M3.8', '工具回执:模型采纳完成(诚实汇报)', adoptStr1.includes('模型采纳完成'), adoptStr1)

  const binds1 = (data(await api('GET', `/api/workshop/optimization/bindings?agentInstanceId=${encodeURIComponent(leadAgentIdOuter)}`, undefined, token))?.bindings ?? []).filter(b => b.profileId === profileId)
  const cardV1 = Number(String(adopt1.card?.nodeId ?? '').split('@')[1])
  const rebound1 = binds1.find(b => Number(b.profileVersionNumber) === cardV1)
  check('M3.9', '绑定自动重绑到采纳版本(revision+1)', Boolean(rebound1) && Number(rebound1?.revision) >= 1, `versions=[${binds1.map(b => b.profileVersionNumber).join(',')}] card=v${cardV1} rev=${rebound1?.revision}`)
  const profs1 = JSON.stringify(data(await api('GET', `/api/workshop/optimization/profiles?limit=50`, undefined, token)) ?? {})
  check('M3.10', '已发布 Profile v2 携带新模型工件 B', profs1.includes(trainedBId), `len=${profs1.length}`)
  check('M3.10b', 'Profile 描述由 Agent 提议写入并落版本台账', profs1.includes('产线A 膜厚闭环:线性 MPC(采纳模型B'), '')
  writeFreshTail()
  const solve1 = await api('POST', '/api/workshop/optimization/solve', { agentInstanceId: leadAgentIdOuter, bindingId: rebound1?.id }, token)
  check('M3.11', '新模型 B solve optimal', solve1.status === 200 && data(solve1)?.result?.status === 'optimal', `status=${data(solve1)?.result?.status} http=${solve1.status} msg=${String(solve1.message ?? '').slice(0, 120)}`)
}

console.log('\n=== M4 模型进化第 2 轮(持续迭代) ===')
{
  const rc = await trainOnce(`模型闭环C-${TAG}`)
  trainedCId = rc.modelId
  trainedCHash = rc.artifactHash
  check('M4.1', '第 3 次训练 done + 资格(反馈持续积累)', rc.job?.status === 'done' && rc.eligOk && trainedCId && trainedCHash.length === 64, `status=${rc.job?.status} model=${trainedCId} rows=${rc.rowCount}`)

  const adopt2 = await adoptRound(trainedCId, '模型进化第 2 轮采纳:持续迭代换新模型 C', '产线A 膜厚闭环:线性 MPC(采纳模型C,持续迭代)')
  check('M4.2', '第 2 轮采纳卡挂出+HITL 批准', Boolean(adopt2.card) && adopt2.dec.status === 200, `nodeId=${adopt2.card?.nodeId ?? 'none'} dec=${adopt2.dec.status}`)
  const adoptStr2 = String(adopt2.adoptText?.data?.text ?? adopt2.adoptText?.data?.result?.text ?? adopt2.adoptText?.text ?? JSON.stringify(adopt2.adoptText)).slice(0, 240)
  check('M4.3', '第 2 轮工具回执:采纳完成', adoptStr2.includes('模型采纳完成'), adoptStr2)

  const binds2 = (data(await api('GET', `/api/workshop/optimization/bindings?agentInstanceId=${encodeURIComponent(leadAgentIdOuter)}`, undefined, token))?.bindings ?? []).filter(b => b.profileId === profileId)
  const cardV2 = Number(String(adopt2.card?.nodeId ?? '').split('@')[1])
  const rebound2 = binds2.find(b => Number(b.profileVersionNumber) === cardV2)
  check('M4.4', '持续进化:绑定再次重绑(revision 递增)', Boolean(rebound2) && Number(rebound2?.revision) >= 2, `versions=[${binds2.map(b => b.profileVersionNumber).join(',')}] card=v${cardV2} rev=${rebound2?.revision}`)
  writeFreshTail()
  const solve2 = await api('POST', '/api/workshop/optimization/solve', { agentInstanceId: leadAgentIdOuter, bindingId: rebound2?.id }, token)
  check('M4.5', '第 2 轮新模型 C solve optimal', solve2.status === 200 && data(solve2)?.result?.status === 'optimal', `status=${data(solve2)?.result?.status} http=${solve2.status}`)

  const writesPath = join(HOME, 'data', 'dcw-writes.json')
  const writesLen = existsSync(writesPath) ? readFileSync(writesPath, 'utf8').length : 0
  check('M4.6', '全闭环零 DCW 写入(三轮训练+两轮采纳+求解)', writesLen === 0, `dcw-writes.json ${writesLen ? '存在' : '不存在'}`)
}

// ════ M5 管理者面 REST ════
console.log('\n=== M5 管理者面 ===')
{
  const versions = await api('GET', `/api/workshop/ontology/versions/${encodeURIComponent(ONT)}`, undefined, token)
  check('M5.1', '本体版本台账(v1+v2,管理者可查)', versions.status === 200 && (data(versions)?.versions ?? []).length >= 2, `n=${(data(versions)?.versions ?? []).length}`)

  const profs = await api('GET', `/api/workshop/optimization/profiles?limit=50`, undefined, token)
  const profStr = JSON.stringify(data(profs) ?? {})
  check('M5.2', 'Profile 版本台账含三轮模型工件(A/B/C 全可查)', profs.status === 200 && [trainedAId, trainedBId, trainedCId].every(id => profStr.includes(id)), `len=${profStr.length}`)

  const twinProf = await api('GET', `/api/workshop/channels/${encodeURIComponent(channelIdOuter)}/twin-profile`, undefined, token)
  check('M5.3', '孪生谱系台账(场景/冻结态可查)', twinProf.status === 200 && data(twinProf)?.profile?.sceneId === SCENE_ID, `sceneId=${data(twinProf)?.profile?.sceneId}`)

  const audit = await api('GET', '/api/workshop/audit?limit=500', undefined, token)
  const entries = data(audit)?.entries ?? []
  const adoptEntries = entries.filter(e => String(e.action).startsWith('optimizer.profile.adopt'))
  const kinds = new Set(adoptEntries.map(e => e.actorKind))
  check('M5.4', '审计三态留痕:AI 提议 + 人批准(adopt_propose+adopt)', adoptEntries.length >= 2 && kinds.has('agent'), `n=${adoptEntries.length} actions=${adoptEntries.map(e => e.action).join(',')} kinds=${[...kinds].join(',')}`)

  const ontAudit = entries.filter(e => String(e.action).includes('ontology'))
  check('M5.5', '本体审计留痕(起草/发布/修正)', ontAudit.length >= 1, `n=${ontAudit.length} sample=${ontAudit[0]?.action ?? '-'}`)
}

// ════ M6 前端渲染走查(管理者查看) ════
console.log('\n=== M6 前端渲染 ===')
process.env.AW_BASE = BASE
{
  const { launch, openPage, gotoReady } = await import('./ui/lib.mjs')
  const browser = await launch({ width: 1600, height: 1000 })
  const page = await openPage(browser, { token, width: 1600, height: 1000, deviceScaleFactor: 1 })
  const pageErrors = []
  page.on('pageerror', e => pageErrors.push(String(e.message).slice(0, 200)))
  const shot = name => page.screenshot({ path: join(EVID, `${name}.png`), fullPage: true })
  try {
    const targets = [['/optimizer', 'optimizer'], ['/aml', 'aml'], ['/ontology', 'ontology']]
    let allOk = true
    const detail = []
    const bodies = {}
    for (const [path, name] of targets) {
      const errsBefore = pageErrors.length
      await gotoReady(page, path, { wait: 2500 })
      await sleep(800)
      const bodyLen = await page.evaluate(() => (document.body.textContent ?? '').length)
      bodies[name] = await page.evaluate(() => document.body.textContent ?? '')
      const ok = pageErrors.length === errsBefore && bodyLen > 400
      detail.push(`${name}:len=${bodyLen},errs=${pageErrors.length - errsBefore}`)
      if (!ok) allOk = false
      await shot(`page-${name}`)
    }
    check('M6.1', '管理者三台(/optimizer /aml /ontology)渲染无错', allOk, detail.join(' '))
    // 数据异步加载:轮询等待关键文案(最多 10s),并切到 Profile tab
    const waitText = async (needle, timeoutMs = 10_000) => {
      const t0 = Date.now()
      while (Date.now() - t0 < timeoutMs) {
        const hit = await page.evaluate(n => (document.body.textContent ?? '').includes(n), needle)
        if (hit) return true
        await sleep(500)
      }
      return false
    }
    await gotoReady(page, '/optimizer', { wait: 2500 })
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find(b => (b.textContent || '').includes('Profile'))
      if (btn) btn.click()
    })
    await sleep(600)
    const profileDescVisible = await waitText('产线A 膜厚闭环')
    check('M6.3', 'UI:Profile 描述在 /optimizer 台账可见', profileDescVisible)
    await shot('page-optimizer-profile')

    await gotoReady(page, '/aml', { wait: 2500 })
    const amlDescVisible = await waitText('产线A 膜厚预测', 12_000)
    check('M6.4', 'UI:模型描述在 /aml 台账可见', amlDescVisible)
    await shot('page-aml-models')

    await gotoReady(page, '/ontology', { wait: 2500 })
    const ontoDescVisible = (await waitText('膜厚闭环控制本体', 6000)) || (await waitText('(产线 ln-', 4000))
    const fixBtnVisible = await page.evaluate(() => (document.body.textContent ?? '').includes('自动修复'))
    check('M6.5', 'UI:本体描述与「自动修复」入口在 /ontology 可见', ontoDescVisible && fixBtnVisible, `desc=${ontoDescVisible} fixBtn=${fixBtnVisible}`)
    await shot('page-ontology-desc')
    check('M6.2', '全程无未捕获 pageerror', pageErrors.length === 0 || pageErrors.every(e => e.includes('dispose')), pageErrors.slice(0, 2).join(';'))
  }
  finally {
    await browser.close().catch(() => {})
  }
}

// ════ 报告 ════
const pass = results.filter(r => r.pass).length
const report = {
  script: 'scripts/e2e-model-loop-live.mjs',
  generatedAt: new Date().toISOString(),
  base: BASE,
  home: HOME,
  ontology: ONT,
  profileId,
  sceneId: SCENE_ID,
  lineId: line.id,
  modelA: { id: trainedAId, artifactHash: trainedAHash },
  modelB: { id: trainedBId, artifactHash: trainedBHash },
  modelC: { id: trainedCId, artifactHash: trainedCHash },
  total: results.length,
  pass,
  fail: results.length - pass,
  results,
}
writeFileSync(join(EVID, 'report.json'), JSON.stringify(report, null, 2))
console.log(`\nMODEL-LOOP LIVE E2E: ${pass}/${results.length} passed, ${results.length - pass} failed`)
console.log(`evidence: ${EVID}`)
killTree(child.pid)
process.exit(results.some(r => !r.pass) ? 1 : 0)
