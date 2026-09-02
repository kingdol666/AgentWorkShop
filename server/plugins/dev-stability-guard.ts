/**
 * Server 稳定性护栏:浏览器断开(WS/keep-alive socket 硬断)产生 ECONNRESET/EPIPE
 * 类异步异常 —— Node 默认策略直接击穿进程,拖垮所有并发调试/运行会话。
 *
 * 严重性过滤(关键设计):只抑制 socket 级断连噪声;其余异常保留致命语义
 * (记日志后按非零码退出)—— 安全插件的 fail-fast(如生产密钥校验失败拒绝启动)
 * 依赖异常中止进程,绝不能被护栏吞掉。
 */
const SOCKET_NOISE = /ECONNRESET|EPIPE|ECONNABORTED|ETIMEDOUT|ERR_STREAM_PREMATURE_CLOSE/
// SQLite 忙/锁(hardening ST-1):多写竞争的瞬态错误,记录并继续;
// 真正的库损坏/磁盘错误不经此路径,仍走致命语义。
const SQLITE_BUSY = /SQLITE_BUSY|SQLITE_LOCKED|database is locked/i

function isSocketNoise(reason: unknown): boolean {
  if (reason == null) return false
  const err = reason as NodeJS.ErrnoException
  if (typeof err.code === 'string') return SOCKET_NOISE.test(err.code)
  return SOCKET_NOISE.test(String(reason))
}

function describe(reason: unknown): string {
  return reason instanceof Error
    ? `${reason.message}\n${reason.stack?.slice(0, 600) ?? ''}`
    : String(reason)
}

export default defineNitroPlugin(() => {
  const isTransientDbBusy = (reason: unknown): boolean => SQLITE_BUSY.test(describe(reason))
  process.on('unhandledRejection', (reason) => {
    if (isSocketNoise(reason)) {
      console.warn(`[stability-guard] socket noise suppressed: ${describe(reason).slice(0, 120)}`)
      return
    }
    if (isTransientDbBusy(reason)) {
      console.warn(`[stability-guard] sqlite busy(瞬态,不退出): ${describe(reason).slice(0, 120)}`)
      return
    }
    console.error(`[stability-guard] fatal unhandledRejection, exiting:\n${describe(reason)}`)
    process.exit(1)
  })
  process.on('uncaughtException', (err) => {
    if (isSocketNoise(err)) {
      console.warn(`[stability-guard] socket noise suppressed: ${describe(err).slice(0, 120)}`)
      return
    }
    if (isTransientDbBusy(err)) {
      console.warn(`[stability-guard] sqlite busy(瞬态,不退出): ${describe(err).slice(0, 120)}`)
      return
    }
    console.error(`[stability-guard] fatal uncaughtException, exiting:\n${describe(err)}`)
    process.exit(1)
  })
  console.warn('[stability-guard] armed (socket 断连与 sqlite 瞬态忙 → 记录继续;真实错误 → exit 1)')
})
