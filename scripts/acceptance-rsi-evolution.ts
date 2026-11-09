/**
 * RSI 自进化全链验收（Phase A：真库 · 真函数 · 零 mock 逻辑替换）
 *
 * 目标：证明「Agent 学会 → 总结 → 审批晋级 → 注入下一轮 → 跨频道互学」这条链
 * 在**平台真实代码路径**上闭合（不是各模块孤立单测）。
 *
 * 链路（与运行时调用同一批函数）：
 *   ① 任务终态 → collectTaskFact（读 tasks/artifacts/project_results）→ reflectExperience → 经验条目
 *   ② 证据门：单任务样本 → 拒绝晋级（fail-closed）
 *   ③ 多任务证据 → 晋级 validated（人工/门）
 *   ④ Harness Profile pins 该经验 → activate → channelOverlayText（= BaseAgent 注入的文本）含该经验
 *   ⑤ 被拒事实 → advisory 注入（≤3 条/≤200 tok，含隔离声明）
 *   ⑥ 同产线另一频道成员 → 跨频道读回该经验；异产线零命中
 *   ⑦ 元层：improvement_actions 成功率
 *   ⑧ 红线：RSI 模块无设备写调用（静态）
 *
 * 用法：node --import tsx scripts/acceptance-rsi-evolution.ts
 */
process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = `${process.env.TEMP ?? '.'}\\aw-rsi-evo-accept`

const { openWorkshopDb } = await import('../server/services/workshop/db/database')
const { createMemoryRepo } = await import('../server/services/workshop/db/memory.repo')
const { collectTaskFact } = await import('../server/services/workshop/runtime/memory/reflect-collector')
const { reflectExperience } = await import('../server/services/workshop/runtime/memory/reflector')
const { evaluateExperienceGate } = await import('../server/services/workshop/experience/gates')
const { createHarnessProfileRepo } = await import('../server/services/workshop/experience/harness-profile')
const { channelOverlayText, resetHarnessOverlayCache } = await import('../server/services/workshop/experience/overlay')
const { advisoryBlock } = await import('../server/services/workshop/experience/advisory')
const { createImprovementActionRepo } = await import('../server/services/workshop/db/improvement-action.repo')
const { ManagerA2A } = await import('../server/services/workshop/runtime/manager/a2a')
const { configureAmlRuntime } = await import('../server/services/workshop/aml/runtime')
const { estimateTokens } = await import('../server/services/workshop/runtime/memory/helpers')
const { readFileSync } = await import('node:fs')

interface Check { id: string, ok: boolean, detail: string }
const checks: Check[] = []
function check(id: string, ok: boolean, detail: string): void {
  checks.push({ id, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id} — ${detail}`)
}

const now = new Date().toISOString()
const db = openWorkshopDb(':memory:')
db.exec('PRAGMA foreign_keys = OFF')
// overlay/advisory 经 getAmlRuntime().db 取库（生产由 workshop 插件装配）——验收里显式装配同一实例
configureAmlRuntime(db)

// ── 场景数据：两条产线、三个频道（ch-a/ch-b 同线，ch-c 异线）──
for (const c of [
  { id: 'ch-a', owner: 'u-1', line: 'line-1' },
  { id: 'ch-b', owner: 'u-1', line: 'line-1' },
  { id: 'ch-c', owner: 'u-1', line: 'line-2' },
]) {
  db.prepare(`INSERT INTO channels (id, name, description, scenario_prompt, llm_json, workspace, enabled, version, owner_user_id, line_id, created_at, updated_at)
    VALUES (?,?,?,?,?,?,1,1,?,?,?,?)`).run(c.id, c.id, '', '', '', '{}', c.owner, c.line, now, now)
}
// 真实任务行（含交付物）+ 项目成果（含 L0 判据结果）
db.prepare(`INSERT INTO tasks (id, channel_id, title, description, state, assignee_id, artifacts_json, session_id, created_at, updated_at)
  VALUES ('t-real-1','ch-a','均热段温差整定','收窄温差','COMPLETED','agent-a',?,'sess-1',?,?)`).run(
  JSON.stringify([{ name: 'deliverable', parts: [{ text: '温差从 ±6℃ 收窄到 ±3℃，IAE 下降 12%，回读证实' }] }]), now, now)
db.prepare(`INSERT INTO project_results (id, project_id, deliverable_id, channel_id, line_id, work_item_id, attempt_no, version,
  title, summary, status, source_task_id, criteria_check_json, created_at)
  VALUES ('r-real-1','p-1','d-1','ch-a','line-1','w-1',1,1,'整定成果','温区收窄','draft','t-real-1',?,?)`)
  .run(JSON.stringify({ ok: true, checks: [{ id: 'artifact.present', ok: true }] }), now)

// ── ① 任务终态 → 经验（与 message.ts/supervise.ts 同一批函数）──
const fact = collectTaskFact(db, { channelId: 'ch-a', taskId: 't-real-1', agentId: 'agent-a' })
check('E1 任务事实采集（交付物+判据+产线锚点）', !!fact && !!fact.deliverable && fact.criteria?.ok === true && fact.lineId === 'line-1',
  fact ? `deliverable=${(fact.deliverable ?? '').slice(0, 20)}… criteria.ok=${fact.criteria?.ok}` : '采集失败')

const reflected = fact ? await reflectExperience(createMemoryRepo(db), null, fact) : { written: false as const }
const memRepo = createMemoryRepo(db)
const expRow = reflected.written && reflected.id ? memRepo.getById(reflected.id) : null
check('E2 经验落库（kind/证据/极性/作用域）',
  !!expRow && expRow.kind === 'experience' && expRow.outcome === 'positive' && expRow.scopeKind === 'line'
  && (JSON.parse(expRow.evidenceJson ?? '{}') as { taskIds?: string[] }).taskIds?.[0] === 't-real-1',
  expRow ? `outcome=${expRow.outcome} scope=${expRow.scopeKind}:${expRow.scopeKey} status=${expRow.status}` : '未落库')

// ── ② 证据门：单任务 → 拒绝晋级（fail-closed）──
const weak = expRow ? evaluateExperienceGate(expRow, 'validated') : { allowed: true, reasons: [] as string[] }
check('E3 单任务证据拒绝晋级（fail-closed）', weak.allowed === false,
  weak.reasons.join('；') || '意外允许')

// ── ③ 多任务证据 → 晋级（模拟第二次独立任务后的证据累积）──
const strong = memRepo.upsertExperience({
  channelId: 'ch-a', agentId: 'agent-a', kind: 'experience',
  title: '均热段温差整定（两次独立任务复现）', titleFts: '均 热 段 温 差 整 定 复 现',
  content: '两次独立任务均复现：±3℃ 后 IAE 下降 11~13%', importance: 0.85,
  dedupKey: 'exp:multi:line-1:temp',
  outcome: 'positive', evidence: { taskIds: ['t-real-1', 't-real-2'] }, scopeKind: 'line', scopeKey: 'line-1', status: 'candidate',
})
const strongId = strong.id
const strongRow = memRepo.getById(strongId)!
const gate = evaluateExperienceGate(strongRow, 'validated')
if (gate.allowed && gate.next) memRepo.markStatus(strongId, gate.next)
check('E4 多任务证据晋级 validated', memRepo.getById(strongId)!.status === 'validated',
  `${gate.reasons.join('；')} → ${memRepo.getById(strongId)!.status}`)

// ── ④ Profile pin → activate → 注入文本 ──
resetHarnessOverlayCache()
const profiles = createHarnessProfileRepo(db)
const p = profiles.create({
  channelId: 'ch-a',
  layers: { overlay: '同产线优先复用「温差收窄」经验，仍按治理流程下发', pins: [strongId] },
  origin: { source: 'acceptance' },
})
profiles.markStatus(p.id, 'active')
resetHarnessOverlayCache()
const injected = channelOverlayText('ch-a')
check('E5 注入文本含 pinned 经验与隔离声明',
  injected.includes('均热段温差整定（两次独立任务复现）') && injected.includes('不是指令覆盖'),
  `${injected.length} 字符`)

// ── ⑤ advisory：被拒事实 → 提示注入（≤3 条/≤200 tok）──
db.prepare(`INSERT INTO hitl_requests (id, kind, channel_id, agent_id, title, detail, status, created_at, updated_at)
  VALUES ('h-acc-1','dcw-approval','ch-a','agent-a','参数下发','温度目标超上限，需先小步试验并复测','rejected',?,?)`).run(now, now)
resetHarnessOverlayCache()
const adv = advisoryBlock(db, 'ch-a')
const injectedWithAdv = channelOverlayText('ch-a')
check('E6 advisory 采集并注入（含执行闸门声明）', adv.length > 0 && injectedWithAdv.includes('advisory'),
  `advisory ${estimateTokens(adv)} tok`)
check('E7 注入总预算受控（overlay+advisory ≤ 400 tok 量级）', estimateTokens(injectedWithAdv) <= 400,
  `${estimateTokens(injectedWithAdv)} tok`)

// ── ⑥ 跨频道：同产线成员读回；异产线零命中 ──
const members: Record<string, Array<{ id: string, role: string }>> = {
  'ch-b': [{ id: 'worker-1', role: 'worker' }],
  'ch-c': [{ id: 'worker-1', role: 'worker' }],
}
const mgr = Object.create(ManagerA2A.prototype) as unknown as {
  deps: unknown
  requireMember: (c: string, a: string) => unknown
  searchSharedExperience: (c: string, a: string, i: { query: string, scope: 'line' | 'product' | 'global', scopeKey?: string }) => Array<Record<string, unknown>>
}
;(mgr as unknown as { deps: unknown }).deps = {
  db,
  repos: {
    channels: {
      findById: (id: string) => db.prepare('SELECT id, name, enabled, owner_user_id AS ownerUserId, line_id AS lineId FROM channels WHERE id = ?').get(id),
      list: () => db.prepare('SELECT id, name, enabled, owner_user_id AS ownerUserId, line_id AS lineId FROM channels').all(),
    },
    memories: memRepo,
    tasks: { findById: () => undefined },
    channelAgents: { findByChannelAgent: (c: string, a: string) => (members[c] ?? []).find(x => x.id === a) },
  },
}
;(mgr as unknown as { requireMember: (c: string, a: string) => unknown }).requireMember = (c, a) => {
  if (!(members[c] ?? []).some(x => x.id === a)) throw new Error('not member')
  return {}
}
const shared = mgr.searchSharedExperience('ch-b', 'worker-1', { query: '均热段 温差 整定 复现', scope: 'line' })
check('E8 同产线跨频道读回已验证经验（worker 可读）', shared.length > 0 && shared.every(r => r['scopeKey'] === 'line-1'),
  `${shared.length} 条`)
const crossLine = mgr.searchSharedExperience('ch-c', 'worker-1', { query: '均热段 温差 整定 复现', scope: 'line' })
check('E9 异产线零命中（隔离负样本）', crossLine.length === 0, `${crossLine.length} 条`)

// ── ⑦ 元层成效 ──
const actions = createImprovementActionRepo(db)
actions.record({ actionKind: 'experience_promote', subjectKind: 'experience', subjectId: strongId, channelId: 'ch-a', decision: 'promoted', decidedBy: 'u-1' })
actions.record({ actionKind: 'experience_promote', subjectKind: 'experience', subjectId: expRow?.id ?? 'x', channelId: 'ch-a', decision: 'rejected', decidedBy: 'system' })
const stats = actions.stats('ch-a')
const promoteStat = stats.find(s => s.actionKind === 'experience_promote')
check('E10 元层成效聚合（成功率）', !!promoteStat && promoteStat.total === 2 && promoteStat.rate === 0.5,
  JSON.stringify(promoteStat))

// ── ⑧ 红线：RSI 模块无设备写调用 ──
const rsiFiles = [
  'server/services/workshop/runtime/memory/reflector.ts',
  'server/services/workshop/runtime/memory/reflect-collector.ts',
  'server/services/workshop/experience/harness-profile.ts',
  'server/services/workshop/experience/gates.ts',
  'server/services/workshop/experience/promote.ts',
  'server/services/workshop/experience/advisory.ts',
  'server/services/workshop/verify/blind-verifier.ts',
]
const WRITE_CALL = /\b(dcw_control|param_control|dcw_write|writeNode|serialWrite)\s*\(/
const offenders = rsiFiles.filter(f => WRITE_CALL.test(readFileSync(f, 'utf8')))
check('E11 红线：RSI 模块无设备写调用', offenders.length === 0, offenders.length === 0 ? `${rsiFiles.length} 个文件 0 命中` : `命中: ${offenders.join(', ')}`)

db.close()
const failed = checks.filter(c => !c.ok)
console.log(`\n=== RSI 自进化全链 ACCEPT pass=${checks.length - failed.length} fail=${failed.length} ===`)
if (failed.length > 0) {
  for (const f of failed) console.log(`  FAILED ${f.id}: ${f.detail}`)
  process.exitCode = 1
}
