/**
 * 记忆中心批次 2：独立观测单元证据门 + 显式部署链。
 *
 * 覆盖：
 *  - 两次**不同 run** 的干预经验可以合并并晋升（旧门要求 taskIds，干预-only 永远过不了）；
 *  - 同一 run 的多个事件只算 1 个单元（单观测不得自证）；
 *  - 晋升后 deployment=none（不注入）→ 显式 deploy 才 active → withdraw 停止；
 *  - 连续两次 deploy 不抛嵌套事务；同域部署撤下旧 active，跨频道不误撤。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-exp-deploy-'))
delete process.env.AW_BENCH_MODE

const { openWorkshopDb } = await import('../server/services/workshop/db/database')
const { createMemoryRepo } = await import('../server/services/workshop/db/memory.repo')
const { mergeExperiences, promoteExperience } = await import('../server/services/workshop/experience/promote')
const { deployExperience } = await import('../server/services/workshop/experience/deploy')
const { getVersion, headVersionId, ensureLegacyVersion, setVersionState } = await import('../server/services/workshop/experience/versions')
const { evaluateExperienceGate } = await import('../server/services/workshop/experience/gates')
const { transactionDepth } = await import('../server/services/workshop/db/transaction')

;(globalThis as unknown as { __workshopManager?: unknown }).__workshopManager = { channelModeOf: () => 'production_line_integrated' }

function fixture() {
  const db = openWorkshopDb(':memory:')
  db.exec('PRAGMA foreign_keys = OFF')
  return { db, repo: createMemoryRepo(db) }
}

function seed(repo: ReturnType<typeof createMemoryRepo>, dedupKey: string, unitId: string, channelId = 'ch-1'): string {
  return repo.upsertExperience({
    channelId,
    agentId: 'agent-a',
    kind: 'experience',
    title: `干预经验 ${dedupKey}`,
    titleFts: `干 预 经 验 ${dedupKey}`,
    content: '熔体温度上调 2℃ 后 PV 跟随',
    importance: 0.8,
    dedupKey,
    outcome: 'positive',
    evidence: {
      interventionEventId: `evt-${unitId}`,
      recipeRunId: unitId.replace(/^run:/, ''),
      supportUnits: [{ id: unitId, kind: 'run', verdict: 'identifiable_effect' }],
    },
    scopeKind: 'channel',
    scopeKey: '',
    status: 'candidate',
  }).id
}

test('两次不同 run 的干预经验：可合并 → 可晋升（旧门不可能通过）', () => {
  const { db, repo } = fixture()
  try {
    const a = seed(repo, 'exp:run-a', 'run:r1')
    const b = seed(repo, 'exp:run-b', 'run:r2')
    const merged = mergeExperiences(db, { channelId: 'ch-1', memoryIds: [a, b], actor: 'u-1' })
    assert.equal(merged.ok, true, merged.reasons.join('；'))
    const promoted = promoteExperience(db, { memoryId: merged.memoryId!, channelId: 'ch-1', to: 'validated', actor: 'u-1' })
    assert.equal(promoted.ok, true, promoted.reasons.join('；'))
    const head = headVersionId(db, merged.memoryId!)
    assert.ok(head, '晋升应确保版本头存在')
    assert.equal(getVersion(db, head!)!.lifecycle, 'validated')
    assert.equal(getVersion(db, head!)!.deployment, 'none', '晋升≠部署：deployment 保持 none')
    assert.equal(repo.getById(merged.memoryId!)!.status, 'validated')
  }
  finally {
    db.close()
  }
})

test('同一 run 的多次事件只算 1 个单元：合并后仍不足', () => {
  const { db, repo } = fixture()
  try {
    const a = seed(repo, 'exp:same-1', 'run:r1')
    const b = seed(repo, 'exp:same-2', 'run:r1')
    const merged = mergeExperiences(db, { channelId: 'ch-1', memoryIds: [a, b], actor: 'u-1' })
    assert.equal(merged.ok, false)
    assert.match(merged.reasons.join('；'), /独立观测证据仍不足/)
  }
  finally {
    db.close()
  }
})

test('门：underpowered/confounded 判读不计入可用证据', () => {
  const under = evaluateExperienceGate({
    status: 'candidate',
    outcome: 'unknown',
    evidenceJson: JSON.stringify({ supportUnits: [
      { id: 'run:r1', kind: 'run', verdict: 'underpowered' },
      { id: 'run:r2', kind: 'run', verdict: 'confounded' },
    ] }),
  }, 'validated')
  assert.equal(under.allowed, false)
  const ok = evaluateExperienceGate({
    status: 'candidate',
    outcome: 'unknown',
    evidenceJson: JSON.stringify({ supportUnits: [
      { id: 'run:r1', kind: 'run', verdict: 'identifiable_effect' },
      { id: 'run:r2', kind: 'run', verdict: 'no_resolvable_effect' },
    ] }),
  }, 'validated')
  assert.equal(ok.allowed, true)
})

test('部署：none → active → withdrawn → 再 active（无嵌套事务）', () => {
  const { db, repo } = fixture()
  try {
    const id = seed(repo, 'exp:deploy', 'run:r9')
    const merged = mergeExperiences(db, { channelId: 'ch-1', memoryIds: [id, seed(repo, 'exp:deploy-2', 'run:r10')], actor: 'u-1' })
    assert.equal(merged.ok, true, merged.reasons.join('；'))
    assert.equal(promoteExperience(db, { memoryId: merged.memoryId!, channelId: 'ch-1', to: 'validated', actor: 'u-1' }).ok, true)
    assert.equal(repo.experienceDeployment(merged.memoryId!), 'none')

    const deployed = deployExperience(db, { memoryId: merged.memoryId!, channelId: 'ch-1', target: 'active', actor: 'u-1' })
    assert.equal(deployed.ok, true, deployed.reasons.join('；'))
    assert.equal(repo.experienceDeployment(merged.memoryId!), 'active')

    const withdrawn = deployExperience(db, { memoryId: merged.memoryId!, channelId: 'ch-1', target: 'withdrawn', actor: 'u-1' })
    assert.equal(withdrawn.ok, true, withdrawn.reasons.join('；'))
    assert.equal(repo.experienceDeployment(merged.memoryId!), 'withdrawn')

    const again = deployExperience(db, { memoryId: merged.memoryId!, channelId: 'ch-1', target: 'active', actor: 'u-1' })
    assert.equal(again.ok, true, again.reasons.join('；'))
    assert.equal(transactionDepth(), 0, '事务必须闭合')
  }
  finally {
    db.close()
  }
})

test('部署域：同频道撤下旧 active；其他频道不误撤', () => {
  const { db, repo } = fixture()
  try {
    const a = seed(repo, 'exp:dom-a', 'run:d1', 'ch-1')
    const b = seed(repo, 'exp:dom-b', 'run:d2', 'ch-1')
    const other = seed(repo, 'exp:dom-c', 'run:d3', 'ch-2')
    for (const id of [a, b, other]) {
      db.prepare(`UPDATE agent_memories SET status='validated' WHERE id=?`).run(id)
      const v = ensureLegacyVersion(db, id)!
      setVersionState(db, v, { lifecycle: 'validated', deployment: 'none' }, 'u-1')
    }
    assert.equal(deployExperience(db, { memoryId: a, channelId: 'ch-1', target: 'active', actor: 'u-1' }).ok, true)
    const second = deployExperience(db, { memoryId: b, channelId: 'ch-1', target: 'active', actor: 'u-1' })
    assert.equal(second.ok, true, second.reasons.join('；'))
    assert.equal(second.withdrawnSiblings, 1, '同频道只撤下 1 条旧 active')
    assert.equal(repo.experienceDeployment(a), 'withdrawn')
    assert.equal(repo.experienceDeployment(other), 'none', '其他频道未部署，不应被牵连')
  }
  finally {
    db.close()
  }
})
