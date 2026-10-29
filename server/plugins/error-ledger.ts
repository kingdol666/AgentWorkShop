/**
 * 错误台账 nitro 接线:API 未捕获异常 / 5xx → audit_log(system 域,level=error)。
 *
 * 为什么是钩子而不是逐路由 try/catch:全站路由已普遍 fail-closed 返回结构化 4xx,
 * 但任何一处漏捕的 throw 都会变成裸 500 —— 此前只进 console(进程重启即失),
 * 运维在 /logs 完全看不到。钩子在异常渲染为响应时统一收口,逐条入账带限流去重
 * (同源 10s 折叠 / 全局 120 条每分钟),见 services/workshop/ops/error-ledger.ts。
 *
 * 纪律:钩子内绝不再抛 —— captureServerError 自吞全部异常。
 */
import { captureServerError } from '../services/workshop/ops/error-ledger'

export default defineNitroPlugin((nitroApp) => {
  const hooks = nitroApp.hooks as typeof nitroApp.hooks & {
    hook: (name: 'error', fn: (error: unknown, ctx: { event: unknown }) => void) => void
  }
  hooks.hook('error', (error, { event }) => {
    captureServerError(event as Parameters<typeof captureServerError>[0], error)
  })
  console.warn('[error-ledger] armed (API 未捕获异常/5xx → audit_log system 域 level=error,限流去重)')
})
