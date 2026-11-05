/**
 * Project 工具执行面（PR8）：host-tool-bridge 的项目分支。
 *
 * 所有工具都经 ProjectService 校验 agent/channel/project 归属；
 * leader 只写 proposal，channel lead 只提交本频道成果；
 * 执行层拒绝（dispatch.ts）与本文件的服务层校验是两道独立的闸门。
 */
import type { HostToolBridgeContext, HostToolResult } from '../agents/host-tool-bridge/types'
import type { ProjectResultRow } from '../db/project.repo'
import { getProjectService } from './service'

function out(value: unknown): HostToolResult {
  return { text: JSON.stringify(value, null, 2) }
}

function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function parsePlanArg(args: Record<string, unknown>): Record<string, unknown> {
  if (typeof args.plan === 'string') {
    try {
      return asObject(JSON.parse(args.plan))
    }
    catch {
      throw new Error('plan 不是合法 JSON')
    }
  }
  if (args.plan && typeof args.plan === 'object') return asObject(args.plan)
  if (Array.isArray(args.deliverables) || Array.isArray(args.work_items) || Array.isArray(args.workItems)) return args
  throw new Error('缺少 plan（对象或 JSON 字符串）')
}

function resultView(r: ProjectResultRow | undefined): Record<string, unknown> | null {
  if (!r) return null
  return {
    id: r.id,
    status: r.status,
    title: r.title,
    workItemId: r.workItemId,
    attemptNo: r.attemptNo,
    version: r.version,
    evidenceCount: (() => {
      try {
        const parsed = JSON.parse(r.evidenceJson)
        return Array.isArray(parsed) ? parsed.length : 0
      }
      catch {
        return 0
      }
    })(),
  }
}

function errorResult(err: unknown): HostToolResult {
  const e = err as { code?: string, message?: string }
  const code = e.code ? `${e.code}: ` : ''
  return { text: `${code}${e.message ?? String(err)}`, isError: true }
}

export async function dispatchProjectTool(
  identity: HostToolBridgeContext['identity'],
  toolName: string,
  args: Record<string, unknown>,
  activeRootTaskId?: string,
): Promise<HostToolResult> {
  let svc
  try {
    svc = getProjectService()
  }
  catch (err) {
    return errorResult(err)
  }
  try {
    switch (toolName) {
      case 'project_get_status':
        return out(svc.agentProjectStatus(identity.agentId))

      case 'project_list_channels':
        return out(svc.agentListChannels(identity.agentId))

      case 'project_read_deliverables':
        return out(svc.agentReadDeliverables(identity.agentId))

      case 'project_read_results':
        return out(svc.agentReadResults(identity.agentId))

      case 'project_read_work_items':
        return out(svc.agentReadWorkItems(identity.agentId))

      case 'project_submit_result': {
        const result = svc.agentSubmitResult(identity.agentId, {
          resultId: asString(args.result_id ?? args.resultId) || undefined,
          taskId: asString(args.task_id ?? args.taskId) || activeRootTaskId || undefined,
          title: asString(args.title) || undefined,
          summary: typeof args.summary === 'string' ? args.summary : undefined,
          method: asString(args.method) || undefined,
          dataWindow: args.data_window ? asObject(args.data_window) : (args.dataWindow ? asObject(args.dataWindow) : undefined),
          sampleCount: typeof args.sample_count === 'number' ? args.sample_count : undefined,
          confidence: typeof args.confidence === 'number' ? args.confidence : undefined,
          validityScope: asString(args.validity_scope ?? args.validityScope) || undefined,
          payload: args.payload ? asObject(args.payload) : undefined,
          evidence: Array.isArray(args.evidence) ? args.evidence.map(asObject) : undefined,
          changeSummary: asString(args.change_summary ?? args.changeSummary) || undefined,
          openQuestions: asString(args.open_questions ?? args.openQuestions) || undefined,
        })
        return out({ ok: true, result: resultView(result) })
      }

      case 'project_review_result': {
        const resultId = asString(args.result_id ?? args.resultId)
        const decision = asString(args.decision) as 'reviewed' | 'rejected'
        const result = svc.agentReviewResult(identity.agentId, resultId, decision, asString(args.reason))
        return out({ ok: true, result: resultView(result) })
      }

      case 'project_propose_plan':
      case 'project_propose_replan': {
        const plan = parsePlanArg(args)
        const kind = toolName === 'project_propose_replan' ? 'replan' : 'plan'
        const { approval, version, proposalId } = svc.agentRequestPlan(identity.agentId, plan, kind)
        return out({
          ok: true,
          proposalId,
          approvalId: approval.id,
          planVersion: version,
          status: approval.status,
          next: 'owner 必须在项目审批页批准计划；批准后 ProjectService 自动物化交付物与工作项（幂等）',
        })
      }

      case 'project_propose_channel': {
        const decision = svc.agentProposeChannel(identity.agentId, {
          name: asString(args.name),
          charter: asString(args.charter),
        })
        return out({
          ok: true,
          proposalId: decision.id,
          status: decision.state,
          next: 'owner 在项目页应用提案后创建并绑定成员频道（leader 不能自建/删除频道）',
        })
      }

      case 'project_propose_dispatch': {
        const decision = svc.agentProposeDispatch(identity.agentId, {
          deliverableId: asString(args.deliverable_id ?? args.deliverableId),
          channelId: asString(args.channel_id ?? args.channelId),
          title: asString(args.title),
          brief: asString(args.brief),
          dedupeKey: asString(args.dedupe_key ?? args.dedupeKey) || undefined,
          dependsOn: Array.isArray(args.depends_on ?? args.dependsOn)
            ? (args.depends_on ?? args.dependsOn) as string[]
            : undefined,
          execBudgetMinutes: typeof args.exec_budget_minutes === 'number' ? args.exec_budget_minutes : undefined,
          dispatch: args.dispatch === true,
        })
        return out({
          ok: true,
          proposalId: decision.id,
          status: decision.state,
          next: 'owner 在项目页应用提案后生成工作项（dispatch=true 时一并派发）',
        })
      }

      case 'project_request_approval': {
        const kind = asString(args.kind)
        if (kind === 'project_complete') {
          const approval = svc.agentRequestProjectComplete(identity.agentId)
          return out({ ok: true, approvalId: approval.id, kind: approval.kind, status: approval.status })
        }
        if (kind === 'deliverable_acceptance') {
          const resultId = asString(args.result_id ?? args.resultId)
          const approval = svc.agentRequestAcceptance(identity.agentId, resultId)
          return out({ ok: true, approvalId: approval.id, kind: approval.kind, status: approval.status })
        }
        return { text: 'BAD_REQUEST: kind 必须是 project_complete 或 deliverable_acceptance', isError: true }
      }

      case 'project_submit_technical_review': {
        const resultId = asString(args.result_id ?? args.resultId)
        const verdict = asString(args.verdict) as 'pass' | 'fail'
        const { review, result } = svc.agentSubmitTechnicalReview(identity.agentId, {
          resultId,
          verdict,
          checks: Array.isArray(args.checks) ? args.checks.map(asObject) : undefined,
          note: asString(args.note ?? args.reason) || undefined,
        })
        return out({
          ok: true,
          reviewId: review.id,
          verdict: review.verdict,
          result: resultView(result),
          next: verdict === 'pass' ? '技术验收通过（L1）；下游可放行，业务签核仍需 owner/approver' : '技术验收未通过；生产 Channel 需返工后重新提交',
        })
      }

      case 'project_propose_route': {
        const result = await svc.agentProposeRoute(identity.agentId, {
          workItemId: asString(args.work_item_id ?? args.workItemId),
          action: asString(args.action) as 'dispatch' | 'defer' | 'retry' | 'rework' | 'escalate',
          reason: asString(args.reason) || undefined,
          deferMinutes: typeof args.defer_minutes === 'number' ? args.defer_minutes : (typeof args.deferMinutes === 'number' ? args.deferMinutes : undefined),
          targetChannelId: asString(args.target_channel_id ?? args.targetChannelId) || undefined,
        })
        return out({
          ok: true,
          proposalId: result.decision.id,
          applied: result.applied,
          status: result.decision.state,
          workItem: result.workItem ? { id: result.workItem.id, state: result.workItem.state, channelId: result.workItem.channelId } : null,
          next: result.applied ? 'route 已由确定性执行器应用' : '等待 owner 在项目页应用（或项目切 auto + routeGate=leader 自动应用）',
        })
      }

      case 'project_send_message':
      case 'project_escalate': {
        const message = await svc.agentSendProjectMessage(identity.agentId, {
          toChannelId: asString(args.to_channel_id ?? args.toChannelId) || undefined,
          toLeader: toolName === 'project_escalate' || args.to_leader === true || args.toLeader === true,
          body: asString(args.body) || asString(args.message),
          kind: toolName === 'project_escalate' ? 'escalate' : ((asString(args.kind) as 'note' | 'escalate' | 'reply' | 'request_review') || 'note'),
          requireReply: args.require_reply === true || args.requireReply === true,
          workItemId: asString(args.work_item_id ?? args.workItemId) || undefined,
          resultId: asString(args.result_id ?? args.resultId) || undefined,
          correlationId: asString(args.correlation_id ?? args.correlationId) || undefined,
        })
        return out({ ok: true, messageId: message.id, status: message.status, toChannelId: message.toChannelId, toAgentId: message.toAgentId })
      }

      case 'project_read_messages':
        return out(svc.agentListProjectMessages(
          identity.agentId,
          typeof args.limit === 'number' ? args.limit : undefined,
        ))

      case 'project_request_write_intent': {
        const tool = asString(args.tool)
        const callArgs = asObject(args.args)
        const { approval, digest } = svc.agentRequestWriteIntent(identity.agentId, {
          tool,
          args: callArgs,
          reason: asString(args.reason) || undefined,
          taskId: asString(args.task_id ?? args.taskId) || activeRootTaskId || undefined,
        })
        return out({
          ok: true,
          approvalId: approval.id,
          digest,
          tool,
          status: approval.status,
          next: 'owner 批准后，执行器只放行 tool/args digest/attempt 完全一致的这一次调用（一次性）',
        })
      }

      default:
        return { text: `未知项目工具: ${toolName}`, isError: true }
    }
  }
  catch (err) {
    return errorResult(err)
  }
}
