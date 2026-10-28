/**
 * 2026-10-28 多专家审查整改 · 写控/权限域 P1:
 *  B-P1-1 系统兜底回退 await 后重验(被判/被关闭/被接管 → 零写入);
 *  B-P1-2 配方下发在飞占位(并发恰一次执行);
 *  B-P1-3 委派 auto 必须 confirm + 留痕,缺省 manual;
 *  B-P1-4 recipe_update 审批期定义快照比对(不静默并入已变定义)。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-mx-write-'))
process.env.AW_TRIAL_INTERVAL_MS = '60000'
delete process.env.AW_BENCH_MODE

const { DcwNode } = await import('../server/services/workshop/dcw/dcw-node')
const { getDcwNodeRepo } = await import('../server/services/workshop/dcw/dcw-node.repo')
const { getDcwProductRepo } = await import('../server/services/workshop/dcw/dcw-product.repo')
const { getDcwRecipeRepo } = await import('../server/services/workshop/dcw/dcw-recipe.repo')
const { setActiveLineRun, clearActiveLineRun, getAllActiveLineRuns } = await import('../server/services/workshop/dcw/line-run')
const { getDcwController } = await import('../server/services/workshop/dcw/dcw-controller')
const { getRecipeRollBackManager } = await import('../server/services/workshop/dcw/recipe-rollback-manager')
const { getAgentNodeBindingRepo } = await import('../server/services/workshop/agents/node-bindings.repo')
const { getToolApprovals } = await import('../server/services/workshop/agents/tool-approvals')
const { toolRecipeUpdate } = await import('../server/services/workshop/agents/industrial/ops-tools')
const { planDelegation, applyDelegation } = await import('../server/services/workshop/agents/node-delegation')
const { isRecipeOpInflight } = await import('../server/services/workshop/dcw/recipe-op-anchor')
const { openWorkshopDb } = await import('../server/services/workshop/db/database')
const { createAlarmEventRepo, createApprovalHistoryRepo, createApprovalRequestRepo, createAuditRepo } = await import('../server/services/workshop/db/ops.repo')
const { bindOpsRepos } = await import('../server/services/workshop/ops/ops')

const db = openWorkshopDb(join(process.env.AW_HOME!, 'mx-write.sqlite'))
bindOpsRepos({
  approvalHistory: createApprovalHistoryRepo(db),
  alarmEvents: createAlarmEventRepo(db),
  audit: createAuditRepo(db),
  approvalRequests: createApprovalRequestRepo(db),
})

async function sleep(ms: number): Promise<void> {
  await new Promise(r => setTimeout(r, ms))
}

function fixture(id: string) {
  const lineId = `ln-${id}`
  const agentId = `ag-${id}`
  const nodes = [50, 60].map((value, i) => {
    const node = new DcwNode({
      id: `dw-${id}-${i}`, templateRef: 'dcw-temp-sp', driver: 'mock',
      driverConfig: { key: `${id}-${i}` }, min: 0, max: 100, unit: 'C', decimals: 1,
      lineId, readIntervalMs: 0, holdIntervalMs: null,
    })
    getDcwNodeRepo().insert(node)
    return { node, value }
  })
  const product = getDcwProductRepo().create({ name: `Product ${id}`, lineId })
  const recipes = getDcwRecipeRepo()
  const recipe = recipes.create({
    name: `Recipe ${id}`, productId: product.id, opIntervalMs: 0,
    params: nodes.map(({ node, value }) => ({ nodeId: node.id, value })),
  })
  getAgentNodeBindingRepo().bind(agentId, recipe.id, 'recipe', 'manual')
  const run = recipes.createRun(recipe)
  setActiveLineRun({
    lineId, runId: run.id, recipeId: recipe.id, recipeName: recipe.name,
    productId: product.id, productName: product.name, startedAt: run.startedAt, taggedSamples: 0,
  })
  return {
    agentId, lineId, nodes, recipe,
    cleanup() {
      clearActiveLineRun(lineId)
      for (const active of getAllActiveLineRuns().filter(r => r.recipeId === recipe.id)) clearActiveLineRun(active.lineId)
      for (const r of recipes.listRuns().filter(r => r.recipeId === recipe.id && !r.endedAt)) recipes.closeRun(r.id)
      getToolApprovals().cancelAllForAgent(agentId, 'Local test completed')
    },
  }
}

test('B-P1-1:captureMetrics 期间被人工判定 → 系统兜底零写入且不覆盖判词', async (t) => {
  const f = fixture('sweep-judged')
  t.after(f.cleanup)
  const mgr = getRecipeRollBackManager()
  const repo = (mgr as unknown as { repo: import('../server/services/workshop/dcw/recipe-rollback.repo').RecipeRollBackRepo }).repo

  let release!: () => void
  const gate = new Promise<void>(resolve => (release = resolve))
  const rolled: string[] = []
  const originalCapture = (mgr as unknown as { captureMetrics: (...a: unknown[]) => Promise<unknown> }).captureMetrics
  const originalRollback = (mgr as unknown as { rollbackRecord: (...a: unknown[]) => Promise<unknown> }).rollbackRecord
  ;(mgr as unknown as { captureMetrics: unknown }).captureMetrics = async () => {
    await gate
    return { channels: [{ breaches: 99 }] }
  }
  ;(mgr as unknown as { rollbackRecord: unknown }).rollbackRecord = async (id: string) => rolled.push(id)
  t.after(() => {
    ;(mgr as unknown as { captureMetrics: unknown }).captureMetrics = originalCapture
    ;(mgr as unknown as { rollbackRecord: unknown }).rollbackRecord = originalRollback
  })

  const record = repo.insertRecord({
    lineId: f.lineId, nodeId: f.nodes[0]!.node.id, nodeName: f.nodes[0]!.node.name,
    recipeId: f.recipe.id, hypothesis: 'sweep-test', params: [], setAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    status: 'open', judge: null, anchorId: 'a-1', policy: 'auto_rollback',
  })
  const p = (mgr as unknown as { evaluateOnce(r: unknown): Promise<void> }).evaluateOnce(record)
  await sleep(20)
  // 人工在查询窗口内下了 uncertain 判词
  record.judge = { by: 'user', actor: 'u-1', verdict: 'uncertain', reason: '人工待定', at: new Date().toISOString() }
  release()
  await p
  assert.equal(rolled.length, 0, '人工已判定后系统不得再物理回退')
  assert.equal(record.judge.verdict, 'uncertain', '不得覆盖人工判词')
})

test('B-P1-1:同节点出现更新的 open 记录 → 陈旧记录不再行动', async (t) => {
  const f = fixture('sweep-superseded')
  t.after(f.cleanup)
  const mgr = getRecipeRollBackManager()
  const repo = (mgr as unknown as { repo: import('../server/services/workshop/dcw/recipe-rollback.repo').RecipeRollBackRepo }).repo
  let release!: () => void
  const gate = new Promise<void>(resolve => (release = resolve))
  const rolled: string[] = []
  const originalCapture = (mgr as unknown as { captureMetrics: (...a: unknown[]) => Promise<unknown> }).captureMetrics
  const originalRollback = (mgr as unknown as { rollbackRecord: (...a: unknown[]) => Promise<unknown> }).rollbackRecord
  ;(mgr as unknown as { captureMetrics: unknown }).captureMetrics = async () => {
    await gate
    return { channels: [{ breaches: 99 }] }
  }
  ;(mgr as unknown as { rollbackRecord: unknown }).rollbackRecord = async (id: string) => rolled.push(id)
  t.after(() => {
    ;(mgr as unknown as { captureMetrics: unknown }).captureMetrics = originalCapture
    ;(mgr as unknown as { rollbackRecord: unknown }).rollbackRecord = originalRollback
  })

  const node = f.nodes[1]!.node
  const record = repo.insertRecord({
    lineId: f.lineId, nodeId: node.id, nodeName: node.name, recipeId: f.recipe.id,
    hypothesis: 'old', params: [], setAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    status: 'open', judge: null, anchorId: 'a-old', policy: 'auto_rollback',
  })
  const p = (mgr as unknown as { evaluateOnce(r: unknown): Promise<void> }).evaluateOnce(record)
  await sleep(20)
  const newer = repo.insertRecord({
    lineId: f.lineId, nodeId: node.id, nodeName: node.name, recipeId: f.recipe.id,
    hypothesis: 'new-intent', params: [], setAt: new Date().toISOString(),
    status: 'open', judge: null, anchorId: 'a-new', policy: 'auto_rollback',
  })
  release()
  await p
  assert.equal(rolled.length, 0, '被新写意图接管的旧记录不得回退')
  assert.equal(repo.byId(newer.id)?.status, 'open')
})

test('B-P1-1:无干扰时自动回退仍执行(反向断言,防修死)', async (t) => {
  const f = fixture('sweep-normal')
  t.after(f.cleanup)
  const mgr = getRecipeRollBackManager()
  const repo = (mgr as unknown as { repo: import('../server/services/workshop/dcw/recipe-rollback.repo').RecipeRollBackRepo }).repo
  const rolled: string[] = []
  const originalCapture = (mgr as unknown as { captureMetrics: (...a: unknown[]) => Promise<unknown> }).captureMetrics
  const originalRollback = (mgr as unknown as { rollbackRecord: (...a: unknown[]) => Promise<unknown> }).rollbackRecord
  ;(mgr as unknown as { captureMetrics: unknown }).captureMetrics = async () => ({ channels: [{ breaches: 99 }] })
  ;(mgr as unknown as { rollbackRecord: unknown }).rollbackRecord = async (id: string) => rolled.push(id)
  t.after(() => {
    ;(mgr as unknown as { captureMetrics: unknown }).captureMetrics = originalCapture
    ;(mgr as unknown as { rollbackRecord: unknown }).rollbackRecord = originalRollback
  })
  const node = f.nodes[0]!.node
  const record = repo.insertRecord({
    lineId: f.lineId, nodeId: node.id, nodeName: node.name, recipeId: f.recipe.id,
    hypothesis: 'normal', params: [], setAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    status: 'open', judge: null, anchorId: 'a-n', policy: 'auto_rollback',
  })
  await (mgr as unknown as { evaluateOnce(r: unknown): Promise<void> }).evaluateOnce(record)
  assert.deepEqual(rolled, [record.id])
})

test('B-P1-2:并发两次 agent 下发 → 恰一次进入写入,另一次在飞占位拒绝', async (t) => {
  const f = fixture('op-race')
  t.after(f.cleanup)
  const ctrl = getDcwController()
  const overrides = f.nodes.map(({ node, value }) => ({ nodeId: node.id, value: value + 1 }))
  const p1 = ctrl.applyRecipe(f.recipe.id, { agentDispatch: true, agentApprovalId: 'ap-a', overrides })
  const p2 = ctrl.applyRecipe(f.recipe.id, { agentDispatch: true, agentApprovalId: 'ap-b', overrides })
  const results = await Promise.allSettled([p1, p2])
  const fulfilled = results.filter(r => r.status === 'fulfilled')
  const rejected = results.filter(r => r.status === 'rejected') as PromiseRejectedResult[]
  assert.equal(fulfilled.length, 1, '并发下发必须恰一次成功')
  assert.equal(rejected.length, 1, '另一次必须在入口被拒')
  const reason = rejected[0]!.reason as { code?: string, statusCode?: number, message?: string }
  assert.equal(reason.code, 'WRITE_FREQUENT', `拒绝原因应为频控族,实际:${reason.code ?? reason.message}`)
  assert.match(String(reason.message), /在飞占位|正在执行/)
  assert.equal(isRecipeOpInflight(f.recipe.id), false, '执行结束后必须释放在飞占位')
  // 释放后可再次下发
  const again = await ctrl.applyRecipe(f.recipe.id, { agentDispatch: true, agentApprovalId: 'ap-c', overrides })
  assert.ok(again.id)
})

test('B-P1-2:并发两次 trial 只放行一次(节拍原子占位)', async (t) => {
  const f = fixture('trial-race')
  t.after(f.cleanup)
  const ctrl = getDcwController()
  const overrides = f.nodes.map(({ node, value }) => ({ nodeId: node.id, value: value + 2 }))
  const p1 = ctrl.applyRecipe(f.recipe.id, { trial: true, overrides })
  const p2 = ctrl.applyRecipe(f.recipe.id, { trial: true, overrides })
  const results = await Promise.allSettled([p1, p2])
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
  const rejected = results.filter(r => r.status === 'rejected') as PromiseRejectedResult[]
  assert.equal(rejected.length, 1)
  assert.match(String((rejected[0]!.reason as Error).message), /试验节拍|试验距今/)
})

test('B-P1-3:委派 auto 无 confirm → 拒绝且零变更;confirm 后落库并留痕;缺省 manual', () => {
  const repo = getAgentNodeBindingRepo()
  const leader = 'ag-lead-x'
  repo.bind(leader, 'dw-grant-1', 'dcw', 'auto')
  const members = [{ id: leader, role: 'lead' as const }, { id: 'ag-work-x', role: 'worker' as const }]

  assert.throws(
    () => planDelegation({ leaderAgentId: leader, channelId: 'ch-x', targetAgentId: 'ag-work-x', nodeIds: ['dw-grant-1'], members, mode: 'auto' }),
    (err: unknown) => (err as { code?: string }).code === 'DELEGATION_MODE_CONFIRM_REQUIRED',
    '未确认的 auto 委派必须拒绝',
  )
  assert.equal(repo.find('ag-work-x', 'dw-grant-1', 'dcw'), undefined, '拒绝时不得产生绑定')

  // 缺省 mode = manual(不继承 lead 的 auto)
  const manualPlan = planDelegation({ leaderAgentId: leader, channelId: 'ch-x', targetAgentId: 'ag-work-x', nodeIds: ['dw-grant-1'], members })
  assert.equal(manualPlan.grants[0]!.mode, 'manual')

  // 显式确认后才允许 auto,并落审计
  const autoPlan = planDelegation({ leaderAgentId: leader, channelId: 'ch-x', targetAgentId: 'ag-work-x', nodeIds: ['dw-grant-1'], members, mode: 'auto', confirm: true })
  assert.equal(autoPlan.grants[0]!.mode, 'auto')
  const bindings = applyDelegation(autoPlan, leader)
  assert.equal(bindings[0]!.mode, 'auto')
  assert.equal(repo.find('ag-work-x', 'dw-grant-1', 'dcw')?.mode, 'auto')
  const audit = createAuditRepo(db).query({ action: 'binding.mode' })
  assert.ok(audit.some(a => String(a.summary).includes('委派授予 auto')), 'auto 授予必须留审计')
})

test('B-P1-4:recipe_update 审批期间配方被并发编辑 → 批准后拒绝执行(不静默并入)', async (t) => {
  const f = fixture('update-stale')
  t.after(f.cleanup)
  const result = toolRecipeUpdate(f.agentId, {
    recipe_id: f.recipe.id,
    params: [{ node_id: f.nodes[0]!.node.id, value: 55 }],
    reason: '基于数采取证的参数修订(本地测试)',
  })
  // 等审批卡生成
  let card = getToolApprovals().listPending(f.agentId)[0]
  for (let i = 0; i < 50 && !card; i++) {
    await sleep(10)
    card = getToolApprovals().listPending(f.agentId)[0]
  }
  assert.ok(card, '应生成参数写入审批卡')
  // 审批窗口内其他人并发编辑了另一个参数
  const before = getDcwRecipeRepo().byId(f.recipe.id)!
  getDcwRecipeRepo().update(f.recipe.id, { params: before.params.map(p => ({ ...p, value: p.value + 7 })) })
  const versionAfterConcurrentEdit = getDcwRecipeRepo().byId(f.recipe.id)!.version
  getToolApprovals().decide(card!.id, true, '批准展示的参数', 'local-owner', 'Local owner')
  const out = await result
  assert.equal(out.isError, true)
  assert.match(out.text, /审批期间.*已被其他操作修改|定义已被其他操作修改/)
  assert.match(out.text, /重新提交 recipe_update/)
  // 只保留了并发编辑那一次版本推进,本次批准未被固化
  assert.equal(getDcwRecipeRepo().byId(f.recipe.id)!.version, versionAfterConcurrentEdit)
  const p0 = getDcwRecipeRepo().byId(f.recipe.id)!.params.find(p => p.nodeId === f.nodes[0]!.node.id)!
  assert.notEqual(p0.value, 55, '被拒的更新不得写入参数值')
})
