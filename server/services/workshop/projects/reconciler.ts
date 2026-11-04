/**
 * Project V1 自主 Reconciler（PR7）。
 *
 * 30s 定时对 active 项目做确定性对账：
 *   root 终态 → 工作项；COMPLETED → 成果 draft；逾期/缺失 → BLOCKED；过期审批。
 * 不调用 LLM；异常单项目隔离，不拖垮其他项目。
 */
import type { ProjectService } from './service'

export interface ProjectReconcilerHandle {
  stop: () => void
  tick: () => { projects: number, errors: Array<{ projectId: string, error: string }> }
}

export function startProjectReconciler(
  service: ProjectService,
  options: { intervalMs?: number } = {},
): ProjectReconcilerHandle {
  const intervalMs = Math.max(1000, Number(options.intervalMs ?? 30_000))
  const tick = (): { projects: number, errors: Array<{ projectId: string, error: string }> } => {
    const errors: Array<{ projectId: string, error: string }> = []
    let projects = 0
    for (const p of service.listActiveProjects()) {
      projects += 1
      try {
        service.reconcileInternal(p.id)
      }
      catch (err) {
        errors.push({ projectId: p.id, error: err instanceof Error ? err.message : String(err) })
      }
    }
    return { projects, errors }
  }
  const timer = setInterval(tick, intervalMs)
  // 不阻止进程退出（服务关闭由 close hook 显式 stop）。
  timer.unref?.()
  return {
    stop: () => clearInterval(timer),
    tick,
  }
}
