/**
 * GET /api/system/settings/events —— 设置变更 SSE 事件流。
 * 客户端用 fetch + ReadableStream（带 Authorization 头）订阅；
 * 服务端任何写入（UI / CLI / 文件监听）都会 push { type, changed, restartRequired, effective }。
 * 连接前先鉴权（无效 token 直接 401，不开流）。
 */
import { createEventStream } from 'h3'
import { resolveUser } from '../../workshop/caller'
import { getSystemConfigService, type ConfigEventPayload } from '../../../services/system-config'

export default defineEventHandler(async (event) => {
  resolveUser(event) // 开流前鉴权：无 token → 401
  const service = getSystemConfigService()
  const stream = createEventStream(event)

  // push 是对已断开 socket 的写:浏览器换页/关标签时必然失败。
  // 不吞掉这个 rejection,它会以 unhandledRejection 逃逸 —— dev 下 nuxt CLI 的处理器
  // 会据此结束整个 dev server(实测:审计浏览器翻页即把 dev server 打死)。
  // 断流是这里的正常终态,不是错误。
  const safePush = (payload: ConfigEventPayload): void => {
    stream.push(JSON.stringify(payload)).catch(() => {})
  }
  const unsubscribe = service.subscribe(safePush)

  stream.onClosed(async () => {
    unsubscribe()
    await stream.close().catch(() => {})
  })

  return stream.send()
})
