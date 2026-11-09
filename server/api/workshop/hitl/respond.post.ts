/**
 * POST /api/workshop/hitl/respond —— 统一 HITL 应答路由(WebUI/TUI 共用)。
 *
 * body: { kind, id, value?, answers?, confirmed?, cancelled?, response?, comment?, choice? }
 *  - omp-dialog          → respondTerminalUi(pid, …):extension_ui_response 直写 omp stdin
 *  - dcw-approval        → toolApprovals.decide(id, approved=confirmed===true, comment[, choice])
 *                          (结构化审批单先经 fail-closed 归一:无有效 choice 的批准按拒绝收敛;audit 留痕)
 *  - codex-approval      → impl.respondHitl:审批 JSON-RPC accept/decline/cancel;
 *                          提问 tool/requestUserInput → `{answers:[…]}`(与审批载荷不同)
 *  - opencode-permission → impl.respondHitl:POST permissions {once|always|reject} / question 逐题 reply|reject
 *  - dsh-permission      → impl.respondHitl:ACP session/request_permission 应答(allow/reject)
 *  - claude-permission   → impl.respondHitl:SDK canUseTool 裁决(allow/deny)
 *  - qwen-permission     → impl.respondHitl:旧版 ACP requestToolCallConfirmation 应答
 *  - hermes-permission   → impl.respondHitl:ACP 权限确认(allow/reject)
 *
 * v17(§13.2/§13.4):本端点**不再**自己做裁决 —— 全部决策统一进 hitl-decision:
 *   成员资格 + 创建时资格快照∩当前资格 → 原子抢占(pending→resolving) → 原生传导 →
 *   引擎确认后才落终态 → hitl.resolved + 定向通知 + 审计。
 * 因此"两个审批人同时提交"只有一个成功,另一个拿到 **409 ALREADY_RESOLVED**
 * (消息里带当前状态与处理人);拒绝/取消/未知结果绝不落成"已批准"。
 *
 * 幂等:待办不在登记处且无持久化行 → 409 ALREADY_RESOLVED。
 * 鉴权:用户 token + Channel 成员/审批策略(hitl-decision.assertCanDecideHitlChannel)。
 */
import { readValidatedBody } from 'h3'
import { z } from 'zod'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { zValidator } from '@/server/utils/validate'
import { decideHitlRequest } from '@/server/services/workshop/agents/hitl-decision'

const RESPONDABLE_KINDS = ['omp-dialog', 'dcw-approval', 'codex-approval', 'opencode-permission', 'dsh-permission', 'claude-permission', 'qwen-permission', 'hermes-permission'] as const

// 入参形状契约:kind 必须命中可应答枚举,id 非空;其余字段只校验类型。
// 业务裁决(pending→resolving 原子抢占、fail-closed 归一)仍全部在 hitl-decision,
// 此处**不**放宽也不收紧任何裁决语义 —— 过去这些字段是裸 readBody 透传。
const respondSchema = z.object({
  kind: z.enum(RESPONDABLE_KINDS),
  id: z.string().trim().min(1, 'id 必填'),
  value: z.string().optional(),
  answers: z.array(z.object({ id: z.union([z.string(), z.number()]).optional(), answer: z.unknown() })).optional(),
  confirmed: z.boolean().optional(),
  cancelled: z.boolean().optional(),
  response: z.string().optional(),
  comment: z.string().optional(),
  choice: z.number().int().optional(),
})

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const body = await readValidatedBody(event, zValidator(respondSchema))
  const kind = body.kind
  const id = body.id

  // 结构化答案归一(id 缺省留空,由决策服务按下标对齐问题)
  const answers = Array.isArray(body.answers)
    ? body.answers
        .filter(a => a && typeof a === 'object')
        .map(a => ({ id: a.id !== undefined ? String(a.id) : '', answer: String(a.answer ?? '') }))
    : undefined

  // 多方案裁决序号:仅接受整数(结构化审批单的「批准此方案」;其余输入一律按未携带处理,
  // 由 fail-closed 归一收敛为拒绝 —— 不做静默取整/默认包)
  const choice = Number.isInteger(body.choice) ? (body.choice as number) : undefined

  const result = await decideHitlRequest({
    kind,
    id,
    user: { id: user.id, name: user.name, role: user.role },
    decision: {
      value: typeof body.value === 'string' ? body.value : undefined,
      answers,
      confirmed: typeof body.confirmed === 'boolean' ? body.confirmed : undefined,
      cancelled: body.cancelled === true,
      response: typeof body.response === 'string' ? body.response : undefined,
      comment: typeof body.comment === 'string' ? body.comment : undefined,
      choice,
    },
  })

  // 审计在决策服务内统一落库(操作者/策略/原生请求 ID/原始决策/引擎确认结果),
  // 此处不再重复 audit,避免一次决策两条留痕。
  return {
    ok: true,
    kind,
    id,
    status: result.status,
    nativeConfirmed: result.nativeConfirmed,
    decisionId: result.decisionId,
    approval: result.approval,
  }
})
