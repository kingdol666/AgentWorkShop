/**
 * AgentTeam task guardrails: deterministic root lineage, depth and quota checks.
 * This module is deliberately side-effect free; TaskEngine remains the write authority.
 */
import type { TaskMetaRow, TaskRepo } from '../../db/task.repo'
import type { TaskState, WorkspaceTask } from '../../types/task'
import { AppError } from '../../../../utils/errors'
import { workshopSettings } from '../../settings'

const TERMINAL = new Set<TaskState>(['COMPLETED', 'FAILED', 'CANCELED'])

export interface TaskBudget {
  rootId: string
  depth: number
  descendants: number
  active: number
  canceled: number
  limits: {
    descendants: number
    active: number
    canceled: number
    depth: number
  }
}

function childrenOf(repo: TaskRepo, channelId: string, parentId: string): TaskMetaRow[] {
  return repo.listChildrenMeta(channelId, parentId)
}

export function rootLineage(repo: TaskRepo, task: { channelId: string, id: string, parentId?: string | null }): { root: TaskMetaRow | null, depth: number } {
  let current: TaskMetaRow | null = repo.findById(task.id) as unknown as TaskMetaRow | null
  let depth = 0
  const seen = new Set<string>()
  while (current?.parentId) {
    if (seen.has(current.id)) break
    seen.add(current.id)
    depth += 1
    const parent = repo.findById(current.parentId) as unknown as TaskMetaRow | undefined
    if (!parent) break
    current = parent
  }
  return { root: current, depth }
}

function descendants(repo: TaskRepo, channelId: string, rootId: string): TaskMetaRow[] {
  const out: TaskMetaRow[] = []
  const queue = [rootId]
  const seen = new Set<string>(queue)
  while (queue.length) {
    const parentId = queue.shift()!
    for (const child of childrenOf(repo, channelId, parentId)) {
      if (seen.has(child.id)) continue
      seen.add(child.id)
      out.push(child)
      queue.push(child.id)
    }
  }
  return out
}

export function budgetFor(repo: TaskRepo, parent: WorkspaceTask): TaskBudget {
  const settings = workshopSettings()
  const lineage = rootLineage(repo, parent)
  const rootId = lineage.root?.id ?? parent.id
  const all = descendants(repo, parent.channelId, rootId)
  return {
    rootId,
    depth: lineage.depth,
    descendants: all.length,
    active: all.filter(t => !TERMINAL.has(t.state as TaskState)).length,
    canceled: all.filter(t => t.state === 'CANCELED').length,
    limits: {
      descendants: Math.max(1, Number(settings.max_descendants_per_root ?? 6)),
      active: Math.max(1, Number(settings.max_active_descendants_per_root ?? 4)),
      canceled: Math.max(0, Number(settings.max_canceled_descendants_per_root ?? 3)),
      depth: Math.max(0, Number(settings.max_task_depth ?? 1)),
    },
  }
}

export function assertDispatchAllowed(repo: TaskRepo, parent: WorkspaceTask): TaskBudget {
  const budget = budgetFor(repo, parent)
  const next = budget.descendants + 1
  if (budget.depth >= budget.limits.depth) {
    throw new AppError(409, 'TASK_DEPTH_EXCEEDED',
      `任务 ${budget.rootId.slice(0, 8)} 已达到最大拆解深度 ${budget.limits.depth}。请由 Lead 继续统筹，或使用有限 pipeline，不要让 worker 递归创建孙任务。`)
  }
  if (next > budget.limits.descendants) {
    throw new AppError(409, 'TASK_QUOTA_EXCEEDED',
      `根任务 ${budget.rootId.slice(0, 8)} 子任务预算已耗尽(${budget.descendants}/${budget.limits.descendants})。请复用已有任务、reassign 原任务或向用户报告阻塞，不要改标题重建。`)
  }
  if (budget.active >= budget.limits.active) {
    throw new AppError(409, 'TASK_ACTIVE_LIMIT',
      `根任务 ${budget.rootId.slice(0, 8)} 当前有 ${budget.active}/${budget.limits.active} 个活动子任务。请先验收/等待现有任务，或 reassign 原任务。`)
  }
  if (budget.canceled >= budget.limits.canceled) {
    throw new AppError(409, 'TASK_CANCEL_BUDGET_EXCEEDED',
      `根任务 ${budget.rootId.slice(0, 8)} 已达到取消预算(${budget.canceled}/${budget.limits.canceled})。禁止继续取消后改标题重派；请报告阻塞或复用已有成果。`)
  }
  return budget
}

export function isModeTask(task: WorkspaceTask): boolean {
  return /^\[mode:(goal|loop|pipeline)\]/.test(task.description ?? '')
}

export function isOrdinaryRoot(task: WorkspaceTask): boolean {
  return !task.parentId && !isModeTask(task)
}

export function activeDescendants(repo: TaskRepo, rootId: string, channelId: string): TaskMetaRow[] {
  return descendants(repo, channelId, rootId).filter(t => !TERMINAL.has(t.state as TaskState))
}
