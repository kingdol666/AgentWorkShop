/**
 * 晋升门 + 回滚（WP-B3/B4）：判定矩阵 / 执行面审计 / 回滚目标选择。
 * 纯内存库；验证「无 bench 不得登 active」「contested 不得晋级」「回滚选上一版本」。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-rsi-b3-'))
delete process.env.AW_BENCH_MODE

const { openWorkshopDb } = await import('../server/services/workshop/db/database')
const { createMemoryRepo } = await import('../server/services/workshop/db/memory.repo')
const { createTaskRepo } = await import('../server/services/workshop/db/task.repo')
const { createHarnessProfileRepo } = await import('../server/services/workshop/experience/harness-profile')
const { evaluateExperienceGate, evaluateProfileGate, rollbackTarget } = await import('../server/services/workshop/experience/gates')
const { promoteExperience, promoteProfile, rollbackProfile } = await import('../server/services/workshop/experience/promote')
const { recordBenchRun } = await import('../server/services/workshop/experience/bench-run')

function fixture() {
  const db = openWorkshopDb(':memory:')
  db.exec('PRAGMA foreign_keys = OFF')
  return { db, repo: createMemoryRepo(db), profiles: createHarnessProfileRepo(db) }
}

function seedExp(repo: ReturnType<typeof fixture>['repo'], opts: { taskIds?: string[], status?: 'active' | 'candidate' | 'validated' | 'contested' | 'retired', expiresAt?: string | null, dedupKey?: string }) {
  return repo.upsertExperience({
    channelId: 'ch-1', agentId: 'agent-a', kind: 'experience',
    title: '均热段整定', titleFts: '均 热 段 整 定', content: '温差 ±3℃', importance: 0.8,
    dedupKey: opts.dedupKey ?? 'exp:g1',
    outcome: 'positive',
    evidence: { taskIds: opts.taskIds ?? ['t-1', 't-2'] },
    scopeKind: 'line', scopeKey: 'line-1',
    status: (opts.status ?? 'candidate') as never,
    expiresAt: opts.expiresAt ?? null,
  })
}

// ===== 经验门 =====

test('经验门：证据充分 → validated；样本不足/contested/已 retired → 拒绝并说明差多少', () => {
  const ok = evaluateExperienceGate({ status: 'candidate', outcome: 'positive', evidenceJson: '{"taskIds":["t-1","t-2"]}' }, 'validated')
  assert.equal(ok.allowed, true)
  assert.equal(ok.next, 'validated')

  const few = evaluateExperienceGate({ status: 'candidate', outcome: 'positive', evidenceJson: '{"taskIds":["t-1"]}' }, 'validated')
  assert.equal(few.allowed, false)
  assert.match(few.reasons.join(), /独立任务样本不足：1\/2/)

  const contested = evaluateExperienceGate({ status: 'contested', outcome: 'positive', evidenceJson: '{"taskIds":["t-1","t-2"]}' }, 'validated')
  assert.equal(contested.allowed, false)
  assert.match(contested.reasons.join(), /contested/)

  const retired = evaluateExperienceGate({ status: 'retired', outcome: 'positive', evidenceJson: '{"taskIds":["t-1","t-2"]}' }, 'validated')
  assert.equal(retired.allowed, false)

  // 锚点兜底：只有 resultId 锚点、无 taskIds → 不低于 minAnchors 但样本不足
  const anchorOnly = evaluateExperienceGate({ status: 'candidate', outcome: 'positive', evidenceJson: '{"resultId":"r-1"}' }, 'validated')
  assert.equal(anchorOnly.allowed, false)
})

test('经验门：退休判定（过期/人工）+ 幂等拒绝', () => {
  const past = new Date(Date.now() - 86_400_000).toISOString()
  const expired = evaluateExperienceGate({ status: 'active', outcome: 'positive', evidenceJson: '{}', expiresAt: past }, 'retired')
  assert.equal(expired.allowed, true)
  assert.match(expired.reasons.join(), /已过期/)

  const already = evaluateExperienceGate({ status: 'retired', outcome: 'positive', evidenceJson: '{}', expiresAt: null }, 'retired')
  assert.equal(already.allowed, false)
})

test('执行面：promoteExperience 落库 + 审计；非本频道/非经验行拒绝', () => {
  const { db, repo } = fixture()
  try {
    const tasks = createTaskRepo(db)
    const taskIds = ['t-1', 't-2'].map(id => tasks.create({ channelId: 'ch-1', assigneeId: 'agent-a', creatorId: 'agent-a', title: id, state: 'COMPLETED', source: 'channel' }).id)
    const a = seedExp(repo, { taskIds })
    const wrongChannel = promoteExperience(db, { memoryId: a.id, channelId: 'ch-2', to: 'validated', actor: 'u-1' })
    assert.equal(wrongChannel.ok, false)
    const ok = promoteExperience(db, { memoryId: a.id, channelId: 'ch-1', to: 'validated', actor: 'u-1' })
    assert.equal(ok.ok, true)
    assert.equal(repo.getById(a.id)!.status, 'validated')
    // 幂等：再晋升被拒
    assert.equal(promoteExperience(db, { memoryId: a.id, channelId: 'ch-1', to: 'validated', actor: 'u-1' }).ok, false)
  }
  finally {
    db.close()
  }
})

// ===== Profile 门 + 回滚 =====

test('Profile 门：candidate→shadow 允许；shadow→active 无 bench 拒绝；有显著改善通过', () => {
  const c = evaluateProfileGate({ status: 'candidate', version: 1 }, 'shadow')
  assert.equal(c.allowed, true)
  assert.equal(c.next, 'shadow')

  const noBench = evaluateProfileGate({ status: 'shadow', version: 1 }, 'active', null)
  assert.equal(noBench.allowed, false)
  assert.match(noBench.reasons.join(), /缺少配对评测结果/)

  const sig = evaluateProfileGate({ status: 'shadow', version: 1 }, 'active', { pValue: 0.01, primaryDelta: 0.1, costDelta: 0.2 })
  assert.equal(sig.allowed, true)
  assert.match(sig.reasons.join(), /配对显著改善/)

  const nonInferior = evaluateProfileGate({ status: 'shadow', version: 1 }, 'active', { pValue: 0.4, primaryDelta: 0.0, costDelta: 0.02 })
  assert.equal(nonInferior.allowed, true)
  assert.match(nonInferior.reasons.join(), /成本非劣/)

  const regress = evaluateProfileGate({ status: 'shadow', version: 1 }, 'active', { pValue: 0.4, primaryDelta: -0.05, costDelta: 0.0 })
  assert.equal(regress.allowed, false)
  assert.match(regress.reasons.join(), /配对未通过/)

  const notShadow = evaluateProfileGate({ status: 'candidate', version: 1 }, 'active', { pValue: 0.01, primaryDelta: 0.1, costDelta: 0 })
  assert.equal(notShadow.allowed, false, '仅 shadow 可登 active')
})

test('回滚：同频道回退到上一版本；唯一版本/无 active → 拒绝', () => {
  const { db, profiles } = fixture()
  try {
    const v1 = profiles.create({ channelId: 'ch-1', layers: { overlay: 'A' } })
    profiles.markStatus(v1.id, 'active')
    const v2 = profiles.create({ channelId: 'ch-1', layers: { overlay: 'B' } })
    profiles.markStatus(v2.id, 'active')
    assert.equal(profiles.activeOf('ch-1')!.id, v2.id)

    const res = rollbackProfile(db, { channelId: 'ch-1', actor: 'u-1' })
    assert.equal(res.ok, true)
    assert.equal(res.targetId, v1.id)
    assert.equal(profiles.activeOf('ch-1')!.id, v1.id, '回滚后 v1 重新 active')

    // 无 active 的频道
    assert.equal(rollbackProfile(db, { channelId: 'ch-none', actor: 'u-1' }).ok, false)
    // rollbackTarget 纯函数：当前 active 无更早版本 → null
    assert.equal(rollbackTarget([{ id: 'a', version: 1, status: 'active' }], 'a'), null)
  }
  finally {
    db.close()
  }
})

test('故障注入：证据 JSON 损坏 → 门按无锚点拒绝（不抛错、不放行）', () => {
  const decision = evaluateExperienceGate(
    { status: 'candidate', outcome: 'positive', evidenceJson: '{not json', expiresAt: null },
    'validated',
  )
  assert.equal(decision.allowed, false)
  assert.match(decision.reasons.join('；'), /证据锚点缺失|独立任务样本不足/)
})

test('执行面：promoteProfile 需要 bench；落地后单 active 不变量保持', () => {
  const { db, profiles } = fixture()
  try {
    const p = profiles.create({ channelId: 'ch-1', layers: { overlay: 'x' } })
    assert.equal(promoteProfile(db, { profileId: p.id, channelId: 'ch-1', to: 'active', actor: 'u-1' }).ok, false, '非 shadow 直接登 active 被拒')
    assert.equal(promoteProfile(db, { profileId: p.id, channelId: 'ch-1', to: 'shadow', actor: 'u-1' }).ok, true)
    // 2026-11-10:active 必须引用已落库的 benchRunId,不再接受客户端自报三个数字
    assert.equal(promoteProfile(db, {
      profileId: p.id, channelId: 'ch-1', to: 'active', actor: 'u-1',
      bench: { pValue: 0.02, primaryDelta: 0.12, costDelta: 0.01 },
    }).ok, false, '自报 bench 不得登 active(provenance 缺失)')
    const run = recordBenchRun(db, {
      channelId: 'ch-1', actor: 'u-1',
      artifact: { profileId: p.id, pValue: 0.02, perSeed: [{ seed: 1, a: 1.12, b: 1 }, { seed: 2, a: 1.12, b: 1 }, { seed: 3, a: 1.12, b: 1 }] },
    })
    assert.equal(run.ok, true, run.ok ? '' : run.reasons.join('；'))
    const promoted = promoteProfile(db, {
      profileId: p.id, channelId: 'ch-1', to: 'active', actor: 'u-1', benchRunId: (run as { run: { id: string } }).run.id,
    })
    assert.equal(promoted.ok, true, promoted.reasons.join('；'))
    assert.equal(profiles.activeOf('ch-1')!.id, p.id)
    assert.equal(profiles.listByChannel('ch-1').filter(x => x.status === 'active').length, 1)
    // 采纳证据绑定到 profile 行
    const bound = db.prepare('SELECT bench_run_id AS id, promoted_at AS at FROM channel_harness_profiles WHERE id = ?').get(p.id) as { id?: string, at?: string }
    assert.equal(bound.id, (run as { run: { id: string } }).run.id)
    assert.ok(bound.at, 'promoted_at 必须落值')
  }
  finally {
    db.close()
  }
})

test('bench 台账:汇总值必须与 perSeed 复算一致 + 样本量下限 + 不可重复导入', () => {
  const { db, profiles } = fixture()
  try {
    const p = profiles.create({ channelId: 'ch-1', layers: { overlay: 'y' } })
    // 自报 primaryDelta 与 perSeed 不符 → 拒绝
    const mismatch = recordBenchRun(db, {
      channelId: 'ch-1', actor: 'u-1',
      artifact: { profileId: p.id, primaryDelta: 99, perSeed: [{ seed: 1, a: 1, b: 1 }, { seed: 2, a: 1, b: 1 }, { seed: 3, a: 1, b: 1 }] },
    })
    assert.equal(mismatch.ok, false)
    assert.match((mismatch as { reasons: string[] }).reasons.join('；'), /不一致/)
    // 样本量不足 → 拒绝
    const few = recordBenchRun(db, {
      channelId: 'ch-1', actor: 'u-1',
      artifact: { profileId: p.id, perSeed: [{ seed: 1, a: 1, b: 1 }] },
    })
    assert.equal(few.ok, false)
    assert.match((few as { reasons: string[] }).reasons.join('；'), /下限/)
    // 同 artifact 重复导入 → 拒绝(UNIQUE(profile_id, artifact_sha256))
    const artifact = { profileId: p.id, perSeed: [{ seed: 1, a: 1.1, b: 1 }, { seed: 2, a: 1.1, b: 1 }, { seed: 3, a: 1.1, b: 1 }] }
    assert.equal(recordBenchRun(db, { channelId: 'ch-1', actor: 'u-1', artifact }).ok, true)
    assert.equal(recordBenchRun(db, { channelId: 'ch-1', actor: 'u-1', artifact }).ok, false, '重复导入必须拒绝')
  }
  finally {
    db.close()
  }
})

test('回滚目标只能是曾被取代的版本(candidate 不可经回滚直接激活)', () => {
  const versions = [
    { id: 'v1', version: 1, status: 'candidate' as const },
    { id: 'v2', version: 2, status: 'active' as const },
  ]
  assert.equal(rollbackTarget(versions as never, 'v2'), null, '从未晋升的 candidate 不能被回滚激活')
  const withSuperseded = [
    { id: 'v1', version: 1, status: 'superseded' as const },
    { id: 'v2', version: 2, status: 'active' as const },
  ]
  assert.equal(rollbackTarget(withSuperseded as never, 'v2'), 'v1')
})
