/**
 * GET /api/workshop/channels/:id/plugins —— 该团队的插件开关视图。
 * 返回全部已注册插件的团队级 enabled(显式配置/默认全启用)+ source 标记。
 * 鉴权:channel 归属者(遗留公共 channel 需 admin)。
 */
import { resolveUser, requireAdmin, isAdmin } from '../../../../workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { getWorkshopManager } from '@/server/plugins/workshop'
import { getChannelPluginsRepo } from '@/server/services/workshop/db/channel-plugins.repo'
import { getPluginHost, pluginManifest } from '@/server/services/workshop/plugins/host.mjs'
import { AppError, ErrorCodes } from '@/server/utils/errors'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const id = String(event.context.params?.id ?? '')
  const manager = getWorkshopManager()
  // 归属校验:遗留公共(owner null)仅 admin;否则本人(getChannelForUser 同语义)
  const channel = manager.getChannelForUser(id, user.id)
  if (!channel && channel !== null) throw new AppError(404, ErrorCodes.NOT_FOUND, `channel 不存在: ${id}`)
  if (channel?.ownerUserId === null) requireAdmin(event)

  const host = getPluginHost()
  const manifest = host ? pluginManifest().filter(p => p.enabled) : []
  const explicit = getChannelPluginsRepo().explicitFor(id)
  return {
    plugins: manifest.map(p => ({
      name: p.name,
      description: p.description,
      builtin: p.builtin,
      enabled: explicit ? explicit.get(p.name) !== false : true,
    })),
    source: explicit ? 'explicit' : 'default',
    isAdmin: isAdmin(user),
  }
})
