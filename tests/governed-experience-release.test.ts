/**
 * Task 6:发布门(审计先于部署、CAS、禁自批、禁客户端评测)。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-governed-release-'))
delete process.env.AW_BENCH_MODE

const { openWorkshopDb } = await import('../server/services/workshop/db/database')
const { createExperienceVersion, setVersionState, getVersion } = await import('../server/services/workshop/experience/versions')
const { commitExperienceRelease, acknowledgeReleaseAudit, withdrawExperienceRelease } = await import('../server/services/workshop/experience/release')
const { readLearningAuthorizationEpoch } = await import('../server/services/workshop/experience/trusted-context')

const setup = (db: ReturnType<typeof openWorkshopDb>, kind = 'host-evaluation') => {
  db.exec('PRAGMA foreign_keys = OFF')
  const version = createExperienceVersion(db, {
    experienceId: 'exp-r', scope: { kind: 'line', key: 'ln-1' },
    claim: {
      productId: 'prod-a', recipeRevision: 'rev-1', variable: '保压压力SP', unit: 'MPa',
      direction: 'increase', condition: '', polarity: 'support',
    },
    content: 'release subject', observedAt: '2026-11-20T10:00:00.000Z', evidence: [], idempotencyKey: 'k1',
  }, null)
  setVersionState(db, version.versionId, { lifecycle: 'validated' }, 'reviewer')
  const now = new Date().toISOString()
  db.prepare('INSERT INTO harness_bench_runs(id, channel_id, profile_id, baseline_profile_id, kind, status, p_value, primary_delta, cost_delta, pairs, excluded, seeds_json, per_seed_json, artifact_sha256, created_by, created_at, completed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run('hbr-host', 'ch-1', 'pf-1', '', kind, 'completed', 0.01, 0.1, 0, 12, 0, '[]', '[]', 'sha', 'u-1', now, now)
  return getVersion(db, version.versionId)!
}

const request = (v: { versionId: string, evidenceSnapshotHash: string }, over: Record<string, unknown> = {}) => ({
  versionId: v.versionId,
  evidenceSnapshotHash: v.evidenceSnapshotHash,
  policyVersion: 'governed-v1',
  evaluationRunId: 'hbr-host',
  expectedEpoch: 0,
  reviewDecisionId: 'rev-1',
  requestedBy: 'owner-1',
  reviewedBy: 'reviewer-1',
  ...over,
})

test('release_stays_off_until_durable_audit', () => {
  const db = openWorkshopDb(':memory:')
  const v = setup(db)
  const pending = commitExperienceRelease(db, request(v), { actor: 'owner-1' })
  assert.equal(pending.ok, true)
  assert.equal(getVersion(db, v.versionId)!.deployment, 'none', '审计未确认不得上线')
  const acked = acknowledgeReleaseAudit(db, (pending as { requestId: string }).requestId, { actor: 'owner-1' })
  assert.equal(acked.ok, true)
  assert.equal(getVersion(db, v.versionId)!.deployment, 'active')
})

test('concurrent confirmations activate exactly once', () => {
  const db = openWorkshopDb(':memory:')
  const v = setup(db)
  const pending = commitExperienceRelease(db, request(v), { actor: 'owner-1' }) as { requestId: string }
  const first = acknowledgeReleaseAudit(db, pending.requestId, { actor: 'owner-1' })
  const second = acknowledgeReleaseAudit(db, pending.requestId, { actor: 'owner-1' })
  assert.equal(first.ok, true)
  assert.equal(second.ok, false)
  assert.match(second.state === 'rejected' ? second.reasons.join() : '', /CAS|并发|已激活/)
  assert.equal(getVersion(db, v.versionId)!.deployment, 'active')
})

test('self approval and client-only bench are rejected', () => {
  const db = openWorkshopDb(':memory:')
  const v = setup(db)
  const self = commitExperienceRelease(db, request(v, { reviewedBy: 'owner-1' }), { actor: 'owner-1' })
  assert.equal(self.ok, false)
  assert.ok(self.state === 'rejected' && self.reasons.includes('SELF_APPROVAL_FORBIDDEN'))

  const clientDb = openWorkshopDb(':memory:')
  const cv = setup(clientDb, 'harness-ab-paired')
  const client = commitExperienceRelease(clientDb, request(cv), { actor: 'owner-1' })
  assert.equal(client.ok, false)
  assert.ok(client.state === 'rejected' && client.reasons.includes('CLIENT_BENCH_NOT_RELEASABLE'))
})

test('stale epoch and wrong evidence snapshot are rejected', () => {
  const db = openWorkshopDb(':memory:')
  const v = setup(db)
  const stale = commitExperienceRelease(db, request(v, { expectedEpoch: readLearningAuthorizationEpoch(db) + 5 }), { actor: 'owner-1' })
  assert.equal(stale.ok, false)
  assert.ok(stale.state === 'rejected' && stale.reasons.includes('EPOCH_STALE'))
  const wrong = commitExperienceRelease(db, request(v, { evidenceSnapshotHash: 'deadbeef' }), { actor: 'owner-1' })
  assert.equal(wrong.ok, false)
  assert.ok(wrong.state === 'rejected' && wrong.reasons.includes('EVIDENCE_SNAPSHOT_MISMATCH'))
})

test('release requires validated lifecycle; withdraw stops injection without rewriting facts', () => {
  const db = openWorkshopDb(':memory:')
  const v = setup(db)
  setVersionState(db, v.versionId, { lifecycle: 'candidate' }, 'reviewer')
  const blocked = commitExperienceRelease(db, request(getVersion(db, v.versionId)!), { actor: 'owner-1' })
  assert.equal(blocked.ok, false)
  assert.ok(blocked.state === 'rejected' && blocked.reasons.some(r => r.startsWith('LIFECYCLE_NOT_VALIDATED')))

  const db2 = openWorkshopDb(':memory:')
  const v2 = setup(db2)
  const pending = commitExperienceRelease(db2, request(v2), { actor: 'owner-1' }) as { requestId: string }
  acknowledgeReleaseAudit(db2, pending.requestId, { actor: 'owner-1' })
  const withdrawn = withdrawExperienceRelease(db2, v2.versionId, { actor: 'reviewer-1' }, 'regression')
  assert.equal(withdrawn.ok, true)
  const after = getVersion(db2, v2.versionId)!
  assert.equal(after.deployment, 'withdrawn')
  assert.equal(after.lifecycle, 'validated')
  assert.equal(after.contentHash, v2.contentHash)
})
