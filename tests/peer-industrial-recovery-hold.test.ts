import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-peer-recovery-'))
process.env.AW_TOOL_VERIFY_LEGACY_SPECS = '1'

const { openWorkshopDb } = await import('../server/services/workshop/db/database')
const { createTaskRepo } = await import('../server/services/workshop/db/task.repo')
const { createMessageRepo } = await import('../server/services/workshop/db/message.repo')
const { TaskEngine } = await import('../server/services/workshop/runtime/task-engine/facade')
const { LEGACY_RECOVERY_MARKER } = await import('../server/services/workshop/runtime/task-engine/legacy-recovery')
const { configureAmlRuntime } = await import('../server/services/workshop/aml/runtime')
const { DcwNode } = await import('../server/services/workshop/dcw/dcw-node')
const { getDcwNodeRepo } = await import('../server/services/workshop/dcw/dcw-node.repo')
const { getDcwLineRepo } = await import('../server/services/workshop/dcw/dcw-line.repo')
const { getDcwProductRepo } = await import('../server/services/workshop/dcw/dcw-product.repo')
const { getDcwRecipeRepo } = await import('../server/services/workshop/dcw/dcw-recipe.repo')
const { getDcwController } = await import('../server/services/workshop/dcw/dcw-controller')
const { getAgentNodeBindingRepo } = await import('../server/services/workshop/agents/node-bindings.repo')
const { getToolApprovals } = await import('../server/services/workshop/agents/tool-approvals')
const { mockDcwDriver } = await import('../server/services/workshop/dcw/drivers/mock')
const { runWithExecutionScope } = await import('../server/services/workshop/agents/execution-scope')
const { dispatchHostTool, peerWriteScope, resetToolActivity, toolActivityAt } = await import('../server/services/workshop/agents/host-tool-bridge/dispatch')
const { toolLineStart } = await import('../server/services/workshop/agents/industrial/line-tools')
const { OBSERVE_BLOCKED_TOOL_NAMES } = await import('../server/services/workshop/agents/tool-classes')
const { clearActiveLineRun } = await import('../server/services/workshop/dcw/line-run')

const db = openWorkshopDb(':memory:')
configureAmlRuntime(db)
const engine = new TaskEngine({ tasks: createTaskRepo(db), messages: createMessageRepo(db) })
db.exec('PRAGMA foreign_keys = OFF')
const line = getDcwLineRepo().create({ name: 'Recovery test', simulated: true })
const node = new DcwNode({ id: 'peer-recovery-node', templateRef: 'dcw-temp-sp', driver: 'mock', driverConfig: { key: 'peer-recovery' }, min: 0, max: 100, unit: 'C', decimals: 1, lineId: line.id, readIntervalMs: 0, holdIntervalMs: null })
getDcwNodeRepo().insert(node)
const product = getDcwProductRepo().create({ name: 'Recovery product', lineId: line.id })
const recipe = getDcwRecipeRepo().create({ name: 'Recovery recipe', productId: product.id, opIntervalMs: 0, params: [{ nodeId: node.id, value: 50 }] })
getAgentNodeBindingRepo().bind('peer-agent', recipe.id, 'recipe', 'manual')
const manager = {
  getTaskEngine: () => engine,
  channelModeForAgent: () => 'production_line_integrated',
  channelModeOf: () => 'production_line_integrated',
  invocationScopeOf: () => null,
  channelLineBindingOf: () => line.id,
  deps: { repos: { channels: { findById: () => ({ id: 'peer-channel', leadAgentId: 'peer-agent', lineId: line.id, ownerUserId: null }) } } },
}
const g = globalThis as unknown as { __workshopManager?: unknown }
g.__workshopManager = manager
const ctx = { identity: { agentId: 'peer-agent', channelId: 'peer-channel', role: 'lead' as const, name: 'peer' }, state: { currentTaskId: null, sessionId: null, sourceChatMessageId: null, sourceChatDeliveryId: null, replyContext: null }, getWorkspace: () => null }
const controller = new AbortController()
const scope = { agentId: 'peer-agent', channelId: 'peer-channel', signal: controller.signal, assertActive: () => {
  if (controller.signal.aborted) throw new Error('turn aborted')
} }
const invoke = (toolName: string, args: Record<string, unknown> = {}) => runWithExecutionScope(scope, () => dispatchHostTool(ctx, { toolName, arguments: args }))
function hold(channelId = 'peer-channel') {
  db.prepare(`INSERT INTO tasks(id, channel_id, assignee_id, title, state, progress, close_reason, created_at, updated_at) VALUES (?, ?, 'old-agent', 'legacy', 'WORKING', 0, ?, '2026-01-01', '2026-01-01')`).run(`held-${channelId}`, channelId, LEGACY_RECOVERY_MARKER)
}
function clearHold() {
  db.prepare('DELETE FROM tasks').run()
}
async function pendingCard(result: Promise<{ text: string, isError?: boolean }>) {
  let early: { text: string, isError?: boolean } | undefined
  void result.then((value) => {
    early = value
  })
  for (let i = 0; i < 100; i++) {
    const card = getToolApprovals().listPending('peer-agent')[0]
    if (card) return card
    if (early) assert.fail(`line start ended before approval: ${early.text}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.fail('line start did not reach approval')
}
const start = () => runWithExecutionScope(peerWriteScope(scope, ctx.identity), () => toolLineStart('peer-agent', { recipe_id: recipe.id, reason: 'Recovery guard test' }, 'peer-channel'))

test('channel hold blocks taskless industrial writes but not chat, reads or another channel', async () => {
  hold()
  resetToolActivity()
  for (const name of OBSERVE_BLOCKED_TOOL_NAMES) {
    const result = await invoke(name)
    assert.equal(result.isError, true, name)
    assert.match(result.text, /LEGACY_EXECUTION_RECOVERY_REQUIRED/, name)
  }
  assert.ok(toolActivityAt('peer-agent'), 'rejected calls still register tool activity, not proof of physical progress')
  const chat = await invoke('poll_messages')
  assert.doesNotMatch(chat.text, /LEGACY_EXECUTION_RECOVERY/)
  const read = await invoke('line_status')
  assert.doesNotMatch(read.text, /LEGACY_EXECUTION_RECOVERY/)
  clearHold()
  hold('other-channel')
  const other = await invoke('line_start')
  assert.doesNotMatch(other.text, /LEGACY_EXECUTION_RECOVERY/)
  clearHold()
})

test('unavailable, invalid or mismatched recovery status fails closed', async () => {
  const old = manager.getTaskEngine
  try {
    for (const replacement of [undefined, () => {
      throw new Error('database offline')
    }, () => ({ hasLegacyRecoveryHold: () => undefined })]) {
      ;(manager as unknown as { getTaskEngine?: unknown }).getTaskEngine = replacement
      const result = await invoke('line_start')
      assert.match(result.text, /LEGACY_EXECUTION_RECOVERY_STATUS_UNAVAILABLE/)
    }
    manager.getTaskEngine = old
    const mismatch = await runWithExecutionScope({ ...scope, channelId: 'other-channel' }, () => dispatchHostTool(ctx, { toolName: 'line_start', arguments: {} }))
    assert.match(mismatch.text, /LEGACY_EXECUTION_RECOVERY_STATUS_UNAVAILABLE/)
  }
  finally { manager.getTaskEngine = old }
})

test('a hold after approval was requested rejects the approved operation', async (t) => {
  const driver = t.mock.method(mockDcwDriver, 'write', mockDcwDriver.write)
  const result = start()
  const card = await pendingCard(result)
  hold()
  assert.throws(() => getToolApprovals().decide(card.id, true, 'approved', 'operator'), /任务执行已失效/)
  const outcome = await result
  assert.equal(driver.mock.callCount(), 0)
  assert.equal(getDcwController().lineState(line.id).active, false)
  assert.match(outcome.text, /未获批准|失效/)
  clearHold()
})

test('hold introduced after approval and at controller write stops before driver', async (t) => {
  const driver = t.mock.method(mockDcwDriver, 'write', mockDcwDriver.write)
  const result = start()
  const card = await pendingCard(result)
  getToolApprovals().decide(card.id, true, 'approved', 'operator')
  hold()
  assert.equal((await result).isError, true)
  assert.equal(driver.mock.callCount(), 0)
  clearHold()

  const repo = getDcwNodeRepo()
  const flush = repo.flushNow.bind(repo)
  let injected = false
  t.mock.method(repo, 'flushNow', () => {
    const flushed = flush()
    if (node.holdBlocked && !injected) {
      injected = true
      hold()
    }
    return flushed
  })
  const next = start()
  const nextCard = await pendingCard(next)
  getToolApprovals().decide(nextCard.id, true, 'approved', 'operator')
  assert.equal((await next).isError, true)
  assert.equal(injected, true, 'hold was inserted at the final pre-driver persistence checkpoint')
  assert.equal(driver.mock.callCount(), 0)
  clearHold()
  clearActiveLineRun(line.id)
})

test('a clear channel permits the guarded line start and a hold does not block direct operator stop', async (t) => {
  const driver = t.mock.method(mockDcwDriver, 'write', mockDcwDriver.write)
  const result = start()
  const card = await pendingCard(result)
  getToolApprovals().decide(card.id, true, 'approved', 'operator')
  const outcome = await result
  assert.equal(outcome.isError, undefined, outcome.text)
  assert.equal(driver.mock.callCount(), 1)
  assert.equal(getDcwController().lineState(line.id).active, true)
  hold()
  const stopped = getDcwController().lineStop(line.id)
  assert.ok(stopped.endedAt)
  assert.equal(getDcwController().lineState(line.id).active, false)
  clearHold()
})

test('unscoped dispatch is not subjected to the peer hold guard', async () => {
  hold()
  const result = await dispatchHostTool(ctx, { toolName: 'line_start', arguments: {} })
  assert.doesNotMatch(result.text, /LEGACY_EXECUTION_RECOVERY/)
  clearHold()
})
