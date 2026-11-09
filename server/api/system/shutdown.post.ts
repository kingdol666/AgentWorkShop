/**
 * POST /api/system/shutdown —— 本机管理员优雅停机(`aw stop` 的优雅通道)。
 *
 * 背景:Windows 上 `taskkill /T /F` 不给进程任何收尾机会,`workshop` 插件的 close 钩子
 * (停训练树 → 停内核 → manager.shutdown → db.close)在正常停服时是死代码。Nitro 生产
 * 服务器自带 setupGracefulShutdown(SIGTERM/SIGINT → close 钩子),但 Windows 送不到信号。
 * 这里用 HTTP 把同一个 close 钩子触发出来。
 *
 * 安全:三道门 ——
 *   ① AW_STOP_TOKEN 必须存在(仅 `aw start` 启动的实例有;dev 直接 404 不暴露能力);
 *   ② 请求头 x-aw-stop-token 必须匹配(自定义 header 天然挡掉浏览器 drive-by POST,
 *      因为跨域带自定义头会触发 preflight);
 *   ③ remoteAddress 必须是环回(防反代/局域网转发)。
 */
import { getRequestHeader } from 'h3'
import { defineApiHandler } from '../../utils/response'
import { AppError } from '../../utils/errors'

function isLoopback(addr: string | undefined): boolean {
  const a = String(addr ?? '')
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1'
}

/**
 * 跑 close 钩子(插件销毁链),超时兜底退出。
 *
 * 实测(2026-11-10 验收):close 链上的 handler 可能永不 resolve(某个 shutdown 在等
 * 一个不会结束的回合/计时器),现象是"插件清理完成、进程仍在监听 200"——半停比不停
 * 更危险。所以**先武装强制退出**,再等钩子;钩子正常收口则提前退出。
 */
function shutdown(): void {
  const force = setTimeout(() => {
    console.error('[shutdown] close 钩子未在 8s 内收口,强制退出(清理链已尽力执行)')
    process.exit(0)
  }, 8000)
  force.unref?.()
  setTimeout(() => {
    void (async () => {
      try {
        await useNitroApp().hooks.callHook('close')
        console.log('[shutdown] close 钩子执行完成,退出')
      }
      catch (err) {
        console.error('[shutdown] close 钩子执行失败:', err)
      }
      clearTimeout(force)
      process.exit(0)
    })()
  }, 50).unref?.()
}

export default defineApiHandler(async (event) => {
  const expected = process.env.AW_STOP_TOKEN ?? ''
  if (!expected) throw new AppError(404, 'NOT_FOUND', '优雅停机未启用(仅 aw start 启动的实例支持)')
  const got = getRequestHeader(event, 'x-aw-stop-token') ?? ''
  if (got !== expected) throw new AppError(403, 'FORBIDDEN', '停机令牌无效')
  const remote = (event.node?.req?.socket as { remoteAddress?: string } | undefined)?.remoteAddress
  if (!isLoopback(remote)) throw new AppError(403, 'FORBIDDEN', '仅允许本机触发停机')
  shutdown()
  return { stopping: true }
})
