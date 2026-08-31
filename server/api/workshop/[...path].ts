/**
 * /api/workshop/** 未匹配路由的兜底 404 信封。
 * - 显式路由优先;只有没有任何路由命中的路径才会落到这里
 * - 输出与 defineApiHandler 同形的 {code:'NOT_FOUND', message, data:null},
 *   前端 apiFetch/调用方不必对 h3 原生 "Page not found" 做特殊分支
 */
import type { H3Event } from 'h3'
import { AppError } from '../../utils/errors'
import { defineApiHandler } from '../../utils/response'

export default defineApiHandler((event: H3Event) => {
  throw new AppError(404, 'NOT_FOUND', `接口不存在: ${event.path}`)
})
