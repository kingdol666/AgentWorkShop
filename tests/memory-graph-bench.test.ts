/**
 * 检索基准：FTS 基线 vs 图谱混合（RRF）。
 * 目标是证明多跳查询有增益、单跳不回退；不追求绝对分数。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-graph-bench-'))
delete process.env.AW_BENCH_MODE
delete process.env.AW_MEMORY_GRAPH_LLM_URL
delete process.env.AW_MEMORY_CURATOR_LLM_URL

const { openWorkshopDb } = await import('../server/services/workshop/db/database')
const { createMemoryRepo } = await import('../server/services/workshop/db/memory.repo')
const { runMemoryGraphConsolidation } = await import('../server/services/workshop/memory/graph/agent')
const { graphRetrieve } = await import('../server/services/workshop/memory/graph/retrieval')
const { buildMatchQuery } = await import('../server/services/workshop/runtime/memory/helpers')

const db = openWorkshopDb(':memory:')
const mem = createMemoryRepo(db)
const now = new Date().toISOString()
db.prepare(`INSERT INTO channels (id, name, description, scenario_prompt, llm_json, workspace, enabled, version, line_id, owner_user_id, created_at, updated_at)
  VALUES ('c1','bench','','','','{}',1,1,'L1','u1',?,?)`).run(now, now)

const ids = new Map<string, string>()
function add(id: string, title: string, content: string) {
  db.prepare(`INSERT INTO agent_memories(id, channel_id, agent_id, kind, title, title_fts, content, importance,
      session_id, dedup_key, scope_kind, scope_key, status, created_at, updated_at)
    VALUES (?, 'c1', '__team__', 'semantic', ?, ?, ?, 0.7, '', ?, 'channel', '', 'active', ?, ?)`)
    .run(id, title, title, content, `bench:${id}`, now, now)
  ids.set(id, id)
}
add('m1', 'packpress thickness', 'packpress 60 to 62 changed thickness 3.05 to 3.14')
add('m2', 'coolflow yieldrate', 'coolflow 12 keeps yieldrate at 98')
add('m3', 'packpress coolflow', 'packpress and coolflow jointly affect quality')
add('m4', 'moldtemperature thickness', 'moldtemperature 85 keeps thickness stable')
for (let i = 0; i < 12; i++) add(`p${i}`, `packpress note ${i}`, `packpress packpress packpress routine note ${i}`)
for (let i = 0; i < 12; i++) add(`y${i}`, `yieldrate note ${i}`, `yieldrate yieldrate yieldrate routine note ${i}`)

const cases = [
  { q: 'packpress thickness', truth: 'm1', type: 'single' },
  { q: 'coolflow yieldrate', truth: 'm2', type: 'single' },
  { q: 'moldtemperature thickness', truth: 'm4', type: 'single' },
  { q: 'packpress yieldrate', truth: 'm2', type: 'multi' },
  { q: 'coolflow thickness', truth: 'm1', type: 'multi' },
  { q: 'packpress coolflow', truth: 'm3', type: 'multi' },
]

function rrfFuse(lists: Array<{ ids: string[], weight: number }>, k = 60): string[] {
  const score = new Map<string, number>()
  for (const list of lists) {
    list.ids.forEach((id, idx) => score.set(id, (score.get(id) ?? 0) + list.weight / (k + idx + 1)))
  }
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id)
}

test('graph hybrid improves multi-hop while keeping single-hop', async () => {
  const run = await runMemoryGraphConsolidation(db, 'c1', { useLlm: false })
  assert.equal(run.status, 'ok', run.error)

  let baselineHits = 0
  let hybridHits = 0
  let improved = 0
  let latencyMax = 0
  for (const c of cases) {
    const match = buildMatchQuery(c.q)!
    const fts = mem.search('a1', match, 20, { channelId: 'c1' }).map(r => r.id)
    const graph = graphRetrieve(mem.graph, 'c1', c.q)
    latencyMax = Math.max(latencyMax, graph.durationMs)
    const graphRanked = [...graph.memoryScores.entries()].sort((a, b) => b[1].score - a[1].score).map(([id]) => id)
    const hybrid = rrfFuse([{ ids: fts, weight: 1 }, { ids: graphRanked, weight: 0.8 }])
    const truth = ids.get(c.truth)!
    const baseRank = fts.indexOf(truth)
    const hybRank = hybrid.indexOf(truth)
    if (baseRank >= 0 && baseRank < 5) baselineHits++
    if (hybRank >= 0 && hybRank < 5) hybridHits++
    if (c.type === 'multi' && hybRank >= 0 && (baseRank < 0 || hybRank < baseRank)) improved++
    if (c.type === 'single') {
      assert.ok(hybRank >= 0 && hybRank < 5, `单跳不应回退：${c.q}`)
    }
  }
  assert.ok(hybridHits >= baselineHits, `混合召回不应低于基线：${hybridHits} vs ${baselineHits}`)
  assert.ok(improved >= 1, '至少一个多跳查询应因图谱扩展而改善')
  assert.ok(latencyMax < 75, `图检索应 ≤75ms，实测 ${latencyMax}ms`)
})
