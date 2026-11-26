/**
 * GET /api/workshop/channels/:id/sessions/:sid/runtime/:agentId/bindings
 * 会话 runtime 的工业绑定摘要（只读）：effective 节点/配方绑定、可选资源、冻结的
 * 会话产品/配方快照。绑定写入仍走 /api/workshop/agent-tools/bindings（同一 agentId）。
 */
import { getRouterParam } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { getWorkshopManager } from '@/server/plugins/workshop'
import { createSessionRuntimeBindingService } from '@/server/services/workshop/sessions/runtime-bindings'
import { getDaqController } from '@/server/services/workshop/daq/daq-controller'
import { getDcwController } from '@/server/services/workshop/dcw/dcw-controller'
import { getAgentNodeBindingRepo } from '@/server/services/workshop/agents/node-bindings.repo'
import { lineMode } from '@/server/services/workshop/permissions'
import { toolRefreshOf } from '@/server/services/workshop/agents/registry'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const channelId = getRouterParam(event, 'id')!
  const sessionId = getRouterParam(event, 'sid')!
  const agentId = getRouterParam(event, 'agentId')!
  const manager = getWorkshopManager()
  manager.getChannelForUser(channelId, user.id)

  const summary = createSessionRuntimeBindingService(manager.deps.db, {
    listDaqNodes: () => getDaqController().listViews().map(n => ({
      id: n.id,
      name: n.name,
      unit: n.unit ?? '',
      lineId: n.lineId ?? null,
    })),
    listDcwNodes: () => getDcwController().listViews().map(n => ({
      id: n.id,
      name: n.name,
      unit: n.unit ?? '',
      lineId: n.lineId ?? null,
    })),
    listRecipes: () => getDcwController().listRecipes().map(r => ({
      id: r.id,
      name: r.name,
      version: r.version ?? 1,
      lineId: r.lineId ?? null,
      productId: r.productId ?? null,
    })),
    listLines: () => getDcwController().listLines().map(l => ({ id: l.id, name: l.name })),
    lineMode: (u, lineId) => lineMode(u, lineId),
    bindingsOf: id => getAgentNodeBindingRepo().byAgent(id).map(b => ({
      id: b.id,
      nodeId: b.nodeId,
      kind: b.kind,
      mode: b.mode,
    })),
    toolRefresh: harness => toolRefreshOf(harness),
  }).get({ channelId, sessionId, agentId, user: { id: user.id, role: user.role } })

  return summary
})
