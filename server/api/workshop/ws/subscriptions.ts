/**
 * 频道总线订阅绑定 / HITL 待办订阅
 * (由 server/api/workshop/ws.ts 按职责拆出;内容逐行原文搬运)
 */
import type { AgentChannelManager } from '../../../services/workshop/runtime/manager'
import type { ChannelStream } from './shared'
import { hitlAudience } from './audience'
import { internalsOf } from './hub'
import { mapAgentEvent } from './event-mapping'
import { publish, rootQueueViewOf } from './publish'
import { publishToUser } from '../../../services/workshop/runtime/user-notification-hub'
import { subscribeHitlEvents } from '../../../services/workshop/agents/hitl-registry'

export function bindStreamSubscriptions(manager: AgentChannelManager, stream: ChannelStream): void {
  const channelId = stream.channelId
  // 任务事件:状态迁移(assignee + 标题/父级/进度/交付数正文随事件直推——
  // 客户端事件即实体,免 REST 补全;协议字段见 shared/workshop-protocol)。
  // 任务全量视图由事件源头携带(TaskEngine → bus → 此处),仅旧事件缺 task 时回查兜底。
  stream.unsubs.push(manager.subscribeTaskEvents(channelId, (e) => {
    if (e.state !== undefined) {
      const task = e.task ?? internalsOf(manager).getTaskEngine().get(e.taskId)
      const assigneeId = task?.assigneeId
      publish(manager, stream, 'task.status', {
        taskId: e.taskId,
        state: e.state,
        assigneeId,
        agentId: e.agentId,
        title: task?.title,
        parentId: task?.parentId,
        rootQueueSeq: task?.rootQueueSeq,
        progress: task?.progress,
        routeReason: task?.routeReason,
        closeReason: task?.closeReason,
        deadlineAt: task?.deadlineAt,
        retryCount: task?.retryCount,
        createdAt: task?.createdAt,
        artifacts: task?.artifacts?.length,
      }, { taskId: e.taskId, agentId: e.agentId ?? assigneeId })
    }
    if (e.progress !== undefined) {
      publish(manager, stream, 'task.progress', { taskId: e.taskId, progress: e.progress, agentId: e.agentId }, { taskId: e.taskId })
    }
    // §3.4-3 广播 root queue 变化:root 进入/离开队列(含终态晋升下一 root)必须
    // 让前端拿到权威排队视图,而不是自己按数组顺序猜 active root。
    if (e.state !== undefined) {
      const engine = internalsOf(manager).getTaskEngine()
      const task = engine.get(e.taskId)
      const isRootEvent = task ? !task.parentId : false
      const terminal = e.state === 'COMPLETED' || e.state === 'FAILED' || e.state === 'CANCELED'
      if (isRootEvent || terminal) {
        publish(manager, stream, 'root.queue', rootQueueViewOf(engine.rootQueue(channelId)))
      }
    }
  }))
  // 成员状态(idle/busy/stopped + 队列上下文):总线载荷为 queuedCount/completedCount,
  // 归一化为 AEP 协议字段 queued/completed(与 channel.snapshot agents 同构,客户端单键消费)
  stream.unsubs.push(manager.subscribeAgentStatus(channelId, e => publish(manager, stream, 'agent.status', {
    agentId: e.agentId,
    state: e.state,
    currentTaskId: e.currentTaskId ?? null,
    currentTaskTitle: e.currentTaskTitle ?? null,
    currentTaskProgress: e.currentTaskProgress ?? null,
    queued: e.queuedCount ?? 0,
    completed: e.completedCount ?? 0,
    context: e.context ?? null,
    supervision: e.supervision ?? null,
    continuity: e.continuity ?? null,
  }, { agentId: e.agentId })))
  // harness 事件流(message/artifact/status.message/error)
  stream.unsubs.push(manager.subscribeChannelEvents(channelId, (event, source) => mapAgentEvent(manager, stream, event, source)))
  // 消息投递(route 汇流点)。信封 agentId = 时间线归属 = 发送方(from-agent);
  // 人类消息(仅 x-aw-from-label)agentId 留空 —— 前端据 from-label 渲染"用户章",
  // 不再把人类消息错误归属到收件 Agent(收件方信息在 payload.metadata 的 target 字段)。
  stream.unsubs.push(manager.subscribeChannelMessages(channelId, (message) => {
    const agentId = (message.metadata?.['x-aw-from-agent'] as string | undefined) ?? undefined
    publish(manager, stream, 'a2a.message', message, { agentId, taskId: message.taskId ?? undefined })
  }))
  // 记忆写入
  stream.unsubs.push(manager.subscribeMemoryEvents(channelId, e => publish(manager, stream, 'memory.saved', e, { agentId: e.agentId })))
  // 团队成员增/改/删(lead 自主管理或用户 REST;agent.member)
  stream.unsubs.push(manager.subscribeMemberEvents(channelId, (e) => {
    publish(manager, stream, 'agent.member', e, { agentId: e.agentId })
  }))
  // v17 群聊事件(chat.message / chat.delivery.status / chat.member / chat.settings)。
  // 走 channel 流:publish 计入 seq/环形缓冲/落库 → channel 历史与 WS 重连复用既有机制。
  stream.unsubs.push(manager.subscribeChatEvents(channelId, (e) => {
    const agentId = (e.payload as { senderType?: string, senderId?: string } | null)?.senderType === 'agent'
      ? (e.payload as { senderId?: string }).senderId
      : undefined
    publish(manager, stream, e.type, e.payload, { agentId })
  }))
}

/** HITL 待办事件挂接(建流时一次;closeStream 回收;与总线 rebind 解耦,见 ChannelStream.hitlUnsub)。
 *
 *  v17 修正(P0 §13.2 —— 关闭审批旁路):
 *  原实现经 `broadcastPeerEvent` 把 hitl.request/hitl.resolved 无条件推给**全部**在线 peer
 *  (seq=0/channelId=''),配合前端"来者不拒"的 store,导致 A 的待办出现在 B 的徽标上 ——
 *  既是通知泄漏,也让无权用户看到审批详情。
 *
 *  现在双水路:
 *   ① 频道流 publish —— 订阅了该频道且通过成员鉴权的 peer 才收得到(seq/缓冲/落库/回放);
 *   ② 用户定向 hub —— 仅推给「该 Channel 的 active 成员 ∪ owner ∪ admin」,
 *      经 user-notification-hub 的 peer→userId 绑定做 recipient 隔离。
 *  **不再**调用 broadcastPeerEvent。 */
export function bindHitlSubscription(manager: AgentChannelManager, stream: ChannelStream): void {
  stream.hitlUnsub?.()
  stream.hitlUnsub = subscribeHitlEvents(stream.channelId, (e) => {
    // ① 频道流(seq/环形缓冲/落库/回放)—— 这是**审计与回放**轨迹,不是可操作通道。
    //    审批动作本身另受两道闸门约束:REST pending 快照按可裁决性过滤、
    //    respond 走决策服务(requireCanApprove + claimPending),所以频道成员"看得到轨迹"
    //    不等于"能审批"。此处不下发敏感字段(载荷即 AepHitlItem 协议面,不含凭据)。
    publish(manager, stream, e.type, e.payload, { agentId: e.agentId })
    // ② 定向通知(用户级 hub):**按审批资格**扇出,而不是按频道成员资格 ——
    //    owner_only 频道里普通成员不该收到"需要你处理"的定向提示。
    for (const userId of hitlAudience(manager, stream.channelId)) {
      publishToUser(userId, e.type, e.payload, { eventId: `${e.type}:${(e.payload as { kind?: string, id?: string }).kind}:${(e.payload as { id?: string }).id}` })
    }
  })
}

/**
 * 某个 Channel 的 HITL **定向通知**受众集。
 *
 * 口径:
 *  - `owner_only` → owner + admin(普通成员**不**收到定向 HITL 提示);
 *  - `any_member` → owner ∪ active 成员 ∪ admin。
 * 读取**当前** Channel 策略;策略收紧后自动收窄(收紧即时生效)。
 *
 * 与 `manager.requireCanApprove` 的关系(不要误读为等价):本方法决定"谁收到提示",
 * 决策服务决定"谁能裁决"。单条历史请求的"创建时资格 ∩ 当前资格"由持久化策略快照判定,
 * 因此**收到提示不等于能裁决**(决策服务仍会 403);反之 admin 在本方法里恒可见,
 * 与其在决策服务里的全局裁决权一致。
 *
 * 注意:频道流(hitl.request 的 AEP 帧)对**所有**已鉴权订阅者可见 —— 那是审计/回放轨迹,
 * 可操作性由 REST pending 快照(按可裁决性过滤)与决策服务把关。详见 P0 审计报告 §3。
 */
