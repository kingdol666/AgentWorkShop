import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-recipe-approval-snapshot-'))
delete process.env.AW_BENCH_MODE

const { DcwNode } = await import('../server/services/workshop/dcw/dcw-node')
const { getDcwNodeRepo } = await import('../server/services/workshop/dcw/dcw-node.repo')
const { getDcwProductRepo } = await import('../server/services/workshop/dcw/dcw-product.repo')
const { getDcwRecipeRepo } = await import('../server/services/workshop/dcw/dcw-recipe.repo')
const { setActiveLineRun, clearActiveLineRun, getActiveLineRun, getAllActiveLineRuns } = await import('../server/services/workshop/dcw/line-run')
const { mockDcwDriver, mockState } = await import('../server/services/workshop/dcw/drivers/mock')
const { ensureDataDir } = await import('../shared/config/home.mjs')
const { DcwNodeRuntime } = await import('../server/services/workshop/dcw/dcw-runtime')
const { getAgentNodeBindingRepo } = await import('../server/services/workshop/agents/node-bindings.repo')
const { getToolApprovals } = await import('../server/services/workshop/agents/tool-approvals')
const { toolRecipeApply, toolRecipeTrial, toolRecipeRollback } = await import('../server/services/workshop/agents/industrial/ops-tools')
const { runWithExecutionScope } = await import('../server/services/workshop/agents/execution-scope')
const { getDcwController } = await import('../server/services/workshop/dcw/dcw-controller')
const { getDcwLineRepo } = await import('../server/services/workshop/dcw/dcw-line.repo')
const { dcwControlGovernedInternal } = await import('../server/services/workshop/agents/industrial/dcw-tools')
const { toolRecipePropose } = await import('../server/services/workshop/agents/industrial/recipe-propose-tools')
const { getRecipeRollBackManager } = await import('../server/services/workshop/dcw/recipe-rollback-manager')
const { configureAmlRuntime } = await import('../server/services/workshop/aml/runtime')
const { latestIntervention } = await import('../server/services/workshop/aml/intervention-ledger')
const { toolLineStop } = await import('../server/services/workshop/agents/industrial/line-tools')
const { openWorkshopDb } = await import('../server/services/workshop/db/database')
const { createAlarmEventRepo, createApprovalHistoryRepo, createApprovalRequestRepo, createAuditRepo } = await import('../server/services/workshop/db/ops.repo')
const { bindOpsRepos } = await import('../server/services/workshop/ops/ops')

const db = openWorkshopDb(join(process.env.AW_HOME!, 'recipe-approval-snapshot.sqlite'))
configureAmlRuntime(db)
bindOpsRepos({
  approvalHistory: createApprovalHistoryRepo(db),
  alarmEvents: createAlarmEventRepo(db),
  audit: createAuditRepo(db),
  approvalRequests: createApprovalRequestRepo(db),
})

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
    agentId, nodes, recipe,
    cleanup() {
      clearActiveLineRun(lineId)
      for (const active of getAllActiveLineRuns().filter(run => run.recipeId === recipe.id)) clearActiveLineRun(active.lineId)
      for (const r of recipes.listRuns().filter(r => r.recipeId === recipe.id && !r.endedAt)) recipes.closeRun(r.id)
      getToolApprovals().cancelAllForAgent(agentId, 'Local test completed')
    },
  }
}

async function pendingCard(agentId: string) {
  for (let i = 0; i < 50; i++) {
    const card = getToolApprovals().listPending(agentId)[0]
    if (card) return card
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.fail('recipe operation did not create a pending approval')
}

for (const change of ['version-and-params', 'version-only', 'params-without-version'] as const) {
  test(`recipe_apply rejects ${change} changed during pending approval without actuation`, async (t) => {
    const f = fixture(`stale-${change}`)
    t.after(f.cleanup)
    const driverWrite = t.mock.method(mockDcwDriver, 'write', mockDcwDriver.write)
    const runCount = getDcwRecipeRepo().listRuns().length
    const result = toolRecipeApply(f.agentId, { recipe_id: f.recipe.id, reason: 'Local snapshot consistency test' })
    const card = await pendingCard(f.agentId)
    assert.match(card.detail, /v1/)
    assert.deepEqual((card.payload as { params: Array<{ to: number }> }).params.map(p => p.to), [50, 60])
    if (change === 'version-and-params') {
      getDcwRecipeRepo().update(f.recipe.id, { params: f.recipe.params.map(p => ({ ...p, value: p.value + 1 })) })
    }
    else if (change === 'version-only') {
      f.recipe.version = 2
    }
    else {
      f.recipe.params[1]!.value = 75
      assert.equal(f.recipe.version, 1, 'parameter equality must also be checked independently of version')
    }
    getToolApprovals().decide(card.id, true, 'Approve only the displayed parameters', 'local-owner', 'Local owner')
    const out = await result
    assert.equal(out.isError, true)
    assert.match(out.text, /配方.*变更|快照.*不一致/)
    assert.match(out.text, /重新提交 recipe_apply/)
    assert.equal(driverWrite.mock.callCount(), 0, 'stale approval must never call the mock PLC driver')
    assert.equal(getDcwRecipeRepo().listRuns().length, runCount, 'stale approval must not create an execution batch')
    for (const { node } of f.nodes) assert.equal(node.value, null)
    assert.equal(getToolApprovals().historyList().find(a => a.id === card.id)?.decidedBy, 'local-owner')
  })
}

for (const change of ['line', 'product', 'recipe', 'run'] as const) {
  test(`recipe_apply rejects a ${change} context change during pending approval without actuation`, async (t) => {
    const f = fixture(`stale-context-${change}`)
    t.after(f.cleanup)
    const driverWrite = t.mock.method(mockDcwDriver, 'write', mockDcwDriver.write)
    const result = toolRecipeApply(f.agentId, { recipe_id: f.recipe.id, reason: 'Bind approval to its active production context' })
    const card = await pendingCard(f.agentId)
    const approvedContext = (card.payload as { context: { lineId: string, runId: string, recipeId: string, productId: string } }).context
    const active = getActiveLineRun(f.recipe.lineId)!
    assert.deepEqual(approvedContext, {
      lineId: f.recipe.lineId,
      runId: active.runId,
      recipeId: f.recipe.id,
      productId: f.recipe.productId,
    })

    if (change === 'line') {
      clearActiveLineRun(active.lineId)
      setActiveLineRun({ ...active, lineId: `${active.lineId}-rebound` })
    }
    else if (change === 'product') {
      setActiveLineRun({ ...active, productId: `${active.productId}-rebound` })
    }
    else if (change === 'recipe') {
      setActiveLineRun({ ...active, recipeId: `${active.recipeId}-rebound` })
    }
    else {
      getDcwRecipeRepo().closeRun(active.runId)
      const replacement = getDcwRecipeRepo().createRun(f.recipe)
      setActiveLineRun({ ...active, runId: replacement.id, startedAt: replacement.startedAt })
    }
    const runCountAfterContextChange = getDcwRecipeRepo().listRuns().length

    getToolApprovals().decide(card.id, true, 'Approve the displayed context only', 'local-owner')
    const out = await result
    assert.equal(out.isError, true)
    assert.match(out.text, /已批准.*(上下文已变化|授权已失效)/)
    assert.equal(driverWrite.mock.callCount(), 0, `${change} context change must be refused before mock PLC actuation`)
    assert.equal(getDcwRecipeRepo().listRuns().length, runCountAfterContextChange, `${change} context change must not create an execution batch`)
    for (const { node } of f.nodes) assert.equal(node.value, null)
  })
}

for (const change of ['line', 'product', 'recipe', 'run'] as const) {
  test(`recipe_trial rejects a ${change} context change during pending approval without actuation`, async (t) => {
    const f = fixture(`trial-stale-context-${change}`)
    t.after(f.cleanup)
    const driverWrite = t.mock.method(mockDcwDriver, 'write', mockDcwDriver.write)
    const result = toolRecipeTrial(f.agentId, {
      recipe_id: f.recipe.id,
      params: f.nodes.map(({ node, value }) => ({ node_id: node.id, value: value + 5 })),
      hypothesis: 'Bind the recipe-trial approval to its active production context',
    })
    const card = await pendingCard(f.agentId)
    const approvedContext = (card.payload as { context: { lineId: string, runId: string, recipeId: string, productId: string } }).context
    const active = getActiveLineRun(f.recipe.lineId)!
    assert.deepEqual(approvedContext, {
      lineId: f.recipe.lineId,
      runId: active.runId,
      recipeId: f.recipe.id,
      productId: f.recipe.productId,
    })

    if (change === 'line') {
      clearActiveLineRun(active.lineId)
      setActiveLineRun({ ...active, lineId: `${active.lineId}-rebound` })
    }
    else if (change === 'product') {
      setActiveLineRun({ ...active, productId: `${active.productId}-rebound` })
    }
    else if (change === 'recipe') {
      setActiveLineRun({ ...active, recipeId: `${active.recipeId}-rebound` })
    }
    else {
      getDcwRecipeRepo().closeRun(active.runId)
      const replacement = getDcwRecipeRepo().createRun(f.recipe)
      setActiveLineRun({ ...active, runId: replacement.id, startedAt: replacement.startedAt })
    }
    const runCountAfterContextChange = getDcwRecipeRepo().listRuns().length

    getToolApprovals().decide(card.id, true, 'Approve the displayed context only', 'local-owner')
    const out = await result
    assert.equal(out.isError, true)
    assert.match(out.text, /已批准.*(上下文已变化|授权已失效)/)
    assert.equal(driverWrite.mock.callCount(), 0, `${change} context change must be refused before mock PLC actuation`)
    assert.equal(getDcwRecipeRepo().listRuns().length, runCountAfterContextChange, `${change} context change must not create a trial execution record`)
    for (const { node } of f.nodes) assert.equal(node.value, null)
  })
}

for (const change of ['line', 'product', 'recipe', 'run'] as const) {
  test(`recipe_rollback(dispatch=true) rejects a ${change} context change during pending approval without actuation`, async (t) => {
    const f = fixture(`rollback-stale-context-${change}`)
    t.after(f.cleanup)
    const driverWrite = t.mock.method(mockDcwDriver, 'write', mockDcwDriver.write)
    const currentParams = f.recipe.params.map(p => ({ ...p, value: p.value + 5 }))
    getDcwRecipeRepo().update(f.recipe.id, { params: currentParams })
    assert.equal(f.recipe.version, 2, 'the fixture must retain v1 as an actual rollback target')
    assert.deepEqual(
      getDcwRecipeRepo().versions(f.recipe.id).find(version => version.version === 1)?.params.map(p => p.value),
      [50, 60],
      'rollback target v1 must contain the original recipe parameters',
    )

    const result = toolRecipeRollback(f.agentId, {
      recipe_id: f.recipe.id,
      version: 1,
      dispatch: true,
      reason: 'Bind a unified rollback to its active production context',
    })
    const card = await pendingCard(f.agentId)
    const approvedContext = (card.payload as { context: { lineId: string, runId: string, recipeId: string, productId: string } }).context
    const active = getActiveLineRun(f.recipe.lineId)!
    assert.deepEqual(approvedContext, {
      lineId: f.recipe.lineId,
      runId: active.runId,
      recipeId: f.recipe.id,
      productId: f.recipe.productId,
    })
    if (change === 'line') {
      clearActiveLineRun(active.lineId)
      setActiveLineRun({ ...active, lineId: `${active.lineId}-rebound` })
    }
    else if (change === 'product') {
      setActiveLineRun({ ...active, productId: `${active.productId}-rebound` })
    }
    else if (change === 'recipe') {
      setActiveLineRun({ ...active, recipeId: `${active.recipeId}-rebound` })
    }
    else {
      getDcwRecipeRepo().closeRun(active.runId)
      const replacement = getDcwRecipeRepo().createRun(f.recipe)
      setActiveLineRun({ ...active, runId: replacement.id, startedAt: replacement.startedAt })
    }
    const runCountAfterContextChange = getDcwRecipeRepo().listRuns().length

    getToolApprovals().decide(card.id, true, 'Approve the displayed context only', 'local-owner')
    const out = await result
    assert.equal(out.isError, true)
    assert.match(out.text, /已批准.*(上下文已变化|授权已失效)/)
    assert.equal(driverWrite.mock.callCount(), 0, `${change} context change must be refused before mock PLC actuation`)
    assert.equal(getDcwRecipeRepo().listRuns().length, runCountAfterContextChange, `${change} context change must not create a rollback execution record`)
    for (const { node } of f.nodes) assert.equal(node.value, null)
  })
}

test('recipe_apply rejects an active-context change before the post-approval dispatch continuation', async (t) => {
  const f = fixture('post-recheck')
  t.after(f.cleanup)
  const driverWrite = t.mock.method(mockDcwDriver, 'write', mockDcwDriver.write)
  const runsBefore = getDcwRecipeRepo().listRuns().length
  const g = globalThis as unknown as { __workshopManager?: unknown }
  const previousManager = g.__workshopManager
  t.after(() => {
    g.__workshopManager = previousManager
  })
  let rechecked = false
  g.__workshopManager = {
    deps: {
      repos: {
        channelAgents: { findById() {
          rechecked = true
          queueMicrotask(() => {
            const active = getActiveLineRun(f.recipe.lineId)!
            setActiveLineRun({ ...active, productId: `${active.productId}-changed` })
          })
          return undefined
        } },
      },
    },
  }
  const result = toolRecipeApply(f.agentId, { recipe_id: f.recipe.id, reason: 'Check the last await before dispatch' })
  const card = await pendingCard(f.agentId)
  getToolApprovals().decide(card.id, true, '', 'local-owner')
  const out = await result
  assert.equal(rechecked, true)
  assert.equal(out.isError, true)
  assert.match(out.text, /上下文已变化/)
  assert.equal(driverWrite.mock.callCount(), 0)
  assert.equal(getDcwRecipeRepo().listRuns().length, runsBefore)
})

test('recipe_apply dispatches the unchanged approved batch through the mock driver and readback', async (t) => {
  const f = fixture('unchanged')
  t.after(f.cleanup)
  const driverWrite = t.mock.method(mockDcwDriver, 'write', mockDcwDriver.write)
  const result = toolRecipeApply(f.agentId, { recipe_id: f.recipe.id, reason: 'Dispatch the displayed batch' })
  const card = await pendingCard(f.agentId)
  assert.equal((card.payload as { recipeVersion: number }).recipeVersion, 1)
  assert.equal(driverWrite.mock.callCount(), 0, 'manual recipe binding must wait for the owner decision')
  getToolApprovals().decide(card.id, true, 'Checked the displayed batch', 'local-owner', 'Local owner')
  const out = await result
  assert.equal(out.isError, undefined)
  assert.match(out.text, /v1.*全部设备证实\(2\/2/)
  assert.match(out.text, /Checked the displayed batch/)
  assert.deepEqual(driverWrite.mock.calls.map(c => c.arguments[0].eng), [50, 60])
  assert.deepEqual(f.nodes.map(({ node }) => node.value), [50, 60])
  for (const { node, value } of f.nodes) assert.equal(mockState.__dcwMockPlc!.get(String(node.driverConfig.key)), value)
  const dispatched = getDcwRecipeRepo().listRuns().filter(r => r.recipeId === f.recipe.id).at(-1)!
  assert.deepEqual(dispatched.paramsSnapshot?.map(p => p.value), [50, 60])
  assert.deepEqual(dispatched.ackSummary, { verified: 2, unverified: 0, failed: 0, total: 2 })
  assert.equal(getToolApprovals().historyList().find(a => a.id === card.id)?.status, 'approved')
})

test('recipe_apply keeps the approved values when the shared recipe mutates after the first write starts', async (t) => {
  const f = fixture('in-flight')
  t.after(f.cleanup)
  const write = mockDcwDriver.write
  const driverWrite = t.mock.method(mockDcwDriver, 'write', async (input: Parameters<typeof mockDcwDriver.write>[0]) => {
    if (input.eng === 50) {
      f.recipe.params[1]!.value = 75
      f.recipe.version = 2
      f.recipe.name = 'Changed during dispatch'
    }
    return write(input)
  })
  const result = toolRecipeApply(f.agentId, { recipe_id: f.recipe.id, reason: 'Check the frozen batch during asynchronous writes' })
  const card = await pendingCard(f.agentId)
  getToolApprovals().decide(card.id, true, '', 'local-owner')
  const out = await result
  assert.equal(out.isError, undefined)
  assert.match(out.text, /Recipe in-flight.*v1.*全部设备证实\(2\/2/)
  assert.deepEqual(driverWrite.mock.calls.map(c => c.arguments[0].eng), [50, 60], 'the second write must use its approved copy')
  assert.equal(f.recipe.params[1]!.value, 75, 'the shared definition really changed during the write')
  const dispatched = getDcwRecipeRepo().listRuns().filter(r => r.recipeId === f.recipe.id).at(-1)!
  assert.deepEqual(dispatched.paramsSnapshot?.map(p => p.value), [50, 60])
  assert.deepEqual(dispatched.results.map(r => r.value), [50, 60])
})

test('recipe_apply still checks current node limits after approval and before driver actuation', async (t) => {
  const f = fixture('current-limits')
  t.after(f.cleanup)
  const driverWrite = t.mock.method(mockDcwDriver, 'write', mockDcwDriver.write)
  const result = toolRecipeApply(f.agentId, { recipe_id: f.recipe.id, reason: 'Current constraints remain authoritative' })
  const card = await pendingCard(f.agentId)
  for (const { node } of f.nodes) node.max = 40
  getToolApprovals().decide(card.id, true, '', 'local-owner')
  const out = await result
  assert.equal(out.isError, true)
  assert.match(out.text, /未生效参数\(2\)/)
  assert.equal(driverWrite.mock.callCount(), 0, 'approved values outside the current node limits must still be refused')
})

test('recipe_apply preserves manual denial without creating a batch or writing controls', async (t) => {
  const f = fixture('denied')
  t.after(f.cleanup)
  const driverWrite = t.mock.method(mockDcwDriver, 'write', mockDcwDriver.write)
  const runCount = getDcwRecipeRepo().listRuns().length
  const result = toolRecipeApply(f.agentId, { recipe_id: f.recipe.id, reason: 'Owner may decline the proposed batch' })
  const card = await pendingCard(f.agentId)
  getToolApprovals().decide(card.id, false, 'Observe first', 'local-owner')
  assert.match((await result).text, /人工未批准.*Observe first/)
  assert.equal(driverWrite.mock.callCount(), 0)
  assert.equal(getDcwRecipeRepo().listRuns().length, runCount)
})

function executionFence(agentId: string) {
  const abort = new AbortController()
  let valid = true
  return {
    abort,
    revoke: () => { valid = false },
    scope: {
      taskId: 'task-test', agentId, channelId: 'channel-test', assignmentGeneration: 1,
      executionLeaseId: 'lease-test', signal: abort.signal,
      assertActive() {
        if (!valid || abort.signal.aborted) throw new Error('execution lease revoked')
      },
    },
  }
}

test('revoked execution fence refuses batch creation and rollback definition changes', async (t) => {
  const f = fixture('fence-before-batch')
  t.after(f.cleanup)
  getDcwRecipeRepo().update(f.recipe.id, { params: f.recipe.params.map(p => ({ ...p, value: p.value + 5 })) })
  const version = f.recipe.version
  const runs = getDcwRecipeRepo().listRuns().length
  const write = t.mock.method(mockDcwDriver, 'write', mockDcwDriver.write)
  const fence = executionFence(f.agentId)
  fence.revoke()
  await assert.rejects(getDcwController().applyRecipe(f.recipe.id, { agentDispatch: true, executionScope: fence.scope }), /lease revoked/)
  await assert.rejects(getDcwController().rollbackRecipeAndDispatch(f.recipe.id, { version: 1, agentDispatch: true, executionScope: fence.scope }), /lease revoked/)
  assert.equal(f.recipe.version, version)
  assert.equal(getDcwRecipeRepo().listRuns().length, runs)
  assert.equal(write.mock.callCount(), 0)
})

for (const operation of ['apply', 'trial', 'rollback', 'propose'] as const) {
  test(`recipe ${operation} stops after in-flight cancellation and reports an indeterminate write`, async (t) => {
    const f = fixture(`fence-${operation}`)
    t.after(f.cleanup)
    if (operation === 'rollback') getDcwRecipeRepo().update(f.recipe.id, { params: f.recipe.params.map(p => ({ ...p, value: p.value + 5 })) })
    const fence = executionFence(f.agentId)
    let release!: () => void
    let started!: () => void
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve
    })
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    const write = t.mock.method(mockDcwDriver, 'write', async (input) => {
      started()
      await released
      return { ok: true, message: 'device acknowledged', raw: input.eng, readback: input.eng, ack: 'readback-verified' as const }
    })
    const result = runWithExecutionScope(fence.scope, () => operation === 'apply'
      ? toolRecipeApply(f.agentId, { recipe_id: f.recipe.id, reason: 'Test cancellation' })
      : operation === 'trial'
        ? toolRecipeTrial(f.agentId, { recipe_id: f.recipe.id, hypothesis: 'Test cancellation', params: f.nodes.map(({ node, value }) => ({ node_id: node.id, value })) })
        : operation === 'rollback'
          ? toolRecipeRollback(f.agentId, { recipe_id: f.recipe.id, version: 1, dispatch: true, reason: 'Test cancellation' })
          : toolRecipePropose(f.agentId, { recipe_id: f.recipe.id, packages: [{ name: 'Test package', params: f.nodes.map(({ node, value }) => ({ node_id: node.id, to: value, basis: 'test', exp_ref: 'test' })) }] }))
    const card = await pendingCard(f.agentId)
    getToolApprovals().decide(card.id, true, '', 'local-owner', '', operation === 'propose' ? 0 : undefined)
    await startedPromise
    fence.abort.abort()
    release()
    const out = await result
    assert.equal(out.isError, true)
    assert.doesNotMatch(out.text, /全部设备证实|产线仍在运行旧参数/)
    assert.equal(write.mock.callCount(), 1)
    const run = getDcwRecipeRepo().listRuns().filter(r => r.recipeId === f.recipe.id).at(-1)!
    assert.deepEqual(run.ackSummary, { verified: 0, unverified: 1, failed: 1, total: 2 })
    assert.match(run.results[0]!.message, /已进入驱动.*不确定/)
    const history = getDcwRecipeRepo().historyList(100).find(entry => entry.recipeRunId === run.id && entry.nodeId === f.nodes[0]!.node.id)
    assert.equal(history?.ok, false)
    assert.equal(history?.ack, 'unverified')
    assert.match(history?.message ?? '', /状态不确定/)
    const journal = getRecipeRollBackManager().journal({ nodeId: f.nodes[0]!.node.id })
    assert.equal(journal.length, 1, 'an accepted driver write must remain in the rollback journal')
    assert.equal(journal[0]!.newValue, run.results[0]!.value)
    const intervention = latestIntervention(f.nodes[0]!.node.id)
    assert.equal(intervention?.ack, 'readback-verified', 'ledger records the actual driver ACK')
    assert.equal(intervention?.actualValue, run.results[0]!.value)
    assert.equal(run.results[0]!.verify?.verdict, 'unverified')
    assert.match(run.results[1]!.message, /未下发/)
  })
}

test('active execution fence allows the complete approved recipe batch', async (t) => {
  const f = fixture('fence-active')
  t.after(f.cleanup)
  const fence = executionFence(f.agentId)
  const write = t.mock.method(mockDcwDriver, 'write', mockDcwDriver.write)
  const result = runWithExecutionScope(fence.scope, () => toolRecipeApply(f.agentId, { recipe_id: f.recipe.id, reason: 'Active fence control' }))
  const card = await pendingCard(f.agentId)
  getToolApprovals().decide(card.id, true, '', 'local-owner')
  const out = await result
  assert.equal(out.isError, undefined)
  assert.match(out.text, /全部设备证实/)
  assert.equal(write.mock.callCount(), 2)
})

test('line start stops its recipe batch after a lease is revoked in flight', async (t) => {
  const line = getDcwLineRepo().create({ name: 'Fence line start' })
  const product = getDcwProductRepo().create({ name: 'Fence start product', lineId: line.id })
  const nodes = [50, 60].map((value, index) => {
    const node = new DcwNode({ id: `start-fence-${index}`, templateRef: 'dcw-temp-sp', driver: 'mock', min: 0, max: 100, lineId: line.id, readIntervalMs: 0, holdIntervalMs: 1 })
    getDcwNodeRepo().insert(node)
    return { nodeId: node.id, value }
  })
  const recipe = getDcwRecipeRepo().create({ name: 'Fence start recipe', productId: product.id, params: nodes })
  t.after(() => {
    clearActiveLineRun(line.id)
  })
  const fence = executionFence('lead')
  let release!: () => void
  let started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })
  const wait = new Promise<void>((resolve) => {
    release = resolve
  })
  const write = t.mock.method(mockDcwDriver, 'write', async (input) => {
    started()
    await wait
    return { ok: true, message: 'ack', raw: input.eng, readback: input.eng, ack: 'readback-verified' as const }
  })
  const pending = getDcwController().lineStart(line.id, recipe.id, undefined, fence.scope)
  await ready
  fence.revoke()
  release()
  const run = await pending
  assert.equal(write.mock.callCount(), 1)
  assert.deepEqual(run.ackSummary, { verified: 0, unverified: 1, failed: 1, total: 2 })
  assert.match(run.results[0]!.message, /不确定/)
  assert.match(run.results[1]!.message, /未下发/)
  assert.equal(getActiveLineRun(line.id), null)
  assert.ok(getDcwRecipeRepo().runById(run.id)?.endedAt)
  assert.equal(getRecipeRollBackManager().journal({ nodeId: nodes[0]!.nodeId }).length, 1)
  assert.equal(latestIntervention(nodes[0]!.nodeId)?.ack, 'readback-verified')
  await new Promise(resolve => setTimeout(resolve, 650))
  assert.equal(write.mock.callCount(), 1, 'closed run must not send hold writes')
})

test('revoked line start does not stop a replacement run', async (t) => {
  const line = getDcwLineRepo().create({ name: 'Fence replacement line' })
  const product = getDcwProductRepo().create({ name: 'Fence replacement product', lineId: line.id })
  const node = new DcwNode({ id: 'start-replacement-node', templateRef: 'dcw-temp-sp', driver: 'mock', min: 0, max: 100, lineId: line.id, readIntervalMs: 0 })
  getDcwNodeRepo().insert(node)
  const recipe = getDcwRecipeRepo().create({ name: 'Fence replacement recipe', productId: product.id, params: [{ nodeId: node.id, value: 50 }] })
  t.after(() => {
    clearActiveLineRun(line.id)
  })
  const fence = executionFence('replacement-lead')
  let release!: () => void
  let started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })
  const wait = new Promise<void>((resolve) => {
    release = resolve
  })
  t.mock.method(mockDcwDriver, 'write', async (input) => {
    started()
    await wait
    return { ok: true, message: 'ack', raw: input.eng, readback: input.eng, ack: 'readback-verified' as const }
  })
  const pending = getDcwController().lineStart(line.id, recipe.id, undefined, fence.scope)
  await ready
  const original = getActiveLineRun(line.id)!
  const replacement = getDcwRecipeRepo().createRun(recipe)
  setActiveLineRun({ ...original, runId: replacement.id, startedAt: replacement.startedAt })
  fence.revoke()
  release()
  const run = await pending
  assert.equal(getActiveLineRun(line.id)?.runId, replacement.id)
  assert.equal(getDcwRecipeRepo().runById(replacement.id)?.endedAt, null)
  assert.ok(getDcwRecipeRepo().runById(run.id)?.endedAt)
  assert.equal(latestIntervention(node.id)?.recipeRunId, run.id)
})

test('optimization governed write returns indeterminate after cancellation in driver', async (t) => {
  const f = fixture('fence-optimization')
  t.after(f.cleanup)
  const fence = executionFence(f.agentId)
  let release!: () => void
  let started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })
  const wait = new Promise<void>((resolve) => {
    release = resolve
  })
  const write = t.mock.method(mockDcwDriver, 'write', async (input) => {
    started()
    await wait
    return { ok: true, message: 'ack', raw: input.eng, readback: input.eng, ack: 'readback-verified' as const }
  })
  const pending = runWithExecutionScope(fence.scope, () => dcwControlGovernedInternal(f.agentId, { node_id: f.nodes[0]!.node.id, value: 50, hypothesis: 'Test fence', task_id: 'untrusted-task' }))
  const card = await pendingCard(f.agentId)
  getToolApprovals().decide(card.id, true, '', 'local-owner')
  await ready
  fence.revoke()
  release()
  const out = await pending
  assert.equal(out.isError, true)
  assert.match(out.text, /已进入驱动.*不确定/)
  assert.equal(write.mock.callCount(), 1)
  const node = f.nodes[0]!.node
  const journal = getRecipeRollBackManager().journal({ nodeId: node.id })
  assert.equal(journal.length, 1)
  assert.equal(journal[0]!.newValue, 50)
  assert.equal(journal[0]!.actor, f.agentId)
  assert.equal(journal[0]!.taskId, fence.scope.taskId)
  const intervention = latestIntervention(node.id)
  assert.equal(intervention?.ack, 'readback-verified')
  assert.equal(intervention?.actualValue, 50)
  assert.equal(intervention?.actor, f.agentId)
  assert.equal(node.value, 50)
  assert.equal(node.holdBlocked, true, 'late verified acknowledgement must not authorize automatic hold after revocation')
  assert.equal(DcwNode.fromRow(node.toRow()).holdBlocked, true)
  await assert.rejects(getDcwController().write(node.id, 51, null, { source: 'agent', actor: f.agentId }), /间隔|保持窗口/)
  assert.equal(write.mock.callCount(), 1, 'accepted in-flight write must retain its cooldown')
})

test('cancelled write preserves a transport-only driver acknowledgement without inventing readback', async (t) => {
  const f = fixture('fence-transport')
  t.after(f.cleanup)
  const node = f.nodes[0]!.node
  const fence = executionFence(f.agentId)
  let release!: () => void
  let started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })
  const wait = new Promise<void>((resolve) => {
    release = resolve
  })
  t.mock.method(mockDcwDriver, 'write', async (input) => {
    started()
    await wait
    return { ok: true, message: 'transport accepted', raw: input.eng, readback: null, ack: 'transport-ack' as const }
  })
  const pending = getDcwController().write(node.id, 50, null, { source: 'agent', actor: f.agentId, taskId: fence.scope.taskId }, fence.scope)
  await ready
  fence.abort.abort()
  release()
  const outcome = await pending
  assert.equal(outcome.ok, false)
  assert.equal(outcome.ack, 'unverified')
  assert.equal(outcome.driverOutcome?.ok, true)
  assert.equal(outcome.driverOutcome?.ack, 'transport-ack')
  assert.equal(getRecipeRollBackManager().journal({ nodeId: node.id }).length, 1)
  const intervention = latestIntervention(node.id)
  assert.equal(intervention?.ack, 'transport-ack')
  assert.equal(intervention?.actualValue, null)
  await assert.rejects(getDcwController().write(node.id, 51, null, { source: 'agent', actor: f.agentId }), /间隔|保持窗口/)
})

test('uncertain in-flight transport failure blocks heartbeat through restart until a verified write', async (t) => {
  const f = fixture('fence-hold-uncertain')
  t.after(f.cleanup)
  const node = f.nodes[0]!.node
  node.holdIntervalMs = 1
  node.applyWriteResult(40, true, 'previous verified value', '2026-10-01T00:00:00.000Z')
  const fence = executionFence(f.agentId)
  let notifyStarted!: () => void
  let release!: () => void
  const ready = new Promise<void>((resolve) => {
    notifyStarted = resolve
  })
  const wait = new Promise<void>((resolve) => {
    release = resolve
  })
  const driver = t.mock.method(mockDcwDriver, 'write', async (input) => {
    const rows = JSON.parse(readFileSync(join(ensureDataDir(), 'dcws.json'), 'utf8')) as Array<{ id: string, holdBlocked: boolean }>
    assert.equal(rows.find(row => row.id === node.id)?.holdBlocked, true, 'interlock must persist before driver invocation')
    notifyStarted()
    await wait
    return { ok: false, message: 'transport timeout after send', raw: input.eng, readback: null, ack: 'unverified' as const }
  })
  const pending = getDcwController().write(node.id, 50, 'run-hold-uncertain', { source: 'recipe', actor: 'test' }, fence.scope)
  await ready
  fence.abort.abort()
  release()
  const outcome = await pending
  assert.equal(outcome.ok, false)
  assert.equal(outcome.ack, 'unverified')
  assert.equal(node.value, 40)
  assert.equal(node.holdBlocked, true)
  assert.equal(node.toView().holdBlocked, true)
  assert.match(node.lastError ?? '', /保写已暂停/)
  await new Promise(resolve => setTimeout(resolve, 650))
  assert.equal(driver.mock.callCount(), 1, 'active line must not resend the previous value')
  const restored = DcwNode.fromRow(JSON.parse(readFileSync(join(ensureDataDir(), 'dcws.json'), 'utf8')).find((row: { id: string }) => row.id === node.id))
  assert.equal(restored.holdBlocked, true)
  const holdWrite = t.mock.fn(async () => ({ ok: true, message: 'unexpected hold', raw: null, readback: null }))
  const runtime = new DcwNodeRuntime(restored, {
    running: () => true,
    defaults: () => ({ holdIntervalMs: 1, readIntervalMs: 0 }),
    lineActive: () => true,
    executeWrite: holdWrite,
    executeRead: async () => ({ ok: true, value: 40, raw: 40, message: 'read', at: new Date().toISOString() }),
  })
  runtime.tick(Date.now())
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(holdWrite.mock.callCount(), 0, 'restart must preserve the hold interlock')
  restored.applyReadResult(40, 40, true, 'ordinary read', new Date().toISOString())
  assert.equal(restored.holdBlocked, true, 'an unrelated read cannot clear the interlock')
  driver.mock.mockImplementation(async input => ({ ok: true, message: 'transport accepted', raw: input.eng, readback: null, ack: 'transport-ack' as const }))
  await getDcwController().write(node.id, 45, 'run-hold-uncertain', { source: 'recipe', actor: 'test' })
  assert.equal(node.holdBlocked, true, 'transport acknowledgement alone cannot clear the interlock')
  driver.mock.mockImplementation(async input => ({ ok: true, message: 'verified', raw: input.eng, readback: input.eng, ack: 'readback-verified' as const }))
  await getDcwController().write(node.id, 45, 'run-hold-uncertain', { source: 'recipe', actor: 'test' })
  assert.equal(node.holdBlocked, false)
  assert.equal(node.value, 45)
  const recovered = DcwNode.fromRow(node.toRow())
  const recoveredRuntime = new DcwNodeRuntime(recovered, {
    running: () => true,
    defaults: () => ({ holdIntervalMs: 1, readIntervalMs: 0 }),
    lineActive: () => true,
    executeWrite: holdWrite,
    executeRead: async () => ({ ok: true, value: 45, raw: 45, message: 'read', at: new Date().toISOString() }),
  })
  recoveredRuntime.tick(Date.now())
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(holdWrite.mock.callCount(), 1, 'physically verified recovery permits hold again')
})

test('transport-ack write releases the hold only after the observed DAQ follows the target', async (t) => {
  const f = fixture('fence-hold-observe')
  t.after(f.cleanup)
  const { getTsdb } = await import('../server/services/workshop/daq/storage')
  const node = f.nodes[0]!.node
  node.holdObserve = { daqId: 'dn-observe-1', tolerance: 1, timeoutMs: 2500 }
  t.mock.method(mockDcwDriver, 'write', async input => ({ ok: true, message: 'transport accepted', raw: input.eng, readback: null, ack: 'transport-ack' as const }))
  await getDcwController().write(node.id, 45, 'run-observe', { source: 'recipe', actor: 'test' })
  assert.equal(node.holdBlocked, true, 'broker ACK alone must not release the hold')
  // 独立 DAQ 观测跟随(点时间晚于写发起)→ 设备生效证据成立,保写解除
  await getTsdb().writeSamples([{ nodeId: 'dn-observe-1', tsMs: Date.now(), value: 45, state: 'ok' }])
  const deadline = Date.now() + 5000
  while (node.holdBlocked && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(node.holdBlocked, false, 'observed DAQ following the target must release the hold')
  assert.equal(node.lastError, null)
  assert.equal(DcwNode.fromRow(node.toRow()).holdBlocked, false, 'the release must persist in the snapshot')
  // 保写心跳恢复:解除后按 holdIntervalMs 重下发
  const holdWrite = t.mock.fn(async () => ({ ok: true, message: 'hold write', raw: null, readback: null }))
  const runtime = new DcwNodeRuntime(DcwNode.fromRow(node.toRow()), {
    running: () => true,
    defaults: () => ({ holdIntervalMs: 1, readIntervalMs: 0 }),
    lineActive: () => true,
    executeWrite: holdWrite,
    executeRead: async () => ({ ok: true, value: 45, raw: 45, message: 'read', at: new Date().toISOString() }),
  })
  runtime.tick(Date.now())
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(holdWrite.mock.callCount(), 1, 'observation-verified recovery permits hold again')
})

test('transport-ack hold stays blocked with a surfaced reason when the observation never follows', async (t) => {
  const f = fixture('fence-hold-observe-timeout')
  t.after(f.cleanup)
  const node = f.nodes[0]!.node
  node.holdObserve = { daqId: 'dn-observe-2', timeoutMs: 400 }
  t.mock.method(mockDcwDriver, 'write', async input => ({ ok: true, message: 'transport accepted', raw: input.eng, readback: null, ack: 'transport-ack' as const }))
  await getDcwController().write(node.id, 45, 'run-observe-timeout', { source: 'recipe', actor: 'test' })
  assert.equal(node.holdBlocked, true)
  await new Promise(resolve => setTimeout(resolve, 1500))
  assert.equal(node.holdBlocked, true, 'no observation evidence must keep the hold interlock')
  assert.match(node.lastError ?? '', /观测证实超时/, 'the timeout reason must be surfaced, not silent')
  const restored = DcwNode.fromRow(node.toRow())
  assert.equal(restored.holdBlocked, true)
  const holdWrite = t.mock.fn(async () => ({ ok: true, message: 'unexpected hold', raw: null, readback: null }))
  const runtime = new DcwNodeRuntime(restored, {
    running: () => true,
    defaults: () => ({ holdIntervalMs: 1, readIntervalMs: 0 }),
    lineActive: () => true,
    executeWrite: holdWrite,
    executeRead: async () => ({ ok: true, value: 45, raw: 45, message: 'read', at: new Date().toISOString() }),
  })
  runtime.tick(Date.now())
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(holdWrite.mock.callCount(), 0, 'unverified transport-ack must keep the heartbeat suspended')
})

test('transport-ack without an observe declaration keeps the hold and surfaces the gap', async (t) => {
  const f = fixture('fence-hold-observe-missing')
  t.after(f.cleanup)
  const node = f.nodes[0]!.node
  assert.equal(node.holdObserve, null)
  t.mock.method(mockDcwDriver, 'write', async input => ({ ok: true, message: 'transport accepted', raw: input.eng, readback: null, ack: 'transport-ack' as const }))
  await getDcwController().write(node.id, 45, 'run-observe-missing', { source: 'recipe', actor: 'test' })
  assert.equal(node.holdBlocked, true, 'broker ACK alone cannot clear the interlock')
  assert.match(node.lastError ?? '', /未配置观测证实/, 'the missing evidence standard must be explicit')
})

test('stale observation evidence from before the write cannot release the hold', async (t) => {
  const f = fixture('fence-hold-observe-stale')
  t.after(f.cleanup)
  const { getTsdb } = await import('../server/services/workshop/daq/storage')
  const node = f.nodes[0]!.node
  node.holdObserve = { daqId: 'dn-observe-4', tolerance: 1, timeoutMs: 600 }
  t.mock.method(mockDcwDriver, 'write', async input => ({ ok: true, message: 'transport accepted', raw: input.eng, readback: null, ack: 'transport-ack' as const }))
  await getDcwController().write(node.id, 45, 'run-observe-stale', { source: 'recipe', actor: 'test' })
  // 写之前就等于目标的旧点:不构成「跟随」证据
  await getTsdb().writeSamples([{ nodeId: 'dn-observe-4', tsMs: Date.now() - 5000, value: 45, state: 'ok' }])
  await new Promise(resolve => setTimeout(resolve, 1500))
  assert.equal(node.holdBlocked, true, 'a pre-write sample must not count as evidence')
  assert.match(node.lastError ?? '', /观测证实超时/)
})

test('a newer transport-ack write supersedes the in-flight observation and verifies against its own target', async (t) => {
  const f = fixture('fence-hold-observe-supersede')
  t.after(f.cleanup)
  const { getTsdb } = await import('../server/services/workshop/daq/storage')
  const node = f.nodes[0]!.node
  node.holdObserve = { daqId: 'dn-observe-5', tolerance: 1, timeoutMs: 2500 }
  t.mock.method(mockDcwDriver, 'write', async input => ({ ok: true, message: 'transport accepted', raw: input.eng, readback: null, ack: 'transport-ack' as const }))
  await getDcwController().write(node.id, 45, 'run-observe-a', { source: 'recipe', actor: 'test' })
  await getDcwController().write(node.id, 50, 'run-observe-b', { source: 'recipe', actor: 'test' })
  assert.equal(node.holdBlocked, true)
  // 设备跟随新目标 B=50:只有 B 的观测代际能证实解除
  await getTsdb().writeSamples([{ nodeId: 'dn-observe-5', tsMs: Date.now(), value: 50, state: 'ok' }])
  const deadline = Date.now() + 5000
  while (node.holdBlocked && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(node.holdBlocked, false, 'the latest write observation must release the hold')
  assert.equal(node.value, 50)
})

test('write refuses driver invocation when the hold interlock cannot be persisted', async (t) => {
  const f = fixture('fence-hold-persist-fail')
  t.after(f.cleanup)
  const node = f.nodes[0]!.node
  node.value = 40
  const repo = getDcwNodeRepo()
  t.mock.method(repo, 'flushNow', () => false)
  const driver = t.mock.method(mockDcwDriver, 'write', mockDcwDriver.write)
  await assert.rejects(getDcwController().write(node.id, 45, 'run-persist-fail', { source: 'recipe', actor: 'test' }), /无法持久化/)
  assert.equal(driver.mock.callCount(), 0)
  assert.equal(node.holdBlocked, true)
  assert.equal(node.value, 40)
})

test('line_stop rechecks the task lease after approval and asynchronous lead lookup', async (t) => {
  const line = getDcwLineRepo().create({ name: 'Fence stop line' })
  const product = getDcwProductRepo().create({ name: 'Fence stop product', lineId: line.id })
  const node = new DcwNode({ id: 'stop-fence-node', templateRef: 'dcw-temp-sp', driver: 'mock', min: 0, max: 100, lineId: line.id })
  getDcwNodeRepo().insert(node)
  const recipe = getDcwRecipeRepo().create({ name: 'Fence stop recipe', productId: product.id, params: [{ nodeId: node.id, value: 50 }] })
  const run = getDcwRecipeRepo().createRun(recipe)
  setActiveLineRun({ lineId: line.id, runId: run.id, recipeId: recipe.id, recipeName: recipe.name, productId: product.id, productName: product.name, startedAt: run.startedAt, taggedSamples: 0 })
  const fence = executionFence('stop-lead')
  const g = globalThis as unknown as { __workshopManager?: unknown }
  const previous = g.__workshopManager
  let lookups = 0
  g.__workshopManager = {
    deps: { repos: { channels: { findById() {
      lookups++
      if (lookups === 2) queueMicrotask(() => fence.revoke())
      return { leadAgentId: 'stop-lead', lineId: line.id }
    } } } },
  }
  t.after(() => {
    g.__workshopManager = previous
    clearActiveLineRun(line.id)
    getToolApprovals().cancelAllForAgent('stop-lead', 'test cleanup')
  })
  const stop = t.mock.method(getDcwController(), 'lineStop', getDcwController().lineStop)
  const pending = runWithExecutionScope(fence.scope, () => toolLineStop('stop-lead', { reason: 'Check lease after approval' }, 'stop-channel'))
  const card = await pendingCard('stop-lead')
  getToolApprovals().decide(card.id, true, '', 'local-owner')
  const result = await pending
  assert.equal(lookups, 2)
  assert.equal(result.isError, true)
  assert.match(result.text, /lease revoked/)
  assert.equal(stop.mock.callCount(), 0)
  assert.equal(getActiveLineRun(line.id)?.runId, run.id)
})
