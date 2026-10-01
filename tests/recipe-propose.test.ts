/**
 * 产线 Co-Pilot P2 单测(整包审批链的服务端基座):
 *   - evaluateRecipeParamLimits 只读预检谓词(write.ts 抽取):量程内 ok / 超量程 violations /
 *     非数字目标值 / 消息与 assertWithinLimits 零漂移 / skipRecipe 语义镜像配方下发真实路径
 *     (不含配方工艺窗口;步长/60s/保持窗本就不适用 recipe,预检不得擅自收紧)
 *   - combineAmlActivitySignals 纯归并(任一信号即活动;理由去重)
 *   - amlActivityForLine 三路信号真实查询(夹具注入:频道投用模型 / 在跑作业 / 近 30min 优化事件)
 *   - toolRecipePropose 入参校验层(packages 1..3;basis/exp_ref 缺失指明缺什么)
 * write.ts 行为零变化由既有 dcw 相关单测(dcw-step-limit.test.ts 等)与本谓词对照断言共同背书。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-recipe-propose-test-'))
delete process.env.AW_BENCH_MODE

const { evaluateRecipeParamLimits } = await import('../server/services/workshop/dcw/dcw-controller/write')
const { assertWithinLimits } = await import('../server/services/workshop/dcw/param-limits')
const { DcwNode } = await import('../server/services/workshop/dcw/dcw-node')
const { getDcwNodeRepo } = await import('../server/services/workshop/dcw/dcw-node.repo')
const { getDcwProductRepo } = await import('../server/services/workshop/dcw/dcw-product.repo')
const { getDcwRecipeRepo } = await import('../server/services/workshop/dcw/dcw-recipe.repo')
const { setActiveLineRun, clearActiveLineRun } = await import('../server/services/workshop/dcw/line-run')
const { combineAmlActivitySignals, amlActivityForLine, toolAmlActivity } = await import('../server/services/workshop/agents/industrial/aml-activity')
const { toolRecipePropose } = await import('../server/services/workshop/agents/industrial/recipe-propose-tools')
const { openWorkshopDb } = await import('../server/services/workshop/db/database')
const { configureAmlRuntime, getAmlRuntime } = await import('../server/services/workshop/aml/runtime')
const { setHybridChannelProfile } = await import('../server/services/workshop/aml/twin/channel-profile')
const { getAgentNodeBindingRepo } = await import('../server/services/workshop/agents/node-bindings.repo')
const { createAlarmEventRepo, createApprovalHistoryRepo, createApprovalRequestRepo, createAuditRepo } = await import('../server/services/workshop/db/ops.repo')
const { bindOpsRepos, getOps } = await import('../server/services/workshop/ops/ops')

const mkNode = (over: Partial<ConstructorParameters<typeof DcwNode>[0]> & { id: string }): DcwNode => {
  const n = new DcwNode({ templateRef: 'dcw-temp-sp', driver: 'mock', min: 0, max: 100, unit: '℃', decimals: 1, ...over })
  return n
}

/** assertWithinLimits 的 throw 消息(用于与谓词 violations[0] 做零漂移对照) */
function throwMsgOf(node: DcwNode, eng: number, skipRecipe: boolean): string {
  try {
    assertWithinLimits(node, eng, { skipRecipe })
    return ''
  }
  catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

// ---------- evaluateRecipeParamLimits ----------

test('谓词:量程内 ok 且零 violations,不产生任何写副作用', () => {
  const n = mkNode({ id: 'rp-n-ok' })
  const out = evaluateRecipeParamLimits(n, 50)
  assert.deepEqual(out, { ok: true, violations: [] })
})

test('谓词:超量程 → violations 携带与 assertWithinLimits 同文消息,error 保留原始错误码', () => {
  const n = mkNode({ id: 'rp-n-over' })
  const out = evaluateRecipeParamLimits(n, 120)
  assert.equal(out.ok, false)
  assert.equal(out.violations.length, 1)
  assert.equal(out.violations[0], throwMsgOf(n, 120, true))
  assert.equal((out.error as { code?: string }).code, 'NODE_RANGE_EXCEEDED')
})

test('谓词:非数字目标值 → 400 校验拒绝(与 write 咽喉点同口径)', () => {
  const n = mkNode({ id: 'rp-n-nan' })
  const out = evaluateRecipeParamLimits(n, Number.NaN)
  assert.equal(out.ok, false)
  assert.match(out.violations[0]!, /需为数字/)
  assert.equal((out.error as { code?: string }).code, 'VALIDATION_ERROR')
})

test('谓词 skipRecipe 语义镜像配方下发路径:配方工艺窗口不参与预检(在线写路径才参与)', () => {
  // 夹具:节点挂线 → 产品 → 配方(参数窗口 40~60)→ 激活批次窗口
  const node = mkNode({ id: 'rp-n-win', lineId: 'ln-win' })
  getDcwNodeRepo().insert(node)
  const product = getDcwProductRepo().create({ name: '预检产品', lineId: 'ln-win' })
  const recipe = getDcwRecipeRepo().create({
    name: '预检配方', productId: product.id,
    params: [{ nodeId: node.id, value: 50, min: 40, max: 60 }],
  })
  setActiveLineRun({ lineId: 'ln-win', runId: 'run-win', recipeId: recipe.id, recipeName: recipe.name, productId: product.id, productName: product.name, startedAt: new Date().toISOString(), taggedSamples: 0 })
  try {
    // 配方下发路径(skipRecipe:true)= 真实 recipe 语义:只看量程∩参数∩产品,70 越配方窗但量程内 → 预检放行
    assert.equal(evaluateRecipeParamLimits(node, 70, { skipRecipe: true }).ok, true)
    // 在线写路径(缺省):活动配方工艺窗口参与约束,同值被配方窗拒绝(两语义必须可区分)
    const online = evaluateRecipeParamLimits(node, 70)
    assert.equal(online.ok, false)
    assert.match(online.violations[0]!, /配方/)
    // 量程内配方窗内:两路径都放行;配方窗下沿之下:在线路径拒绝,recipe 路径放行
    assert.equal(evaluateRecipeParamLimits(node, 50, { skipRecipe: true }).ok, true)
    assert.equal(evaluateRecipeParamLimits(node, 35, { skipRecipe: true }).ok, true)
    assert.equal(evaluateRecipeParamLimits(node, 35).ok, false)
  }
  finally {
    clearActiveLineRun('ln-win')
  }
})

// ---------- combineAmlActivitySignals(纯归并) ----------

test('信号归并:两路全空 = 不活动;任一命中即活动且理由去重', () => {
  const idle = combineAmlActivitySignals({ profileReasons: [], jobReasons: [] })
  assert.deepEqual(idle, { active: false, reasons: [] })
  const mixed = combineAmlActivitySignals({
    profileReasons: ['频道 A 投用模型 m1'],
    jobReasons: ['作业 j1 进行中'],
  })
  assert.equal(mixed.active, true)
  assert.equal(mixed.reasons.length, 2)
  const dup = combineAmlActivitySignals({ profileReasons: ['同一理由'], jobReasons: ['同一理由'] })
  assert.equal(dup.active, true)
  assert.deepEqual(dup.reasons, ['同一理由'])
  // 空白理由行不触发活动
  assert.equal(combineAmlActivitySignals({ profileReasons: ['  '], jobReasons: [] }).active, false)
})

// ---------- amlActivityForLine(真实查询;夹具注入三路信号) ----------

const db = openWorkshopDb(join(process.env.AW_HOME!, 'recipe-propose-test.sqlite'))
configureAmlRuntime(db)
bindOpsRepos({
  approvalHistory: createApprovalHistoryRepo(db),
  alarmEvents: createAlarmEventRepo(db),
  audit: createAuditRepo(db),
  approvalRequests: createApprovalRequestRepo(db),
})
const insertChannel = db.prepare('INSERT OR IGNORE INTO channels (id, name, description, enabled, line_id, created_at, updated_at) VALUES (?, ?, \'\', 1, ?, ?, ?)')
const now = new Date().toISOString()
const T0 = Date.UTC(2026, 9, 1, 8, 0, 0)

test('amlActivityForLine:空库产线不活动', () => {
  assert.deepEqual(amlActivityForLine('ln-none'), { active: false, reasons: [] })
})

test('amlActivityForLine 信号①:投用(production)模型且策略非仅建议 → 活动;候选模型不触发', () => {
  insertChannel.run('ch-aml-1', '工艺优化测试频道', 'ln-aml', now, now)
  setHybridChannelProfile({ channelId: 'ch-aml-1', profile: 'aml_optimization', capability: {}, controlPolicy: 'bounded_auto', boundModelId: 'mdl-1', boundAt: now, createdBy: 'test' })
  const rt = getAmlRuntime()
  // 谱系链:dataset → job → experiment → model(FK 级联)
  rt.repo.dataset.insert({
    id: 'ds-1', lineId: 'ln-aml', productId: 'pd', recipeId: 'rc', runIds: [], specJson: '{}', sha256: 'x',
    rowCount: 0, fromMs: T0, toMs: T0, path: 'p', createdBy: 'test', createdByKind: 'agent', note: '', createdAt: now,
  })
  rt.repo.job.insert({ id: 'job-1', datasetId: 'ds-1', purpose: 'quality', budget: {}, agentId: '', channelId: '', taskId: '', createdAt: now })
  // 谱系夹具作业置 done:信号① 测试只验证 profile 投用信号,不被在跑作业信号干扰(信号② 单测)
  rt.repo.job.setState('job-1', 'done', 'done', 100)
  rt.repo.experiment.insert({ id: 'exp-1', jobId: 'job-1', datasetId: 'ds-1', changeNote: '基线', configJson: '{}', createdAt: now })
  rt.repo.model.insert({
    id: 'mdl-1', experimentId: 'exp-1', datasetId: 'ds-1', productId: 'pd', recipeId: 'rc', purpose: 'quality',
    ioSpecJson: '{}', metricsJson: '{}', path: 'x', createdBy: 'test', note: '', lineId: 'ln-aml', createdAt: now,
  })
  // 候选阶段:不算投用 → 不活动
  assert.equal(amlActivityForLine('ln-aml').active, false)
  // 晋升 production → 活动且理由点名模型
  assert.equal(rt.repo.model.transition('mdl-1', 'candidate', 'production', 'tester', now), true)
  const active = amlActivityForLine('ln-aml')
  assert.equal(active.active, true)
  assert.ok(active.reasons.some(r => r.includes('mdl-1')), '活动理由应点名投用模型')
  // 换一条无绑定产线:仍不活动(信号按产线隔离)
  assert.equal(amlActivityForLine('ln-other').active, false)
})

test('amlActivityForLine 信号②:在跑优化作业经 datasetId 联查产线 → 活动', () => {
  const rt = getAmlRuntime()
  rt.repo.dataset.insert({
    id: 'ds-2', lineId: 'ln-aml', productId: 'pd', recipeId: 'rc', runIds: [], specJson: '{}', sha256: 'x',
    rowCount: 0, fromMs: T0, toMs: T0, path: 'p', createdBy: 'test', createdByKind: 'agent', note: '', createdAt: now,
  })
  rt.repo.job.insert({ id: 'job-2', datasetId: 'ds-2', purpose: 'train', budget: {}, agentId: '', channelId: '', taskId: '', createdAt: now })
  const active = amlActivityForLine('ln-aml')
  assert.equal(active.active, true)
  assert.ok(active.reasons.some(r => r.includes('job-2')), '活动理由应点名在跑作业')
})

test('amlActivityForLine:普通 Agent 写的 optimization.open 事件不再误判为 AML 活动(假阳性修复)', () => {
  // 干净产线(无投用模型/无在跑作业):仅有普通 Agent 写的优化开窗审计 → 不得判活动
  getOps()!.audit.append({
    actor: 'u1', actorKind: 'agent', action: 'optimization.open', targetKind: 'dcw', targetId: 'n1',
    lineId: 'ln-aml-fresh', kind: 'write', summary: '优化开窗:节点 n1 试探', at: new Date().toISOString(),
  })
  const active = amlActivityForLine('ln-aml-fresh')
  assert.equal(active.active, false)
  assert.equal(active.reasons.length, 0)
})

test('aml_activity 工具:可见产线输出活动判定与理由行,越权产线拒绝', async () => {
  // 授权:绑定一个挂在 ln-aml 的数控节点(可读面 = 节点授权线 ∪ 频道绑线)
  const probe = mkNode({ id: 'rp-n-probe', lineId: 'ln-aml' })
  getDcwNodeRepo().insert(probe)
  getAgentNodeBindingRepo().bind('ag-doctor', probe.id, 'dcw', 'manual')
  const ok = await toolAmlActivity('ag-doctor', { line_id: 'ln-aml' })
  assert.match(ok.text, /AML 优化循环\*\*活动\*\*/)
  assert.match(ok.text, /投用 AML 优化模型|在跑优化作业/)
  const denied = await toolAmlActivity('ag-doctor', { line_id: 'ln-secret' })
  assert.equal(denied.isError, true)
  assert.match(denied.text, /无权查询/)
})

// ---------- toolRecipePropose 入参校验层 ----------

test('recipe_propose 校验:recipe_id/packages 缺失与超量指明原因', async () => {
  const noId = await toolRecipePropose('ag-doctor', {})
  assert.equal(noId.isError, true)
  assert.match(noId.text, /recipe_id 必填/)
  const noPkgs = await toolRecipePropose('ag-doctor', { recipe_id: 'rc-x' })
  assert.equal(noPkgs.isError, true)
  assert.match(noPkgs.text, /packages 必填/)
  const tooMany = await toolRecipePropose('ag-doctor', {
    recipe_id: 'rc-x',
    packages: [1, 2, 3, 4].map(i => ({ name: `方案${i}`, params: [{ node_id: 'n', to: 1, basis: 'b', exp_ref: 'e' }] })),
  })
  assert.equal(tooMany.isError, true)
  assert.match(tooMany.text, /最多 3 套/)
})

test('recipe_propose 校验:缺 basis/exp_ref 逐条指明哪套哪条缺什么,不挂审批单', async () => {
  const out = await toolRecipePropose('ag-doctor', {
    recipe_id: 'rc-x',
    packages: [{ name: '方案A', params: [{ node_id: 'n1', to: 52 }, { node_id: 'n2', to: 10, basis: '有依据', exp_ref: '' }] }],
  })
  assert.equal(out.isError, true)
  assert.match(out.text, /方案「方案A」第 1 条参数:缺 basis/)
  assert.match(out.text, /方案「方案A」第 1 条参数:缺 exp_ref/)
  assert.match(out.text, /方案「方案A」第 2 条参数:缺 exp_ref/)
  assert.match(out.text, /请补齐后重新提交/)
})
