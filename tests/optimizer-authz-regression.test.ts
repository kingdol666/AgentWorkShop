/** Optimizer 建议引用与撤权的跨 Agent/Channel 回归;使用真实仓储,不调用设备。 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import type { ResolvedUser } from '../server/api/workshop/caller'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-optimizer-authz-'))

const { openWorkshopDb } = await import('../server/services/workshop/db/database/open')
const { configureAmlRuntime } = await import('../server/services/workshop/aml/runtime')
const { getBindingRepo } = await import('../server/services/workshop/optimization/binding.repo')
const { getRunRepo } = await import('../server/services/workshop/optimization/run.repo')
const { revokeBindingForUser } = await import('../server/services/workshop/optimization/rest-auth')
const { toolOptimizerPlanGet } = await import('../server/services/workshop/agents/industrial/optimizer-tools')

const db = openWorkshopDb(join(process.env.AW_HOME, 'optimizer-authz.sqlite'))
configureAmlRuntime(db)
const now = new Date().toISOString()
db.prepare(`INSERT INTO channels (id, name, description, enabled, owner_user_id, created_at, updated_at)
  VALUES ('ch-own','own','',1,'owner',?,?), ('ch-other','other','',1,'other-owner',?,?)`).run(now, now, now, now)
db.prepare(`INSERT INTO workspaces (id, owner_user_id, name, created_at) VALUES ('ws','owner','w',?)`).run(now)
for (const [agent, channel] of [['ca-own', 'ch-own'], ['ca-other', 'ch-other'], ['ca-revoke-owner', 'ch-own'], ['ca-revoke-admin', 'ch-other']]) {
  db.prepare(`INSERT INTO channel_agents (id, channel_id, name, harness, token, created_at, updated_at)
    VALUES (?, ?, ?, 'mock', ?, ?, ?)`).run(agent, channel, agent, `token-${agent}`, now, now)
  getBindingRepo().insert({
    id: `binding-${agent}`, workspaceId: 'ws', channelId: channel!, channelAgentId: agent!,
    profileId: 'profile', profileVersion: 1, capabilities: ['plan_get'], mode: 'recommendation',
  })
}

function run(id: string, agent: string): string[] {
  db.prepare(`INSERT INTO optimizer_runs (id, binding_id, binding_revision, profile_id, profile_version,
    problem_ir_hash, context_snapshot_json, problem_ir_json, status, diagnostics_json, started_at)
    VALUES (?, ?, 1, 'profile', 1, 'hash', '{}', '{}', 'optimal', '{}', ?)`).run(id, `binding-${agent}`, now)
  return getRunRepo().insertCandidates(id, [0, 1].map(seq => ({
    seq, controls: [[seq + 1]], predicted: [[seq + 2]], cost: seq, constraints: [], feasible: true,
  })))
}

function recommendation(id: string, runId: string, candidateId: string): void {
  getRunRepo().insertRecommendation({
    id, runId, candidateId, problemIrHash: 'hash', modelArtifactHash: 'model-hash',
    evidenceSource: 'simulation', uqEvidence: null, status: 'unverified',
    validUntil: new Date(Date.now() + 60_000).toISOString(),
  })
}

const ownCandidates = run('run-own', 'ca-own')
const ownOtherCandidates = run('run-own-other', 'ca-own')
const foreignCandidates = run('run-other', 'ca-other')
run('run-bad-candidate', 'ca-own')
run('run-empty', 'ca-own')
recommendation('rec-own', 'run-own', ownCandidates[0]!)
recommendation('rec-own-other', 'run-own-other', ownOtherCandidates[0]!)
recommendation('rec-other', 'run-other', foreignCandidates[0]!)
// 模拟历史/损坏行:数据库外键存在,但建议与候选属于不同运行。
recommendation('rec-bad-candidate', 'run-bad-candidate', foreignCandidates[1]!)
recommendation('rec-revoke-owner', 'run-revoke-owner', run('run-revoke-owner', 'ca-revoke-owner')[0]!)
recommendation('rec-revoke-admin', 'run-revoke-admin', run('run-revoke-admin', 'ca-revoke-admin')[0]!)

const managerGlobal = globalThis as { __workshopManager?: unknown }
const previousManager = managerGlobal.__workshopManager
managerGlobal.__workshopManager = {
  deps: { repos: { channelAgents: { findById: (id: string) => db.prepare('SELECT channel_id AS channelId FROM channel_agents WHERE id = ?').get(id) } } },
  channelPermissionsOf(channelId: string, user: ResolvedUser) {
    const channel = db.prepare('SELECT owner_user_id AS owner FROM channels WHERE id = ?').get(channelId) as { owner: string }
    const isOwner = channel.owner === user.id
    return { isMember: isOwner || (channelId === 'ch-own' && user.id === 'member'), canManage: isOwner || user.role === 'admin' }
  },
}
after(() => {
  managerGlobal.__workshopManager = previousManager
  db.close()
})

const user = (id: string, role = 'editor'): ResolvedUser => ({ id, name: id, role, createdAt: now })

test('plan_get 混合 snake/camel 参数同样校验建议所属运行', async () => {
  for (const args of [
    { run_id: 'run-own', recommendationId: 'rec-other' },
    { runId: 'run-own', recommendation_id: 'rec-other' },
  ]) {
    const result = await toolOptimizerPlanGet('ca-own', args)
    assert.equal(result.isError, true)
    assert.match(result.text, /^BINDING_NOT_OWNED:/)
  }
})

for (const [runKey, recommendationKey] of [['run_id', 'recommendation_id'], ['runId', 'recommendationId']] as const) {
  test(`plan_get ${runKey}: 自己的 run 不能掩盖他人的建议`, async () => {
    for (const args of [
      { [runKey]: 'run-own', [recommendationKey]: 'rec-other' },
      { [recommendationKey]: 'rec-other' },
    ]) {
      const result = await toolOptimizerPlanGet('ca-own', args)
      assert.equal(result.isError, true)
      assert.match(result.text, /^BINDING_NOT_OWNED:/)
      assert.ok(!result.text.includes('controls'))
    }
  })

  test(`plan_get ${runKey}: 显式建议必须存在,并与运行/候选同源`, async () => {
    const mismatch = await toolOptimizerPlanGet('ca-own', { [runKey]: 'run-own', [recommendationKey]: 'rec-own-other' })
    assert.equal(mismatch.isError, true)
    assert.match(mismatch.text, /^PLAN_REF_MISMATCH:/)
    const missing = await toolOptimizerPlanGet('ca-own', { [runKey]: 'run-own', [recommendationKey]: 'rec-missing' })
    assert.equal(missing.isError, true)
    assert.match(missing.text, /^PLAN_NOT_FOUND:/)
    const candidateMismatch = await toolOptimizerPlanGet('ca-own', { [recommendationKey]: 'rec-bad-candidate' })
    assert.equal(candidateMismatch.isError, true)
    assert.match(candidateMismatch.text, /^PLAN_REF_MISMATCH:/)
  })

  test(`plan_get ${runKey}: 合法运行单参/建议单参/双参继续可用`, async () => {
    for (const args of [
      { [runKey]: 'run-own' },
      { [recommendationKey]: 'rec-own' },
      { [runKey]: 'run-own', [recommendationKey]: 'rec-own' },
    ]) {
      const result = await toolOptimizerPlanGet('ca-own', args)
      assert.ok(!result.isError, result.text)
      const plan = JSON.parse(result.text)
      assert.equal(plan.runId, 'run-own')
      assert.equal(plan.recommendation.id, 'rec-own')
      assert.equal(plan.candidate.id, ownCandidates[0])
    }
    const empty = await toolOptimizerPlanGet('ca-own', { [runKey]: 'run-empty' })
    assert.ok(!empty.isError, empty.text)
    assert.equal(JSON.parse(empty.text).recommendation, null)
  })
}

test('binding 撤权:跨 Channel editor 与普通成员均拒绝,绑定和建议不变', () => {
  for (const actor of [user('outsider'), user('member')]) {
    assert.throws(() => revokeBindingForUser(actor, 'binding-ca-revoke-owner'),
      (err: { status?: number, code?: string }) => err.status === 403 && err.code === 'SCOPE_VIOLATION')
    assert.ok(getBindingRepo().get('binding-ca-revoke-owner'))
    assert.equal(getRunRepo().getRecommendation('rec-revoke-owner')?.status, 'unverified')
  }
})

test('binding 撤权:owner/editor 与 admin 均可撤销,只失效对应建议', () => {
  revokeBindingForUser(user('owner'), 'binding-ca-revoke-owner')
  assert.equal(getBindingRepo().get('binding-ca-revoke-owner'), undefined)
  assert.equal(getRunRepo().getRecommendation('rec-revoke-owner')?.status, 'expired')
  assert.equal(getRunRepo().getRecommendation('rec-revoke-admin')?.status, 'unverified')
  revokeBindingForUser(user('administrator', 'admin'), 'binding-ca-revoke-admin')
  assert.equal(getBindingRepo().get('binding-ca-revoke-admin'), undefined)
  assert.equal(getRunRepo().getRecommendation('rec-revoke-admin')?.status, 'expired')
  assert.equal(getRunRepo().getRecommendation('rec-own')?.status, 'unverified')
})

test('binding 撤权:不存在的绑定不修改其他建议', () => {
  assert.throws(() => revokeBindingForUser(user('administrator', 'admin'), 'missing'),
    (err: { status?: number, code?: string }) => err.status === 404 && err.code === 'BINDING_NOT_FOUND')
  assert.equal(getRunRepo().getRecommendation('rec-own')?.status, 'unverified')
})
