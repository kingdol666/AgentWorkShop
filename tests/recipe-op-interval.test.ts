/**
 * Recipe 级下发操作间隔卡控(opIntervalMs)单测:
 *   - 默认值兼容(老配方无字段 = 60000;0 = 显式禁用)
 *   - 归一化(非法值 400;治理配置原地改不增版本)
 *   - 审批锚捕获(decide 批准写锚;拒绝/update 不写)
 *   - 提案早拒(距锚不足间隔 → isError 且不建卡)
 *   - emergency 豁免频控不豁免审批(卡照建且标注应急)
 *   - 执行兜底(不同审批 id 且锚新鲜 → 429;同 id 自豁免)
 *   - 人工/系统路径豁免(无 agentDispatch 标记不查锚)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-recipe-op-interval-test-'))
delete process.env.AW_BENCH_MODE

const { getDcwNodeRepo } = await import('../server/services/workshop/dcw/dcw-node.repo')
const { getDcwProductRepo } = await import('../server/services/workshop/dcw/dcw-product.repo')
const { getDcwRecipeRepo, recipeOpIntervalMs } = await import('../server/services/workshop/dcw/dcw-recipe.repo')
const { setActiveLineRun, clearActiveLineRun } = await import('../server/services/workshop/dcw/line-run')
const {
  recordRecipeOpAnchor,
  getRecipeOpAnchor,
  resetRecipeOpAnchors,
  assertRecipeOpInterval,
  assertRecipeOpIntervalForExecution,
} = await import('../server/services/workshop/dcw/recipe-op-anchor')
const { getToolApprovals } = await import('../server/services/workshop/agents/tool-approvals')
const { recipeApprovalPayload } = await import('../server/services/workshop/agents/industrial/recipe-gate')
const { toolRecipeTrial } = await import('../server/services/workshop/agents/industrial/ops-tools')
const { DcwNode } = await import('../server/services/workshop/dcw/dcw-node')
const { openWorkshopDb } = await import('../server/services/workshop/db/database')
const { createAlarmEventRepo, createApprovalHistoryRepo, createApprovalRequestRepo, createAuditRepo } = await import('../server/services/workshop/db/ops.repo')
const { bindOpsRepos } = await import('../server/services/workshop/ops/ops')
const { getAgentNodeBindingRepo } = await import('../server/services/workshop/agents/node-bindings.repo')

const db = openWorkshopDb(join(process.env.AW_HOME!, 'recipe-op-interval-test.sqlite'))
bindOpsRepos({
  approvalHistory: createApprovalHistoryRepo(db),
  alarmEvents: createAlarmEventRepo(db),
  audit: createAuditRepo(db),
  approvalRequests: createApprovalRequestRepo(db),
})

const mkNode = (over: Partial<ConstructorParameters<typeof DcwNode>[0]> & { id: string }): DcwNode =>
  new DcwNode({ templateRef: 'dcw-temp-sp', driver: 'mock', min: 0, max: 100, unit: '℃', decimals: 1, ...over })

// ---------- ① 默认值兼容 + 归一化 + 版本语义 ----------

test('默认值兼容:老配方无 opIntervalMs 字段 → 读取器返回 60000', () => {
  assert.equal(recipeOpIntervalMs(undefined as never), 60_000)
  assert.equal(recipeOpIntervalMs({}), 60_000)
  assert.equal(recipeOpIntervalMs({ opIntervalMs: 120_000 }), 120_000)
  assert.equal(recipeOpIntervalMs({ opIntervalMs: 0 }), 0)
})

test('归一化:create/update 合法值生效;非法值 400;0=显式禁用', () => {
  const node = mkNode({ id: 'oi-n1', lineId: 'ln-oi' })
  getDcwNodeRepo().insert(node)
  const product = getDcwProductRepo().create({ name: '频控产品', lineId: 'ln-oi' })
  const rc = getDcwRecipeRepo().create({
    name: '频控配方', productId: product.id,
    params: [{ nodeId: node.id, value: 50 }],
    opIntervalMs: 120_000,
  })
  assert.equal(rc.opIntervalMs, 120_000)
  assert.equal(recipeOpIntervalMs(getDcwRecipeRepo().byId(rc.id)!), 120_000)

  for (const bad of [-1, 'abc', 86_400_001, 1.5]) {
    assert.throws(() => getDcwRecipeRepo().update(rc.id, { opIntervalMs: bad as never }), /opIntervalMs 需为/, `bad=${String(bad)} 应 400`)
  }
  // 治理配置原地改:版本/参数史不动
  const vBefore = getDcwRecipeRepo().byId(rc.id)!.version
  const histBefore = getDcwRecipeRepo().byId(rc.id)!.paramsHistory?.length ?? 0
  getDcwRecipeRepo().update(rc.id, { opIntervalMs: 0 })
  const after = getDcwRecipeRepo().byId(rc.id)!
  assert.equal(after.opIntervalMs, 0)
  assert.equal(after.version, vBefore, '治理配置变更不应增版本')
  assert.equal(after.paramsHistory?.length ?? 0, histBefore, '治理配置变更不应入参数史')
})

// ---------- ② 审批锚捕获(批准写锚;拒绝/update 不写) ----------

const NODE = mkNode({ id: 'oi-n2', lineId: 'ln-oi2' })
getDcwNodeRepo().insert(NODE)
const PRODUCT = getDcwProductRepo().create({ name: '频控产品2', lineId: 'ln-oi2' })
export const RC = getDcwRecipeRepo().create({
  name: '频控配方2', productId: PRODUCT.id,
  params: [{ nodeId: NODE.id, value: 50 }],
  opIntervalMs: 60_000,
})

// request() 返回的 Promise 只有裁决后才 resolve —— 测试里一律不 await 它,
// 挂卡后从 listPending() 拿单号再 decide(与真实审批 UI 同步序)。
async function requestCard(agentId: string, payload: unknown, detail = '试验审批'): Promise<{ id: string }> {
  const ta = getToolApprovals()
  void ta.request(agentId, `recipe:${RC.id}`, 'dcw', detail, { payload })
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 15))
    const card = ta.listPending().find(c => c.agentId === agentId && c.nodeId === `recipe:${RC.id}`)
    if (card) return card
  }
  throw new Error('审批卡未挂起(request 未注册 pending)')
}

test('锚捕获:批准的 recipe-gate(trial)单落锚;拒绝的单不落锚', async () => {
  resetRecipeOpAnchors()
  const ta = getToolApprovals()
  const c1 = await requestCard('ag-x', recipeApprovalPayload('trial', RC.id, RC.name, { reason: '测试' }))
  await ta.decide(c1.id, false, '先不同意')
  assert.equal(getRecipeOpAnchor(RC.id), null, '拒绝的审批不计时(不写锚)')

  const c2 = await requestCard('ag-x', recipeApprovalPayload('trial', RC.id, RC.name, { reason: '测试' }))
  await ta.decide(c2.id, true, '批准')
  const anchor = getRecipeOpAnchor(RC.id)
  assert.ok(anchor, '批准后应落锚')
  assert.equal(anchor!.recipeId, RC.id)
  assert.equal(anchor!.approvalId, c2.id)
  assert.equal(anchor!.op, 'trial')
  assert.equal(anchor!.source, 'hitl-approved')
  assert.ok(Math.abs(anchor!.at - Date.now()) < 5_000, '锚时刻≈审批时刻')
})

test('锚捕获:recipe_update 审批不计锚(仅写定义,不触产线)', async () => {
  const before = getRecipeOpAnchor(RC.id)!.at
  const c = await requestCard('ag-x', recipeApprovalPayload('update', RC.id, RC.name, { reason: '仅改定义' }), '改定义审批')
  await getToolApprovals().decide(c.id, true, '批准')
  assert.equal(getRecipeOpAnchor(RC.id)!.at, before, 'update 审批不应前移锚')
})

// ---------- ③ 提案早拒 + emergency 豁免(频控豁免、审批不豁免) ----------

async function withRun<T>(fn: () => Promise<T>): Promise<T> {
  // 运行门交叉校验:注册表 + 真实批次行都要在(a5726ec 防僵尸语义),夹具两者都建
  const run = getDcwRecipeRepo().createRun(RC)
  setActiveLineRun({ lineId: 'ln-oi2', runId: run.id, recipeId: RC.id, recipeName: RC.name, productId: PRODUCT.id, productName: PRODUCT.name, startedAt: run.startedAt, taggedSamples: 0 })
  getAgentNodeBindingRepo().bind('ag-x', RC.id, 'recipe', 'manual')
  try {
    return await fn()
  }
  finally {
    clearActiveLineRun('ln-oi2')
    getDcwRecipeRepo().closeRun(run.id)
  }
}

test('提案早拒:距锚不足间隔 → isError 且不创建审批卡', async () => {
  await withRun(async () => {
    const ta = getToolApprovals()
    const pendingBefore = ta.listPending().length
    const r = await toolRecipeTrial('ag-x', {
      recipe_id: RC.id,
      params: [{ node_id: NODE.id, value: 55 }],
      hypothesis: '测试候选',
    })
    assert.equal(r.isError, true)
    assert.match(r.text, /下发操作间隔卡控/)
    assert.match(r.text, /emergency=true/, '报错应给应急豁免指引')
    assert.equal(ta.listPending().length, pendingBefore, '早拒不得创建审批卡')
  })
})

test('emergency=true 豁免频控但审批照挂,卡片标注【应急】', async () => {
  await withRun(async () => {
    const ta = getToolApprovals()
    const p = toolRecipeTrial('ag-x', {
      recipe_id: RC.id,
      params: [{ node_id: NODE.id, value: 55 }],
      hypothesis: '应急纠偏测试(不会获批,用于验证豁免路径)',
      emergency: true,
    })
    // 轮询等挂卡(toolRecipeTrial 内部 request 为挂起 Promise)
    let card: { id: string, detail: string, payload?: unknown } | null = null
    for (let i = 0; i < 40 && !card; i++) {
      await new Promise(r => setTimeout(r, 15))
      card = ta.listPending().find(c => c.agentId === 'ag-x' && c.detail.includes('【应急豁免频控】')) ?? null
    }
    assert.ok(card, 'emergency 应照常创建审批卡且标注应急')
    assert.equal((card!.payload as { emergency?: boolean })?.emergency, true, 'payload 应带 emergency 标记')
    await ta.decide(card!.id, false, '测试收敛,不同意')
    const out = await p
    assert.match(out.text, /人工未批准/, '审批不豁免:拒绝即不下发')
  })
})

// ---------- ④ 执行兜底 + 人工/系统豁免 ----------

test('执行兜底:锚新鲜 + 不同审批 id → 429;同审批 id 自豁免', () => {
  resetRecipeOpAnchors()
  recordRecipeOpAnchor({ recipeId: RC.id, at: Date.now(), approvalId: 'ap-A', agentId: 'ag-a', op: 'trial', source: 'hitl-approved' })
  // 不同审批 id(说明有更新的已批单抢先落锚)→ 拦
  assert.throws(() => assertRecipeOpIntervalForExecution(RC, { approvalId: 'ap-B' }), (err: unknown) => (err as { code?: string }).code === 'RECIPE_OP_INTERVAL_NOT_ELAPSED')
  // 同审批 id = 自己刚获批的那次 → 放行
  assert.doesNotThrow(() => assertRecipeOpIntervalForExecution(RC, { approvalId: 'ap-A' }))
  // emergency → 放行
  assert.doesNotThrow(() => assertRecipeOpIntervalForExecution(RC, { approvalId: 'ap-B', emergency: true }))
})

test('锚过期/禁用间隔 → 判定放行;人工与系统路径豁免语义由"无 agentDispatch 不调用"保证', () => {
  resetRecipeOpAnchors()
  // 过期锚(> interval)
  recordRecipeOpAnchor({ recipeId: RC.id, at: Date.now() - 61_000, approvalId: 'ap-old', agentId: 'ag-a', op: 'trial', source: 'hitl-approved' })
  assert.doesNotThrow(() => assertRecipeOpInterval(RC))
  // interval=0 显式禁用
  const rc0 = { ...RC, opIntervalMs: 0 }
  recordRecipeOpAnchor({ recipeId: RC.id, at: Date.now(), approvalId: 'ap-x', agentId: 'ag-a', op: 'apply', source: 'agent-executed' })
  assert.doesNotThrow(() => assertRecipeOpInterval(rc0))
})
