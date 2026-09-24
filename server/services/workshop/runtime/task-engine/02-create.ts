/**
 * TaskEngineLayer02 —— 创建与派发
 * (分层 3/5,承 TaskEngineLayer01;方法体与原文件逐行一致)
 */
import { TaskEngineLayer01 } from './01-update'
import type { Part } from '../../types/a2a'
import type { WorkspaceTask } from '../../types/task'
import { AppError } from '../../../../utils/errors'
import { rowToTask } from './helpers'
import { assertDispatchAllowed, rootLineage } from './policy'
import { issueLeaseFields } from './lease'
import { rootQueueEnabled } from '../../settings'

export abstract class TaskEngineLayer02 extends TaskEngineLayer01 {
  /** 创建任务(落库);若 parentId 存在且父任务 WORKING 则父转 WAITING */
  create(input: {
    channelId: string
    creatorId: string
    assigneeId: string
    title: string
    description?: string
    parentId?: string
    rootQueueSeq?: number | null
    parts?: Part[]
    sourceChatMessageId?: string
    sourceChatDeliveryId?: string
    closeReason?: string
    deadlineAt?: string
  }): WorkspaceTask {
    const row = this.repos.tasks.create({
      channelId: input.channelId,
      parentId: input.parentId ?? null,
      rootQueueSeq: input.parentId ? null : input.rootQueueSeq,
      assigneeId: input.assigneeId,
      creatorId: input.creatorId,
      title: input.title,
      description: input.description ?? null,
      state: 'SUBMITTED',
      artifacts: this.initialArtifacts(input.parts),
      history: [],
      sourceChatMessageId: input.sourceChatMessageId ?? null,
      sourceChatDeliveryId: input.sourceChatDeliveryId ?? null,
      closeReason: input.closeReason ?? '',
      deadlineAt: input.deadlineAt ?? null,
      // §5.1 每次新分配产生新代次 + 新租约(创建即首个 assignment)
      ...issueLeaseFields(0, input.assigneeId),
    })
    if (input.parentId) {
      const parent = this.repos.tasks.findById(input.parentId)
      if (parent && parent.state === 'WORKING') {
        this.transition(parent.id, 'WAITING', input.creatorId)
      }
    }
    const created = rowToTask(row)
    this.hooks?.onTaskChange?.({ taskId: created.id, channelId: created.channelId, state: 'SUBMITTED', agentId: input.assigneeId, task: created })
    return created
  }

  /** 来源消息幂等的根任务入口；同 source 永远返回 canonical root。 */
  createOrGetRoot(input: {
    channelId: string
    creatorId: string
    assigneeId: string
    title: string
    description?: string
    parts?: Part[]
    sourceChatMessageId: string
    sourceChatDeliveryId?: string
    deadlineAt?: string
  }): { task: WorkspaceTask, created: boolean } {
    const result = this.repos.tasks.createOrGetRoot({
      channelId: input.channelId,
      creatorId: input.creatorId,
      assigneeId: input.assigneeId,
      title: input.title,
      description: input.description,
      artifacts: this.initialArtifacts(input.parts),
      sourceChatMessageId: input.sourceChatMessageId,
      sourceChatDeliveryId: input.sourceChatDeliveryId,
      deadlineAt: input.deadlineAt,
      ...issueLeaseFields(0, input.assigneeId),
    })
    const task = rowToTask(result.row)
    if (result.created) {
      this.hooks?.onTaskChange?.({ taskId: task.id, channelId: task.channelId, state: 'SUBMITTED', agentId: input.assigneeId, task })
    }
    return { task, created: result.created }
  }

  /** 主理人分解:创建子任务(ASSIGNED)+ 向 assignee 投递 assign 消息 + 父任务转 WAITING */
  dispatch(
    parent: WorkspaceTask,
    input: { assigneeId: string, title: string, description?: string, parts?: Part[], routeReason?: string },
  ): WorkspaceTask {
    // TaskEngine 是所有派发入口的最终预算闸门；Manager/host tool 的提示不能替代它。
    assertDispatchAllowed(this.repos.tasks, parent)
    // 根任务 FIFO：只有当前 active root 可以继续拆解；后续 roots 先排队。
    // §11 回滚开关 root_queue_enabled=false 时退回多根并发(不改变 source 幂等与预算)。
    const activeRoot = rootQueueEnabled() ? this.activeRootOf(parent.channelId) : null
    const lineage = rootLineage(this.repos.tasks, parent)
    if (activeRoot && lineage.root?.rootQueueSeq != null && lineage.root.id !== activeRoot.id) {
      throw new AppError(409, 'ROOT_QUEUED', `根任务 ${lineage.root.id.slice(0, 8)} 尚未轮到执行；当前 active root=${activeRoot.id.slice(0, 8)}`)
    }
    // 判重下沉(单一入口守卫:REST / LLM 工具 / 调度器直通统一遵守):
    // 同父同标题在途子任务 → 409,快照滞后引发的重复派发在此收口(省 token 不重跑)。
    // 子任务直查(listChildrenMeta;idx_tasks_parent 支撑),免全 channel 扫描。
    const norm = (t: string): string => t.replace(/\s+/g, ' ').trim().toLowerCase()
    const siblingRow = this.repos.tasks.listChildrenMeta(parent.channelId, parent.id)
      .find(r => norm(r.title) === norm(input.title)
        && r.state !== 'COMPLETED' && r.state !== 'CANCELED' && r.state !== 'FAILED')
    if (siblingRow) {
      throw new AppError(409, 'DUPLICATE_DISPATCH', `子任务 "${input.title}" 已在执行中(状态 ${siblingRow.state},指派 ${siblingRow.assigneeId?.slice(0, 8) ?? '?'}),不要重复派发`)
    }
    const child = this.repos.tasks.create({
      channelId: parent.channelId,
      parentId: parent.id,
      assigneeId: input.assigneeId,
      creatorId: parent.assigneeId,
      title: input.title,
      description: input.description ?? null,
      state: 'ASSIGNED',
      artifacts: this.initialArtifacts(input.parts),
      history: [],
      routeReason: input.routeReason ?? '',
      ...issueLeaseFields(0, input.assigneeId),
    })
    this.deliverTaskMessage({
      channelId: parent.channelId,
      taskId: child.id,
      fromAgentId: parent.assigneeId,
      toAgentId: input.assigneeId,
      title: input.title,
      description: input.description,
      kind: 'assign',
    })
    // 父任务若非 WAITING 则转 WAITING(等待子任务)
    const freshParent = this.repos.tasks.findById(parent.id)
    if (freshParent && freshParent.state !== 'WAITING') {
      this.transition(parent.id, 'WAITING', parent.assigneeId)
    }
    const created = rowToTask(child)
    this.hooks?.onTaskChange?.({ taskId: created.id, channelId: created.channelId, state: 'ASSIGNED', agentId: input.assigneeId, task: created })
    return created
  }
}
