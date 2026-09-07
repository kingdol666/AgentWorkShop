/**
 * /api/plugins/:name/** —— 插件自注册 API 的转发层(exact-match)。
 * 插件经 ctx.route(method, path, handler) 注册;handler(event) 返回值由 nitro 序列化。
 * 鉴权:插件在入口声明 auth:'user' | 'admin' | 'agent-or-user' 时由转发层统一校验
 *   (缺省 'none' 保持开放,兼容既有插件/浏览器面板)。
 * 错误隔离:插件 handler 抛错 → 结构化日志(带插件归属)+ 干净 500 信封,不裸传堆栈。
 */
import { defineEventHandler, createError, readBody } from 'h3'
import { getPluginHost } from '@/server/services/workshop/plugins/host.mjs'
import { resolveUser, resolveAgentOrUser, requireAdmin } from '../../workshop/caller'

export default defineEventHandler(async (event) => {
  const host = getPluginHost()
  if (!host) throw createError({ statusCode: 503, statusMessage: 'plugin host not ready' })
  const name = String(event.context.params?.name ?? '')
  const path = '/' + (event.context.params?.path ?? '').replace(/^\/+/, '')
  const rec = host.plugins.get(name)
  // 声明式鉴权门:在进入插件 handler 前统一校验(禁用插件的路由表已不含其路由,天然 404)
  const authMode = String(rec?.auth ?? 'none')
  if (authMode !== 'none') {
    try {
      if (authMode === 'admin') await requireAdmin(event)
      else if (authMode === 'agent-or-user') await resolveAgentOrUser(event)
      else await resolveUser(event)
    }
    catch {
      throw createError({ statusCode: 401, statusMessage: '需要有效的用户 token(Authorization: Bearer <用户token>)' })
    }
  }
  const handler = host.routes.resolve(name, event.method, path)
  if (!handler) {
    throw createError({ statusCode: 404, statusMessage: `plugin route not found: ${event.method} /api/plugins/${name}${path}` })
  }
  // 预读 body 挂到 event(插件 handler 无 h3 导入能力,经 event.awBody 消费)
  const awBody = await readBody(event).catch(() => undefined)
  ;(event as unknown as Record<string, unknown>).awBody = awBody
  try {
    return await handler(event)
  }
  catch (err) {
    // 问题日志:插件归属 + 路由 + 原始原因(运维按 name 即可定位到具体插件目录)
    const reason = err instanceof Error ? err.message : String(err)
    host.logger?.error?.(`插件路由处理失败 [${name}] ${event.method} /api/plugins/${name}${path}: ${reason}`)
    throw createError({ statusCode: 500, statusMessage: `插件路由处理失败(${name}): ${reason}` })
  }
})
