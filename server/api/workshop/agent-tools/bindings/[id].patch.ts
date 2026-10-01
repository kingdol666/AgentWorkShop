/**
 * PATCH /api/workshop/agent-tools/bindings/:id —— 切换控制模式(auto/manual)/设置调试元数据。
 * body: { mode?, confirm?, tuning?: { min?, max?, step?, note? } }
 * tuning = 绑定级调试元数据(工况提示词与探索步长来源,优先于节点自带元数据)。
 *
 * 鉴权(与 index.post.ts 同口径):manual→auto 等于**摘掉人类审批闸门**,
 * 所以必须先证明调用者可支配该绑定所属产线的节点,否则任意登录用户都能
 * 关掉别人的 HITL。早先此处只有 resolveUser。
 *
 * auto 治理(产线 Co-Pilot P2,计划 §5.4 铁律 2):
 *  - body 无 mode 字段 → **不变更 mode**(消掉旧实现 `?? 'auto'` 的静默缺省:
 *    空 body 曾会一言不发地把绑定切到 auto);
 *  - manual→auto 必须携带显式 `confirm: true`(严格全等),缺失返回 400
 *    MODE_CONFIRM_REQUIRED(前端可凭该 code 识别"缺确认");auto→manual 与
 *    同名 mode 免 confirm;
 *  - 判定逻辑抽在 server/services/workshop/agents/binding-mode.ts(纯函数,可单测)。
 */
import { createError, getRouterParam, readBody } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { AppError } from '@/server/utils/errors'
import { getAgentNodeBindingRepo, type AgentNodeBindingTuning } from '@/server/services/workshop/agents/node-bindings.repo'
import { requireBindingAccess } from '@/server/services/workshop/agents/binding-authz'
import { resolveModeChange } from '@/server/services/workshop/agents/binding-mode'
import { recordOps } from '@/server/services/workshop/ops/ops'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const id = getRouterParam(event, 'id')!
  const body = await readBody<{ mode?: 'auto' | 'manual', confirm?: unknown, tuning?: AgentNodeBindingTuning }>(event) ?? {}
  const repo = getAgentNodeBindingRepo()
  const binding = repo.all().find(b => b.id === id)
  if (!binding) throw createError({ statusCode: 404, statusMessage: 'binding not found' })
  requireBindingAccess(user, binding)
  if (body.tuning !== undefined) {
    return { binding: repo.setTuning(id, body.tuning) }
  }
  // 模式切换判定:无 mode 字段/同名 → 不变更;manual→auto 无显式 confirm → 400
  const decision = resolveModeChange(binding.mode, body.mode, body.confirm)
  if (!decision.ok) {
    throw new AppError(400, 'MODE_CONFIRM_REQUIRED', decision.error ?? '切换到 auto 需要风险确认')
  }
  if (decision.noop) {
    return { binding }
  }
  const fromMode = binding.mode
  const updated = repo.setMode(id, body.mode!)
  // 模式切换留痕(产线 Co-Pilot P1:绑定 mode 切换此前无审计盲区)
  recordOps({
    actor: user.id,
    actorName: user.name,
    actorKind: 'user',
    action: 'binding.mode',
    kind: 'system',
    summary: `节点绑定控制模式切换 ${fromMode}→${updated.mode}`,
    targetKind: 'agent_node_binding',
    targetId: id,
    detail: { nodeId: binding.nodeId, bindingKind: binding.kind, agentId: binding.agentId, fromMode, toMode: updated.mode },
  })
  return { binding: updated }
})
