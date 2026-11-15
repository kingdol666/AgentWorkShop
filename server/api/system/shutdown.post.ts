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
import { resolve } from 'node:path'
import { getRequestHeader } from 'h3'
import { resolveRunMode } from '@/shared/config/home.mjs'
import { writeStopIntent } from '@/shared/config/stop-intent.mjs'
import { defineApiHandler } from '../../utils/response'
import { AppError } from '../../utils/errors'

/**
 * 写"意图停机"标记（协议见 shared/config/stop-intent.mjs）。
 *
 * 路径完全由服务端自己解析的配置根推导（与 system-config 插件同一入口），
 * 不接受请求参数或专用环境变量里的路径；写入点固定在
 * <configRoot>/.runtime/stop-intent，并由 stop-intent 模块做根内包含校验。
 * 失败不阻断停机：父进程会按原有崩溃策略重启，行为不劣化。
 */
function markIntentionalStop(): void {
  const token = process.env.AW_STOP_TOKEN ?? ''
  if (!token) return
  try {
    const rm = resolveRunMode({
      cwd: resolve(process.cwd()),
      packageRoot: process.env.AW_PACKAGE_ROOT,
      env: process.env,
    })
    if (!writeStopIntent(rm.configRoot, token)) {
      console.error('[shutdown] 意图停机标记写入失败(父进程可能按崩溃重启)')
    }
  }
  catch (err) {
    console.error('[shutdown] 意图停机标记解析失败(父进程可能按崩溃重启):', String((err as { message?: unknown } | null)?.message ?? err))
  }
}

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
  // 先登记意图再退：父进程据此不自动重启（close 钩子超时强退同样成立）
  markIntentionalStop()
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
