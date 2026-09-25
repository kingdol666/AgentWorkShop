/**
 * Hybrid Twin AML 工具：只做场景读取、快照、VirtualTrial、MPC recommendation-only。
 * 该工具族不拥有任何 DCW 写入能力；模型门禁未通过时仅返回 safe_small_step 试探。
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { agentBadgeLabel } from '../agent-badge'
import { getAmlRuntime } from '../../aml/runtime'
import { defaultInjectionScene, InjectionGreyboxProvider, smallStepCandidates } from '../../aml/twin/physics-runtime'
import { createTwinSnapshot } from '../../aml/twin/snapshot-service'
import { evaluateHybridGates, DEFAULT_ACCEPTANCE_PROFILE } from '../../aml/twin/acceptance'
import { issueRecommendationCertificate, runVirtualTrial } from '../../aml/twin/trial-service'
import { sha256 } from '../../aml/twin/contracts'
import type { HostToolResult } from '../host-tool-bridge/types'
import { recordOps } from '../../ops/ops'
import { createTwinRepo } from '../../aml/twin/repo'
import { requestCalibration, DEFAULT_TWIN_CALIBRATION_POLICY } from '../../aml/twin/calibration-scheduler'

function ok(text: string): HostToolResult {
  return { text }
}
function fail(text: string): HostToolResult {
  return { text, isError: true }
}
function jsonArg<T>(args: Record<string, unknown>, key: string, fallback?: T): T | undefined {
  const value = args[key]
  if (value == null) return fallback
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T
    }
    catch {
      return fallback
    }
  }
  return value as T
}

async function persistTwinArtifact(kind: string, id: string, payload: unknown): Promise<string> {
  const rt = getAmlRuntime()
  const dir = join(rt.root, 'twins', kind, id)
  await mkdir(dir, { recursive: true })
  const path = join(dir, `${kind}.json`)
  await writeFile(path, JSON.stringify(payload, null, 2), 'utf8')
  return path
}

export async function toolTwinSceneRead(_agentId: string, args: Record<string, unknown>): Promise<HostToolResult> {
  const scene = defaultInjectionScene('twin-scene-tool')
  const sceneId = String(args.scene_id ?? scene.sceneId)
  if (sceneId !== scene.sceneId) return fail(`当前 MVP 仅内置可执行场景 ${scene.sceneId}；未知 scene_id=${sceneId} 请先注册 PhysicsModelProvider。`)
  return ok(`场景契约 ${scene.sceneId}@${scene.sceneVersion}\n${JSON.stringify(scene, null, 2)}\n\n控制策略：recommendation-only；模型门禁未通过时只能 safe_small_step，禁止直接 DCW。`)
}

export async function toolTwinSnapshotCreate(agentId: string, args: Record<string, unknown>): Promise<HostToolResult> {
  try {
    const scene = (jsonArg(args, 'scene_json') ?? defaultInjectionScene('twin-snapshot-tool')) as ReturnType<typeof defaultInjectionScene>
    const twinRepo = createTwinRepo(getAmlRuntime().db)
    twinRepo.upsertScene(scene, agentId)
    const snapshot = createTwinSnapshot({
      scene,
      channelId: String(args.channel_id ?? ''),
      createdBy: agentId,
      phase: String(args.phase ?? 'holding'),
      controls: jsonArg<Record<string, number>>(args, 'controls', {}) ?? {},
      states: jsonArg<Record<string, number>>(args, 'states', {}) ?? {},
      disturbances: jsonArg<Record<string, number>>(args, 'disturbances', {}) ?? {},
      samples: jsonArg<Array<{ nodeId: string, at: number, value: number, sequence?: string }>>(args, 'samples', []) ?? [],
      nowMs: Number(args.now_ms) || Date.now(),
      freshnessMaxMs: Number(args.freshness_max_ms) || 60_000,
    })
    twinRepo.insertSnapshot(snapshot)
    const path = await persistTwinArtifact('snapshots', snapshot.snapshotId, snapshot)
    recordOps({ actor: agentId, actorName: agentBadgeLabel(agentId), actorKind: 'agent', action: 'aml.twin.snapshot_create', kind: 'aml' as 'system', summary: `创建 TwinSnapshot ${snapshot.snapshotId}`, targetKind: 'aml_twin_snapshot', targetId: snapshot.snapshotId, lineId: scene.lineId, productId: scene.productId, recipeId: scene.recipeId })
    return ok(`TwinSnapshot 已创建\n  snapshot_id: ${snapshot.snapshotId}\n  hash: ${snapshot.snapshotHash}\n  fresh: ${snapshot.dataQuality.fresh}\n  completeness: ${snapshot.dataQuality.completeness}\n  artifact: ${path}`)
  }
  catch (err) {
    return fail(`TwinSnapshot 创建失败:${err instanceof Error ? err.message : String(err)}`)
  }
}

export async function toolTwinTrialRun(agentId: string, args: Record<string, unknown>): Promise<HostToolResult> {
  try {
    const scene = (jsonArg(args, 'scene_json') ?? defaultInjectionScene('twin-trial-tool')) as ReturnType<typeof defaultInjectionScene>
    const snapshot = jsonArg<Record<string, unknown>>(args, 'snapshot_json') as never
    if (!snapshot) return fail('snapshot_json 必填；必须使用当前 DAQ 生成的 TwinSnapshot，禁止 Agent 伪造执行状态。')
    const provider = new InjectionGreyboxProvider()
    const baseline = jsonArg<Record<string, number>>(args, 'baseline_controls', {}) ?? {}
    const candidate = jsonArg<Array<Record<string, number>>>(args, 'candidate_controls', []) ?? []
    const objective = jsonArg<Record<string, unknown>>(args, 'objective', {
      schemaVersion: 1, createdAt: new Date().toISOString(), createdBy: agentId, objectiveId: 'weight-quality', targets: { weight: 32.5 }, weights: { weight: 1 }, controlCosts: {}, horizonSteps: candidate.length || 4, trustRegion: {},
    }) as never
    const trial = runVirtualTrial({ scene, snapshot, modelId: String(args.model_id ?? 'physics-only-injection-v1'), modelHash: sha256(provider.manifest), objective, baselineControls: baseline, candidateControls: candidate, provider, uncertainty: jsonArg(args, 'uncertainty') as never, createdBy: agentId })
    const certificate = issueRecommendationCertificate(trial, agentId, sha256(provider.manifest), sha256(objective))
    const twinRepo = createTwinRepo(getAmlRuntime().db)
    twinRepo.insertTrial(trial, String(args.model_id ?? 'physics-only-injection-v1'))
    if (certificate) twinRepo.insertRecommendation(certificate, agentId)
    const path = await persistTwinArtifact('trials', trial.trialId, { trial, certificate })
    return ok(`VirtualTrial 已完成(candidateExecuted=false)\n  trial_id: ${trial.trialId}\n  constraints_passed: ${trial.constraintResults.every(c => c.passed)}\n  uq_ood_accepted: ${trial.outOfDistribution.accepted}\n  improvement: ${trial.baselineComparison.improvement}\n  recommendation_id: ${certificate?.recommendationId ?? '(未签发：门禁未通过或无收益)'}\n  artifact: ${path}\n  控制路径: recommendation-only，未调用 DCW。`)
  }
  catch (err) {
    return fail(`VirtualTrial 失败:${err instanceof Error ? err.message : String(err)}`)
  }
}

export async function toolMpcOptimize(agentId: string, args: Record<string, unknown>): Promise<HostToolResult> {
  try {
    const scene = (jsonArg(args, 'scene_json') ?? defaultInjectionScene('twin-mpc-tool')) as ReturnType<typeof defaultInjectionScene>
    const baseline = jsonArg<Record<string, number>>(args, 'baseline_controls', {}) ?? {}
    const modelId = String(args.model_id ?? '').trim()
    const modelRow = modelId ? getAmlRuntime().repo.model.get(modelId) : null
    let modelReady = false
    if (modelRow && (modelRow.stage === 'shadow' || modelRow.stage === 'production')) {
      try {
        const metrics = JSON.parse(modelRow.metricsJson || '{}') as Record<string, unknown>
        const twin = metrics.twinEligibility as Record<string, unknown> | undefined
        modelReady = twin?.recommendationEligible === true && twin?.uqPassed === true && twin?.oodPassed === true && twin?.physicsPassed === true
      }
      catch {
        modelReady = false
      }
    }
    const provider = new InjectionGreyboxProvider()
    const candidates = smallStepCandidates(scene, baseline)
    const mode = modelReady ? 'precise_search' : 'safe_small_step'
    const selected = modelReady ? candidates : candidates.slice(0, Math.min(3, candidates.length))
    const results = selected.map((candidate) => {
      const initial = provider.initialize({ stateEstimate: {}, controlValues: baseline })
      const trajectory = provider.simulate(initial, Array.from({ length: Number(args.horizon_steps) || 4 }, () => candidate), {})
      const constraints = provider.evaluateConstraints(scene, trajectory)
      const last = trajectory.steps.at(-1)?.observations ?? {}
      const cost = ((last.weight ?? 0) - 32.5) ** 2 + (last.flash_rate ?? 0) ** 2 + (last.sink_rate ?? 0) ** 2
      return { candidate, cost, constraintsPassed: constraints.every(c => c.passed), constraints }
    }).filter(x => x.constraintsPassed).sort((a, b) => a.cost - b.cost)
    const best = results[0]
    const report = { modelId: modelId || null, mode, modelReady, candidatesEvaluated: selected.length, bestCandidate: best?.candidate ?? null, bestCost: best?.cost ?? null, recommendationOnly: true, preciseSearchAllowed: modelReady && results.length > 0 }
    const path = await persistTwinArtifact('mpc', `run-${Date.now().toString(36)}`, report)
    return ok(`MPC recommendation-only 试验完成\n${JSON.stringify(report, null, 2)}\nartifact: ${path}\n${modelReady ? '模型门禁已通过，可进行更精确的候选搜索，但仍不能直接写 DCW。' : '模型门禁未通过，仅执行 safe_small_step 小步试探；先收集 DAQ 数据，不执行精确搜索。'}`)
  }
  catch (err) {
    return fail(`MPC 优化失败:${err instanceof Error ? err.message : String(err)}`)
  }
}

export async function toolTwinGateEvaluate(_agentId: string, args: Record<string, unknown>): Promise<HostToolResult> {
  try {
    const result = evaluateHybridGates({
      rows: Number(args.rows ?? 0), runs: Number(args.runs ?? 0), oneStepTestNrmse: Number(args.one_step_nrmse ?? 1), rolloutTestNrmse: Number(args.rollout_nrmse ?? 1), valTestGap: Number(args.val_test_gap ?? 1), calibrationRows: Number(args.calibration_rows ?? 0), calibrationCoverage: Number(args.coverage ?? 0), candidateTrials: jsonArg(args, 'candidate_trials', []) as never, physicsSolverFailureRate: Number(args.physics_failure_rate ?? 1),
    }, DEFAULT_ACCEPTANCE_PROFILE)
    return ok(JSON.stringify(result, null, 2))
  }
  catch (err) {
    return fail(`Twin Gate 评估失败:${err instanceof Error ? err.message : String(err)}`)
  }
}

export async function toolTwinCalibrationRequest(agentId: string, args: Record<string, unknown>): Promise<HostToolResult> {
  try {
    const rt = getAmlRuntime()
    const result = requestCalibration(rt.db, {
      sceneId: String(args.scene_id ?? 'injection-hold-control'),
      lineId: String(args.line_id ?? ''),
      recipeId: String(args.recipe_id ?? ''),
      newRuns: Number(args.new_runs ?? 0),
      newRows: Number(args.new_rows ?? 0),
      driftScore: Number(args.drift_score ?? 0),
      errorScore: Number(args.error_score ?? 0),
      reason: String(args.reason ?? 'agent_requested'),
    }, DEFAULT_TWIN_CALIBRATION_POLICY, agentId)
    return ok(JSON.stringify({ ...result, policy: DEFAULT_TWIN_CALIBRATION_POLICY, next: result.accepted ? 'AgentTeam lead should dispatch data/calibration/training/evaluation tasks; production model remains unchanged.' : 'Collect more DAQ runs or wait for cooldown.' }, null, 2))
  }
  catch (err) {
    return fail(`持续校准请求失败:${err instanceof Error ? err.message : String(err)}`)
  }
}
