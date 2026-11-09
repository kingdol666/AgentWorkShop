/**
 * RSI 改进提案（WP-D2）：幂等建提案 / 状态收口 / 读面过滤。
 * 纯内存库；验证「提案只描述，不产生任何写动作」与 dedup 幂等。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-rsi-d2-'))
delete process.env.AW_BENCH_MODE

const { openWorkshopDb } = await import('../server/services/workshop/db/database')
const { createImprovementRepo, markRecipeProposalsAccepted } = await import('../server/services/workshop/db/improvement.repo')
const { handleImprovementList } = await import('../server/services/workshop/agents/host-tool-bridge/tools/improvement')

function fixture() {
  const db = openWorkshopDb(':memory:')
  db.exec('PRAGMA foreign_keys = OFF')
  return { db, repo: createImprovementRepo(db) }
}

const base = {
  kind: 'recipe_update' as const,
  channelId: 'ch-1',
  lineId: 'line-1',
  recipeId: 'rc-1',
  sourceKind: 'intervention',
  sourceId: 'ie-1',
  title: '配方固化候选：均热段 220→218.5',
  detail: '判定 identifiable_effect，effect=-1.48',
  evidence: { interventionEventId: 'ie-1', recipeRunId: 'run-1', metrics: { effect: -1.48 } },
}

test('建提案：幂等（同 source 重复事件不新增）+ 证据 JSON 落库', () => {
  const { db, repo } = fixture()
  try {
    const first = repo.create(base)
    assert.equal(first.created, true)
    const dup = repo.create({ ...base, title: '重复事件' })
    assert.equal(dup.created, false, '同 dedup_key 不新增')
    assert.equal(dup.id, first.id)
    const row = repo.get(first.id)!
    assert.equal(row.status, 'pending')
    assert.equal(row.recipeId, 'rc-1')
    assert.equal(row.dedupKey, 'prop:intervention:ie-1')
    assert.deepEqual(JSON.parse(row.evidenceJson).interventionEventId, 'ie-1')
    assert.equal(repo.listByChannel('ch-1').length, 1)
  }
  finally {
    db.close()
  }
})

test('状态收口：markStatus 与配方固化批量收口（只影响该配方的 pending）', () => {
  const { db, repo } = fixture()
  try {
    const a = repo.create({ ...base, sourceId: 'ie-a', recipeId: 'rc-1' })
    const b = repo.create({ ...base, sourceId: 'ie-b', recipeId: 'rc-1' })
    const c = repo.create({ ...base, sourceId: 'ie-c', recipeId: 'rc-2' })
    const n = markRecipeProposalsAccepted(db, 'rc-1', 'agent-a')
    assert.equal(n, 2, '仅 rc-1 的两条 pending 被收口')
    assert.equal(repo.get(a.id)!.status, 'accepted')
    assert.equal(repo.get(b.id)!.status, 'accepted')
    assert.equal(repo.get(c.id)!.status, 'pending', '其他配方不受影响')
    assert.equal(repo.get(a.id)!.decidedBy, 'agent-a')

    assert.equal(repo.markStatus(c.id, 'rejected', 'owner'), true)
    assert.equal(repo.get(c.id)!.status, 'rejected')
    assert.deepEqual(repo.countsByStatus('ch-1'), { accepted: 2, rejected: 1 })
    // 幂等：再收口一次为 0（已无 pending）
    assert.equal(markRecipeProposalsAccepted(db, 'rc-1', 'agent-a'), 0)
  }
  finally {
    db.close()
  }
})

test('读面：status 过滤 / limit / 空集文案', async () => {
  const { db, repo } = fixture()
  try {
    repo.create({ ...base, sourceId: 'ie-1' })
    const acc = repo.create({ ...base, sourceId: 'ie-2' })
    repo.markStatus(acc.id, 'accepted', 'owner')

    const ws = {
      listImprovementProposals: async (input: { status?: 'pending' | 'accepted' | 'rejected' | 'expired', limit?: number }) =>
        repo.listByChannel('ch-1', input).map(r => ({
          id: r.id, kind: r.kind, lineId: r.lineId, recipeId: r.recipeId, sourceKind: r.sourceKind,
          sourceId: r.sourceId, title: r.title, detail: r.detail, status: r.status, decidedAt: r.decidedAt, createdAt: r.createdAt,
        })),
    }
    const all = await handleImprovementList({}, ws as never)
    assert.match(all.text, /改进提案（2 条/)
    assert.match(all.text, /提案只是候选/)
    const pending = await handleImprovementList({ status: 'pending' }, ws as never)
    assert.match(pending.text, /status=pending/)
    assert.doesNotMatch(pending.text, /\[accepted\]/)
    const empty = await handleImprovementList({ status: 'expired' }, ws as never)
    assert.match(empty.text, /暂无改进提案/)
  }
  finally {
    db.close()
  }
})
