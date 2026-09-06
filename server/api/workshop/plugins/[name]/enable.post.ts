/**
 * POST /api/workshop/plugins/:name/enable —— 启用插件(admin;热重载生效)。
 * 统一信封:经 defineApiHandler,错误(AppError)带人话 message 供前端直出。
 */
import { resolveUser, requireAdmin } from '@/server/api/workshop/caller'
import { AppError, ErrorCodes } from '@/server/utils/errors'
import { pluginManifest, reloadPluginHost, setPluginEnabled } from '@/server/services/workshop/plugins/host.mjs'
import { defineApiHandler } from '@/server/utils/response'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  requireAdmin(event)
  const name = String(event.context.params?.name ?? '')
  if (!pluginManifest().some(p => p.name === name)) {
    throw new AppError(404, ErrorCodes.NOT_FOUND, `插件不存在: ${name}`)
  }
  setPluginEnabled(name, true)
  await reloadPluginHost()
  const p = pluginManifest().find(x => x.name === name)
  return { ok: true, enabled: p?.enabled ?? true, by: user.name }
})
