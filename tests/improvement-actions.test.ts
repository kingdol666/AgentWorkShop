/**
 * 元层成效表（WP-C3）：动作结果计数 + 成功率聚合 + 幂等。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-rsi-c3-'))
delete process.env.AW_BENCH_MODE

const { openWorkshopDb } = await import('../server/services/workshop/db/database')
const { createImprovementActionRepo } = await import('../server/services/workshop/db/improvement-action.repo')

test('记录 + 幂等（同 subject+decision 只记一次）', () => {
  const db = openWorkshopDb(':memory:')
  try {
    const repo = createImprovementActionRepo(db)
    assert.equal(repo.record({ actionKind: 'recipe_update', subjectKind: 'proposal', subjectId: 'ip-1', decision: 'accepted' }), true)
    assert.equal(repo.record({ actionKind: 'recipe_update', subjectKind: 'proposal', subjectId: 'ip-1', decision: 'accepted' }), false, '幂等')
    assert.equal(repo.record({ actionKind: 'recipe_update', subjectKind: 'proposal', subjectId: 'ip-1', decision: 'rejected' }), true, '不同 decision 可另记')
  }
  finally {
    db.close()
  }
})

test('成功率聚合：accepted+promoted 计成功；按 action_kind 分组；channel 收窄', () => {
  const db = openWorkshopDb(':memory:')
  try {
    const repo = createImprovementActionRepo(db)
    repo.record({ actionKind: 'recipe_update', subjectKind: 'proposal', subjectId: 'a', decision: 'accepted', channelId: 'ch-1' })
    repo.record({ actionKind: 'recipe_update', subjectKind: 'proposal', subjectId: 'b', decision: 'accepted', channelId: 'ch-1' })
    repo.record({ actionKind: 'recipe_update', subjectKind: 'proposal', subjectId: 'c', decision: 'rejected', channelId: 'ch-1' })
    repo.record({ actionKind: 'kb_ingest', subjectKind: 'proposal', subjectId: 'd', decision: 'accepted', channelId: 'ch-2' })
    repo.record({ actionKind: 'profile_promote', subjectKind: 'harness_profile', subjectId: 'p', decision: 'promoted', channelId: 'ch-1' })

    const all = repo.stats()
    const byKind = new Map(all.map(s => [s.actionKind, s]))
    assert.equal(byKind.get('recipe_update')!.total, 3)
    assert.equal(byKind.get('recipe_update')!.success, 2)
    assert.equal(byKind.get('recipe_update')!.rate, 0.667)
    assert.equal(byKind.get('profile_promote')!.rate, 1)

    const ch1 = repo.stats('ch-1')
    assert.deepEqual(ch1.map(s => s.actionKind).sort(), ['profile_promote', 'recipe_update'])
    assert.equal(ch1.find(s => s.actionKind === 'recipe_update')!.total, 3)
    const ch2 = repo.stats('ch-2')
    assert.equal(ch2.length, 1)
    assert.equal(ch2[0]!.actionKind, 'kb_ingest')
  }
  finally {
    db.close()
  }
})

test('空表：stats 返回空集（不报错）', () => {
  const db = openWorkshopDb(':memory:')
  try {
    assert.deepEqual(createImprovementActionRepo(db).stats(), [])
  }
  finally {
    db.close()
  }
})
