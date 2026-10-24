/* eslint-disable @stylistic/max-statements-per-line */
/**
 * Optimizer Manager(G3 编排):resolve → build → solve → verify → persist → recommend。
 *
 * 边界:
 *  - Worker 不读生产数据库、不持设备凭据;只接受已注册模型的 ProblemIR;
 *  - Solver 成功仍独立复算约束与有效域(A4);代价以同一 ProblemIR 重算;
 *  - 首版只产生建议(recommendation),不打开设备写权限。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { AppError } from '../../../utils/errors'
import { getAmlRuntime } from '../aml/runtime'
import { getProcessModelSpecRepo } from '../process-model/spec.repo'
import { parseProcessModelSpec } from '../process-model/spec'
import { assertArxArtifactCurrent } from '../process-model/artifact-validation'
import { getRuntimeContext, type ContextSnapshot } from '../process-model/context'
import { getEligibilityRepo } from '../process-model/eligibility'
import { getDcwLineRepo } from '../dcw/dcw-line.repo'
import type { ProcessModelSpec } from '../process-model/contracts'
import { buildProblemIR, constraintReport, evaluateCandidateCost, type LinearStateSpaceLike, type ModelArtifact, type StaticResponseLike } from './problem-builder'
import type { Recommendation, SolveCandidate, SolveResult, SolveStatus } from './contracts'
import { getProfileRepo, parseProfileRow } from './profile.repo'
import { resolveBinding, type ResolvedBinding } from './binding.service'
import { getRunRepo } from './run.repo'
import { getSolverWorkerPool } from './worker-client'
import { assertRecommendationUsable, createRecommendation } from './recommendation.service'
import { inputDistance, isUqFresh, type ArtifactUq, type RecommendationUqEvidence } from './uq-evidence'
import { deriveDualState } from './crosscheck.service'
import { isRuntimeConditionChanged } from '../process-model/conditions'

export interface SolveRequest {
  bindingId?: string
  /** 请求级超时(默认取配置) */
  timeoutMs?: number
}

export interface SolveOutcome {
  runId: string
  bindingId: string
  profileVersion: string
  result: SolveResult
  recommendation: Recommendation | null
  context: Pick<ContextSnapshot, 'capturedAt' | 'eventAsOf' | 'availabilityWatermark' | 'conditionId'>
}

interface WorkerSolvePayload {
  status: SolveStatus
  controls?: number[][]
  predicted?: number[][]
  cost?: number
  iterations?: number
  backend?: string
  solverVersion?: string
  message?: string
}

function db() { return getAmlRuntime().db }

function loadSpec(ref: string): ProcessModelSpec {
  const [id, versionText] = ref.split('@')
  if (!id) throw new AppError(422, 'PROFILE_SPEC_MISSING', 'Profile 未引用 ProcessModelSpec(processSpecRef 为空)')
  const row = getProcessModelSpecRepo().get(id, versionText ? Number(versionText) : undefined)
  if (!row) throw new AppError(404, 'SPEC_NOT_FOUND', `ProcessModelSpec ${ref} 不存在`)
  return parseProcessModelSpec(JSON.parse(row.specJson))
}

function loadArtifact(modelId: string, expectedHash: string): { artifact: ModelArtifact, artifactHash: string } {
  const row = db().prepare('SELECT path, artifact_kind AS kind, artifact_hash AS hash, artifacts_pruned AS pruned, stage, dataset_id AS datasetId FROM aml_models WHERE id = ?').get(modelId) as { path: string, kind: string, hash: string, pruned: number, stage: string, datasetId?: string | null } | undefined
  if (!row) throw new AppError(404, 'MODEL_NOT_FOUND', `模型 ${modelId} 不存在`)
  if (row.pruned) throw new AppError(410, 'MODEL_ARTIFACT_PRUNED', `模型 ${modelId} 工件已被保留策略清理;重新训练后再求解`)
  // D18 谱系门:训练数据 lineage_verified=0(旧/未核验/无 confirmed segment)→ 禁止数值求解。
  // Twin/shadow 不受限;重新走 builder 建 confirmed segment 数据集并重训即可解除。
  if (row.datasetId) {
    const lineage = db().prepare('SELECT lineage_verified AS v FROM aml_datasets WHERE id = ?').get(row.datasetId) as { v: number } | undefined
    if (lineage && lineage.v !== 1) {
      throw new AppError(422, 'LEGACY_MODEL_REQUIRES_RETRAIN',
        `模型 ${modelId} 的训练数据集 ${row.datasetId} 谱系未核验(lineage_verified=0);请基于已确认工况段重建数据集并重训`)
    }
  }
  const kind = row.kind || ''
  if (kind !== 'linear_state_space@1' && kind !== 'static_response@1') {
    throw new AppError(422, 'UNSUPPORTED_ARTIFACT', `模型 ${modelId} 工件类型 ${kind || 'legacy'} 不能用于数值求解(需要 linear_state_space@1 / static_response@1)`)
  }
  const path = join(row.path, 'model.json')
  if (!existsSync(path)) throw new AppError(410, 'MODEL_ARTIFACT_MISSING', `模型工件 ${path} 缺失`)
  const artifact = JSON.parse(readFileSync(path, 'utf8')) as ModelArtifact
  if (artifact.kind !== kind) throw new AppError(409, 'MODEL_ARTIFACT_MISMATCH', `工件 kind=${artifact.kind} 与注册类型 ${kind} 不一致`)
  assertArxArtifactCurrent(artifact, modelId)
  if (expectedHash && row.hash && expectedHash !== row.hash) {
    throw new AppError(409, 'BINDING_STALE', `Profile 冻结的工件 hash 与当前模型不一致(模型已替换);请重新发布 Profile`)
  }
  return { artifact, artifactHash: row.hash }
}

export async function solve(agentId: string, req: SolveRequest = {}): Promise<SolveOutcome> {
  const resolved: ResolvedBinding = resolveBinding(agentId, req.bindingId)
  try {
    const profileRow = getProfileRepo().get(resolved.profileId, resolved.profileVersion)
    if (!profileRow) throw new AppError(404, 'PROFILE_NOT_FOUND', `Profile ${resolved.profileId}@${resolved.profileVersion} 不存在`)
    if (profileRow.status === 'retired') throw new AppError(409, 'PROFILE_RETIRED', `Profile ${profileRow.id}@${profileRow.version} 已退役`)
    const profile = parseProfileRow(profileRow)
    const spec = loadSpec(profile.processSpecRef)
    const { artifact, artifactHash } = loadArtifact(profile.modelRef.modelId, profile.modelRef.artifactHash)

    // 资格:必须存在通过的 optimizationEligible(A2/A3)。
    // D20 精确谱系:资格按"模型的训练数据集"查询;模型无数据集谱系(已被 D18 门拦截,双保险)才回退 latest。
    // 作用域必须与产线性质一致:模拟资格不能授权真实线,反之亦然。
    const modelDatasetId = (db().prepare('SELECT dataset_id AS d FROM aml_models WHERE id = ?').get(profile.modelRef.modelId) as { d?: string | null } | undefined)?.d ?? ''
    const eligibility = modelDatasetId
      ? (getEligibilityRepo().latestForDataset(spec.id, modelDatasetId) ?? getEligibilityRepo().latest(spec.id))
      : getEligibilityRepo().latest(spec.id)
    const line = getDcwLineRepo().byId(spec.lineId)
    if (!line) throw new AppError(404, 'LINE_NOT_FOUND', `产线 ${spec.lineId} 不存在`)
    if (eligibility?.scope === 'simulation' && line.simulated !== true) {
      throw new AppError(422, 'ELIGIBILITY_SCOPE_MISMATCH', '该资格报告来自模拟作用域,不能用于真实产线求解')
    }
    if (line.simulated !== true && eligibility && eligibility.scope !== 'real') {
      throw new AppError(422, 'ELIGIBILITY_SCOPE_MISMATCH', '真实产线求解需要 real 作用域资格报告')
    }
    if (line.simulated === true && eligibility && eligibility.scope !== 'simulation') {
      throw new AppError(422, 'ELIGIBILITY_SCOPE_MISMATCH', '模拟产线求解只接受 simulation 作用域资格报告')
    }
    if (!eligibility || !eligibility.optimizationEligible) {
      const gaps = eligibility?.gaps.map(g => `${g.code}:${g.message}`).join('; ') ?? '尚无资格报告'
      throw new AppError(422, 'OPTIMIZATION_NOT_ELIGIBLE', `不具备优化资格:${gaps}`)
    }
    if (profile.conditionIds.length && eligibility && !profile.conditionIds.includes(eligibility.conditionId)) {
      throw new AppError(422, 'CONDITION_NOT_ALLOWED', `Profile 不允许工况 ${eligibility.conditionId}`)
    }

    const context = await getRuntimeContext(spec)
    context.evidenceSource = eligibility?.scope ?? 'unassessed'
    if (await isRuntimeConditionChanged(spec, context)) {
      getRunRepo().expireWhere({ bindingId: resolved.binding.id })
      throw new AppError(409, 'CONDITION_CHANGED', '运行工况/配方版本已变化;旧 Profile 计划失效,请重新装配')
    }
    const ir = buildProblemIR({ profile, spec, artifact: artifact as LinearStateSpaceLike | StaticResponseLike, context, runId: '' })
    if (profile.problemIrHash && profile.problemIrHash !== ir.hash) {
      throw new AppError(409, 'PROBLEM_IR_CHANGED', `问题结构 hash 与发布时冻结值不一致(profile=${profile.problemIrHash.slice(0, 12)}, now=${ir.hash.slice(0, 12)})`)
    }

    const runId = `orun-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
    const startedAt = new Date().toISOString()
    getRunRepo().insertRun({
      id: runId, bindingId: resolved.binding.id, bindingRevision: resolved.binding.revision,
      profileId: profile.id, profileVersion: profile.version, ir, context, startedAt,
    })

    const pool = getSolverWorkerPool()
    let payload: WorkerSolvePayload
    let elapsedMs = 0
    let workerPid: number | undefined
    try {
      // 用 runId 作 Worker 请求 ID,取消才能命中(worker-client 按 reqId 匹配)
      const solved = await pool.solve(ir, { timeoutMs: req.timeoutMs, requestId: runId })
      payload = solved.result as WorkerSolvePayload
      elapsedMs = solved.elapsedMs
      workerPid = solved.workerPid
    }
    catch (err) {
      const code = err instanceof AppError ? err.code : ''
      const message = err instanceof Error ? err.message : String(err)
      const status: SolveStatus = code === 'SOLVE_TIMEOUT' ? 'timeout' : code === 'WORKER_INTERRUPTED' ? 'numerical_error' : code === 'ENV_MISSING_DEP' ? 'unsupported' : 'numerical_error'
      const failed: SolveResult = {
        runId, status, candidates: [], firstMove: null, independentCost: null,
        diagnostics: { backend: 'worker', solverVersion: 'unknown', elapsedMs, problemIrHash: ir.hash, message, workerPid },
        createdAt: new Date().toISOString(),
      }
      getRunRepo().finishRun(runId, failed)
      return { runId, bindingId: resolved.binding.id, profileVersion: resolved.binding.profileVersion, result: failed, recommendation: null, context: pick(context) }
    }

    const candidates: SolveCandidate[] = []
    if (payload.controls && payload.predicted) {
      const candidate: SolveCandidate = {
        seq: 0,
        controls: payload.controls,
        predicted: payload.predicted,
        cost: Number(payload.cost ?? 0),
        constraints: [],
        feasible: true,
      }
      candidate.constraints = constraintReport(ir, candidate)
      candidate.feasible = candidate.constraints.every(c => c.satisfied)
      // 独立代价重算(A4):Solver 自报代价与平台重算必须一致
      candidate.cost = evaluateCandidateCost(ir, candidate)
      candidates.push(candidate)
    }
    const independentCost = candidates[0]?.cost ?? null
    const solverCost = Number(payload.cost ?? Number.NaN)
    const costMismatch = Number.isFinite(solverCost) && independentCost != null && Math.abs(solverCost - independentCost) > 1e-6 * Math.max(1, Math.abs(independentCost))
    // 取消/超时竞争:终态已由 cancel() 落定 → 丢弃迟到结果,不写候选/建议。
    const liveRun = getRunRepo().getRun(runId)
    if (!liveRun || liveRun.status !== 'running') {
      const cancelled: SolveResult = {
        runId, status: 'cancelled', candidates: [], firstMove: null, independentCost: null,
        diagnostics: { backend: 'worker', solverVersion: 'unknown', elapsedMs, problemIrHash: ir.hash, message: '运行已取消或终态已落定;迟到结果丢弃', workerPid },
        createdAt: new Date().toISOString(),
      }
      return { runId, bindingId: resolved.binding.id, profileVersion: resolved.binding.profileVersion, result: cancelled, recommendation: null, context: pick(context) }
    }
    // 绑定 revision 在求解期间被撤销/变更 → 结果失效
    const freshBinding = db().prepare('SELECT revision FROM optimizer_bindings WHERE id = ?').get(resolved.binding.id) as { revision: number } | undefined
    if (!freshBinding || freshBinding.revision !== resolved.binding.revision) {
      const stale: SolveResult = {
        runId, status: 'cancelled', candidates: [], firstMove: null, independentCost: null,
        diagnostics: { backend: 'worker', solverVersion: 'unknown', elapsedMs, problemIrHash: ir.hash, message: 'BINDING_STALE: 绑定在求解期间被撤销或 revision 变化', workerPid },
        createdAt: new Date().toISOString(),
      }
      getRunRepo().finishRun(runId, stale)
      getRunRepo().expireWhere({ bindingId: resolved.binding.id })
      return { runId, bindingId: resolved.binding.id, profileVersion: resolved.binding.profileVersion, result: stale, recommendation: null, context: pick(context) }
    }
    const firstMove = candidates[0] ? Object.fromEntries(ir.problem.mvOrder.map((id, m) => [id, candidates[0]!.controls[0]?.[m] ?? 0])) : null
    const result: SolveResult = {
      runId,
      status: costMismatch ? 'numerical_error' : payload.status,
      candidates,
      firstMove,
      independentCost,
      diagnostics: {
        backend: payload.backend ?? 'worker', solverVersion: payload.solverVersion ?? 'unknown',
        iterations: payload.iterations, elapsedMs, problemIrHash: ir.hash,
        message: costMismatch ? `代价不一致:solver=${solverCost} independent=${independentCost}` : payload.message,
        workerPid,
      },
      createdAt: new Date().toISOString(),
    }
    getRunRepo().finishRun(runId, result)

    let recommendation: Recommendation | null = null
    if (result.status === 'optimal' || result.status === 'feasible') {
      const candidateIds = getRunRepo().insertCandidates(runId, candidates, profile.modelRef.modelId)
      // D5 证据单源:唯一来源 = 工件 uq 字段(注册前已算入 artifactHash);快照含 artifactHash 锚
      const uqSnapshot = buildUqEvidence(artifact as { uq?: ArtifactUq, norm?: { u: { mean: number[], std: number[] }, y: { mean: number[], std: number[] } }, mvOrder?: string[], cvOrder?: string[] }, artifactHash, context)
      recommendation = createRecommendation({
        runId,
        candidate: candidates[0]!,
        candidateId: candidateIds[0]!,
        problemIrHash: ir.hash,
        modelArtifactHash: artifactHash,
        evidenceSource: context.evidenceSource,
        uqEvidence: uqSnapshot,
      })
    }
    return { runId, bindingId: resolved.binding.id, profileVersion: resolved.binding.profileVersion, result, recommendation, context: pick(context) }
  }
  finally {
    resolved.lease.release()
  }
}

function pick(context: ContextSnapshot): SolveOutcome['context'] {
  return {
    capturedAt: context.capturedAt, eventAsOf: context.eventAsOf,
    availabilityWatermark: context.availabilityWatermark, conditionId: context.conditionId,
  }
}

/**
 * 工件 UQ → 建议证据快照(D2/D4/D5):
 * 无 uq 字段(旧 ONNX/样本不足)→ null(维持 unverified,不伪造);
 * inputDistance 由本次上下文现算(MV+CV 双偏移;σ 缺失/列序不符 → null 不乐观)。
 */
function buildUqEvidence(
  artifact: { uq?: ArtifactUq, norm?: { u: { mean: number[], std: number[] }, y: { mean: number[], std: number[] } }, mvOrder?: string[], cvOrder?: string[] },
  artifactHash: string,
  context: ContextSnapshot,
): RecommendationUqEvidence | null {
  const uq = artifact.uq
  if (!uq) return null
  const currentU = (artifact.mvOrder ?? []).map(id => context.currentInputs[id])
  const currentY = (artifact.cvOrder ?? []).map(id => context.currentOutputs[id])
  const distance = artifact.norm
    ? inputDistance({ currentU, currentY, normU: artifact.norm.u, normY: artifact.norm.y })
    : null
  return {
    ...uq,
    artifactHash,
    calibrationFresh: isUqFresh(uq),
    inputDistance: distance,
  }
}

export function getRunStatus(agentId: string, runId: string): { run: ReturnType<ReturnType<typeof getRunRepo>['getRun']>, recommendation: Recommendation | null, candidates: unknown[], crosscheck?: ReturnType<typeof deriveDualState> } {
  const run = getRunRepo().getRun(runId)
  if (!run) throw new AppError(404, 'RUN_NOT_FOUND', `运行 ${runId} 不存在`)
  const binding = db().prepare('SELECT channel_agent_id AS agentId FROM optimizer_bindings WHERE id = ?').get(run.bindingId) as { agentId: string } | undefined
  if (!binding || binding.agentId !== agentId) throw new AppError(403, 'BINDING_NOT_OWNED', `运行 ${runId} 不属于当前 Agent`)
  const recommendation = getRunRepo().latestRecommendationForRun(runId)
  return {
    run,
    recommendation: recommendation ? assertRecommendationUsable(recommendation) : null,
    candidates: getRunRepo().listCandidates(runId),
    // D6 计算态:互校一致由最新 crosscheck 行派生(不改建议 status)
    ...(recommendation ? { crosscheck: deriveDualState(recommendation.id) } : {}),
  }
}

export async function cancel(agentId: string, runId: string): Promise<{ cancelled: boolean }> {
  const run = getRunRepo().getRun(runId)
  if (!run) throw new AppError(404, 'RUN_NOT_FOUND', `运行 ${runId} 不存在`)
  const binding = db().prepare('SELECT channel_agent_id AS agentId FROM optimizer_bindings WHERE id = ?').get(run.bindingId) as { agentId: string } | undefined
  if (!binding || binding.agentId !== agentId) throw new AppError(403, 'BINDING_NOT_OWNED', `运行 ${runId} 不属于当前 Agent`)
  if (run.status !== 'running') return { cancelled: false }
  await getSolverWorkerPool().cancel(runId)
  const fake: SolveResult = {
    runId, status: 'cancelled', candidates: [], firstMove: null, independentCost: null,
    diagnostics: { backend: 'worker', solverVersion: 'unknown', elapsedMs: 0, problemIrHash: run.problemIrHash, message: 'cancelled by request' },
    createdAt: new Date().toISOString(),
  }
  getRunRepo().finishRun(runId, fake)
  return { cancelled: true }
}
