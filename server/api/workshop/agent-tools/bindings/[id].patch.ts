/**
 * PATCH /api/workshop/agent-tools/bindings/:id —— 切换控制模式(auto/manual)。
 *
 * 鉴权(与 index.post.ts 同口径):manual→auto 等于**摘掉人类审批闸门**,
 * 所以必须先证明调用者可支配该绑定所属产线的节点,否则任意登录用户都能
 * 关掉别人的 HITL。早先此处只有 resolveUser。
 */
import { createError, getRouterParam, readBody } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { getAgentNodeBindingRepo } from '@/server/services/workshop/agents/node-bindings.repo'
import { requireBindingAccess } from '@/server/services/workshop/agents/binding-authz'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const id = getRouterParam(event, 'id')!
  const body = await readBody<{ mode?: 'auto' | 'manual' }>(event) ?? {}
  const repo = getAgentNodeBindingRepo()
  const binding = repo.all().find(b => b.id === id)
  if (!binding) throw createError({ statusCode: 404, statusMessage: 'binding not found' })
  requireBindingAccess(user, binding)
  return { binding: repo.setMode(id, body.mode ?? 'auto') }
})
