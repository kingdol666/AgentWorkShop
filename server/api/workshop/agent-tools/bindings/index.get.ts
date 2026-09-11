/**
 * GET /api/workshop/agent-tools/bindings?agentId= —— Agent 工业节点绑定列表。
 *
 * 鉴权:不带 agentId 时**不再返回全量授权表** —— 那是控制面数据(谁被允许动哪台设备),
 * 且是「PATCH 摘 HITL 闸门」的枚举原语。改为按调用者可见产线过滤:
 * admin/editor 全量,普通用户只看自己有权产线对应的绑定。
 */
import { getQuery } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { getAgentNodeBindingRepo } from '@/server/services/workshop/agents/node-bindings.repo'
import { requireBindingAccess, lineIdOfBinding } from '@/server/services/workshop/agents/binding-authz'
import { visibleLineIds } from '@/server/services/workshop/permissions'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const q = getQuery(event)
  const agentId = typeof q.agentId === 'string' ? q.agentId : ''
  if (agentId) {
    // 指定 agent:逐条校验(顺带暴露悬空绑定,便于前端提示)
    const rows = getAgentNodeBindingRepo().byAgent(agentId)
    const visible = rows.filter((b) => {
      try {
        requireBindingAccess(user, b)
        return true
      }
      catch {
        return false
      }
    })
    return { bindings: visible, filtered: visible.length !== rows.length }
  }
  const visible = visibleLineIds(user)
  if (!visible) return { bindings: getAgentNodeBindingRepo().all() }
  // 普通用户:只返回自己授权产线所属的绑定(节点→产线经控制器解析)
  const rows = getAgentNodeBindingRepo().all().filter((b) => {
    const lineId = lineIdOfBinding(b)
    return lineId != null && visible.has(lineId)
  })
  return { bindings: rows }
})
