/**
 * 致命异常严重性判定(稳定性护栏的唯一判据来源)。
 *
 * 为什么独立成文件:判定逻辑必须可被 **纯 node 回归测试** 直接加载断言。
 * 放在 `server/plugins/dev-stability-guard.ts` 里就只能靠起真实服务观察,
 * 而"哪类异常该退进程"恰恰是最不该靠观察来确认的一类逻辑。
 *
 * 四级严重性,只有 `fatal` 会退进程:
 *
 *  1. `socket`   —— 浏览器/客户端硬断(WS、keep-alive)。最高频的瞬态噪声,
 *                   Node 默认策略会直接击穿进程,从而拖垮所有并发会话。
 *  2. `db-busy`  —— SQLite 忙/锁。多写竞争的瞬态错误,应重试而非退出。
 *  3. `upstream` —— **外部设备/上游服务不可达**:ECONNREFUSED / ENOTFOUND /
 *                   EHOSTUNREACH / ENETUNREACH / 连接超时。
 *                   这是运维常态(设备下电、模拟器未启、容器重启),
 *                   绝不能让"某一台设备没开"带走整个监控平台 ——
 *                   DAQ 驱动本身把这类失败记为节点 lastError 并继续轮询,
 *                   护栏再补一刀 exit 1 就构成可用性事故。
 *                   ⚠️ 与"连上了但业务失败"区分:后者不在此列,仍走 fatal。
 *  4. `engine`   —— Agent 引擎边界错误(opencode/omp/codex/dsh 的 RPC 失败)。
 *                   只影响对应 agent 会话,服务端同时承载数采/数控,不可退进程。
 *
 * 其余一律 `fatal`:安全插件的 fail-fast(如生产密钥校验失败拒绝启动)依赖异常
 * 中止进程,绝不能被护栏吞掉。
 */

/** socket 级断连噪声 */
export const SOCKET_NOISE = /ECONNRESET|EPIPE|ECONNABORTED|ETIMEDOUT|ERR_STREAM_PREMATURE_CLOSE|ERR_STREAM_WRITE_AFTER_END/

/** 外部设备/上游不可达(运维常态,非程序缺陷) */
export const UPSTREAM_UNREACHABLE = /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|ERR_SOCKET_CONNECTION_TIMEOUT|UND_ERR_CONNECT_TIMEOUT/

/** SQLite 忙/锁(hardening ST-1) */
export const SQLITE_BUSY = /SQLITE_BUSY|SQLITE_LOCKED|database is locked/i

/** Agent 引擎边界错误(harness 容错) */
export const ENGINE_BOUNDARY = /\b(opencode|omp|codex|dsh) API\b/i

export type FatalSeverity = 'socket' | 'db-busy' | 'upstream' | 'engine' | 'fatal'

/** 错误→可读文本;Error 取 message + 截断 stack,其余 String() */
export function describeReason(reason: unknown): string {
  return reason instanceof Error
    ? `${reason.message}\n${reason.stack?.slice(0, 600) ?? ''}`
    : String(reason)
}

/**
 * 判定一次"致命候选"的真实严重性。
 * 命中顺序即优先级:code 字段优先(经典 errno),再全文兜底
 * (undici 等包装错误 code 可能是 UND_ERR_*,但 message/stack 仍带原文)。
 */
export function classifyFatalCandidate(reason: unknown): FatalSeverity {
  if (reason == null) return 'fatal'
  const err = reason as NodeJS.ErrnoException
  const code = typeof err.code === 'string' ? err.code : ''
  const text = `${code}\n${describeReason(reason)}`

  if (SOCKET_NOISE.test(text)) return 'socket'
  if (SQLITE_BUSY.test(text)) return 'db-busy'
  if (UPSTREAM_UNREACHABLE.test(text)) return 'upstream'
  // 引擎边界只看首行:避免 stack 里偶然出现的引擎名把真实错误降级
  const head = describeReason(reason).split('\n')[0] ?? ''
  if (ENGINE_BOUNDARY.test(head)) return 'engine'
  return 'fatal'
}
