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
import { memorySettings, retentionSettings } from '../../settings'
import { parseJson } from '../../db/database'

export abstract class ManagerState extends ManagerContracts {
  protected channels = new Map<string, ChannelRuntime>()
  /** 键 = runtimeKey(channelId, 实例 id);每个实例一个独立运行时 */
  protected agentIndex = new Map<string, AgentRuntime>()
  protected buses = new Map<string, ChannelBus>()
  protected taskEngine: TaskEngine | null = null
  protected idleSweeperTimer: NodeJS.Timeout | null = null
  protected memoryTimer: NodeJS.Timeout | null = null
  /** 全 manager 共享的 env 向量 provider(未配置 → null 纯 FTS;熔断/维度全体实例共享) */
  protected readonly memoryEmbedder = createEnvEmbeddingProvider()
  /** 反思游标:每 agent 上次聚合的当月任务数(月度幂等增量判定) */
  protected readonly reflectCounts = new Map<string, number>()
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
    // ① 补偿扫描:滞留 pending 说明"落库成功但发布阶段未收敛",按事件类型重发即可(客户端按 eventId/seq 幂等)
    try {
      const stalled = this.outboxRepo.listPending(200)
      for (const ev of stalled) {
        const payload = parseJson<Record<string, unknown>>(ev.payloadJson, {})
        const channelId = typeof payload.channelId === 'string' ? payload.channelId : null
        if (!channelId) continue
        if (ev.eventType === 'chat.message' && typeof payload.chatMessageId === 'string') {
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
    // ② outbox 保留期(默认与事件保留期同源:已发布行留够排障窗口后回收)
    try {
      const days = retentionSettings().events_days
      const cutoff = new Date(now - days * 86_400_000).toISOString()
      const removed = this.outboxRepo.sweepPublished(cutoff)
      if (removed > 0) log.info(`[chat] outbox 保留期清理 ${removed} 行(已发布 >${days}d)`)
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
          })
          // 事件驱动调度:任务状态变化即唤醒该频道调度循环(空闲退避即刻恢复快节奏)
          this.channels.get(e.channelId)?.scheduler?.wake()
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
      this.buses.get(channelId)!.onTaskEvent(e => this.recordTeamTaskTerminal(channelId, e))
    }
    return cr
  }

  /**
   * 团队历史沉淀(任务终态):① team-task 共享行(成果/失败原因,全员可检索);
   * ② 团队编年史滚动重写(最近 12 条终态任务轨迹)。
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
