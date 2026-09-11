/**
 * GET /api/system/config-groups —— 配置分组列表(设置页分区的唯一渲染权威)。
 *
 * 返回有序分组(内置 / 管理员自建 / 插件声明),每项带 fieldCount。
 * 前端设置页不再自行按描述符猜分组,而是完全按本接口的顺序与元数据渲染,
 * 从而做到「后端 API 控制前端渲染」。
 *
 * 鉴权:admin/editor(与设置快照同权;含插件分组与字段数,属管理面信息)。
 */
import { defineApiHandler } from '../../../utils/response'
import { requireRole } from '../../workshop/caller'
import { getSystemConfigService } from '../../../services/system-config'

export default defineApiHandler((event) => {
  requireRole(event, ['admin', 'editor'])
  const svc = getSystemConfigService()
  return {
    groups: svc.listGroups(),
    registryPath: svc.groupRegistryPath,
  }
})
