/**
 * Project 计划 preflight / 物化(纯函数 + 仓储依赖)。
 *
 * 从 projects/service.ts 抽出的计划落地段:
 *  - preflightApprovedPlan: 批准/物化前的只读一致性校验(Channel/交付物/dedupe);
 *  - materializeApprovedPlan: 批准事务内创建/复用交付物与工作项、写依赖图与 plan.applied 事件。
 *
 * 调用方(ProjectService)负责事务边界与 plan 版本推进;本模块只做确定性写入,
 * 异常直接抛出由上层事务整体回滚(行为与原实现逐行一致)。
 */
import type { AgentChannelManager } from '../runtime/manager'
import type {
  ProjectChannelRepo,
  ProjectDeliverableRepo,
  ProjectDeliverableRow,
  ProjectEventRepo,
  ProjectRow,
  ProjectWorkItemRepo,
  ProjectWorkItemRow,
} from '../db/project.repo'
import { AppError } from '../../../utils/errors'
import { normalizeProjectPlan, resolveContractForMaterialize } from './plan-schema'

export interface PlanMaterializationContext {
  bindings: Pick<ProjectChannelRepo, 'listByProject'>
  manager: Pick<AgentChannelManager, 'getChannelForUser'>
  deliverables: Pick<ProjectDeliverableRepo, 'listByProject' | 'create' | 'update'>
  workItems: Pick<ProjectWorkItemRepo, 'listByProject' | 'create' | 'update'>
  events: Pick<ProjectEventRepo, 'append'>
}

/** Read-only validation required before approval or any plan materialization side effect. */
export function preflightApprovedPlan(ctx: PlanMaterializationContext, p: ProjectRow, plan: Record<string, unknown>): void {
  if (!Array.isArray(plan.deliverables)) return // legacy non-V1 approval payload
  const normalized = normalizeProjectPlan(plan)
  const channels = ctx.bindings.listByProject(p.id).filter(binding => binding.status === 'active')
  const resolveChannel = (ref: string): string => {
    const direct = channels.find(binding => binding.channelId === ref)
    if (direct) return direct.channelId
    const matches = channels.flatMap((binding) => {
      const channel = ctx.manager.getChannelForUser(binding.channelId, p.ownerUserId)
      return channel?.name === ref ? [binding.channelId] : []
    })
    if (matches.length !== 1) throw new AppError(409, matches.length ? 'PLAN_CHANNEL_AMBIGUOUS' : 'PLAN_CHANNEL_UNRESOLVED', `Channel ref ${ref} ${matches.length ? '不唯一' : '未绑定到当前 Project'}`)
    return matches[0]!
  }
  const resolvedChannels = new Map<string, string>()
  for (const deliverable of normalized.deliverables) if (deliverable.channelId) resolvedChannels.set(deliverable.channelId, resolveChannel(deliverable.channelId))
  for (const workItem of normalized.workItems) resolvedChannels.set(workItem.channelId, resolveChannel(workItem.channelId))

  const deliverables = ctx.deliverables.listByProject(p.id)
  const deliverableByName = new Map<string, ProjectDeliverableRow>()
  for (const deliverable of deliverables) {
    if (deliverableByName.has(deliverable.name)) throw new AppError(409, 'PLAN_DELIVERABLE_AMBIGUOUS', `交付物名称「${deliverable.name}」已有多个匹配项`)
    deliverableByName.set(deliverable.name, deliverable)
  }
  const existingItems = ctx.workItems.listByProject(p.id)
  const existingByDedupe = new Map<string, ProjectWorkItemRow>()
  for (const item of existingItems) {
    if (existingByDedupe.has(item.dedupeKey)) throw new AppError(409, 'PLAN_DEDUPE_AMBIGUOUS', `dedupeKey ${item.dedupeKey} 已有多个工作项`)
    existingByDedupe.set(item.dedupeKey, item)
  }
  const plannedDedupe = new Set<string>()
  for (const workItem of normalized.workItems) {
    const currentDeliverable = normalized.deliverables.find(deliverable => deliverable.key === workItem.deliverableKey)
    const currentDeliverableRow = currentDeliverable ? deliverableByName.get(currentDeliverable.name) : undefined
    const dedupeKey = workItem.dedupeKey ?? `${workItem.deliverableKey}:${resolvedChannels.get(workItem.channelId)}:${workItem.title}`
    if (plannedDedupe.has(dedupeKey)) throw new AppError(400, 'PLAN_INVALID', `物化后的工作项 dedupeKey 重复: ${dedupeKey}`)
    plannedDedupe.add(dedupeKey)
    const existing = existingByDedupe.get(dedupeKey)
    if (existing && (existing.state !== 'DRAFT' || !currentDeliverableRow || existing.title !== workItem.title || existing.channelId !== resolvedChannels.get(workItem.channelId) || existing.deliverableId !== currentDeliverableRow.id || existing.resultKey !== workItem.resultKey || existing.planVersion !== p.planVersion)) {
      throw new AppError(409, 'PLAN_DEDUPE_CONFLICT', `dedupeKey ${dedupeKey} 已被其他版本/状态/契约的工作项占用`)
    }
  }
}

/**
 * Owner 批准计划后同步物化；调用者必须在同一 SQLite transaction 中执行，异常向外传播以回滚全部写入。
 */
export function materializeApprovedPlan(ctx: PlanMaterializationContext, p: ProjectRow, version: number, plan: Record<string, unknown>): void {
  if (!Array.isArray(plan.deliverables)) return // 历史非 V1 plan payload 不触发物化
  const normalized = normalizeProjectPlan(plan)
  const channels = ctx.bindings.listByProject(p.id).filter(b => b.status === 'active')
  const resolveChannel = (ref: string): string => {
    const byId = channels.find(binding => binding.channelId === ref)
    if (byId) return byId.channelId
    const named = channels.flatMap((binding) => {
      const channel = ctx.manager.getChannelForUser(binding.channelId, p.ownerUserId)
      return channel?.name === ref ? [binding.channelId] : []
    })
    if (named.length !== 1) throw new AppError(409, named.length ? 'PLAN_CHANNEL_AMBIGUOUS' : 'PLAN_CHANNEL_UNRESOLVED', `Channel ref ${ref} ${named.length ? '不唯一' : '未绑定到当前 Project'}`)
    return named[0]!
  }
  const resolvedChannels = new Map<string, string>()
  for (const deliverable of normalized.deliverables) {
    if (deliverable.channelId) resolvedChannels.set(deliverable.channelId, resolveChannel(deliverable.channelId))
  }
  for (const workItem of normalized.workItems) resolvedChannels.set(workItem.channelId, resolveChannel(workItem.channelId))

  const existingDeliverables = ctx.deliverables.listByProject(p.id)
  const existingWorkItems = ctx.workItems.listByProject(p.id)
  const existingDedupe = new Map(existingWorkItems.map(workItem => [workItem.dedupeKey, workItem]))
  const planDedupe = new Set<string>()
  for (const workItem of normalized.workItems) {
    const channelId = resolvedChannels.get(workItem.channelId)!
    const dedupeKey = workItem.dedupeKey ?? `${workItem.deliverableKey}:${channelId}:${workItem.title}`
    if (planDedupe.has(dedupeKey)) throw new AppError(400, 'PLAN_INVALID', `物化后的工作项 dedupeKey 重复: ${dedupeKey}`)
    planDedupe.add(dedupeKey)
    const existing = existingDedupe.get(dedupeKey)
    if (existing && (existing.title !== workItem.title || existing.channelId !== channelId || existing.deliverableId !== existingDeliverables.find(d => d.name === normalized.deliverables.find(x => x.key === workItem.deliverableKey)?.name)?.id)) {
      throw new AppError(409, 'PLAN_DEDUPE_CONFLICT', `dedupeKey ${dedupeKey} 已被不同的工作项占用`)
    }
    if (existing && existing.state !== 'DRAFT') throw new AppError(409, 'PLAN_DEDUPE_CONFLICT', `dedupeKey ${dedupeKey} 已对应非 DRAFT 工作项 ${existing.id}`)
  }
  const existingNames = new Map<string, ProjectDeliverableRow>()
  for (const deliverable of existingDeliverables) {
    if (existingNames.has(deliverable.name)) throw new AppError(409, 'PLAN_DELIVERABLE_AMBIGUOUS', `交付物名称「${deliverable.name}」已有多个匹配项`)
    existingNames.set(deliverable.name, deliverable)
  }
  const deliverableIdByKey = new Map<string, string>()
  let createdDeliverables = 0
  for (const deliverable of normalized.deliverables) {
    const existing = existingNames.get(deliverable.name)
    if (existing) {
      deliverableIdByKey.set(deliverable.key, existing.id)
      continue
    }
    const created = ctx.deliverables.create({
      projectId: p.id,
      name: deliverable.name,
      description: deliverable.description,
      ownerChannelId: deliverable.channelId ? resolvedChannels.get(deliverable.channelId)! : null,
      required: deliverable.required ? 1 : 0,
      acceptanceCriteriaJson: JSON.stringify(deliverable.acceptanceCriteria),
      createdBy: 'project_leader',
    })
    deliverableIdByKey.set(deliverable.key, created.id)
    existingNames.set(deliverable.name, created)
    createdDeliverables++
  }
  for (const deliverable of normalized.deliverables) {
    const deliverableId = deliverableIdByKey.get(deliverable.key)!
    const dependencies = deliverable.dependsOn.map((key) => {
      const dependencyId = deliverableIdByKey.get(key)
      if (!dependencyId) throw new AppError(409, 'PLAN_MATERIALIZE_REFERENCE_MISSING', `交付物 ${deliverable.name} 的依赖 ${key} 未解析`)
      return dependencyId
    })
    ctx.deliverables.update(deliverableId, { dependsOnJson: JSON.stringify(dependencies) })
  }

  const itemByDedupe = new Map(existingWorkItems.map(workItem => [workItem.dedupeKey, workItem]))
  const workItemIdByKey = new Map<string, string>()
  const warnings: string[] = []
  let createdWorkItems = 0
  for (const workItem of normalized.workItems) {
    const channelId = resolvedChannels.get(workItem.channelId)!
    const dedupeKey = workItem.dedupeKey ?? `${workItem.deliverableKey}:${channelId}:${workItem.title}`
    const deliverableId = deliverableIdByKey.get(workItem.deliverableKey)
    if (!deliverableId) throw new AppError(409, 'PLAN_MATERIALIZE_REFERENCE_MISSING', `工作项 ${workItem.title} 的交付物未解析`)
    const existing = itemByDedupe.get(dedupeKey)
    if (existing) {
      // 已批准的 replan 复用了仍在 DRAFT 的工作项:必须把 plan 内容同步到新版本,
      // 否则执行仍按旧 brief/验收标准跑(preflight 只校验 key 维度,内容变更需在此落地)。
      ctx.workItems.update(existing.id, {
        deliverableId,
        channelId,
        title: workItem.title,
        brief: workItem.brief,
        acceptanceJson: JSON.stringify(workItem.acceptanceCriteria),
        resultKey: workItem.resultKey,
        execBudgetMinutes: workItem.execBudgetMinutes,
        contractJson: JSON.stringify(workItem.contract ?? {}),
        dedupeKey,
        planVersion: version,
      })
      workItemIdByKey.set(workItem.key, existing.id)
      continue
    }
    const created = ctx.workItems.create({
      projectId: p.id,
      deliverableId,
      channelId,
      title: workItem.title,
      brief: workItem.brief,
      dependsOnJson: '[]',
      acceptanceJson: JSON.stringify(workItem.acceptanceCriteria),
      resultKey: workItem.resultKey,
      planVersion: version,
      execBudgetMinutes: workItem.execBudgetMinutes,
      contractJson: JSON.stringify(workItem.contract ?? {}),
      traceId: `plan:${p.id}:${version}:${workItem.key}`,
      dedupeKey,
      createdBy: 'project_leader',
    })
    workItemIdByKey.set(workItem.key, created.id)
    itemByDedupe.set(dedupeKey, created)
    createdWorkItems++
  }
  for (const workItem of normalized.workItems) {
    const id = workItemIdByKey.get(workItem.key)
    if (!id) throw new AppError(409, 'PLAN_MATERIALIZE_REFERENCE_MISSING', `工作项 ${workItem.title} 未物化`)
    const dependencies = workItem.dependsOn.map((key) => {
      const dependencyId = workItemIdByKey.get(key)
      if (!dependencyId) throw new AppError(409, 'PLAN_MATERIALIZE_DEPENDENCY_MISSING', `工作项 ${workItem.title} 的依赖 ${key} 未物化`)
      return dependencyId
    })
    const contract = resolveContractForMaterialize(workItem.contract, workItemIdByKey)
    ctx.workItems.update(id, { dependsOnJson: JSON.stringify(dependencies), contractJson: JSON.stringify(contract) })
  }
  ctx.events.append({
    projectId: p.id,
    type: 'plan.applied',
    eventKey: `plan:${p.id}:${version}:applied`,
    payloadJson: JSON.stringify({ version, createdDeliverables, createdWorkItems, warnings }),
    traceId: `plan:${p.id}:${version}`,
  })
}
