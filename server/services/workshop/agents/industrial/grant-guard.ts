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
import { recordOps } from '../../ops/ops'

/** 写族工具:涉及产线写向/下发意图,要求 operate(其余工业工具按只读复核) */
const WRITE_TOOLS = new Set([
  'recipe_propose',
  'recipe_create',
  'recipe_update',
  'recipe_apply',
  'recipe_trial',
  'recipe_rollback',
  'optimization_explore',
  'twin_calibration_request',
  // 产线管理面(启停直接改物理状态与批次窗口)
  'line_start',
  'line_stop',
  // 模型采纳(OW-adopt):改变求解器运行的模型工件(控制面写向,HITL 卡裁决)
  'optimizer_profile_propose',
  // 本体(ONT):知识起草与发布提议属产线域写向动作(不写设备,但会改变控制侧知识来源)
  'ontology_draft_create',
  'ontology_draft_update',
  'ontology_publish_propose',
])

/** 无需复核的纯协作/管理面工具(不触达产线数据) */
const GRANT_EXEMPT = new Set([
  'team_grant_nodes',
  'team_revoke_nodes',
  'aml_activity',
  'exp_collect',
])

function draftLineId(draftJson: string): string {
  try {
    return (JSON.parse(draftJson || '{}') as { lineId?: string }).lineId ?? ''
  }
  catch {
    return ''
  }
}

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
  // 本体草稿 → 授权锚产线(草稿 doc.lineId;空则取该本体最近版本的 lineId)。
  // 缺口修复(计划 ONT-13):draft_id 不在原解析面时 lineSet 为空会直接放行 operate 判定。
  const draftId = one(args.draft_id ?? args.draftId)
  if (draftId) {
    const { getAmlRuntime } = await import('@/server/services/workshop/aml/runtime')
    const db = getAmlRuntime().db
    const row = db.prepare('SELECT ontology_id AS ontologyId, draft_json AS draftJson FROM ontology_drafts WHERE id = ?').get(draftId) as
      { ontologyId?: string, draftJson?: string } | undefined
    if (row) {
      let lineId = draftLineId(row.draftJson ?? '')
      if (!lineId && row.ontologyId) {
        const v = db.prepare('SELECT line_id AS lineId FROM ontology_versions WHERE id = ? ORDER BY version DESC LIMIT 1').get(row.ontologyId) as { lineId?: string } | undefined
        lineId = v?.lineId ?? ''
      }
      if (lineId) lines.add(lineId)
    }
  }
  // 模型采纳:profile_id → 该 Agent 对该 Profile 绑定所在产线(经 profile→spec)
  const adoptProfileId = one(args.profile_id)
  if (adoptProfileId) {
    const { getAmlRuntime } = await import('@/server/services/workshop/aml/runtime')
    const db = getAmlRuntime().db
    const b = db.prepare('SELECT id FROM optimizer_bindings WHERE channel_agent_id = ? AND profile_id = ? LIMIT 1').get(agentId, adoptProfileId) as { id?: string } | undefined
    const bindingId2 = b?.id ?? ''
    if (bindingId2) {
      const prof = db.prepare('SELECT process_spec_ref AS specRef FROM optimizer_profiles WHERE id = ? ORDER BY version DESC LIMIT 1').get(adoptProfileId) as { specRef?: string } | undefined
      const [specId] = (prof?.specRef ?? '').split('@')
      if (specId) {
        const spec = db.prepare('SELECT line_id AS lineId FROM process_model_specs WHERE id = ?').get(specId) as { lineId?: string } | undefined
        if (spec?.lineId) lines.add(spec.lineId)
      }
    }
  }
  // 本体版本 → 版本产线(版本比较的归属面)  // 本体版本 → 版本产线(版本比较的归属面)
  const ontologyId = one(args.ontology_id ?? args.ontologyId)
  if (ontologyId) {
    const { getAmlRuntime } = await import('@/server/services/workshop/aml/runtime')
    const db = getAmlRuntime().db
    const wantsVersion = args.version !== undefined ? Number(args.version) : Number.NaN
    const v = Number.isInteger(wantsVersion)
      ? db.prepare('SELECT line_id AS lineId FROM ontology_versions WHERE id = ? AND version = ?').get(ontologyId, wantsVersion) as { lineId?: string } | undefined
      : db.prepare(`SELECT line_id AS lineId FROM ontology_versions WHERE id = ? AND status = 'published' ORDER BY version DESC LIMIT 1`).get(ontologyId) as { lineId?: string } | undefined
    if (v?.lineId) lines.add(v.lineId)
  }
  // Optimizer 绑定 → 目标产线(Profile → ProcessModelSpec.lineId);只读工具同样受线授权约束
  const bindingId = one(args.binding_id ?? args.bindingId)
  if (bindingId) {
    const { getAmlRuntime } = await import('@/server/services/workshop/aml/runtime')
    const db = getAmlRuntime().db
    const binding = db.prepare('SELECT profile_id AS profileId, profile_version AS profileVersion FROM optimizer_bindings WHERE id = ? AND channel_agent_id = ?')
      .get(bindingId, agentId) as { profileId: string, profileVersion: number } | undefined
    if (binding) {
      const profile = db.prepare('SELECT process_spec_ref AS specRef FROM optimizer_profiles WHERE id = ? AND version = ?')
        .get(binding.profileId, binding.profileVersion) as { specRef: string } | undefined
      const [specId, specVersion] = (profile?.specRef ?? '').split('@')
      if (specId) {
        const spec = db.prepare('SELECT line_id AS lineId FROM process_model_specs WHERE id = ? AND version = ?')
          .get(specId, Number(specVersion || '1')) as { lineId: string } | undefined
        if (spec?.lineId) lines.add(spec.lineId)
      }
    }
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

/** 授权性拒绝入册(与 tool-verify 同口径,/logs 可追溯撤权后的越权尝试) */
function deny(identity: GuardIdentity, toolName: string, args: Record<string, unknown>, text: string, reason: string): { text: string, isError: true } {
  try {
    recordOps({
      actor: identity.agentId,
      actorName: identity.agentId,
      actorKind: 'agent',
      action: 'tool.call.denied',
      kind: 'system',
      level: 'warn',
      targetKind: 'tool',
      targetId: toolName,
      summary: `工具调用被拒(权限复核):${reason}`,
      detail: { tool: toolName, args, reason },
    })
  }
  catch { /* 审计失败不影响拒绝语义 */ }
  return { text, isError: true }
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
      return deny(identity, toolName, args, `工具调用被拒:所属频道不存在或已删除(channel=${identity.channelId.slice(0, 8)})。`, 'channel_missing')
    }
    // 遗留无主 channel 豁免(存量兼容;新 channel 均有属主)
    if (!channel.ownerUserId) return null
    const owner = userRepository.findById(channel.ownerUserId)
    if (!owner) {
      return deny(identity, toolName, args, '工具调用被拒:频道属主账号不存在(fail-closed)。请联系管理员。', 'owner_missing')
    }
    if (owner.role === 'admin') return null

    const need: LineMode = WRITE_TOOLS.has(toolName) ? 'operate' : 'readonly'
    const resolved = await resolveTargetLines(identity.agentId, toolName, args ?? {})
    // P1-6:频道绑线并入复核集 —— line_start/line_stop 等产线管理工具的目标产线
    // 来自频道绑线(ch.lineId)而非调用参数,agent 无节点绑定时 resolveTargetLines
    // 返回 null → 守卫在此直接放行,属主被撤权后绑线频道的启停/读面照常工作
    // (收权即失活的结构性缺口,2026-10-08 评审)。
    const lineSet = new Set(resolved ?? [])
    if (channel.lineId) lineSet.add(channel.lineId)
    if (lineSet.size === 0) return null
    for (const lineId of lineSet) {
      const mode = lineMode({ id: owner.id, role: owner.role }, lineId)
      const ok = mode === 'operate' || (need === 'readonly' && mode === 'readonly')
      if (!ok) {
        const what = need === 'operate' ? '写控/下发' : '读取'
        return deny(
          identity,
          toolName,
          args,
          `工具调用被拒(权限模型 v3):频道属主对产线「${lineId}」无${need === 'operate' ? '可操控' : '查看'}授权,无法${what}。请联系管理员在「权限管理」中重新授予;该限制在授权收回后即时生效。`,
          `line_grant_revoked:${lineId}:${need}`,
        )
      }
    }
    return null
  }
  catch (err) {
    if (err instanceof AppError) throw err
    // 守卫自身故障 → fail-closed(不因实现缺陷放行)
    return deny(identity, toolName, args, `工具调用被拒:权限复核服务异常(${err instanceof Error ? err.message : String(err)})。`, 'guard_error')
  }
}
