import { test } from 'node:test'
import assert from 'node:assert/strict'
import { handleReportProgress } from '../server/services/workshop/agents/host-tool-bridge/tools/progress'
import type { HostToolSessionState } from '../server/services/workshop/agents/host-tool-bridge/types'
import type { AgentWorkspace } from '../server/services/workshop/agents/agent-interface'
import type { WorkspaceTask } from '../server/services/workshop/types/task'

/**
 * 2026-10-30 回归:迟到回合的诚实回执。
 *  任务被平台收口(看门狗取消/超时判 FAILED)后,worker 的在途回合仍会调
 *  report_progress —— manager 有意丢弃终态写入(活性信号不得写终态),但工具面
 *  旧实现照样回报「进度已上报」,Agent 误信进度已同步、继续在僵尸任务上作业。
 *  另:progress 参数来自异构 LLM,字符串化/越界值必须钳制,不得原样落库。
 */

const state: HostToolSessionState = {
  currentTaskId: null,
  sourceChatMessageId: null,
  sourceChatDeliveryId: null,
  replyContext: null,
}

function makeWorkspace(taskOver: Partial<WorkspaceTask> = {}) {
  const task: WorkspaceTask = {
    id: 't-1',
    channelId: 'channel-1',
    state: 'WORKING',
    assigneeId: 'w-1',
    creatorId: 'lead-1',
    title: 'task',
    progress: 0,
    retryCount: 0,
    artifacts: [],
    history: [],
    createdAt: '2026-10-30T00:00:00.000Z',
    updatedAt: '2026-10-30T00:00:00.000Z',
    ...taskOver,
  }
  const reported: Array<{ taskId: string, progress: number }> = []
  const workspace = {
    getTask: async (taskId: string) => (taskId === 't-1' ? task : null),
    reportTask: async (input: { taskId: string, progress: number }) => {
      reported.push({ taskId: input.taskId, progress: input.progress })
    },
  } as unknown as AgentWorkspace
  return { workspace, reported }
}

test('report_progress: 终态任务(CANCELED)→ 诚实拒绝且不再写入,不谎报成功', async () => {
  const { workspace, reported } = makeWorkspace({ state: 'CANCELED' })
  const r = await handleReportProgress({ progress: 80 }, state, workspace, 't-1')
  assert.equal(r.isError, true)
  assert.match(r.text, /已终态/)
  assert.match(r.text, /进度写入被忽略/)
  assert.equal(reported.length, 0, '终态任务不得再有进度写入')
})

test('report_progress: 活跃任务正常上报(守卫不误伤)', async () => {
  const { workspace, reported } = makeWorkspace()
  const r = await handleReportProgress({ progress: 50, message: '推进中' }, state, workspace, 't-1')
  assert.equal(r.isError, undefined)
  assert.match(r.text, /进度已上报: 50%/)
  assert.deepEqual(reported, [{ taskId: 't-1', progress: 50 }])
})

test('report_progress: 字符串化数字被归一("80" → 80),非数字 fail-closed', async () => {
  const a = makeWorkspace()
  const ok = await handleReportProgress({ progress: '80' }, state, a.workspace, 't-1')
  assert.equal(ok.isError, undefined)
  assert.deepEqual(a.reported, [{ taskId: 't-1', progress: 80 }])

  const b = makeWorkspace()
  const bad = await handleReportProgress({ progress: 'abc' }, state, b.workspace, 't-1')
  assert.equal(bad.isError, true)
  assert.equal(b.reported.length, 0)
})

test('report_progress: 越界值钳到 [0,100](不原样落库污染看门狗)', async () => {
  const hi = makeWorkspace()
  await handleReportProgress({ progress: 999 }, state, hi.workspace, 't-1')
  assert.deepEqual(hi.reported, [{ taskId: 't-1', progress: 100 }])

  const lo = makeWorkspace()
  await handleReportProgress({ progress: -5 }, state, lo.workspace, 't-1')
  assert.deepEqual(lo.reported, [{ taskId: 't-1', progress: 0 }])
})
