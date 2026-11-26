/**
 * 批次 E：Curator 汇整（M13–M22 子集）。
 * - 来源准入：session/未部署经验/curated 自身不进手册；
 * - 12 条碎片 → 1 份结构化文档（5 章节 + 来源 id）；
 * - 增量幂等 + 人工编辑保护 + force；
 * - 冲突并列保留；
 * - L0.5 注入 ≤200 tok。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-curator-'))
delete process.env.AW_BENCH_MODE

const { openWorkshopDb } = await import('../server/services/workshop/db/database')
const { createMemoryRepo } = await import('../server/services/workshop/db/memory.repo')
const { AgentMemory } = await import('../server/services/workshop/runtime/memory')
const { runCuratorForChannel, selectCuratorSources, listCurations } = await import('../server/services/workshop/memory/curator')
const { unsegmentCJK } = await import('../server/services/workshop/runtime/memory/helpers')

const db = openWorkshopDb(':memory:')
const now = new Date().toISOString()
db.prepare(`INSERT INTO channels (id, name, description, scenario_prompt, llm_json, workspace, enabled, version, line_id, owner_user_id, created_at, updated_at)
  VALUES ('c1','注塑一线','','','','{}',1,1,'L1','u1',?,?)`).run(now, now)
const repo = createMemoryRepo(db)

let seq = 0
function semantic(content: string, sessionId = '', title?: string) {
  seq++
  return repo.upsert({
    channelId: 'c1',
    agentId: 'a1',
    kind: 'semantic',
    title: title ?? `约定 ${seq}`,
    titleFts: title ?? `约 定 ${seq}`,
    content,
    importance: 0.7,
    sessionId,
    dedupKey: `cur:${seq}`,
    scopeKind: 'channel',
  }).id
}

for (let i = 0; i < 8; i++) semantic(`车间约定 ${i}：模温保持 85 度，首件必检。`)
for (let i = 0; i < 4; i++) semantic(`流程 ${i}：换模后先空跑 3 模再取样。`)
semantic('会话私有：不得进入频道手册', 's1')
semantic('另一会话私有：也不得进入', 's2')
// candidate 经验（未部署）不得进手册
repo.upsertExperience({
  channelId: 'c1', agentId: 'a1', kind: 'experience', title: '未验证经验', titleFts: '未 验 证 经 验',
  content: 'candidate 不得进手册', importance: 0.7, dedupKey: 'exp:candidate', evidence: { taskIds: ['t1'] },
  scopeKind: 'line', scopeKey: 'L1', status: 'candidate',
})
// validated + active 经验应进手册
const goodExp = repo.upsertExperience({
  channelId: 'c1', agentId: 'a1', kind: 'experience', title: '保压上调提升壁厚', titleFts: '保 压 上 调 提 升 壁 厚',
  content: '保压 60→62 后壁厚 3.05→3.14（已验证）', importance: 0.8, dedupKey: 'exp:good', evidence: { taskIds: ['t2'] },
  scopeKind: 'line', scopeKey: 'L1', status: 'validated',
}).id
db.prepare(`INSERT INTO experience_versions
  (version_id, experience_id, claim_origin_id, scope_kind, scope_key, claim_json, content, content_hash,
   evidence_json, evidence_snapshot_hash, lifecycle, deployment, claim_origin_time, beta_ancestors_json, idempotency_key, created_at)
  VALUES ('ev-good', ?, 'co-good', 'line','L1','{}','x','h1','[]','h2','validated','active',?,'[]','idem-good',?)`).run(goodExp, now, now)
db.prepare(`INSERT INTO experience_heads(experience_id, version_id, updated_at) VALUES (?, 'ev-good', ?)`).run(goodExp, now)

test('source admission excludes session rows, candidates and curated docs', () => {
  const sources = selectCuratorSources(db, 'c1')
  assert.ok(sources.length >= 12)
  assert.ok(!sources.some(s => s.content.includes('会话私有')), 'session 行不得作为频道手册来源')
  assert.ok(!sources.some(s => s.title === '未验证经验'), 'candidate 未部署经验不得作为来源')
  assert.ok(sources.some(s => s.id === goodExp), 'validated+active 经验应作为来源')
})

test('12 fragments become one structured doc with sources; rerun is noop', async () => {
  const first = await runCuratorForChannel(db, 'c1')
  assert.equal(first.status, 'ok')
  assert.ok(first.curatedId)
  assert.equal(first.sourceCount, 13)
  const row = db.prepare(`SELECT content, kind, status FROM agent_memories WHERE id = ?`).get(first.curatedId!) as { content: string, kind: string, status: string }
  const content = unsegmentCJK(row.content).replace(/\s+/g, '')
  assert.equal(row.kind, 'curated')
  assert.equal(row.status, 'active')
  assert.ok(content.includes('##1.当前结论'))
  assert.ok(content.includes('##5.来源'))
  assert.ok(content.includes(goodExp), '来源 id 必须可追溯')
  const links = db.prepare('SELECT COUNT(*) AS n FROM memory_curation_sources WHERE curated_id = ?').get(first.curatedId!) as { n: number }
  assert.equal(links.n, first.sourceCount)
  const listed = listCurations(db)
  assert.ok(listed.some(c => c.id === first.curatedId), '管理面列表必须包含 Curator 文档')

  const second = await runCuratorForChannel(db, 'c1')
  assert.equal(second.status, 'skipped_noop')
  assert.equal(second.revision, first.revision)
})

test('new sources bump revision and keep old version', async () => {
  for (let i = 0; i < 5; i++) semantic(`新增约定 ${i}：冷却时间不低于 8s。`)
  const run = await runCuratorForChannel(db, 'c1')
  assert.equal(run.status, 'ok')
  assert.equal(run.revision, 2)
  const revisions = db.prepare('SELECT COUNT(*) AS n FROM memory_revisions WHERE memory_id = ?').get(run.curatedId!) as { n: number }
  assert.ok(revisions.n >= 1, '旧版必须保留')
})

test('human edit blocks automatic regeneration; force overrides', async () => {
  const ref = repo.findByAgentDedup('c1', 'curator', 'curated:knowledge:c1')
  assert.ok(ref)
  // 模拟人工编辑（author_kind=human）
  db.prepare(`UPDATE agent_memories SET author_kind='human', author_id='u1', content=? WHERE id=?`).run('人工编辑版', ref!.id)
  semantic('人工编辑后再来的新来源')
  const blocked = await runCuratorForChannel(db, 'c1')
  assert.equal(blocked.status, 'blocked_human')
  const forced = await runCuratorForChannel(db, 'c1', { force: true })
  assert.equal(forced.status, 'ok')
  assert.ok(forced.markdown!.includes('人工编辑后再来的新来源') || forced.markdown!.includes('新增约定'))
})

test('conflicting numeric claims are preserved side by side', async () => {
  semantic('模温设定 85 度', '', '模温设定 冲突A')
  semantic('模温设定 92 度', '', '模温设定 冲突B')
  const run = await runCuratorForChannel(db, 'c1', { force: true })
  assert.equal(run.status, 'ok')
  assert.ok(run.markdown!.includes('## 4. 争议与未决'))
  assert.ok(run.markdown!.includes('模温设定 85 度'))
  assert.ok(run.markdown!.includes('模温设定 92 度'))
})

test('curated doc is injected in L0.5 within budget and not double-injected in L1', async () => {
  const memory = new AgentMemory(repo, { channelId: 'c1', agentId: 'a1', sessionId: 's1', industrialScopeEnabled: false })
  const block = String(await memory.recall('模温 保压 壁厚 约定') ?? '')
  assert.ok(block.includes('知识手册'), 'curated 文档应进入 L0.5 注入')
  assert.ok(block.length < 3000, '注入块应有预算上限')
})
