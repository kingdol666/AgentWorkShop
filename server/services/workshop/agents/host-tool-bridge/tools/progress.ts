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
  activeRootTaskId?: string,
): Promise<HostToolResult> {
  const message = args.message as string | undefined
  // 2026-10-30 修复:progress 来自异构 LLM(七引擎),字符串化数字/越界值是高频形态;
  // 原样落库会污染看门狗与前端进度显示。钳到 [0,100],非数字显式拒绝。
  const rawProgress = Number(args.progress)
  if (!Number.isFinite(rawProgress)) return { text: 'progress 必须是数字(0-100)', isError: true }
  const progress = Math.max(0, Math.min(100, rawProgress))
  // 2026-10-30 修复:lead 监督回合不经过 workerTurn,session.currentTaskId 恒空;
  // 分发层已验证的 activeRootTaskId(lease.rootId)是唯一可靠上下文,作为兜底回退。
  const taskId = state.currentTaskId ?? activeRootTaskId
  if (!taskId) return { text: '无当前任务上下文', isError: true }
  // 2026-10-30 修复(fail-open):终态任务上 manager 有意丢弃进度写入(活性信号不得写
  // 终态),但旧实现照样回报「进度已上报」—— 迟到回合的 Agent 误信进度已同步,继续在
  // 僵尸任务上作业烧 token。与 complete_task 同口径给诚实回执,推动转向队列下一项。
  const current = await ws.getTask(taskId).catch(() => null)
  if (current && current.state !== 'SUBMITTED' && current.state !== 'ASSIGNED' && current.state !== 'WORKING' && current.state !== 'WAITING') {
    return {
      text: `任务 ${taskId} 已终态(${current.state}),进度写入被忽略 —— 该任务已由平台收口,这不是你的错误,请停止在该任务上作业,转向队列下一项。`,
      isError: true,
    }
  }
  await ws.reportTask({ taskId, progress, message })
  return { text: `进度已上报: ${progress}%${message ? ` (${message})` : ''}` }
}

export async function handleCompleteTask(
  args: Record<string, unknown>,
  state: HostToolSessionState,
  ws: AgentWorkspace,
  activeRootTaskId?: string,
): Promise<HostToolResult> {
  const summary = args.summary as string
  const deliverable = args.deliverable as string | undefined
  // 2026-10-30 修复:lead 收口链 —— 显式 task_id > 会话态 > 监督租约根任务。
  // 此前 lead 无 task_id 时恒报「无任务 ID」,根任务只能被看门狗取消收口(三次实机复现)。
  const taskId = (args.task_id as string | undefined) ?? state.currentTaskId ?? activeRootTaskId
  if (!taskId) return { text: '无任务 ID', isError: true }
  // 父任务保护:有未收口子任务时拒绝完成(lead 须等 worker 交付;失败/取消分支用 supersede 处置)
  const allTasks = await ws.listTasks()
  const incompleteChildren = allTasks.filter(t => t.parentId === taskId && t.state !== 'COMPLETED' && !t.supersededByTaskId)
  if (incompleteChildren.length > 0) {
    const unresolved = incompleteChildren.filter(t => t.state === 'FAILED' || t.state === 'CANCELED')
    const hint = unresolved.length > 0
      ? '失败/取消分支请先派发替代任务并用 supersede 工具(或 REST POST /tasks/:id/supersede)显式处置'
      : '等待子任务交付后再收口'
    return {
      text: `任务 ${taskId} 有 ${incompleteChildren.length} 个未收口的子任务: ${incompleteChildren.map(t => `「${t.title}」(${t.state})`).join(', ')}。${hint}，再由 Lead 检查交付物并提交验收总结。`,
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

/** (lead)显式替代:把 FAILED/CANCELED 子任务分支标记为被替代任务覆盖(整改计划 2026-10-30 F1) */
export async function handleSupersedeTask(
  args: Record<string, unknown>,
  _state: HostToolSessionState,
  ws: AgentWorkspace,
): Promise<HostToolResult> {
  const taskId = (args.task_id as string | undefined) ?? (args.taskId as string | undefined)
  const replacementTaskId = (args.replacement_task_id as string | undefined) ?? (args.replacementTaskId as string | undefined)
  const reason = args.reason as string | undefined
  if (!taskId || !replacementTaskId) {
    return { text: '参数缺失:需要 task_id(失败/取消的分支任务)与 replacement_task_id(覆盖其工作的替代任务)', isError: true }
  }
  const superseded = await ws.supersedeTask(taskId, replacementTaskId, reason)
  return {
    text: `分支「${superseded.title}」(${superseded.state})已标记为被 ${replacementTaskId.slice(0, 8)} 替代,不再阻塞父任务收口。失败事实保留在任务记录中;现在可对父任务检查交付并 complete_task。`,
  }
}
