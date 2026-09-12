/**
 * Server 稳定性护栏:浏览器断开(WS/keep-alive socket 硬断)产生 ECONNRESET/EPIPE
 * 类异步异常 —— Node 默认策略直接击穿进程,拖垮所有并发调试/运行会话。
 *
 * 严重性判定集中在 `server/utils/stability-severity.ts`(可被纯 node 回归测试直接断言):
 * socket 断连 / SQLite 瞬态忙 / 外部设备不可达 / Agent 引擎边界 → 记录并继续;
 * 其余判为 fatal,记日志后按非零码退出 —— 安全插件的 fail-fast(如生产密钥校验
 * 失败拒绝启动)依赖异常中止进程,绝不能被护栏吞掉。
 *
 * "外部设备不可达"是**运维常态**(设备下电、模拟器未启、容器重启):
 * 曾实测到一台 Modbus TCP 设备未启动(`connect ECONNREFUSED 127.0.0.1:1502`)
 * 使 unhandledRejection 走到 fatal 分支,整个生产实例 exit 1 ——
 * 数采/数控/数字孪生全平台被一台设备带走,属可用性事故。
 */
import { classifyFatalCandidate, describeReason } from '../utils/stability-severity'

export default defineNitroPlugin(() => {
  // 'db-busy' 必须引号 → 按 @stylistic/quote-props 的 consistent 口径,同对象内全部加引号
  const counts: Record<string, number> = { 'socket': 0, 'db-busy': 0, 'upstream': 0, 'engine': 0 }
  const onFatalCandidate = (kind: string, reason: unknown): void => {
    const severity = classifyFatalCandidate(reason)
    if (severity === 'fatal') {
      console.error(`[stability-guard] fatal ${kind}, exiting:\n${describeReason(reason)}`)
      process.exit(1)
    }
    counts[severity] += 1
    const line = `[stability-guard] ${severity}(累计 ${counts[severity]},不退出): ${describeReason(reason).slice(0, 200).replace(/\n/g, ' ')}`
    // 外部设备不可达与引擎边界属"要有人知道"的信号 → error;其余瞬态噪声 → warn
    if (severity === 'upstream' || severity === 'engine') console.error(line)
    else console.warn(line)
  }

  process.on('unhandledRejection', (reason) => {
    onFatalCandidate('unhandledRejection', reason)
  })
  process.on('uncaughtException', (err) => {
    onFatalCandidate('uncaughtException', err)
  })
  console.warn('[stability-guard] armed (socket 断连/sqlite 瞬态忙/外部设备不可达/引擎边界错误 → 记录继续;其余真实错误 → exit 1)')
})
