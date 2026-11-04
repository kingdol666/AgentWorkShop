/**
 * Project 工具面（V1）：注入过滤 + 执行授权共用同一份名字集合。
 *
 * 工具矩阵（plan v3.0 §4.2）：
 *  - worker：只读 approved 成果；
 *  - channel lead：读交付物/成果/工作项 + 提交成果 + 申请 write_intent；
 *  - project leader：项目只读 + 提案 + 复核 + 申请审批；无 Channel lead 工具/工业写。
 *
 * 关键约束：执行层（dispatch）必须按 agent_kind + channel 再判一次；
 * 目录里隐藏不是安全边界。
 */
import type { AgentCapabilities } from '../agents/role-capabilities'

export type ProjectToolMode = 'leader' | 'channel_lead' | 'worker' | 'none'

export const PROJECT_READ_TOOL_NAMES: ReadonlySet<string> = new Set([
  'project_read_deliverables',
  'project_read_results',
  'project_read_work_items',
])

/** 仅 project leader 可用（提案/复核/审批/全局只读） */
export const PROJECT_LEADER_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set([
  'project_get_status',
  'project_list_channels',
  'project_propose_plan',
  'project_propose_dispatch',
  'project_propose_replan',
  'project_review_result',
  'project_request_approval',
])

/** 仅 channel lead 可用（成果提交与工业写意图） */
export const PROJECT_CHANNEL_LEAD_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set([
  'project_submit_result',
  'project_request_write_intent',
])

export const PROJECT_LEADER_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...PROJECT_READ_TOOL_NAMES,
  ...PROJECT_LEADER_ONLY_TOOL_NAMES,
])

export const PROJECT_CHANNEL_LEAD_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...PROJECT_READ_TOOL_NAMES,
  ...PROJECT_CHANNEL_LEAD_ONLY_TOOL_NAMES,
])

export const PROJECT_WORKER_TOOL_NAMES: ReadonlySet<string> = new Set(['project_read_results'])

export const PROJECT_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...PROJECT_LEADER_TOOL_NAMES,
  ...PROJECT_CHANNEL_LEAD_ONLY_TOOL_NAMES,
])

/** 需要 owner write_intent 的工业直写面（project-origin 任务默认不可直写）。 */
export const PROJECT_GATED_WRITE_TOOL_NAMES: ReadonlySet<string> = new Set([
  'dcw_control',
  'param_control',
  'dcw_rollback',
  'recipe_create',
  'recipe_update',
  'recipe_rollback',
  'recipe_trial',
  'recipe_apply',
  'line_start',
  'line_stop',
])

export function projectToolModeOf(cap: Pick<AgentCapabilities, 'projectLeader' | 'channelLead'>): ProjectToolMode {
  if (cap.projectLeader) return 'leader'
  if (cap.channelLead) return 'channel_lead'
  return 'none'
}

function allowedSet(mode: ProjectToolMode): ReadonlySet<string> | null {
  if (mode === 'leader') return PROJECT_LEADER_TOOL_NAMES
  if (mode === 'channel_lead') return PROJECT_CHANNEL_LEAD_TOOL_NAMES
  if (mode === 'worker') return PROJECT_WORKER_TOOL_NAMES
  return null
}

/** 仅保留 mode 允许的 project 工具；非 project 工具原样保留。 */
export function filterProjectToolSurface<T extends { name: string }>(tools: T[], mode: ProjectToolMode): T[] {
  const allowed = allowedSet(mode)
  return tools.filter((t) => {
    if (!PROJECT_TOOL_NAMES.has(t.name)) return true
    return allowed ? allowed.has(t.name) : false
  })
}

/**
 * leader 的完整工具面（白名单）：项目工具之外一律不注入。
 * 这覆盖 Channel lead 工具、工业写、插件管理面；执行层同样按本集合拒绝。
 */
export function filterLeaderToolSurface<T extends { name: string }>(tools: T[]): T[] {
  return tools.filter(t => PROJECT_LEADER_TOOL_NAMES.has(t.name))
}

/** 执行层判定：该工具是否可被该 mode 调用（非 project 工具不受本函数约束）。 */
export function projectToolCallVerdict(mode: ProjectToolMode, toolName: string): { allowed: boolean, code?: string, message?: string } {
  if (!PROJECT_TOOL_NAMES.has(toolName)) return { allowed: true }
  const allowed = allowedSet(mode)
  if (!allowed || !allowed.has(toolName)) {
    return {
      allowed: false,
      code: 'PROJECT_TOOL_DENIED',
      message: `工具 ${toolName} 不对当前角色开放（${mode}）`,
    }
  }
  return { allowed: true }
}
