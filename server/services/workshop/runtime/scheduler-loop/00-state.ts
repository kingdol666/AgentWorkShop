/**
 * SchedulerLoopLayer00 —— 状态字段 / 启停 / 定时唤醒 / 重投递回调
 * (分层 1/5,承 SchedulerLoopContracts;方法体与原文件逐行一致)
 */
import { SchedulerLoopContracts } from './contracts'
import type { AgentRuntime } from '../agent-runtime'
import type { ChannelMail } from '../../types/a2a'
import type { ChannelRuntime } from '../channel-runtime'
import type { ExecutionMode } from '../../agents/agent-interface'
import type { ModeConfig, LoopController } from '../execution-mode'
import type { SchedulerLoopOptions } from './types'

export abstract class SchedulerLoopLayer00 extends SchedulerLoopContracts {
  protected readonly tickMs: number
  protected readonly stallMs: number
  protected readonly supervisionMail: ((limit: number) => ChannelMail[]) | null
  protected readonly toolActivityOf: ((agentId: string) => number | null) | null
  /** Lead 决策留痕(§7.1 lead.*;manager 注入 → Channel shared memory) */
  protected readonly onLeadDecision: SchedulerLoopOptions['onLeadDecision']
  /** supervise 节流:最小间隔与最近一次执行时刻/信号指纹(token 效率) */
  protected lastSuperviseAt = 0
  protected lastFingerprint = ''
  protected timer: NodeJS.Timeout | null = null
  protected started = false
  protected running = false
  protected activeRound: Promise<void> | null = null
  protected pendingWake = false
  protected tick = 0
  /** 已催办一次的 WORKING 任务(再次停滞 → cancel) */
  protected readonly notified = new Set<string>()
  /** WORKING 任务最近一次 progress 与时间(停滞检测) */
  protected readonly lastProgress = new Map<string, { progress: number, at: number }>()
  /** busy 成员执行中任务的进度基线(与 lastProgress 分离:busy 不重置——
   *  独立检测"忙碌但进度长期不变"的停滞,喂给快照的 stalled 标记) */
  protected readonly progressSeen = new Map<string, { progress: number, at: number }>()
  /** 成员空闲起始时间(最久空闲 worker 排序) */
  protected readonly idleSince = new Map<string, number>()
  /** 当前活跃的执行模式(null = 默认无模式) */
  protected activeMode: ExecutionMode | null = null
  protected activeModeConfig: ModeConfig = {}
  /** loop 模式控制器 */
  protected loopController: LoopController | null = null
  /** 已通知 loop 控制器的完成任务,避免每轮 tick 重复计数 */
  protected readonly loopCompletedTaskIds = new Set<string>()
  /** 调度器启动时刻(loop 完成识别基线;防进程重启后重放重启前的 loop 主任务) */
  protected readonly bootAt = Date.now()
  /** loop 模式下重新提交任务的回调 */
  protected onLoopResubmit: ((title: string, description: string) => void) | null = null

  constructor(
    protected readonly channelRuntime: ChannelRuntime,
    protected readonly lead: AgentRuntime,
    options: SchedulerLoopOptions = {},
  ) {
    super()
    this.tickMs = options.tickMs ?? 1000
    this.stallMs = options.stallMs ?? 300000
    this.supervisionMail = options.supervisionMail ?? null
    this.toolActivityOf = options.toolActivityOf ?? null
    this.onLeadDecision = options.onLeadDecision
  }

  /** Lead 决策留痕(异常绝不阻断调度) */
  protected noteLeadDecision(e: { decision: string, taskId?: string, toAgentId?: string, reason?: string, rootId?: string }): void {
    try {
      this.onLeadDecision?.({ channelId: this.channelRuntime.channelId, agentId: this.lead.agentId, ...e })
    }
    catch {
      // 记忆写入失败不得影响调度主流程
    }
  }

  /** 空闲退避:快照指纹连续不变的轮数(决定下次 tick 间隔) */
  protected idleStreak = 0
  /** 上一轮快照指纹(空闲判定) */
  protected lastRoundFingerprint = ''

  /** 启动调度(自重排 setTimeout:tick 间隔可按空闲状态退避) */
  start(): void {
    if (this.started) return
    this.started = true
    this.scheduleNext(this.tickMs)
  }

  /** 事件唤醒(任务状态变化即调):空闲退避中的循环立即恢复快节奏 */
  wake(): void {
    if (!this.started) return
    if (this.running) {
      this.pendingWake = true
      return
    }
    this.clearTimer()
    this.launchRound()
  }

  /** Start exactly one tracked round; shutdown awaits this promise before DB/runtime teardown. */
  protected launchRound(): void {
    if (this.activeRound) return
    const round = this.runRound()
    this.activeRound = round
    void round.finally(() => {
      if (this.activeRound === round) this.activeRound = null
    })
  }

  protected clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  protected scheduleNext(delayMs: number): void {
    this.clearTimer()
    this.timer = setTimeout(() => {
      this.timer = null
      this.wake()
    }, delayMs)
    this.timer.unref?.()
  }

  stop(): void {
    this.started = false
    this.clearTimer()
    this.pendingWake = false
    if (this.loopController) {
      this.loopController.stop()
      this.loopController = null
    }
    this.loopCompletedTaskIds.clear()
  }

  /** Stop scheduling and await an already-running supervision round. */
  async stopAndWait(): Promise<void> {
    this.stop()
    // A supervision round may be awaiting a persistent harness indefinitely.
    // Shutdown is an explicit hard-stop boundary, so abort only the Lead runtime
    // supervision/run before awaiting the tracked round; normal watchdog never does this.
    this.lead.abortCurrent()
    const active = this.activeRound
    if (active) await active.catch(() => {})
  }

  /** 设置 loop 模式重新提交回调(manager 注入 submitChannelTask) */
  setLoopResubmitCallback(fn: (title: string, description: string) => void): void {
    this.onLoopResubmit = fn
  }

  // ===== 内部 =====
}
