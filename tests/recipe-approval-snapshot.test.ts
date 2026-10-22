import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
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
const { setActiveLineRun, clearActiveLineRun } = await import('../server/services/workshop/dcw/line-run')
const { mockDcwDriver, mockState } = await import('../server/services/workshop/dcw/drivers/mock')
const { getAgentNodeBindingRepo } = await import('../server/services/workshop/agents/node-bindings.repo')
const { getToolApprovals } = await import('../server/services/workshop/agents/tool-approvals')
const { toolRecipeApply } = await import('../server/services/workshop/agents/industrial/ops-tools')
const { openWorkshopDb } = await import('../server/services/workshop/db/database')
const { createAlarmEventRepo, createApprovalHistoryRepo, createApprovalRequestRepo, createAuditRepo } = await import('../server/services/workshop/db/ops.repo')
const { bindOpsRepos } = await import('../server/services/workshop/ops/ops')

const db = openWorkshopDb(join(process.env.AW_HOME!, 'recipe-approval-snapshot.sqlite'))
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
  assert.fail('recipe_apply did not create a pending approval')
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

test('recipe_apply rejects a change during the asynchronous post-approval recheck', async (t) => {
  const f = fixture('post-recheck')
  t.after(f.cleanup)
  const driverWrite = t.mock.method(mockDcwDriver, 'write', mockDcwDriver.write)
  const g = globalThis as unknown as { __workshopManager?: unknown }
  const previousManager = g.__workshopManager
  t.after(() => {
    g.__workshopManager = previousManager
  })
  let rechecked = false
  g.__workshopManager = {
    deps: { repos: { channelAgents: { findById() {
      rechecked = true
      queueMicrotask(() => {
        f.recipe.params[1]!.value = 75
      })
      return undefined
    } } } },
  }
  const result = toolRecipeApply(f.agentId, { recipe_id: f.recipe.id, reason: 'Check the last await before dispatch' })
  const card = await pendingCard(f.agentId)
  getToolApprovals().decide(card.id, true, '', 'local-owner')
  const out = await result
  assert.equal(rechecked, true)
  assert.equal(out.isError, true)
  assert.match(out.text, /重新提交 recipe_apply/)
  assert.equal(driverWrite.mock.callCount(), 0)
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
