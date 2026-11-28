/**
 * team 向量榜的频道过滤回归（2026-11-28 实机发现）。
 *
 * `agent_memories_vec` 只按 agent_id 分区，`__team__` 行来自所有频道。召回原先对 team
 * 只取 top-5，再按 channel 过滤 —— 多频道 home 里别的频道的 team 行会把 top-5 占满，
 * 本频道的 team 行一条不剩，该频道的向量榜恒空、只剩 FTS：语义相近但字面不重合的记忆
 * 永远搜不到（实机：低活动频道整轮没有注入留痕）。
 *
 * 修复：team kNN 放大到 40 条，再做频道过滤。本测试用确定性向量复现"别的频道更近"的场景。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-team-vec-'))
delete process.env.AW_BENCH_MODE
process.env.AW_MEMORY_GRAPH_RETRIEVAL = '0'

const { openWorkshopDb } = await import('../server/services/workshop/db/database')
const { createMemoryRepo, TEAM_AGENT_ID } = await import('../server/services/workshop/db/memory.repo')
const { AgentMemory } = await import('../server/services/workshop/runtime/memory')
const { segmentCJK } = await import('../server/services/workshop/runtime/memory/helpers')

test('team 向量榜：别的频道的近邻不得把本频道语义行挤出 top-k', async () => {
  const db = openWorkshopDb(':memory:')
  db.exec('PRAGMA foreign_keys = OFF')
  const now = new Date().toISOString()
  for (const id of ['ch-a', 'ch-b']) {
    db.prepare(`INSERT INTO channels (id, name, description, scenario_prompt, llm_json, workspace, enabled, version, line_id, owner_user_id, memory_access_mode, created_at, updated_at)
      VALUES (?,?,'','','','{}',1,1,'','u1','inherit',?,?)`).run(id, id, now, now)
  }
  const repo = createMemoryRepo(db)
  assert.equal(repo.vecInit(4), true)
  const insert = (channelId: string, title: string, content: string, key: string): { id: string, rowid: number } => {
    const write = repo.upsert({
      channelId, agentId: TEAM_AGENT_ID, kind: 'semantic', title, titleFts: segmentCJK(title),
      content: segmentCJK(content), importance: 0.8, taskId: null, sessionId: '', dedupKey: key, ownerUserId: 'u1',
    }, { kind: 'human', id: 'u1' })
    repo.setScope(write.id, 'channel', '')
    const rowid = Number((db.prepare('SELECT rowid FROM agent_memories WHERE id = ?').get(write.id) as { rowid: number | bigint }).rowid)
    return { id: write.id, rowid }
  }
  // 别的频道 6 条"更近"的 team 向量（距离 0）
  for (let i = 0; i < 6; i++) {
    const row = insert('ch-a', `A 频道近邻 ${i}`, `A 频道近邻正文 ${i}`, `tv:a:${i}`)
    repo.vecSet(row.rowid, TEAM_AGENT_ID, Float32Array.from([1, 0, 0, 0]))
  }
  // 本频道 1 条稍远但语义相关的行（距离 > 0），且正文与查询**无字面重合**
  const target = insert('ch-b', 'B 频道唯一结论', 'ZEBRA 冷却水温 47 度结论', 'tv:b:1')
  repo.vecSet(target.rowid, TEAM_AGENT_ID, Float32Array.from([0.8, 0.6, 0, 0]))

  const embedder = {
    dims: () => 4,
    embed: async (texts: string[]) => texts.map(() => Float32Array.from([1, 0, 0, 0])),
  } as never
  const mem = new AgentMemory(repo, { channelId: 'ch-b', agentId: 'a1', embedder })
  // 查询是纯英文，正文是中文 + ZEBRA：FTS 不可能命中，只有向量榜能找到
  const rows = await mem.recallRows('cooling liquid thermal setting', { scope: 'auto', limit: 20 })
  assert.ok(rows.some(r => r.id === target.id), `本频道语义行必须被向量榜召回（实际 ${rows.length} 条：${JSON.stringify(rows.map(r => r.title))}）`)
  // 别的频道的行仍不得越界
  assert.equal(rows.some(r => String(r.content ?? '').includes('A 频道近邻正文')), false, '其他频道内容不得返回')

  // 正向对照：同频道字面查询也命中（证明不是查询本身没跑）
  const literal = await mem.recallRows('ZEBRA 冷却水温', { scope: 'auto', limit: 20 })
  assert.ok(literal.some(r => r.id === target.id), '同频道字面检索应命中')

  // ── 名次必须按距离序，而不是 rowid 序（评审 P1 回归）──
  // 先插"远行"（rowid 小）、后插"近行"（rowid 大）：按 rowid 排序会把远行排前面。
  const far = insert('ch-b', 'FAR-ROW 远端', 'FAR-ROW content', 'tv:b:far')
  repo.vecSet(far.rowid, TEAM_AGENT_ID, Float32Array.from([0, 1, 0, 0]))
  const near = insert('ch-b', 'NEAR-ROW 近端', 'NEAR-ROW content', 'tv:b:near')
  repo.vecSet(near.rowid, TEAM_AGENT_ID, Float32Array.from([1, 0, 0, 0]))
  const sameAt = new Date().toISOString()
  db.prepare('UPDATE agent_memories SET created_at = ?, importance = 0.8 WHERE id IN (?, ?)').run(sameAt, far.id, near.id)
  const ranked = await mem.recallRows('cooling liquid thermal setting', { scope: 'auto', limit: 20 })
  const iNear = ranked.findIndex(r => r.id === near.id)
  const iFar = ranked.findIndex(r => r.id === far.id)
  assert.ok(iNear >= 0 && iFar >= 0, `两行都应被向量榜召回（near=${iNear} far=${iFar}）`)
  assert.ok(iNear < iFar, `距离更近的行必须排更前（near=${iNear} far=${iFar}，按 rowid 排序会反过来）`)
  db.close()
})
