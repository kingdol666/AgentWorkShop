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
 * 诚实边界(审查后明确):
 *  - 设备层是 **mock 驱动**,被控对象的响应由夹具序列注入(不是物理产线);
 *    本脚本证明的是**平台链路的接线与治理**,不是真实工艺响应;
 *  - F6 的 `no_resolvable_effect` 是对"注入的恒定响应序列"的引擎判定,
 *    用来说明"负结论可被判读并回灌",**不等于**证明该产线无耦合;
 *  - AW_BENCH_MODE=1+AW_BENCH_ACK=1 仅旁路 60s/步长限频(联锁由 test:e2e-line 44/44 覆盖)。
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
// 必须走真实内置训练器:stub 会伪造工件,本脚本的证据将失去意义
delete process.env.AML_STUB

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
const { approveExperimentPlan, runExperimentPlan, buildExperimentSteps, parsePlan } = await import('../server/services/workshop/process-model/experiment-runner')
const ledger = await import('../server/services/workshop/aml/intervention-ledger')
const { getOntologyRepo } = await import('../server/services/workshop/ontology/repo')
const { preDispatchCrossCheck } = await import('../server/services/workshop/aml/twin/cross-check-service')
const { setHybridChannelProfile } = await import('../server/services/workshop/aml/twin/channel-profile')
const { readFileSync, existsSync } = await import('node:fs')

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
const manifestCoverage = (manifest.actionCoverage as Array<{ distinctLevels: number }> | undefined) ?? []
check('F2a', 'v2 manifest 携带非空 actionCoverage', manifest.version === 2 && manifestCoverage.length === 1, `version=${String(manifest.version)} n=${manifestCoverage.length}`)
check('F2b', 'ABAB 激励:恰好 3 水平且非纯阶梯', !!coverage && coverage.distinctLevels === 3 && coverage.monolithicSequence === false, coverage ? `levels=${coverage.distinctLevels} blocks=${coverage.levelBlocks.join('/')}` : '无')
{
  const sp = manifest.split as { train: number, val: number, test: number, trainRunIds: string[], valRunIds: string[], testRunIds: string[] }
  const sets = [sp.trainRunIds, sp.valRunIds, sp.testRunIds]
  const disjoint = sets[0]!.length === 1 && sets[1]!.length === 1 && sets[2]!.length === 1
    && new Set([...sets[0]!, ...sets[1]!, ...sets[2]!]).size === 3
  check('F2c', 'byRun 三段各 211 窗口且 run 互斥', sp.train === 211 && sp.val === 211 && sp.test === 211 && disjoint, JSON.stringify({ train: sp.train, val: sp.val, test: sp.test, runs: sets.map(s => s.length) }))
}

// ============ F3 G6 门(真实工件) ============
console.log('\nF3 G6 门')
{
  const datasetRow = { rowCount: dataset.dataset.rowCount, runIds: dataset.dataset.runIds }
  const passReport = evaluateGates('mpc_surrogate', datasetRow, manifest as never, undefined, dataset.dataset.path)
  const g6pass = passReport.checks.find(c => c.id === 'G6')
  check('F3a', '真实 manifest 的 G6 通过(非"不适用"分支)', g6pass?.pass === true && /3 个水平/.test(g6pass.detail) && /\|r\|=0\.0/.test(g6pass.detail), g6pass?.detail ?? '')
  // 负例:用真实 computeActionCoverage 生成单调斜坡,替换**manifest 副本**后送同一条真实 gate 链
  // (不是 builder 产出的 ramp 数据集 —— 该路径由 tests/action-coverage-g6.test.ts 覆盖)
  const ramp = computeActionCoverage(mvNode, [40, 50, 60].flatMap(v => new Array<number>(120).fill(v)))
  const badManifest = { ...manifest, actionCoverage: [ramp] }
  const badReport = evaluateGates('mpc_surrogate', datasetRow, badManifest as never, undefined, dataset.dataset.path)
  const g6bad = badReport.checks.find(c => c.id === 'G6')
  check('F3b', '单调斜坡 → G6 失败(共线+纯阶梯双理由)', g6bad?.pass === false && /共线/.test(g6bad.detail) && /纯阶梯/.test(g6bad.detail), g6bad?.detail ?? '')
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
check('F4b', '模型已注册(linear_state_space,非 stub)', !!model && model.artifactKind === 'linear_state_space@1' && !existsSync(join(model.path, 'STUB')), modelId)
const metrics = JSON.parse(model?.metricsJson ?? '{}') as { oneStepTest?: { nrmse: number }, rolloutImprovement?: number }
check('F4c', '平台指标可读:G1 单步 NRMSE < 0.1', (metrics.oneStepTest?.nrmse ?? 1) < 0.1, `nrmse=${metrics.oneStepTest?.nrmse}`)

// ============ F5 推理:动作敏感度 ============
console.log('\nF5 推理与动作敏感度')
const trueGain = B / (1 - A)
let measuredGain: number | undefined
{
  const artifact = JSON.parse(readFileSync(join(model!.path, 'model.json'), 'utf8')) as Parameters<typeof arxStepResponseGain>[0]
  const sens = arxStepResponseGain({ ...artifact, mvOrder: (artifact as unknown as { mvOrder: string[] }).mvOrder ?? ['mv1'], cvOrder: (artifact as unknown as { cvOrder: string[] }).cvOrder ?? ['cv1'] }, 'mv1')
  measuredGain = sens?.gains.cv1 ?? Number.NaN
  check('F5a', 'ARX 阶跃增益≈真值(误差<20%)', !!sens && sens.converged && Math.abs(measuredGain - trueGain) / trueGain < 0.2, `gain=${measuredGain.toFixed(3)} true=${trueGain}`)
  check('F5b', '耦合可分辨(模型通道有非零增益)', hasResolvableCoupling(sens, 'cv1'), `gain=${measuredGain.toFixed(3)}`)
}

// ============ F6 下发:DoE → 判读 → 台账 → 证据 ============
console.log('\nF6 下发与学习回路(mock 设备;目标响应由夹具注入)')
const nowIso = new Date().toISOString()
// 夹具说明:直接插一条已发布本体(无 coupling 边)。draft→approve→publish 全链由
// e2e-ontology / e2e-ontology-live 套件覆盖;此处只需要"已发布且无该边"这个输入状态。
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
  const e = err as { code?: string, message?: string }
  unapproved = e.code === 'EXPERIMENT_APPROVAL_REQUIRED'
}
check('F6b', '未批准执行被拒(错误码 EXPERIMENT_APPROVAL_REQUIRED)', unapproved, unapproved ? 'EXPERIMENT_APPROVAL_REQUIRED' : '未命中错误码')
approveExperimentPlan(plan.id, 'rest:u-fc:1', 'u-fc')
const runResult = await runExperimentPlan(plan.id, {
  // 不注入 write:走真实 DcwController.write 咽喉,台账(intervention_events)才会逐步落行;
  // bench 模式仅旁路 60s/步长限频(联锁由 test:e2e-line 单独覆盖)
  readTargetSeries: async (_n, from, to) => new Array<number>(Math.max(60, Math.ceil((to - from) / 1000))).fill(0.28),
  readTargetMean: async () => 0.28,
  sleep: async () => {},
})
check('F6c', '计划执行完成(2/2)', runResult.status === 'done' && runResult.executedSteps === 2, `${runResult.status} ${runResult.executedSteps}/${runResult.totalSteps}`)
// 设备层回读:随机化步序的**最后一步设定**必须真实写到节点(证明不是只落了台账)
const lastStep = buildExperimentSteps(parsePlan(plan), plan.id).at(-1)!
const nodeValue = Number(getDcwController().byId(dwSp.id)?.value ?? Number.NaN)
check('F6c2', '末步设定真实落到节点(随机序回读)', Math.abs(nodeValue - lastStep.level) < 1e-9, `value=${nodeValue} lastLevel=${lastStep.level}`)
const rows = ledger.listInterventions({ nodeId: dwSp.id, limit: 20 }).filter(r => r.hypothesis.startsWith(`[pexp:${plan.id}]`))
const verdicts = rows.map(r => r.verdict).sort()
check('F6d', '台账 2 行且判定精确为 no_resolvable_effect×2', verdicts.length === 2 && verdicts[0] === 'no_resolvable_effect' && verdicts[1] === 'no_resolvable_effect', verdicts.join(','))
const evidence = getOntologyRepo().listEvidence('ont-fc', { targetKind: 'relation', limit: 100 })
check('F6e', '判定回灌本体证据恰 2 条(sourceType=intervention)', evidence.length === 2 && evidence.every(e => e.sourceType === 'intervention'), `${evidence.length} 条`)
const refute = evidence.filter((e) => {
  try {
    return (JSON.parse(e.detailJson) as { verdict?: string }).verdict === 'no_resolvable_effect'
  }
  catch {
    return false
  }
}).length
// 诚实口径:响应是夹具注入的恒定序列 → 引擎判"无可分辨效应"并计 refute。
// 证明的是"负结论能被判读并回灌",不等于证明该产线无耦合。
check('F6f', '注入恒定响应下的负结论按 refute 回灌(refute=2)', refute === 2, `refute=${refute}`)

// ============ F7 互审:绑定模型 + 本体无路径 → 阻断 ============
console.log('\nF7 下发前双通道互审')
{
  db.prepare(`INSERT INTO channels (id, name, description, enabled, created_at, updated_at) VALUES ('ch-fc', 'fc', '', 1, ?, ?)`).run(nowIso, nowIso)
  setHybridChannelProfile({ channelId: 'ch-fc', profile: 'aml_optimization', capability: {}, controlPolicy: 'bounded_auto', boundModelId: modelId })
  const cc = preDispatchCrossCheck({ lineId: line.id, controlNodeId: 'mv1', targetNodeId: 'cv1', proposedDelta: -0.1, channelId: 'ch-fc', auto: true })
  check('F7a', '模型有效应 + 本体无耦合 → 阻断(冲突含双方证据)', cc.blocked === true && cc.result.conflicts.some(c => /模型预测有效应/.test(c) && /无耦合路径/.test(c)), cc.result.conflicts[0] ?? cc.text)
  const fm = cc.result.payload.falsificationMethod
  check('F7b', '可证伪方式点名控制量/目标量', fm.includes('mv1') && fm.includes('cv1') && /MDE/.test(fm), fm.slice(0, 80))
}

// ============ 汇总(证据落仓库 docs/audit/evidence,不随临时 home 删除) ============
// 作业预算在 repo 层可能已是对象、也可能是 JSON 串(不同调用路径),两种都吃
function budgetTrainerRef(budget: unknown): string | null {
  try {
    const obj = typeof budget === 'string' ? JSON.parse(budget) as Record<string, unknown> : budget as Record<string, unknown> | undefined
    const ref = obj?.trainerRef
    return typeof ref === 'string' ? ref : null
  }
  catch {
    return null
  }
}
const report = {
  at: new Date().toISOString(),
  suite: 'scientific-fullchain',
  // 诚实边界:设备层 mock;F6 的目标响应为夹具注入,负结论证明"可判读+可回灌",
  // 不构成"该产线无耦合"的证据。
  scope: { deviceLayer: 'mock', dofResponse: 'injected-fixture', realPlantRun: false, tsdbBackend: 'sqlite-emulated' },
  pass,
  fail: failures.length,
  failures,
  checks: passLines,
  job: { id: job.id, status: jobRow?.status, modelId, trainerRef: budgetTrainerRef(jobRow?.budget) },
  model: { id: modelId, artifactKind: model?.artifactKind, metrics },
  sensitivity: { gain: measuredGain, trueGain },
  dataset: { id: dataset.dataset.id, rows: dataset.dataset.rowCount, runs: dataset.dataset.runIds.length, actionCoverage: coverage },
  experiment: { planId: plan.id, status: runResult.status, executed: runResult.executedSteps, ledgerRows: rows.length, verdicts: rows.map(r => r.verdict), evidenceRows: evidence.length, refute, nodeReadback: getDcwController().byId(dwSp.id)?.value },
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
