import { test } from 'node:test'
import assert from 'node:assert/strict'
import { OmpRpcAgentImpl } from '../server/services/workshop/agents/omp-agent'
import type { OmpRpcClient, HostToolCallRequest } from '../server/services/workshop/agents/adapters/omp-rpc-client'

class TestOmpAgent extends OmpRpcAgentImpl {
  dispatchCount = 0
  dispatchedRootTaskIds: Array<string | undefined> = []
  rootState = 'WORKING'

  setClient(client: OmpRpcClient): void {
    this.client = client
  }

  setRootStateReader(): void {
    this.workspace = { getTask: async () => ({ state: this.rootState }) } as never
  }

  setLease(client: OmpRpcClient, rootId: string | null, rootActive: boolean, signal: AbortSignal): void {
    this.activeSupervisionToolLease = { client, rootId, rootActive, signal }
    this.turnActive = true
  }

  setTurnActive(turnActive: boolean): void {
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

  override async dispatchHostTool(_toolName: string, _args: Record<string, unknown>, activeRootTaskId?: string): Promise<{ text: string, isError?: boolean }> {
    this.dispatchCount++
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
