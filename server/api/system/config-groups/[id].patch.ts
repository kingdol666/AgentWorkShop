/**
 * PATCH /api/system/config-groups/[id] —— 更新分组(标题/说明/排序/默认折叠/图标)。
 *
 * 允许改内置分组(source=builtin)的展示元数据 —— 管理员可重排、改名、默认折叠,
 * 但 source 与 id 不可改,内置分组也不可删除(避免字段无家可归)。
 * 插件声明的分组(id=plugin-*)由插件权威,本接口拒绝,请在插件侧修改。
 *
 * 鉴权:仅 admin。
 */
import { readBody } from 'h3'
import { defineApiHandler } from '../../../utils/response'
import { requireRole } from '../../workshop/caller'
import { getSystemConfigService } from '../../../services/system-config'

export default defineApiHandler(async (event) => {
  requireRole(event, ['admin'])
  const id = String(event.context.params?.id ?? '').trim()
  const body = (await readBody(event)) ?? {}
  // id/source/plugin 是身份字段,不接受伪造
  const patch = { ...body }
  delete patch.id
  delete patch.source
  delete patch.plugin
  const group = getSystemConfigService().updateGroup(id, patch)
  return { ok: true, group }
})
