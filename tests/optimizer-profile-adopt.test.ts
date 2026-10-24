/**
 * 模型采纳闭环(OW-adopt)单测:
 *   propose(草稿新版本+卡) → HITL 批准(单一咽喉) → 发布 + 自动重绑(revision+1) + 审计;
 *   拒绝 → 零写;D21 不兼容 → 422;未知模型/基线 → 404;工具面登记断言。
 */
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-profile-adopt-'))

const { openWorkshopDb } = await import('../server/services/workshop/db/database/open')
const { configureAmlRuntime, getAmlRuntime } = await import('../server/services/workshop/aml/runtime')
const { bindOpsRepos } = await import('../server/services/workshop/ops/ops')
const { createAuditRepo } = await import('../server/services/workshop/db/ops.repo')
const { createProfileRepo, parseProfileRow } = await import('../server/services/workshop/optimization/profile.repo')
const { createBindingRepo, getBindingRepo } = await import('../server/services/workshop/optimization/binding.repo')
const { resetOntologyRepo } = await import('../server/services/workshop/ontology/repo')
const svc = await import('../server/services/workshop/optimization/profile-adopt.service')

const db = openWorkshopDb(join(process.env.AW_HOME!, 'adopt.sqlite'))
configureAmlRuntime(db)
resetOntologyRepo()
try {
  bindOpsRepos({ audit: createAuditRepo(db) })
}
catch { /* 重复装配无害 */ }

const now = new Date().toISOString()
const rt = getAmlRuntime()

// ── 夹具:数据集/作业/实验 + 两个模型(线性合格 + ONNX 旧工件)+ Profile v1(published)+ 绑定 ──
rt.repo.dataset.insert({ id: 'ds-a', lineId: 'ln-1', productId: 'pd-1', recipeId: 'rc-1', runIds: [], specJson: '{}', sha256: 'x', rowCount: 1, fromMs: 0, toMs: 1, path: 'p', createdBy: 't', createdByKind: 'user', note: '', createdAt: now })
rt.repo.job.insert({ id: 'job-a', datasetId: 'ds-a', purpose: 'mpc_surrogate', budget: {}, createdAt: now })
rt.repo.job.setState('job-a', 'training', 'train', 10)
rt.repo.job.setState('job-a', 'evaluating', 'evaluate', 80)
rt.repo.experiment.insert({ id: 'exp-a', jobId: 'job-a', datasetId: 'ds-a', changeNote: '', configJson: '{}', createdAt: now })
rt.repo.model.insert({ id: 'mdl-v1', experimentId: 'exp-a', datasetId: 'ds-a', productId: 'pd-1', recipeId: 'rc-1', purpose: 'mpc_surrogate', ioSpecJson: '{}', metricsJson: '{}', path: 'z', createdBy: 't', note: '', lineId: 'ln-1', createdAt: now, artifactKind: 'linear_state_space@1', modelInterface: 'linear_state_space' })
rt.repo.model.insert({ id: 'mdl-v2', experimentId: 'exp-a', datasetId: 'ds-a', productId: 'pd-1', recipeId: 'rc-1', purpose: 'mpc_surrogate', ioSpecJson: '{}', metricsJson: '{}', path: 'x', createdBy: 't', note: '新训练模型', lineId: 'ln-1', createdAt: now, artifactKind: 'linear_state_space@1', modelInterface: 'linear_state_space' })
rt.repo.model.insert({ id: 'mdl-onnx', experimentId: 'exp-a', datasetId: 'ds-a', productId: 'pd-1', recipeId: 'rc-1', purpose: 'mpc_surrogate', ioSpecJson: '{}', metricsJson: '{}', path: 'y', createdBy: 't', note: '', lineId: 'ln-1', createdAt: now, artifactKind: 'onnx_one_step@1', modelInterface: 'one_step' })

const profileRepo = createProfileRepo(db)
const profileV1 = {
  schemaVersion: 1 as const, id: 'optp-adopt', version: 1,
  modelRef: { modelId: 'mdl-v1', artifactKind: 'linear_state_space@1' as const, artifactHash: 'a'.repeat(64), modelInterface: 'linear_state_space' as const, stage: 'candidate' as const },
  problemTemplateRef: 'linear_mpc_quadratic@1' as const,
  problemConfig: { linear_mpc_quadratic: { cvWeights: { cv1: 1 }, duWeights: { mv1: 0.1 }, terminalWeight: 2, targets: { cv1: 50 } } },
  solverRef: 'osqp_mpc@1' as const, solverVersion: '1', processSpecRef: 'pms-adopt@1', conditionIds: [], status: 'draft' as const,
}
profileRepo.insert(profileV1, 'u1')
profileRepo.publish('optp-adopt', 1)

db.prepare(`INSERT INTO channels (id, name, description, enabled, created_at, updated_at) VALUES ('ch-a','c','',1,?,?)`).run(now, now)
db.prepare(`INSERT INTO channel_agents (id, channel_id, name, harness, token, created_at, updated_at) VALUES ('ca-a','ch-a','a','mock','t1',?,?)`).run(now, now)
db.prepare(`INSERT INTO workspaces (id, owner_user_id, name, created_at) VALUES ('ws-a','u1','w',?)`).run(now)
db.prepare(`INSERT INTO workspace_channels (workspace_id, channel_id, created_at) VALUES ('ws-a','ch-a',?)`).run(now)
const bindingRepo = createBindingRepo(db)
bindingRepo.insert({ id: 'ob-a', workspaceId: 'ws-a', channelId: 'ch-a', channelAgentId: 'ca-a', profileId: 'optp-adopt', profileVersion: 1, capabilities: ['solve'], mode: 'recommendation' })

const ACTING = { id: 'u-human', name: '工艺管理员' }

test('propose:复制已发布配置+换新模型 → 草稿 v2 + 卡;未批准前零发布', async () => {
  let captured: { nodeId: string, payload: unknown } | null = null
  const result = await svc.proposeProfileAdoption({
    agentInstanceId: 'ca-a', initiatorId: 'ca-a', initiatorKind: 'agent',
    profileId: 'optp-adopt', modelId: 'mdl-v2', reason: 'oneStepTest nrmse 0.0009 优于现网',
    deps: { requestApproval: async (_a, nodeId, _k, _d, opts) => {
      captured = { nodeId, payload: opts?.payload }
      return { approved: false, comment: '测试路径:拒绝', choice: null }
    } },
  })
  assert.equal(result.cardId, 'optimizer-profile:optp-adopt@2')
  assert.equal(result.priorVersion, 1)
  assert.equal(result.published, false)
  assert.equal(result.rebindCount, 0)
  const draft = profileRepo.get('optp-adopt', 2)!
  assert.equal(draft.status, 'draft')
  const parsed = parseProfileRow(draft)
  assert.equal(parsed.modelRef.modelId, 'mdl-v2')
  assert.equal(parsed.problemTemplateRef, 'linear_mpc_quadratic@1')
  assert.ok(captured && String(captured.nodeId).startsWith('optimizer-profile:'))
  assert.equal((captured!.payload as { schemaVersion: number }).schemaVersion, 1)
})

test('decide(approve):发布 v2 + 自动重绑(revision+1) + 审计', async () => {
  const before = getBindingRepo().get('ob-a')!
  assert.equal(before.profileVersionNumber, 1)
  const result = await svc.decideProfileAdoption({
    cardId: 'optimizer-profile:optp-adopt@2', approved: true, comment: '指标更优,批准采纳', actingUser: ACTING, via: 'decide-endpoint',
    deps: { decideApproval: () => {} },
  })
  assert.equal(result.handled, true)
  assert.equal(result.approved, true)
  assert.deepEqual(result.published, { profileId: 'optp-adopt', version: 2, rebindCount: 1 })
  const v2 = profileRepo.get('optp-adopt', 2)!
  assert.equal(v2.status, 'published')
  const after = getBindingRepo().get('ob-a')!
  assert.equal(after.profileVersionNumber, 2)
  assert.equal(after.revision, before.revision + 1)
  const audit = (db.prepare('SELECT action FROM audit_log WHERE target_id = \'optp-adopt@2\' ORDER BY at DESC').all() as Array<{ action: string }>).map(r => r.action)
  assert.ok(audit.includes('optimizer.profile.adopt'), `缺采纳审计:${audit.join(',')}`)
  assert.ok(audit.includes('optimizer.profile.adopt_propose'))
})

test('采纳后的绑定直接可解:profileVersion=2 无需人工重绑', () => {
  const binding = getBindingRepo().get('ob-a')!
  const profile = profileRepo.get(binding.profileId, binding.profileVersionNumber)!
  assert.equal(profile.status, 'published')
  assert.equal(parseProfileRow(profile).modelRef.modelId, 'mdl-v2')
})

test('decide(reject):零写(草稿保留、版本不发布)', async () => {
  await svc.proposeProfileAdoption({
    agentInstanceId: 'ca-a', initiatorId: 'ca-a', initiatorKind: 'agent',
    profileId: 'optp-adopt', modelId: 'mdl-v2', reason: '再提议',
    deps: { requestApproval: async () => ({ approved: false, comment: 'stub', choice: null }) },
  })
  const decided = await svc.decideProfileAdoption({
    cardId: 'optimizer-profile:optp-adopt@3', approved: false, comment: '证据不足', actingUser: ACTING, via: 'hitl/respond',
    deps: { decideApproval: () => {} },
  })
  assert.equal(decided.approved, false)
  assert.equal(decided.code, 'PROFILE_ADOPT_REJECTED')
  assert.equal(profileRepo.get('optp-adopt', 3)!.status, 'draft')
  assert.equal(getBindingRepo().get('ob-a')!.profileVersionNumber, 2)
})

test('D21 兼容性:ONNX 工件 + OSQP 提议 → 422,不产生草稿', async () => {
  const before = profileRepo.nextVersion('optp-adopt')
  await assert.rejects(() => svc.proposeProfileAdoption({
    agentInstanceId: 'ca-a', initiatorId: 'ca-a', initiatorKind: 'agent',
    profileId: 'optp-adopt', modelId: 'mdl-onnx', reason: '不该被允许',
    deps: { requestApproval: async () => ({ approved: true, comment: '', choice: null }) },
  }), (err: { code?: string }) => err.code === 'UNSUPPORTED_MODEL_SOLVER')
  assert.equal(profileRepo.nextVersion('optp-adopt'), before, '不应产生新版本行')
})

test('未知模型 / 无已发布基线 → 404', async () => {
  await assert.rejects(() => svc.proposeProfileAdoption({
    agentInstanceId: 'ca-a', initiatorId: 'ca-a', profileId: 'optp-adopt', modelId: 'mdl-ghost', reason: 'x',
    deps: { requestApproval: async () => ({ approved: true, comment: '', choice: null }) },
  }), (err: { code?: string }) => err.code === 'MODEL_NOT_FOUND')
  await assert.rejects(() => svc.proposeProfileAdoption({
    agentInstanceId: 'ca-a', initiatorId: 'ca-a', profileId: 'optp-none', modelId: 'mdl-v2', reason: 'x',
    deps: { requestApproval: async () => ({ approved: true, comment: '', choice: null }) },
  }), (err: { code?: string }) => err.code === 'PROFILE_NOT_PUBLISHED')
})

test('工具面登记:optimizer_profile_propose 进 host-tools/grant-guard/INDUSTRIAL_HANDLERS', () => {
  const tools = JSON.parse(readFileSync('.AgentWorkShop/prompts/host-tools.json', 'utf8')) as Array<Record<string, unknown>>
  const tool = tools.find(t => t.name === 'optimizer_profile_propose')
  assert.ok(tool, 'host-tools.json 缺 optimizer_profile_propose')
  assert.equal(tool.riskClass, 'write')
  assert.ok(String(tool.description).length >= 40)
  const grantGuard = readFileSync('server/services/workshop/agents/industrial/grant-guard.ts', 'utf8')
  assert.ok(grantGuard.includes('\'optimizer_profile_propose\''), 'grant-guard WRITE_TOOLS 缺成员')
  assert.ok(grantGuard.includes('args.profile_id'), 'resolveTargetLines 应识别 profile_id')
  const handlers = readFileSync('server/services/workshop/agents/host-tool-bridge/tools/industrial.ts', 'utf8')
  assert.ok(handlers.includes('[\'optimizer_profile_propose\','), 'INDUSTRIAL_HANDLERS 缺登记')
  const dispatcher = readFileSync('server/services/workshop/agents/hitl-decision/dispatcher.ts', 'utf8')
  assert.ok(dispatcher.includes('isProfileAdoptCard'), 'dispatcher 缺采纳卡分支')
  const decideRoute = readFileSync('server/api/workshop/agent-tools/approvals/[id]/decide.post.ts', 'utf8')
  assert.ok(decideRoute.includes('isProfileAdoptCard'), 'decide 端点缺采纳卡分支')
})
