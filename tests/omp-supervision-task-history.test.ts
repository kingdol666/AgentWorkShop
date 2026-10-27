import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AgentSessionEvent } from '../server/services/workshop/agents/adapters/omp-rpc-client'
import { recordSupervisionToolHistory, supervisionToolHistoryMessage } from '../server/services/workshop/agents/omp-agent/supervision-history'

test('supervisor history formatter records host-tool starts and compact results', () => {
  assert.equal(
    supervisionToolHistoryMessage({ type: 'tool_execution_start', toolName: 'recipe_trial', args: { recipe_id: 'recipe-1', value: 125 } }),
    '🔧 recipe_trial(recipe_id=recipe-1, value=125)',
  )
  assert.equal(
    supervisionToolHistoryMessage({ type: 'tool_execution_end', toolName: 'recipe_trial', isError: false, result: '1/1 verified' }),
    '🔧 recipe_trial ✅ 完成: 1/1 verified',
  )
  assert.equal(
    supervisionToolHistoryMessage({ type: 'tool_execution_end', toolName: 'recipe_trial', isError: true, result: 'denied' }),
    '🔧 recipe_trial ❌ 失败: denied',
  )
  assert.equal(supervisionToolHistoryMessage({ type: 'agent_end' }), null)
})

test('supervisor host-tool events are appended through the active task workspace', async () => {
  const entries: Array<{ taskId: string, message: string }> = []
  const workspace = {
    reportTask: async (input: { taskId: string, message?: string }) => {
      entries.push({ taskId: input.taskId, message: input.message ?? '' })
      return {} as never
    },
  }
  const event: AgentSessionEvent = { type: 'tool_execution_start', toolName: 'read_node', args: { node_id: 'node-1' } }

  await recordSupervisionToolHistory(workspace, 'root-1', event)

  assert.deepEqual(entries, [{ taskId: 'root-1', message: '🔧 read_node(node_id=node-1)' }])
})
