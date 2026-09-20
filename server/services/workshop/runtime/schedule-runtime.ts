/**
 * ScheduleRuntime —— 定时任务执行器(v16)。
 *
 * 职责边界(与 Manager 分工):
 * - 本类只做「何时触发」与「触发后怎么记」:持有唯一的周期 timer,逐 tick 判到期、
 *   忙等守卫、调 submitTask 下发任务、维护 run 历史与计划状态机;
 * - 「任务怎么执行」完全不归本类:下发一律经 deps.submitTask(Manager.submitChannelTask),
 *   与人类从控制台提交任务同一条链路(懒装配 lead/成员、信箱、调度循环全部复用)。
 *
 * 两种触发模式:
 * - interval:固定间隔(interval_ms,下限 60s)。next_run_at = 触发时刻 + 间隔;
 * - daily:每日定点(daily_time 'HH:MM',本地时区)。错过(停机跨点)在下一个 tick 补跑一次。
 *
 * 忙等守卫(硬约束):Channel 内存在任一非终态任务 → 计划置 waiting 并跳过;
 * 待 Channel 任务全部收口后的下一个 tick 立即补触发(next_run_at 已过仍判到期)。
 * 计划自身的在途 run 未收口前绝不二次触发(state=running 先于到期判定短路)。
 */
import type { ScheduledTaskRow } from '../db/database'
import type { ScheduledTaskRepo } from '../db/scheduled-task.repo'

/** 日志前缀收口(本模块不引 createLogger,保持可被 tsx 单测直跑) */
const L = { p: '[workshop.schedule]' }

/** 固定间隔下限(60s):挡住误配的高频触发打爆 Channel 任务队列 */
export const SCHEDULE_MIN_INTERVAL_MS = 60_000

/** 任务终态(与 types/task TERMINAL_TASK_STATES 同集;此处独立声明避免运行时反向依赖) */
const TERMINAL = new Set(['COMPLETED', 'FAILED', 'CANCELED'])

/** 'HH:MM'(24 小时制) */
const DAILY_TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/

export function isValidDailyTime(v: string): boolean {
  return DAILY_TIME_RE.test(v)
}

/**
 * 计算下一次触发时刻(纯函数;本地时区——项目全局 ISO 已本地化,Date 解析双向兼容)。
 * @returns ISO 字符串;参数非法返回 null(调用方按「无下次」处理)
 */
export function computeNextRunAt(
  mode: 'interval' | 'daily',
  intervalMs: number,
  dailyTime: string,
  from: Date,
): string | null {
  if (mode === 'interval') {
    if (!Number.isFinite(intervalMs) || intervalMs < SCHEDULE_MIN_INTERVAL_MS) return null
    return new Date(from.getTime() + intervalMs).toISOString()
  }
  if (mode === 'daily') {
    const m = dailyTime.match(DAILY_TIME_RE)
    if (!m) return null
    const hh = Number(m[1])
    const mm = Number(m[2])
    const next = new Date(from)
    next.setHours(hh, mm, 0, 0)
    if (next.getTime() <= from.getTime()) next.setDate(next.getDate() + 1)
    return next.toISOString()
  }
  return null
}

/** 计划触发输入(管理面校验后的规范形状) */
export interface SchedulePlanInput {
  mode: 'interval' | 'daily'
  intervalMs?: number
  dailyTime?: string
}

/** 校验计划参数并计算首个 next_run_at(创建/修改共用;非法抛错文案面向 API) */
export function validatePlanAndComputeFirstRun(input: SchedulePlanInput, from: Date): { intervalMs: number, dailyTime: string, nextRunAt: string | null } {
  if (input.mode === 'interval') {
    const intervalMs = input.intervalMs ?? 0
    if (!Number.isFinite(intervalMs) || intervalMs < SCHEDULE_MIN_INTERVAL_MS) {
      throw new Error(`固定间隔至少 ${Math.floor(SCHEDULE_MIN_INTERVAL_MS / 1000)} 秒`)
    }
    return { intervalMs, dailyTime: '', nextRunAt: computeNextRunAt('interval', intervalMs, '', from) }
  }
  if (input.mode === 'daily') {
    const dailyTime = (input.dailyTime ?? '').trim()
    if (!isValidDailyTime(dailyTime)) throw new Error('每日定点时刻须为合法 HH:MM(24 小时制)')
    return { intervalMs: 0, dailyTime, nextRunAt: computeNextRunAt('daily', 0, dailyTime, from) }
  }
  throw new Error('mode 只支持 interval(固定间隔)或 daily(每日定点)')
}

/** ScheduleRuntime 依赖(manager 注入;全部收窄为最小面,便于单测替身) */
export interface ScheduleRuntimeDeps {
  repo: ScheduledTaskRepo
  /** 向 channel 提交任务(= Manager.submitChannelTask;与人类提交同链路) */
  submitTask: (input: { channelId: string, title: string, description?: string }) => Promise<{ id: string }>
  /** Channel 是否有未收口任务(忙等守卫的事实源) */
  channelHasActiveTasks: (channelId: string) => boolean
  /** 任务状态读取(run 收口对账;任务已不存在返回 undefined) */
  getTaskState: (taskId: string) => string | undefined
  /** tick 周期(env WORKSHOP_SCHEDULE_TICK_MS 可覆写;缺省 10s) */
  tickMs?: number
}

/** fire 结果(manual 触发映射 REST 语义) */
export interface FireResult {
  ok: boolean
  reason?: 'channel_busy' | 'already_running' | 'disabled'
  runId?: string
  taskId?: string
  error?: string
}

export class ScheduleRuntime {
  private timer: ReturnType<typeof setInterval> | null = null
  /** 防重入:正在执行的 tick 不叠加 */
  private ticking = false
  private tickSoonHandle: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly deps: ScheduleRuntimeDeps) {}

  start(): void {
    if (this.timer) return
    const tickMs = this.deps.tickMs ?? 10_000
    this.timer = setInterval(() => {
      void this.tick()
    }, tickMs)
    // 不阻进程退出(与 manager 内其他定时器同纪律)
    this.timer.unref?.()
    console.log(`${L.p} 定时任务运行时已启动(tick=${tickMs}ms)`)
    // 启动即 tick 一次:补跑停机期间错过的到期计划(catch-up)
    void this.tick()
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    if (this.tickSoonHandle) {
      clearTimeout(this.tickSoonHandle)
      this.tickSoonHandle = null
    }
  }

  /** CRUD 后即刻感知(去抖:同周期内多次触发只补一次) */
  tickSoon(): void {
    if (this.tickSoonHandle) return
    this.tickSoonHandle = setTimeout(() => {
      this.tickSoonHandle = null
      void this.tick()
    }, 250)
    this.tickSoonHandle.unref?.()
  }

  /**
   * 单 tick:① 对账在途 run(任务终态 → run 收口 + 计划回 idle/熔断);
   * ② 逐计划判到期 → 忙等守卫 → 触发。
   */
  async tick(now: Date = new Date()): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      await this.reconcileRunning(now)
      for (const schedule of this.deps.repo.listEnabled()) {
        if (schedule.state === 'running') continue // 在途,① 已对账
        if (!this.isDue(schedule, now)) continue
        if (this.deps.channelHasActiveTasks(schedule.channelId)) {
          if (schedule.state !== 'waiting') {
            this.deps.repo.update(schedule.id, { state: 'waiting' })
          }
          continue
        }
        // waiting → 触发瞬间直接翻 running(守卫刚放行,不等下一个 tick)
        await this.fire(schedule, 'timer', now)
      }
    }
    catch (err) {
      console.error(`${L.p} tick 异常(下个 tick 继续):`, err)
    }
    finally {
      this.ticking = false
    }
  }

  /** 到期判定:next_run_at 缺失(历史数据)时按 last_run_at/created_at 推导一次并回填 */
  private isDue(schedule: ScheduledTaskRow, now: Date): boolean {
    let next = schedule.nextRunAt
    if (!next) {
      const base = schedule.lastRunAt ?? schedule.createdAt
      const computed = computeNextRunAt(
        schedule.mode as 'interval' | 'daily',
        schedule.intervalMs,
        schedule.dailyTime,
        new Date(base),
      )
      // 参数已损坏(无法推导)→ 停用并留痕,避免每 tick 空转
      if (!computed) {
        this.deps.repo.update(schedule.id, { enabled: 0, state: 'failed' })
        console.warn(`${L.p} 计划「${schedule.name}」(${schedule.id.slice(0, 8)})参数无效,已自动停用`)
        return false
      }
      this.deps.repo.update(schedule.id, { nextRunAt: computed })
      next = computed
    }
    return new Date(next).getTime() <= now.getTime()
  }

  /**
   * 对账在途 run:任务终态 → run 收口;计划状态机推进(成功回 idle / 失败计数熔断)。
   * 崩溃恢复:run 还在但任务行已消失(库被清/渠道级联)→ 超过 1 小时判 FAILED 收口。
   */
  private async reconcileRunning(now: Date): Promise<void> {
    for (const run of this.deps.repo.listRunningRuns()) {
      const schedule = this.deps.repo.findById(run.scheduleId)
      if (!schedule) {
        // 计划已删(FK CASCADE 正常不会留 run;旧库无 FK 兜底)
        this.deps.repo.finishRun(run.id, { state: 'FAILED', error: '计划已删除' })
        continue
      }
      if (schedule.state !== 'running') {
        // 计划已被手动改状态/停用:run 孤儿,直接收口不推进计划
        this.deps.repo.finishRun(run.id, { state: 'FAILED', error: '计划在途状态被外部变更' })
        continue
      }
      if (run.taskId) {
        const state = this.deps.getTaskState(run.taskId)
        if (state && !TERMINAL.has(state)) continue // 任务还在跑,等下一个 tick
        if (state === 'COMPLETED') {
          this.deps.repo.finishRun(run.id, { taskId: run.taskId, state: 'COMPLETED' })
          this.finalizeSuccess(schedule)
          continue
        }
        const err = state
          ? `channel 任务终态 ${state}`
          : (run.startedAt && now.getTime() - new Date(run.startedAt).getTime() > 3_600_000
              ? '任务记录已不存在(超 1 小时判失败)'
              : '')
        if (err) {
          this.deps.repo.finishRun(run.id, { taskId: run.taskId, state: 'FAILED', error: err })
          this.finalizeFailure(schedule, err)
        }
        // err 为空 = 任务行短暂不可读(竞态),下个 tick 重试
        continue
      }
      // 无 taskId 且长时间 RUNNING:提交悬死(进程曾崩溃于提交中)→ 收口
      if (now.getTime() - new Date(run.startedAt).getTime() > 3_600_000) {
        this.deps.repo.finishRun(run.id, { state: 'FAILED', error: '任务提交悬死(超 1 小时)' })
        this.finalizeFailure(schedule, '任务提交悬死')
      }
    }
  }

  /**
   * 触发一次(手动 run-now 与 timer 共用主路径):
   * 建 run → 计划翻 running/计数推进 → submitTask 下发 → 失败当场收口。
   * 成功路径的 run 收口由 reconcileRunning 在任务终态后完成。
   */
  async fire(schedule: ScheduledTaskRow, triggerKind: 'timer' | 'manual', now: Date = new Date()): Promise<FireResult> {
    if (schedule.state === 'running') return { ok: false, reason: 'already_running' }
    if (schedule.enabled !== 1) return { ok: false, reason: 'disabled' }
    // manual 也要过忙等守卫(timer 路径已过;此处保证两路语义一致)
    if (this.deps.channelHasActiveTasks(schedule.channelId)) {
      if (triggerKind === 'manual') {
        // 计划置 waiting:用户能直观看到"在等 Channel 收口";到期判定不受影响
        this.deps.repo.update(schedule.id, { state: 'waiting' })
      }
      return { ok: false, reason: 'channel_busy' }
    }
    const run = this.deps.repo.createRun({ scheduleId: schedule.id, triggerKind })
    const nextRunAt = computeNextRunAt(
      schedule.mode as 'interval' | 'daily',
      schedule.intervalMs,
      schedule.dailyTime,
      now,
    )
    this.deps.repo.update(schedule.id, {
      state: 'running',
      lastRunAt: now.toISOString(),
      nextRunAt,
      runCount: schedule.runCount + 1,
    })
    try {
      const task = await this.deps.submitTask({
        channelId: schedule.channelId,
        title: schedule.title,
        description: schedule.description,
      })
      // run 行保持 RUNNING 仅回填 taskId(ended_at 不动),收口统一走 reconcileRunning(任务终态后)
      this.deps.repo.attachTask(run.id, task.id)
      this.deps.repo.update(schedule.id, { lastTaskId: task.id })
      this.deps.repo.pruneRuns(schedule.id)
      console.log(`${L.p} 计划「${schedule.name}」已触发(${triggerKind})→ channel ${schedule.channelId.slice(0, 8)} 任务 ${task.id.slice(0, 8)}`)
      return { ok: true, runId: run.id, taskId: task.id }
    }
    catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.deps.repo.finishRun(run.id, { state: 'FAILED', error: message })
      this.finalizeFailure(this.deps.repo.findById(schedule.id) ?? schedule, message)
      console.error(`${L.p} 计划「${schedule.name}」触发失败:`, message)
      return { ok: false, error: message, runId: run.id }
    }
  }

  /** 成功收口:连续失败清零,计划回 idle(等待 next_run_at) */
  private finalizeSuccess(schedule: ScheduledTaskRow): void {
    this.deps.repo.update(schedule.id, { state: 'idle', consecutiveFailures: 0 })
  }

  /** 失败收口:失败计数推进;达熔断阈值 → 自动停用(state=failed) */
  private finalizeFailure(schedule: ScheduledTaskRow, error: string): void {
    const consecutive = schedule.consecutiveFailures + 1
    const tripped = schedule.maxConsecutiveFailures > 0 && consecutive >= schedule.maxConsecutiveFailures
    this.deps.repo.update(schedule.id, {
      state: tripped ? 'failed' : 'idle',
      failCount: schedule.failCount + 1,
      consecutiveFailures: consecutive,
      ...(tripped ? { enabled: 0 } : {}),
    })
    if (tripped) {
      console.warn(`${L.p} 计划「${schedule.name}」连续失败 ${consecutive} 次,已熔断停用: ${error}`)
    }
  }
}
