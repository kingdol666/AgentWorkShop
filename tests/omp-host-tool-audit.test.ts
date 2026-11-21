import { test } from 'node:test'
import assert from 'node:assert/strict'
import { OmpRpcClient, type RpcCommand, type RpcResponse } from '../server/services/workshop/agents/adapters/omp-rpc-client'
import { OmpRpcAgentImpl } from '../server/services/workshop/agents/omp-agent'
import type { AgentRunContext } from '../server/services/workshop/agents/agent-interface'

class TestOmpRpcClient extends OmpRpcClient {
  runHostToolCall(req: { id: string, toolCallId: string, toolName: string, arguments: Record<string, unknown> }): Promise<void> {
    return this.handleHostToolCall({ type: 'host_tool_call', ...req })
  }

  injectFrame(frame: Record<string, unknown>): void {
    this.dispatchFrame(frame)
  }
}

test('OMP applies the configured reasoning level after model selection via RPC', async (t) => {
  class TestOmpAgent extends OmpRpcAgentImpl {
    async connect(): Promise<void> {
      await this.ensureClient({ channelId: 'channel', role: 'worker', workspace: {} } as AgentRunContext)
    }
  }
  t.mock.method(OmpRpcClient.prototype, 'start', async () => {})
  const commands: RpcCommand[] = []
  const send = async <T = RpcResponse>(command: RpcCommand): Promise<T & RpcResponse> => {
    commands.push(command)
    return { type: 'response', command: command.type, success: true } as T & RpcResponse
  }
  t.mock.method(OmpRpcClient.prototype, 'send', send)
  const agent = new TestOmpAgent({ provider: 'provider', model: 'model', effort: 'high' })
  t.after(() => agent.dispose())
  await agent.connect()
  assert.deepEqual(commands.slice(0, 3), [
    { type: 'set_model', provider: 'provider', modelId: 'model' },
    { type: 'set_thinking_level', level: 'high' },
    { type: 'get_state' },
  ])
})

test('untagged ordinary frames cannot be correlated to a prompt by the adapter', () => {
  const client = new TestOmpRpcClient()
  const events: Array<Record<string, unknown>> = []
  const unsubscribeOld = client.onEvent(() => {})
  client.injectFrame({ type: 'session_settled' })
  unsubscribeOld()
  client.onEvent(event => events.push(event))
  client.injectFrame({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'late old text' } })
  client.injectFrame({ type: 'agent_end', messages: [], isTerminal: true })
  assert.deepEqual(events.map(event => event.type), ['message_update', 'agent_end'])
  assert.ok(events.every(event => !('promptId' in event)))
})

test('host tool calls emit history-compatible start/end events without changing handler behavior', async () => {
  const client = new TestOmpRpcClient()
  const events: Array<Record<string, unknown>> = []
  const args = { path: '/tmp/report.txt', token: 'not-for-history' }
  let handlerCalls = 0

  client.onEvent(() => {
    throw new Error('listener failure')
  })
  client.onEvent((event) => {
    events.push(event)
  })
  client.onHostToolCall(async (req) => {
    handlerCalls++
    assert.deepEqual(req, {
      id: 'rpc-1',
      toolCallId: 'call-1',
      toolName: 'read_report',
      arguments: args,
    })
    return { text: 'report contents' }
  })

  await client.runHostToolCall({ id: 'rpc-1', toolCallId: 'call-1', toolName: 'read_report', arguments: args })

  assert.equal(handlerCalls, 1)
  assert.deepEqual(events, [
    { type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'read_report', args },
    { type: 'tool_execution_end', toolCallId: 'call-1', toolName: 'read_report', isError: false, result: 'report contents' },
  ])
})

test('host tool handler errors are captured in the end event and remain protocol results', async () => {
  const client = new TestOmpRpcClient()
  const events: Array<Record<string, unknown>> = []
  client.onEvent(event => events.push(event))
  client.onHostToolCall(async () => {
    throw new Error('handler failed')
  })

  await client.runHostToolCall({ id: 'rpc-2', toolCallId: 'call-2', toolName: 'write_report', arguments: {} })

  assert.deepEqual(events.map(event => event.type), ['tool_execution_start', 'tool_execution_end'])
  assert.deepEqual(events[1], {
    type: 'tool_execution_end',
    toolCallId: 'call-2',
    toolName: 'write_report',
    isError: true,
    result: '工具执行异常: handler failed',
  })
})
