/**
 * PUT /api/workshop/channels/:id/plugins —— 写入该团队的插件开关(团队级独立控制)。
 * body: { plugins: [{ name, enabled }] }(未知插件名忽略;全量替换语义)
 * 生效:切换即写入 channel_plugins;该团队在跑 Agent 经工具热通知刷新清单(关闭的
 * 插件工具从清单消失,dispatch 同源拒绝),防不需要插件的 channel 上下文被污染。
 * 鉴权:channel 归属者(遗留公共 channel 需 admin)。
 */
import { readBody } from 'h3'
import { resolveUser, requireAdmin } from '../../../../workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { getWorkshopManager } from '@/server/plugins/workshop'
import { getChannelPluginsRepo, type ChannelPluginToggle } from '@/server/services/workshop/db/channel-plugins.repo'
import { getPluginHost, pluginManifest } from '@/server/services/workshop/plugins/host.mjs'
import { notifyToolChange } from '@/server/services/workshop/agents/plugin-tools'
import { AppError } from '@/server/utils/errors'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const id = String(event.context.params?.id ?? '')
  const manager = getWorkshopManager()
  const channel = manager.getChannelForUser(id, user.id)
  if (channel?.ownerUserId === null) requireAdmin(event)

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
  // 热通知:该团队(全部团队,轻量)在跑 agent 重发工具清单,关闭插件的工具即消失
  notifyToolChange()
  return { saved: clean.length, plugins: clean }
})
