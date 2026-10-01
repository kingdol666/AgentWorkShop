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
  const body = await readBody<{ agentId?: string, nodeId?: string, kind?: 'dcw' | 'daq', mode?: 'auto' | 'manual' }>(event) ?? {}
  const kind = body.kind ?? 'dcw'
  const nodeId = String(body.nodeId ?? '')
  const agentId = String(body.agentId ?? '')

  // 绑定主体必须是**已部署的 Channel 成员实例**(运行时就是它持这条绑定做工具鉴权)。
  // 传 Agent 模板 id 是极易发生的误用:旧实现照单全收,绑定落在模板 id 上,
  // 成员侧 daq_query / dcw_control 一律报"尚未绑定节点" —— 一条**静默失效**的授权,
  // 排查成本极高(实测:脚本按 /api/workshop/agents 返回的 id 绑定,任务全被拒绝)。
  // 这里把无声错误变成可执行提示:模板 id → 告知应改用哪个成员 id;两者都不是 → 404。
  const manager = getWorkshopManager()
  if (!manager.findChannelAgentById(agentId)) {
    const instances = manager.listChannelAgentInstances(agentId)
    if (instances.length > 0) {
      const hint = instances.map(i => `${i.id}(频道「${i.name}」)`).join('、')
      throw new AppError(400, 'AGENT_ID_NOT_MEMBER',
        `agentId 是 Agent 模板而非频道成员实例,绑定不会生效。请改用成员 id:${hint}`)
    }
    throw new AppError(404, ErrorCodes.NOT_FOUND,
      `Agent 成员不存在: ${agentId || '(空)'}(需传频道成员 id,可经 GET /api/workshop/channels/:id/agents 获取)`)
  }

  // 绑定前置:节点必须存在,且用户对其所属产线有足额权限
  const lineId = kind === 'daq'
    ? getDaqController().byId(nodeId)?.lineId
    : getDcwController().byId(nodeId)?.lineId
  if (!lineId) {
    throw new AppError(404, ErrorCodes.NOT_FOUND, `${kind === 'daq' ? '数采' : '写控'}节点不存在: ${nodeId}`)
  }
  const mode = lineMode(user, lineId)
  const needOperate = kind === 'dcw'
  if (mode === 'none' || (needOperate && mode !== 'operate')) {
    throw new AppError(403, 'LINE_FORBIDDEN', `无该产线权限:绑定${kind === 'daq' ? '数采' : '写控'}节点需对产线「${lineId}」拥有${needOperate ? '可操控' : '仅查看'}及以上权限`)
  }
  // dcw 首绑强制 manual(铁律 2);daq 维持 body.mode ?? 'auto' 缺省
  const bindingMode = kind === 'dcw' ? 'manual' : body.mode ?? 'auto'
  const binding = getAgentNodeBindingRepo().bind(agentId, nodeId, kind, bindingMode)
  if (kind === 'dcw' && body.mode === 'auto') {
    return {
      binding,
      modeForced: 'manual',
      notice: 'dcw(写控)绑定首绑强制 manual,body.mode=auto 已被忽略;如需 auto 请对该绑定 PATCH { mode: "auto", confirm: true } 显式确认切换',
    }
  }
  return { binding }
})
