/**
 * POST /api/workshop/agent-tools/bindings —— 绑定 Agent ↔ 工业对象。
 * body: { agentId, nodeId, kind: 'dcw'|'daq'|'recipe'|'line-recipe', mode?: 'auto'|'manual' }
 * 产线权限:普通用户仅可绑定自己有权产线的对象——daq 绑定需「仅查看」及以上,
 * dcw/recipe/line-recipe(写向/管理向)绑定需「可操控」;admin/editor 不受限。
 *
 * 三轨授权(2026-10-28 节点级写授权 + 产线配方管理权):
 *   - kind='recipe'(nodeId=配方 id)= 单配方操作权(update/apply/trial/rollback);
 *   - kind='dcw'(nodeId=数控节点 id)= **点位写授权面 + 下发范围收窄器** —— Agent 仍不能
 *     直写节点(param_control/dcw_control 恒拒桩不动);绑了 dcw 后,下发只能覆盖这些点位;
 *   - kind='line-recipe'(nodeId=产线 id)= **产线配方管理权**:对该线全部配方(含未来新建)
 *     可 查看/新建/修改/回退;下发仍按 dcw 收窄规则(未绑任何 dcw = 配方全参数可发,向下兼容)。
 *
 * auto 治理(产线 Co-Pilot P2,计划 §5.4 铁律 2):**写向/管理向绑定首绑强制 manual**——
 * 创建即 auto 等于免审上线,故 body.mode 对 dcw/recipe/line-recipe 一律忽略;显式传 auto
 * 不静默吞掉,响应附 modeForced + notice 提示(响应形状向后兼容)。如需 auto,应在绑定
 * 创建后走 PATCH 携 confirm:true 显式切换(见 [id].patch.ts)。
 * daq 绑定仅授权 daq_query 读(工具面无写族、mode 无审批语义可摘),维持原样。
 */
import { readBody } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { getAgentNodeBindingRepo } from '@/server/services/workshop/agents/node-bindings.repo'
import { lineMode } from '@/server/services/workshop/permissions'
import { getDaqController } from '@/server/services/workshop/daq/daq-controller'
import { getDcwController } from '@/server/services/workshop/dcw/dcw-controller'
import { getWorkshopManager } from '@/server/plugins/workshop'
import { AppError, ErrorCodes } from '@/server/utils/errors'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const body = await readBody<{ agentId?: string, nodeId?: string, kind?: 'dcw' | 'daq' | 'recipe' | 'line-recipe', mode?: 'auto' | 'manual' }>(event) ?? {}
  const kind = body.kind ?? 'daq'
  const nodeId = String(body.nodeId ?? '')
  const agentId = String(body.agentId ?? '')

  // 绑定主体必须是**已部署的 Channel 成员实例**(运行时就是它持这条绑定做工具鉴权)。
  // 传 Agent 模板 id 是极易发生的误用:旧实现照单全收,绑定落在模板 id 上,
  // 成员侧 daq_query / dcw_control 一律报"尚未绑定节点" —— 一条**静默失效**的授权,
  // 排查成本极高(实测:脚本按 /api/workshop/agents 返回的 id 绑定,任务全被拒绝)。
  // 这里把无声错误变成可执行提示:模板 id → 告知应改用哪个成员 id;两者都不是 → 404。
  const manager = getWorkshopManager()
  const memberRow = manager.findChannelAgentById(agentId)
  if (!memberRow) {
    const instances = manager.listChannelAgentInstances(agentId)
    if (instances.length > 0) {
      const hint = instances.map(i => `${i.id}(频道「${i.name}」)`).join('、')
      throw new AppError(400, 'AGENT_ID_NOT_MEMBER',
        `agentId 是 Agent 模板而非频道成员实例,绑定不会生效。请改用成员 id:${hint}`)
    }
    throw new AppError(404, ErrorCodes.NOT_FOUND,
      `Agent 成员不存在: ${agentId || '(空)'}(需传频道成员 id,可经 GET /api/workshop/channels/:id/agents 获取)`)
  }

  // 权限模型 v3:绑线 channel 的产线一致性 —— channel 绑了产线后,其成员 agent 只能
  // 绑定同产线的节点/配方/产线管理权(产线隔离的工作空间语义;未绑线的纯协作频道不受此限)。
  const nodeLineOf = (nid: string, k: 'daq' | 'dcw' | 'recipe' | 'line-recipe'): string | null | undefined => {
    if (k === 'recipe') return getDcwController().listRecipes().find(r => r.id === nid)?.lineId
    if (k === 'line-recipe') return nid
    return k === 'daq' ? getDaqController().byId(nid)?.lineId : getDcwController().byId(nid)?.lineId
  }
  const targetLine = nodeLineOf(nodeId, kind)
  const channelRow = manager.deps.repos.channels.findById(memberRow.channelId)
  if (channelRow?.lineId && targetLine && channelRow.lineId !== targetLine) {
    throw new AppError(403, 'LINE_SCOPE_MISMATCH',
      `该频道已绑定产线「${channelRow.lineId}」,成员 agent 只能绑定同产线的节点/配方(目标 ${nodeId} 属于产线「${targetLine}」)。请改绑同产线对象,或将频道解绑/换绑。`)
  }

  if (kind === 'line-recipe') {
    // 产线配方管理权:nodeId 字段 = 产线 id;要求调用者对该产线「可操控」(管理向授权)
    const { getDcwLineRepo } = await import('@/server/services/workshop/dcw/dcw-line.repo')
    const line = getDcwLineRepo().byId(nodeId)
    if (!line) throw new AppError(404, ErrorCodes.NOT_FOUND, `产线不存在: ${nodeId}`)
    const mode = lineMode(user, line.id)
    if (mode !== 'operate') {
      throw new AppError(403, 'LINE_FORBIDDEN', `无该产线权限:授予产线配方管理权需对产线「${line.name}」拥有可操控权限`)
    }
    // 管理向绑定首绑恒 manual(每次 创建/修改/回退 需人工批准);auto 须 PATCH confirm:true 显式切换
    const binding = getAgentNodeBindingRepo().bind(agentId, nodeId, 'line-recipe', 'manual')
    if (body.mode === 'auto') {
      return {
        binding,
        modeForced: 'manual',
        notice: '产线配方管理权默认 manual(该线配方的创建/修改/回退每次需人工批准),body.mode=auto 已被忽略;如需 auto 请对该绑定 PATCH { mode: "auto", confirm: true } 显式确认切换',
      }
    }
    return { binding }
  }

  if (kind === 'recipe') {
    // recipe 绑定:nodeId 字段 = 配方 id;要求调用者对该配方所在产线「可操控」
    const recipe = getDcwController().listRecipes().find(r => r.id === nodeId)
    if (!recipe) throw new AppError(404, ErrorCodes.NOT_FOUND, `配方不存在: ${nodeId}`)
    const mode = lineMode(user, recipe.lineId)
    if (mode !== 'operate') {
      throw new AppError(403, 'LINE_FORBIDDEN', `无该产线权限:绑定配方需对产线「${recipe.lineId}」拥有可操控权限`)
    }
    // recipe 绑定恒 manual(默认要认证):每次参数写入/下发都挂 HITL 等人工批准;
    // auto 一律走 PATCH { mode: "auto", confirm: true } 显式确认切换(body.mode 恒忽略,
    // 避免"再绑一个新配方即免审"的旁路 —— 逐配方默认安全)
    const binding = getAgentNodeBindingRepo().bind(agentId, nodeId, 'recipe', 'manual')
    if (body.mode === 'auto') {
      return {
        binding,
        modeForced: 'manual',
        notice: 'recipe 绑定默认 manual(每次写入/下发需人工批准并附理由),body.mode=auto 已被忽略;如需 auto 请对该绑定 PATCH { mode: "auto", confirm: true } 显式确认切换',
      }
    }
    return { binding }
  }

  // 绑定前置:节点必须存在,且用户对其所属产线有足额权限
  const lineId = kind === 'daq'
    ? getDaqController().byId(nodeId)?.lineId
    : getDcwController().byId(nodeId)?.lineId
  if (!lineId) {
    throw new AppError(404, ErrorCodes.NOT_FOUND, `${kind === 'daq' ? '数采' : '写控'}节点不存在: ${nodeId}`)
  }
  const mode = lineMode(user, lineId)
  // daq 只读绑定「仅查看」即可;dcw 是写授权面,需「可操控」(与 binding-authz 同口径)
  const need = kind === 'daq' ? '仅查看' : '可操控'
  if (mode === 'none') {
    throw new AppError(403, 'LINE_FORBIDDEN', `无该产线权限:绑定${kind === 'daq' ? '数采' : '数控'}节点需对产线「${lineId}」拥有${need}及以上权限`)
  }
  if (kind === 'dcw' && mode !== 'operate') {
    throw new AppError(403, 'LINE_READONLY', `该绑定涉及写控节点,需对产线「${lineId}」拥有可操控权限(当前:仅查看)`)
  }
  if (kind === 'dcw') {
    // 写向绑定首绑恒 manual(每次下发/试验需人工批准);auto 须 PATCH confirm:true 显式切换
    const binding = getAgentNodeBindingRepo().bind(agentId, nodeId, 'dcw', 'manual')
    if (body.mode === 'auto') {
      return {
        binding,
        modeForced: 'manual',
        notice: '数控节点绑定默认 manual(点位写授权,每次下发/试验需人工批准),body.mode=auto 已被忽略;如需 auto 请对该绑定 PATCH { mode: "auto", confirm: true } 显式确认切换',
      }
    }
    return { binding }
  }
  // daq 维持 body.mode ?? 'auto' 缺省
  const bindingMode = body.mode ?? 'auto'
  const binding = getAgentNodeBindingRepo().bind(agentId, nodeId, kind, bindingMode)
  return { binding }
})
