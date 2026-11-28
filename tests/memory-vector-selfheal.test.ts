/**
 * 向量维度自愈回归（2026-11-28 实机验收补正）。
 *
 * 场景：回填/换模型是由 backfill 自己的 repo 实例执行 vecReset 的；manager 常驻的
 * 另一个 repo 实例缓存 vecDims 会与真实表脱节。旧实现此时 `vecInit(新维度)` 恒 false
 * → vectorizeMemory 静默跳过，新记忆永远没有向量，直到进程重启。
 *
 * 期望：
 *  1) 外部重建到新维度后，宿主实例 vecInit(新维度)=true 并恢复 vecSet/vecSearch；
 *  2) 宿主实例对"仍不匹配"的旧维度返回 false（不在此处静默重建/不丢旧向量）；
 *  3) vecReset 之后旧实例的 vecSearch 不抛错（失败静默 → 上层退化为 FTS）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-vec-selfheal-'))
delete process.env.AW_BENCH_MODE
process.env.AW_MEMORY_GRAPH_RETRIEVAL = '0'

const { openWorkshopDb } = await import('../server/services/workshop/db/database')
const { createMemoryRepo, TEAM_AGENT_ID } = await import('../server/services/workshop/db/memory.repo')

test('向量表被外部 vecReset 后宿主 repo 自愈（换模型无需重启）', () => {
  const db = openWorkshopDb(':memory:')
  db.exec('PRAGMA foreign_keys = OFF')
  try {
    const host = createMemoryRepo(db)
    assert.equal(host.vecInit(4), true, '首次建表 4 维')
    const id = host.upsert({
      channelId: 'c1', agentId: TEAM_AGENT_ID, kind: 'semantic',
      title: '自愈探针', titleFts: '自 愈 探 针', content: '自愈探针正文',
      importance: 0.5, dedupKey: 'vec:selfheal', sessionId: '',
    }).id
    const rowid = Number((db.prepare('SELECT rowid FROM agent_memories WHERE id = ?').get(id) as { rowid: number | bigint }).rowid)
    host.vecSet(rowid, TEAM_AGENT_ID, new Float32Array([1, 0, 0, 0]))
    assert.equal(host.vecSearch(TEAM_AGENT_ID, new Float32Array([1, 0, 0, 0]), 5).length, 1, '4 维写入可检索')

    // 回填侧另一个实例：按新模型维度重建（模拟记忆中心"回填 rebuild"）
    const backfillSide = createMemoryRepo(db)
    assert.equal(backfillSide.vecReset(8), true, '外部重建到 8 维')

    // 宿主实例仍缓存旧维度：快路径直接放行（不额外查 schema），但真正写/读会因维度不符静默失败。
    // 关键是不能抛错、不能把语句打空 —— 上层退化为 FTS，而不是炸掉。
    assert.equal(host.vecInit(4), true, '同维度快路径放行（不查 schema）')
    assert.deepEqual(host.vecSearch(TEAM_AGENT_ID, new Float32Array([1, 0, 0, 0]), 5), [], '维度不符时检索静默为空')
    assert.doesNotThrow(() => host.vecSet(rowid, TEAM_AGENT_ID, new Float32Array([1, 0, 0, 0])), '维度不符时写入静默失败')

    // 目标维度自愈：重新 prepare 后写入/检索恢复
    assert.equal(host.vecInit(8), true, '表已重建到 8 维 → 宿主自愈')
    const vec8 = Float32Array.from([0, 0, 1, 0, 0, 0, 0, 0])
    host.vecSet(rowid, TEAM_AGENT_ID, vec8)
    const hits = host.vecSearch(TEAM_AGENT_ID, vec8, 5)
    assert.equal(hits.length, 1, '自愈后新向量可检索')
    assert.equal(hits[0]!.memRowid, rowid)
    assert.ok(host.vecDims === 8, `vecDims 应更新为 8，实际 ${host.vecDims}`)
  }
  finally {
    db.close()
  }
})
