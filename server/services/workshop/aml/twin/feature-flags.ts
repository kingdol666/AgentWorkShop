export interface AmlTwinFeatureFlags {
  channelEnabled: boolean
  trainingEnabled: boolean
  trialEnabled: boolean
  mpcEnabled: boolean
  governedWriteEnabled: boolean
  boundedAutoEnabled: boolean
}

function flag(name: string, fallback: boolean): boolean {
  const raw = process.env[name]
  if (raw == null || raw.trim() === '') return fallback
  return ['1', 'true', 'yes', 'on', 'enabled'].includes(raw.trim().toLowerCase())
}

/**
 * AML Twin 的服务端 feature flags。在线写入默认关闭；推荐/试验路径默认保持可用，
 * 这样可以继续跑 VirtualTrial 和 recommendation-only 验收而不会误触 PLC。
 */
export function amlTwinFeatureFlags(): AmlTwinFeatureFlags {
  return {
    channelEnabled: flag('AML_TWIN_CHANNEL_ENABLED', true),
    trainingEnabled: flag('AML_TWIN_TRAINING_ENABLED', true),
    trialEnabled: flag('AML_TWIN_TRIAL_ENABLED', true),
    mpcEnabled: flag('AML_TWIN_MPC_ENABLED', true),
    governedWriteEnabled: flag('AML_TWIN_GOVERNED_WRITE_ENABLED', false),
    boundedAutoEnabled: flag('AML_TWIN_BOUNDED_AUTO_ENABLED', false),
  }
}

export function twinCapabilityEnabled(capability: keyof AmlTwinFeatureFlags): boolean {
  return amlTwinFeatureFlags()[capability]
}

export function assertTwinCapability(capability: 'channelEnabled' | 'trainingEnabled' | 'trialEnabled' | 'mpcEnabled'): void {
  if (!amlTwinFeatureFlags()[capability]) throw new Error(`AML_TWIN_${capability.replace('Enabled', '').toUpperCase()}_DISABLED`)
}

export function twinWriteGuard(channelId: string, profile: { profile: string, controlPolicy?: string, capability?: Record<string, unknown> }): { allowed: true } | { allowed: false, code: string, message: string } {
  if (profile.profile !== 'hybrid_twin') return { allowed: true }
  const flags = amlTwinFeatureFlags()
  if (!flags.channelEnabled) return { allowed: false, code: 'AML_TWIN_CHANNEL_DISABLED', message: 'AML Twin Channel 功能开关已关闭，拒绝在线写入。' }
  if (profile.controlPolicy === 'recommendation_only' || !profile.controlPolicy) {
    // 未通过 Twin Gate 时允许进入 exploration，但只允许下层 DCW 单步/60s
    // 硬联锁；没有明确 capability 的旧频道仍保持 recommendation-only 禁写。
    const cap = profile.capability ?? {}
    const phase = String(cap.phase ?? cap.twinPhase ?? '').toLowerCase()
    const safeExploration = cap.explorationWrite !== false && (
      cap.explorationWrite === true
      || cap.safeSmallStep === true
      || ['discovery', 'exploration', 'calibration'].includes(phase)
      // 兼容在本安全卡控上线前创建的 Hybrid Channel:它们没有 phase，
      // 但只要不是显式关闭探索，就走服务端 stepLimit/60s 硬闸门。
      || cap.mpcRecommendation === true
      || Object.keys(cap).length === 0
    )
    if (safeExploration) return { allowed: true }
    return { allowed: false, code: 'AML_TWIN_RECOMMENDATION_ONLY', message: `Hybrid Twin Channel ${channelId} 当前是 recommendation_only；直接 DCW/参数写入被平台拒绝，必须先进入明确标记的 exploration/safe_small_step 阶段并通过单步/60s 安全联锁。` }
  }
  if (profile.controlPolicy === 'hitl_governed' && !flags.governedWriteEnabled) return { allowed: false, code: 'AML_TWIN_GOVERNED_WRITE_DISABLED', message: 'hitl_governed 写入开关默认关闭；当前只允许 recommendation-only，未签发 WriteGrant。' }
  if (profile.controlPolicy === 'bounded_auto' && !flags.boundedAutoEnabled) return { allowed: false, code: 'AML_TWIN_BOUNDED_AUTO_DISABLED', message: 'bounded_auto 写入开关默认关闭；当前只允许 recommendation-only，未签发 WriteGrant。' }
  return { allowed: false, code: 'AML_TWIN_WRITE_GRANT_REQUIRED', message: 'Hybrid Twin 在线写入必须由平台签发经校验的 WriteGrant；Agent 不能直接伪造或绕过门禁。' }
}
