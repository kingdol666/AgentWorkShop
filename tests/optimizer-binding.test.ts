/**
 * G4 绑定作用域与实例身份(A17):
 *  - 模板 id 拒绝;channel/workspace 不一致拒绝;
 *  - 多绑定 → BINDING_AMBIGUOUS;他人 binding → BINDING_NOT_OWNED;过期 → BINDING_STALE;
 *  - 成员删除 → 绑定级联删除。
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-optimizer-binding-'))

const { openWorkshopDb } = await import('../server/services/workshop/db/database/open')
const { configureAmlRuntime } = await import('../server/services/workshop/aml/runtime')
const { createBinding, resolveBinding, listBindingsForAgent } = await import('../server/services/workshop/optimization/binding.service')
const { createProfileRepo } = await import('../server/services/workshop/optimization/profile.repo')
const { getBindingRepo } = await import('../server/services/workshop/optimization/binding.repo')

const db = openWorkshopDb(join(process.env.AW_HOME!, 'binding.sqlite'))
configureAmlRuntime(db)
const now = new Date().toISOString()

// 夹具:两个 workspace / 两个 channel / 两个 agent 实例 + 一个模板
db.prepare(`INSERT INTO workspaces (id, owner_user_id, name, created_at) VALUES ('ws-1','u1','w1',?), ('ws-2','u1','w2',?)`).run(now, now)
db.prepare(`INSERT INTO channels (id, name, description, enabled, created_at, updated_at) VALUES ('ch-1','c1','',1,?,?), ('ch-2','c2','',1,?,?)`).run(now, now, now, now)
db.prepare(`INSERT INTO workspace_channels (workspace_id, channel_id, created_at) VALUES ('ws-1','ch-1',?), ('ws-2','ch-2',?)`).run(now, now)
db.prepare(`INSERT INTO agents (id, name, harness, created_at, updated_at) VALUES ('tpl-1','tpl','mock',?,?)`).run(now, now)
db.prepare(`INSERT INTO channel_agents (id, channel_id, template_id, name, harness, token, created_at, updated_at) VALUES ('ca-1','ch-1','tpl-1','a1','mock','tok-1',?,?), ('ca-2','ch-2','tpl-1','a2','mock','tok-2',?,?)`).run(now, now, now, now)

const rt = { db }
function profile(id: string, modelId: string) {
  return {
    schemaVersion: 1 as const, id, version: 1,
    modelRef: { modelId, artifactKind: 'linear_state_space@1' as const, artifactHash: 'h', modelInterface: 'linear_state_space' as const, stage: 'candidate' as const },
    problemTemplateRef: 'linear_mpc_quadratic@1' as const,
    problemConfig: { linear_mpc_quadratic: { cvWeights: { cv1: 1 }, duWeights: { mv1: 0.1 }, terminalWeight: 1, targets: { cv1: 1 } } },
    solverRef: 'osqp_mpc@1' as const, solverVersion: '1', processSpecRef: 'pms@1', conditionIds: [], status: 'draft' as const,
  }
}

// 模型行(绑定解析会查 stage;这里用最小谱系)
db.prepare(`INSERT INTO aml_datasets (id, line_id, product_id, recipe_id, spec_json, sha256, path, created_at) VALUES ('ds-b','ln-1','pd-1','rc-1','{}','x','p',?)`).run(now)
db.prepare(`INSERT INTO aml_jobs (id, dataset_id, purpose, status, created_at) VALUES ('job-b','ds-b','mpc_surrogate','evaluating',?)`).run(now)
db.prepare(`INSERT INTO aml_experiments (id, job_id, dataset_id, created_at) VALUES ('exp-b','job-b','ds-b',?)`).run(now)
db.prepare(`INSERT INTO aml_models (id, experiment_id, dataset_id, product_id, recipe_id, purpose, stage, path, created_at) VALUES ('mdl-a','exp-b','ds-b','pd-1','rc-1','mpc_surrogate','candidate','x',?), ('mdl-b','exp-b','ds-b','pd-1','rc-1','mpc_surrogate','candidate','x',?)`).run(now, now)

test('模板 id 明确拒绝(AGENT_TEMPLATE_ID_NOT_ALLOWED)', () => {
  const repo = createProfileRepo(db)
  repo.insert(profile('optp-1', 'mdl-a'))
  repo.publish('optp-1', 1)
  assert.throws(() => createBinding({ workspaceId: 'ws-1', channelId: 'ch-1', agentInstanceId: 'tpl-1', profileId: 'optp-1', profileVersion: 1 }), (err: { code?: string }) => err.code === 'AGENT_TEMPLATE_ID_NOT_ALLOWED')
})

test('channel/workspace 归属不一致拒绝', () => {
  const repo = createProfileRepo(db)
  repo.insert(profile('optp-1', 'mdl-a'))
  repo.publish('optp-1', 1)
  assert.throws(() => createBinding({ workspaceId: 'ws-1', channelId: 'ch-2', agentInstanceId: 'ca-2', profileId: 'optp-1', profileVersion: 1 }), (err: { code?: string }) => err.code === 'BINDING_WORKSPACE_MISMATCH')
  assert.throws(() => createBinding({ workspaceId: 'ws-1', channelId: 'ch-1', agentInstanceId: 'ca-2', profileId: 'optp-1', profileVersion: 1 }), (err: { code?: string }) => err.code === 'BINDING_CHANNEL_MISMATCH')
})

test('多绑定 → 歧义;他人绑定 → NOT_OWNED;唯一绑定可默认', () => {
  const repo = createProfileRepo(db)
  repo.insert(profile('optp-1', 'mdl-a'))
  repo.publish('optp-1', 1)
  repo.insert(profile('optp-2', 'mdl-b'))
  repo.publish('optp-2', 1)
  const b1 = createBinding({ workspaceId: 'ws-1', channelId: 'ch-1', agentInstanceId: 'ca-1', profileId: 'optp-1', profileVersion: 1 })
  const resolved = resolveBinding('ca-1')
  assert.equal(resolved.binding.id, b1.id)
  resolved.lease.release()
  const b2 = createBinding({ workspaceId: 'ws-1', channelId: 'ch-1', agentInstanceId: 'ca-1', profileId: 'optp-2', profileVersion: 1 })
  assert.throws(() => resolveBinding('ca-1'), (err: { code?: string }) => err.code === 'BINDING_AMBIGUOUS')
  const explicit = resolveBinding('ca-1', b2.id)
  assert.equal(explicit.binding.id, b2.id)
  explicit.lease.release()
  // 其他 Agent 不能用这个 binding
  assert.throws(() => resolveBinding('ca-2', b1.id), (err: { code?: string }) => err.code === 'BINDING_NOT_FOUND' || err.code === 'BINDING_NOT_OWNED')
})

test('有效期过期 → BINDING_STALE;成员删除 → 绑定级联', () => {
  const repo = createProfileRepo(db)
  repo.insert(profile('optp-1', 'mdl-a'))
  repo.publish('optp-1', 1)
  // ca-2 唯一绑定但已过期
  const expired = createBinding({
    workspaceId: 'ws-2', channelId: 'ch-2', agentInstanceId: 'ca-2', profileId: 'optp-1', profileVersion: 1,
    validTo: new Date(Date.now() - 60_000).toISOString(),
  })
  assert.throws(() => resolveBinding('ca-2', expired.id), (err: { code?: string }) => err.code === 'BINDING_STALE')
  const before = getBindingRepo().listByAgent('ca-1').length
  assert.ok(before >= 1)
  db.prepare('DELETE FROM channel_agents WHERE id = ?').run('ca-1')
  assert.equal(listBindingsForAgent('ca-1').length, 0)
  void rt
})
