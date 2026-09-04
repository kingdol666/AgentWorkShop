// ============================================================
// StatusBar —— 底部状态条:频道/成员忙碌/HITL 待办/连接态。
// ============================================================
import { theme } from '../theme.mjs'
import { truncateToWidth } from '@earendil-works/pi-tui'

const CONN_LABEL = { open: '实时', connecting: '连接中', closed: '离线' }

export class StatusBar {
  constructor(state) {
    this.state = state
  }

  render(width) {
    const s = this.state
    const channel = s.channels.find(c => c.id === s.activeChannelId)
    const members = s.agents.length
    const busy = Object.values(s.agentStates).filter(a => a.state === 'busy').length
    const target = s.target
      ? theme.info(`@${s.target.name}(通信)`)
      : theme.accent('频道(任务)')
    const parts = [
      theme.accent(`▣ ${channel?.name ?? '未选择频道'}`),
      `${theme.faint('输入→')} ${target}`,
      members > 0 ? theme.faint(`成员 ${members}(忙 ${busy})`) : theme.faint('成员 0'),
      s.hitl.length > 0 ? theme.warn(`⏸ HITL 待处理 ${s.hitl.length}(/hitl)`) : theme.faint('HITL 0'),
      s.monitor.agentId ? theme.info(`监控:${s.monitor.waiting ? '等待进程' : s.monitor.name}`) : null,
      s.connState === 'open' ? theme.faint(`● ${CONN_LABEL[s.connState]}`) : theme.warn(`● ${CONN_LABEL[s.connState] ?? s.connState}`),
    ].filter(Boolean)
    const line = parts.join(theme.faint(' · '))
    return [truncateToWidth(line, Math.max(width, 20))]
  }
}
