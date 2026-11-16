import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AgentRuntime } from '../server/services/workshop/runtime/agent-runtime/facade'
import { getToolApprovals } from '../server/services/workshop/agents/tool-approvals'
import { workshopSettings } from '../server/services/workshop/settings'
import type { AgentInfo, AgentInterface } from '../server/services/workshop/agents/agent-interface'

class WatchdogRuntime extends AgentRuntime {
  aborts: string[] = []

  constructor(agentId: string) {
    super({ id: agentId, channelId: 'channel', name: 'Worker', role: 'worker', harness: 'mock', config: {} } as AgentInfo,
      {} as AgentInterface, { mailbox: {} as never, taskEngine: {} as never, bus: {} as never, workspace: {} as never })
    this.state = 'busy'
  }

  override abortCurrent(reason?: string): void { this.aborts.push(reason ?? '') }

  watch(fn: () => Promise<void>): Promise<void> {
    return this.withMessageWatchdog({ messageId: 'message' }, 'claim-token', fn)
  }

  hasActivityHook(): boolean { return this.messageWatchdogBump !== null }
}

test('quick approval between watchdog ticks resets the idle window and cleans up', async (t) => {
  const agentId = 'watchdog-quick-approval'
  const runtime = new WatchdogRuntime(agentId)
  const approvals = getToolApprovals()
  const listeners = (approvals as unknown as { approvalListeners: Map<string, Set<() => void>> }).approvalListeners
  let now = 1_000_000
  let tick: (() => void) | undefined
  let cleared = false
  t.mock.method(Date, 'now', () => now)
  t.mock.method(globalThis, 'setInterval', ((callback: () => void) => {
    tick = callback
    return { unref() {} } as unknown as NodeJS.Timeout
  }) as typeof setInterval)
  t.mock.method(globalThis, 'clearInterval', (() => {
    cleared = true
  }) as typeof clearInterval)
  const started = Promise.withResolvers<undefined>()
  const finish = Promise.withResolvers<undefined>()
  const watched = runtime.watch(async () => {
    started.resolve(undefined)
    await finish.promise
  })
  try {
    await started.promise
    assert.ok(tick)
    assert.equal(listeners.get(agentId)?.size, 1)
    assert.equal(runtime.hasActivityHook(), true)
    const stallMs = Math.max(60_000, Number(workshopSettings().harness_stall_timeout_ms) || 600_000)
    now += stallMs - 1
    const pending = approvals.request(agentId, 'node', 'dcw', 'quick', { timeoutMs: 60_000 })
    const approval = approvals.listPending(agentId)[0]!
    assert.ok(approval)
    approvals.decide(approval.id, true, '')
    await pending
    assert.equal(approvals.listPending(agentId).length, 0)
    now += 2
    tick()
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.deepEqual(runtime.aborts, [], 'approval resolution must start a fresh idle window')
    now += stallMs
    tick()
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.deepEqual(runtime.aborts, ['message watchdog'], 'a full subsequent idle window still fires')
  }
  finally {
    finish.resolve(undefined)
    await watched
    approvals.cancelAllForAgent(agentId, 'test cleanup')
  }
  assert.equal(cleared, true)
  assert.equal(runtime.hasActivityHook(), false)
  assert.equal(listeners.has(agentId), false)
})
