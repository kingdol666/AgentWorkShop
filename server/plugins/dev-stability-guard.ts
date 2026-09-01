/**
 * Dev 稳定性护栏:浏览器断开(WS/keep-alive socket 硬断)会产生 ECONNRESET 类
 * unhandledRejection —— Node v24 默认策略是 throw,直接击穿 dev server,
 * 拖垮所有正在调试/测试的会话。这里仅在 dev 捕获并记日志(生产不挂此护栏,
 * 未处理拒绝仍按 Node 默认策略暴露真实问题)。
 */
export default defineNitroPlugin(() => {
  if (!import.meta.dev) return
  process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? `${reason.message}\n${reason.stack?.slice(0, 600) ?? ''}` : String(reason)
    console.warn(`[dev-guard] unhandledRejection suppressed: ${msg}`)
  })
  process.on('uncaughtException', (err) => {
    console.warn(`[dev-guard] uncaughtException suppressed: ${err.message}\n${err.stack?.slice(0, 600) ?? ''}`)
  })
})
