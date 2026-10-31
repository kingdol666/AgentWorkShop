import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OmpRpcAgentImpl } from '../server/services/workshop/agents/omp-agent'
import type { AgentEvent, AgentRunContext, AgentRunRequest } from '../server/services/workshop/agents/agent-interface'
import type { AgentSessionEvent, HostToolCallRequest, OmpRpcClient } from '../server/services/workshop/agents/adapters/omp-rpc-client'
import { handleDispatchTask } from '../server/services/workshop/agents/host-tool-bridge/tools/tasks'

class TestOmpAgent extends OmpRpcAgentImpl {
  dispatchedRootTaskIds: Array<string | undefined> = []
  createdTasks: Array<Record<string, unknown>> = []
  private taskWorkspace: never = null as never

  setClient(client: OmpRpcClient): void {
    this.client = client
  }

  setTaskWorkspace(workspace: never): void {
    this.taskWorkspace = workspace
  }

  setLease(client: OmpRpcClient, rootId: string): void {
    this.activeSupervisionToolLease = { client, rootId, rootActive: true }
  }

  mapEvent(event: AgentSessionEvent): void {
    this.mapOmpEvent(event, undefined)
  }

  hasSupervisionLease(): boolean {
    return this.activeSupervisionToolLease !== null
  }

  invokeHostTool(request: HostToolCallRequest, sourceClient: OmpRpcClient): Promise<{ text: string, isError?: boolean }> {
    return this.handleHostTool(request, sourceClient)
  }

  runPeerTurn(request: AgentRunRequest, ctx: AgentRunContext): AsyncGenerator<AgentEvent, void, unknown> {
    return this.peerTurn(request, ctx)
  }

  protected override async ensureClient(_ctx: AgentRunContext): Promise<void> {}

  protected override async contextGate(): Promise<void> {}

  protected override async contextPrefix(): Promise<string> {
    return ''
  }

  override async dispatchHostTool(_toolName: string, _args: Record<string, unknown>, activeRootTaskId?: string): Promise<{ text: string, isError?: boolean }> {
    this.dispatchedRootTaskIds.push(activeRootTaskId)
    if (_toolName === 'dispatch_task') {
      return handleDispatchTask(_args, this.taskWorkspace, {
        agentId: this.selfAgentId,
        channelId: this.channelId,
        role: this.agentRole,
        name: this.agentName,
      }, activeRootTaskId)
    }
    return { text: 'dispatched' }
  }
}

function makeEventingClient(onPeerPrompt?: () => Promise<void>): OmpRpcClient {
  const listeners = new Set<(event: AgentSessionEvent) => void>()
  let promptCount = 0
  const emit = (event: AgentSessionEvent): void => {
    for (const listener of [...listeners]) listener(event)
  }
  return {
    onEvent: (listener: (event: AgentSessionEvent) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    send: async (command: { type: string }) => {
      if (command.type === 'prompt') {
        promptCount++
        if (promptCount === 2) {
          await onPeerPrompt?.()
          emit({ type: 'tool_execution_start', toolCallId: 'peer-call', toolName: 'dispatch_task', args: {} })
          emit({ type: 'tool_execution_end', toolCallId: 'peer-call', toolName: 'dispatch_task', result: 'peer-child' })
        }
        emit({ type: 'agent_end', isTerminal: true, messages: [] })
      }
      return {} as never
    },
    kill: () => {},
  } as unknown as OmpRpcClient
}

test('OMP audit binds active root events and keeps the following peer turn taskless', async () => {
  const oldLog = process.env.AW_AGENTTEAM_EVENT_LOG
  const oldRunId = process.env.AW_AGENTTEAM_RUN_ID
  const dir = mkdtempSync(join(tmpdir(), 'aw-supervision-task-audit-'))
  const path = join(dir, 'events.jsonl')
  process.env.AW_AGENTTEAM_EVENT_LOG = path
  process.env.AW_AGENTTEAM_RUN_ID = 'run-supervision-context-test'

  try {
    const client = { kill: () => {} } as unknown as OmpRpcClient
    const agent = new TestOmpAgent({ agentId: 'lead-1', role: 'lead', channelId: 'channel-1' })
    agent.setClient(client)
    agent.setLease(client, 'root-1')
    agent.mapEvent({ type: 'tool_execution_start', toolCallId: 'call-root', toolName: 'dispatch_task', args: {} })
    agent.mapEvent({ type: 'tool_execution_end', toolCallId: 'call-root', toolName: 'dispatch_task', result: 'child-1' })

    const rows = readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    assert.equal(rows.length, 2)
    assert.ok(rows.every(row => row.task_id === 'root-1'))

    const rootTask = {
      id: 'root-1', title: 'root', description: 'root task', assigneeId: 'lead-1', state: 'WORKING',
      progress: 0, artifacts: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }
    const agentRef: { current: TestOmpAgent | null } = { current: null }
    let peerDispatchResult: { text: string, isError?: boolean } | undefined
    let peerReadResult: { text: string, isError?: boolean } | undefined
    const dispatchRequest = { id: 'peer-rpc', toolCallId: 'peer-dispatch', toolName: 'dispatch_task', arguments: {} }
    const readRequest = { id: 'peer-read-rpc', toolCallId: 'peer-read', toolName: 'line_context', arguments: {} }
    const peerClient = makeEventingClient(async () => {
      const peerAgent = agentRef.current!
      peerDispatchResult = await peerAgent.invokeHostTool(dispatchRequest, peerClient)
      peerReadResult = await peerAgent.invokeHostTool(readRequest, peerClient)
    })
    const peerAgent = new TestOmpAgent({ agentId: 'lead-1', role: 'lead', channelId: 'channel-1' })
    agentRef.current = peerAgent
    peerAgent.setClient(peerClient)
    const taskWorkspace = {
      listAgents: async () => [],
      getTask: async () => rootTask,
      listTasks: async () => [],
      dispatchTask: async (input: Record<string, unknown>) => {
        peerAgent.createdTasks.push(input)
        return { ...rootTask, id: `child-${peerAgent.createdTasks.length}` }
      },
    } as never
    peerAgent.setTaskWorkspace(taskWorkspace)
    const workspace = taskWorkspace as never
    peerAgent.attachWorkspace(workspace)
    const ctx = {
      agentId: 'lead-1', channelId: 'channel-1', role: 'lead', workspace,
      signal: new AbortController().signal,
    } as AgentRunContext
    const snapshot = {
      tick: 1, now: Date.now(), tasks: [rootTask], activeRootId: 'root-1',
      queuedRootIds: [], members: [{ agentId: 'lead-1', name: 'lead', role: 'lead', state: 'idle' }], pendingChildren: {},
    } as never

    await peerAgent.supervise(snapshot, ctx)
    assert.equal(peerAgent.hasSupervisionLease(), false)
    const lateDispatchResult = await peerAgent.invokeHostTool(dispatchRequest, peerClient)
    assert.equal(lateDispatchResult.isError, true)
    assert.equal(peerAgent.createdTasks.length, 0)
    // Exercise peerTurn's explicit taskless reset even if a stale root lease survives to its entry.
    peerAgent.setLease(peerClient, 'root-1')

    const peerRequest = {
      message: {
        messageId: 'peer-message', contextId: 'channel-1', role: 'ROLE_USER', parts: [{ text: 'Please inspect this.' }], metadata: {},
      },
      contextId: 'channel-1', fromAgentId: 'agent-peer', toAgentId: 'lead-1',
    } as AgentRunRequest
    for await (const _event of peerAgent.runPeerTurn(peerRequest, ctx)) { /* drain peer turn */ }

    assert.equal(peerDispatchResult?.isError, true)
    assert.deepEqual(peerReadResult, { text: 'dispatched' })
    assert.equal(peerAgent.createdTasks.length, 0)
    assert.deepEqual(peerAgent.dispatchedRootTaskIds, [undefined])
    const finalRows = readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    assert.equal(finalRows.length, 4)
    assert.ok(finalRows.slice(2).every(row => row.task_id === null))
  }
  finally {
    if (oldLog === undefined) delete process.env.AW_AGENTTEAM_EVENT_LOG
    else process.env.AW_AGENTTEAM_EVENT_LOG = oldLog
    if (oldRunId === undefined) delete process.env.AW_AGENTTEAM_RUN_ID
    else process.env.AW_AGENTTEAM_RUN_ID = oldRunId
    rmSync(dir, { recursive: true, force: true })
  }
})
