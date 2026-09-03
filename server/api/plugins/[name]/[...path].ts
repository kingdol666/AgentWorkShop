/**
 * /api/plugins/:name/** —— 插件自注册 API 的转发层(exact-match)。
 * 插件经 ctx.route(method, path, handler) 注册;handler(event) 返回值由 nitro 序列化。
 * 鉴权由插件自行处理(v1 不强制;可经 resolveUser 复用业务鉴权)。
 * 错误隔离:插件 handler 抛错 → 结构化日志(带插件归属)+ 干净 500 信封,不裸传堆栈。
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
