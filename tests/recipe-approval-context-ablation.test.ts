import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(resolve(tmpdir(), 'aw-recipe-context-ablation-'))
delete process.env.AW_BENCH_MODE

const productionPath = resolve('server/services/workshop/agents/industrial/ops-tools.ts')
const ablationPath = resolve('server/services/workshop/agents/industrial/ops-tools.approval-context-ablation.ts')
assert.equal(existsSync(ablationPath), false, 'refuse to overwrite a pre-existing ablation module')
const productionSource = readFileSync(productionPath, 'utf8')
const comparisonStart = productionSource.indexOf('  const current = currentGate.activeContext')
const comparisonEnd = productionSource.indexOf('\n  return null', comparisonStart)
assert.ok(comparisonStart >= 0 && comparisonEnd > comparisonStart, 'find the approved-context tuple comparison')
const ablatedSource = productionSource.slice(0, comparisonStart)
  + '  void expectedContext // test-only ablation: retain authority checks, omit tuple-equality checks\n'
  + productionSource.slice(comparisonEnd)
writeFileSync(ablationPath, ablatedSource, 'utf8')

const { DcwNode } = await import('../server/services/workshop/dcw/dcw-node')
const { getDcwNodeRepo } = await import('../server/services/workshop/dcw/dcw-node.repo')
const { getDcwProductRepo } = await import('../server/services/workshop/dcw/dcw-product.repo')
const { getDcwRecipeRepo } = await import('../server/services/workshop/dcw/dcw-recipe.repo')
const { setActiveLineRun, clearActiveLineRun, getActiveLineRun, getAllActiveLineRuns } = await import('../server/services/workshop/dcw/line-run')
const { mockDcwDriver } = await import('../server/services/workshop/dcw/drivers/mock')
const { getAgentNodeBindingRepo } = await import('../server/services/workshop/agents/node-bindings.repo')
const { getToolApprovals } = await import('../server/services/workshop/agents/tool-approvals')
const { openWorkshopDb } = await import('../server/services/workshop/db/database')
const { createAlarmEventRepo, createApprovalHistoryRepo, createApprovalRequestRepo, createAuditRepo } = await import('../server/services/workshop/db/ops.repo')
const { bindOpsRepos } = await import('../server/services/workshop/ops/ops')
const { toolRecipeApply, toolRecipeTrial, toolRecipeRollback } = await import(pathToFileURL(ablationPath).href)

const db = openWorkshopDb(resolve(process.env.AW_HOME!, 'recipe-context-ablation.sqlite'))
bindOpsRepos({
  approvalHistory: createApprovalHistoryRepo(db),
  alarmEvents: createAlarmEventRepo(db),
  audit: createAuditRepo(db),
  approvalRequests: createApprovalRequestRepo(db),
})

function fixture(id: string) {
  const lineId = `ablation-line-${id}`
  const agentId = `ablation-agent-${id}`
  const nodes = [50, 60].map((value, i) => {
    const node = new DcwNode({
      id: `ablation-node-${id}-${i}`, templateRef: 'dcw-temp-sp', driver: 'mock',
      driverConfig: { key: `ablation-${id}-${i}` }, min: 0, max: 100, unit: 'C', decimals: 1,
      lineId, readIntervalMs: 0, holdIntervalMs: null,
    })
    getDcwNodeRepo().insert(node)
    return { node, value }
  })
  const product = getDcwProductRepo().create({ name: `Ablation product ${id}`, lineId })
  const recipes = getDcwRecipeRepo()
  const recipe = recipes.create({
    name: `Ablation recipe ${id}`, productId: product.id, opIntervalMs: 0,
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
      for (const active of getAllActiveLineRuns().filter(active => active.recipeId === recipe.id)) clearActiveLineRun(active.lineId)
      for (const active of recipes.listRuns().filter(active => active.recipeId === recipe.id && !active.endedAt)) recipes.closeRun(active.id)
      getToolApprovals().cancelAllForAgent(agentId, 'Ablation test completed')
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

function changeContext(f: ReturnType<typeof fixture>, change: 'line' | 'product' | 'recipe' | 'run') {
  const active = getActiveLineRun(f.recipe.lineId)!
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
}

type AblationRow = { route: string, changedField: string, refused: boolean, mockDriverWrites: number, newExecutionRecords: number }
const rows: AblationRow[] = []
const routes = ['recipe_apply', 'recipe_trial', 'recipe_rollback(dispatch=true)'] as const
const fields = ['line', 'product', 'recipe', 'run'] as const

for (const route of routes) {
  for (const field of fields) {
    test(`ablation ${route}: outcome after ${field} changes during approval`, async (t) => {
      const f = fixture(`${route.replaceAll(/[^a-z]+/g, '-')}-${field}`)
      t.after(f.cleanup)
      const driverWrite = t.mock.method(mockDcwDriver, 'write', mockDcwDriver.write)
      if (route === 'recipe_rollback(dispatch=true)') {
        getDcwRecipeRepo().update(f.recipe.id, { params: f.recipe.params.map(p => ({ ...p, value: p.value + 5 })) })
      }
      const result = route === 'recipe_apply'
        ? toolRecipeApply(f.agentId, { recipe_id: f.recipe.id, reason: 'Tuple-comparison ablation' })
        : route === 'recipe_trial'
          ? toolRecipeTrial(f.agentId, {
              recipe_id: f.recipe.id,
              params: f.nodes.map(({ node, value }) => ({ node_id: node.id, value: value + 5 })),
              hypothesis: 'Tuple-comparison ablation',
            })
          : toolRecipeRollback(f.agentId, { recipe_id: f.recipe.id, version: 1, dispatch: true, reason: 'Tuple-comparison ablation' })
      const card = await pendingCard(f.agentId)
      changeContext(f, field)
      const recordCountAfterMutation = getDcwRecipeRepo().listRuns().length
      getToolApprovals().decide(card.id, true, 'Approve displayed action', 'ablation-owner')
      const resultValue = await result
      const row = {
        route,
        changedField: field,
        refused: resultValue.isError === true,
        mockDriverWrites: driverWrite.mock.callCount(),
        newExecutionRecords: getDcwRecipeRepo().listRuns().length - recordCountAfterMutation,
      }
      rows.push(row)
      console.log(`CONTEXT_ABLATION ${JSON.stringify(row)}`)
      assert.equal(typeof resultValue.text, 'string')
    })
  }
}

after(() => {
  console.log(`CONTEXT_ABLATION_SUMMARY ${JSON.stringify(rows)}`)
  if (existsSync(ablationPath)) unlinkSync(ablationPath)
})
