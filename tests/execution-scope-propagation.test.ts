import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BaseAgentImpl } from '../server/services/workshop/agents/base-agent'
import { currentExecutionScope, runWithExecutionScope, type ExecutionScope } from '../server/services/workshop/agents/execution-scope'
import type { AgentEvent, AgentRunContext, AgentRunRequest } from '../server/services/workshop/agents/agent-interface'

class ScopeAgent extends BaseAgentImpl {
  seen: Array<ExecutionScope | undefined> = []

  constructor() { super({ agentId: 'agent', channelId: 'channel' }) }
  protected get harnessId() { return 'scope-test' }
  protected configRecord() { return {} }
  protected async* workerTurn(): AsyncGenerator<AgentEvent, void, unknown> {
    this.seen.push(currentExecutionScope())
    await Promise.resolve()
    this.seen.push(currentExecutionScope())
    yield { kind: 'done' }
  }

  protected async* peerTurn(): AsyncGenerator<AgentEvent, void, unknown> {
    this.seen.push(currentExecutionScope())
    yield { kind: 'done' }
  }

  protected async collectTurnEvents(): Promise<AgentEvent[]> { return [] }
  begin(ctx: AgentRunContext) { return this.beginTurnScope(ctx) }
  end(scope: ExecutionScope) { this.endTurnScope(scope) }
  dispatch(scope: ExecutionScope) { return this.dispatchTurnHostTool('unused', {}, scope) }
}

function context(signal: AbortSignal, executionScope?: ExecutionScope): AgentRunContext {
  return { agentId: 'agent', channelId: 'channel', role: 'worker', workspace: {} as AgentRunContext['workspace'], signal, executionScope }
}

function lease(signal: AbortSignal): ExecutionScope {
  return { taskId: 'task', agentId: 'agent', channelId: 'channel', assignmentGeneration: 0, executionLeaseId: 'lease', signal, assertActive: () => {} }
}

function request(kind?: string): AgentRunRequest {
  return {
    message: { messageId: 'message', contextId: 'channel', role: 'ROLE_USER', parts: [], metadata: kind ? { 'x-aw-task-kind': kind } : { 'x-aw-from-label': 'human' } },
    taskId: kind === 'assign' ? 'task' : undefined,
    contextId: 'channel', fromAgentId: null, toAgentId: 'agent',
  }
}

test('undefined scope clears an inherited ambient scope across async work', async () => {
  const signal = new AbortController().signal
  const outer = lease(signal)
  await runWithExecutionScope(outer, async () => {
    assert.equal(currentExecutionScope(), outer)
    await runWithExecutionScope(undefined, async () => {
      await Promise.resolve()
      assert.equal(currentExecutionScope(), undefined)
    })
    assert.equal(currentExecutionScope(), outer)
  })
})

test('assigned turns require complete lease and use immutable captured values', async () => {
  const agent = new ScopeAgent()
  const controller = new AbortController()
  await assert.rejects(async () => {
    for await (const event of agent.run(request('assign'), context(controller.signal))) void event
  }, /matching execution lease/)
  const partial = { ...lease(controller.signal), executionLeaseId: undefined }
  await assert.rejects(async () => {
    for await (const event of agent.run(request('assign'), context(controller.signal, partial))) void event
  }, /incomplete task execution lease/)
  const original = lease(controller.signal)
  const events = []
  for await (const event of agent.run(request('assign'), context(controller.signal, original))) events.push(event)
  assert.equal(events.length, 1)
  const scope = agent.seen[0]!
  assert.equal(agent.seen[1], scope)
  assert.equal(Object.isFrozen(scope), true)
  ;(original as { executionLeaseId: string }).executionLeaseId = 'changed'
  assert.equal(scope.executionLeaseId, 'lease')
  assert.equal(scope.signal.aborted, true)
  assert.throws(() => scope.assertActive(), /no longer active/)
})

test('peer turns are abort-bound and never inherit an outer task lease', async () => {
  const agent = new ScopeAgent()
  const controller = new AbortController()
  const outer = lease(new AbortController().signal)
  await runWithExecutionScope(outer, async () => {
    for await (const event of agent.run(request(), context(controller.signal))) void event
  })
  const scope = agent.seen[0]!
  assert.notEqual(scope, outer)
  assert.equal(scope.taskId, undefined)
  assert.equal(scope.signal.aborted, true)
})

test('old callbacks cannot borrow a newer turn and abort invalidates the scope', async () => {
  const agent = new ScopeAgent()
  const first = agent.begin(context(new AbortController().signal))
  agent.end(first)
  const controller = new AbortController()
  const second = agent.begin(context(controller.signal))
  assert.equal((await agent.dispatch(first)).isError, true)
  controller.abort()
  assert.throws(() => second.assertActive(), /no longer active/)
  agent.end(second)
})
