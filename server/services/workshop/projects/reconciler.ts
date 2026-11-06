/**
 * Project V1 自主 Reconciler（PR7）。
 *
 * 30s 定时对 active 项目做确定性对账（PR20 起 = runRouteLoop：对账 + Route 自动派发，
 * 与内核 tick 同口径）：
 *   root 终态 → 工作项；COMPLETED → 成果 draft；逾期/缺失 → BLOCKED；过期审批；
 *   auto_dispatch=1 的项目随后自动派发下一批就绪工作项（回调闭环兜底路径）。
 * 不调用 LLM；异常单项目隔离，不拖垮其他项目。
 */
import type { ProjectService } from './service'

export interface ProjectReconcilerHandle {
  stop: () => void
  tick: () => Promise<{ projects: number, errors: Array<{ projectId: string, error: string }> }>
}

export function startProjectReconciler(
  service: ProjectService,
  options: { intervalMs?: number } = {},
): ProjectReconcilerHandle {
  const intervalMs = Math.max(1000, Number(options.intervalMs ?? 30_000))
  const tick = async (): Promise<{ projects: number, errors: Array<{ projectId: string, error: string }> }> => {
    const errors: Array<{ projectId: string, error: string }> = []
    let projects = 0
    for (const p of service.listActiveProjects()) {
      projects += 1
      try {
        await service.runRouteLoop(p.id)
      }
      catch (err) {
        errors.push({ projectId: p.id, error: err instanceof Error ? err.message : String(err) })
      }
    }
    return { projects, errors }
  }
  const timer = setInterval(() => {
    void tick().catch(() => { /* tick 内已逐项隔离 */ })
  }, intervalMs)
  // 不阻止进程退出（服务关闭由 close hook 显式 stop）。
  timer.unref?.()
  return {
    stop: () => clearInterval(timer),
    tick,
  }
}
