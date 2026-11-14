/** Trusted channel mode lookup. Missing, invalid and failed lookups are generic. */
export type ChannelMode = 'generic' | 'production_line_integrated'

function normalize(mode: unknown): ChannelMode {
  return mode === 'production_line_integrated' ? mode : 'generic'
}

export function channelModeOf(channelId: string): ChannelMode {
  try {
    const manager = (globalThis as unknown as { __workshopManager?: { channelModeOf?: (id: string) => unknown } }).__workshopManager
    return normalize(manager?.channelModeOf?.(channelId))
  }
  catch {
    return 'generic'
  }
}

export function channelModeForAgent(agentId: string): ChannelMode {
  try {
    const manager = (globalThis as unknown as { __workshopManager?: { channelModeForAgent?: (id: string) => unknown } }).__workshopManager
    return normalize(manager?.channelModeForAgent?.(agentId))
  }
  catch {
    return 'generic'
  }
}
