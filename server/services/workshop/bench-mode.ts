/**
 * 基准/消融模式保险丝(2026-10-30 安全审计 P2-11)。
 *
 * AW_BENCH_MODE=1 曾单 env 解除全部防线:整条限流中间件、在线探索限频(单步上限 /
 * 60s 间隔 / 写入保持窗)、软联锁(参数/产品/配方窗)、回读容差、写间隔……
 * 生产实例只要环境里残留这一个变量,整机就变成"无护栏"状态。
 *
 * 现在要求**双 env 明确确认**:AW_BENCH_MODE=1 且 AW_BENCH_ACK=1。
 * 单 env 时启动告警一次并保持防线;既有基准脚本需同时导出两者(README 已更新)。
 */
let warned = false

export function benchModeEnabled(): boolean {
  if (process.env.AW_BENCH_MODE !== '1') return false
  if (process.env.AW_BENCH_ACK === '1') return true
  if (!warned) {
    warned = true
    console.warn('[bench-mode] 忽略 AW_BENCH_MODE=1:缺少 AW_BENCH_ACK=1 确认令牌,全部安全防线保持生效。'
      + '基准/消融运行请同时设置 AW_BENCH_MODE=1 AW_BENCH_ACK=1。')
  }
  return false
}
