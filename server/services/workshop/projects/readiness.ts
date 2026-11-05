/**
 * Router v3 P0：统一就绪谓词（手动派发 / route 自动派发 / observability 共用）。
 *
 * 两套口径：
 *  - legacy：上游工作项进入 COMPLETED/CANCELED/SUPERSEDED 即放行（PR20 行为，零突变）；
 *  - technical：上游工作项 COMPLETED **且**成果已通过技术验收（reviewed/approved）才放行；
 *    CANCELED/SUPERSEDED 不再默认放行（需 owner waiver，走交付物豁免）。
 *
 * 就绪判定只读，不写库；派发 CAS 由 service 的 claim 步骤完成。
 */
import { parseJson } from '../db/database'
import type { ProjectDeliverableRow, ProjectResultRow, ProjectWorkItemRow } from '../db/project.repo'

export type WaitingOn =
  | 'READY'
  | 'IN_FLIGHT'
  | 'DEFERRED'
  | 'DEPENDENCY_NOT_STARTED'
  | 'DEPENDENCY_RUNNING'
  | 'RESULT_SUBMISSION'
  | 'TECHNICAL_REVIEW'
  | 'UPSTREAM_CANCELED'
  | 'DELIVERABLE_GATE'

export interface ReadinessVerdict {
  ready: boolean
  waitingOn: WaitingOn
  reason: string
  /** 已技术验收的上游成果（handoff 用；只含 reviewed/approved）。 */
  upstreamResultIds: string[]
}

export interface ReadinessContext {
  items: ProjectWorkItemRow[]
  results: ProjectResultRow[]
  deliverables: ProjectDeliverableRow[]
  routingPolicy: string
  nowMs?: number
}

const LEGACY_DEP_SATISFIED = new Set(['COMPLETED', 'CANCELED', 'SUPERSEDED'])
const RESULT_TECH_OK = new Set(['reviewed', 'approved'])

function isTechnicalPolicy(policy: string): boolean {
  return policy === 'technical'
}

/** 工作项全部成果按创建时间升序（version 单调，取尾部即最新）。 */
function latestResultFor(results: ProjectResultRow[], workItemId: string): ProjectResultRow | undefined {
  let latest: ProjectResultRow | undefined
  for (const r of results) {
    if (r.workItemId !== workItemId || r.status === 'superseded') continue
    if (!latest || r.version >= latest.version) latest = r
  }
  return latest
}

function technicalResultFor(results: ProjectResultRow[], workItemId: string): ProjectResultRow | undefined {
  let chosen: ProjectResultRow | undefined
  for (const r of results) {
    if (r.workItemId !== workItemId || !RESULT_TECH_OK.has(r.status)) continue
    if (!chosen || r.version >= chosen.version) chosen = r
  }
  return chosen
}

export function evaluateWorkItemReadiness(workItem: ProjectWorkItemRow, ctx: ReadinessContext): ReadinessVerdict {
  const nowMs = ctx.nowMs ?? Date.now()
  if (workItem.state !== 'DRAFT') {
    return { ready: false, waitingOn: 'IN_FLIGHT', reason: `工作项状态 ${workItem.state}`, upstreamResultIds: [] }
  }
  if (workItem.currentAttemptId) {
    return { ready: false, waitingOn: 'IN_FLIGHT', reason: '工作项已有在飞 attempt', upstreamResultIds: [] }
  }
  if (workItem.deferredUntil && Date.parse(workItem.deferredUntil) > nowMs) {
    return { ready: false, waitingOn: 'DEFERRED', reason: `延后至 ${workItem.deferredUntil}`, upstreamResultIds: [] }
  }
  if (workItem.attemptCount >= workItem.maxAttempts && workItem.state === 'DRAFT' && workItem.attemptCount > 0) {
    return { ready: false, waitingOn: 'UPSTREAM_CANCELED', reason: `已达最大尝试次数 ${workItem.maxAttempts}`, upstreamResultIds: [] }
  }

  const byId = new Map(ctx.items.map(w => [w.id, w]))
  const deps = parseJson<string[]>(workItem.dependsOnJson, [])
  const technical = isTechnicalPolicy(ctx.routingPolicy)
  const upstreamResultIds: string[] = []

  for (const depId of deps) {
    const dep = byId.get(depId)
    if (!dep) {
      return { ready: false, waitingOn: 'DEPENDENCY_NOT_STARTED', reason: `依赖工作项不存在: ${depId}`, upstreamResultIds }
    }
    if (!technical) {
      if (!LEGACY_DEP_SATISFIED.has(dep.state)) {
        return { ready: false, waitingOn: 'DEPENDENCY_RUNNING', reason: `依赖工作项「${dep.title}」未完成(${dep.state})`, upstreamResultIds }
      }
      continue
    }
    if (dep.state === 'CANCELED' || dep.state === 'SUPERSEDED') {
      return { ready: false, waitingOn: 'UPSTREAM_CANCELED', reason: `依赖工作项「${dep.title}」被取消/替代，需 owner 豁免`, upstreamResultIds }
    }
    if (dep.state === 'FAILED' || dep.state === 'BLOCKED' || dep.state === 'REWORK') {
      return { ready: false, waitingOn: 'DEPENDENCY_NOT_STARTED', reason: `依赖工作项「${dep.title}」失败/阻塞/待返工(${dep.state})`, upstreamResultIds }
    }
    if (dep.state !== 'COMPLETED') {
      return { ready: false, waitingOn: 'DEPENDENCY_RUNNING', reason: `依赖工作项「${dep.title}」未完成(${dep.state})`, upstreamResultIds }
    }
    const tech = technicalResultFor(ctx.results, dep.id)
    if (!tech) {
      const latest = latestResultFor(ctx.results, dep.id)
      if (latest?.status === 'submitted') {
        return { ready: false, waitingOn: 'TECHNICAL_REVIEW', reason: `上游「${dep.title}」成果待技术验收`, upstreamResultIds }
      }
      return { ready: false, waitingOn: 'RESULT_SUBMISSION', reason: `上游「${dep.title}」尚未产出可验收成果`, upstreamResultIds }
    }
    upstreamResultIds.push(tech.id)
  }

  if (technical) {
    const deliverableById = new Map(ctx.deliverables.map(d => [d.id, d]))
    // 交付物图（project_deliverables.depends_on_json）：technical 口径要求上游交付物已验收/豁免。
    const ownDeliverable = deliverableById.get(workItem.deliverableId)
    for (const depId of parseJson<string[]>(ownDeliverable?.dependsOnJson ?? '[]', [])) {
      const depDeliverable = deliverableById.get(depId)
      if (!depDeliverable) continue
      if (!['approved', 'waived'].includes(depDeliverable.status)) {
        return { ready: false, waitingOn: 'DELIVERABLE_GATE', reason: `交付物依赖「${depDeliverable.name}」未验收(${depDeliverable.status})`, upstreamResultIds }
      }
    }
  }

  return { ready: true, waitingOn: 'READY', reason: '依赖满足', upstreamResultIds }
}

/** 兼容旧调用：只按 legacy 口径筛 DRAFT + 依赖终态。 */
export function selectReadyWorkItemsWithContext(ctx: ReadinessContext): ProjectWorkItemRow[] {
  return ctx.items
    .filter(w => evaluateWorkItemReadiness(w, ctx).ready)
    .sort((a, b) =>
      (b.priority ?? 0) - (a.priority ?? 0)
      || a.createdAt.localeCompare(b.createdAt))
}
