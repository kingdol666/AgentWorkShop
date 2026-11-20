/**
 * Task 7:反射 outbox 崩溃恢复 + 运维面追证。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-governed-reflection-'))
delete process.env.AW_BENCH_MODE

const { openWorkshopDb } = await import('../server/services/workshop/db/database')
const { enqueueReflection, drainReflectionEffects, experiencePanelDetail } = await import('../server/services/workshop/experience/reflection-effects')
const { setVersionState } = await import('../server/services/workshop/experience/versions')

const draft = (over: Record<string, unknown> = {}) => ({
  experienceId: 'exp-rfl',
  scope: { kind: 'line' as const, key: 'ln-1' },
  claim: {
    productId: 'prod-a', recipeRevision: 'rev-1', variable: '保压压力SP', unit: 'MPa',
    direction: 'increase' as const, condition: '', polarity: 'support' as const,
  },
  content: '反射生成的候选',
  observedAt: '2026-11-20T10:00:00.000Z',
  evidence: [{
    id: 'ev-rfl', sourceKind: 'task' as const, environment: 'simulation' as const,
    observedAt: '2026-11-20T10:00:00.000Z', supportUnitId: 'run-1', polarity: 'support' as const,
  }],
  idempotencyKey: 'reflect:task:t-1',
  ...over,
})

test('reflection_survives_commit_then_process_exit', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aw-rfl-db-'))
  const path = join(dir, 'workshop.db')
  const first = openWorkshopDb(path)
  first.exec('PRAGMA foreign_keys = OFF')
  enqueueReflection(first, { sourceKind: 'task-terminal', sourceId: 't-1', idempotencyKey: 'reflect:task:t-1', draft: draft() })
  // 同幂等键重复登记不产生第二行
  enqueueReflection(first, { sourceKind: 'task-terminal', sourceId: 't-1', idempotencyKey: 'reflect:task:t-1', draft: draft() })
  first.close()

  // 模拟进程重启:重开同一库再补扫
  const second = openWorkshopDb(path)
  second.exec('PRAGMA foreign_keys = OFF')
  const report = drainReflectionEffects(second)
  assert.equal(report.reflected, 1)
  assert.equal(report.versionIds.length, 1)
  const again = drainReflectionEffects(second)
  assert.equal(again.reflected, 0)
  const detail = experiencePanelDetail(second, 'exp-rfl')
  assert.equal(detail.versionId, report.versionIds[0])
  assert.equal(detail.lifecycle, 'candidate')
  assert.ok(detail.auditActions.includes('created'))
  second.close()
})

test('unrecoverable reflection is marked failed after bounded retries and unauthorized is quarantined', () => {
  const db = openWorkshopDb(':memory:')
  db.exec('PRAGMA foreign_keys = OFF')
  // 契约错误:缺 experienceId,每次重试都失败
  enqueueReflection(db, { sourceKind: 'review', sourceId: 'r-1', idempotencyKey: 'bad-1', draft: draft({ experienceId: '' }) })
  enqueueReflection(db, { sourceKind: 'review', sourceId: 'r-2', idempotencyKey: 'unauth-1', draft: draft({ experienceId: 'exp-2' }) })
  const first = drainReflectionEffects(db, { maxAttempts: 2, authorize: e => e.idempotencyKey !== 'unauth-1' })
  assert.equal(first.quarantined, 1)
  assert.equal(first.failed, 1)
  const second = drainReflectionEffects(db, { maxAttempts: 2, authorize: () => true })
  assert.equal(second.failed, 1)
  const row = db.prepare(`SELECT state, attempts FROM experience_reflection_outbox WHERE idempotency_key = 'bad-1'`).get() as { state: string, attempts: number }
  assert.equal(row.state, 'failed')
  assert.equal(row.attempts, 2)
  const q = db.prepare(`SELECT state FROM experience_reflection_outbox WHERE idempotency_key = 'unauth-1'`).get() as { state: string }
  assert.equal(q.state, 'quarantined')
})

test('operator_follows_use_to_evidence', () => {
  const db = openWorkshopDb(':memory:')
  db.exec('PRAGMA foreign_keys = OFF')
  enqueueReflection(db, { sourceKind: 'task-terminal', sourceId: 't-9', idempotencyKey: 'follow-1', draft: draft({ experienceId: 'exp-follow' }) })
  const report = drainReflectionEffects(db)
  const usedVersionId = report.versionIds[0]!
  const panel = experiencePanelDetail(db, 'exp-follow')
  assert.equal(panel.versionId, usedVersionId, '运维面必须能从一个使用追到准确版本')
  setVersionState(db, usedVersionId, { lifecycle: 'validated', deployment: 'active' }, 'reviewer')
  const after = experiencePanelDetail(db, 'exp-follow')
  assert.equal(after.lifecycle, 'validated')
  assert.equal(after.deployment, 'active')
  assert.ok(after.auditActions.includes('state'))
  // 未授权 DTO:不存在的条目不返回正文或候选计数
  const empty = experiencePanelDetail(db, 'exp-missing')
  assert.equal(empty.versionId, null)
  assert.equal('content' in empty, false)
})
