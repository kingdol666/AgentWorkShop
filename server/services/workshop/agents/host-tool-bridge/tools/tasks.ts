/**
 * 任务面(submit_task / dispatch_task / refuse_task / list_channel_tasks / get_my_task_queue /
 * reassign_task / update_task / cancel_task / get_task_details)
 * ——原 dispatchHostTool 对应 case 的函数体按行搬运,闭包捕获的变量改为显式参数。
 */
import type { AgentWorkspace } from '../../agent-interface'
import type { WorkspaceTask } from '../../../types/task'
import { TERMINAL_TASK_STATES } from '../../../types/task'
import { extractTaskMode } from '../../../runtime/execution-mode'
import type { HostToolBridgeContext, HostToolResult, HostToolSessionState } from '../types'

export async function handleSubmitTask(args: Record<string, unknown>, state: HostToolSessionState, ws: AgentWorkspace): Promise<HostToolResult> {
  const title = String(args.title ?? '').trim()
  const description = args.description as string | undefined
  if (!title) return { text: 'submit_task 需要非空 title', isError: true }
  // budget_minutes:长工业链路显式预算(分钟;如 8 步巡检链在 15min 默认预算下会被处决)
  const budgetRaw = Number(args.budget_minutes)
  const budgetMinutes = Number.isFinite(budgetRaw) && budgetRaw > 0 ? Math.round(budgetRaw) : undefined
  const task = await ws.submitTask({
    title,
    description,
    budgetMinutes,
    sourceChatMessageId: state.sourceChatMessageId ?? undefined,
    sourceChatDeliveryId: state.sourceChatDeliveryId ?? undefined,
  })
  return {
    text: `根任务 ${task.id} 已登记(assignee=你,state=${task.state}${budgetMinutes ? `,预算=${budgetMinutes}min` : ''})。若需要专业分工:对每个子任务调用 dispatch_task(parent_task_id=${task.id}, assignee_id=..., title=..., description=含目标/上下文/交付格式/验收标准/边界);若你自己就能回答,直接 complete_task(task_id=${task.id}, summary=..., deliverable=...) 并把结论回给提问者。`,
  }
}

export async function handleDispatchTask(args: Record<string, unknown>, ws: AgentWorkspace, identity?: HostToolBridgeContext['identity'], activeRootTaskId?: string): Promise<HostToolResult> {
  const assigneeId = args.assignee_id as string
  const title = args.title as string
  const description = args.description as string | undefined
  const rawParentTaskId = args.parent_task_id
  if (rawParentTaskId != null && typeof rawParentTaskId !== 'string') {
    return { text: 'parent_task_id 必须是字符串', isError: true }
  }
  const requestedParentTaskId = typeof rawParentTaskId === 'string' ? rawParentTaskId.trim() || undefined : undefined
  let parentTaskId = requestedParentTaskId
  const routeReason = args.route_reason as string | undefined
  if (activeRootTaskId) {
    if (identity?.role !== 'lead') {
      return { text: '拒绝:当前调用没有 lead 监督任务上下文，不能按活动根任务派发。', isError: true }
    }
    if (requestedParentTaskId && requestedParentTaskId !== activeRootTaskId) {
      return { text: `拒绝:parent_task_id 必须匹配当前活动根任务 ${activeRootTaskId}。`, isError: true }
    }
    const rootTask = await ws.getTask(activeRootTaskId).catch(() => null)
    if (!rootTask || TERMINAL_TASK_STATES[rootTask.state] || rootTask.assigneeId !== identity.agentId) {
      return { text: '拒绝:活动根任务不存在、已结束或不属于当前 lead。', isError: true }
    }
    parentTaskId = activeRootTaskId
  }
  // 重复派发守卫(真实场景实测:lead 模型可能对同一目标重复派发,引发协调风暴):
  // 同父任务下已存在同标题非终态子任务 → 不再创建,直接指路既有任务。
  // 2026-10-30 前移到授权之前:原顺序先落库 grant_node_ids 再判重,判重命中时授权
  // (grant_mode=auto 还会摘除逐次人工审批)已生效却无任务上下文 —— 悬空授权面,
  // 且 lead 每次重复派发尝试都会重放授权,把偶发幻觉放大成常态越权面。
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
  // 派发时随任务授予节点权限(lead 专属;grant_node_ids ⊆ lead 自身绑定面,fail-closed):
  // 任一节点不满足则整单拒绝,任务不创建 —— 避免 worker 拿到任务却没有节点权限的半途态。
  let grantNote = ''
  let grantedNodeIds: string[] = []
  const rawGrant = args.grant_node_ids ?? args.grantNodeIds
  if (rawGrant != null && identity) {
    const { grantNodesForDispatch } = await import('./team-delegation')
    const grantNodeIds = (Array.isArray(rawGrant) ? rawGrant : String(rawGrant).split(',')).map(x => String(x ?? '').trim()).filter(Boolean)
    if (!grantNodeIds.length) return { text: 'grant_node_ids 为空:要么不传,要么给出至少一个节点 id。', isError: true }
    const grantMode = args.grant_mode === 'manual' || args.grant_mode === 'auto' ? (args.grant_mode as 'auto' | 'manual') : undefined
    const grant = await grantNodesForDispatch(identity, assigneeId, grantNodeIds, grantMode, ws, args.grant_confirm)
    if (!grant.ok) return { text: `未派发:${grant.text}\n请先用 team_grant_nodes 确认你持有这些节点,或修正 node id 后重试。`, isError: true }
    grantedNodeIds = grantNodeIds
    grantNote = `\n${grant.text}`
  }
  try {
    const task = await ws.dispatchTask({ assigneeId, title, description, parentTaskId, routeReason })
    return { text: `子任务 ${task.id} 已创建并指派 → ${assigneeId}(父任务 ${parentTaskId ?? '无'},标题: ${title}${routeReason ? `,路由理由: ${routeReason}` : ''})${grantNote}` }
  }
  catch (err) {
    // 2026-10-30 修复(授权-任务绑定不变量):manager 侧判重 409/父任务终态/harness
    // 不可用/预算超限等拒绝发生在授权落库之后 —— 任务没创建,节点授权已生效。
    // 失败即回滚本轮授权再如实回报,杜绝「派发失败留下无任务授权」。
    if (grantedNodeIds.length && identity) {
      const { revokeNodesForDispatchRollback } = await import('./team-delegation')
      const revoked = await revokeNodesForDispatchRollback(identity, assigneeId, grantedNodeIds, ws)
      grantNote = revoked > 0 ? `\n(派发失败,已回滚本轮 ${revoked} 条随单授权)` : '\n(派发失败;随单授权回滚未完成,请用 team_revoke_nodes 手工核销)'
    }
    const msg = err instanceof Error ? err.message : String(err)
    return { text: `未派发:${msg}${grantNote}`, isError: true }
  }
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
