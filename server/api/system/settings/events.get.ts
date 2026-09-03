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

<<<<<<< HEAD
  const listener: ((payload: ConfigEventPayload) => void) | undefined
  listener = (payload) => {
=======
  const listener = (payload: ConfigEventPayload): void => {
>>>>>>> 3c897a0 (fix(settings): 修复 sse 监听器拆分声明导致的构建失败)
    void stream.push(JSON.stringify(payload))
  }
  const unsubscribe = service.subscribe(listener)

  stream.onClosed(async () => {
    unsubscribe()
    await stream.close()
  })

  return stream.send()
})
