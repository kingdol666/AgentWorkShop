import { getAmlRuntime } from '../runtime'
import { getChannelTwinProfile } from './channel-profile'
import { twinWriteGuard } from './feature-flags'

export function channelIdForAgent(agentId: string): string | undefined {
  try {
    const row = getAmlRuntime().db.prepare('SELECT channel_id AS channelId FROM channel_agents WHERE id = ?').get(agentId) as { channelId?: string } | undefined
    return row?.channelId ? String(row.channelId) : undefined
  }
  catch {
    return undefined
  }
}

export function guardTwinWrite(agentId: string, channelId?: string): { allowed: true } | { allowed: false, code: string, message: string } {
  const resolved = String(channelId ?? channelIdForAgent(agentId) ?? '').trim()
  // 非 Channel 直接调用保留 legacy 工具兼容性；所有 HostTool/Agent runtime 调用都会带 channel_agents 记录。
  if (!resolved) return { allowed: true }
  return twinWriteGuard(resolved, getChannelTwinProfile(resolved))
}
