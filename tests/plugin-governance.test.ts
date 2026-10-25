/**
 * WP4b/WP8 插件治理单测(临时 home + 临时 sqlite,不联网):
 *  - kb_agent 动作契约:action 缺省=query;非法值拒绝;
 *  - 入库意图启发拦截:action 缺省但 prompt 含入库意图 → 拒绝并提示改用 action=ingest
 *    (AW_KB_INGEST_GUARD=0 关闭启发,但 action=ingest 审批不受影响);
 *  - action=ingest → 真实产生 HITL 审批单(approval_history 有 pending 行),
 *    超时默认拒绝 → 工具返回 isError(未写入知识库);
 *  - 声明式引用:插件工具声明了 references 才校验(未声明零变化)。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
const awHome = mkdtempSync(join(tmpdir(), 'aw-plugin-gov-test-'))
process.env.AW_HOME = awHome
delete process.env.AW_BENCH_MODE
// HITL 超时 80ms(缺省 180s):真实走审批 → 超时默认拒绝,无需人工交互
writeFileSync(join(awHome, 'runtime-settings.json'), JSON.stringify({ version: 1, overrides: { 'security.hitl_timeout_ms': 80 } }))

const { openWorkshopDb } = await import('../server/services/workshop/db/database')
const { bindOpsRepos } = await import('../server/services/workshop/ops/ops')
const { createAlarmEventRepo, createApprovalHistoryRepo, createApprovalRequestRepo, createAuditRepo } = await import('../server/services/workshop/db/ops.repo')

const db = openWorkshopDb(join(awHome, 'plugin-gov-test.sqlite'))
const approvalHistory = createApprovalHistoryRepo(db)
bindOpsRepos({
  approvalHistory,
  alarmEvents: createAlarmEventRepo(db),
  audit: createAuditRepo(db),
  approvalRequests: createApprovalRequestRepo(db),
})

const { governPluginToolCall, kbActionOf } = await import('../server/services/workshop/agents/plugin-governance')

const identity = { agentId: 'agent-gov-1', channelId: 'ch-gov-1', role: 'worker' as const, name: '治理测试 Agent' }

test('kbActionOf:缺省=query;ingest/query 归一;非法值 invalid', () => {
  assert.equal(kbActionOf({}), 'query')
  assert.equal(kbActionOf({ action: 'INGEST' }), 'ingest')
  assert.equal(kbActionOf({ action: ' query ' }), 'query')
  assert.equal(kbActionOf({ action: 'delete' }), 'invalid')
})

test('非法 action → 拒绝且提示合法取值', async () => {
  const r = await governPluginToolCall(identity, 'kb_agent', { prompt: 'hi', action: 'purge' })
  assert.ok(r?.isError)
  assert.match(String(r?.text), /只能是 query.*或 ingest/)
})

test('入库意图启发:action 缺省但 prompt 含"入库"→ 拒绝并提示 action=ingest', async () => {
  const r = await governPluginToolCall(identity, 'kb_agent', { prompt: '把这份诊断报告入库到 aw-industrial' })
  assert.ok(r?.isError)
  assert.match(String(r?.text), /action=ingest/)
})

test('查询语义不受影响:action 缺省 + 普通检索问题 → 放行', async () => {
  const r = await governPluginToolCall(identity, 'kb_agent', { prompt: '膜厚波动的常见原因是什么?' })
  assert.equal(r, null)
})

test('AW_KB_INGEST_GUARD=0 关闭启发拦截(逃生门)', async () => {
  process.env.AW_KB_INGEST_GUARD = '0'
  try {
    const r = await governPluginToolCall(identity, 'kb_agent', { prompt: '把内容入库' })
    assert.equal(r, null)
  }
  finally {
    delete process.env.AW_KB_INGEST_GUARD
  }
})

test('action=ingest 产生真实 HITL 审批单;超时默认拒绝 → isError 且未放行', async () => {
  const before = approvalHistory.list ? approvalHistory.list(200).length : 0
  const started = Date.now()
  const r = await governPluginToolCall(identity, 'kb_agent', { prompt: '把诊断报告入库', action: 'ingest', mode: 'async' })
  const elapsed = Date.now() - started
  assert.ok(r?.isError, '未获批准必须拒绝')
  assert.match(String(r?.text), /知识库入库未获批准/)
  assert.ok(elapsed >= 60, `应真实等待审批超时(实际 ${elapsed}ms)`)
  const rows = approvalHistory.list(200)
  assert.ok(rows.length > before, '审批单必须落 approval_history')
  assert.ok(rows.some(x => x.detail?.includes('知识库入库审批')), '审批单 detail 应含标题语义')
})

test('声明式引用:插件声明 references 才校验;未声明放行(存量零变化)', async () => {
  const declared = { references: { atLeastOne: [{ params: ['record_id'], hint: 'record_id 必填(插件声明)' }] } }
  const denied = await governPluginToolCall(identity, 'rd_plugin_tool', {}, declared)
  assert.ok(denied?.isError)
  assert.match(String(denied?.text), /record_id 必填/)

  const passthrough = await governPluginToolCall(identity, 'rd_plugin_tool', {}, undefined)
  assert.equal(passthrough, null)
})
