import { test } from 'node:test'
import assert from 'node:assert/strict'
import { handleDispatchTask } from '../server/services/workshop/agents/host-tool-bridge/tools/tasks'
import type { HostToolBridgeContext } from '../server/services/workshop/agents/host-tool-bridge/types'

const leadIdentity: HostToolBridgeContext['identity'] = {
  agentId: 'lead-1',
  channelId: 'channel-1',
  role: 'lead',
  name: 'lead',
}

function makeWorkspace(rootState = 'WORKING', rootAssignee = leadIdentity.agentId) {
  let dispatched: Record<string, unknown> | null = null
  const workspace = {
    getTask: async (taskId: string) => taskId === 'root-1'
      ? { id: 'root-1', state: rootState, assigneeId: rootAssignee }
      : null,
    listTasks: async () => [],
    dispatchTask: async (input: Record<string, unknown>) => {
      dispatched = input
      return { id: 'child-1' }
    },
  } as never
  return { workspace, getDispatched: () => dispatched }
}

test('dispatch_task binds omitted and blank parent IDs to the server supervision root', async () => {
  for (const args of [
    { assignee_id: 'worker-1', title: 'inspect' },
    { assignee_id: 'worker-1', title: 'inspect', parent_task_id: '' },
    { assignee_id: 'worker-1', title: 'inspect', parent_task_id: '   ' },
  ]) {
    const { workspace, getDispatched } = makeWorkspace()
    const result = await handleDispatchTask(args, workspace, leadIdentity, 'root-1')
    assert.equal(result.isError, undefined)
    assert.equal(getDispatched()?.parentTaskId, 'root-1')
  }
})

test('dispatch_task accepts the matching parent and rejects a mismatched parent', async () => {
  const matching = makeWorkspace()
  const accepted = await handleDispatchTask({ assignee_id: 'worker-1', title: 'inspect', parent_task_id: 'root-1' }, matching.workspace, leadIdentity, 'root-1')
  assert.equal(accepted.isError, undefined)
  assert.equal(matching.getDispatched()?.parentTaskId, 'root-1')

  const mismatched = makeWorkspace()
  const rejected = await handleDispatchTask({ assignee_id: 'worker-1', title: 'inspect', parent_task_id: 'other-root' }, mismatched.workspace, leadIdentity, 'root-1')
  assert.equal(rejected.isError, true)
  assert.equal(mismatched.getDispatched(), null)
})

test('dispatch_task rejects a terminal or non-owned supervision root and rejects non-string parents', async () => {
  const terminal = makeWorkspace('COMPLETED')
  const terminalResult = await handleDispatchTask({ assignee_id: 'worker-1', title: 'inspect' }, terminal.workspace, leadIdentity, 'root-1')
  assert.equal(terminalResult.isError, true)
  assert.equal(terminal.getDispatched(), null)

  const notOwned = makeWorkspace('WORKING', 'lead-2')
  const ownershipResult = await handleDispatchTask({ assignee_id: 'worker-1', title: 'inspect' }, notOwned.workspace, leadIdentity, 'root-1')
  assert.equal(ownershipResult.isError, true)
  assert.equal(notOwned.getDispatched(), null)

  const wrongRole = makeWorkspace()
  const workerIdentity = { ...leadIdentity, agentId: 'worker-1', role: 'worker' as const }
  const roleResult = await handleDispatchTask({ assignee_id: 'worker-2', title: 'inspect' }, wrongRole.workspace, workerIdentity, 'root-1')
  assert.equal(roleResult.isError, true)
  assert.equal(wrongRole.getDispatched(), null)

  const invalidParent = makeWorkspace()
  const invalidResult = await handleDispatchTask({ assignee_id: 'worker-1', title: 'inspect', parent_task_id: 42 }, invalidParent.workspace, leadIdentity, 'root-1')
  assert.equal(invalidResult.isError, true)
  assert.equal(invalidParent.getDispatched(), null)
})

test('dispatch_task preserves standalone behavior when no supervision root is supplied', async () => {
  const { workspace, getDispatched } = makeWorkspace()
  const result = await handleDispatchTask({ assignee_id: 'worker-1', title: 'inspect' }, workspace, leadIdentity)
  assert.equal(result.isError, undefined)
  assert.equal(getDispatched()?.parentTaskId, undefined)
})
