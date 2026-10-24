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
