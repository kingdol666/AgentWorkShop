import { test } from 'node:test'
import assert from 'node:assert/strict'
import { OmpRpcClient } from '../server/services/workshop/agents/adapters/omp-rpc-client'

class TestOmpRpcClient extends OmpRpcClient {
  runHostToolCall(req: { id: string, toolCallId: string, toolName: string, arguments: Record<string, unknown> }): Promise<void> {
    return this.handleHostToolCall({ type: 'host_tool_call', ...req })
  }
}

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
