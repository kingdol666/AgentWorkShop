/**
 * grant-guard —— 工业工具运行时产线 grant 复核(权限模型 v3 / 收权即失活的收口)。
 *
 * 为什么需要:agent 绑定面是**绑定时点**的静态授权(绑定端点已校验 lineMode),
 * 但 admin 事后撤销某用户的产线授权后,绑定行仍在 —— 若工具分发只查绑定面,
 * 被撤权用户的 agent 依旧能经工具桥读/写该产线(REST/内部回合/MCP 全路径)。
 * 本守卫在工业工具分发入口按**调用上下文的当前 grant**复核:
 *   - 上下文用户 = channel 属主(REST invoke 的调用者已另行校验可支配该 agent,
 *     二者语义一致;agent 自主回合归属其 channel 属主);
 *   - 目标产线从调用参数解析(node_id / recipe_id / line_id / ids),解析不到时
 *     回退为「该 agent 全部绑定的产线」(如 daq_query 不带 node_id 的全节点查询);
 *   - 只读工具要求 ≥readonly,写族工具要求 operate;
 *   - 遗留无主 channel(owner NULL)豁免(存量数据兼容;新建 channel 均有属主);
 *   - admin 属主天然放行;channel/属主不存在 → fail-closed 拒绝。
 */
import { AppError } from '@/server/utils/errors'
import { userRepository } from '@/server/repositories/user.repository'
import { lineMode, type LineMode } from '@/server/services/workshop/permissions'
import { INDUSTRIAL_TOOL_NAMES } from '../host-tool-bridge/tools/industrial'

/** 写族工具:涉及产线写向/下发意图,要求 operate(其余工业工具按只读复核) */
const WRITE_TOOLS = new Set([
  'recipe_propose',
  'recipe_update',
  'recipe_apply',
  'recipe_trial',
  'recipe_rollback',
  'optimization_explore',
  'twin_calibration_request',
  // 产线管理面(启停直接改物理状态与批次窗口)
  'line_start',
  'line_stop',
])

/** 无需复核的纯协作/管理面工具(不触达产线数据) */
const GRANT_EXEMPT = new Set([
  'team_grant_nodes',
  'team_revoke_nodes',
  'aml_activity',
  'exp_collect',
])

interface GuardIdentity {
  agentId: string
  channelId: string
}

/** 从调用参数解析涉及的产线(动态 import 重仓,避免与 dcw/daq 模块循环依赖) */
async function resolveTargetLines(agentId: string, toolName: string, args: Record<string, unknown>): Promise<string[] | null> {
  const lines = new Set<string>()
  const one = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : '')
  const nodeIdLine = async (id: string): Promise<string | null> => {
    const { getDaqNodeRepo } = await import('@/server/services/workshop/daq/daq-node.repo')
    const daq = getDaqNodeRepo().byId(id)
    if (daq?.lineId) return daq.lineId
    const { getDcwController } = await import('@/server/services/workshop/dcw/dcw-controller')
    return getDcwController().byId(id)?.lineId ?? null
  }
  const { getDcwController } = await import('@/server/services/workshop/dcw/dcw-controller')

  const explicit = one(args.node_id ?? args.nodeId)
  if (explicit) {
    const l = await nodeIdLine(explicit)
    if (l) lines.add(l)
  }
  const recipeId = one(args.recipe_id ?? args.recipeId)
  if (recipeId) {
    const r = getDcwController().listRecipes().find(x => x.id === recipeId)
    if (r?.lineId) lines.add(r.lineId)
  }
  const lineArg = one(args.line_id ?? args.lineId)
  if (lineArg) lines.add(lineArg)
  const ids = Array.isArray(args.ids) ? args.ids.map(one).filter(Boolean) : []
  for (const id of ids) {
    const l = await nodeIdLine(id)
    if (l) lines.add(l)
  }
  if (lines.size > 0) return [...lines]

  // 无显式目标(如全节点 daq_query)→ 回退 agent 绑定面涉及的全部产线
  const { getAgentNodeBindingRepo } = await import('@/server/services/workshop/agents/node-bindings.repo')
  const bindings = getAgentNodeBindingRepo().byAgent(agentId)
  for (const b of bindings) {
    if (b.kind === 'recipe') {
      const r = getDcwController().listRecipes().find(x => x.id === b.nodeId)
      if (r?.lineId) lines.add(r.lineId)
    }
    else {
      const l = await nodeIdLine(b.nodeId)
      if (l) lines.add(l)
    }
  }
  return lines.size > 0 ? [...lines] : null
}

/**
 * 工业工具分发前的 grant 复核。通过 → 静默返回;
 * 不通过 → 返回面向 agent 的工具错误文本(fail-closed,不做部分放行)。
 */
export async function guardIndustrialToolGrant(identity: GuardIdentity, toolName: string, args: Record<string, unknown>): Promise<{ text: string, isError: true } | null> {
  if (!INDUSTRIAL_TOOL_NAMES.has(toolName) || GRANT_EXEMPT.has(toolName)) return null
  if (!identity.channelId) return null
  try {
    const { getWorkshopManager } = await import('@/server/plugins/workshop')
    const manager = getWorkshopManager()
    const channel = manager.deps.repos.channels.findById(identity.channelId)
    if (!channel) {
      return { text: `工具调用被拒:所属频道不存在或已删除(channel=${identity.channelId.slice(0, 8)})。`, isError: true }
    }
    // 遗留无主 channel 豁免(存量兼容;新 channel 均有属主)
    if (!channel.ownerUserId) return null
    const owner = userRepository.findById(channel.ownerUserId)
    if (!owner) {
      return { text: '工具调用被拒:频道属主账号不存在(fail-closed)。请联系管理员。', isError: true }
    }
    if (owner.role === 'admin') return null

    const need: LineMode = WRITE_TOOLS.has(toolName) ? 'operate' : 'readonly'
    const lines = await resolveTargetLines(identity.agentId, toolName, args ?? {})
    if (!lines) return null
    for (const lineId of lines) {
      const mode = lineMode({ id: owner.id, role: owner.role }, lineId)
      const ok = mode === 'operate' || (need === 'readonly' && mode === 'readonly')
      if (!ok) {
        const what = need === 'operate' ? '写控/下发' : '读取'
        return {
          text: `工具调用被拒(权限模型 v3):频道属主对产线「${lineId}」无${need === 'operate' ? '可操控' : '查看'}授权,无法${what}。请联系管理员在「权限管理」中重新授予;该限制在授权收回后即时生效。`,
          isError: true,
        }
      }
    }
    return null
  }
  catch (err) {
    if (err instanceof AppError) throw err
    // 守卫自身故障 → fail-closed(不因实现缺陷放行)
    return { text: `工具调用被拒:权限复核服务异常(${err instanceof Error ? err.message : String(err)})。`, isError: true }
  }
}
