/**
 * POST /api/workshop/agent-tools/bindings —— 绑定 Agent ↔ 工业节点。
 * body: { agentId, nodeId, kind: 'dcw'|'daq', mode: 'auto'|'manual' }
 */
import { readBody } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { getAgentNodeBindingRepo } from '@/server/services/workshop/agents/node-bindings.repo'

export default defineApiHandler(async (event) => {
  resolveUser(event)
  const body = await readBody<{ agentId?: string, nodeId?: string, kind?: 'dcw' | 'daq', mode?: 'auto' | 'manual' }>(event) ?? {}
  const binding = getAgentNodeBindingRepo().bind(
    String(body.agentId ?? ''),
    String(body.nodeId ?? ''),
    body.kind ?? 'dcw',
    body.mode ?? 'auto',
  )
  return { binding }
})
