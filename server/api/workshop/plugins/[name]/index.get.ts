/**
 * GET /api/workshop/plugins/:name —— 单插件详情(鉴权)。
 */
import { defineEventHandler, createError } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { pluginManifest } from '@/server/services/workshop/plugins/host.mjs'

export default defineEventHandler((event) => {
  resolveUser(event)
  const name = String(event.context.params?.name ?? '')
  const p = pluginManifest().find(x => x.name === name)
  if (!p) throw createError({ statusCode: 404, statusMessage: `plugin not found: ${name}` })
  return p
})
