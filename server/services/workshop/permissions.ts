/**
 * 产线级权限服务 —— 用户 × 产线的三态访问控制(none / readonly / operate)。
 *
 * 模型:
 *   - admin / editor:全量全权(运营管理角色,不受 grant 约束);
 *   - user(普通用户):默认无任何产线权限,由管理员在权限管理页逐线授予:
 *       readonly = 仅查看(数采节点读取;无数控/写向能力)
 *       operate  = 可操控(数采读取 + 数控写向 + 产线操作全量)
 *     无记录 = none(后端数据面直接不返回该产线信息)。
 *
 * 消费方:
 *   - dcw/daq 列表 API(可见性过滤);
 *   - dcw 写控 / 数采下发 / 产线启停(操控能力校验);
 *   - agent-node-bindings 绑定校验(只能绑定有权产线的节点);
 *   - 插件 ctx.permissions(SDK 拓展面,见 plugins/host.mjs)。
 * 权限变更广播:scene-events 'permissions.changed' + 插件钩子 'permissions:changed'。
 */
import { userRepository } from '@/server/repositories/user.repository'
import { AppError } from '@/server/utils/errors'
import type { ResolvedUser } from '@/server/api/workshop/caller'

export type LineMode = 'none' | 'readonly' | 'operate'
export type GrantMode = 'readonly' | 'operate'

/** 管理角色(admin/editor)不受产线 grant 约束 */
export function isPrivilegedRole(user: { role: string } | null | undefined): boolean {
  return user?.role === 'admin' || user?.role === 'editor'
}

/** 用户对某产线的有效访问模式 */
export function lineMode(user: ResolvedUser | { id: string, role: string }, lineId: string | null | undefined): LineMode {
  if (!lineId) return isPrivilegedRole(user) ? 'operate' : 'none'
  if (isPrivilegedRole(user)) return 'operate'
  const grant = userRepository.lineAccessMap(user.id).get(lineId)
  return grant === 'operate' ? 'operate' : grant === 'readonly' ? 'readonly' : 'none'
}

/** 可见产线集合:null = 不限(admin/editor);否则为授权产线 id 集(普通用户) */
export function visibleLineIds(user: { id: string, role: string }): Set<string> | null {
  if (isPrivilegedRole(user)) return null
  return new Set(userRepository.lineAccessMap(user.id).keys())
}

/** 按 lineId 过滤实体列表(admin/editor 原样返回) */
export function filterByLine<T>(user: { id: string, role: string }, items: T[], lineIdOf: (item: T) => string | null | undefined): T[] {
  const visible = visibleLineIds(user)
  if (!visible) return items
  return items.filter((it) => {
    const lid = lineIdOf(it)
    return lid != null && visible.has(lid)
  })
}

/** 操控能力校验:need='operate' 时 readonly/none 均拒;need='readonly' 时 none 拒 */
export function requireLineMode(user: { id: string, role: string }, lineId: string | null | undefined, need: 'readonly' | 'operate'): LineMode {
  const mode = lineMode(user, lineId)
  if (mode === 'operate' || (need === 'readonly' && mode === 'readonly')) return mode
  if (mode === 'readonly') {
    throw new AppError(403, 'LINE_READONLY', '该产线为仅查看权限:只读数采可见,写控/操作需管理员授予「可操控」')
  }
  throw new AppError(403, 'LINE_FORBIDDEN', `无该产线权限:请联系管理员在「权限管理」中授予(产线 ${lineId ?? '?'})`)
}

/** 权限变更广播(scene-events + 插件钩子),前端/插件据此刷新授权视图 */
export function notifyGrantsChanged(userId: string): void {
  try {
    // 延迟动态导入避免与 scene-events 循环依赖
    void import('@/server/services/workshop/scene-events').then((m) => {
      m.broadcastSceneEvent('permissions.changed', { userId, at: new Date().toISOString() })
    }).catch(() => {})
  }
  catch { /* 广播失败不影响授权写入 */ }
  try {
    void import('@/server/services/workshop/plugins/host.mjs').then((m) => {
      void m.emitPluginEvent('permissions:changed', { userId })
    }).catch(() => {})
  }
  catch { /* 插件钩子失败不影响授权写入 */ }
}
