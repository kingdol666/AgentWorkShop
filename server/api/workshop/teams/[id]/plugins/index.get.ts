/**
 * GET /api/workshop/teams/:id/plugins —— 该 AgentTeam 的插件开关视图。
 * 返回全部已注册插件的团队级 enabled(显式配置/默认全启用)+ source 标记。
 * 以 team id 为键读 channel_plugins(建队勾选/团队设置写入;部署时传导到 channel)。
 * 鉴权:team 属主或 admin;public team 全员可读。
 */
import { resolveUser, isAdmin } from '../../../../workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { getWorkshopManager } from '@/server/plugins/workshop'
import { getChannelPluginsRepo } from '@/server/services/workshop/db/channel-plugins.repo'
import { getPluginHost, pluginManifest } from '@/server/services/workshop/plugins/host.mjs'
import { AppError, ErrorCodes } from '@/server/utils/errors'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const id = String(event.context.params?.id ?? '')
  const manager = getWorkshopManager()
  const team = manager.getTeam(id)
  if (!team) throw new AppError(404, ErrorCodes.NOT_FOUND, `AgentTeam 不存在: ${id}`)
  const readable = user.role === 'admin' || team.visibility === 'public' || team.ownerUserId === user.id
  if (!readable) throw new AppError(403, 'SCOPE_VIOLATION', 'AgentTeam 不属于当前用户')

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
