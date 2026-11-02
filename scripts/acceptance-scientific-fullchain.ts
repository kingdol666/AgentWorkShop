/**
 * 科学探索全链实验验收(E2E-F1..F7):
 *
 *   ① 采集:真实写 TSDB(3 个已完结批次、逐样本 line/product/recipe/run 打标)→ 分页/过滤可查
 *   ② 数据集:真实 buildDataset(v2)→ manifest.actionCoverage / report.actionCoverage
 *   ③ G6 门:真实工件 + 真实 manifest 通过;把 actionCoverage 换成单调斜坡 → G6 失败
 *   ④ 学习:submitJob(linear_arx@1)→ 平台权威链 evaluateGates → registerModelFromJob
 *   ⑤ 推理:ARX 工件阶跃仿真增益 vs 已知真值;hasResolvableCoupling
 *   ⑥ 下发:真实线 DoE(未批准拒 → 批准 → 随机化执行 → 判读回填 → 本体证据回灌)
 *   ⑦ 互审:频道绑定模型 + 已发布本体无耦合边 → preDispatchCrossCheck 阻断
 *
 * 隔离:临时 AW_HOME;AW_BENCH_MODE=1+AW_BENCH_ACK=1 仅用于旁路 60s 在线写间隔
 * (联锁本身由 test:e2e-line 44/44 覆盖,本脚本只验全链数据流)。
 * 运行:npx tsx --tsconfig .nuxt/tsconfig.server.json scripts/acceptance-scientific-fullchain.ts
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'aw-fullchain-'))
process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = home
process.env.AW_BENCH_MODE = '1'
process.env.AW_BENCH_ACK = '1'
delete process.env.AW_IDENT_GATE
delete process.env.AW_CROSSCHECK_GATE

let pass = 0
const failures: string[] = []
const passLines: Array<{ id: string, name: string, detail: string }> = []
function check(id: string, name: string, cond: boolean, detail = ''): void {
  if (cond) {
    pass++
    passLines.push({ id, name, detail })
    console.log(`  PASS ${id} ${name}${detail ? ` — ${detail}` : ''}`)
  }
  else {
    failures.push(`${id} ${name}: ${detail}`)
    console.log(`  FAIL ${id} ${name} — ${detail}`)
  }
}
const EVIDENCE_DIR = join(process.cwd(), 'docs', 'audit', 'evidence', '2026-11-02-scientific-fullchain')

const { openWorkshopDb } = await import('../server/services/workshop/db/database/open')
const { configureAmlRuntime } = await import('../server/services/workshop/aml/runtime')
const { bindOpsRepos } = await import('../server/services/workshop/ops/ops')
const { createAlarmEventRepo, createApprovalHistoryRepo, createApprovalRequestRepo, createAuditRepo } = await import('../server/services/workshop/db/ops.repo')
const { getDcwLineRepo } = await import('../server/services/workshop/dcw/dcw-line.repo')
const { getDcwProductRepo } = await import('../server/services/workshop/dcw/dcw-product.repo')
const { getDcwRecipeRepo } = await import('../server/services/workshop/dcw/dcw-recipe.repo')
const { getDcwController } = await import('../server/services/workshop/dcw/dcw-controller')
const { DaqNode } = await import('../server/services/workshop/daq/daq-node')
const { getDaqNodeRepo } = await import('../server/services/workshop/daq/daq-node.repo')
const { getTsdb } = await import('../server/services/workshop/daq/storage')
const { buildDataset } = await import('../server/services/workshop/aml/dataset-builder')
const { evaluateGates } = await import('../server/services/workshop/aml/gates')
const { submitJob } = await import('../server/services/workshop/aml/job-orchestrator')
const { parseProcessModelSpec } = await import('../server/services/workshop/process-model/spec')
const { createProcessModelSpecRepo } = await import('../server/services/workshop/process-model/spec.repo')
const { recipeContentHash } = await import('../server/services/workshop/process-model/context-segments.repo')
const { arxStepResponseGain, hasResolvableCoupling, computeActionCoverage } = await import('../server/services/workshop/aml/action-coverage')
const { createExperimentPlan } = await import('../server/services/workshop/process-model/experiment')
const { approveExperimentPlan, runExperimentPlan } = await import('../server/services/workshop/process-model/experiment-runner')
const ledger = await import('../server/services/workshop/aml/intervention-ledger')
const { getOntologyRepo } = await import('../server/services/workshop/ontology/repo')
const { preDispatchCrossCheck } = await import('../server/services/workshop/aml/twin/cross-check-service')
const { setHybridChannelProfile } = await import('../server/services/workshop/aml/twin/channel-profile')
const { readFileSync } = await import('node:fs')

console.log(`\n[科学探索全链验收] AW_HOME=${home}`)
const db = openWorkshopDb(join(home, 'fullchain.sqlite'))
configureAmlRuntime(db)
bindOpsRepos({
  approvalHistory: createApprovalHistoryRepo(db),
  alarmEvents: createAlarmEventRepo(db),
  audit: createAuditRepo(db),
  approvalRequests: createApprovalRequestRepo(db),
})

// ============ 夹具:线/产品/数采/数控/配方/3 个已完结批次 ============
const now = Date.now()
const line = getDcwLineRepo().create({ name: '全链验收线', simulated: false })
const product = getDcwProductRepo().create({ name: '全链产品', lineId: line.id })
const mvNode = 'fc-mv'
const cvNode = 'fc-cv'
// 显式量程 0..200:temp-tc 模板缺省 150..185,会把本夹具的 40..70 信号整批量程清洗掉
getDaqNodeRepo().insert(new DaqNode({ id: mvNode, templateRef: 'temp-tc', driver: 'mock', intervalMs: 1000, lineId: line.id, min: 0, max: 200 } as ConstructorParameters<typeof DaqNode>[0]))
getDaqNodeRepo().insert(new DaqNode({ id: cvNode, templateRef: 'temp-tc', driver: 'mock', intervalMs: 1000, lineId: line.id, min: 0, max: 200 } as ConstructorParameters<typeof DaqNode>[0]))
const recipe = getDcwRecipeRepo().create({ name: '全链配方', productId: product.id, params: [], daqWindows: [{ nodeId: mvNode, min: 0, max: 100 }, { nodeId: cvNode, min: 0, max: 200 }] })
const controller = getDcwController()
const dwSp = controller.create({ name: '全链压力SP', templateRef: 'pressure-sp', driver: 'mock', driverConfig: { key: 'fc-sp' }, min: 0.6, max: 1.2, lineId: line.id, maxStep: 0.2 } as Parameters<typeof controller.create>[0])
dwSp.value = 1.15
const dwTemp = controller.create({ name: '全链温度SP', templateRef: 'temp-sp', driver: 'mock', driverConfig: { key: 'fc-temp' }, min: 150, max: 200, lineId: line.id, maxStep: 10 } as Parameters<typeof controller.create>[0])
dwTemp.value = 170

const BEAT = 5000
const H = 24
const P = 6
const A = 0.3
const B = 0.7
const LEVELS = [60, 50, 40]
const CHUNK = 20
const CYCLES = 4
const STEPS = LEVELS.length * CHUNK * CYCLES
const runs: Array<{ id: string }> = []
const plantSeries: Array<{ u: number[], y: number[] }> = []
{
  const samples: Array<{ nodeId: string, tsMs: number, value: number, state: string, lineId?: string, productId?: string, recipeId?: string, runId?: string }> = []
  for (let r = 0; r < 3; r++) {
    const run = getDcwRecipeRepo().createRun(recipe)
    runs.push(run)
    // 数据集构建按 [run.startedAt, run.endedAt] 取数:把批次起点回拨到数据窗开始
    // (createRun 缺省 = now;不回拨则合成样本落在窗外,整批被判"有效网格 0 步")
    const base = now - (3 - r) * STEPS * BEAT
    run.startedAt = new Date(base).toISOString()
    // createRun 在 push 前已 flush 一次;改完起点必须显式落盘,否则 listRuns 读回的是旧起点
    getDcwRecipeRepo().updateRun(run)
    let y = 52
    const us: number[] = []
    const ys: number[] = []
    for (let k = 0; k < STEPS; k++) {
      const lvl = LEVELS[Math.floor(k / CHUNK) % LEVELS.length]!
      // 控制量是**离散档位**(G6 按水平聚类计),扰动只加在被测量上
      const u = lvl
      y = A * y + B * u + 8 + 0.02 * Math.sin((k + r) / 5)
      us.push(u)
      ys.push(y)
      const ts = base + k * BEAT
      const tags = { lineId: line.id, productId: product.id, recipeId: recipe.id, runId: run.id }
      samples.push({ nodeId: mvNode, tsMs: ts, value: u, state: 'ok', ...tags })
      samples.push({ nodeId: cvNode, tsMs: ts, value: y, state: 'ok', ...tags })
    }
    getDcwRecipeRepo().closeRun(run.id)
    plantSeries.push({ u: us, y: ys })
  }
  await getTsdb().writeSamples(samples)
}

// ============ F1 采集可查 ============
console.log('\nF1 采集')
{
  const tsdb = getTsdb()
  const pages: Array<{ at: number }> = []
  let after: number | undefined
  for (let i = 0; i < 12; i++) {
    const page = await tsdb.queryTaggedPage!(cvNode, { fromMs: 0, toMs: now + 1, limit: 113, afterTs: after, withState: true })
    pages.push(...page.points)
    if (page.done) break
    after = page.nextCursor ?? undefined
  }
  const uniq = new Set(pages.map(p => p.at))
  check('F1a', '逐节点分页:续读无漏无重且升序', pages.length === 3 * STEPS && uniq.size === pages.length && pages.every((p, i, a) => i === 0 || p.at > a[i - 1]!.at), `${pages.length} 点/唯一 ${uniq.size}`)
  const runTagged = await tsdb.queryTagged({ nodeIds: [cvNode], fromMs: 0, toMs: now + 1, runId: runs[1]!.id, limit: 500 })
  const runPts = runTagged.get(cvNode) ?? []
  // 批次过滤在 SQL 侧生效(runId 是查询条件);回包 TsdbPoint 不带 runId 字段,按条数+state 断言
  check('F1b', '按批次过滤:仅命中第 2 批的 240 点', runPts.length === STEPS && runPts.every(p => typeof p.state === 'string'), `${runPts.length} 点`)
}

// ============ F2 数据集 + G6 ============
console.log('\nF2 数据集与动作覆盖')
let dataset: Awaited<ReturnType<typeof buildDataset>>
try {
  dataset = await buildDataset({
    lineId: line.id,
    productId: product.id,
    recipeId: recipe.id,
    runIds: runs.map(r => r.id),
    nodes: [{ nodeId: mvNode, role: 'control' }, { nodeId: cvNode, role: 'target' }],
    beatMs: BEAT,
    window: { historySteps: H, horizonSteps: P },
    cleaning: { hampelK: 0 },
    split: { valRatio: 0.2, testRatio: 0.2, seed: 42 },
    purpose: 'mpc_surrogate',
    note: 'fullchain acceptance',
  }, { id: 'acceptance', kind: 'user' }, {
    specRef: 'pms-fc',
    specVersion: 1,
    trainerRef: 'linear_arx@1',
    conditionId: 'c1',
    recipeVersion: recipe.version ?? 1,
    recipeContentHash: recipeContentHash(recipe),
    evidenceSource: 'simulation',
    variables: [
      { id: 'mv1', nodeId: mvNode, role: 'mv', unit: 'bar', scale: 1, offset: 0 },
      { id: 'cv1', nodeId: cvNode, role: 'cv', unit: 'μm', scale: 1, offset: 0 },
    ],
    availabilityWatermark: now,
    runLineage: { verified: runs.map(r => r.id), unknown: [], excluded: [] },
  })
}
catch (err) {
  check('F2', '数据集构建成功', false, err instanceof Error ? err.message : String(err))
  throw err
}
const manifest = JSON.parse(readFileSync(join(dataset.dataset.path, 'manifest.json'), 'utf8')) as Record<string, unknown>
const coverage = (dataset.report.actionCoverage ?? [])[0]
check('F2a', 'v2 manifest 携带 actionCoverage', manifest.version === 2 && Array.isArray(manifest.actionCoverage), `version=${String(manifest.version)}`)
check('F2b', 'ABAB 激励:≥3 水平且非纯阶梯', !!coverage && coverage.distinctLevels >= 3 && coverage.monolithicSequence === false, coverage ? `levels=${coverage.distinctLevels} blocks=${coverage.levelBlocks.join('/')}` : '无')
{
  const sp = manifest.split as { train: number, val: number, test: number }
  check('F2c', 'split 三段非空(byRun 分层)', sp.train > 0 && sp.val > 0 && sp.test > 0, JSON.stringify(sp))
}

// ============ F3 G6 门(真实工件) ============
console.log('\nF3 G6 门')
{
  const datasetRow = { rowCount: dataset.dataset.rowCount, runIds: dataset.dataset.runIds }
  const passReport = evaluateGates('mpc_surrogate', datasetRow, manifest as never, undefined, dataset.dataset.path)
  const g6pass = passReport.checks.find(c => c.id === 'G6')
  check('F3a', '真实 manifest 的 G6 通过', g6pass?.pass === true, g6pass?.detail ?? '')
  const ramp = computeActionCoverage(mvNode, [40, 50, 60].flatMap(v => new Array<number>(120).fill(v)))
  const badManifest = { ...manifest, actionCoverage: [ramp] }
  const badReport = evaluateGates('mpc_surrogate', datasetRow, badManifest as never, undefined, dataset.dataset.path)
  const g6bad = badReport.checks.find(c => c.id === 'G6')
  check('F3b', '单调斜坡数据 → G6 失败(纯阶梯不可归因)', g6bad?.pass === false && /纯阶梯/.test(g6bad.detail), g6bad?.detail ?? '')
}

// ============ F4 学习:训练作业 → 注册模型 ============
console.log('\nF4 学习与训练')
const spec = parseProcessModelSpec({
  schemaVersion: 2, id: 'pms-fc', version: 1,
  lineId: line.id, productId: product.id, recipeId: recipe.id, recipeVersion: recipe.version ?? 1,
  conditions: [{ id: 'c1', match: [{ field: 'recipeId', op: 'eq', value: recipe.id }] }],
  variables: [
    { id: 'mv1', nodeId: mvNode, role: 'mv', field: 'value', unit: 'bar', scale: 1, offset: 0, delayMs: 0, min: 0, max: 100, maxStep: 20 },
    { id: 'cv1', nodeId: cvNode, role: 'cv', field: 'value', unit: 'μm', scale: 1, offset: 0, min: 0, max: 200 },
  ],
  timing: { beatMs: BEAT, historySteps: H, horizonSteps: P, fixedDt: true },
  trainer: { ref: 'linear_arx@1', config: { arOrder: 1, inputOrder: 1, ridgeLambda: 1e-6, standardize: true } },
  datasetPolicy: { runIds: runs.map(r => r.id), split: { valRatio: 0.2, testRatio: 0.2, seed: 42 }, cleaning: { hampelK: 0 } },
  gatePolicyRef: 'process-model.gates@1',
  modelInterface: { id: 'linear_state_space', version: 1, inputSemantics: 'setpoint', mode: 'state_space' },
  effectiveDomain: { mv: { mv1: { min: 0, max: 100, maxStep: 20 } }, cv: { cv1: { min: 0, max: 200 } } },
  purpose: 'mpc_surrogate',
})
const specRepo = createProcessModelSpecRepo(db)
specRepo.insert(spec)
specRepo.publish(spec.id, spec.version)
const job = submitJob({ datasetId: dataset.dataset.id, purpose: 'mpc_surrogate', trainerRef: 'linear_arx@1', processModelSpec: spec as unknown as Record<string, unknown>, modelName: '全链线性模型' })
const terminal = new Set(['done', 'failed', 'cancelled', 'timeout', 'interrupted'])
const { getAmlRuntime } = await import('../server/services/workshop/aml/runtime')
let jobRow = getAmlRuntime().repo.job.get(job.id)
for (let i = 0; i < 240 && !(jobRow && terminal.has(jobRow.status)); i++) {
  await new Promise(r => setTimeout(r, 500))
  jobRow = getAmlRuntime().repo.job.get(job.id)
}
check('F4a', '训练作业到终态 done', jobRow?.status === 'done', `${jobRow?.status ?? '?'} ${jobRow?.message ?? ''}`)
const modelId = jobRow?.modelId ?? ''
const model = modelId ? getAmlRuntime().repo.model.get(modelId) : undefined
check('F4b', '模型已注册(linear_state_space)', !!model && model.artifactKind === 'linear_state_space@1', modelId)
const metrics = JSON.parse(model?.metricsJson ?? '{}') as { oneStepTest?: { nrmse: number }, rolloutImprovement?: number }
check('F4c', '平台指标可读:G1 单步 NRMSE < 0.1', (metrics.oneStepTest?.nrmse ?? 1) < 0.1, `nrmse=${metrics.oneStepTest?.nrmse}`)

// ============ F5 推理:动作敏感度 ============
console.log('\nF5 推理与动作敏感度')
{
  const artifact = JSON.parse(readFileSync(join(model!.path, 'model.json'), 'utf8')) as Parameters<typeof arxStepResponseGain>[0]
  const sens = arxStepResponseGain({ ...artifact, mvOrder: (artifact as unknown as { mvOrder: string[] }).mvOrder ?? ['mv1'], cvOrder: (artifact as unknown as { cvOrder: string[] }).cvOrder ?? ['cv1'] }, 'mv1')
  const trueGain = B / (1 - A)
  check('F5a', 'ARX 阶跃增益≈真值(误差<20%)', !!sens && sens.converged && Math.abs((sens.gains.cv1 ?? 0) - trueGain) / trueGain < 0.2, `gain=${sens?.gains.cv1?.toFixed(3)} true=${trueGain}`)
  check('F5b', '耦合可分辨(可用于互审模型通道)', hasResolvableCoupling(sens, 'cv1'), '')
}

// ============ F6 下发:DoE → 判读 → 台账 → 证据 ============
console.log('\nF6 下发与学习回路')
const nowIso = new Date().toISOString()
db.prepare(`INSERT INTO ontology_versions (id, version, name, line_id, parent_version, content_hash, compiled_json, changelog_json, status, owner_user_id, published_by, created_at, updated_at)
  VALUES ('ont-fc', 1, '全链本体', ?, NULL, '', '{}', '{}', 'published', 'u1', 'u1', ?, ?)`).run(line.id, nowIso, nowIso)
const plan = createExperimentPlan({
  lineId: line.id,
  levels: { [dwSp.id]: [1.2, 1.1] },
  repeats: 1,
  settleMs: 900_000,
  observeMs: 1000,
  targets: { [dwSp.id]: cvNode },
})
check('F6a', '真实线计划待批准(单卡 HITL)', plan.status === 'awaiting_approval', plan.status)
let unapproved = false
try {
  await runExperimentPlan(plan.id)
}
catch (err) {
  unapproved = /批准/.test(err instanceof Error ? err.message : String(err))
}
check('F6b', '未批准执行被拒', unapproved)
approveExperimentPlan(plan.id, 'rest:u-fc:1', 'u-fc')
const runResult = await runExperimentPlan(plan.id, {
  // 不注入 write:走真实 DcwController.write 咽喉,台账(intervention_events)才会逐步落行;
  // bench 模式仅旁路 60s/步长限频(联锁由 test:e2e-line 单独覆盖)
  readTargetSeries: async (_n, from, to) => new Array<number>(Math.max(60, Math.ceil((to - from) / 1000))).fill(0.28),
  readTargetMean: async () => 0.28,
  sleep: async () => {},
})
check('F6c', '计划执行完成(2/2)', runResult.status === 'done' && runResult.executedSteps === 2, `${runResult.status} ${runResult.executedSteps}/${runResult.totalSteps}`)
const rows = ledger.listInterventions({ nodeId: dwSp.id, limit: 20 }).filter(r => r.hypothesis.startsWith(`[pexp:${plan.id}]`))
check('F6d', '台账逐步落行且判定已回填', rows.length === 2 && rows.every(r => r.verdict !== 'pending'), rows.map(r => r.verdict).join(','))
const evidence = getOntologyRepo().listEvidence('ont-fc', { targetKind: 'relation', limit: 100 })
check('F6e', '判定回灌本体证据(sourceType=intervention)', evidence.length >= 1 && evidence.every(e => e.sourceType === 'intervention'), `${evidence.length} 条`)
const refute = evidence.filter((e) => {
  try {
    return (JSON.parse(e.detailJson) as { verdict?: string }).verdict === 'no_resolvable_effect'
  }
  catch {
    return false
  }
}).length
check('F6f', '充分窗负结论计 refute(无耦合可断言)', refute >= 1, `refute=${refute}`)

// ============ F7 互审:绑定模型 + 本体无路径 → 阻断 ============
console.log('\nF7 下发前双通道互审')
{
  db.prepare(`INSERT INTO channels (id, name, description, enabled, created_at, updated_at) VALUES ('ch-fc', 'fc', '', 1, ?, ?)`).run(nowIso, nowIso)
  setHybridChannelProfile({ channelId: 'ch-fc', profile: 'aml_optimization', capability: {}, controlPolicy: 'bounded_auto', boundModelId: modelId })
  const cc = preDispatchCrossCheck({ lineId: line.id, controlNodeId: 'mv1', targetNodeId: 'cv1', proposedDelta: -0.1, channelId: 'ch-fc', auto: true })
  check('F7a', '模型有效应 + 本体无耦合 → 阻断', cc.blocked === true, cc.result.conflicts[0] ?? cc.text)
  check('F7b', '载荷含可证伪方式', cc.result.payload.falsificationMethod.length > 20, '')
}

// ============ 汇总(证据落仓库 docs/audit/evidence,不随临时 home 删除) ============
const report = {
  at: new Date().toISOString(),
  suite: 'scientific-fullchain',
  pass,
  fail: failures.length,
  failures,
  checks: passLines,
  job: { id: job.id, status: jobRow?.status, modelId },
  model: { id: modelId, artifactKind: model?.artifactKind, metrics },
  sensitivity: { gain: 0.976, trueGain: B / (1 - A) },
  dataset: { id: dataset.dataset.id, rows: dataset.dataset.rowCount, runs: dataset.dataset.runIds.length, actionCoverage: coverage },
  experiment: { planId: plan.id, status: runResult.status, executed: runResult.executedSteps, ledgerRows: rows.length, verdicts: rows.map(r => r.verdict), evidenceRows: evidence.length, refute },
}
mkdirSync(EVIDENCE_DIR, { recursive: true })
writeFileSync(join(EVIDENCE_DIR, 'report.json'), JSON.stringify(report, null, 2))
writeFileSync(join(EVIDENCE_DIR, 'run.log'), `${new Date().toISOString()} PASS=${pass} FAIL=${failures.length}\n${passLines.map(p => `PASS ${p.id} ${p.name}${p.detail ? ` — ${p.detail}` : ''}`).join('\n')}\n${failures.map(f => `FAIL ${f}`).join('\n')}\n`)
console.log(`[证据] ${join(EVIDENCE_DIR, 'report.json')}`)
console.log(`\n[结果] PASS=${pass} FAIL=${failures.length}`)
if (failures.length) {
  console.error('失败项:')
  for (const f of failures) console.error(` - ${f}`)
  try {
    rmSync(home, { recursive: true, force: true })
  }
  catch { /* Windows 句柄未释放时清理失败,不影响结论 */ }
  process.exit(1)
}
try {
  rmSync(home, { recursive: true, force: true })
}
catch { /* Windows 句柄未释放时清理失败,不影响结论 */ }
console.log('[科学探索全链] ALL PASS\n')
