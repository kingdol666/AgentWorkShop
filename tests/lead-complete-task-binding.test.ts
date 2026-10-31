import { test } from 'node:test'
import assert from 'node:assert/strict'
import { handleCompleteTask, handleReportProgress } from '../server/services/workshop/agents/host-tool-bridge/tools/progress'
import type { HostToolSessionState } from '../server/services/workshop/agents/host-tool-bridge/types'
import type { AgentWorkspace } from '../server/services/workshop/agents/agent-interface'
import type { WorkspaceTask } from '../server/services/workshop/types/task'

/**
 * 2026-10-30 回归:lead 监督回合不经过 workerTurn,session.currentTaskId 恒空;
 * dispatch 层必须把已验证的 activeRootTaskId(lease.rootId)透传给 complete_task /
 * report_progress,否则 lead 收口恒报「无任务 ID」,根任务只能被看门狗取消。
 * (三次实机复现:模型反复 complete_task ❌ 无任务 ID → 任务 CANCELED by watchdog)
 */

const state: HostToolSessionState = {
  currentTaskId: null,
  sourceChatMessageId: null,
  sourceChatDeliveryId: null,
  replyContext: null,
}

function makeWorkspace(rootOver: Partial<WorkspaceTask> = {}) {
  const root: WorkspaceTask = {
    id: 'root-1',
    channelId: 'channel-1',
    state: 'WORKING',
    assigneeId: 'lead-1',
    creatorId: 'user-1',
    title: 'root',
    progress: 0,
    retryCount: 0,
    artifacts: [],
    history: [],
    createdAt: '2026-10-30T00:00:00.000Z',
    updatedAt: '2026-10-30T00:00:00.000Z',
    ...rootOver,
  }
  const completed: WorkspaceTask[] = []
  const reported: Array<{ taskId: string, progress: number }> = []
  const workspace = {
    getTask: async (taskId: string) => (taskId === 'root-1' ? root : null),
    listTasks: async () => [root],
    completeTask: async (taskId: string, artifacts: unknown) => {
      completed.push({ ...root, id: taskId, state: 'COMPLETED', artifacts: artifacts as never })
    },
    reportTask: async (input: { taskId: string, progress: number }) => {
      reported.push(input)
    },
    myQueue: async () => ({ queued: [] }),
  } as unknown as AgentWorkspace
  return { workspace, completed, reported }
}

test('complete_task: lead 无 task_id 且会话态为空 → 兜底到分发层验证的监督根任务', async () => {
  const { workspace, completed } = makeWorkspace()
  const result = await handleCompleteTask({ summary: 'lead 收口' }, state, workspace, 'root-1')
  assert.equal(result.isError, undefined)
  assert.match(result.text, /已完成/)
  assert.equal(completed.length, 1)
  assert.equal(completed[0]?.id, 'root-1')
})

test('complete_task: 显式 task_id 优先,且无任何上下文时仍 fail-closed', async () => {
  // 显式 task_id 走显式路径
  const a = makeWorkspace()
  await handleCompleteTask({ task_id: 'root-1', summary: 's' }, state, a.workspace, undefined)
  assert.equal(a.completed[0]?.id, 'root-1')

  // 三处全空 → 明确报错(不猜测)
  const b = makeWorkspace()
  const denied = await handleCompleteTask({ summary: 's' }, state, b.workspace, undefined)
  assert.equal(denied.isError, true)
  assert.match(denied.text, /无任务 ID/)
})

test('complete_task: 有未收口子任务时 lead 收口被拒(保护语义不因兜底而放松)', async () => {
  const child: WorkspaceTask = {
    id: 'child-1', channelId: 'channel-1', parentId: 'root-1', state: 'WORKING', assigneeId: 'w-1',
    creatorId: 'lead-1', title: 'child', progress: 0, retryCount: 0, artifacts: [], history: [],
    createdAt: '2026-10-30T00:00:00.000Z', updatedAt: '2026-10-30T00:00:00.000Z',
  }
  const { workspace } = makeWorkspace()
  const ws = { ...workspace, listTasks: async () => [child] } as unknown as AgentWorkspace
  const result = await handleCompleteTask({ summary: 's' }, state, ws, 'root-1')
  assert.equal(result.isError, true)
  assert.match(result.text, /未收口的子任务/)
})

test('report_progress: lead 兜底到监督根任务(此前恒报无当前任务上下文)', async () => {
  const { workspace, reported } = makeWorkspace()
  const result = await handleReportProgress({ progress: 50, message: 'halfway' }, state, workspace, 'root-1')
  assert.equal(result.isError, undefined)
  assert.equal(reported[0]?.taskId, 'root-1')
  assert.equal(reported[0]?.progress, 50)
})

test('report_progress: 无任何上下文仍 fail-closed', async () => {
  const { workspace } = makeWorkspace()
  const result = await handleReportProgress({ progress: 10 }, state, workspace, undefined)
  assert.equal(result.isError, true)
  assert.match(result.text, /无当前任务上下文/)
})
