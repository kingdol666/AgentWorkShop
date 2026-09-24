/**
 * ManagerSchedules —— 定时任务管理面与 restore
 * (拆分层,承 ManagerHostTools)
 */
import { ManagerHostTools } from './host-tools'
import type { ActingUser, ScheduleView } from './types'
import type { ChannelRow, ScheduledTaskRow, ScheduledTaskRunRow } from '../../db/database'
import type { FireResult } from '../schedule-runtime'
import { AppError } from '../../../../utils/errors'
import { ScheduleRuntime, validatePlanAndComputeFirstRun } from '../schedule-runtime'
import { TERMINAL_TASK_STATES } from '../../types/task'
import { log } from './helpers'

export abstract class ManagerSchedules extends ManagerHostTools {
  async restore(): Promise<void> {
    this.deps.repos.messages.resetConsuming()
    // §6.4 服务重启:先跑一次 outbox 补偿,把重启窗口内滞留的 pending 记忆/群聊事件
    // 立即收敛(否则要等一个 memory.maintenance_ms 周期 —— 默认 6 小时)。
    try {
      this.runGroupChatMaintenance()
    }
    catch (err) {
      log.error('[restore] outbox 补偿失败(不阻断恢复):', err)
    }
    const nonTerminal = this.deps.repos.tasks.listNonTerminal()
    const activeChannelIds = new Set(nonTerminal.map(t => t.channelId))
    for (const channelId of activeChannelIds) {
      const channel = this.deps.repos.channels.findById(channelId)
      if (!channel || channel.enabled !== 1) continue
      this.ensureChannelActive(channelId)
      // §6.4:跨进程重启后旧子进程必然不可用 —— 对仍在恢复的 channel,如实记录
      // SERVER_RESTART,而不是让前端以为 Harness 会话仍在复用。
      this.runtimeOf(channelId, channel.leadAgentId ?? '')?.markServerRestart?.()
    }
    // 断线重连:ASSIGNED/WORKING 的叶子任务(无子任务)若无 pending assign 投递
    // (消息已被消费但任务未完成——进程内 run 抛错、或崩溃落在消费后),
    // 无人会重新驱动它(调度循环只 dispatch lead 名下任务;停滞检测要 stallMs×2 才 cancel)。
    // 重投 assign + 唤醒 assignee,由 processMessage 的终态检查保证幂等(执行从头重放)。
    // 父任务(WAITING/有子任务)不重投:由调度循环按子任务进度汇总推进。
    // 父任务集合按 channel 全量任务计算(含已完成子任务):
    // 「子任务全部完成、父任务 WAITING 待汇总」的父任务不能误判为叶子而重投。
    const parentIds = new Set<string>()
    for (const channelId of activeChannelIds) {
      for (const t of this.deps.repos.tasks.listByChannel(channelId)) {
        if (t.parentId) parentIds.add(t.parentId)
      }
    }
    for (const task of nonTerminal) {
      if (task.state !== 'ASSIGNED' && task.state !== 'WORKING') continue
      if (parentIds.has(task.id)) continue
      if (this.deps.repos.messages.hasPendingAssign(task.id)) continue
      this.getTaskEngine().redeliverAssign(task.id)
    }
    // 唤醒有未消费消息的 agent:重启前 consuming 的 assign 消息已被 resetConsuming 重投为 pending,
    // 若无人唤醒,worker 的运行时(懒加载)不会装配,重投消息滞留 pending,任务永远无法恢复。
    // 任务状态保持原样(不重置为 ASSIGNED):调度循环按 SUBMITTED/WORKING 重新驱动 lead 任务,
    // worker 经消息重放从 ASSIGNED/WORKING 恢复执行;WAITING 父任务等子任务完成后正常汇总。
    for (const { channelId, toAgentId } of this.deps.repos.messages.listPendingTargets()) {
      this.wakeAgent(channelId, toAgentId)
    }
  }

  // ===== 定时任务管理面(v16;元数据 CRUD 归 Manager,timer 周期归 ScheduleRuntime)=====

  /** 组装计划视图(repo 行 + channel 名;channel 已删的计划不会出现——建表 FK CASCADE) */
  protected scheduleViewOf(row: ScheduledTaskRow): ScheduleView {
    const channel = this.deps.repos.channels.findById(row.channelId)
    return {
      id: row.id,
      channelId: row.channelId,
      channelName: channel?.name ?? row.channelId.slice(0, 8),
      name: row.name,
      title: row.title,
      description: row.description,
      mode: row.mode as 'interval' | 'daily',
      intervalMs: row.intervalMs,
      dailyTime: row.dailyTime,
      enabled: row.enabled,
      state: row.state,
      lastRunAt: row.lastRunAt,
      nextRunAt: row.nextRunAt,
      lastTaskId: row.lastTaskId,
      runCount: row.runCount,
      failCount: row.failCount,
      consecutiveFailures: row.consecutiveFailures,
      maxConsecutiveFailures: row.maxConsecutiveFailures,
      ownerUserId: row.ownerUserId,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }
  }

  /** 计划的 channel 级权限校验(可读 = channel 可见;可写 = requireOwned;返回 channel 行) */
  protected scheduleChannelGuard(scheduleId: string, user: ActingUser): { channel: ChannelRow, row: ScheduledTaskRow } {
    const row = this.deps.repos.schedules?.findById(scheduleId)
    if (!row) throw new AppError(404, 'NOT_FOUND', `定时任务不存在: ${scheduleId}`)
    const channel = this.deps.repos.channels.findById(row.channelId)
    if (!channel) throw new AppError(404, 'NOT_FOUND', `定时任务所属 channel 不存在: ${row.channelId}`)
    // 可见性同 channel:本人 + 遗留公共;admin 全量
    if (user.role !== 'admin') {
      this.getChannelForUser(row.channelId, user.id)
    }
    return { channel, row }
  }

  /** 用户视角定时计划列表(本人 + 遗留公共 channel;admin 全量),附 channel 名 */
  listSchedulesForUser(user: ActingUser): ScheduleView[] {
    if (!this.deps.repos.schedules) return []
    const rows = user.role === 'admin'
      ? this.deps.repos.schedules.list()
      : this.deps.repos.schedules.list().filter((row) => {
          const channel = this.deps.repos.channels.findById(row.channelId)
          return channel && (channel.ownerUserId === null || channel.ownerUserId === user.id)
        })
    return rows.map(row => this.scheduleViewOf(row))
  }

  /** 单个定时计划详情 */
  getScheduleForUser(scheduleId: string, user: ActingUser): ScheduleView {
    const { row } = this.scheduleChannelGuard(scheduleId, user)
    return this.scheduleViewOf(row)
  }

  /** 定时计划运行历史(最近 limit 条;新→旧) */
  listScheduleRunsForUser(scheduleId: string, user: ActingUser, limit = 50): ScheduledTaskRunRow[] {
    this.scheduleChannelGuard(scheduleId, user)
    return this.deps.repos.schedules.listRuns(scheduleId, limit)
  }

  /** 创建定时计划(参数校验 + 首次 next_run_at 计算;归属 = channel 属主) */
  createSchedule(user: ActingUser, input: {
    channelId: string
    name: string
    title: string
    description?: string
    mode: 'interval' | 'daily'
    intervalMs?: number
    dailyTime?: string
    maxConsecutiveFailures?: number
  }): ScheduleView {
    if (!this.deps.repos.schedules) throw new AppError(503, 'WORKSHOP_NOT_READY', '定时任务仓储未装配')
    const channel = this.getChannelForUser(input.channelId, user.id)
    this.requireOwned(channel.ownerUserId, user.id, 'channel')
    if (!input.name.trim()) throw new AppError(400, 'BAD_REQUEST', '计划名称不能为空')
    if (!input.title.trim()) throw new AppError(400, 'BAD_REQUEST', '任务标题不能为空')
    // 计划参数校验 + 首触发时刻(本地时区;validatePlan 抛 Error → 400 信封)
    let plan: ReturnType<typeof validatePlanAndComputeFirstRun>
    try {
      plan = validatePlanAndComputeFirstRun(input, new Date())
    }
    catch (err) {
      throw new AppError(400, 'BAD_REQUEST', err instanceof Error ? err.message : String(err))
    }
    const row = this.deps.repos.schedules.create({
      channelId: input.channelId,
      name: input.name.trim(),
      title: input.title.trim(),
      description: input.description ?? '',
      mode: input.mode,
      intervalMs: plan.intervalMs,
      dailyTime: plan.dailyTime,
      maxConsecutiveFailures: input.maxConsecutiveFailures ?? 0,
      ownerUserId: user.id,
      nextRunAt: plan.nextRunAt,
    })
    this.scheduleRuntime?.tickSoon()
    return this.scheduleViewOf(row)
  }

  /** 更新定时计划(改参数即重算 next_run_at;停用/启用走状态机) */
  updateSchedule(scheduleId: string, user: ActingUser, patch: {
    name?: string
    title?: string
    description?: string
    mode?: 'interval' | 'daily'
    intervalMs?: number
    dailyTime?: string
    enabled?: number
    maxConsecutiveFailures?: number
  }): ScheduleView {
    const { row } = this.scheduleChannelGuard(scheduleId, user)
    this.requireOwned(row.ownerUserId, user.id, '定时任务')
    const repo = this.deps.repos.schedules!
    const planChanged = (patch.mode !== undefined && patch.mode !== row.mode)
      || (patch.intervalMs !== undefined && patch.intervalMs !== row.intervalMs)
      || (patch.dailyTime !== undefined && patch.dailyTime !== row.dailyTime)
    let nextRunAt: string | null | undefined
    if (planChanged) {
      try {
        const plan = validatePlanAndComputeFirstRun(
          { mode: patch.mode ?? (row.mode as 'interval' | 'daily'), intervalMs: patch.intervalMs ?? row.intervalMs, dailyTime: patch.dailyTime ?? row.dailyTime },
          new Date(),
        )
        nextRunAt = plan.nextRunAt
      }
      catch (err) {
        throw new AppError(400, 'BAD_REQUEST', err instanceof Error ? err.message : String(err))
      }
    }
    let state: string | undefined
    let consecutiveFailures: number | undefined
    if (patch.enabled === 0) {
      state = 'disabled'
    }
    else if (patch.enabled === 1) {
      // 启用 = 重新计时 + 清连续失败(熔断后的计划获得新窗口)
      state = 'idle'
      consecutiveFailures = 0
      nextRunAt = validatePlanAndComputeFirstRun(
        { mode: patch.mode ?? (row.mode as 'interval' | 'daily'), intervalMs: patch.intervalMs ?? row.intervalMs, dailyTime: patch.dailyTime ?? row.dailyTime },
        new Date(),
      ).nextRunAt
    }
    const updated = repo.update(scheduleId, {
      ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
      ...(patch.title !== undefined ? { title: patch.title.trim() } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.mode !== undefined ? { mode: patch.mode } : {}),
      ...(patch.intervalMs !== undefined ? { intervalMs: patch.intervalMs } : {}),
      ...(patch.dailyTime !== undefined ? { dailyTime: patch.dailyTime } : {}),
      ...(patch.maxConsecutiveFailures !== undefined ? { maxConsecutiveFailures: patch.maxConsecutiveFailures } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(state !== undefined ? { state } : {}),
      ...(consecutiveFailures !== undefined ? { consecutiveFailures } : {}),
      ...(nextRunAt !== undefined ? { nextRunAt } : {}),
    })
    if (!updated) throw new AppError(404, 'NOT_FOUND', `定时任务不存在: ${scheduleId}`)
    this.scheduleRuntime?.tickSoon()
    return this.scheduleViewOf(updated)
  }

  /** 删除定时计划 */
  removeSchedule(scheduleId: string, user: ActingUser): void {
    const { row } = this.scheduleChannelGuard(scheduleId, user)
    this.requireOwned(row.ownerUserId, user.id, '定时任务')
    this.deps.repos.schedules.remove(scheduleId)
  }

  /**
   * 手动立即执行(与 timer 触发同一条 fire 主路径,同样受忙等守卫约束):
   * - Channel 忙 → 409 CHANNEL_BUSY(计划已置 waiting,收口后 timer 不会重放 manual;
   *   需要用户再点一次或等周期触发)
   * - 在途 → 409 SCHEDULE_RUNNING
   * - 提交失败 → 502(run 已留 FAILED 痕)
   */
  async runScheduleNow(scheduleId: string, user: ActingUser): Promise<{ runId: string, taskId?: string }> {
    const { row } = this.scheduleChannelGuard(scheduleId, user)
    this.requireOwned(row.ownerUserId, user.id, '定时任务')
    const runtime = this.scheduleRuntime
    if (!runtime) throw new AppError(503, 'WORKSHOP_NOT_READY', '定时任务运行时未启动')
    const fresh = this.deps.repos.schedules.findById(scheduleId)!
    const result: FireResult = await runtime.fire(fresh, 'manual')
    if (result.ok) return { runId: result.runId!, taskId: result.taskId }
    if (result.reason === 'channel_busy') {
      throw new AppError(409, 'CHANNEL_BUSY', 'Channel 正在处理任务,须等其全部收口后再执行定时任务(计划已标记等待中)')
    }
    if (result.reason === 'already_running') {
      throw new AppError(409, 'SCHEDULE_RUNNING', '该定时任务上一轮仍在执行中')
    }
    if (result.reason === 'disabled') {
      throw new AppError(409, 'SCHEDULE_DISABLED', '该定时任务已停用,请先启用')
    }
    throw new AppError(502, 'SCHEDULE_FIRE_FAILED', result.error ?? '定时任务触发失败')
  }

  /** Channel 是否有未收口任务(忙等守卫事实源;SUBMITTED/ASSIGNED/WORKING/WAITING 视为在途) */
  channelHasActiveTasks(channelId: string): boolean {
    return this.getTaskEngine().list(channelId).some(t => !TERMINAL_TASK_STATES[t.state])
  }

  /** 装配并启动定时任务运行时(幂等;plugin 在 restore 后调用) */
  startScheduleRuntime(options?: { tickMs?: number }): void {
    if (!this.deps.repos.schedules) return
    if (this.scheduleRuntime) {
      this.scheduleRuntime.stop()
      this.scheduleRuntime = null
    }
    const envTick = Number(process.env.WORKSHOP_SCHEDULE_TICK_MS)
    this.scheduleRuntime = new ScheduleRuntime({
      repo: this.deps.repos.schedules,
      // 与人类控制台提交同链路:懒装配/信箱/调度循环/HITL 全部复用;
      // fromLabel 盖章使时间线一眼可辨「定时触发」
      submitTask: async ({ channelId, title, description }) => {
        const task = await this.submitChannelTask({ channelId, title, description, fromLabel: '定时任务' })
        return { id: task.id }
      },
      channelHasActiveTasks: channelId => this.channelHasActiveTasks(channelId),
      getTaskState: taskId => this.deps.repos.tasks.findById(taskId)?.state,
      ...(options?.tickMs !== undefined ? { tickMs: options.tickMs } : {}),
      ...(Number.isFinite(envTick) && envTick > 0 ? { tickMs: envTick } : {}),
    })
    this.scheduleRuntime.start()
  }

  /** 各 channel 启用的定时计划数(channels 列表批量附「定时」标志;一次 GROUP BY) */
  channelScheduleFlags(): Map<string, number> {
    if (!this.deps.repos.schedules) return new Map()
    return this.deps.repos.schedules.countEnabledByChannelAll()
  }

  // ===== 内部辅助 =====
}
