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
// Agent 引擎边界错误(harness 容错):opencode/omp/codex/dsh 等外部引擎 RPC 失败
// (HTTP 4xx/5xx、连接拒绝)只影响对应 agent 会话,应降级重试而非退进程 ——
// 服务端同时承载 DAQ 数采/DCW 写控,引擎故障带走监控平台属于可用性事故。
const ENGINE_BOUNDARY = /\b(opencode|omp|codex|dsh) API\b/i

function isSocketNoise(reason: unknown): boolean {
  if (reason == null) return false
  const err = reason as NodeJS.ErrnoException
  // code 命中即噪声(经典 errno 形态)
  if (typeof err.code === 'string' && SOCKET_NOISE.test(err.code)) return true
  // undici 等包装错误:code 可能是 UND_ERR_*/undefined,但 message/stack 仍带
  // "read ECONNRESET" 文本 —— 全文兜底再测一次(四引擎并发下 keep-alive socket
  // 复位是高频瞬态,不可判死进程)
  return SOCKET_NOISE.test(describe(reason))
}

function describe(reason: unknown): string {
  return reason instanceof Error
    ? `${reason.message}\n${reason.stack?.slice(0, 600) ?? ''}`
    : String(reason)
}

export default defineNitroPlugin(() => {
  const isTransientDbBusy = (reason: unknown): boolean => SQLITE_BUSY.test(describe(reason))
  const isEngineBoundary = (reason: unknown): boolean => ENGINE_BOUNDARY.test(describe(reason).split('\n')[0] ?? '')
  let engineFaults = 0
  const onFatalCandidate = (kind: string, reason: unknown): void => {
    if (isSocketNoise(reason)) {
      console.warn(`[stability-guard] socket noise suppressed: ${describe(reason).slice(0, 120)}`)
      return
    }
    if (isTransientDbBusy(reason)) {
      console.warn(`[stability-guard] sqlite busy(瞬态,不退出): ${describe(reason).slice(0, 120)}`)
      return
    }
    if (isEngineBoundary(reason)) {
      engineFaults += 1
      console.error(`[stability-guard] 引擎边界错误(累计 ${engineFaults},不退出): ${describe(reason).slice(0, 400)}`)
      return
    }
    console.error(`[stability-guard] fatal ${kind}, exiting:\n${describe(reason)}`)
    process.exit(1)
  }
  process.on('unhandledRejection', (reason) => {
    onFatalCandidate('unhandledRejection', reason)
  })
  process.on('uncaughtException', (err) => {
    onFatalCandidate('uncaughtException', err)
  })
  console.warn('[stability-guard] armed (socket 断连/sqlite 瞬态忙/引擎边界错误 → 记录继续;其余真实错误 → exit 1)')
})
