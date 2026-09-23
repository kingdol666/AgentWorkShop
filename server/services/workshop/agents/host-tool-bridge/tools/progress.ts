/**
 * 进度与完成面(report_progress / complete_task)——原 dispatchHostTool 两个 case 的函数体按行搬运。
 * 闭包捕获的三样东西改为显式参数:args(调用参数)、state(会话态,完成时清空 currentTaskId)、ws。
 */
import { randomUUID } from 'node:crypto'
import type { AgentWorkspace } from '../../agent-interface'
import type { A2AArtifact } from '../../../types/a2a'
import type { HostToolResult, HostToolSessionState } from '../types'

export async function handleReportProgress(
  args: Record<string, unknown>,
  state: HostToolSessionState,
  ws: AgentWorkspace,
): Promise<HostToolResult> {
  const progress = args.progress as number
  const message = args.message as string | undefined
  const taskId = state.currentTaskId
  if (!taskId) return { text: '无当前任务上下文', isError: true }
  await ws.reportTask({ taskId, progress, message })
  return { text: `进度已上报: ${progress}%${message ? ` (${message})` : ''}` }
}

export async function handleCompleteTask(
  args: Record<string, unknown>,
  state: HostToolSessionState,
  ws: AgentWorkspace,
): Promise<HostToolResult> {
  const summary = args.summary as string
  const deliverable = args.deliverable as string | undefined
  const taskId = (args.task_id as string | undefined) ?? state.currentTaskId
  if (!taskId) return { text: '无任务 ID', isError: true }
  // 父任务保护:有未完成子任务时拒绝完成(lead 须等 worker 交付)
  const allTasks = await ws.listTasks()
  const incompleteChildren = allTasks.filter(t => t.parentId === taskId && t.state !== 'COMPLETED')
  if (incompleteChildren.length > 0) {
    return {
      text: `任务 ${taskId} 有 ${incompleteChildren.length} 个未通过验收的子任务(包含失败/取消)。请先解决或重新指派，再由 Lead 检查交付物并提交验收总结。`,
      isError: true,
    }
  }
  // 终态幂等:任务已被平台收口(看门狗取消/调度器完成)时不撞状态机 ——
  // 给 Agent 明确的"无需再完成,继续下一项"信号,杜绝重复重试烧 token
  const current = await ws.getTask(taskId)
  if (current && current.state !== 'SUBMITTED' && current.state !== 'ASSIGNED' && current.state !== 'WORKING' && current.state !== 'WAITING') {
    if (current.state === 'COMPLETED') {
      return { text: `任务 ${taskId} 已是完成状态(可能已被平台收口),无需重复完成。` }
    }
    try {
      const q = await ws.myQueue()
      const next = q.queued[0]
      return {
        text: `任务 ${taskId} 已被平台${current.state === 'CANCELED' ? '取消(如停滞回收/上级作废)' : '判定失败'},不能再标记完成 —— 这不是你的错误,也无需重试。${next ? `队列还有 ${q.queued.length} 项,下一项「${next.title}」即将开始,请继续处理。` : '队列为空,保持待命。'}`,
        isError: false,
      }
    }
    catch {
      return { text: `任务 ${taskId} 已被平台${current.state === 'CANCELED' ? '取消' : '判定失败'},无需再完成,请继续处理队列下一项。` }
    }
  }
  const artifacts: A2AArtifact[] = []
  if (deliverable || summary) {
    artifacts.push({
      artifactId: randomUUID(),
      name: 'deliverable',
      parts: [{ text: deliverable ?? summary }],
    })
  }
  await ws.completeTask(taskId, artifacts)
  state.currentTaskId = null
  // 完成即衔接:报告队列余量与下一项(状态同步 + 驱动继续处理)
  try {
    const q = await ws.myQueue()
    const next = q.queued[0]
    if (next) {
      return {
        text: `任务 ${taskId} 已完成(状态已同步为 COMPLETED)。你的队列还有 ${q.queued.length} 项待处理,下一项:「${next.title}」(即将自动开始;收到任务指派消息后按工作流执行,完成后同样调用 complete_task)。`,
      }
    }
    return { text: `任务 ${taskId} 已完成(状态已同步为 COMPLETED),队列为空。保持待命:新任务/实时消息会自动到达你的信箱。` }
  }
  catch {
    return { text: `任务 ${taskId} 已完成(状态已同步为 COMPLETED)。` }
  }
}
