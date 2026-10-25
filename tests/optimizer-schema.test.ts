/**
 * G1 表/仓储/引用保护:十张新表可建;spec/profile 发布不可变;被引用模型拒删(A19)。
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-optimizer-schema-'))

const { openWorkshopDb } = await import('../server/services/workshop/db/database/open')
const { configureAmlRuntime, getAmlRuntime } = await import('../server/services/workshop/aml/runtime')
const { createProcessModelSpecRepo, specContentHash, parseSpecRow } = await import('../server/services/workshop/process-model/spec.repo')
const { createProfileRepo } = await import('../server/services/workshop/optimization/profile.repo')
const { assertModelNotReferenced, modelReferences } = await import('../server/services/workshop/aml/model-references')
const { createBindingRepo } = await import('../server/services/workshop/optimization/binding.repo')

const db = openWorkshopDb(join(process.env.AW_HOME!, 'optimizer-schema.sqlite'))
configureAmlRuntime(db)

const TABLES = [
  'process_model_specs', 'process_context_segments', 'process_model_eligibility', 'process_model_experiments',
  'optimizer_profiles', 'optimizer_bindings', 'optimizer_runs', 'optimizer_candidates',
  'optimizer_recommendations', 'optimizer_outcomes',
]

test('新表全部由 schema.ts 建出(启动即存在)', () => {
  const names = new Set((db.prepare('SELECT name FROM sqlite_master WHERE type = \'table\'').all() as Array<{ name: string }>).map(r => r.name))
  for (const table of TABLES) assert.ok(names.has(table), `缺表 ${table}`)
})

function spec(version = 1) {
  return {
    schemaVersion: 2 as const, id: 'pms-schema', version,
    lineId: 'ln-1', productId: 'pd-1', recipeId: 'rc-1', recipeVersion: 1,
    conditions: [{ id: 'c1', match: [{ field: 'recipeId' as const, op: 'eq' as const, value: 'rc-1' }] }],
    variables: [
      { id: 'mv1', nodeId: 'n-mv', role: 'mv' as const, field: 'value' as const, unit: 'bar', scale: 1, offset: 0, delayMs: 0, min: 0, max: 100 },
      { id: 'cv1', nodeId: 'n-cv', role: 'cv' as const, field: 'value' as const, unit: 'μm', scale: 1, offset: 0, min: 0, max: 200 },
    ],
    timing: { beatMs: 5000, historySteps: 12, horizonSteps: 5, fixedDt: true as const },
    trainer: { ref: 'linear_arx@1' as const, config: { arOrder: 1, inputOrder: 1, ridgeLambda: 0, standardize: true } },
    datasetPolicy: { split: { valRatio: 0.2, testRatio: 0.2, seed: 1 } },
    gatePolicyRef: 'process-model.gates@1' as const,
    modelInterface: { id: 'linear_state_space' as const, version: 1, inputSemantics: 'setpoint' as const, mode: 'state_space' as const },
    effectiveDomain: { mv: { mv1: { min: 0, max: 100 } } },
    purpose: 'mpc_surrogate' as const,
  }
}

test('Spec 仓储:内容 hash 稳定;同版本不同内容拒绝;发布后不可改', () => {
  const repo = createProcessModelSpecRepo(db)
  const row = repo.insert(spec(1), { ownerUserId: 'u1' })
  assert.equal(row.status, 'draft')
  assert.equal(row.contentHash, specContentHash(spec(1)))
  assert.equal(parseSpecRow(row).id, 'pms-schema')
  // 幂等:完全相同内容重复登记返回同一行
  assert.equal(repo.insert(spec(1)).id, row.id)
  // 同 (id,version) 内容不同 → 拒绝
  const changed = { ...spec(1), note: 'changed' }
  assert.throws(() => repo.insert(changed), (err: { code?: string }) => err.code === 'SPEC_VERSION_IMMUTABLE')
  // 发布 → published
  assert.equal(repo.publish('pms-schema', 1).status, 'published')
  // 新版本独立
  const v2 = repo.insert(spec(2))
  assert.equal(v2.version, 2)
  assert.equal(repo.nextVersion('pms-schema'), 3)
})

test('Profile 仓储:OSQP 只能配线性工件;发布冻结 hash;retired 不可发布', () => {
  const repo = createProfileRepo(db)
  const profile = {
    schemaVersion: 1 as const, id: 'optp-schema', version: 1,
    modelRef: { modelId: 'mdl-x', artifactKind: 'linear_state_space@1' as const, artifactHash: 'h', modelInterface: 'linear_state_space' as const, stage: 'candidate' as const },
    problemTemplateRef: 'linear_mpc_quadratic@1' as const,
    problemConfig: { linear_mpc_quadratic: { cvWeights: { cv1: 1 }, duWeights: { mv1: 0.1 }, terminalWeight: 1, targets: { cv1: 50 } } },
    solverRef: 'osqp_mpc@1' as const, solverVersion: '1', processSpecRef: 'pms-schema@1',
    conditionIds: [], status: 'draft' as const,
  }
  const row = repo.insert(profile, 'u1')
  assert.equal(row.status, 'draft')
  assert.equal(repo.publish('optp-schema', 1, 'hash-1').problemIrHash, 'hash-1')
  const retired = repo.retire('optp-schema', 1)
  assert.equal(retired.status, 'retired')
  assert.throws(() => repo.publish('optp-schema', 1), (err: { code?: string }) => err.code === 'PROFILE_RETIRED')
  // ONNX 工件 + OSQP → PROFILE_INCOMPATIBLE
  assert.throws(() => repo.insert({ ...profile, id: 'optp-bad', modelRef: { ...profile.modelRef, artifactKind: 'onnx_one_step@1' } }), (err: { code?: string }) => err.code === 'UNSUPPORTED_MODEL_SOLVER')
})

test('A19 引用保护:被 optimizer profile / 训练计划 / 渠道绑定引用的模型拒删', () => {
  const rt = getAmlRuntime()
  const now = new Date().toISOString()
  rt.repo.dataset.insert({ id: 'ds-ref', lineId: 'ln-1', productId: 'pd-1', recipeId: 'rc-1', runIds: [], specJson: '{}', sha256: 'x', rowCount: 1, fromMs: 0, toMs: 1, path: 'p', createdBy: 't', createdByKind: 'user', note: '', createdAt: now })
  rt.repo.job.insert({ id: 'job-ref', datasetId: 'ds-ref', purpose: 'mpc_surrogate', budget: {}, createdAt: now })
  rt.repo.job.setState('job-ref', 'training', 'train', 10)
  rt.repo.job.setState('job-ref', 'evaluating', 'evaluate', 80)
  rt.repo.experiment.insert({ id: 'exp-ref', jobId: 'job-ref', datasetId: 'ds-ref', changeNote: '', configJson: '{}', createdAt: now })
  rt.repo.model.insert({
    id: 'mdl-ref', experimentId: 'exp-ref', datasetId: 'ds-ref', productId: 'pd-1', recipeId: 'rc-1', purpose: 'mpc_surrogate',
    ioSpecJson: '{}', metricsJson: '{}', path: 'x', createdBy: 't', note: '', lineId: 'ln-1', createdAt: now,
    artifactKind: 'linear_state_space@1', modelInterface: 'linear_state_space',
  })
  assert.deepEqual(modelReferences(db, 'mdl-ref'), [])
  createProfileRepo(db).insert({
    schemaVersion: 1, id: 'optp-ref', version: 1,
    modelRef: { modelId: 'mdl-ref', artifactKind: 'linear_state_space@1', artifactHash: 'h', modelInterface: 'linear_state_space', stage: 'candidate' },
    problemTemplateRef: 'linear_mpc_quadratic@1',
    problemConfig: { linear_mpc_quadratic: { cvWeights: { cv1: 1 }, duWeights: { mv1: 0.1 }, terminalWeight: 1, targets: { cv1: 1 } } },
    solverRef: 'osqp_mpc@1', solverVersion: '1', processSpecRef: 'pms-schema@1', conditionIds: [], status: 'draft',
  })
  const refs = modelReferences(db, 'mdl-ref')
  assert.ok(refs.some(r => r.kind === 'optimizer_profile'))
  assert.throws(() => assertModelNotReferenced(db, 'mdl-ref'), (err: { code?: string }) => err.code === 'MODEL_IN_USE')

  // 绑定仓储:同一实例同 profile 版本唯一
  const bindingRepo = createBindingRepo(db)
  db.prepare(`INSERT INTO channels (id, name, description, enabled, created_at, updated_at) VALUES ('ch-1','c','',1,?,?)`).run(now, now)
  db.prepare(`INSERT INTO channel_agents (id, channel_id, name, harness, token, created_at, updated_at) VALUES ('ca-1','ch-1','a','mock','t1',?,?)`).run(now, now)
  db.prepare(`INSERT INTO workspaces (id, owner_user_id, name, created_at) VALUES ('ws-1','u1','w',?)`).run(now)
  db.prepare(`INSERT INTO workspace_channels (workspace_id, channel_id, created_at) VALUES ('ws-1','ch-1',?)`).run(now)
  bindingRepo.insert({ id: 'ob-1', workspaceId: 'ws-1', channelId: 'ch-1', channelAgentId: 'ca-1', profileId: 'optp-ref', profileVersion: 1, capabilities: ['solve'], mode: 'recommendation' })
  assert.throws(() => bindingRepo.insert({ id: 'ob-2', workspaceId: 'ws-1', channelId: 'ch-1', channelAgentId: 'ca-1', profileId: 'optp-ref', profileVersion: 1, capabilities: ['solve'], mode: 'recommendation' }), (err: { code?: string }) => err.code === 'BINDING_DUPLICATE')
  // 删除成员 → 绑定级联删除
  db.prepare('DELETE FROM channel_agents WHERE id = ?').run('ca-1')
  assert.equal(bindingRepo.listByAgent('ca-1').length, 0)
})
