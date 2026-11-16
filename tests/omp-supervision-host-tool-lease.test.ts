import { test } from 'node:test'
import assert from 'node:assert/strict'
import { OmpRpcAgentImpl } from '../server/services/workshop/agents/omp-agent'
import { OmpRpcClient } from '../server/services/workshop/agents/adapters/omp-rpc-client'
import type { HostToolCallRequest, AgentSessionEvent, RpcCommand } from '../server/services/workshop/agents/adapters/omp-rpc-client'
import { registerPluginTool, unregisterPluginTools } from '../server/services/workshop/agents/plugin-tools'
import type { AgentRunContext } from '../server/services/workshop/agents/agent-interface'
import type { ExecutionScope } from '../server/services/workshop/agents/execution-scope'
import { getToolApprovals } from '../server/services/workshop/agents/tool-approvals'
import { setTimeout as delay } from 'node:timers/promises'

class TestOmpAgent extends OmpRpcAgentImpl {
  dispatchCount = 0
  dispatchedRootTaskIds: Array<string | undefined> = []
  dispatchedNames: string[] = []
  rootState = 'WORKING'

  setClient(client: OmpRpcClient): void {
    this.client = client
  }

  setRootStateReader(): void {
    this.workspace = { getTask: async () => ({ state: this.rootState }) } as never
  }

  setRootReader(reader: () => Promise<unknown>): void {
    this.workspace = { getTask: reader } as never
  }

  setLease(client: OmpRpcClient, rootId: string | null, rootActive: boolean, signal: AbortSignal): void {
    const scope = this.beginTestScope(signal)
    this.installTestAliases(client, scope)
    this.activeSupervisionToolLease = { client, rootId, rootActive, signal, scope }
    this.turnActive = true
  }

  installTestAliases(client: OmpRpcClient, scope: ExecutionScope): void {
    this.hostToolAliases = { client, scope, nonce: 'test', revision: 0, byAlias: new Map([['line_context', 'line_context'], ['dispatch_task', 'dispatch_task']]), byName: new Map() }
  }

  beginTestScope(signal = new AbortController().signal): ExecutionScope {
    if (this.currentTurnScope) this.endTurnScope(this.currentTurnScope)
    return this.beginTurnScope({ agentId: this.selfAgentId, channelId: this.channelId, role: this.agentRole, workspace: {} as never, signal } as AgentRunContext)
  }

  async registerAliases(client: OmpRpcClient, scope: ExecutionScope): Promise<void> {
    await this.registerTurnTools(client, scope, true)
  }

  currentAlias(name: string): string | undefined {
    return this.hostToolAliases?.byName.get(name)
  }

  waitForRegistration(): Promise<void> {
    return this.hostToolRegistration
  }

  mapTestEvent(event: AgentSessionEvent): AgentSessionEvent | null {
    return this.canonicalToolEvent(event)
  }

  endTestScope(scope: ExecutionScope): void {
    this.endTurnScope(scope)
  }

  markTurnActive(): void {
    this.turnActive = true
  }

  setTurnActive(turnActive: boolean): void {
    if (turnActive && !this.currentTurnScope) this.beginTestScope()
    if (turnActive && this.client && this.currentTurnScope) this.installTestAliases(this.client, this.currentTurnScope)
    this.turnActive = turnActive
  }

  invokeHostTool(request: HostToolCallRequest, sourceClient: OmpRpcClient): Promise<{ text: string, isError?: boolean }> {
    return this.handleHostTool(request, sourceClient)
  }

  preparePeerTurn(): Promise<void> {
    return this.retireEndedSupervisionClient()
  }

  hasClient(): boolean {
    return this.client !== null
  }

  override async contextGate(): Promise<void> {}

  async* stream(signal: AbortSignal) {
    const scope = this.beginTestScope(signal)
    try {
      yield* this.promptAndStream('test prompt', undefined, signal)
    }
    finally {
      this.endTestScope(scope)
    }
  }

  override async dispatchTurnHostTool(_toolName: string, _args: Record<string, unknown>, scope: ExecutionScope, activeRootTaskId?: string): Promise<{ text: string, isError?: boolean }> {
    scope.assertActive()
    this.dispatchCount++
    this.dispatchedNames.push(_toolName)
    this.dispatchedRootTaskIds.push(activeRootTaskId)
    return { text: 'dispatched' }
  }
}

const request: HostToolCallRequest = {
  id: 'rpc-1', toolCallId: 'call-1', toolName: 'line_context', arguments: {},
}
const makeClient = (): OmpRpcClient => ({ kill: () => {} } as unknown as OmpRpcClient)

test('canceled or terminal root calls fail closed while valid root and taskless calls dispatch', async () => {
  const agent = new TestOmpAgent({ agentId: 'lead-1', role: 'lead', channelId: 'channel-1' })
  const originalClient = makeClient()
  const rootController = new AbortController()
  agent.setClient(originalClient)
  agent.setRootStateReader()
  agent.setLease(originalClient, 'root-1', true, rootController.signal)

  assert.deepEqual(await agent.invokeHostTool(request, originalClient), { text: 'dispatched' })
  assert.deepEqual(agent.dispatchedRootTaskIds, ['root-1'])
  agent.rootState = 'CANCELED'
  const terminalRootController = new AbortController()
  agent.setLease(originalClient, 'root-1', true, terminalRootController.signal)
  assert.equal((await agent.invokeHostTool(request, originalClient)).isError, true)
  assert.equal(agent.hasClient(), false)

  const canceledClient = makeClient()
  const canceledController = new AbortController()
  agent.rootState = 'WORKING'
  agent.setClient(canceledClient)
  agent.setLease(canceledClient, 'root-1', true, canceledController.signal)
  canceledController.abort()
  assert.equal((await agent.invokeHostTool(request, canceledClient)).isError, true)

  const terminalClient = makeClient()
  agent.setClient(terminalClient)
  agent.rootState = 'CANCELED'
  agent.setLease(terminalClient, 'root-1', false, new AbortController().signal)
  assert.equal((await agent.invokeHostTool(request, terminalClient)).isError, true)

  const messageClient = makeClient()
  const messageController = new AbortController()
  agent.setClient(messageClient)
  agent.setLease(messageClient, null, false, messageController.signal)
  assert.deepEqual(await agent.invokeHostTool(request, messageClient), { text: 'dispatched' })
  assert.equal(agent.dispatchedRootTaskIds.at(-1), undefined)
  assert.equal((await agent.invokeHostTool(request, originalClient)).isError, true)
  assert.equal(agent.dispatchCount, 2)
})

test('a terminal prior root is retired before the next taskless peer call', async () => {
  const agent = new TestOmpAgent({ agentId: 'lead-1', role: 'lead', channelId: 'channel-1' })
  const oldClient = makeClient()
  agent.rootState = 'CANCELED'
  agent.setClient(oldClient)
  agent.setRootStateReader()
  agent.setLease(oldClient, 'root-1', true, new AbortController().signal)

  await agent.preparePeerTurn()
  assert.equal(agent.hasClient(), false)

  const peerClient = makeClient()
  agent.setClient(peerClient)
  agent.setTurnActive(true)
  assert.deepEqual(await agent.invokeHostTool(request, peerClient), { text: 'dispatched' })
})

test('a worker cannot dispatch tasks even when the tool is invoked directly', async () => {
  const agent = new TestOmpAgent({ agentId: 'worker-1', role: 'worker', channelId: 'channel-1' })
  const client = makeClient()
  agent.setClient(client)
  agent.setTurnActive(true)

  const denied = await agent.invokeHostTool({ ...request, toolName: 'dispatch_task' }, client)
  assert.equal(denied.isError, true)
  assert.equal(agent.dispatchCount, 0)

  assert.deepEqual(await agent.invokeHostTool(request, client), { text: 'dispatched' })
  assert.equal(agent.dispatchCount, 1)
  assert.equal(agent.dispatchedRootTaskIds[0], undefined)
})

test('a delayed host call cannot inherit the next turn scope', async () => {
  const agent = new TestOmpAgent({ agentId: 'scope-lead', role: 'lead', channelId: 'channel' })
  const client = makeClient()
  const rootLookup = Promise.withResolvers<unknown>()
  agent.setClient(client)
  agent.setRootReader(() => rootLookup.promise)
  agent.setLease(client, 'root', true, new AbortController().signal)
  const call = agent.invokeHostTool(request, client)
  const nextScope = agent.beginTestScope()
  rootLookup.resolve({ state: 'WORKING' })
  assert.equal((await call).isError, true)
  assert.equal(agent.dispatchCount, 0)
  agent.endTestScope(nextScope)
})

class FrameClient extends OmpRpcClient {
  registrations: RpcCommand[] = []
  holdNext?: Promise<unknown>
  registrationStarted?: () => void

  override get alive(): boolean { return true }

  override async send<T = import('../server/services/workshop/agents/adapters/omp-rpc-client').RpcResponse>(command: RpcCommand): Promise<T & import('../server/services/workshop/agents/adapters/omp-rpc-client').RpcResponse> {
    this.registrations.push(command)
    if (this.holdNext && command.type === 'set_host_tools') {
      const hold = this.holdNext
      this.holdNext = undefined
      this.registrationStarted?.()
      await hold
    }
    return { type: 'response', command: command.type, success: true } as T & import('../server/services/workshop/agents/adapters/omp-rpc-client').RpcResponse
  }

  inject(request: HostToolCallRequest): Promise<void> {
    return this.handleHostToolCall({ type: 'host_tool_call', ...request })
  }
}

test('real RPC adapter rejects old aliases before dispatch and canonicalizes events', async () => {
  const agent = new TestOmpAgent({ agentId: 'alias-test', role: 'worker' })
  const client = new FrameClient()
  agent.setClient(client)
  client.onHostToolCall(req => agent.invokeHostTool(req, client))
  const events: AgentSessionEvent[] = []
  client.onEvent((event) => {
    const mapped = agent.mapTestEvent(event)
    if (mapped) events.push(mapped)
  })
  const oldScope = agent.beginTestScope()
  await agent.registerAliases(client, oldScope)
  const first = agent.currentAlias('poll_messages')!
  assert.ok(first.length <= 64)
  agent.markTurnActive()
  await client.inject({ ...request, toolName: first })
  assert.equal(agent.dispatchedNames.at(-1), 'poll_messages')
  assert.ok(events.some(event => event.type === 'tool_execution_start' && event.toolName === 'poll_messages'))
  agent.endTestScope(oldScope)
  const newScope = agent.beginTestScope()
  await agent.registerAliases(client, newScope)
  const current = agent.currentAlias('poll_messages')!
  assert.notEqual(current, first)
  const count = agent.dispatchCount
  const eventCount = events.length
  await client.inject({ ...request, id: 'late', toolName: first })
  assert.equal(events.length, eventCount)
  await client.inject({ ...request, id: 'unknown', toolName: 'line_context' })
  assert.equal(agent.dispatchCount, count)
  await client.inject({ ...request, id: 'current', toolName: current })
  assert.equal(agent.dispatchCount, count + 1)
  agent.endTestScope(newScope)
})

test('plugin refresh rotates aliases and revokes removed tools immediately', async () => {
  const agent = new TestOmpAgent({ agentId: 'alias-plugin', role: 'worker' })
  const client = new FrameClient()
  agent.setClient(client)
  const scope = agent.beginTestScope()
  await agent.registerAliases(client, scope)
  agent.markTurnActive()
  const initial = agent.currentAlias('poll_messages')
  assert.ok(initial)
  registerPluginTool('alias-test-plugin', { name: 'alias_test_plugin', description: 'test', parameters: { type: 'object', properties: {} }, handler: () => ({ text: 'ok' }) })
  try {
    await agent.waitForRegistration()
    assert.notEqual(agent.currentAlias('poll_messages'), initial)
    const pluginAlias = agent.currentAlias('alias_test_plugin')
    assert.ok(pluginAlias)
    assert.ok(pluginAlias!.length <= 64)
    unregisterPluginTools('alias-test-plugin')
    assert.equal((await agent.invokeHostTool({ ...request, toolName: pluginAlias! }, client)).isError, true)
    await agent.waitForRegistration()
    assert.equal(agent.currentAlias('alias_test_plugin'), undefined)
    registerPluginTool('alias-test-plugin', { name: 'alias_test_plugin', description: 'replacement', parameters: { type: 'object', properties: {} }, handler: () => ({ text: 'new' }) })
    await agent.waitForRegistration()
    const replacement = agent.currentAlias('alias_test_plugin')
    assert.ok(replacement)
    assert.notEqual(replacement, pluginAlias)
    const before = agent.dispatchCount
    assert.equal((await agent.invokeHostTool({ ...request, toolName: pluginAlias! }, client)).isError, true)
    assert.equal(agent.dispatchCount, before)
    assert.deepEqual(await agent.invokeHostTool({ ...request, toolName: replacement! }, client), { text: 'dispatched' })
  }
  finally {
    unregisterPluginTools('alias-test-plugin')
    agent.endTestScope(scope)
  }
})

test('overlapping plugin refreshes do not publish superseded registrations', async () => {
  const agent = new TestOmpAgent({ agentId: 'alias-race', role: 'worker' })
  const client = new FrameClient()
  agent.setClient(client)
  const scope = agent.beginTestScope()
  await agent.registerAliases(client, scope)
  agent.markTurnActive()
  const gate = Promise.withResolvers<undefined>()
  const started = Promise.withResolvers<undefined>()
  client.holdNext = gate.promise
  client.registrationStarted = () => started.resolve(undefined)
  registerPluginTool('alias-race-plugin', { name: 'alias_race_tool', description: 'test', parameters: { type: 'object' }, handler: () => ({ text: 'ok' }) })
  await started.promise
  unregisterPluginTools('alias-race-plugin')
  gate.resolve(undefined)
  await agent.waitForRegistration()
  assert.equal(agent.currentAlias('alias_race_tool'), undefined)
  assert.ok(agent.currentAlias('poll_messages'))
  agent.endTestScope(scope)
})

function makeStreamingClient(failPrompt = false) {
  const listeners = new Set<(event: AgentSessionEvent) => void>()
  const commands: string[] = []
  let kills = 0
  const client = {
    onEvent: (listener: (event: AgentSessionEvent) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    send: async (command: { type: string }) => {
      commands.push(command.type)
      if (failPrompt && command.type === 'prompt') throw new Error('prompt failed')
    },
    kill: () => {
      kills++
    },
  } as unknown as OmpRpcClient
  return {
    client,
    listeners,
    commands,
    get kills() { return kills },
  }
}

test('OMP pauses for approval and starts a full idle window on resolution', async () => {
  const agentId = 'omp-approval-wait'
  const agent = new TestOmpAgent({ agentId, promptTimeoutMs: 80 })
  const { client, listeners, commands } = makeStreamingClient()
  agent.setClient(client)
  const controller = new AbortController()
  const stream = agent.stream(controller.signal)
  const next = stream.next()
  await delay(20)
  const approvals = getToolApprovals()
  const request = approvals.request(agentId, 'node', 'dcw', 'wait', { timeoutMs: 10_000 })
  await delay(220)
  assert.equal(commands.includes('abort'), false)
  approvals.decide(approvals.listPending(agentId)[0]!.id, true, '')
  await request
  await delay(30)
  assert.equal(commands.includes('abort'), false)
  const result = await next
  assert.equal(result.value?.kind, 'error')
  assert.equal(result.value?.kind === 'error' && result.value.error.code, 'TURN_STALLED')
  await stream.return()
  assert.equal(listeners.size, 0)
})

test('OMP observes a quick approval during its idle timer and cleans up on abort', async () => {
  const agentId = 'omp-approval-quick'
  const agent = new TestOmpAgent({ agentId, promptTimeoutMs: 200 })
  const { client, listeners, commands } = makeStreamingClient()
  agent.setClient(client)
  const controller = new AbortController()
  const stream = agent.stream(controller.signal)
  const next = stream.next()
  await delay(170)
  const approvals = getToolApprovals()
  const request = approvals.request(agentId, 'node', 'dcw', 'quick', { timeoutMs: 10_000 })
  approvals.decide(approvals.listPending(agentId)[0]!.id, true, '')
  await request
  await delay(160)
  assert.equal(commands.includes('abort'), false)
  controller.abort()
  assert.equal((await next).value?.kind, 'done')
  await stream.return()
  assert.equal(listeners.size, 0)
})

test('aborted OMP turn retires its client before a new turn can accept late frames', async () => {
  const agent = new TestOmpAgent({ agentId: 'omp-abort-fence', promptTimeoutMs: 1_000 })
  const old = makeStreamingClient()
  agent.setClient(old.client)
  const controller = new AbortController()
  const stream = agent.stream(controller.signal)
  const next = stream.next()
  await delay(10)
  controller.abort()
  assert.equal((await next).value?.kind, 'done')
  await stream.return()
  assert.equal(old.kills, 1)
  assert.equal(agent.hasClient(), false)
  const replacement = makeStreamingClient()
  agent.setClient(replacement.client)
  const scope = agent.beginTestScope()
  agent.setTurnActive(true)
  assert.equal((await agent.invokeHostTool(request, old.client)).isError, true)
  assert.equal(agent.dispatchCount, 0)
  agent.endTestScope(scope)
})

test('OMP prompt failure removes every event and approval subscription', async () => {
  const agentId = 'omp-approval-fail'
  const agent = new TestOmpAgent({ agentId })
  const { client, listeners } = makeStreamingClient(true)
  agent.setClient(client)
  const stream = agent.stream(new AbortController().signal)
  const result = await stream.next()
  assert.equal(result.value?.kind === 'error' && result.value.error.code, 'PROMPT_FAILED')
  await stream.return()
  assert.equal(listeners.size, 0)
  const approvals = getToolApprovals() as unknown as { approvalListeners: Map<string, Set<() => void>> }
  assert.equal(approvals.approvalListeners.has(agentId), false)
})
