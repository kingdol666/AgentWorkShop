/**
 * ToolApprovalService P2 扩展单测(产线 Co-Pilot 整包审批链):
 *   - opts.timeoutMs 覆写生效(expiresAt 与 timer 同源;短超时按拒绝收敛)
 *   - payload 进 pending 与审批历史(payload_json 列,重启可追溯参数表)
 *   - choice 进 resolve 通道与历史(多方案裁决序号留痕)
 *   - normalizeRecipeProposeDecision fail-closed:schemaVersion=1 无 choice/越界 choice 的
 *     「批准」一律按拒绝收敛;legacy 审批单(无 payload)完全不干预
 *   - approval_history payload_json/choice 加列迁移(旧表 → initWorkshopDb 补列 → 落库可查)
 * 向后兼容铁律:不传 opts 的既有调用形态(param_control/manual-approval/recipe 门)回归断言在案。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-tool-approvals-choice-test-'))
delete process.env.AW_BENCH_MODE

const { getToolApprovals, normalizeRecipeProposeDecision } = await import('../server/services/workshop/agents/tool-approvals')
const { initWorkshopDb } = await import('../server/services/workshop/db/database')
const { createAlarmEventRepo, createApprovalHistoryRepo, createApprovalRequestRepo, createAuditRepo } = await import('../server/services/workshop/db/ops.repo')
const { bindOpsRepos } = await import('../server/services/workshop/ops/ops')

// 审批历史仓储接线(覆盖 remember→upsert 持久化分支与 historyList 的持久化读取分支)
const db = new DatabaseSync(':memory:')
initWorkshopDb(db)
bindOpsRepos({
  approvalHistory: createApprovalHistoryRepo(db),
  alarmEvents: createAlarmEventRepo(db),
  audit: createAuditRepo(db),
  approvalRequests: createApprovalRequestRepo(db),
})

const PAYLOAD = {
  schemaVersion: 1,
  recipeId: 'rc-x',
  lineId: 'ln-x',
  packages: [
    { name: '方案A', rationale: 'a', params: [{ nodeId: 'n1', paramName: '温度', from: 50, to: 52, unit: '℃', basis: '依据', exp_ref: '经验 v1', preflight: { ok: true } }] },
    { name: '方案B', rationale: 'b', params: [{ nodeId: 'n1', paramName: '温度', from: 50, to: 55, unit: '℃', basis: '依据', exp_ref: '经验 v1', preflight: { ok: true } }] },
  ],
}

// ---------- timeoutMs 覆写 ----------

test('request opts.timeoutMs:expiresAt 与超时收敛同源取覆写值(短超时按拒绝收敛)', async () => {
  const approvals = getToolApprovals()
  const p = approvals.request('ag-t1', 'dw-t1', 'dcw', '短超时单', { timeoutMs: 1000 })
  await new Promise(r => setTimeout(r, 50))
  const pend = approvals.listPending('ag-t1')
  assert.equal(pend.length, 1)
  const drift = Date.parse(pend[0]!.expiresAt) - Date.now()
  assert.ok(drift > 0 && drift <= 1000, `expiresAt 应按覆写超时窗派生(实际剩余 ${drift}ms)`)
  const decision = await p
  assert.equal(decision.approved, false)
  assert.match(decision.comment, /超时/)
  // 落历史(持久化表):status=expired 可追溯
  const hist = approvals.historyList().find(a => a.id === decision.id)
  assert.ok(hist, '超时单应入审批历史')
  assert.equal(hist!.status, 'expired')
})

// ---------- payload 进 pending 与历史 ----------

test('request opts.payload:pending 携带结构化载荷;decide 后历史含 payload_json/choice', async () => {
  const approvals = getToolApprovals()
  const p = approvals.request('ag-t2', 'recipe-propose:rc-x', 'dcw', '整包方案审批', { payload: PAYLOAD })
  await new Promise(r => setTimeout(r, 15))
  const pend = approvals.listPending('ag-t2')
  assert.equal(pend.length, 1)
  assert.deepEqual(pend[0]!.payload, PAYLOAD)
  // 未携带 choice 的「批准」在 decide 层不拦(归一在 decide.post/dispatcher 调 normalize 后传导);
  // 此处直接带合法 choice 走完生命周期
  let resolved!: { approved: boolean, comment: string, id: string, choice?: number }
  const done = p.then(r => (resolved = r))
  approvals.decide(approvals.listPending('ag-t2')[0]!.id, true, '选B', 'u1', '用户', 1)
  await done
  assert.equal(resolved.approved, true)
  assert.equal(resolved.choice, 1)
  const hist = approvals.historyList().find(a => a.id === resolved.id)
  assert.ok(hist, '审批应入历史')
  assert.deepEqual(hist!.payload, PAYLOAD)
  assert.equal(hist!.choice, 1)
  assert.equal(hist!.status, 'approved')
})

test('向后兼容:不传 opts/choice 的既有调用形态行为不变', async () => {
  const approvals = getToolApprovals()
  const p = approvals.request('ag-t3', 'dw-t3', 'dcw', '传统单')
  await new Promise(r => setTimeout(r, 15))
  const pend = approvals.listPending('ag-t3')
  assert.equal(pend.length, 1)
  assert.equal(pend[0]!.payload, undefined, '传统单不携带 payload')
  assert.equal(pend[0]!.choice, null)
  let resolved!: { approved: boolean, comment: string, id: string, choice?: number }
  const done = p.then(r => (resolved = r))
  approvals.decide(approvals.listPending('ag-t3')[0]!.id, true, '')
  await done
  assert.equal(resolved.approved, true)
  assert.equal('choice' in resolved, false, '未选方案的 resolve 通道不携带 choice 键(旧消费方零感知)')
  const hist = approvals.historyList().find(a => a.id === resolved.id)!
  assert.equal(hist.payload, undefined)
  assert.equal(hist.choice, null)
})

// ---------- normalizeRecipeProposeDecision(fail-closed 铁律 5) ----------

test('normalize:schemaVersion=1 无 choice 的批准 → 归一为拒绝(fail-closed)', () => {
  const out = normalizeRecipeProposeDecision({ payload: PAYLOAD }, { approved: true })
  assert.equal(out.approved, false)
  assert.match(out.rejectedReason ?? '', /fail-closed/)
})

test('normalize:schemaVersion=1 越界/负数/非整数 choice → 归一为拒绝', () => {
  for (const choice of [2, -1, 1.5]) {
    const out = normalizeRecipeProposeDecision({ payload: PAYLOAD }, { approved: true, choice })
    assert.equal(out.approved, false, `choice=${choice} 应被收敛为拒绝`)
    assert.match(out.rejectedReason ?? '', /0~1/)
  }
})

test('normalize:schemaVersion=1 合法 choice 原样放行;拒绝路径不干预', () => {
  const ok = normalizeRecipeProposeDecision({ payload: PAYLOAD }, { approved: true, choice: 1 })
  assert.deepEqual(ok, { approved: true, choice: 1 })
  const deny = normalizeRecipeProposeDecision({ payload: PAYLOAD }, { approved: false })
  assert.deepEqual(deny, { approved: false })
})

test('normalize:schemaVersion=1 但无 packages 的 payload(如 recipe-gate 逐动作单)不干预 —— 批准照常放行', () => {
  // v2 权限模型回归:配方逐动作 HITL 单带 payload(schemaVersion=1,无 packages),
  // 不得被多方案 fail-closed 拦截(实测:e3d9aef 后批准被静默转拒绝)
  const gatePayload = { schemaVersion: 1, kind: 'recipe-gate', op: 'dispatch', recipeId: 'rc-x', recipeName: 'x', reason: 'r' }
  const out = normalizeRecipeProposeDecision({ payload: gatePayload }, { approved: true })
  assert.deepEqual(out, { approved: true })
})

test('normalize:legacy 审批单(无 payload/schemaVersion≠1)完全不干预', () => {
  const noPayload = normalizeRecipeProposeDecision(undefined, { approved: true })
  assert.deepEqual(noPayload, { approved: true })
  const v2 = normalizeRecipeProposeDecision({ payload: { schemaVersion: 2, packages: PAYLOAD.packages } }, { approved: true })
  assert.deepEqual(v2, { approved: true })
})

// ---------- approval_history payload_json/choice 加列迁移 ----------

test('迁移:旧库 approval_history(无 payload_json/choice)经 initWorkshopDb 补列后载荷可落库', () => {
  const legacy = new DatabaseSync(':memory:')
  legacy.exec(`CREATE TABLE approval_history (
    id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, node_id TEXT NOT NULL, kind TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, comment TEXT NOT NULL DEFAULT '',
    decided_by TEXT NOT NULL DEFAULT '', decided_name TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL, decided_at TEXT)`)
  // SCHEMA_SQL 全程 IF NOT EXISTS/幂等:建其余表,approval_history 保留旧形,由加列迁移升级
  initWorkshopDb(legacy)
  const repo = createApprovalHistoryRepo(legacy)
  repo.upsert({
    id: 'ap-legacy-1', agentId: 'ag', nodeId: 'recipe-propose:rc', kind: 'dcw', detail: 'd',
    status: 'approved', comment: 'c', decidedBy: 'u', decidedName: '用户', createdAt: new Date().toISOString(),
    decidedAt: new Date().toISOString(), payloadJson: JSON.stringify(PAYLOAD), choice: 0,
  })
  const row = repo.list(10)[0]!
  assert.equal(row.payloadJson, JSON.stringify(PAYLOAD))
  assert.equal(row.choice, 0)
  // 既有行安全:历史行 payloadJson 为空串、choice 为 NULL(不回填改史)
  assert.equal(repo.list(10).length, 1)
})

// ---------- 解绑取消审批(2026-10-18) ----------

test('cancelPendingForBinding:配方解绑同时取消 recipe:/recipe-propose:/参数节点审批', async () => {
  const approvals = getToolApprovals()
  const pRecipe = approvals.request('ag-bind-1', 'recipe:rc-bind', 'dcw', '配方下发', { timeoutMs: 60_000 })
  const pPropose = approvals.request('ag-bind-1', 'recipe-propose:rc-bind', 'dcw', '整包方案', { timeoutMs: 60_000 })
  const pParam = approvals.request('ag-bind-1', 'dw-param-1', 'dcw', '探索写入', { timeoutMs: 60_000 })
  await new Promise(r => setTimeout(r, 50))
  assert.equal(approvals.listPending('ag-bind-1').length, 3)
  const n = approvals.cancelPendingForBinding('ag-bind-1', { nodeId: 'rc-bind', kind: 'recipe' })
  // 配方不存在于控制器时无从枚举参数节点:至少取消 recipe:/recipe-propose: 两张单
  assert.ok(n >= 2, `应至少取消 2 条(实际 ${n})`)
  for (const p of [pRecipe, pPropose]) {
    const d = await p
    assert.equal(d.approved, false)
    assert.match(d.comment, /绑定已解除/)
  }
  // 参数节点单仍待处理(配方可查时由 cancelPendingForBinding 一并取消);此处手动收尾
  assert.equal(approvals.listPending('ag-bind-1').length, 1)
  approvals.cancelPendingFor('ag-bind-1', 'dw-param-1')
  assert.equal((await pParam).approved, false)
  assert.equal(approvals.listPending('ag-bind-1').length, 0)
})

test('cancelPendingForBinding:节点直绑只取消该节点审批,不误伤其他节点', async () => {
  const approvals = getToolApprovals()
  const p1 = approvals.request('ag-bind-2', 'dw-direct-1', 'dcw', '直绑节点', { timeoutMs: 60_000 })
  const p2 = approvals.request('ag-bind-2', 'dw-other-1', 'dcw', '其他节点', { timeoutMs: 60_000 })
  await new Promise(r => setTimeout(r, 50))
  const n = approvals.cancelPendingForBinding('ag-bind-2', { nodeId: 'dw-direct-1', kind: 'dcw' })
  assert.equal(n, 1)
  assert.equal((await p1).approved, false)
  const pending = approvals.listPending('ag-bind-2')
  assert.equal(pending.length, 1)
  assert.equal(pending[0]!.nodeId, 'dw-other-1')
  // 收尾:人工拒绝剩余单,避免计时器悬挂
  approvals.decide(pending[0]!.id, false, '测试收尾')
  assert.equal((await p2).approved, false)
})
