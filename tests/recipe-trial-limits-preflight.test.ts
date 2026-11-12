/**
 * P2 验收收口回归(2026-11-12):recipe_trial 的候选限界预检必须发生在 HITL 挂卡之前。
 *
 * 事故形态(2026-11-12 main 验收 §3.3/§7):200 bar(>节点 100 上限)的试验候选
 * 照样生成审批卡,人工批准后才在 DcwController.write() 咽喉点被量程联锁拒绝。
 * 设备零变更(安全成立),但白白消耗一次人工审批与产线窗口。
 *
 * 本测试锁定:
 *  - 超量程候选:立即 isError、不建卡、不写驱动、不开执行批次、节点值不变;
 *  - 合法候选:仍按 manual 绑定正常挂卡(预检不误拦);
 *  - 预检纯函数:边界值放行、越界逐项点名、部分越界整批拒绝、跨层同口径。
 *
 * 夹具为真 SQLite + 真 repo + mock 驱动(与 recipe-approval-snapshot 同装配)。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-trial-preflight-'))
delete process.env.AW_BENCH_MODE

const { DcwNode } = await import('../server/services/workshop/dcw/dcw-node')
const { getDcwNodeRepo } = await import('../server/services/workshop/dcw/dcw-node.repo')
const { getDcwProductRepo } = await import('../server/services/workshop/dcw/dcw-product.repo')
const { getDcwRecipeRepo } = await import('../server/services/workshop/dcw/dcw-recipe.repo')
const { setActiveLineRun, clearActiveLineRun, getAllActiveLineRuns } = await import('../server/services/workshop/dcw/line-run')
const { mockDcwDriver } = await import('../server/services/workshop/dcw/drivers/mock')
const { getAgentNodeBindingRepo } = await import('../server/services/workshop/agents/node-bindings.repo')
const { getToolApprovals } = await import('../server/services/workshop/agents/tool-approvals')
const { toolRecipeTrial, recipeTrialValuePreflight } = await import('../server/services/workshop/agents/industrial/ops-tools')
const { evaluateRecipeParamLimits } = await import('../server/services/workshop/dcw/dcw-controller/write')
const { openWorkshopDb } = await import('../server/services/workshop/db/database')
const { createAlarmEventRepo, createApprovalHistoryRepo, createApprovalRequestRepo, createAuditRepo } = await import('../server/services/workshop/db/ops.repo')
const { bindOpsRepos } = await import('../server/services/workshop/ops/ops')

const db = openWorkshopDb(join(process.env.AW_HOME!, 'trial-preflight.sqlite'))
bindOpsRepos({
  approvalHistory: createApprovalHistoryRepo(db),
  alarmEvents: createAlarmEventRepo(db),
  audit: createAuditRepo(db),
  approvalRequests: createApprovalRequestRepo(db),
})

function fixture(id: string, window?: { min: number, max: number }) {
  const lineId = `ln-${id}`
  const agentId = `ag-${id}`
  const nodes = [50, 60].map((value, i) => {
    const node = new DcwNode({
      id: `dw-${id}-${i}`, templateRef: 'dcw-temp-sp', driver: 'mock',
      driverConfig: { key: `${id}-${i}` }, min: 0, max: 100, unit: 'bar', decimals: 1,
      lineId, readIntervalMs: 0, holdIntervalMs: null,
    })
    getDcwNodeRepo().insert(node)
    return { node, value }
  })
  const product = getDcwProductRepo().create({ name: `Product ${id}`, lineId })
  const recipes = getDcwRecipeRepo()
  const recipe = recipes.create({
    name: `Recipe ${id}`, productId: product.id, opIntervalMs: 0,
    params: nodes.map(({ node, value }) => ({
      nodeId: node.id,
      value,
      ...(window ? { min: window.min, max: window.max } : {}),
    })),
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
      for (const active of getAllActiveLineRuns().filter(r => r.recipeId === recipe.id)) clearActiveLineRun(active.lineId)
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
  assert.fail('recipe trial did not create a pending approval')
}

test('超量程候选在挂 HITL 卡之前即拒:零审批卡 / 零驱动写 / 零执行批次 / 设备零变更', async (t) => {
  const f = fixture('over-range')
  t.after(f.cleanup)
  const writeSpy = t.mock.method(mockDcwDriver, 'write', mockDcwDriver.write)
  const runsBefore = getDcwRecipeRepo().listRuns().length
  const out = await toolRecipeTrial(f.agentId, {
    recipe_id: f.recipe.id,
    hypothesis: 'P2 回归:超量程候选不应进入人工审批',
    params: [{ node_id: f.nodes[0]!.node.id, value: 200 }],
  })
  assert.equal(out.isError, true, '确定性非法候选必须报错')
  assert.match(out.text, /挂卡前限界预检/)
  assert.match(out.text, /未创建审批卡/)
  assert.match(out.text, /设备零变更/)
  assert.match(out.text, /节点安全量程|超出上限/, '拒绝理由必须点名被越的约束层')
  assert.equal(getToolApprovals().listPending(f.agentId).length, 0, '不得生成任何待审卡')
  assert.equal(getToolApprovals().historyList().filter(a => a.agentId === f.agentId).length, 0, '不得留下审批历史')
  assert.equal(writeSpy.mock.callCount(), 0, '不得触碰设备驱动')
  assert.equal(getDcwRecipeRepo().listRuns().length, runsBefore, '不得创建执行批次')
  for (const { node } of f.nodes) assert.equal(node.value, null, '节点设定值必须不变')
})

test('活动配方窗口越界也在挂 HITL 卡之前拒绝', async (t) => {
  const f = fixture('recipe-window', { min: 40, max: 60 })
  t.after(f.cleanup)
  const out = await toolRecipeTrial(f.agentId, {
    recipe_id: f.recipe.id,
    hypothesis: '配方窗口外候选不应进入人工审批',
    params: [{ node_id: f.nodes[0]!.node.id, value: 80 }],
  })
  assert.equal(out.isError, true)
  assert.match(out.text, /挂卡前限界预检/)
  assert.match(out.text, /配方.*工艺窗口|超出上限/)
  assert.equal(getToolApprovals().listPending(f.agentId).length, 0)
  assert.equal(f.nodes[0]!.node.value, null)
})

test('合法候选不受影响:manual 绑定仍正常挂 HITL 卡(预检不误拦)', async (t) => {
  const f = fixture('in-range')
  t.after(f.cleanup)
  const task = toolRecipeTrial(f.agentId, {
    recipe_id: f.recipe.id,
    hypothesis: '窗口内小步幅候选应当照常等待人工批准',
    params: [{ node_id: f.nodes[0]!.node.id, value: 53 }],
  })
  const card = await pendingCard(f.agentId)
  assert.match(card.detail, /试验|候选|下发/)
  getToolApprovals().decide(card.id, false, '本用例只验证挂卡,不下发', 'local-owner', 'Local owner')
  const out = await task
  assert.equal(out.isError, undefined, '人工拒绝是正常语义,不是工具错误')
  assert.match(out.text, /人工未批准/)
  assert.equal(getToolApprovals().listPending(f.agentId).length, 0)
  for (const { node } of f.nodes) assert.equal(node.value, null)
})

test('合法候选批准后仍走 mock 驱动并完成设备回读', async (t) => {
  const f = fixture('approved')
  t.after(f.cleanup)
  const writeSpy = t.mock.method(mockDcwDriver, 'write', mockDcwDriver.write)
  const task = toolRecipeTrial(f.agentId, {
    recipe_id: f.recipe.id,
    hypothesis: '批准后的合法数字字符串候选必须完成设备证实',
    params: [{ node_id: f.nodes[0]!.node.id, value: '53' }],
  })
  const card = await pendingCard(f.agentId)
  getToolApprovals().decide(card.id, true, '批准合法候选', 'local-owner', 'Local owner')
  const out = await task
  assert.equal(out.isError, undefined)
  assert.match(out.text, /全部设备证实|证实/)
  assert.equal(writeSpy.mock.callCount(), 1)
  assert.equal(f.nodes[0]!.node.value, 53)
})

test('混入非法参数时整批拒绝,不静默缩减为合法子集', async (t) => {
  const f = fixture('malformed')
  t.after(f.cleanup)
  for (const value of [null, '', true, Number.NaN, Number.POSITIVE_INFINITY, 'NaN', 'Infinity', 'not-a-number']) {
    const out = await toolRecipeTrial(f.agentId, {
      recipe_id: f.recipe.id,
      hypothesis: '非法参数不能被静默丢弃',
      params: [
        { node_id: f.nodes[0]!.node.id, value: 53 },
        { node_id: f.nodes[1]!.node.id, value: value as never },
      ],
    })
    assert.equal(out.isError, true)
    assert.match(out.text, /整批候选已拒绝/)
    assert.equal(getToolApprovals().listPending(f.agentId).length, 0)
  }
})

test('预检纯函数:边界值放行、越界点名、部分越界整批拒绝、与 write() 断言同文', (t) => {
  const f = fixture('pure')
  t.after(f.cleanup)
  const n0 = f.nodes[0]!.node
  const n1 = f.nodes[1]!.node
  assert.equal(recipeTrialValuePreflight([{ nodeId: n0.id, value: 0 }]), null, '下限恰好在界内')
  assert.equal(recipeTrialValuePreflight([{ nodeId: n0.id, value: 100 }]), null, '上限恰好在界内')
  assert.equal(recipeTrialValuePreflight([
    { nodeId: n0.id, value: 50 }, { nodeId: n1.id, value: 60 },
  ]), null, '配方内现值必须放行')

  const single = recipeTrialValuePreflight([{ nodeId: n0.id, value: 100.001 }])
  assert.ok(single)
  assert.match(single.text, /超出上限/)
  // 与执行层咽喉点的断言逐字同源(单点收敛,消息零漂移)
  const throat = evaluateRecipeParamLimits(n0, 100.001, { skipRecipe: true })
  assert.equal(throat.ok, false)
  assert.ok(single.text.includes(throat.violations[0]!), '预检消息必须原样包含 write() 的拒绝理由')

  const mixed = recipeTrialValuePreflight([
    { nodeId: n0.id, value: 55 }, { nodeId: n1.id, value: -1 },
  ])
  assert.ok(mixed, '只要有一个参数越界,整批候选都不得入审')
  assert.match(mixed.text, /「.*」-1bar/, '点名越界的那一个参数')
  // 未知节点由前序节点存在性校验负责,预检不重复报错(返回 null)
  assert.equal(recipeTrialValuePreflight([{ nodeId: 'dw-not-exist', value: 999 }]), null)
  void t
})
