/**
 * POST /api/workshop/plugins/:name/enable —— 启用插件(admin;热重载生效)。
 */
import { defineEventHandler, createError } from 'h3'
import { resolveUser, requireAdmin } from '@/server/api/workshop/caller'
import { pluginManifest, reloadPluginHost, setPluginEnabled } from '@/server/services/workshop/plugins/host.mjs'

export default defineEventHandler(async (event) => {
  const user = resolveUser(event)
  requireAdmin(event)
  const name = String(event.context.params?.name ?? '')
  if (!pluginManifest().some(p => p.name === name)) {
    throw createError({ statusCode: 404, statusMessage: `plugin not found: ${name}` })
  }
  setPluginEnabled(name, true)
  await reloadPluginHost()
  const p = pluginManifest().find(x => x.name === name)
  return { ok: true, enabled: p?.enabled ?? true, by: user.name }
})
