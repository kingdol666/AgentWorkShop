/**
 * 依赖健康与有界恢复(Task 10)。
 *
 * 现场形态:慢回合、RPC ready 超时、进程退出重建、限流与预算耗尽混在一起,
 * 结果只能看到"超时"一个标签。这里把 provider / RPC / 进程 / 预算 / 排队 / 进展
 * 分开判定,并规定**有副作用的步骤在效果未知时禁止任何自动恢复**(换模型/重试也不行)。
 */
export type DependencyAction = 'continue' | 'wait' | 'retry' | 'fallback_readonly' | 'attention_required' | 'failed'

export interface DependencyHealth {
  provider: 'ok' | 'degraded' | 'down'
  rpc: 'ready' | 'ready_timeout' | 'closed'
  process: 'alive' | 'exited'
  budget: 'ok' | 'exhausted'
  rateLimited: boolean
  queueDepth: number
  /** 最近一次实质进展(接受/就绪/输出)时间;null = 从未 */
  lastProgressAt: string | null
  /** 正在等待人审 —— 不得被无活动时钟误杀 */
  waitingForApproval: boolean
  /** 本轮是否已执行过可能产生副作用的步骤且结果不明 */
  effectUnknown: boolean
}

export interface JobCapability {
  /** 该步骤是否可能产生副作用(设备写/外部提交) */
  effectful: boolean
  /** 是否有批准的能力等价只读降级 */
  readonlyFallbackAllowed: boolean
}

export interface DependencyDecision {
  action: DependencyAction
  reasons: string[]
}

export function decideDependencyAction(state: DependencyHealth, job: JobCapability): DependencyDecision {
  const reasons: string[] = []
  // 最高优先:副作用未知 → 人工核对,不重试、不降级、不换模型
  if (state.effectUnknown && job.effectful) {
    return { action: 'attention_required', reasons: ['EFFECT_UNKNOWN: 副作用步骤结果不明,先对账,禁止自动重发或降级'] }
  }
  if (state.waitingForApproval) return { action: 'wait', reasons: ['WAITING_FOR_HUMAN'] }
  if (state.budget === 'exhausted') {
    return { action: 'failed', reasons: ['BUDGET_EXHAUSTED: 保留既有上限,不通过延长超时绕开'] }
  }
  if (state.rateLimited) return { action: 'wait', reasons: ['RATE_LIMITED'] }
  if (state.provider === 'down' && state.process === 'exited' && state.rpc === 'closed') {
    if (!job.effectful && job.readonlyFallbackAllowed) {
      return { action: 'fallback_readonly', reasons: ['PROVIDER_DOWN: 仅批准的能力等价只读降级'] }
    }
    return { action: 'attention_required', reasons: ['PROVIDER_DOWN: 无批准降级路径,交值班处理'] }
  }
  if (state.process === 'exited') {
    return { action: 'retry', reasons: ['PROCESS_EXIT: 重建后重试(有界)'] }
  }
  if (state.rpc === 'ready_timeout') {
    return { action: 'retry', reasons: ['RPC_READY_TIMEOUT: 清理本次拥有的进程后重试'] }
  }
  if (state.provider === 'degraded') {
    reasons.push('PROVIDER_DEGRADED')
    // 慢但有实质进展不当作故障
    if (state.lastProgressAt) return { action: 'continue', reasons: [...reasons, 'HAS_PROGRESS'] }
    if (state.queueDepth > 0) return { action: 'wait', reasons: [...reasons, 'QUEUED'] }
    return { action: 'retry', reasons: [...reasons, 'NO_PROGRESS'] }
  }
  return { action: 'continue', reasons: ['HEALTHY'] }
}
