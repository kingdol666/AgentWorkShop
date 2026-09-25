/**
 * ManagerState —— 运行时状态 / 依赖注入 / TaskEngine / 编年史 / 空闲反思
 *
 *
 * 原 AgentChannelManager 是单文件 god class(4600 行);这里按职责切成多层,
 * 方法体逐行原文搬运(仅 private → protected),跨层调用由 contracts 抽象契约承载。
 * 对外仍是同一个 AgentChannelManager 实例与同一套公开方法。
 */
import { ManagerContracts } from './contracts'
import type { A2AArtifact } from '../../types/a2a'
import type { ChannelBus, TaskEngine, TaskEventTask, AgentRuntime } from '../agent-runtime'
import type { ManagerDeps } from './types'
import type { TaskState } from '../../types/task'
import type { WorkshopPermissionScope } from '../../../../../shared/workshop-protocol'
import { AgentMemory, runMemoryMaintenance, unsegmentCJK } from '../memory'
import { ChannelRuntime } from '../channel-runtime'
import type { ScheduleRuntime } from '../schedule-runtime'
import { TEAM_AGENT_ID } from '../../db/memory.repo'
import { TERMINAL_TASK_STATES } from '../../types/task'
import { TaskEngine as TaskEngineImpl } from '../task-engine'
import { createEnvEmbeddingProvider } from '../embedding-provider'
import { log } from './helpers'
import { memorySettings, retentionSettings, channelMemoryDigestEnabled } from '../../settings'
import { parseJson } from '../../db/database'

/** §7.1 事件名 → 展示标签(tasks 状态机 → 设计文档事件契约) */
const EVENT_LABELS: Record<string, string> = {
  'root.created': '根任务创建',
  'root.queued': '根任务进入队列',
  'root.activated': '根任务激活执行',
  'child.dispatched': '子任务已派发',
  'child.assigned': '子任务已指派',
  'child.started': '子任务开始执行',
  'child.progress': '进度里程碑',
  'child.artifact': '交付物产出',
  'root.artifact': '交付物产出',
  'child.completed': '子任务完成',
  'child.failed': '子任务失败',
  'lead.wait': 'Lead 显式等待',
  'lead.guide': 'Lead 指引',
  'lead.reassign': '改派执行者',
  'lead.cancel': 'Lead 取消任务',
  'supervise.watchdog': '监督 watchdog',
  'harness.restarted': 'Harness 重建',
  'root.completed': '根任务完成',
  'root.failed': '根任务失败',
  'root.canceled': '根任务取消',
}

/** Lead 决策类型 → §7.1 事件名(仅这四类进记忆) */
const LEAD_DECISION_EVENTS: Record<string, string> = {
  wait: 'lead.wait',
  guide: 'lead.guide',
  reassign: 'lead.reassign',
  cancel: 'lead.cancel',
}
const LEAD_DECISION_LABELS: Record<string, string> = {
  wait: 'Lead 显式等待',
  guide: 'Lead 指引',
  reassign: 'Lead 改派',
  cancel: 'Lead 取消',
}

/** §7.3 ④ 记忆 outbox 最大尝试次数(超过转 failed 死信,不再每周期重放毒事件) */
const MEMORY_OUTBOX_MAX_ATTEMPTS = 5
/** §7.2 节流表容量上限(超出按 task 前缀裁剪;长跑进程内存有界) */
const TEAM_MEMORY_CHECKPOINT_CAP = 500
/** §7.3 outbox 补偿扫描周期(独立于记忆维护的 6h 周期) */
const OUTBOX_COMPENSATION_MS = 30_000

export abstract class ManagerState extends ManagerContracts {
  protected channels = new Map<string, ChannelRuntime>()
  /** 键 = runtimeKey(channelId, 实例 id);每个实例一个独立运行时 */
  protected agentIndex = new Map<string, AgentRuntime>()
  protected buses = new Map<string, ChannelBus>()
  protected taskEngine: TaskEngine | null = null
  protected idleSweeperTimer: NodeJS.Timeout | null = null
  protected memoryTimer: NodeJS.Timeout | null = null
  /** §7.3 outbox 独立补偿定时器(短周期重试;与记忆维护 6h 周期解耦) */
  protected outboxTimer: NodeJS.Timeout | null = null
  /** 全 manager 共享的 env 向量 provider(未配置 → null 纯 FTS;熔断/维度全体实例共享) */
  protected readonly memoryEmbedder = createEnvEmbeddingProvider()
  /** 反思游标:每 agent 上次聚合的当月任务数(月度幂等增量判定) */
  protected readonly reflectCounts = new Map<string, number>()
  /** shared task digest 节流：channel/task/event bucket -> last write time */
  protected readonly teamMemoryCheckpointAt = new Map<string, number>()
  /** agent 最近一次工具 invoke 时刻(调度器停滞看门狗的活性源;工具调用即健康推进) */
  protected readonly lastToolInvokeAt = new Map<string, number>()
  /**
   * 每个 Agent 当前正在服务的**人类发起者作用域**(§13.3)。
   * 由群聊投递(deliverChatToAgent)写入,Agent 回复(platformReply)后清除。
   * 之所以用"最近一次人类调用"而不是逐次传递:mailbox 对单个 agent 是**串行**消费
   * (claim/requeue 语义),同一时刻只有一个 run 在跑,因此不存在并发歧义;
   * 而工具调用是由 harness 侧发起的往返,逐次透传需要改协议,取本表更保守(宁可收紧)。
   */
  protected readonly activeInvocationScopes = new Map<string, WorkshopPermissionScope>()
  /** v16 定时任务执行器(timer 唯一持有者;startScheduleRuntime 装配,shutdown 停止) */
  protected scheduleRuntime: ScheduleRuntime | null = null
  /**
   * 停机中/已停机标记:shutdown 会停掉全部调度循环并卸载 runtime,但懒装配
   * (channelRuntime loader / 在途定时任务 / 在飞消息)仍可能在此后重新 wireMember,
   * 挂上一个**新的** SchedulerLoop 并在 DB 关闭后继续 tick。
   * 该标记让 attachScheduler 在停机后拒绝挂载(生产无影响:停机后即进程退出)。
   */
  protected shutdownStarted = false

  /** 依赖集(repos/implFactory/db)。
   *  API 作业面(ws/agent-tools/a2a card/…)需要直接读 repo —— 原先只能靠
   *  `(manager as unknown as { deps })` 断言绕过 private。这里改成 public readonly:
   *  TS 的 private 是纯类型层(擦除后运行时无差异),readonly 保证不可重绑定,
   *  既去掉断言又保持封装语义(依赖注入本身就是本类的构造契约)。 */
  constructor(readonly deps: ManagerDeps) {
    super()
    // 记忆衰减清理定时器(失败只记日志,绝不抛出;unref 不阻进程退出;非法/非正 env 回退默认)
    this.memoryTimer = setInterval(() => {
      try {
        runMemoryMaintenance(this.deps.repos.memories)
      }
      catch (err) {
        log.error('[memory] 维护任务异常', err)
      }
      // 空闲反思(sleep-time compute):busy runtime 存在即整轮跳过,绝不与作业争抢
      try {
        this.reflectIdleMemories()
      }
      catch (err) {
        log.error('[memory] 反思任务异常', err)
      }
      // v17 群聊层有界化(outbox / 通知表都会随每次发言+HITL 增长;失败不影响主流程)
      this.runGroupChatMaintenance()
    }, memorySettings().maintenance_ms)
    this.memoryTimer.unref?.()
    // §7.3 ④ outbox 独立短周期消费:重试节奏不能被 6h 的 memory.maintenance_ms 拖住
    this.outboxTimer = setInterval(() => {
      try {
        this.runOutboxCompensation()
      }
      catch (err) {
        log.error('[memory] outbox 补偿 worker 异常', err)
      }
    }, OUTBOX_COMPENSATION_MS)
    this.outboxTimer.unref?.()
  }

  /**
   * 群聊层周期性有界化(与记忆维护同一定时器,零额外 timer):
   *  ① outbox 补偿:把滞留的 pending 行重新发布(发布阶段崩溃/漏标时的事实源收敛);
   *  ② outbox 保留:删除已 published 且超过保留期的行,防表无界增长;
   *  ③ 通知保留:删除已读且超过保留期的通知(**未读永不删**,见 repo 注释)。
   *
   * 全程只读/删自身数据,失败仅记日志 —— 维护任务绝不能影响正常收发。
   */
  protected runGroupChatMaintenance(): void {
    const now = Date.now()
    // ① outbox 补偿(§7.3 后台消费环;见 runOutboxCompensation)
    this.runOutboxCompensation()
    // ② outbox 保留期(默认与事件保留期同源:已发布行留够排障窗口后回收)
    try {
      const days = retentionSettings().events_days
      const cutoff = new Date(now - days * 86_400_000).toISOString()
      const removed = this.outboxRepo.sweepPublished(cutoff)
      if (removed > 0) log.info(`[chat] outbox 保留期清理 ${removed} 行(已发布 >${days}d)`)
      // 死信同样有界化:failed 行超过保留期后回收,避免毒事件永久占表
      const deadLettered = this.outboxRepo.sweepFailed?.(cutoff) ?? 0
      if (deadLettered > 0) log.info(`[chat] outbox 死信清理 ${deadLettered} 行(failed >${days}d)`)
    }
    catch (err) {
      log.error('[chat] outbox 保留期清理异常', err)
    }
    // ③ 通知保留期(仅已读)
    try {
      const days = retentionSettings().events_days
      const cutoff = new Date(now - days * 86_400_000).toISOString()
      const removed = this.notificationRepo.sweepRead(cutoff)
      if (removed > 0) log.info(`[chat] 已读通知保留期清理 ${removed} 行(>${days}d)`)
    }
    catch (err) {
      log.error('[chat] 通知保留期清理异常', err)
    }
  }

  // ===== 运行时装配 =====

  /**
   * outbox 补偿扫描(§7.3 后台消费环)。
   *
   * 单列出来是因为**重试节奏不能跟 retention 定时器走**:`memory.maintenance_ms`
   * 默认 6 小时,一次失败要等 6 小时才重试;本方法由独立的短周期 worker
   * (OUTBOX_COMPENSATION_MS,默认 30s)驱动,失败留痕与死信判定即时生效。
   */
  protected runOutboxCompensation(): void {
    try {
      const stalled = this.outboxRepo.listPending(200)
      for (const ev of stalled) {
        const payload = parseJson<Record<string, unknown>>(ev.payloadJson, {})
        const channelId = typeof payload.channelId === 'string' ? payload.channelId : null
        if (!channelId) continue
        if (ev.eventType === 'memory.team-task') {
          void this.processTeamTaskMemoryOutbox(ev.id, payload).catch(err => this.markMemoryOutboxFailure(ev.id, err))
        }
        else if (ev.eventType === 'chat.message' && typeof payload.chatMessageId === 'string') {
          this.publishChatMessage(channelId, payload.chatMessageId)
        }
        else if (ev.eventType === 'chat.delivery.status' && typeof payload.deliveryId === 'string') {
          this.publishChatDelivery(channelId, payload.deliveryId)
        }
      }
    }
    catch (err) {
      log.error('[chat] outbox 补偿扫描异常', err)
    }
  }

  /** outbox 状态聚合(§11 memory_outbox_pending/failed;读失败一律返回空计数,不阻断监控) */
  protected outboxCounts(): Record<string, number> {
    try {
      return this.outboxRepo.counts()
    }
    catch {
      return {}
    }
  }

  /**
   * 按需装配频道(lead 运行时 + SchedulerLoop,幂等)。实现位于装配层
   * `ManagerRuntimeWiring.ensureChannelActive`;基类只声明,调用点在任务事件钩子里。
   */
  protected abstract ensureChannelActive(channelId: string): void

  protected getTaskEngine(): TaskEngine {
    if (!this.taskEngine) {
      const factory = this.deps.taskEngineFactory ?? (r => new TaskEngineImpl(r, {
        onTaskChange: (e) => {
        // 全字段转发(含 progress):TaskEngine 内部进度变化(applyEvent 分块折算 /
        // complete 置 100)须经总线 → WS task.progress 实时同步,否则前端实体进度滞后
          this.buses.get(e.channelId)?.notifyTask({
            taskId: e.taskId,
            state: e.state,
            progress: e.progress,
            agentId: e.agentId,
            task: e.task,
            artifactName: e.artifactName,
            reassignFrom: e.reassignFrom,
            reason: e.reason,
          })
          // 事件驱动调度:任务状态变化即唤醒该频道调度循环(空闲退避即刻恢复快节奏)。
          //
          // ⚠️ 只 wake 不够:lead 运行时因空闲被清扫卸载后 `cr.scheduler` 会被置空
          // (见 runtime-wiring.attachScheduler 注释),此后新建的根任务只落库,
          // `scheduler?.wake()` 变成空操作 —— 任务永久停在 SUBMITTED,直到
          // ROOT_TIMEOUT(~18 分钟)被判 FAILED(实测复现:mock Channel 第一条根任务
          // COMPLETED,后续两条一直 SUBMITTED;omp Channel 同样如此)。
          // `reviveScheduler` 只在"lead 正在被装配"的窗口里被调用,没有别的事件会重建
          // 调度循环,所以这里补上**重新挂载**的分支:没有 scheduler 就按需装配 lead +
          // 调度循环(ensureChannelActive 幂等;频道停用/无 lead 时内部直接返回)。
          const cr = this.channels.get(e.channelId)
          if (cr?.scheduler) cr.scheduler.wake()
          else if (e.state === 'SUBMITTED' || e.state === 'ASSIGNED') ((this as unknown) as { ensureChannelActive: (channelId: string) => void }).ensureChannelActive(e.channelId)
        },
      }))
      this.taskEngine = factory({ tasks: this.deps.repos.tasks, messages: this.deps.repos.messages })
    }
    return this.taskEngine
  }

  protected ensureChannelRuntime(channelId: string): ChannelRuntime {
    let cr = this.channels.get(channelId)
    if (!cr) {
      cr = new ChannelRuntime(channelId, {
        taskEngine: this.getTaskEngine(),
        subscriptionRepo: this.deps.repos.subscriptions,
        channelAgents: this.deps.repos.channelAgents,
      // 路由成功 → 总线通知(a2a.message 帧):经 runtime 回调统一收口,
      // 调度器直呼 channelRuntime.route 的消息同样可见
      }, msg => this.buses.get(channelId)?.notifyMessage(msg))
      cr.setLoader(id => this.ensureAgentRuntime(channelId, id))
      this.channels.set(channelId, cr)
      this.buses.set(channelId, this.buildBus(cr))
      // 团队记忆沉淀(任务终态事件单点收口):team-task 共享行 + 编年史滚动重写。
      // 事件总线保证每次状态迁移恰好一次通知——worker/lead 各自私有域 harvest 之外
      // 的团队域写入不存在双写;失败仅记日志,绝不影响任务流。
      this.buses.get(channelId)!.onTaskEvent(e => this.recordTeamTaskEvent(channelId, e))
    }
    return cr
  }

  protected async processTeamTaskMemoryOutbox(eventId: string, payload: Record<string, unknown>): Promise<void> {
    const channelId = typeof payload.channelId === 'string' ? payload.channelId : ''
    const taskId = typeof payload.taskId === 'string' ? payload.taskId : ''
    const title = typeof payload.title === 'string' ? payload.title : `任务 ${taskId.slice(0, 8)}`
    const event = typeof payload.event === 'string' ? payload.event : '任务事件'
    const state = typeof payload.state === 'string' ? payload.state : 'WORKING'
    const assigneeId = typeof payload.assigneeId === 'string' ? payload.assigneeId : undefined
    const progress = typeof payload.progress === 'number' ? payload.progress : undefined
    const summary = typeof payload.summary === 'string' ? payload.summary : undefined
    const dedupKey = typeof payload.dedupKey === 'string' ? payload.dedupKey : `team-task-event:${taskId}:${event}`
    const importance = typeof payload.importance === 'number' ? payload.importance : undefined
    if (!channelId || !taskId) return
    const mem = new AgentMemory(this.deps.repos.memories, { channelId, agentId: TEAM_AGENT_ID, embedder: this.memoryEmbedder ?? undefined })
    await mem.appendTeamTaskProgress({
      taskId,
      title,
      event,
      state,
      assigneeId,
      progress,
      summary,
      dedupKey,
      importance,
      eventType: typeof payload.eventType === 'string' ? payload.eventType : undefined,
      nodeRole: payload.nodeRole === 'root' || payload.nodeRole === 'child' ? payload.nodeRole : undefined,
      rootId: typeof payload.rootId === 'string' ? payload.rootId : undefined,
      rootTitle: typeof payload.rootTitle === 'string' ? payload.rootTitle : undefined,
      artifact: typeof payload.artifact === 'string' ? payload.artifact : undefined,
      nextStep: typeof payload.nextStep === 'string' ? payload.nextStep : undefined,
      at: typeof payload.at === 'string' ? payload.at : undefined,
    })
    this.outboxRepo.markPublishedIfPending(eventId)
  }

  // ===== §7.1 过程记忆事件契约 =====

  /**
   * 任务节点角色 + 根任务归属(§7.1 root.* / child.* 事件身份)。
   * 旧实现从 state 反推自然语言,子任务的 SUBMITTED 被错标成"根任务进入队列"。
   */
  protected eventNode(task: { parentId?: string, id: string, title?: string, channelId: string }): { nodeRole: 'root' | 'child', rootId: string, rootTitle: string } {
    if (!task.parentId) return { nodeRole: 'root', rootId: task.id, rootTitle: task.title ?? '' }
    const rootRow = this.deps.repos.tasks.findById(task.parentId)
    return { nodeRole: 'child', rootId: rootRow?.id ?? task.parentId, rootTitle: rootRow?.title ?? '' }
  }

  /**
   * 关键过程摘要：状态迁移与进度里程碑进入 Channel shared memory(§7.1/§7.2)。
   *
   * §11 回滚开关 channel_memory_digest_enabled=false 时整体停写(异常回滚用),
   * 任务主流程与 outbox 表结构不变。
   */
  protected recordTeamTaskEvent(channelId: string, e: { taskId: string, state?: TaskState, progress?: number, task?: TaskEventTask, artifactName?: string, reassignFrom?: string, reason?: string }): void {
    if (!channelMemoryDigestEnabled()) return
    const task = e.task ?? this.getTaskEngine().get(e.taskId)
    if (!task) return
    const now = Date.now()
    const terminal = e.state ? !!TERMINAL_TASK_STATES[e.state] : false
    const node = this.eventNode({ ...task, channelId })
    // §7.1 事件名(与设计文档逐字一致)+ 展示用中文标签。
    // 两条覆盖:① 新 root 若排在已有 active root 之后 → root.queued(而非 root.created);
    // ② artifact 事件独立成 child.artifact / root.artifact 语义(交付物必须可见)。
    let eventType = this.canonicalEventType(e.state, node.nodeRole, e.reassignFrom !== undefined)
    if (e.artifactName && (e.state === undefined || e.state === 'WORKING')) {
      eventType = node.nodeRole === 'root' ? 'root.artifact' : 'child.artifact'
    }
    else if (eventType === 'root.created') {
      const active = this.getTaskEngine().activeRootOf(channelId)
      if (active && active.id !== e.taskId) eventType = 'root.queued'
    }
    if (!eventType) return
    const event = EVENT_LABELS[eventType] ?? eventType
    const milestone = typeof e.progress === 'number' ? Math.floor(e.progress / 10) * 10 : 0
    // §7.2「同一事件类型 30 秒内最多写一次」:节流键只含事件类型(不含里程碑),
    // 里程碑只进 dedupKey —— 否则任务 30s 内从 10% 跳到 90% 会写 8 行。
    const throttleKey = `${channelId}:${e.taskId}:${eventType}`
    const previous = this.teamMemoryCheckpointAt.get(throttleKey) ?? 0
    if (!terminal && now - previous < 30_000) return
    this.teamMemoryCheckpointAt.set(throttleKey, now)
    this.pruneTeamMemoryCheckpoints(e.taskId)
    const bucket = terminal ? 'terminal' : `${eventType}:${milestone}`
    const payload = {
      channelId,
      taskId: e.taskId,
      rootId: node.rootId,
      rootTitle: node.rootTitle,
      nodeRole: node.nodeRole,
      eventType,
      title: task.title ?? `任务 ${e.taskId.slice(0, 8)}`,
      event,
      state: e.state ?? 'WORKING',
      assigneeId: task.assigneeId,
      progress: e.progress ?? task.progress ?? undefined,
      // §7.2「结论」:交付物摘要优先 → 关闭原因 → 路由理由
      summary: this.taskConclusion(task) || task.closeReason || task.routeReason || undefined,
      artifact: e.artifactName,
      nextStep: terminal ? undefined : this.taskNextStep(e.state, node.nodeRole),
      at: new Date().toISOString(),
      dedupKey: `team-task-event:${e.taskId}:${bucket}`,
      importance: terminal ? (e.state === 'COMPLETED' ? 0.85 : 0.6) : 0.5,
    }
    const eventId = `memory.team-task:${channelId}:${payload.dedupKey}`
    this.outboxRepo.enqueue({ aggregateType: 'task', aggregateId: e.taskId, eventType: 'memory.team-task', eventId, payload })
    void this.processTeamTaskMemoryOutbox(eventId, payload).catch((err) => {
      // §7.3 ④ 失败必须留痕 + 可重试:写 last_error 与 attempts,超过阈值转 failed 死信。
      this.markMemoryOutboxFailure(eventId, err)
    })
    // §7.2 root 终态写一条 canonical summary(交付物/结论),与过程行分列
    if (terminal && node.nodeRole === 'root') {
      this.recordTeamTaskTerminal(channelId, { taskId: e.taskId, state: e.state, task })
    }
    if (terminal) this.refreshChronicle(channelId)
  }

  /** §7.1 事件名派生(设计文档逐字口径) */
  protected canonicalEventType(state: TaskState | undefined, nodeRole: 'root' | 'child', reassigned: boolean): string | null {
    switch (state) {
      case 'SUBMITTED': return nodeRole === 'root' ? 'root.created' : 'child.dispatched'
      case 'ASSIGNED': return reassigned ? 'lead.reassign' : 'child.assigned'
      case 'WORKING': return nodeRole === 'root' ? 'root.activated' : 'child.started'
      case 'WAITING': return 'child.completed'
      case 'COMPLETED': return nodeRole === 'root' ? 'root.completed' : 'child.completed'
      case 'FAILED': return nodeRole === 'root' ? 'root.failed' : 'child.failed'
      case 'CANCELED': return nodeRole === 'root' ? 'root.canceled' : 'lead.cancel'
      default: return null
    }
  }

  /** §7.2「结论」:交付物文本优先(deliverable/summary → 首个非 input 交付物) */
  protected taskConclusion(task: TaskEventTask): string {
    const artifacts = (task.artifacts ?? []) as A2AArtifact[]
    const preferred = artifacts.filter(a => a.name === 'deliverable' || a.name === 'summary')
    const source = preferred.length > 0 ? preferred : artifacts.filter(a => a.name !== 'input')
    return source
      .flatMap(a => a.parts)
      .map(p => ('text' in p ? p.text : ''))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 300)
  }

  /** §7.2「下一步」:把当前状态翻译成可执行的下一步提示(确定性,无 LLM 成本) */
  protected taskNextStep(state: TaskState | undefined, nodeRole: 'root' | 'child'): string | undefined {
    if (nodeRole === 'root') {
      if (state === 'SUBMITTED') return '等待 Lead 规划并派发子任务'
      if (state === 'WORKING') return 'Lead 派发/验收中'
      return undefined
    }
    if (state === 'ASSIGNED' || state === 'SUBMITTED') return '等待 worker 接取执行'
    if (state === 'WORKING') return '等待 worker 交付,Lead 随后验收'
    if (state === 'FAILED') return 'Lead 需改派或向用户报告阻塞'
    return undefined
  }

  /** §7.2/§11 节流表有界化:同一 task 只保留最近 8 个事件桶,任务终态后整体清理 */
  protected pruneTeamMemoryCheckpoints(taskId: string): void {
    if (this.teamMemoryCheckpointAt.size <= TEAM_MEMORY_CHECKPOINT_CAP) return
    const prefix = `:${taskId}:`
    const keys = [...this.teamMemoryCheckpointAt.keys()].filter(k => k.includes(prefix))
    if (keys.length <= 8) return
    for (const k of keys.slice(0, keys.length - 8)) this.teamMemoryCheckpointAt.delete(k)
  }

  /** §7.3 ④ outbox 失败留痕:未超阈值 → pending 重排(带 last_error);超阈值 → failed 死信 */
  protected markMemoryOutboxFailure(eventId: string, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err)
    log.error('[memory] team-task 过程摘要失败:', err)
    try {
      const row = this.outboxRepo.findById(eventId)
      // markFailed/reschedule 均自增 attempts —— 用现有 attempts 判定是否进入死信
      if (row && row.attempts + 1 >= MEMORY_OUTBOX_MAX_ATTEMPTS) this.outboxRepo.markFailed(eventId, message)
      else this.outboxRepo.reschedule(eventId, message)
    }
    catch (inner) {
      log.error('[memory] outbox 失败留痕异常:', inner)
    }
  }

  /**
   * 监督信号落共享记忆(§7.1 supervise.watchdog)。
   * watchdog 是非破坏信号 —— 这里只记录,不触碰任何任务状态。
   */
  protected recordSupervisionSignal(e: {
    agentId: string
    channelId: string
    attemptId: string | null
    kind: 'watchdog'
    activeRootId: string | null
    snapshotRevision: number | null
    watchdogCount: number
    at: string
  }): void {
    if (!channelMemoryDigestEnabled()) return
    const root = e.activeRootId ? this.getTaskEngine().get(e.activeRootId) : undefined
    const payload: Record<string, unknown> = {
      channelId: e.channelId,
      taskId: e.activeRootId ?? `supervision:${e.agentId}`,
      rootId: e.activeRootId ?? undefined,
      rootTitle: root?.title ?? '',
      nodeRole: 'root',
      eventType: 'supervise.watchdog',
      title: root?.title ?? `Lead 监督回合(${e.agentId.slice(0, 8)})`,
      event: '监督 watchdog',
      state: root?.state ?? 'WORKING',
      assigneeId: e.agentId,
      summary: `Lead 监督回合超过观察阈值(第 ${e.watchdogCount} 次,tick=${e.snapshotRevision ?? '-'})。这是观察信号,不是取消:任务状态未变,Lead 仍可 wait/guide/reassign/cancel/complete。`,
      nextStep: '等待 Lead 基于真实 worker 进度给出显式决策',
      at: e.at,
      dedupKey: `supervise-watchdog:${e.channelId}:${e.agentId}:${e.attemptId ?? 'na'}:${e.watchdogCount}`,
      importance: 0.55,
    }
    const eventId = `memory.supervise:${e.channelId}:${payload.dedupKey}`
    this.outboxRepo.enqueue({ aggregateType: 'agent', aggregateId: e.agentId, eventType: 'memory.team-task', eventId, payload })
    void this.processTeamTaskMemoryOutbox(eventId, payload).catch(err => this.markMemoryOutboxFailure(eventId, err))
  }

  /** Harness 重建落共享记忆(§7.1 harness.restarted / §6.2 lastRestartReason) */
  protected recordHarnessRestartEvent(e: { agentId: string, channelId: string, harness: string, reason: string, at: string }): void {
    if (!channelMemoryDigestEnabled()) return
    const payload: Record<string, unknown> = {
      channelId: e.channelId,
      taskId: `harness:${e.agentId}`,
      eventType: 'harness.restarted',
      title: `Harness 重建(${e.harness})`,
      event: 'Harness 重建',
      state: 'WORKING',
      assigneeId: e.agentId,
      summary: `Harness 会话/进程已重建,原因 ${e.reason}。队列与任务状态不变,后续回合在新会话中继续。`,
      nextStep: '等待下一回合在同一 Runtime 上继续(不创建新 root,不改队列顺序)',
      at: e.at,
      dedupKey: `harness-restart:${e.channelId}:${e.agentId}:${e.at}`,
      importance: 0.5,
    }
    const eventId = `memory.harness:${e.channelId}:${payload.dedupKey}`
    this.outboxRepo.enqueue({ aggregateType: 'agent', aggregateId: e.agentId, eventType: 'memory.team-task', eventId, payload })
    void this.processTeamTaskMemoryOutbox(eventId, payload).catch(err => this.markMemoryOutboxFailure(eventId, err))
  }

  /**
   * Lead 决策落共享记忆(§7.1 lead.wait / lead.guide / lead.reassign / lead.cancel)。
   * 由 SchedulerLoop 在每个决策执行后回调;不做节流 —— 决策本身就是低频关键事件。
   */
  protected recordLeadDecision(channelId: string, e: { agentId: string, decision: string, taskId?: string, toAgentId?: string, reason?: string, rootId?: string }): void {
    if (!channelMemoryDigestEnabled()) return
    const eventType = LEAD_DECISION_EVENTS[e.decision]
    if (!eventType) return
    const task = e.taskId ? this.getTaskEngine().get(e.taskId) : undefined
    const node = task ? this.eventNode(task) : undefined
    const at = new Date().toISOString()
    const detail = e.decision === 'wait'
      ? `Lead 显式等待:${e.reason || '(未说明)'}`
      : e.decision === 'guide'
        ? `Lead 指引 ${e.toAgentId?.slice(0, 8) ?? '?'}:${e.reason || '(见消息)'}`
        : `Lead ${e.decision} ${e.taskId?.slice(0, 8) ?? '?'}${e.toAgentId ? ` → ${e.toAgentId.slice(0, 8)}` : ''}${e.reason ? `:${e.reason}` : ''}`
    const payload: Record<string, unknown> = {
      channelId,
      taskId: e.taskId ?? `lead-decision:${e.agentId}`,
      rootId: e.rootId ?? node?.rootId,
      rootTitle: node?.rootTitle,
      nodeRole: node?.nodeRole,
      eventType,
      title: task?.title ?? `Lead 决策(${e.agentId.slice(0, 8)})`,
      event: LEAD_DECISION_LABELS[e.decision] ?? e.decision,
      state: task?.state ?? 'WORKING',
      assigneeId: e.toAgentId ?? e.agentId,
      summary: detail,
      at,
      dedupKey: `${eventType}:${channelId}:${e.taskId ?? e.agentId}:${at}`,
      importance: 0.55,
    }
    const eventId = `memory.lead:${channelId}:${payload.dedupKey}`
    this.outboxRepo.enqueue({ aggregateType: 'task', aggregateId: e.taskId ?? e.agentId, eventType: 'memory.team-task', eventId, payload })
    void this.processTeamTaskMemoryOutbox(eventId, payload).catch(err => this.markMemoryOutboxFailure(eventId, err))
  }

  /**
   * 团队历史沉淀(任务终态)§7.2 canonical summary + 团队编年史滚动重写。
   * ① team-task 共享行(deliverable 结论,全员可检索);② 编年史最近 12 条终态轨迹。
   * 旧实现里本函数是**死代码**,root 的 canonical summary 从未落库 —— 这里在终态分支接回。
   */
  protected recordTeamTaskTerminal(channelId: string, e: { taskId: string, state?: TaskState, task?: TaskEventTask }): void {
    if (!e.state || !TERMINAL_TASK_STATES[e.state]) return
    try {
      const completed = e.state === 'COMPLETED'
      const task = e.task
      const title = task?.title ?? `任务 ${e.taskId.slice(0, 8)}`
      // 成果提取与 AgentMemory.recordTaskOutcome 同口径(deliverable/summary 优先)
      const artifacts = (task?.artifacts ?? []) as A2AArtifact[]
      const preferred = artifacts.filter(a => a.name === 'deliverable' || a.name === 'summary')
      const source = preferred.length > 0 ? preferred : artifacts
      const deliverable = source
        .flatMap(a => a.parts)
        .map(p => ('text' in p ? p.text : ''))
        .join(' ')
        .trim()
      const content = completed
        ? (deliverable || title)
        : `任务「${title}」${e.state === 'CANCELED' ? '已取消' : '未完成'}${deliverable ? `;已有进展: ${deliverable.slice(0, 200)}` : ''}`
      const mem = new AgentMemory(this.deps.repos.memories, { channelId, agentId: TEAM_AGENT_ID, embedder: this.memoryEmbedder ?? undefined })
      void mem.appendTeamTaskRecord({
        taskId: e.taskId,
        title,
        content,
        importance: completed ? 0.8 : 0.55,
      }).catch((err) => { log.error('[memory] team-task 沉淀失败:', err) })
      this.refreshChronicle(channelId)
    }
    catch (err) {
      log.error('[memory] 团队任务沉淀异常:', err)
    }
  }

  /** 团队编年史滚动重写(最近 12 条终态任务;chronicle:<channelId> 幂等单行;免向量化) */
  protected refreshChronicle(channelId: string): void {
    try {
      const terminal = this.getTaskEngine().list(channelId)
        .filter(t => TERMINAL_TASK_STATES[t.state])
        .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
        .slice(0, 12)
      if (terminal.length === 0) return
      const entries = terminal.map((t) => {
        const stamp = t.updatedAt.slice(5, 16).replace('T', ' ')
        const deliverable = t.artifacts
          .flatMap(a => a.parts)
          .map(p => ('text' in p ? p.text : ''))
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 60)
        const state = t.state === 'COMPLETED' ? '完成' : t.state === 'FAILED' ? '失败' : '取消'
        return `${stamp} [${state}] ${t.title} — ${t.assigneeId.slice(0, 8)}${deliverable ? `(${deliverable})` : ''}`
      })
      new AgentMemory(this.deps.repos.memories, { channelId, agentId: TEAM_AGENT_ID })
        .upsertChronicle(entries.join('\n'))
    }
    catch (err) {
      log.error('[memory] 编年史刷新失败:', err)
    }
  }

  /**
   * 空闲反思(sleep-time compute,零 LLM):当月 episodic-task 增量 ≥ 阈值时,
   * 聚合标题+结论成 semantic 反思行(月度 dedupKey 幂等;FTS 可检索,免向量化)。
   */
  protected reflectIdleMemories(): void {
    for (const rt of this.agentIndex.values()) {
      if (rt.getState() === 'busy') return
    }
    const trigger = memorySettings().reflect_trigger
    const month = new Date().toISOString().slice(0, 7)
    const memories = this.deps.repos.memories
    for (const agentId of memories.listMemoryAgentIds()) {
      // 条件下推到 SQL:原先拉 limit=1_000_000 全量再 JS filter,代价随记忆总量无上限增长。
      // 这里按 (agent, kind, 当月) 精确取行 —— 返回量与实际增量同阶,且内存不随历史膨胀。
      const rows = memories.listByAgentKindMonth(agentId, 'episodic-task', month)
      const prev = this.reflectCounts.get(agentId) ?? 0
      if (rows.length < trigger || rows.length <= prev) continue
      // 行可能跨 channel(历史迁移):按 channel 分组,各组建反思
      const byChannel = new Map<string, typeof rows>()
      for (const r of rows) {
        const list = byChannel.get(r.channelId) ?? []
        list.push(r)
        byChannel.set(r.channelId, list)
      }
      for (const [channelId, list] of byChannel) {
        const lines = list.slice(0, 20).map(r => `- ${r.title}:${unsegmentCJK(r.content).slice(0, 60)}`)
        new AgentMemory(this.deps.repos.memories, { channelId, agentId })
          .upsertReflection({ month, content: [`当月 ${list.length} 项任务经验聚合:`, ...lines].join('\n') })
      }
      this.reflectCounts.set(agentId, rows.length)
      log.info(`[memory] 反思蒸馏:agent=${agentId.slice(0, 8)} 当月 ${rows.length} 项任务已聚合`)
    }
  }
}
