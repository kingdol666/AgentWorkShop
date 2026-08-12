import { defineEventHandler } from 'h3'

/**
 * 全局请求日志中间件（Nitro 自动注册，作用于所有请求）
 * 仅记录 API 请求方法/路径/耗时，用于链路观测。
 */
export default defineEventHandler((event) => {
  if (!event.path.startsWith('/api')) {
    return
  }
  const start = Date.now()
  event.node.res.once('close', () => {
    console.log(`[api] ${event.method} ${event.path} - ${Date.now() - start}ms`)
  })
})
