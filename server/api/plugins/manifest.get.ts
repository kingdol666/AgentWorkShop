/**
 * GET /api/plugins/manifest —— 已装载插件清单(免鉴权只读:名称/版本/作用域/路由/是否有客户端)。
 * 客户端 loader 启动期拉取;未登录/服务未装载时返回空数组(前端静默)。
 */
import { pluginManifest } from '@/server/services/workshop/plugins/host.mjs'
import { defineEventHandler } from 'h3'

export default defineEventHandler(() => {
  return { plugins: pluginManifest() }
})
