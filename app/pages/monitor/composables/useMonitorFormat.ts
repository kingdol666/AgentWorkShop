/**
 * 监控页的展示辅助(与 app/pages/logs/composables/useLogsFormat 同构)。
 *
 * 拆组件后最容易出的回归是"每个组件各记一份状态";这里给的是一组**纯函数**,
 * 三个表格 + 概要卡各调各的,拿到的仍是同一套口径,不存在第二份数据。
 */

/** 短 id / 状态色 / 运行时长 / 进程启动时刻(无 i18n 依赖,纯格式化) */
export function useMonitorFormat() {
  const shortId = (id: string | null | undefined): string => (id && id.length > 8 ? `${id.slice(0, 8)}…` : (id ?? '-'))
  const uptimeText = (ms: number): string => {
    const s = Math.floor(ms / 1000)
    const h = Math.floor(s / 3600)
    const m = Math.floor((s % 3600) / 60)
    const sec = s % 60
    return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${sec}s` : `${sec}s`
  }
  const startedAtText = (ts: number): string => new Date(ts).toLocaleTimeString()

  return { shortId, uptimeText, startedAtText }
}

/**
 * Agent 状态徽标的色/文案(idle/busy/stopped)。
 *
 * 单独一个是因为要 i18n:文案在 setup 期取值一次 —— 与拆分前同语义
 * (原来的 stateText 也是在页面 setup 期算一次的普通对象,语言切换不重算)。
 */
export function useAgentStateLabels() {
  const { t } = useI18n()
  const stateColor: Record<string, string> = { idle: 'success', busy: 'processing', stopped: 'error' }
  const stateText: Record<string, string> = {
    idle: t('monitor.stateIdle'),
    busy: t('monitor.stateBusy'),
    stopped: t('monitor.stateStopped'),
  }

  return { stateColor, stateText }
}
