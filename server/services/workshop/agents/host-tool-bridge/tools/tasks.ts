/**
 * 任务面(submit_task / dispatch_task / refuse_task / list_channel_tasks / get_my_task_queue /
 * reassign_task / update_task / cancel_task / get_task_details)
 * ——原 dispatchHostTool 对应 case 的函数体按行搬运,闭包捕获的变量改为显式参数。
 */
import type { AgentWorkspace } from '../../agent-interface'
import type { WorkspaceTask } from '../../../types/task'
import { extractTaskMode } from '../../../runtime/execution-mode'
import type { HostToolBridgeContext, HostToolResult, HostToolSessionState } from '../types'

export async function handleSubmitTask(args: Record<string, unknown>, state: HostToolSessionState, ws: AgentWorkspace): Promise<HostToolResult> {
  const title = String(args.title ?? '').trim()
  const description = args.description as string | undefined
  if (!title) return { text: 'submit_task 需要非空 title', isError: true }
  const task = await ws.submitTask({
    title,
    description,
    sourceChatMessageId: state.sourceChatMessageId ?? undefined,
    sourceChatDeliveryId: state.sourceChatDeliveryId ?? undefined,
  })
  return {
    text: `根任务 ${task.id} 已登记(assignee=你,state=${task.state})。若需要专业分工:对每个子任务调用 dispatch_task(parent_task_id=${task.id}, assignee_id=..., title=..., description=含目标/上下文/交付格式/验收标准/边界);若你自己就能回答,直接 complete_task(task_id=${task.id}, summary=..., deliverable=...) 并把结论回给提问者。`,
  }
}

export async function handleDispatchTask(args: Record<string, unknown>, ws: AgentWorkspace): Promise<HostToolResult> {
  const assigneeId = args.assignee_id as string
  const title = args.title as string
  const description = args.description as string | undefined
  const parentTaskId = args.parent_task_id as string | undefined
  const routeReason = args.route_reason as string | undefined
  // 重复派发守卫(真实场景实测:lead 模型可能对同一目标重复派发,引发协调风暴):
  // 同父任务下已存在同标题非终态子任务 → 不再创建,直接指路既有任务
  const dup = await ws.listTasks()
  const existing = dup.find(t =>
    t.parentId === parentTaskId
    && t.title === title
    && t.state !== 'COMPLETED' && t.state !== 'FAILED' && t.state !== 'CANCELED')
  if (existing) {
    return {
      text: `未创建:同父任务下已存在同标题进行中子任务 ${existing.id}("${existing.title}",state=${existing.state},assignee=${existing.assigneeId})。请勿重复派发;若需跟进请对该任务 notify 或 reassign。`,
    }
  }
  const task = await ws.dispatchTask({ assigneeId, title, description, parentTaskId, routeReason })
  return { text: `子任务 ${task.id} 已创建并指派 → ${assigneeId}(父任务 ${parentTaskId ?? '无'},标题: ${title}${routeReason ? `,路由理由: ${routeReason}` : ''})` }
}

export async function handleRefuseTask(args: Record<string, unknown>, ws: AgentWorkspace): Promise<HostToolResult> {
  const taskId = args.task_id as string
  const reason = args.reason as string
  if (!taskId || !reason) return { text: '缺少 task_id 或 reason', isError: true }
  const r = await ws.refuseTask(taskId, reason)
  const notified = r.notifiedTo ? `拒绝回执已送达 ${r.notifiedTo.slice(0, 8)}` : '无回执对象(创建者已不在 channel)'
  return {
    text: `任务 ${taskId.slice(0, 8)}("${r.task.title}") 已拒绝(state=${r.task.state});${notified}。调度器将改派他人,请勿再处理该任务。`,
  }
}

export async function handleListChannelTasks(ws: AgentWorkspace): Promise<HostToolResult> {
  const tasks = await ws.listTasks()
  const text = tasks.map(t =>
    `  ${t.id} [${t.state}] "${t.title}" assignee=${t.assigneeId} progress=${t.progress}%`,
  ).join('\n')
  return { text: `Channel 任务(${tasks.length}):\n${text || '(空)'}` }
}

export async function handleGetMyTaskQueue(identity: HostToolBridgeContext['identity'], ws: AgentWorkspace): Promise<HostToolResult> {
  const queue = await ws.myQueue()
  const fmt = (t: WorkspaceTask): string =>
    `  ${t.id} [${t.state}] "${t.title}" progress=${t.progress}%`
  return {
    text: [
      `我的任务队列(${identity.role}):`,
      `执行中: ${queue.current ? `${queue.current.id} "${queue.current.title}" (${queue.current.progress}%)` : '(无)'}`,
      `待执行(${queue.queued.length},FIFO):`,
      ...queue.queued.map(fmt),
      `已完成(${queue.completed.length}):`,
      ...queue.completed.map(fmt),
    ].join('\n'),
  }
}

export async function handleReassignTask(args: Record<string, unknown>, ws: AgentWorkspace): Promise<HostToolResult> {
  const taskId = args.task_id as string
  const toAgentId = args.to_agent_id as string
  const task = await ws.reassignTask(taskId, toAgentId)
  return { text: `任务 ${taskId}("${task.title}")已调配 → ${toAgentId}(state=${task.state})` }
}

export async function handleUpdateTask(args: Record<string, unknown>, ws: AgentWorkspace): Promise<HostToolResult> {
  const taskId = args.task_id as string
  const title = args.title as string | undefined
  const description = args.description as string | undefined
  const task = await ws.updateTask(taskId, { title, description })
  return { text: `任务 ${taskId} 已更新: "${task.title}"` }
}

export async function handleCancelTask(args: Record<string, unknown>, ws: AgentWorkspace): Promise<HostToolResult> {
  const taskId = args.task_id as string
  // 守卫:goal/loop/pipeline 的 mode 父任务是用户的作业主任务,Agent 不得经工具取消
  const target = await ws.getTask(taskId).catch(() => null)
  if (target && extractTaskMode(target)) {
    return {
      text: `拒绝:任务 ${taskId} 是 mode 父任务(${target.title}),不能用 cancel_task 取消。若目标未达成 → dispatch_task 派发子任务补齐差距;若确认无法达成 → complete_task 并在交付中说明未达成原因。终止整个作业请由用户操作。`,
    }
  }
  await ws.cancelTask(taskId)
  return { text: `任务 ${taskId} 已取消并移出 assignee 队列` }
}

export async function handleGetTaskDetails(args: Record<string, unknown>, ws: AgentWorkspace): Promise<HostToolResult> {
  const taskId = args.task_id as string
  const task: WorkspaceTask = await ws.getTask(taskId)
  const artifactText = task.artifacts.map(a =>
    `  artifact ${a.artifactId}: ${a.parts.map(p => 'text' in p ? p.text.slice(0, 100) : '').join('; ')}`,
  ).join('\n')
  return {
    text: `任务 ${task.id}\n  状态: ${task.state}\n  标题: ${task.title}\n  描述: ${task.description ?? '-'}\n  指派: ${task.assigneeId}\n  进度: ${task.progress}%\n  成果:\n${artifactText || '  (无)'}`,
  }
}
