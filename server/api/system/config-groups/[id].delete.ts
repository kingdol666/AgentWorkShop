/**
 * DELETE /api/system/config-groups/[id] —— 删除「管理员自建」分组。
 *
 * 拒绝删除内置分组(source=builtin)与插件分组(source=plugin);
 * 组内仍有字段时拒绝(字段的 group 由描述符声明,运行时不可改写 → 不允许静默丢字段),
 * 可用 ?reassignTo=<groupId> 显式声明迁移目标后再删。
 *
 * 鉴权:仅 admin。
 */
import { getQuery } from 'h3'
import { defineApiHandler } from '../../../utils/response'
import { requireRole } from '../../workshop/caller'
import { getSystemConfigService } from '../../../services/system-config'

export default defineApiHandler((event) => {
  requireRole(event, ['admin'])
  const id = String(event.context.params?.id ?? '').trim()
  const reassignTo = String(getQuery(event).reassignTo ?? '').trim() || undefined
  const res = getSystemConfigService().deleteGroup(id, reassignTo)
  return { ok: true, ...res }
})
