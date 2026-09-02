/**
 * GET /api/workshop/plugins —— 插件管理清单(鉴权;含启停状态/路由/装载失败)。
 * 网页「插件管理」页数据源。
 */
import { defineEventHandler } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { getPluginHost, pluginManifest } from '@/server/services/workshop/plugins/host.mjs'

export default defineEventHandler((event) => {
  resolveUser(event)
  const host = getPluginHost()
  return {
    plugins: pluginManifest(),
    failures: host?.failures ?? [],
    initedAt: host?.initedAt ?? null,
  }
})
