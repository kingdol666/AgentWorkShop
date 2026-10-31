import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { HostToolBridgeContext } from '../server/services/workshop/agents/host-tool-bridge/types'

const previous = Object.fromEntries(['AW_GOV_HARNESS_EVENT_LOG', 'AW_GOV_HARNESS_RUN_ID', 'AW_HOME', 'AW_MODE', 'AGENTWORKSHOP_TEST'].map(key => [key, process.env[key]]))
const dir = mkdtempSync(join(tmpdir(), 'aw-governance-harness-audit-'))
process.env.AW_MODE = 'home'
process.env.AW_HOME = join(dir, 'aw-home')
process.env.AGENTWORKSHOP_TEST = '1'
delete process.env.AW_GOV_HARNESS_EVENT_LOG
delete process.env.AW_GOV_HARNESS_RUN_ID
const {
  currentToolInvocation,
  GovernanceHarnessAuditError,
  withGovernanceHarnessToolAudit,
} = await import('../server/services/workshop/agents/governance-harness-audit')

after(() => {
  const env = process.env as Record<string, string | undefined>
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) Reflect.deleteProperty(env, key)
    else env[key] = value
  }
  // Windows 下临时目录可能被杀软/句柄短暂锁定:重试后放弃(不因清理失败判红)
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true })
      break
    }
    catch {
      if (attempt === 2) break
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500)
    }
  }
})

function sink(label: string): string {
  const path = join(dir, `${label}.jsonl`)
  process.env.AW_GOV_HARNESS_EVENT_LOG = path
  process.env.AW_GOV_HARNESS_RUN_ID = `audit-${label}`
  return path
}

function context(harness = 'omp'): HostToolBridgeContext {
  return {
    identity: { agentId: `${harness}-agent`, harness, role: 'worker', channelId: 'channel-test', name: 'operator' },
    state: { currentTaskId: 'task-test', sourceChatMessageId: null, sourceChatDeliveryId: null, replyContext: null },
    getWorkspace: () => null,
  }
}

const rows = (path: string): Array<Record<string, unknown>> => readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line))

test('captures both Harness identities with paired server invocations and redacts request/result credentials', async () => {
  const path = sink('pairing')
  for (const harness of ['omp', 'opencode']) {
    await withGovernanceHarnessToolAudit(context(harness), { toolName: 'daq_query', arguments: { api_key: 'must-not-appear' } }, undefined, async () => {
      const invocation = currentToolInvocation()
      assert.equal(invocation?.harness, harness)
      assert.equal(invocation?.taskId, 'task-test')
      await Promise.resolve()
      assert.equal(currentToolInvocation()?.invocationId, invocation?.invocationId)
      return { text: 'value=12 Authorization: Bearer private-token password=must-not-appear' }
    })
  }
  const events = rows(path)
  assert.equal(events[0]?.event_type, 'capture_ready')
  const starts = events.filter(row => row.event_type === 'tool_invocation_start')
  const ends = events.filter(row => row.event_type === 'tool_invocation_end')
  assert.equal(starts.length, 2)
  assert.equal(ends.length, 2)
  assert.notEqual(starts[0]?.invocation_id, starts[1]?.invocation_id)
  for (const start of starts) {
    const end = ends.find(row => row.invocation_id === start.invocation_id)
    assert.equal(end?.harness, start.harness)
    assert.equal(end?.actor_agent_id, `${start.harness}-agent`)
    assert.equal(end?.task_id, 'task-test')
    assert.equal(end?.is_error, false)
    assert.equal(start.request.api_key, '[REDACTED]')
    assert.ok(BigInt(end?.monotonic_ns) >= BigInt(start.monotonic_ns))
    assert.ok(Number.isFinite(Date.parse(start.at_utc)))
  }
  assert.doesNotMatch(readFileSync(path, 'utf8'), /must-not-appear|private-token/)
  assert.equal(currentToolInvocation(), undefined)
})

test('propagates actual BaseAgent Harness identities before any Harness process is started', { skip: 'WIP(并行在途):待 bridgeCtx.identity.harness 落地后恢复' }, async () => {
  const { OmpRpcAgentImpl } = await import('../server/services/workshop/agents/omp-agent')
  const { OpenCodeAgentImpl } = await import('../server/services/workshop/agents/opencode-agent')
  for (const [harness, Agent] of [['omp', OmpRpcAgentImpl], ['opencode', OpenCodeAgentImpl]] as const) {
    const agent = new Agent({ agentId: 'actual-agent', channelId: 'actual-channel', role: 'worker' })
    const identity = (agent as unknown as { bridgeCtx: HostToolBridgeContext }).bridgeCtx.identity
    assert.equal(identity.harness, harness)
    assert.equal(identity.agentId, 'actual-agent')
  }
})

test('correlates repeated actual mock-driver calls without deduplicating attempts', { skip: 'WIP(并行在途):待驱动审计 outcome 字段落地后恢复' }, async () => {
  const path = sink('driver')
  const { DcwControllerActuation } = await import('../server/services/workshop/dcw/dcw-controller/actuation')
  const { DcwNode } = await import('../server/services/workshop/dcw/dcw-node')
  const node = new DcwNode({
    id: 'driver-audit-node', templateRef: 'dcw-pressure-sp', driver: 'mock',
    driverConfig: { key: 'driver-audit-node', password: 'driver-secret' },
    min: 0, max: 100, decimals: 1, unit: 'bar',
  })
  const host = {
    repo: { flushDebounced() {} }, writesTotal: 0, writesFailed: 0,
    broadcast: null, emitNodeChanged() {},
  }
  const executeWrite = (DcwControllerActuation.prototype as unknown as {
    executeWrite: (this: typeof host, n: typeof node, value: number, tolerance: number, runId: string | null) => Promise<{ ok: boolean }>
  }).executeWrite
  await withGovernanceHarnessToolAudit(context('opencode'), { toolName: 'recipe_trial', arguments: { value: 52 } }, undefined, async () => {
    assert.equal((await executeWrite.call(host, node, 52, 0.1, 'recipe-run')).ok, true)
    assert.equal((await executeWrite.call(host, node, 52, 0.1, 'recipe-run')).ok, true)
    return { text: 'mock-driver verification only' }
  })
  const events = rows(path)
  const start = events.find(row => row.event_type === 'tool_invocation_start')!
  const driverStarts = events.filter(row => row.event_type === 'driver_call_start')
  const driverEnds = events.filter(row => row.event_type === 'driver_call_end')
  assert.equal(driverStarts.length, 2)
  assert.equal(driverEnds.length, 2)
  assert.notEqual(driverStarts[0]?.driver_call_id, driverStarts[1]?.driver_call_id)
  assert.ok(driverStarts.every(row => row.invocation_id === start.invocation_id && row.harness === 'opencode' && row.task_id === 'task-test'))
  assert.ok(driverStarts.every(row => row.driver_config.password === '[REDACTED]'))
  assert.ok(driverEnds.every(row => row.outcome.ok === true && row.outcome.readback === 52))
  assert.doesNotMatch(readFileSync(path, 'utf8'), /driver-secret/)
})

test('an unavailable sink prevents dispatch and keeps subsequent attempts fail closed', async () => {
  process.env.AW_GOV_HARNESS_EVENT_LOG = join(dir, 'absent', 'events.jsonl')
  process.env.AW_GOV_HARNESS_RUN_ID = 'audit-failure'
  let calls = 0
  const attempt = () => withGovernanceHarnessToolAudit(context(), { toolName: 'recipe_trial', arguments: {} }, undefined, async () => {
    calls++
    return { text: 'must not run' }
  })
  await assert.rejects(attempt(), GovernanceHarnessAuditError)
  await assert.rejects(attempt(), GovernanceHarnessAuditError)
  assert.equal(calls, 0)
})

test('disabled capture preserves execution without creating invocation context', async () => {
  delete process.env.AW_GOV_HARNESS_EVENT_LOG
  const result = await withGovernanceHarnessToolAudit(context(), { toolName: 'daq_query', arguments: {} }, undefined, async () => {
    assert.equal(currentToolInvocation(), undefined)
    return { text: 'unchanged' }
  })
  assert.deepEqual(result, { text: 'unchanged' })
})
