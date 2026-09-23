/**
 * GET /api/workshop/channels —— channel 列表(设计文档 §6.2)。
 * v16:附「定时」标志 —— scheduledCount = 该 channel 启用的定时计划数(0 = 无定时任务)。
 * v17:可见性扩到「owner 的 + 本人 active 成员的 + 公开可发现的」,并附
 *     成员/群聊设置与调用者能力视图(便于前端区分管理面与群聊面)。
 */
import { defineApiHandler } from '../../utils/response'
import { resolveUser } from './caller'
import { getWorkshopManager } from '../../plugins/workshop'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const manager = getWorkshopManager()
  const channels = manager.listChannelsVisibleTo(user)
  const flags = manager.channelScheduleFlags()
  return channels.map((ch) => {
    let permissions: ReturnType<typeof manager.channelPermissionsOf> | null = null
    try {
      permissions = manager.channelPermissionsOf(ch.id, user)
    }
    catch { /* channel 半删除竞态:权限视图缺失不影响列表 */ }
    return {
      ...ch,
      scheduledCount: flags.get(ch.id) ?? 0,
      /** v17:群成员数(active;用于列表徽标) */
      memberCount: manager.listChannelMembersProjected(ch.id).filter(m => m.status === 'active').length,
      /** v17:调用者能力(canManage=false 时前端只渲染群聊视图) */
      permissions,
    }
  })
})
