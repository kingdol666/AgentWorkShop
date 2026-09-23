/**
 * POST /api/workshop/hitl/respond —— 统一 HITL 应答路由(WebUI/TUI 共用)。
 *
 * body: { kind, id, value?, answers?, confirmed?, cancelled?, response?, comment? }
 *  - omp-dialog          → respondTerminalUi(pid, …):extension_ui_response 直写 omp stdin
 *  - dcw-approval        → toolApprovals.decide(id, approved=confirmed===true, comment)(audit 留痕)
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
import { readBody } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { AppError } from '@/server/utils/errors'
import { decideHitlRequest } from '@/server/services/workshop/agents/hitl-decision'

const RESPONDABLE_KINDS = ['omp-dialog', 'dcw-approval', 'codex-approval', 'opencode-permission', 'dsh-permission', 'claude-permission', 'qwen-permission', 'hermes-permission'] as const

interface RespondBody {
  kind?: string
  id?: string
  value?: string
  /** 结构化多问题答案(question 型;id 缺省按下标对齐) */
  answers?: Array<{ id?: string, answer: string }>
  confirmed?: boolean
  cancelled?: boolean
  /** 引擎原生选项(opencode permission:once|always|reject;未知枚举一律 400) */
  response?: string
  comment?: string
}

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const body = await readBody<RespondBody>(event) ?? {}
  const kind = body.kind
  const id = String(body.id ?? '')
  if (!kind || !(RESPONDABLE_KINDS as readonly string[]).includes(kind) || !id) {
    throw new AppError(400, 'BAD_REQUEST', `body 需要 { kind: ${RESPONDABLE_KINDS.join('|')}, id, value?/answers?/confirmed?/cancelled?/response?/comment? }`)
  }

  // 结构化答案归一(id 缺省留空,由决策服务按下标对齐问题)
  const answers = Array.isArray(body.answers)
    ? body.answers
        .filter(a => a && typeof a === 'object')
        .map(a => ({ id: a.id !== undefined ? String(a.id) : '', answer: String(a.answer ?? '') }))
    : undefined

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
