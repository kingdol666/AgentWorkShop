/**
 * /api/plugins/:name/** —— 插件自注册 API 的转发层(exact-match)。
 * 插件经 ctx.route(method, path, handler) 注册;handler(event) 返回值由 nitro 序列化。
 * 鉴权由插件自行处理(v1 不强制;可经 resolveUser 复用业务鉴权)。
 */
import { defineEventHandler, createError, readBody } from 'h3'
import { getPluginHost } from '@/server/services/workshop/plugins/host.mjs'

export default defineEventHandler(async (event) => {
  const host = getPluginHost()
  if (!host) throw createError({ statusCode: 503, statusMessage: 'plugin host not ready' })
  const name = String(event.context.params?.name ?? '')
  const path = '/' + (event.context.params?.path ?? '').replace(/^\/+/, '')
  const handler = host.routes.resolve(name, event.method, path)
  if (!handler) {
    throw createError({ statusCode: 404, statusMessage: `plugin route not found: ${event.method} /api/plugins/${name}${path}` })
  }
  // 预读 body 挂到 event(插件 handler 无 h3 导入能力,经 event.awBody 消费)
  const awBody = await readBody(event).catch(() => undefined)
  ;(event as Record<string, unknown>).awBody = awBody
  return handler(event)
})
