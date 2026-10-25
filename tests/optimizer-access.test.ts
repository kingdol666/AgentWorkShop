/** D16 统一操作授权单测:Profile 用户私有 / 拒绝审计恰 1 条 / 配置动作入册。 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import type { ResolvedUser } from '../server/api/workshop/caller'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-optimizer-access-'))

const { openWorkshopDb } = await import('../server/services/workshop/db/database/open')
const { configureAmlRuntime } = await import('../server/services/workshop/aml/runtime')
const { bindOpsRepos } = await import('../server/services/workshop/ops/ops')
const { createAuditRepo } = await import('../server/services/workshop/db/ops.repo')
const { createProfileRepo } = await import('../server/services/workshop/optimization/profile.repo')
const { canSeeProfile, recordConfigAction, assertOptimizationAccess } = await import('../server/services/workshop/optimization/access')

const db = openWorkshopDb(join(process.env.AW_HOME!, 'access.sqlite'))
configureAmlRuntime(db)
bindOpsRepos({ audit: createAuditRepo(db) })
const profileRepo = createProfileRepo(db)

const admin = { id: 'u-admin', name: 'Admin', role: 'admin' } as ResolvedUser
const alice = { id: 'u-alice', name: 'Alice', role: 'editor' } as ResolvedUser
const bob = { id: 'u-bob', name: 'Bob', role: 'editor' } as ResolvedUser

function baseProfile(id: string): Record<string, unknown> {
  return {
    schemaVersion: 1, id, version: 1, name: id,
    modelRef: { modelId: 'mdl-1', artifactKind: 'linear_state_space@1', artifactHash: '', modelInterface: 'linear_state_space', stage: 'production' },
    problemTemplateRef: 'linear_mpc_quadratic@1',
    problemConfig: { linear_mpc_quadratic: { cvWeights: { cv1: 1 }, duWeights: { mv1: 0.1 }, terminalWeight: 1, targets: { cv1: 50 } } },
    solverRef: 'osqp_mpc@1', solverVersion: '1', processSpecRef: 'spec-1@1', conditionIds: [], status: 'draft',
  }
}

function auditCount(action: string): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM audit_log WHERE action = ?').get(action) as { n: number }).n
}

function denied(fn: () => unknown): AppError {
  try {
    fn()
  }
  catch (e) {
    return e as AppError
  }
  throw new Error('expected denial')
}

after(() => {
  try {
    rmSync(process.env.AW_HOME!, { recursive: true, force: true })
  }
  catch { /* 并行会话可能已清理 */ }
})

test('profile 是用户私有:owner 可读可发布,cross-user 拒绝且恰 1 条拒绝审计', () => {
  profileRepo.insert(baseProfile('optp-x') as never, alice.id)
  assert.equal(assertOptimizationAccess(alice, 'read', { kind: 'profile', id: 'optp-x' }).agentInstanceId, undefined)
  const before = auditCount('tool.call.denied')
  const err = denied(() => assertOptimizationAccess(bob, 'read', { kind: 'profile', id: 'optp-x' }))
  assert.equal(err.status, 403)
  assert.equal(err.code, 'AUTHZ_DENIED')
  assert.equal(auditCount('tool.call.denied'), before + 1)
  assert.equal(denied(() => assertOptimizationAccess(bob, 'publish', { kind: 'profile', id: 'optp-x' })).status, 403)
  assert.equal(assertOptimizationAccess(admin, 'publish', { kind: 'profile', id: 'optp-x' }).agentInstanceId, undefined)
  // 列表过滤口径
  assert.equal(canSeeProfile(bob, { owner_user_id: alice.id }), false)
  assert.equal(canSeeProfile(admin, { owner_user_id: alice.id }), true)
  assert.equal(canSeeProfile(alice, { owner_user_id: alice.id }), true)
})

test('404 不算授权失败(不写拒绝审计)', () => {
  const before = auditCount('tool.call.denied')
  assert.equal(denied(() => assertOptimizationAccess(alice, 'read', { kind: 'profile', id: 'nope' })).status, 404)
  assert.equal(auditCount('tool.call.denied'), before)
})

test('recordConfigAction 每次恰 1 条配置审计', () => {
  recordConfigAction(alice, 'optimizer.profile.create', { kind: 'optimizer_profile', id: 'p@1' }, '登记 P')
  recordConfigAction(alice, 'optimizer.profile.publish', { kind: 'optimizer_profile', id: 'p@1' }, '发布 P')
  assert.equal(auditCount('optimizer.profile.create'), 1)
  assert.equal(auditCount('optimizer.profile.publish'), 1)
})
