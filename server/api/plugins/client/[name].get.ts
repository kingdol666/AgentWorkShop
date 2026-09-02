/**
 * GET /api/plugins/client/:name —— 插件客户端脚本(text/javascript)。
 * 自包含 ESM(无裸导入);客户端 loader 动态 import 后以 setup(ctx) 装载。
 * 信任模型与 aw commands 相同:仅装载自己放入插件目录的可信代码。
 */
import { defineEventHandler, getRouterParam, setHeader, createError } from 'h3'
import { readClientScript } from '@/server/services/workshop/plugins/host.mjs'

export default defineEventHandler((event) => {
  const name = String(getRouterParam(event, 'name') ?? '').replace(/\.mjs$/, '')
  const r = readClientScript(name)
  if (r.status !== 200) {
    throw createError({ statusCode: r.status, statusMessage: r.status === 404 ? 'plugin client not found' : 'bad request' })
  }
  setHeader(event, 'content-type', r.contentType ?? 'text/javascript; charset=utf-8')
  setHeader(event, 'cache-control', 'no-cache')
  return r.code
})
