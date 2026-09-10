/**
 * PUT /api/workshop/teams/:id/plugins —— 写入该 AgentTeam 的插件开关。
 * body: { plugins: [{ name, enabled }] }(未知插件名忽略;全量替换语义)
 * 以 team id 为键写 channel_plugins(团队作用域偏好);部署 deployTeamToChannel 时
 * 传导到目标 channel,传导后该团队在跑 Agent 经 notifyToolChange 热刷新工具清单。
 * 鉴权:team 属主或 admin。
 */
import { readBody } from 'h3'
import { resolveUser } from '../../../../workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { getWorkshopManager } from '@/server/plugins/workshop'
import { getChannelPluginsRepo, type ChannelPluginToggle } from '@/server/services/workshop/db/channel-plugins.repo'
import { getPluginHost, pluginManifest } from '@/server/services/workshop/plugins/host.mjs'
import { notifyToolChange } from '@/server/services/workshop/agents/plugin-tools'
import { AppError, ErrorCodes } from '@/server/utils/errors'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const id = String(event.context.params?.id ?? '')
  const manager = getWorkshopManager()
  const team = manager.getTeam(id)
  if (!team) throw new AppError(404, ErrorCodes.NOT_FOUND, `AgentTeam 不存在: ${id}`)
  if (team.ownerUserId !== user.id && user.role !== 'admin') {
    throw new AppError(403, 'SCOPE_VIOLATION', '仅 team 属主或 admin 可修改插件开关')
  }

  const body = (await readBody<{ plugins?: Array<{ name?: string, enabled?: boolean }> }>(event)) ?? {}
  const entries = Array.isArray(body?.plugins) ? body.plugins : null
  if (!entries) throw new AppError(400, 'VALIDATION_ERROR', 'body 应为 { plugins: [{ name, enabled }] }')

  // 只接受已注册且启用的插件名(停用插件无工具可注入,写入无意义)
  const host = getPluginHost()
  const registered = new Set(host ? pluginManifest().filter(p => p.enabled).map(p => p.name) : [])
  const clean: ChannelPluginToggle[] = entries
    .filter((e): e is { name: string, enabled?: boolean } => Boolean(e) && typeof e.name === 'string' && registered.has(e.name as string))
    .map(e => ({ name: e.name as string, enabled: e.enabled !== false }))

  getChannelPluginsRepo().setMany(id, clean)
  // 热通知:该 team 已部署到各 channel 的在跑 Agent 重发工具清单(轻量广播)
  notifyToolChange()
  return { saved: clean.length, plugins: clean }
})
