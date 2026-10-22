/**
 * GET /api/workshop/plugins —— 插件管理清单(鉴权;含启停状态/路由/装载失败)。
 * 网页「插件管理」页数据源;附带每个插件当前注册的工具(来自 tool_registry)。
 */
import { defineEventHandler } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { getPluginHost, pluginManifest } from '@/server/services/workshop/plugins/host.mjs'
import { getToolRegistryRepo } from '@/server/services/workshop/db/tool-registry.repo'

export default defineEventHandler((event) => {
  resolveUser(event)
  const host = getPluginHost()
  let rows: Array<{ name: string, label: string, pluginName: string, available: boolean }> = []
  try {
    rows = getToolRegistryRepo().list().map(r => ({
      name: r.name,
      label: r.label,
      pluginName: r.pluginName,
      available: r.available,
    }))
  }
  catch { /* 目录不可用不影响插件清单 */ }
  return {
    plugins: pluginManifest().map((p) => {
      const own = rows.filter(r => r.pluginName === p.name)
      return {
        ...p,
        toolCount: own.filter(r => r.available).length,
        knownToolCount: own.length,
        tools: own.filter(r => r.available).map(r => ({ name: r.name, label: r.label })),
      }
    }),
    failures: host?.failures ?? [],
    initedAt: host?.initedAt ?? null,
  }
})
