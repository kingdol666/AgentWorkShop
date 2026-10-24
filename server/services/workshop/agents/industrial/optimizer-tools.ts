/**
 * Optimizer Agent 工具(G4.3):
 *   optimizer_capabilities / optimizer_solve / optimizer_status / optimizer_cancel / optimizer_plan_get
 *
 * 零写设备:本工具族只计算并产出"建议",不获得任何写权限;逐次调用由 dispatch 门控 +
 * tool-verify(binding 类别)+ manager 的绑定 revision/工况重校验共同兜底。
 */
import { AppError } from '../../../../utils/errors'
import { getAmlRuntime } from '../../aml/runtime'
import { venvIdentity } from '../../aml/python-runtime'
import type { HostToolResult } from '../host-tool-bridge/types'
import { listBindingsForAgent } from '../../optimization/binding.service'
import { getProfileRepo } from '../../optimization/profile.repo'
import { getRunRepo } from '../../optimization/run.repo'
import { getSolverWorkerPool } from '../../optimization/worker-client'
import { getEligibilityRepo } from '../../process-model/eligibility'
import { getProcessModelSpecRepo } from '../../process-model/spec.repo'
import { cancel, getRunStatus, solve } from '../../optimization/manager'
import { assertRecommendationUsable } from '../../optimization/recommendation.service'
import { proposeProfileAdoption } from '../../optimization/profile-adopt.service'
import { deriveDualState } from '../../optimization/crosscheck.service'

function ok(payload: unknown): HostToolResult {
  return { text: JSON.stringify(payload, null, 2) }
}

function fail(err: unknown): HostToolResult {
  if (err instanceof AppError) return { text: `${err.code}: ${err.message}`, isError: true }
  return { text: `工具执行异常:${err instanceof Error ? err.message : String(err)}`, isError: true }
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** 能力面:绑定清单 + 求解器池状态 + 环境身份(不含任何 secrets)。 */
export async function toolOptimizerCapabilities(agentId: string): Promise<HostToolResult> {
  try {
    const bindings = listBindingsForAgent(agentId).map((binding) => {
      const profile = getProfileRepo().get(binding.profileId, binding.profileVersionNumber)
      const spec = profile?.processSpecRef ? getProcessModelSpecRepo().get(...splitRef(profile.processSpecRef)) : undefined
      const eligibility = spec ? getEligibilityRepo().latest(spec.id) : null
      return {
        bindingId: binding.id,
        profile: binding.profileVersion,
        mode: binding.mode,
        capabilities: binding.capabilities,
        profileStatus: profile?.status ?? 'missing',
        conditions: profile ? JSON.parse(profile.conditionIdsJson || '[]') as string[] : [],
        optimizationEligible: eligibility?.optimizationEligible ?? false,
        eligibilityGaps: eligibility?.gaps.map(g => `${g.code}:${g.message}`) ?? ['无资格报告'],
      }
    })
    const rt = getAmlRuntime()
    const identity = venvIdentity(rt)
    return ok({
      agentId,
      bindings,
      solver: getSolverWorkerPool().stats(),
      environment: {
        pythonPath: identity.pythonPath,
        requirementsHash: identity.requirementsHash,
        ready: identity.ready,
        platform: identity.platform,
      },
      note: '优化器仅产出建议(recommendation),不授予设备写权限;未验证建议不得当作已验收结论。',
    })
  }
  catch (err) {
    return fail(err)
  }
}

export async function toolOptimizerSolve(agentId: string, args: Record<string, unknown>): Promise<HostToolResult> {
  try {
    const outcome = await solve(agentId, {
      bindingId: str(args.binding_id ?? args.bindingId),
      timeoutMs: num(args.timeout_ms ?? args.timeoutMs),
    })
    return ok({
      runId: outcome.runId,
      bindingId: outcome.bindingId,
      profileVersion: outcome.profileVersion,
      status: outcome.result.status,
      firstMove: outcome.result.firstMove,
      cost: outcome.result.independentCost,
      candidates: outcome.result.candidates.length,
      constraints: outcome.result.candidates[0]?.constraints ?? [],
      recommendation: outcome.recommendation
        ? {
            id: outcome.recommendation.id,
            status: outcome.recommendation.status,
            statusLabel: outcome.recommendation.statusLabel,
            evidenceSource: outcome.recommendation.evidenceSource,
            validUntil: outcome.recommendation.validUntil,
          }
        : null,
      diagnostics: outcome.result.diagnostics,
      context: outcome.context,
    })
  }
  catch (err) {
    return fail(err)
  }
}

export async function toolOptimizerStatus(agentId: string, args: Record<string, unknown>): Promise<HostToolResult> {
  try {
    const runId = str(args.run_id ?? args.runId)
    if (!runId) throw new AppError(422, 'RUN_ID_REQUIRED', 'run_id 必填')
    const status = getRunStatus(agentId, runId)
    return ok({
      run: status.run,
      recommendation: status.recommendation,
      candidates: status.candidates,
    })
  }
  catch (err) {
    return fail(err)
  }
}

export async function toolOptimizerCancel(agentId: string, args: Record<string, unknown>): Promise<HostToolResult> {
  try {
    const runId = str(args.run_id ?? args.runId)
    if (!runId) throw new AppError(422, 'RUN_ID_REQUIRED', 'run_id 必填')
    return ok(await cancel(agentId, runId))
  }
  catch (err) {
    return fail(err)
  }
}

export async function toolOptimizerPlanGet(agentId: string, args: Record<string, unknown>): Promise<HostToolResult> {
  try {
    const runId = str(args.run_id ?? args.runId)
    const recommendationId = str(args.recommendation_id ?? args.recommendationId)
    if (!runId && !recommendationId) throw new AppError(422, 'PLAN_REF_REQUIRED', 'run_id 或 recommendation_id 至少一个必填')
    let recommendation = recommendationId ? getRunRepo().getRecommendation(recommendationId) ?? null : null
    if (recommendationId && !recommendation) throw new AppError(404, 'PLAN_NOT_FOUND', '找不到对应的建议')
    const resolvedRunId = runId ?? recommendation?.runId
    if (!resolvedRunId) throw new AppError(404, 'PLAN_NOT_FOUND', '找不到对应的运行/建议')
    const status = getRunStatus(agentId, recommendation?.runId ?? resolvedRunId)
    if (recommendation && recommendation.runId !== resolvedRunId) {
      throw new AppError(422, 'PLAN_REF_MISMATCH', '建议不属于指定运行')
    }
    recommendation = recommendation ? assertRecommendationUsable(recommendation) : status.recommendation ? assertRecommendationUsable(status.recommendation) : null
    const candidateId = recommendation?.candidateId
    const candidate = candidateId ? getRunRepo().getCandidate(candidateId) : undefined
    if (candidate && candidate.runId !== resolvedRunId) {
      throw new AppError(422, 'PLAN_REF_MISMATCH', '建议候选不属于指定运行')
    }
    return ok({
      runId: resolvedRunId,
      recommendation,
      // D6 计算态:互校一致由最新 crosscheck 行派生;label 仅展示层,不改建议 status
      crosscheck: recommendation ? deriveDualState(recommendation.id) : undefined,
      candidate: candidate
        ? {
            id: candidate.id,
            seq: candidate.seq,
            controls: candidate.controls,
            predicted: candidate.predicted,
            cost: candidate.cost,
            verified: candidate.verified === 1,
            constraints: candidate.constraints,
          }
        : null,
      note: '建议不等于执行授权;审批/写入走既有 DCW 治理链。',
    })
  }
  catch (err) {
    return fail(err)
  }
}

function splitRef(ref: string): [string, number | undefined] {
  const [id, version] = ref.split('@')
  return [id ?? ref, version ? Number(version) : undefined]
}

/** 只读探测:该 agent 是否至少有一个可用绑定(per-agent 工具注入用)。 */
export function hasOptimizerBinding(agentId: string): boolean {
  try {
    return listBindingsForAgent(agentId).length > 0
  }
  catch {
    return false
  }
}

/**
 * 模型采纳提议(OW-adopt):把 AML 新训练登记的模型采纳为指定 Profile 的新版本。
 *
 * AI-first 闭环的"采纳"环节:复制当前已发布 Profile 的全部求解配置 → 换新模型工件 →
 * 草稿新版本 → 挂 HITL 卡等待人类裁决。批准(单一咽喉)= 冻结发布 + 自动重绑所有
 * 绑定在旧版本的 Agent(revision+1,在飞求解 BINDING_STALE 收敛);拒绝/超时 = 零写。
 *
 * 治理:工具属写族(grant-guard operate);Agent 必须已绑定该 Profile(防越权提议);
 * 兼容性(D21 矩阵)在服务层提议时校验;发布仅发生在人类批准后。
 */
export async function toolOptimizerProfilePropose(agentId: string, args: Record<string, unknown>): Promise<HostToolResult> {
  try {
    const bindings = listBindingsForAgent(agentId)
    if (bindings.length === 0) {
      return { text: '本 Agent 没有优化器绑定;模型采纳必须由已绑定该 Profile 的 Agent 发起(先在 Channel 设置里绑定)。', isError: true }
    }
    const modelId = String(args.model_id ?? '').trim()
    if (!modelId) return { text: 'model_id 必填(aml_job_submit 训练完成登记的模型 id;aml_leaderboard/aml_model_find 可查)。', isError: true }
    const profileId = String(args.profile_id ?? '').trim() || (() => {
      const bound = bindings.map(b => b.profileId)
      return new Set(bound).size === 1 ? bound[0]! : ''
    })()
    if (!profileId) {
      return { text: `本 Agent 绑定了多个 Profile(${bindings.map(b => b.profileId).join(', ')});必须显式传 profile_id。`, isError: true }
    }
    if (!bindings.some(b => b.profileId === profileId)) {
      return { text: `Profile ${profileId} 不在本 Agent 的绑定面内,不能代为提议采纳(越权拒绝)。`, isError: true }
    }
    const reason = String(args.reason ?? '').trim()
    if (!reason) return { text: 'reason 必填:为什么采纳新模型(证据:训练指标对比/互校结论/业务动因)。', isError: true }

    const result = await proposeProfileAdoption({
      agentInstanceId: agentId,
      initiatorId: agentId,
      initiatorKind: 'agent',
      profileId,
      modelId,
      templateRef: args.template_ref as Parameters<typeof proposeProfileAdoption>[0]['templateRef'],
      solverRef: args.solver_ref as Parameters<typeof proposeProfileAdoption>[0]['solverRef'],
      reason,
    })

    if (!result.decision.approved) {
      return {
        text: [
          `采纳提议未被批准(卡 ${result.cardId}):`,
          `${result.profileId} v${result.priorVersion} → v${result.version}(模型 ${result.modelId})`,
          `裁决:${result.decision.comment || '拒绝/超时'}`,
          '草稿已保留(零写);可修订理由后重新提议,或由管理员经 REST 发布。',
        ].join('\n'),
        isError: true,
      }
    }
    if (!result.published) {
      return {
        text: [
          `⚠️ 采纳提议获批准,但发布未由裁决咽喉完成(卡 ${result.cardId}):`,
          `${result.profileId} v${result.priorVersion} → v${result.version} 仍为草稿;请管理员经 REST/管理面发布,或重新发起采纳。`,
        ].join('\n'),
        isError: true,
      }
    }
    return {
      text: [
        '✅ 模型采纳完成(HITL 批准):',
        `${result.profileId} v${result.priorVersion} → v${result.version}(published)`,
        `模型:${result.modelId};重绑绑定 ${result.rebindCount} 个(revision+1,在飞求解 BINDING_STALE 收敛)`,
        `裁决意见:${result.decision.comment || '(无)'}`,
        '下一次 optimizer_solve 即使用新模型;旧版本保留可回退(retire/rebind 走管理面)。',
      ].join('\n'),
    }
  }
  catch (err) {
    const message = err instanceof AppError ? `${err.code}: ${err.message}` : String(err)
    return { text: `模型采纳提议失败:${message}`, isError: true }
  }
}
