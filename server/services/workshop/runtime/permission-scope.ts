/**
 * 人类发起者权限上下文的服务端判定(主计划 §13.3)。
 *
 * 合同(类型/解析/交集)在 `shared/workshop-protocol.ts`;本模块只放**服务端执行语义**:
 * 哪些工具属于「管理面」、哪些属于「高危写」,以及给定作用域下是否放行。
 *
 * 分类**不发明新清单**,而是复用既有授权概念:
 *  - 管理面 = `LEAD_ONLY_TOOL_NAMES`(host-tool-bridge 里已存在的 lead 专属工具集合:
 *    派活/改派/改题/建删 agent/模型晋升)。这些工具本身就要求 lead 身份;
 *    由普通成员 @Agent 触发的运行不得因为 Agent 身份更高而绕过。
 *  - 高危写 = 工业/工艺写与控制类工具(改现场参数、下发控制、回滚、提交训练/数据任务)。
 *    这些工具的正常使用路径是 owner 显式授予(§13.3「跨 Channel、私有 memory、
 *    工业/高危工具需 owner 明确授予」)。
 */
import { LEAD_ONLY_TOOL_NAMES } from '../agents/host-tool-bridge'
import type { WorkshopPermissionScope } from '../../../../shared/workshop-protocol'

/** 管理面工具(Channel/Agent/Task/Plugin 的管理动作) */
export const MANAGEMENT_TOOL_NAMES: ReadonlySet<string> = LEAD_ONLY_TOOL_NAMES

/**
 * 高危写/控制工具。
 * 取值来自 host-tool-bridge 的 dispatch 分支(dcw_control/param_control/dcw_rollback/
 * aml_job_submit/aml_model_promote/aml_dataset_build)与工业工具族(包括配方写入/回退)
 * —— 这些都是"会让现场设备或数据发生变化"的动作,只读的 *_read/_query/_frames/_status 不在其中。
 */
export const HIGH_RISK_TOOL_NAMES: ReadonlySet<string> = new Set([
  'dcw_control',
  'dcw_rollback',
  'param_control',
  'recipe_update',
  'recipe_rollback',
  'aml_job_submit',
  'aml_job_cancel',
  'aml_dataset_build',
  'aml_model_promote',
])

export type ToolScopeVerdict
  = | { allowed: true }
    | { allowed: false, reason: 'MANAGEMENT_TOOL_DENIED' | 'HIGH_RISK_TOOL_DENIED', message: string }

/**
 * 该作用域下是否允许调用该工具。
 * 无作用域(undefined/null)→ 放行:这不是人类触发的调用(系统/agent 自发),沿用既有授权。
 * 作用域存在但能力位为 false → 拒绝(§13.5「未知 response 枚举直接拒绝,不得默认允许」
 * 的同一精神:权限判定默认收紧)。
 */
export function checkToolAgainstScope(
  scope: WorkshopPermissionScope | null | undefined,
  tool: string,
): ToolScopeVerdict {
  if (!scope) return { allowed: true }
  if (scope.canManageChannel !== true && MANAGEMENT_TOOL_NAMES.has(tool)) {
    return {
      allowed: false,
      reason: 'MANAGEMENT_TOOL_DENIED',
      message: `工具 ${tool} 属于 Channel 管理面;本次调用由群成员(${scope.requesterUserId || '未知用户'})发起,`
        + '未获管理授权(§13.3:发起者权限不得因 Agent 身份更高而放大)。请 Channel owner 直接操作。',
    }
  }
  if (scope.canUseHighRiskTools !== true && HIGH_RISK_TOOL_NAMES.has(tool)) {
    return {
      allowed: false,
      reason: 'HIGH_RISK_TOOL_DENIED',
      message: `工具 ${tool} 属于工业/高危写操作;本次调用由群成员(${scope.requesterUserId || '未知用户'})发起,`
        + '未获高危授权(§13.3:工业/高危工具需 owner 明确授予)。请 Channel owner 直接操作或显式授权。',
    }
  }
  return { allowed: true }
}

/** 从 mailbox 元数据里取作用域(宽容:非法值按"无作用域"处理,不抛错) */
export function scopeFromMetadata(
  metadata: Record<string, unknown> | undefined | null,
  parse: (raw: unknown) => WorkshopPermissionScope | null,
  header: string,
): WorkshopPermissionScope | null {
  if (!metadata) return null
  return parse(metadata[header])
}
