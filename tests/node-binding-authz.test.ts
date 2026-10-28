/**
 * 节点级写授权(2026-10-28 双轨授权)单元验收。
 *
 * 授权矩阵(计划 §三):
 *   W(a) = dcw 绑定节点 ∪ 配方绑定覆盖的参数节点
 *   - recipe_trial(带 overrides):每个 override node ∈ W(a)
 *   - recipe_trial(无 overrides):全部参数 ∈ W(a)
 *   - recipe_apply(整批):recipe 绑定 ∨ 全部参数 ⊆ W(a)
 *   - recipe_update / recipe_rollback:仅 recipe 绑定(节点绑定不授予版本权)
 * 另覆盖:换配方(line_id → 活动配方)后节点绑定 Agent 无需新绑定、收权即失活、
 * HITL 三层取最严、tool-verify 写面预检。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-node-binding-authz-'))
delete process.env.AW_BENCH_MODE

const { DcwNode } = await import('../server/services/workshop/dcw/dcw-node')
const { getDcwNodeRepo } = await import('../server/services/workshop/dcw/dcw-node.repo')
const { getDcwProductRepo } = await import('../server/services/workshop/dcw/dcw-product.repo')
const { getDcwRecipeRepo } = await import('../server/services/workshop/dcw/dcw-recipe.repo')
const { getDcwLineRepo } = await import('../server/services/workshop/dcw/dcw-line.repo')
const { setActiveLineRun, clearActiveLineRun } = await import('../server/services/workshop/dcw/line-run')
const { getAgentNodeBindingRepo } = await import('../server/services/workshop/agents/node-bindings.repo')
const { getToolApprovals } = await import('../server/services/workshop/agents/tool-approvals')
const { assertRecipeOperation } = await import('../server/services/workshop/agents/industrial/recipe-gate')
const { resolveRefFaces, verifyIndustrialToolCall } = await import('../server/services/workshop/agents/industrial/tool-verify')
const { toolRecipeTrial } = await import('../server/services/workshop/agents/industrial/ops-tools')
const { openWorkshopDb } = await import('../server/services/workshop/db/database')
const { createAlarmEventRepo, createApprovalHistoryRepo, createApprovalRequestRepo, createAuditRepo } = await import('../server/services/workshop/db/ops.repo')
const { bindOpsRepos } = await import('../server/services/workshop/ops/ops')

const db = openWorkshopDb(join(process.env.AW_HOME!, 'node-binding-authz.sqlite'))
bindOpsRepos({
  approvalHistory: createApprovalHistoryRepo(db),
  alarmEvents: createAlarmEventRepo(db),
  audit: createAuditRepo(db),
  approvalRequests: createApprovalRequestRepo(db),
})

function fixture(id: string) {
  const line = getDcwLineRepo().create({ name: `授权线-${id}`, controlMode: 'auto' })
  const nodes = [1, 2, 3].map((i) => {
    const node = new DcwNode({
      id: `dw-${id}-${i}`,
      templateRef: 'dcw-temp-sp',
      driver: 'mock',
      driverConfig: { key: `${id}-${i}` },
      min: 0,
      max: 100,
      unit: 'C',
      decimals: 1,
      lineId: line.id,
      readIntervalMs: 0,
      holdIntervalMs: null,
    })
    getDcwNodeRepo().insert(node)
    return node
  })
  const product = getDcwProductRepo().create({ name: `产品-${id}`, lineId: line.id })
  const recipes = getDcwRecipeRepo()
  const recipe = recipes.create({
    name: `配方-${id}`,
    productId: product.id,
    opIntervalMs: 0,
    params: nodes.slice(0, 2).map(node => ({ nodeId: node.id, value: 50 })),
  })
  const run = recipes.createRun(recipe)
  setActiveLineRun({
    lineId: line.id,
    runId: run.id,
    recipeId: recipe.id,
    recipeName: recipe.name,
    productId: product.id,
    productName: product.name,
    startedAt: run.startedAt,
    taggedSamples: 0,
  })
  const agentId = `ag-${id}`
  return {
    agentId,
    line,
    nodes,
    recipe,
    recipes,
    cleanup() {
      clearActiveLineRun(line.id)
      for (const active of recipes.listRuns().filter(r => r.recipeId === recipe.id && !r.endedAt)) recipes.closeRun(active.id)
      for (const b of getAgentNodeBindingRepo().byAgent(agentId)) getAgentNodeBindingRepo().unbind(b.id)
    },
  }
}

function expectOk(result: Awaited<ReturnType<typeof assertRecipeOperation>>) {
  assert.equal(result.ok, true, result.ok ? '' : result.text)
  if (!result.ok) throw new Error(result.text)
  return result
}

test('US-03 recipe 绑定 = 配方操作权:update/dispatch/trial 全放行且 auto 线免批', (t) => {
  const f = fixture('recipe-track')
  t.after(f.cleanup)
  getAgentNodeBindingRepo().bind(f.agentId, f.recipe.id, 'recipe', 'auto')
  for (const op of ['update', 'dispatch', 'trial'] as const) {
    const gate = expectOk(assertRecipeOperation(f.agentId, f.recipe, op))
    assert.equal(gate.hitlRequired, false, `${op} 在 auto 配方绑定 + auto 线应免批`)
  }
})

test('US-02 纯 dcw 绑定:trial 只按本次覆盖集判定(单点放行/多点全覆盖放行)', (t) => {
  const f = fixture('dcw-full')
  t.after(f.cleanup)
  const repo = getAgentNodeBindingRepo()
  repo.bind(f.agentId, f.nodes[0]!.id, 'dcw', 'auto')
  repo.bind(f.agentId, f.nodes[1]!.id, 'dcw', 'auto')
  assert.equal(expectOk(assertRecipeOperation(f.agentId, f.recipe, 'trial', [f.nodes[0]!.id])).hitlRequired, false)
  assert.equal(expectOk(assertRecipeOperation(f.agentId, f.recipe, 'trial', [f.nodes[0]!.id, f.nodes[1]!.id])).hitlRequired, false)
  // 整批 apply:全部参数 ⊆ 节点绑定面 → 放行
  expectOk(assertRecipeOperation(f.agentId, f.recipe, 'dispatch'))
})

test('US-03 部分覆盖:apply 整批被拒 + 缺失节点清单点名', (t) => {
  const f = fixture('dcw-partial')
  t.after(f.cleanup)
  getAgentNodeBindingRepo().bind(f.agentId, f.nodes[0]!.id, 'dcw', 'auto')
  // trial 只覆盖已授权节点 → 放行
  expectOk(assertRecipeOperation(f.agentId, f.recipe, 'trial', [f.nodes[0]!.id]))
  // trial 覆盖未授权节点 → 拒,且点名缺失节点
  const trial = assertRecipeOperation(f.agentId, f.recipe, 'trial', [f.nodes[0]!.id, f.nodes[1]!.id])
  assert.equal(trial.ok, false)
  if (!trial.ok) {
    assert.match(trial.text, /不在你的数控节点绑定面内/)
    assert.ok(trial.text.includes(f.nodes[1]!.id), '拒绝文案应点名缺失节点 id')
    assert.ok(trial.text.includes(f.nodes[1]!.name), '拒绝文案应点名缺失节点名称')
  }
  // apply 无 overrides = 全参数 → 部分覆盖拒
  const apply = assertRecipeOperation(f.agentId, f.recipe, 'dispatch')
  assert.equal(apply.ok, false)
  if (!apply.ok) assert.match(apply.text, /补绑这些节点|绑定该配方/)
})

test('US-03 版本操作:dcw 节点绑定不授予 update/rollback', (t) => {
  const f = fixture('dcw-version')
  t.after(f.cleanup)
  const repo = getAgentNodeBindingRepo()
  repo.bind(f.agentId, f.nodes[0]!.id, 'dcw', 'auto')
  repo.bind(f.agentId, f.nodes[1]!.id, 'dcw', 'auto')
  for (const op of ['update', 'rollback'] as const) {
    const gate = assertRecipeOperation(f.agentId, f.recipe, op)
    assert.equal(gate.ok, false)
    if (!gate.ok) assert.match(gate.text, /版本操作|配方级操作权/)
  }
})

test('无任何绑定:全部写操作拒绝(trial 拒绝文案指明绑定面)', (t) => {
  const f = fixture('no-binding')
  t.after(f.cleanup)
  for (const op of ['update', 'dispatch', 'trial', 'rollback'] as const) {
    const gate = assertRecipeOperation(f.agentId, f.recipe, op, [f.nodes[0]!.id])
    assert.equal(gate.ok, false, `${op} 无绑定应拒绝`)
  }
})

test('US-05 收权即失活:撤销 dcw 绑定后 trial 立刻拒绝', (t) => {
  const f = fixture('revoke')
  t.after(f.cleanup)
  const repo = getAgentNodeBindingRepo()
  const b1 = repo.bind(f.agentId, f.nodes[0]!.id, 'dcw', 'auto')
  const b2 = repo.bind(f.agentId, f.nodes[1]!.id, 'dcw', 'auto')
  expectOk(assertRecipeOperation(f.agentId, f.recipe, 'trial', [f.nodes[0]!.id, f.nodes[1]!.id]))
  repo.unbind(b1.id)
  repo.unbind(b2.id)
  const after = assertRecipeOperation(f.agentId, f.recipe, 'trial', [f.nodes[0]!.id, f.nodes[1]!.id])
  assert.equal(after.ok, false)
})

test('HITL 取最严:dcw manual 绑定 / 产线 manual 均强制审批', (t) => {
  const f = fixture('hitl')
  t.after(f.cleanup)
  const repo = getAgentNodeBindingRepo()
  const binding = repo.bind(f.agentId, f.nodes[0]!.id, 'dcw', 'manual')
  assert.equal(expectOk(assertRecipeOperation(f.agentId, f.recipe, 'trial', [f.nodes[0]!.id])).hitlRequired, true)
  // 绑定切 auto(线仍 auto)→ 免批
  repo.setMode(binding.id, 'auto')
  assert.equal(expectOk(assertRecipeOperation(f.agentId, f.recipe, 'trial', [f.nodes[0]!.id])).hitlRequired, false)
  // 线切 manual → 即便绑定 auto 也强制
  getDcwLineRepo().update(f.line.id, { controlMode: 'manual' })
  assert.equal(expectOk(assertRecipeOperation(f.agentId, f.recipe, 'trial', [f.nodes[0]!.id])).hitlRequired, true)
})

test('tool-verify 写面预检:未授权参数节点在进 handler 前被拒,已授权放行', (t) => {
  const f = fixture('verify-write-face')
  t.after(f.cleanup)
  getAgentNodeBindingRepo().bind(f.agentId, f.nodes[0]!.id, 'dcw', 'auto')
  const faces = resolveRefFaces(f.agentId)
  assert.ok(faces.writeFace.has(f.nodes[0]!.id), 'dcw 绑定节点应进入写授权面')
  assert.ok(!faces.writeFace.has(f.nodes[1]!.id), '未绑定节点不应进入写授权面')
  const denied = verifyIndustrialToolCall(f.agentId, 'recipe_trial', {
    recipe_id: f.recipe.id,
    params: [{ node_id: f.nodes[1]!.id, value: 55 }],
    hypothesis: '写面预检',
  })
  assert.ok(denied?.isError, '未授权节点应在 tool-verify 被拒')
  assert.match(denied!.text, /写授权/)
  const allowed = verifyIndustrialToolCall(f.agentId, 'recipe_trial', {
    recipe_id: f.recipe.id,
    params: [{ node_id: f.nodes[0]!.id, value: 55 }],
    hypothesis: '写面预检',
  })
  assert.equal(allowed, null, '已授权节点应通过 tool-verify')
})

test('US-05 撤销 dcw 绑定时:在飞配方审批按拒收敛,零写入', async (t) => {
  const f = fixture('cancel-pending')
  t.after(f.cleanup)
  const repo = getAgentNodeBindingRepo()
  const binding = repo.bind(f.agentId, f.nodes[0]!.id, 'dcw', 'manual')
  const trial = toolRecipeTrial(f.agentId, {
    line_id: f.line.id,
    params: [{ node_id: f.nodes[0]!.id, value: 55 }],
    hypothesis: '收权即失活:撤销节点绑定后审批单必须失效',
  })
  let card = getToolApprovals().listPending(f.agentId)[0]
  for (let i = 0; i < 100 && !card; i++) {
    await new Promise(resolve => setTimeout(resolve, 10))
    card = getToolApprovals().listPending(f.agentId)[0]
  }
  assert.ok(card, 'trial 应挂起一张人工审批卡')
  repo.unbind(binding.id)
  const cancelled = getToolApprovals().cancelPendingForBinding(f.agentId, binding)
  assert.equal(cancelled, 1, '撤销 dcw 绑定应取消覆盖集失效的配方审批单')
  assert.equal(getToolApprovals().listPending(f.agentId).length, 0)
  const out = await trial
  assert.match(out.text, /未批准|失效|授权/)
  assert.equal(f.nodes[0]!.value, null, '审批失效后不得写入 PLC')
})

test('US-04 换配方:同一 dcw 绑定 Agent 对新活动配方继续 trial(无需新绑定)', async (t) => {
  const f = fixture('recipe-switch')
  t.after(f.cleanup)
  const repo = getAgentNodeBindingRepo()
  // A 配方在跑时,节点绑定 Agent 可 trial
  repo.bind(f.agentId, f.nodes[0]!.id, 'dcw', 'auto')
  repo.bind(f.agentId, f.nodes[2]!.id, 'dcw', 'auto')
  // 切到 B 配方(参数 n1+n3),活动批次替换
  const recipeB = f.recipes.create({
    name: `配方B-${f.line.id}`,
    productId: f.recipe.productId,
    opIntervalMs: 0,
    params: [{ nodeId: f.nodes[0]!.id, value: 40 }, { nodeId: f.nodes[2]!.id, value: 70 }],
  })
  const runB = f.recipes.createRun(recipeB)
  t.after(() => {
    try {
      f.recipes.closeRun(runB.id)
    }
    catch { /* 已关闭 */ }
  })
  setActiveLineRun({
    lineId: f.line.id,
    runId: runB.id,
    recipeId: recipeB.id,
    recipeName: recipeB.name,
    productId: f.recipe.productId,
    productName: '产品切换',
    startedAt: runB.startedAt,
    taggedSamples: 0,
  })
  // 只给 line_id → 解析活动配方 B;节点绑定面覆盖 B 的全部参数 → 放行
  expectOk(assertRecipeOperation(f.agentId, recipeB, 'trial', [f.nodes[2]!.id]))
  expectOk(assertRecipeOperation(f.agentId, recipeB, 'dispatch'))
  // recipe 绑定 Agent 行为不变:绑的是配方 A,对 B 仍需新绑定
  const other = `ag-${f.line.id}-recipe-only`
  repo.bind(other, f.recipe.id, 'recipe', 'auto')
  const denied = assertRecipeOperation(other, recipeB, 'trial', [f.nodes[0]!.id])
  assert.equal(denied.ok, false)
  for (const b of repo.byAgent(other)) repo.unbind(b.id)
  // 真机路径:line_id 定位活动配方 + 节点绑定 Agent 整批 trial 成功(非 HITL)
  const out = await toolRecipeTrial(f.agentId, {
    line_id: f.line.id,
    params: [{ node_id: f.nodes[2]!.id, value: 62 }],
    hypothesis: '换配方后节点绑定继续生效',
  })
  assert.notEqual(out.isError, true, out.text)
  assert.match(out.text, /试验已整批下发/)
})

// ===== 产线配方管理权(kind='line-recipe',2026-10-28)=====

const { assertRecipeCreate } = await import('../server/services/workshop/agents/industrial/recipe-gate')

test('产线配方管理权:update/rollback 全线放行;无 dcw 绑定时 trial/apply 全参数放行(向下兼容)', (t) => {
  const f = fixture('line-mgr-full')
  t.after(f.cleanup)
  const repo = getAgentNodeBindingRepo()
  repo.bind(f.agentId, f.line.id, 'line-recipe', 'auto')
  // 版本操作:无需单配方绑定,凭产线管理权即可
  expectOk(assertRecipeOperation(f.agentId, f.recipe, 'update'))
  expectOk(assertRecipeOperation(f.agentId, f.recipe, 'rollback'))
  // 下发:未绑任何 dcw → 配方全部参数默认可发(向下兼容)
  expectOk(assertRecipeOperation(f.agentId, f.recipe, 'trial', [f.nodes[0]!.id]))
  expectOk(assertRecipeOperation(f.agentId, f.recipe, 'dispatch'))
})

test('产线配方管理权 + dcw 绑定:下发收窄到绑定点位,版本操作不受影响', (t) => {
  const f = fixture('line-mgr-scoped')
  t.after(f.cleanup)
  const repo = getAgentNodeBindingRepo()
  repo.bind(f.agentId, f.line.id, 'line-recipe', 'auto')
  repo.bind(f.agentId, f.nodes[0]!.id, 'dcw', 'auto')
  // 绑定点位内 trial 放行
  expectOk(assertRecipeOperation(f.agentId, f.recipe, 'trial', [f.nodes[0]!.id]))
  // 覆盖未绑定节点 → 下发被收窄拒绝(点名缺失节点)
  const narrowed = assertRecipeOperation(f.agentId, f.recipe, 'trial', [f.nodes[0]!.id, f.nodes[1]!.id])
  assert.equal(narrowed.ok, false)
  if (!narrowed.ok) {
    assert.match(narrowed.text, /下发被收窄|只能覆盖这些点位/)
    assert.ok(narrowed.text.includes(f.nodes[1]!.id), '拒绝文案应点名未绑定节点')
  }
  // 整批 apply(全参数)同样被收窄拒
  const applyNarrowed = assertRecipeOperation(f.agentId, f.recipe, 'dispatch')
  assert.equal(applyNarrowed.ok, false)
  // 版本操作不受 dcw 收窄影响:仍凭管理权放行
  expectOk(assertRecipeOperation(f.agentId, f.recipe, 'update'))
  expectOk(assertRecipeOperation(f.agentId, f.recipe, 'rollback'))
})

test('单配方绑定 + 无 dcw:整批下发放行(存量行为不变);补绑 dcw 后收窄', (t) => {
  const f = fixture('recipe-compat')
  t.after(f.cleanup)
  const repo = getAgentNodeBindingRepo()
  repo.bind(f.agentId, f.recipe.id, 'recipe', 'auto')
  // 存量:recipe 绑定 + 无 dcw → 全参数可发
  expectOk(assertRecipeOperation(f.agentId, f.recipe, 'dispatch'))
  // 绑了一个 dcw → 下发立即收窄到该点位
  repo.bind(f.agentId, f.nodes[0]!.id, 'dcw', 'auto')
  expectOk(assertRecipeOperation(f.agentId, f.recipe, 'trial', [f.nodes[0]!.id]))
  const narrowed = assertRecipeOperation(f.agentId, f.recipe, 'dispatch')
  assert.equal(narrowed.ok, false)
})

test('assertRecipeCreate:产线配方管理权可作为新建配方的授权锚', () => {
  const f = fixture('line-mgr-create')
  const repo = getAgentNodeBindingRepo()
  repo.bind(f.agentId, f.line.id, 'line-recipe', 'auto')
  const gate = assertRecipeCreate(f.agentId, f.line.id)
  assert.equal(gate.ok, true, gate.ok ? '' : gate.text)
  for (const b of repo.byAgent(f.agentId)) repo.unbind(b.id)
})

test('撤销 line-recipe:在飞配方管理审批按拒收敛,零写入', async (t) => {
  const f = fixture('line-mgr-revoke')
  t.after(f.cleanup)
  const repo = getAgentNodeBindingRepo()
  const binding = repo.bind(f.agentId, f.line.id, 'line-recipe', 'manual')
  const trial = toolRecipeTrial(f.agentId, {
    line_id: f.line.id,
    params: [{ node_id: f.nodes[0]!.id, value: 55 }],
    hypothesis: '收权即失活:撤销产线管理权后审批单必须失效',
  })
  let card = getToolApprovals().listPending(f.agentId)[0]
  for (let i = 0; i < 100 && !card; i++) {
    await new Promise(resolve => setTimeout(resolve, 10))
    card = getToolApprovals().listPending(f.agentId)[0]
  }
  assert.ok(card, 'trial 应挂起一张人工审批卡')
  repo.unbind(binding.id)
  const cancelled = getToolApprovals().cancelPendingForBinding(f.agentId, binding)
  assert.equal(cancelled, 1, '撤销产线管理权应取消该线配方审批单')
  const out = await trial
  assert.match(out.text, /未批准|失效|授权/)
  assert.equal(f.nodes[0]!.value, null, '审批失效后不得写入 PLC')
})

test('tool-verify:管理线配方参数进入写授权面,配方外节点仍不因管理权放行', (t) => {
  const f = fixture('verify-managed-face')
  t.after(f.cleanup)
  getAgentNodeBindingRepo().bind(f.agentId, f.line.id, 'line-recipe', 'auto')
  const faces = resolveRefFaces(f.agentId)
  assert.ok(faces.managedLines.has(f.line.id), '管理线应进入 managedLines')
  assert.ok(faces.writeFace.has(f.nodes[0]!.id), '管理线配方参数应进入写授权面')
  const denied = verifyIndustrialToolCall(f.agentId, 'recipe_trial', {
    recipe_id: f.recipe.id,
    params: [{ node_id: f.nodes[2]!.id, value: 55 }],
    hypothesis: '配方外节点不因管理权进入候选',
  })
  assert.ok(denied?.isError, '配方外参数节点应被拒(候选只能覆盖配方内参数)')
})
