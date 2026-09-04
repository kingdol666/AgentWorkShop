/**
 * POST /api/workshop/hitl/respond —— 统一 HITL 应答路由(WebUI/TUI 共用)。
 *
 * body: { kind, id, value?, confirmed?, cancelled?, response?, comment? }
 *  - omp-dialog          → respondTerminalUi(pid, …):extension_ui_response 直写 omp stdin
 *  - dcw-approval        → toolApprovals.decide(id, approved=confirmed===true, comment)(audit 留痕)
 *  - codex-approval      → impl.respondHitl:JSON-RPC 应答回 app-server(accept/decline)
 *  - opencode-permission → impl.respondHitl:POST permissions {once|always|reject} / question 回答
 *  - dsh-permission      → impl.respondHitl:ACP session/request_permission 应答(allow/reject)
 *
 * 幂等:待办不在登记处(已被他端处理/超时/撤销)→ 409 ALREADY_RESOLVED。
 * 鉴权:用户 token + channel 所有权(与 pending.get 同口径)。
 */
import { readBody } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { AppError } from '@/server/utils/errors'
import { getWorkshopManager } from '@/server/plugins/workshop'
import { getHitlRegistry } from '@/server/services/workshop/agents/hitl-registry'
import { getToolApprovals } from '@/server/services/workshop/agents/tool-approvals'
import { respondTerminalUi } from '@/server/services/workshop/agents/harness-terminal'
import { audit } from '@/server/services/workshop/ops/ops'

const RESPONDABLE_KINDS = ['omp-dialog', 'dcw-approval', 'codex-approval', 'opencode-permission', 'dsh-permission'] as const

interface RespondBody {
  kind?: string
  id?: string
  value?: string
  confirmed?: boolean
  cancelled?: boolean
  /** 引擎原生选项(opencode permission:once|always|reject) */
  response?: string
  comment?: string
}

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const body = await readBody<RespondBody>(event) ?? {}
  const kind = body.kind
  const id = String(body.id ?? '')
  if (!kind || !(RESPONDABLE_KINDS as readonly string[]).includes(kind) || !id) {
    throw new AppError(400, 'BAD_REQUEST', `body 需要 { kind: ${RESPONDABLE_KINDS.join('|')}, id, value?/confirmed?/cancelled?/response?/comment? }`)
  }

  // 所有权校验:待办必须属于请求者可见的 channel
  const item = getHitlRegistry().find(kind as typeof RESPONDABLE_KINDS[number], id)
  if (!item) throw new AppError(409, 'ALREADY_RESOLVED', `待办已处理或不存在: ${id}`)
  const manager = getWorkshopManager()
  manager.getChannelForUser(item.channelId, user.id)

  if (kind === 'omp-dialog') {
    if (!item.pid) throw new AppError(410, 'SESSION_GONE', '对话框缺少 pid(进程已退出?)')
    try {
      respondTerminalUi(item.pid, {
        id,
        value: typeof body.value === 'string' ? body.value : undefined,
        confirmed: typeof body.confirmed === 'boolean' ? body.confirmed : undefined,
        cancelled: body.cancelled === true,
      })
    }
    catch (err) {
      throw new AppError(410, 'SESSION_GONE', `omp 会话不可用: ${err instanceof Error ? err.message : String(err)}`)
    }
    audit({ actor: user.id, actorName: user.name, actorKind: 'user', action: 'hitl.respond', targetKind: 'omp-dialog', targetId: id, detail: { channelId: item.channelId, agentId: item.agentId, cancelled: body.cancelled === true } })
    return { ok: true, kind, id }
  }

  if (kind === 'dcw-approval') {
    // dcw-approval:approved = confirmed === true(缺省视为拒绝,与 decide 端点同语义)
    const approved = body.confirmed === true
    const approval = getToolApprovals().decide(id, approved, String(body.comment ?? ''), user.id, user.name)
    audit({ actor: user.id, actorName: user.name, actorKind: 'user', action: approved ? 'approval.approve' : 'approval.reject', targetKind: 'tool-approval', targetId: id, detail: { comment: String(body.comment ?? ''), via: 'hitl.respond' } })
    return { ok: true, kind, id, approval }
  }

  // 引擎审批(codex/opencode/dsh):传导到 impl.respondHitl(引擎协议应答)
  await manager.respondHarnessHitl(item.agentId, kind, id, {
    confirmed: typeof body.confirmed === 'boolean' ? body.confirmed : undefined,
    cancelled: body.cancelled === true,
    value: typeof body.value === 'string' ? body.value : undefined,
    response: typeof body.response === 'string' ? body.response : undefined,
    comment: typeof body.comment === 'string' ? body.comment : undefined,
  })
  audit({ actor: user.id, actorName: user.name, actorKind: 'user', action: body.cancelled === true || body.confirmed === false ? 'hitl.respond' : 'hitl.respond', targetKind: kind, targetId: id, detail: { channelId: item.channelId, agentId: item.agentId, cancelled: body.cancelled === true, confirmed: body.confirmed === true, response: body.response } })
  return { ok: true, kind, id }
})
