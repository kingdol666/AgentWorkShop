/**
 * DELETE /api/workshop/agent-tools/bindings/:id —— 解除绑定。
 */
import { createError, getRouterParam } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { getAgentNodeBindingRepo } from '@/server/services/workshop/agents/node-bindings.repo'

export default defineApiHandler(async (event) => {
  resolveUser(event)
  const id = getRouterParam(event, 'id')!
  if (!getAgentNodeBindingRepo().unbind(id)) throw createError({ statusCode: 404, statusMessage: 'binding not found' })
  return { ok: true }
})
