/** 工具治理共享类型(目录/策略/UI 共用;纯类型,零运行时依赖)。 */

export type ToolBlockReason
  = | 'OK'
    | 'ROLE_DENIED'
    | 'PROFILE_DENIED'
    | 'WRITE_GUARD'
    | 'PLUGIN_DISABLED'
    | 'CHANNEL_PLUGIN_DISABLED'
    | 'CHANNEL_TOOL_DISABLED'
    | 'EXEC_MODE_OBSERVE'
    | 'UNAVAILABLE'
    | 'UNKNOWN'

export interface ToolExclusion {
  reason: Exclude<ToolBlockReason, 'OK'>
  message: string
}

export type ToolRoleName = 'lead' | 'worker'
