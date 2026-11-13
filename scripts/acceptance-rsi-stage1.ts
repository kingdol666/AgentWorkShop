/**
 * RSI Stage-1 验收脚本（Gate-1A 离线可重复执行件）。
 *
 * 覆盖：
 *   ①经验产生（任务/评审/干预三触发）②作用域与证据链 ③跨频道共享正负样本
 *   ④memoryPolicy 写入门 ⑤注入预算不变量 ⑥retired 排除 ⑦DTO provenance 字段
 *
 * 设计边界：本脚本**不发任何网络请求**（纯内存库确定性验收）。live 观测走仓库既有
 * `pnpm test:api-live` 通道 + 新增的 GET /api/workshop/channels/:id/memories/experience-stats。
 *
 * 用法：node --import tsx scripts/acceptance-rsi-stage1.ts
 *   （或 tsx --tsconfig .nuxt/tsconfig.server.json scripts/acceptance-rsi-stage1.ts）
 */
process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'

interface Check { id: string, ok: boolean, detail: string }
const checks: Check[] = []
function check(id: string, ok: boolean, detail: string): void {
  checks.push({ id, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id} — ${detail}`)
}

const { openWorkshopDb } = await import('../server/services/workshop/db/database')
const { createMemoryRepo } = await import('../server/services/workshop/db/memory.repo')
const { AgentMemory } = await import('../server/services/workshop/runtime/memory')
const { reflectExperience } = await import('../server/services/workshop/runtime/memory/reflector')
const { estimateTokens } = await import('../server/services/workshop/runtime/memory/helpers')
const { ManagerA2A } = await import('../server/services/workshop/runtime/manager/a2a')

const now = new Date().toISOString()

const db = openWorkshopDb(':memory:')
db.exec('PRAGMA foreign_keys = OFF')
for (const c of [
  { id: 'ch-a', owner: 'u-1', line: 'line-1' },
  { id: 'ch-b', owner: 'u-1', line: 'line-1' },
  { id: 'ch-c', owner: 'u-1', line: 'line-2' },
  { id: 'ch-x', owner: 'u-2', line: 'line-1' },
]) {
  db.prepare(`INSERT INTO channels (id, name, description, scenario_prompt, llm_json, workspace, enabled, version, owner_user_id, line_id, created_at, updated_at)
    VALUES (?,?,?,?,?,?,1,1,?,?,?,?)`).run(c.id, c.id, '', '', '', '{}', c.owner, c.line, now, now)
}
const repo = createMemoryRepo(db)

try {
  // ① 三触发产生经验（证据链）
  const taskFact = {
    source: 'task' as const, channelId: 'ch-a', agentId: 'agent-a', taskId: 't-1',
    title: '均热段整定', state: 'COMPLETED', deliverable: '温差收窄到 ±3℃，IAE 下降 12%',
    criteria: { ok: true, checks: [{ id: 'artifact.present', ok: true }] }, lineId: 'line-1',
  }
  const t = await reflectExperience(repo, null, taskFact)
  const tRow = t.written ? repo.getById(t.id!)! : null
  check('A-3.1 任务终态产出经验', !!tRow && tRow.kind === 'experience',
    tRow ? `outcome=${tRow.outcome} status=${tRow.status} scope=${tRow.scopeKind}:${tRow.scopeKey}` : '未产出')

  const r = await reflectExperience(repo, null, {
    source: 'review', channelId: 'ch-a', agentId: 'agent-a', resultId: 'r-1', verdict: 'approved',
    title: '调参报告', summary: 'IAE 改善显著', validityScope: { kind: 'line', key: 'line-1' }, lineId: 'line-1',
  })
  const rRow = r.written ? repo.getById(r.id!)! : null
  check('A-3.2 评审终态产出经验(line 作用域→candidate)', !!rRow && rRow.scopeKind === 'line' && rRow.status === 'candidate',
    rRow ? `scope=${rRow.scopeKind}:${rRow.scopeKey} status=${rRow.status}` : '未产出')

  // 干预 verdict 走 line 作用域 + 可辨识性证据
  repo.upsertExperience({
    channelId: 'ch-a', agentId: 'agent-a', kind: 'experience',
    title: '干预判定 identifiable_effect', titleFts: '干 预 判 定',
    content: '节点均热段 220→218.5 回读 218.52 判定 identifiable_effect effect=-1.48',
    importance: 0.9, dedupKey: 'exp:int:ie-1',
    outcome: 'positive', evidence: { interventionEventId: 'ie-1', recipeRunId: 'run-1', metrics: { effect: -1.48 } },
    scopeKind: 'line', scopeKey: 'line-1', status: 'validated',
  })
  const evRows = repo.listByScope({ scopeKind: 'line', scopeKey: 'line-1', channelIds: ['ch-a'] })
  const ev = evRows.find(x => x.dedupKey === 'exp:int:ie-1')
  let evOk = false
  try {
    const parsed = JSON.parse(ev?.evidenceJson ?? '{}') as { interventionEventId?: string, recipeRunId?: string }
    evOk = parsed.interventionEventId === 'ie-1' && parsed.recipeRunId === 'run-1'
  }
  catch { evOk = false }
  check('A-3.3 干预 verdict 证据可解析(干预行+配方批次)', evOk, evOk ? 'evidence 锚点完整' : '证据缺失/不可解析')

  // 证据 fail-closed
  let rejected = false
  try {
    repo.upsertExperience({ channelId: 'ch-a', agentId: 'agent-a', kind: 'experience', title: 'x', titleFts: 'x', content: 'y', importance: 0.5, dedupKey: 'exp:bad', evidence: '' })
  }
  catch { rejected = true }
  check('A-3.4 无锚点证据被拒绝(fail-closed)', rejected, rejected ? '已拒绝' : '未拒绝')

  // ② 跨频道共享：同产线正样本 / 异产线·异 owner 负样本
  const members: Record<string, Array<{ id: string, role: string }>> = { 'ch-b': [{ id: 'worker-1', role: 'worker' }] }
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
      memories: repo,
      tasks: { findById: () => undefined },
      channelAgents: { findByChannelAgent: (c: string, a: string) => (members[c] ?? []).find(x => x.id === a) },
    },
  }
  ;(mgr as unknown as { requireMember: (c: string, a: string) => unknown }).requireMember = (c, a) => {
    if (!(members[c] ?? []).some(x => x.id === a)) throw new Error('not member')
    return {}
  }
  const hit = mgr.searchSharedExperience('ch-b', 'worker-1', { query: '均热段 温差 整定 经验', scope: 'line' })
  check('A-4.1 跨频道同产线命中(worker 可读)', hit.length > 0 && hit.every(h => h['scopeKey'] === 'line-1'),
    `${hit.length} 条 · status=${[...new Set(hit.map(h => String(h['status'])))].join('/')}`)
  check('A-4.2 跨频道结果带 visibility=cross-channel', hit.length > 0 && hit.every(h => h['visibility'] === 'cross-channel'),
    hit.length > 0 ? '标注正确' : '无命中')

  // 异产线 / 异 owner：零命中
  repo.upsertExperience({
    channelId: 'ch-c', agentId: 'agent-a', kind: 'experience', title: '异产线经验', titleFts: '异 产 线 经 验',
    content: '不应命中', importance: 0.8, dedupKey: 'exp:other-line',
    outcome: 'positive', evidence: { taskIds: ['t-c'] }, scopeKind: 'line', scopeKey: 'line-2', status: 'validated',
  })
  repo.upsertExperience({
    channelId: 'ch-x', agentId: 'agent-x', kind: 'experience', title: '异owner经验', titleFts: '异 owner 经 验',
    content: '不应命中', importance: 0.8, dedupKey: 'exp:other-owner',
    outcome: 'positive', evidence: { taskIds: ['t-x'] }, scopeKind: 'line', scopeKey: 'line-1', status: 'validated',
  })
  const neg = mgr.searchSharedExperience('ch-b', 'worker-1', { query: '异产线经验 异owner经验', scope: 'line' })
  check('A-4.3 隔离负样本：异产线/异owner 零命中', neg.length === 0, `${neg.length} 条(应为 0)`)

  // ③ memoryPolicy 写入门
  db.prepare(`INSERT INTO channel_sessions (id, channel_id, title, status, memory_policy, created_at) VALUES ('sess-session','ch-a','s','active','session',?)`).run(now)
  db.prepare(`INSERT INTO channel_sessions (id, channel_id, title, status, memory_policy, created_at) VALUES ('sess-shared','ch-a','s','active','shared',?)`).run(now)
  const mem = new AgentMemory(repo, { channelId: 'ch-a', agentId: 'agent-a' })
  let policyRejected = false
  try {
    await mem.save({ title: 'T', content: 'C', scope: 'line', sessionId: 'sess-session', taskId: 't-1' })
  }
  catch { policyRejected = true }
  check('A-4.4 memoryPolicy=session 拒绝共享经验写入', policyRejected, policyRejected ? '已拒绝' : '未拒绝')
  let policyAllowed = false
  try {
    const saved = await mem.save({ title: '同线经验', content: '温差 ±3℃ 最优', scope: 'line', sessionId: 'sess-shared', taskId: 't-2' })
    const row = repo.listByAgentChannel('ch-a', 'agent-a', 50).find(x => x.dedupKey === saved.dedupKey)
    policyAllowed = !!row && row.status === 'candidate' && row.scopeKind === 'line'
  }
  catch { policyAllowed = false }
  check('A-4.5 memoryPolicy=shared 放行且落 candidate', policyAllowed, policyAllowed ? 'candidate/line 正确' : '写入或状态不符')

  // ④ 注入预算不变量（500 tok 硬顶）
  for (let i = 0; i < 8; i++) {
    repo.upsertExperience({
      channelId: 'ch-a', agentId: 'agent-a', kind: 'experience', title: `经验 ${i} 均热段`, titleFts: `经 验 ${i} 均 热 段`,
      content: `第 ${i} 条：温差收窄后 IAE 下降，回读证实，判据通过。`.repeat(6), importance: 0.8,
      dedupKey: `exp:budget-${i}`, outcome: 'positive', evidence: { taskIds: [`t-b${i}`] },
      scopeKind: 'line', scopeKey: 'line-1', status: 'validated',
    })
  }
  const block = await mem.recall('均热段 温差 整定 经验', { budgetTokens: 500 })
  const tok = block ? estimateTokens(block) : 0
  check('A-5.1 注入预算 ≤500 tok(含经验行)', block !== null && tok <= 500, `${tok} tok`)

  // ⑤ retired 排除
  const retired = repo.upsertExperience({
    channelId: 'ch-a', agentId: 'agent-a', kind: 'experience', title: '退休经验', titleFts: '退 休 经 验',
    content: '应被排除', importance: 0.9, dedupKey: 'exp:retired-1', outcome: 'negative',
    evidence: { taskIds: ['t-r'] }, scopeKind: 'line', scopeKey: 'line-1', status: 'validated',
  })
  repo.markStatus(retired.id, 'retired', 'validated')
  const rowsAfter = await mem.recallRows('退休经验', { limit: 20 })
  check('A-5.2 retired 经验不参与检索', rowsAfter.every(x => x.dedupKey !== 'exp:retired-1' && x.status !== 'retired'),
    `${rowsAfter.length} 条命中均非 retired`)

  // ⑥ DTO provenance 字段完备
  const prov = await mem.recallRows('均热段 温差 整定 经验', { limit: 5 })
  const provOk = prov.length > 0 && prov.every(x => typeof x.outcome === 'string' && typeof x.status === 'string' && typeof x.scopeKind === 'string')
  check('A-5.3 检索 DTO 含 outcome/status/scopeKind', provOk, provOk ? '字段齐备' : '字段缺失')

  // ⑦ 经验看板聚合（API 的数据面，离线直测）
  const overview = ((): { total: number, byStatus: Record<string, number> } => {
    const rows = (['session', 'channel', 'line', 'product', 'global'] as const).flatMap(scopeKind => repo.listByScope({
      scopeKind,
      channelIds: ['ch-a'],
      statuses: ['active', 'candidate', 'validated', 'contested', 'retired'],
      limit: 500,
    }))
    const byStatus: Record<string, number> = {}
    for (const row of rows) byStatus[row.status ?? 'active'] = (byStatus[row.status ?? 'active'] ?? 0) + 1
    return { total: rows.length, byStatus }
  })()
  check('A-5.4 经验看板聚合(total/byStatus)', overview.total > 0 && typeof overview.byStatus['candidate'] === 'number',
    `total=${overview.total} status=${JSON.stringify(overview.byStatus)}`)
}
finally {
  db.close()
}

const failed = checks.filter(c => !c.ok)
console.log(`\n=== RSI Stage-1 ACCEPT pass=${checks.length - failed.length} fail=${failed.length} ===`)
if (failed.length > 0) {
  for (const f of failed) console.log(`  FAILED ${f.id}: ${f.detail}`)
  process.exitCode = 1
}
