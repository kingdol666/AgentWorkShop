/**
 * POST /api/workshop/agent-tools/bindings —— 绑定 Agent ↔ 工业节点。
 * body: { agentId, nodeId, kind: 'dcw'|'daq', mode: 'auto'|'manual' }
 * 产线权限:普通用户仅可绑定自己有权产线的节点——daq 绑定需「仅查看」及以上,
 * dcw(写控)绑定需「可操控」;admin/editor 不受限。
 */
import { readBody } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { getAgentNodeBindingRepo } from '@/server/services/workshop/agents/node-bindings.repo'
import { lineMode } from '@/server/services/workshop/permissions'
import { getDaqController } from '@/server/services/workshop/daq/daq-controller'
import { getDcwController } from '@/server/services/workshop/dcw/dcw-controller'
import { AppError, ErrorCodes } from '@/server/utils/errors'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const body = await readBody<{ agentId?: string, nodeId?: string, kind?: 'dcw' | 'daq', mode?: 'auto' | 'manual' }>(event) ?? {}
  const kind = body.kind ?? 'dcw'
  const nodeId = String(body.nodeId ?? '')
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
  const binding = getAgentNodeBindingRepo().bind(
    String(body.agentId ?? ''),
    nodeId,
    kind,
    body.mode ?? 'auto',
  )
  return { binding }
})
