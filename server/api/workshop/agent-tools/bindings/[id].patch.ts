/**
 * PATCH /api/workshop/agent-tools/bindings/:id —— 切换控制模式(auto/manual)。
 */
import { getRouterParam, readBody } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { getAgentNodeBindingRepo } from '@/server/services/workshop/agents/node-bindings.repo'

export default defineApiHandler(async (event) => {
  resolveUser(event)
  const id = getRouterParam(event, 'id')!
  const body = await readBody<{ mode?: 'auto' | 'manual' }>(event) ?? {}
  return { binding: getAgentNodeBindingRepo().setMode(id, body.mode ?? 'auto') }
})
