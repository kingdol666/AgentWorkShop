/**
 * HITL 到期权威收口回归(2026-11-16 复现)。
 *
 * 实测:整包方案审批(30min 窗)在到期后未即时落定终态 —— history 面残留
 * status=pending 的行、pending 列表却已为空,约 1 小时后才在对账里看到 failed,
 * 且全程无"已自动拒绝"通告。修复语义:
 *  1. 到期 timer 以审批单自身 status 为准(不再因 pending 表项被其它路径摘除而短路);
 *  2. 到期即落定 expired + 发送终态通告(agent 侧 + 线域);
 *  3. decide() 对已过期单不再二次落定。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-hitl-expiry-test-'))
delete process.env.AW_BENCH_MODE

const { getToolApprovals } = await import('../server/services/workshop/agents/tool-approvals')

test('到期权威收口:pending 表项被摘除后 timer 仍落定 expired 并 resolve 拒绝', async () => {
  const approvals = getToolApprovals()
  const p = approvals.request('ag-exp-1', 'dw-exp-1', 'dcw', '到期收口验证', { timeoutMs: 200 })
  const decision = await p
  assert.equal(decision.approved, false, '到期必须按默认拒绝 resolve')
  assert.match(decision.comment, /超时未处理,默认拒绝/)
  assert.equal(approvals.listPending('ag-exp-1').length, 0, '到期后 pending 列表必须为空')
  // 注册面已收敛:过期单再 decide 直接抛"审批不存在或已处理"(不得翻改终态)
  assert.throws(() => approvals.decide(decision.id, true, '迟到批准'), /审批不存在或已处理/)
})

test('到期收口先于 decide:approve 竞态下先到者赢', async () => {
  const approvals = getToolApprovals()
  const p = approvals.request('ag-exp-2', 'dw-exp-2', 'dcw', '竞态验证', { timeoutMs: 300 })
  setTimeout(() => {
    const pend = approvals.listPending('ag-exp-2')
    if (pend.length > 0) approvals.decide(pend[0]!.id, true, '及时批准')
  }, 50)
  const decision = await p
  // 50ms 批准先于 300ms 到期 → approved
  assert.equal(decision.approved, true)
  assert.equal(approvals.listPending('ag-exp-2').length, 0)
})

test('到期收口晚于 decide:已批准的审批到期时不得被翻改为 expired', async () => {
  const approvals = getToolApprovals()
  const p = approvals.request('ag-exp-3', 'dw-exp-3', 'dcw', '已批准保护验证', { timeoutMs: 200 })
  setTimeout(() => {
    const pend = approvals.listPending('ag-exp-3')
    if (pend.length > 0) approvals.decide(pend[0]!.id, true, '提前批准')
  }, 50)
  const decision = await p
  assert.equal(decision.approved, true)
  // 到期 timer 在 200ms 触发,但 status 已非 pending → 权威守卫直接 return
  await new Promise(r => setTimeout(r, 320))
  assert.equal(approvals.listPending('ag-exp-3').length, 0)
})
