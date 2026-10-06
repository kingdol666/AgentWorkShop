/**
 * save_memory 共享域近邻治理的 FTS 注入回归:
 *   标题含 `10:30`/`2026-10-07` 这类片段时,FTS5 把裸 `10` 解析成列过滤器
 *   → "no such column: 10",save_memory 全量炸掉(实测:跨频道冻结约定标题带时间戳)。
 *   修复:近邻检索必须走 buildMatchQuery(剥 `:+-` 并逐词引号惰性化),与 recall 同源。
 * 断言:
 *   1) 带时间戳/冒号标题的 shared save 正常落库(修复前抛 SQLITE error);
 *   2) 近邻合并语义不受影响:标题词项重合 + 数值一致 → 并入既有条目(并存确认);
 *   3) buildMatchQuery 自身对 `10:30` 产出引号惰性化查询。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'

const { initWorkshopDb } = await import('../server/services/workshop/db/database')
const { createMemoryRepo } = await import('../server/services/workshop/db/memory.repo')
const { AgentMemory, buildMatchQuery } = await import('../server/services/workshop/runtime/memory')

const db = new DatabaseSync(':memory:')
initWorkshopDb(db)
const repo = createMemoryRepo(db)
const CH = 'ch-fts-test'
const mk = (agentId: string) => new AgentMemory(repo, { agentId, channelId: CH })

test('buildMatchQuery 惰性化时间戳/冒号片段', () => {
  const q = buildMatchQuery('跨频道冻结窗口 2026-10-07 20:18 z2/z3')
  assert.ok(q, '应产出非空 MATCH 串')
  assert.ok(!/[^"]10:/.test(q!), `10 不得作为裸列过滤器出现: ${q}`)
  assert.match(q!, /"10"/, '数字词项应被引号包裹')
})

test('save_memory 标题带时间戳(修复前 no such column: 10)可正常落库', async () => {
  const m = mk('ag-fts-a')
  const saved = await m.save({
    title: '跨频道写入冻结窗口 2026-10-07(演示线1 · z1/z2/z3 + 配方)',
    content: '冻结期内对线1 z1/z2/z3 SP 与配方零写入,直至对方收敛确认回执。',
    scope: 'shared',
  })
  assert.ok(saved.dedupKey.length > 0)
  const hits = await m.recallRows('冻结窗口 零写入', { scope: 'shared' })
  assert.ok(hits.length >= 1, '落库后应可检索到')
})

test('近邻合并语义保留:标题重合+数值一致 → 并入既有条目', async () => {
  const a = mk('ag-fts-b')
  await a.save({ title: '线1熔体温度恢复作业结论', content: 'SP 227,熔体 208.6', scope: 'shared' })
  const b = mk('ag-fts-c')
  await b.save({ title: '线1熔体温度恢复作业结论', content: 'SP 227,熔体 208.6', scope: 'shared' })
  const hits = await b.recallRows('熔体温度恢复', { scope: 'shared' })
  assert.ok(hits.length >= 1)
  const row = hits.find(h => h.content.includes('并存确认 ag-fts-c'))
  assert.ok(row, '应命中并入后的既有条目(带后写者并存确认标注)')
})
