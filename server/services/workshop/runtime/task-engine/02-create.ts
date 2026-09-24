/**
 * TaskEngineLayer02 —— 创建与派发
 * (分层 3/5,承 TaskEngineLayer01;方法体与原文件逐行一致)
 */
import { TaskEngineLayer01 } from './01-update'
import type { Part } from '../../types/a2a'
import type { WorkspaceTask } from '../../types/task'
import { AppError } from '../../../../utils/errors'
import { rowToTask } from './helpers'
import { assertDispatchAllowed } from './policy'

export abstract class TaskEngineLayer02 extends TaskEngineLayer01 {
  /** 创建任务(落库);若 parentId 存在且父任务 WORKING 则父转 WAITING */
  create(input: {
    channelId: string
    creatorId: string
    assigneeId: string
    title: string
    description?: string
    parentId?: string
    parts?: Part[]
    sourceChatMessageId?: string
    sourceChatDeliveryId?: string
    closeReason?: string
    deadlineAt?: string
  }): WorkspaceTask {
    const row = this.repos.tasks.create({
      channelId: input.channelId,
      parentId: input.parentId ?? null,
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

  /** 主理人分解:创建子任务(ASSIGNED)+ 向 assignee 投递 assign 消息 + 父任务转 WAITING */
  dispatch(
    parent: WorkspaceTask,
    input: { assigneeId: string, title: string, description?: string, parts?: Part[], routeReason?: string },
  ): WorkspaceTask {
    // TaskEngine 是所有派发入口的最终预算闸门；Manager/host tool 的提示不能替代它。
    assertDispatchAllowed(this.repos.tasks, parent)
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
