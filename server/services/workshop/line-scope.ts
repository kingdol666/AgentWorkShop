/**
 * REST 数据面 → 产线授权解析(2026-10-28 审计修复 S4)。
 *
 * 背景:工具面有 grant-guard/tool-verify 双层产线校验,但大量 REST 读数/删除端点
 * 只有 `resolveUser` —— 任意登录用户可读全量产线配方参数、写账本、PLC 实时值,
 * 甚至删除配方/关闭批次。本模块把"资源 → 产线"的解析收敛到一处,配合
 * permissions.requireLineMode 让 REST 与工具面同口径。
 *
 * 约定:
 *  - 资源不存在时返回 null,由路由负责 404(避免把"不存在"误报成 403)。
 *  - 列表用 filterByLine(admin/特权返回全集)。
 */
import { AppError } from '../../utils/errors'
import { filterByLine, requireLineMode } from './permissions'
import { getDcwRecipeRepo } from './dcw/dcw-recipe.repo'
import { getDcwController } from './dcw/dcw-controller'
import { getDcwParamRepo } from './dcw/param-map.repo'
import { getDaqNodeRepo } from './daq/daq-node.repo'
import { getRecipeRollBackManager } from './dcw/recipe-rollback-manager'

export interface ScopedUser {
  id: string
  role: string
}

/** 配方 → 产线 */
export function recipeLineId(recipeId: string): string | null {
  return getDcwRecipeRepo().byId(recipeId)?.lineId ?? null
}

/** 数控节点 → 产线 */
export function dcwNodeLineId(nodeId: string): string | null {
  return getDcwController().byId(nodeId)?.lineId ?? null
}

/** 数采节点 → 产线 */
export function daqNodeLineId(nodeId: string): string | null {
  return getDaqNodeRepo().byId(nodeId)?.lineId ?? null
}

/** 工艺参数 → 执行节点 → 产线 */
export function paramLineId(paramId: string): string | null {
  const row = getDcwParamRepo().byId(paramId)
  if (!row) return null
  return dcwNodeLineId(row.nodeId)
}

/** 批次 → 产线 */
export function runLineId(runId: string): string | null {
  return getDcwRecipeRepo().runById(runId)?.lineId ?? null
}

/** 优化记录 → 产线 */
export function optimizationLineId(recordId: string): string | null {
  return getRecipeRollBackManager().recordById(recordId)?.lineId ?? null
}

/**
 * 解析并校验:资源不存在 → 404;无该线权限 → 403。
 * need='readonly' 允许只读/操控;need='operate' 仅操控。
 */
export function requireLineForResource(
  user: ScopedUser,
  lineId: string | null | undefined,
  resourceLabel: string,
  need: 'readonly' | 'operate' = 'readonly',
): void {
  if (!lineId) {
    // 未分配产线的资源(独立节点/遗留数据):与 permissions 的"无记录=不可见"同口径,
    // 仅 admin 可见;否则拒绝,避免成为绕过产线隔离的旁路。
    if (user.role === 'admin') return
    throw new AppError(403, 'LINE_FORBIDDEN', `${resourceLabel}未归属产线,仅管理员可访问`)
  }
  requireLineMode(user, lineId, need)
}

/** 列表按产线过滤(admin 见全集;无授权线的条目被剔掉) */
export function filterRowsByLine<T>(user: ScopedUser, rows: T[], lineIdOf: (row: T) => string | null | undefined): T[] {
  return filterByLine(user, rows, lineIdOf)
}
