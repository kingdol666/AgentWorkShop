/**
 * 科学探索闭环验收(E2E-1..4,docs/plans/2026-11-02-scientific-exploration-acceptance.md):
 *
 *  正交 DoE 计划(真实线分级 → HITL 批准 → 随机化步序)
 *    → 每步经 DCW 写咽喉真实落 intervention_events
 *    → 引擎判读(UNDERPOWERED/负结论/有效应)回填台账
 *    → 判定回灌 ontology_evidence(support/refute 计数)
 *    → 通道 B 解析"明确无耦合" + 模型通道"有效应" → 互审拒绝
 *    → G6:事故型数据集 FAIL / 正交型 PASS
 *
 * 隔离:临时 AW_HOME + 临时 sqlite;AW_BENCH_MODE=1 旁路 60s 在线写间隔(仅验收加速,
 * 生产模式恒不旁路);所有副作用在临时目录,进程退出即丢弃。
 * 运行:npx tsx --tsconfig .nuxt/tsconfig.server.json scripts/acceptance-scientific-loop.ts
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'aw-sci-e2e-'))
process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = home
process.env.AW_BENCH_MODE = '1'
process.env.AW_BENCH_ACK = '1'
delete process.env.AW_IDENT_GATE

let pass = 0
let fail = 0
const failures: string[] = []
function check(id: string, name: string, cond: boolean, detail: string): void {
  if (cond) {
    pass++
    console.log(`  PASS ${id} ${name}${detail ? ` — ${detail}` : ''}`)
  }
  else {
    fail++
    failures.push(`${id} ${name}: ${detail}`)
    console.log(`  FAIL ${id} ${name} — ${detail}`)
  }
}

const { openWorkshopDb } = await import('../server/services/workshop/db/database/open')
const { configureAmlRuntime } = await import('../server/services/workshop/aml/runtime')
const { bindOpsRepos } = await import('../server/services/workshop/ops/ops')
const { createAlarmEventRepo, createApprovalHistoryRepo, createApprovalRequestRepo, createAuditRepo } = await import('../server/services/workshop/db/ops.repo')
const { getDcwLineRepo } = await import('../server/services/workshop/dcw/dcw-line.repo')
const { getDcwController } = await import('../server/services/workshop/dcw/dcw-controller')
const { createExperimentPlan } = await import('../server/services/workshop/process-model/experiment')
const { approveExperimentPlan, runExperimentPlan, parsePlan } = await import('../server/services/workshop/process-model/experiment-runner')
const ledger = await import('../server/services/workshop/aml/intervention-ledger')
const learning = await import('../server/services/workshop/aml/ontology-learning')
const { evaluateCrossCheck } = await import('../server/services/workshop/aml/twin/cross-check')
const { computeActionCoverage, assessDatasetActionCoverage } = await import('../server/services/workshop/aml/action-coverage')
const { getOntologyRepo } = await import('../server/services/workshop/ontology/repo')

console.log(`\n[科学探索闭环验收] AW_HOME=${home}`)
const db = openWorkshopDb(join(home, 'sci-loop.sqlite'))
configureAmlRuntime(db)
bindOpsRepos({
  approvalHistory: createApprovalHistoryRepo(db),
  alarmEvents: createAlarmEventRepo(db),
  audit: createAuditRepo(db),
  approvalRequests: createApprovalRequestRepo(db),
})

// ---------- 夹具:真实线 + 两个 mock 数控节点 + 已发布本体 ----------
const line = getDcwLineRepo().create({ name: '科学闭环验收线', simulated: false })
const controller = getDcwController()
const sp = controller.create({ name: '验收·熔体压力SP', templateRef: 'pressure-sp', driver: 'mock', driverConfig: { key: 'sci-sp' }, min: 0.6, max: 1.2, unit: 'MPa', decimals: 2, lineId: line.id, maxStep: 0.2 } as Parameters<typeof controller.create>[0])
const sp2 = controller.create({ name: '验收·熔体温度SP', templateRef: 'temp-sp', driver: 'mock', driverConfig: { key: 'sci-hold' }, min: 150, max: 200, unit: '℃', decimals: 1, lineId: line.id, maxStep: 10 } as Parameters<typeof controller.create>[0])
const nowIso = new Date().toISOString()
db.prepare(`INSERT INTO ontology_versions (id, version, name, line_id, parent_version, content_hash, compiled_json, changelog_json, status, owner_user_id, published_by, created_at, updated_at)
  VALUES ('ont-sci', 1, '科学闭环本体', ?, NULL, '', '{}', '{}', 'published', 'u1', 'u1', ?, ?)`).run(line.id, nowIso, nowIso)

// 目标响应:壁厚 = 0.28 + 4.71min 振荡 + 噪声(与控制量无耦合 —— 事故形态的"真无耦合"世界)
const periodBeats = 4.71 * 60
let tick = 0
function series(beats: number): number[] {
  const out: number[] = []
  for (let i = 0; i < beats; i++) {
    tick++
    // 单一主导振荡 + 微噪声(与事故一致;不加高频纹波,避免把"局部纹波 vs 全局周期"混进来)
    out.push(0.28 + 0.05 * Math.sin((2 * Math.PI * tick) / periodBeats) + 0.0008 * Math.sin(tick * 2.3))
  }
  return out
}
const targetId = 'daq-sci-thickness'
/** 按请求窗长生成拍数(生产语义:读多长窗就得多少拍) */
const beatsOf = (from: number, to: number): number => Math.max(60, Math.ceil((to - from) / 1000))
/** Leg A(事故形态):按窗长生成 282 拍周期振荡 —— 长历史能估出周期,短窗只能判欠功效 */
const readSeriesShort = async (_node: string, from: number, to: number) => series(beatsOf(from, to))
/** Leg B(充分窗负结论):恒定目标无效应 → 应判"无可分辨效应"并产生 refute 证据 */
const readSeriesLong = async (_node: string, from: number, to: number) => new Array<number>(beatsOf(from, to)).fill(0.28)

// ---------- E2E-1 真实线计划:创建 → 成本 → 批准 → 正交执行 ----------
console.log('\nE2E-1 真实线 DoE 分级与执行')
const plan = createExperimentPlan({
  lineId: line.id,
  levels: { [sp.id]: [1.2, 1.1, 1.0], [sp2.id]: [170, 180] },
  repeats: 2,
  settleMs: 1000,
  observeMs: 1000,
  targets: { [sp.id]: targetId, [sp2.id]: targetId },
  dominantPeriodMs: 4.71 * 60_000,
})
const body = parsePlan(plan)
check('E2E-1a', '真实线计划创建即待批准', plan.status === 'awaiting_approval', `status=${plan.status}`)
check('E2E-1b', '成本核算含 3×主导周期与预计总时长', !!body.cost?.suggestedWindowMs && /3×主导周期/.test(body.cost!.summary), body.cost?.summary ?? '(无)')
check('E2E-1c', '步数 = (3+2)×2 = 10', body.cost?.steps === 10, `steps=${body.cost?.steps}`)

let rejected = false
try {
  await runExperimentPlan(plan.id)
}
catch (err) {
  rejected = /批准/.test(err instanceof Error ? err.message : String(err))
}
check('E2E-1d', '未批准执行被拒(HITL 是硬门)', rejected)

const approved = approveExperimentPlan(plan.id, 'rest:u-accept:1', 'u-accept')
check('E2E-1e', '人工批准后转 planned 并留痕', approved.status === 'planned' && parsePlan(approved).approvalId === 'rest:u-accept:1')

const result = await runExperimentPlan(plan.id, { readTargetSeries: readSeriesShort, readTargetMean: async () => 0.28, sleep: async () => {} })
check('E2E-1f', '计划执行完成(10/10 步)', result.status === 'done' && result.executedSteps === 10 && result.totalSteps === 10, `${result.status} ${result.executedSteps}/${result.totalSteps} ${result.failedReason ?? ''}`)

// 充分窗负结论(leg B):900 拍窗 + 恒定目标 → no_resolvable_effect → refute 证据
const planB = createExperimentPlan({
  lineId: line.id,
  levels: { [sp.id]: [1.2, 1.1] },
  repeats: 1,
  settleMs: 900_000,
  observeMs: 1,
  targets: { [sp.id]: targetId },
})
approveExperimentPlan(planB.id, 'rest:u-accept:2', 'u-accept')
const resultB = await runExperimentPlan(planB.id, { readTargetSeries: readSeriesLong, readTargetMean: async () => 0.28, sleep: async () => {} })
check('E2E-1g', '充分窗计划执行完成', resultB.status === 'done' && resultB.executedSteps === 2, `${resultB.status} ${resultB.executedSteps}/2 ${resultB.failedReason ?? ''}`)
for (const r of ledger.listInterventions({ nodeId: sp.id, limit: 50 }).filter(x => x.verdict === 'identifiable_effect')) {
  console.log(`  [诊断] ${r.hypothesis.slice(0, 40)} verdict=${r.verdict} effect=${r.effect} mde=${r.mde} detail=${JSON.stringify(r.verdictDetail?.reasons ?? [])}`)
}

// ---------- E2E-2 台账逐步落行 + 判定回填 + 证据回灌 ----------
console.log('\nE2E-2 台账 → 判定 → 本体证据')
for (const nodeId of [sp.id, sp2.id]) {
  const rows = ledger.listInterventions({ nodeId, limit: 50 }).filter(r => r.hypothesis.startsWith(`[pexp:${plan.id}]`))
  check('E2E-2a', `${nodeId} 台账逐步落行`, rows.length >= 2, `${rows.length} 行`)
  check('E2E-2b', `${nodeId} 判定已回填(非 pending)`, rows.every(r => r.verdict !== 'pending'), rows.map(r => r.verdict).join(','))
}
const evidence = getOntologyRepo().listEvidence('ont-sci', { targetKind: 'relation', limit: 200 })
check('E2E-2c', '判定回灌 ontology_evidence(sourceType=intervention)', evidence.length > 0 && evidence.every(e => e.sourceType === 'intervention'), `${evidence.length} 条`)
const verdictOf = (detailJson: string): string | undefined => {
  try {
    return (JSON.parse(detailJson) as { verdict?: string }).verdict
  }
  catch {
    return undefined
  }
}
const verdicts = evidence.map(e => verdictOf(e.detailJson))
const spurious = verdicts.filter(v => v === 'identifiable_effect').length
const refutes = verdicts.filter(v => v === 'no_resolvable_effect').length
const underpowered = verdicts.filter(v => v === 'underpowered').length
// 事故形态(短窗)下正确结论是"欠功效";声称有效应 = 假阳性,必须为 0
check('E2E-2d', '短窗步骤不得声称有效应(假阳性=0)', spurious === 0, `identifiable_effect=${spurious}, underpowered=${underpowered}`)
// 充分窗负结论必须落成 refute 证据(可证伪的一等事实)
check('E2E-2e', '充分窗负结论计 refute(无耦合可断言)', refutes > 0, `refute=${refutes}`)

// ---------- E2E-3 通道 B 用回灌证据 + 模型通道冲突 → 拒绝 ----------
console.log('\nE2E-3 互审:本体明确无耦合 vs 模型有效应')
const coupling = learning.resolveCouplingFromOntology(line.id, sp.id, targetId)
check('E2E-3a', '本体无该耦合边 → 明确无路径(false)', coupling.hasCouplingPath === false, JSON.stringify({ has: coupling.hasCouplingPath, refute: coupling.refuteCount }))
const withEffect = { A: [[0.5, 0.3], [0, 0]], B: [[0], [1]], C: [[1, 0]], D: [[0]], mvOrder: [sp.id], cvOrder: [targetId] }
const cross = evaluateCrossCheck({
  controlNodeId: sp.id, targetNodeId: targetId, proposedDelta: -0.2, auto: true,
  model: { artifact: withEffect, targetNodeId: targetId },
  ontology: { hasCouplingPath: coupling.hasCouplingPath, evidence: coupling.evidence },
  identifiability: { verdict: 'UNDERPOWERED', mde: 0.003 },
})
check('E2E-3b', '自动模式拒绝且理由含"模型有效应"+"无耦合路径"', cross.decision === 'reject' && cross.conflicts.some(c => /模型预测有效应/.test(c) && /无耦合路径/.test(c)), cross.conflicts.join(' | '))
check('E2E-3c', '科学载荷带 MDE 与可证伪方式', cross.payload.mde === 0.003 && cross.payload.falsificationMethod.length > 20)

// ---------- E2E-4 G6 动作覆盖门 ----------
console.log('\nE2E-4 G6:事故型数据集 vs 正交数据集')
const incident = computeActionCoverage(sp.id, Array.from({ length: 600 }, (_, i) => (i < 300 ? 2.6 : 2.4)))
const orthogonal = computeActionCoverage(sp.id, [2.6, 2.5, 2.4, 2.5, 2.6, 2.5, 2.4].flatMap(v => new Array<number>(80).fill(v)))
const t = { minControlLevels: 3, maxCollinearity: 0.9 }
check('E2E-4a', '事故型(2 水平纯阶梯)G6 不通过', assessDatasetActionCoverage([incident], t).pass === false, incident.monolithicSequence ? 'monolithic' : '')
check('E2E-4b', '正交 ABAB(3 档往返)G6 通过', assessDatasetActionCoverage([orthogonal], t).pass === true, `levels=${orthogonal.distinctLevels} blocks=${orthogonal.levelBlocks.join('/')}`)

// ---------- 汇总 ----------
const outDir = join(home, 'evidence')
mkdirSync(outDir, { recursive: true })
const summary = {
  at: new Date().toISOString(),
  planId: plan.id,
  lineId: line.id,
  pass,
  fail,
  failures,
  run: result,
  evidenceRows: evidence.length,
  refutes,
  coupling: { hasCouplingPath: coupling.hasCouplingPath, refuteCount: coupling.refuteCount },
  crossCheck: { decision: cross.decision, conflicts: cross.conflicts },
  g6: { incident: assessDatasetActionCoverage([incident], t).pass, orthogonal: assessDatasetActionCoverage([orthogonal], t).pass },
}
writeFileSync(join(outDir, 'scientific-loop-report.json'), JSON.stringify(summary, null, 2))
console.log(`\n[结果] pass=${pass} fail=${fail}`)
console.log(`[证据] ${join(outDir, 'scientific-loop-report.json')}`)
if (fail > 0) {
  console.error('失败项:')
  for (const f of failures) console.error(` - ${f}`)
  // Windows 下 sqlite 句柄未释放时删目录会 EPERM:清理失败不影响验收结论
  try {
    rmSync(home, { recursive: true, force: true })
  }
  catch { console.error(`[提示] 临时目录未清理:${home}`) }
  process.exit(1)
}
try {
  rmSync(home, { recursive: true, force: true })
}
catch { console.log(`[提示] 临时目录未清理:${home}`) }
console.log('[科学探索闭环] ALL PASS\n')
