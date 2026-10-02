/**
 * POST /api/workshop/agent-tools/bindings —— 绑定 Agent ↔ 工业节点。
 * body: { agentId, nodeId, kind: 'dcw'|'daq', mode?: 'auto'|'manual' }
 * 产线权限:普通用户仅可绑定自己有权产线的节点——daq 绑定需「仅查看」及以上,
 * dcw(写控)绑定需「可操控」;admin/editor 不受限。
 *
 * auto 治理(产线 Co-Pilot P2,计划 §5.4 铁律 2):**dcw 绑定首绑强制 manual**——
 * dcw 写控面挂着逐次人工审批闸,创建即 auto 等于免审上线(旧实现 body.mode 缺省
 * 还是 'auto'),故 body.mode 对 dcw 一律忽略;显式传 auto 不静默吞掉,响应附
 * modeForced + notice 提示(响应形状向后兼容,多余字段无害)。如需 auto,应在
 * 绑定创建后走 PATCH 携 confirm:true 显式切换(见 [id].patch.ts)。
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
  const body = await readBody<{ agentId?: string, nodeId?: string, kind?: 'dcw' | 'daq' | 'recipe', mode?: 'auto' | 'manual' }>(event) ?? {}
  const kind = body.kind ?? 'daq'
  const nodeId = String(body.nodeId ?? '')
  const agentId = String(body.agentId ?? '')

  // 权限模型 v2:数控节点不再直接绑定 —— Agent 只对 recipe 做参数写入与下发;
  // 节点级写控/dcw 绑定一律拒绝(存量绑定仅历史兼容,工具层已全部收敛到 recipe 面)。
  if (kind === 'dcw') {
    throw new AppError(400, 'BINDING_KIND_DEPRECATED',
      `数控节点(dcw)不再支持直接绑定:Agent 通过绑定 recipe(kind='recipe',nodeId=配方id)获得该配方参数写入与下发能力;数采观察用 kind='daq'。`)
  }

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
  // 绑定同产线的节点/配方(产线隔离的工作空间语义;未绑线的纯协作频道不受此限)。
  const nodeLineOf = (nid: string, k: 'daq' | 'recipe'): string | null | undefined => {
    if (k === 'recipe') return getDcwController().listRecipes().find(r => r.id === nid)?.lineId
    return k === 'daq' ? getDaqController().byId(nid)?.lineId : getDcwController().byId(nid)?.lineId
  }
  const targetLine = nodeLineOf(nodeId, kind)
  const channelRow = manager.deps.repos.channels.findById(memberRow.channelId)
  if (channelRow?.lineId && targetLine && channelRow.lineId !== targetLine) {
    throw new AppError(403, 'LINE_SCOPE_MISMATCH',
      `该频道已绑定产线「${channelRow.lineId}」,成员 agent 只能绑定同产线的节点/配方(目标 ${nodeId} 属于产线「${targetLine}」)。请改绑同产线对象,或将频道解绑/换绑。`)
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
  if (mode === 'none') {
    throw new AppError(403, 'LINE_FORBIDDEN', `无该产线权限:绑定数采节点需对产线「${lineId}」拥有仅查看及以上权限`)
  }
  // daq 维持 body.mode ?? 'auto' 缺省
  const bindingMode = body.mode ?? 'auto'
  const binding = getAgentNodeBindingRepo().bind(agentId, nodeId, kind, bindingMode)
  return { binding }
})
