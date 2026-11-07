/**
 * PR17 M4 调度内核组装 —— EventIngress + Effects(outbox) + Watchdog 的单定时器编排。
 *
 * tick（默认 10s，S3）：
 *   1) 逐 active 项目消费事件（fast → reconcile；slow → 合并批投递 leader）；
 *   2) PR20 route 回调闭环：无条件对账 + 自动派发下一批就绪工作项（延迟上界 ≈ 1 tick）；
 *   3) 执行到期 effects（5s→300s 退避，3 次失败 dead+升级）；
 *   4) 每 N tick 独立 watchdog 扫描（预算/无进展/重复决策）。
 * 异常单项目隔离；各组件写 HealthBoard 心跳。
 */
import type { DatabaseSync } from 'node:sqlite'
import type { ProjectKernelRepo } from '../db/project-kernel.repo'
import { createEventIngress, type IngressProcessResult } from './event-ingress'
import { createEffectsOutbox, type DrainResult } from './effects'
import { createProjectWatchdog, type WatchdogFinding } from './watchdog'
import type { ProjectService } from './service'

export interface ProjectKernelOptions {
  tickMs?: number
  watchdogEveryTicks?: number
  slowPathEnabled?: boolean
  minSlowIntervalMs?: number
  nowMs?: () => number
}

export interface ProjectKernelDeps {
  db: DatabaseSync
  service: ProjectService
  kernelRepo: ProjectKernelRepo
  /** 慢路径投递：向办公室频道 lead 发送合并评估请求（requireReply）。 */
  sendMailbox: (projectId: string, text: string) => Promise<void> | void
  /** owner 通知落库。 */
  notifyOwner: (projectId: string, title: string, body: string, eventId: string) => Promise<void> | void
}

export interface KernelTickResult {
  projects: number
  reconciles: number
  ingress: Array<IngressProcessResult & { projectId: string }>
  effects: DrainResult
  watchdog: Array<{ projectId: string, findings: WatchdogFinding[] }>
  /** PR20 route 自动派发结果（每项目一项；skippedByGate=true 表示未开启/未批准/单飞占用） */
  autoDispatch: Array<{ projectId: string, dispatched: Array<{ workItemId: string, taskId: string | null }>, failed: number, skippedByGate: boolean }>
  errors: Array<{ projectId: string, error: string }>
}

export interface ProjectKernelHandle {
  start: () => void
  stop: () => void
  tick: () => Promise<KernelTickResult>
  /** 单项目处理（API 手动触发用）。 */
  processProject: (projectId: string) => Promise<{ ingress: IngressProcessResult, effects: DrainResult, watchdog: WatchdogFinding[] }>
}

let kernelSingleton: ProjectKernelHandle | null = null

export function getProjectKernel(): ProjectKernelHandle {
  if (!kernelSingleton) throw new Error('ProjectKernel 未装配')
  return kernelSingleton
}

export function initProjectKernel(deps: ProjectKernelDeps, options: ProjectKernelOptions = {}): ProjectKernelHandle {
  const nowMs = options.nowMs ?? (() => Date.now())
  const tickMs = Math.max(1000, options.tickMs ?? 10_000)
  const watchdogEveryTicks = Math.max(1, options.watchdogEveryTicks ?? 3)
  const { db, service, kernelRepo } = deps

  const ingress = createEventIngress(db, kernelRepo, {
    nowMs,
    slowPathEnabled: options.slowPathEnabled ?? true,
    minSlowIntervalMs: options.minSlowIntervalMs ?? 10_000,
  })
  const watchdog = createProjectWatchdog(db, kernelRepo, { nowMs })

  const outbox = createEffectsOutbox(kernelRepo, {
    reconcile: async (effect) => {
      service.reconcileInternal(effect.projectId)
    },
    // Router v3 P0：任务状态回调的 durable 落点（重复回调幂等收敛 + 派发）。
    task_callback: async (effect) => {
      await service.runRouteLoop(effect.projectId)
    },
    mailbox: async (effect, payload) => {
      const ids = Array.isArray(payload.events) ? payload.events as string[] : []
      const rows = ids.map(id => db.prepare('SELECT type, created_at AS createdAt, payload_json AS payloadJson FROM project_events WHERE id = ?').get(id) as { type: string, createdAt: string, payloadJson: string } | undefined).filter(Boolean) as Array<{ type: string, createdAt: string, payloadJson: string }>
      // P1-5 批次级确定性摘要：按类型聚合计数 + 仅最新一条保留 payload 细节。
      // 旧实现逐条 200 字截断罗列，长批次下 leader 上下文线性膨胀。
      const byType = new Map<string, { n: number, last: { createdAt: string, payloadJson: string } }>()
      for (const r of rows) {
        const cur = byType.get(r.type)
        if (cur) {
          cur.n += 1
          if (r.createdAt > cur.last.createdAt) cur.last = { createdAt: r.createdAt, payloadJson: r.payloadJson }
        }
        else {
          byType.set(r.type, { n: 1, last: { createdAt: r.createdAt, payloadJson: r.payloadJson } })
        }
      }
      const lines = [...byType.entries()].map(([type, agg]) =>
        `- ${type} ×${agg.n}（最新 @ ${agg.last.createdAt}）${agg.last.payloadJson.slice(0, 200)}`)
      const text = [
        `[项目内核] 事件批次摘要（${rows.length} 条，按类型聚合；需要细节请用 project_get_status）：`,
        ...lines,
        '如有需要请用项目提案工具给出建议；无需要则忽略。',
      ].join('\n')
      await deps.sendMailbox(effect.projectId, text)
    },
    notify: async (effect, payload) => {
      const title = String(payload.title ?? '项目通知')
      const detail = String(payload.detail ?? payload.error ?? '')
      await deps.notifyOwner(effect.projectId, title, detail, effect.id)
    },
  }, { nowMs })

  const activeProjects = () => {
    try {
      return service.listActiveProjects().map(p => ({ id: p.id, planVersion: p.planVersion }))
    }
    catch {
      return []
    }
  }

  let tickCount = 0
  const tick = async (): Promise<KernelTickResult> => {
    tickCount += 1
    const result: KernelTickResult = { projects: 0, reconciles: 0, ingress: [], effects: { done: 0, retried: 0, dead: 0, escalated: [] }, watchdog: [], autoDispatch: [], errors: [] }
    const projects = activeProjects()
    result.projects = projects.length
    for (const p of projects) {
      try {
        const r = ingress.process(p.id)
        result.ingress.push({ projectId: p.id, ...r })
        // PR20 route 回调主路径：无条件 reconcile（幂等且便宜）+ 立即派发下一批就绪项 ——
        // 「Channel root 终态 → 工作项收敛 → 下游 DISPATCHED」延迟上界 ≈ 1 tick。
        const route = await service.runRouteLoop(p.id)
        result.reconciles += 1
        result.autoDispatch.push({ projectId: p.id, ...route.autoDispatch })
        kernelRepo.health.heartbeat(p.id, 'ingress', true)
      }
      catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        result.errors.push({ projectId: p.id, error: message })
        try {
          kernelRepo.health.heartbeat(p.id, 'ingress', false, message)
        }
        catch { /* health 写失败不拖垮 tick */ }
      }
    }
    try {
      result.effects = await outbox.drain()
      for (const p of projects) kernelRepo.health.heartbeat(p.id, 'effects', true)
    }
    catch (err) {
      result.errors.push({ projectId: '*', error: err instanceof Error ? err.message : String(err) })
    }
    if (tickCount % watchdogEveryTicks === 0) {
      for (const p of projects) {
        try {
          const findings = watchdog.scanProject(p.id, p.planVersion)
          result.watchdog.push({ projectId: p.id, findings })
          if (findings.length === 0) watchdog.heartbeat(p.id)
        }
        catch (err) {
          result.errors.push({ projectId: p.id, error: err instanceof Error ? err.message : String(err) })
        }
      }
    }
    return result
  }

  const processProject = async (projectId: string) => {
    const r = ingress.process(projectId)
    // PR20：无条件 route 闭环（对账 + 自动派发），与 tick 同口径（API 手动触发即可验收）。
    const route = await service.runRouteLoop(projectId)
    const effects = await outbox.drain()
    const findings = watchdog.scanProject(projectId, service.listActiveProjects().find(p => p.id === projectId)?.planVersion ?? 0)
    return { ingress: r, reconcile: route.reconcile, autoDispatch: route.autoDispatch, effects, watchdog: findings }
  }

  const handle: ProjectKernelHandle = {
    start: () => {
      // dead-man：接管时把上次运行遗留健康行标记 stale。
      for (const p of activeProjects()) {
        try {
          watchdog.deadManSweep(p.id)
        }
        catch { /* 忽略 */ }
      }
      const timer = setInterval(() => {
        void tick().catch(() => { /* tick 内已逐项隔离 */ })
      }, tickMs)
      timer.unref?.()
      ;(handle as { _timer?: NodeJS.Timeout })._timer = timer
    },
    stop: () => {
      const timer = (handle as { _timer?: NodeJS.Timeout })._timer
      if (timer) clearInterval(timer)
    },
    tick,
    processProject,
  }
  kernelSingleton = handle
  return handle
}
