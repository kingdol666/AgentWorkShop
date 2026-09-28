/**
 * 持续校准 worker:消费 twin_update_runs 里排队的新数据信号,自动发起
 * hybrid_residual 重训候选(冻结场景 + 最新编译 PhysicsSpec + 该配方最新数据集)。
 *
 * 纪律(plan §8.3/§9.4.3):
 *  - 只生成 candidate;绝不自动晋升 production(晋升仍走 HITL + Twin Gate);
 *  - 训练开关(AML_TWIN_TRAINING_ENABLED/CHANNEL_ENABLED)关闭时整个 worker 空转;
 *  - 每条 run 状态机 queued → running(携带 job_id)→ succeeded/failed,
 *    由 concludeJob 钩子收口;提交失败直接 failed,不阻塞后续信号。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { createLogger } from '../../logger'
import { submitJob } from '../job-orchestrator'
import { getAmlRuntime } from '../runtime'
import { amlTwinFeatureFlags } from './feature-flags'
import { compileDeclarativeProvider } from './declarative-provider'
import { validatePhysicsSpec, type PhysicsSpec } from './physics-spec'

const log = createLogger('aml.twin-worker')

interface UpdateRunRow {
  id: string
  requestId: string
  dedupKey: string
  sceneId: string
  lineId: string
  recipeId: string
  state: string
  payloadJson: string
  createdAt: string
}

function frozenSceneLatest(db: DatabaseSync, sceneId: string): { sceneVersion: string, contract: Record<string, unknown>, objectiveProfileIds: string[] } | undefined {
  const row = db.prepare(
    `SELECT scene_version AS sceneVersion, contract_json AS contractJson FROM twin_scenes
     WHERE scene_id = ? AND status = 'frozen' ORDER BY created_at DESC LIMIT 1`,
  ).get(sceneId) as { sceneVersion?: string, contractJson?: string } | undefined
  if (!row?.contractJson) return undefined
  try {
    const contract = JSON.parse(row.contractJson) as Record<string, unknown>
    const ids = Array.isArray(contract.objectiveProfileIds) ? contract.objectiveProfileIds as string[] : []
    return { sceneVersion: String(row.sceneVersion), contract, objectiveProfileIds: ids }
  }
  catch {
    return undefined
  }
}

/** 最近一次为该场景编译通过的 PhysicsSpec 工件(twin_physics_spec_compile 落盘) */
function latestCompiledSpecForScene(root: string, sceneId: string): PhysicsSpec | undefined {
  const dir = join(root, 'twins', 'physics-spec')
  if (!existsSync(dir)) return undefined
  const candidates: Array<{ at: string, spec: PhysicsSpec }> = []
  for (const entry of readdirSync(dir)) {
    const file = join(dir, entry, 'physics-spec.json')
    if (!existsSync(file)) continue
    try {
      const artifact = JSON.parse(readFileSync(file, 'utf8')) as { sceneId?: string, spec?: unknown, compiledAt?: string }
      if (artifact.sceneId !== sceneId || !artifact.spec) continue
      const checked = validatePhysicsSpec(artifact.spec)
      if (checked.valid && checked.spec) candidates.push({ at: String(artifact.compiledAt ?? ''), spec: checked.spec })
    }
    catch { /* 跳过损坏工件 */ }
  }
  candidates.sort((a, b) => b.at.localeCompare(a.at))
  return candidates[0]?.spec
}

export function processQueuedTwinUpdates(): number {
  const flags = amlTwinFeatureFlags()
  if (!flags.channelEnabled || !flags.trainingEnabled) return 0
  const rt = getAmlRuntime()
  const queued = rt.db.prepare(
    `SELECT id, request_id AS requestId, dedup_key AS dedupKey, scene_id AS sceneId, line_id AS lineId,
            recipe_id AS recipeId, state, payload_json AS payloadJson, created_at AS createdAt
     FROM twin_update_runs WHERE state = 'queued' ORDER BY created_at LIMIT 10`,
  ).all() as unknown as UpdateRunRow[]
  let dispatched = 0
  for (const run of queued) {
    const scene = frozenSceneLatest(rt.db, run.sceneId)
    if (!scene) {
      rt.db.prepare(`UPDATE twin_update_runs SET state = 'failed', error = ?, ended_at = ? WHERE id = ? AND state = 'queued'`)
        .run(`场景 ${run.sceneId} 无冻结 SceneContract:先 twin_scene_compile/freeze 再请求校准`, new Date().toISOString(), run.id)
      continue
    }
    const spec = latestCompiledSpecForScene(rt.root, run.sceneId)
    if (!spec) {
      rt.db.prepare(`UPDATE twin_update_runs SET state = 'failed', error = ?, ended_at = ? WHERE id = ? AND state = 'queued'`)
        .run(`场景 ${run.sceneId} 无已编译 PhysicsSpec 工件:先 twin_physics_spec_compile`, new Date().toISOString(), run.id)
      continue
    }
    const [dataset] = rt.repo.dataset.list({ lineId: run.lineId, ...(run.recipeId ? { recipeId: run.recipeId } : {}), limit: 1 })
    if (!dataset) {
      rt.db.prepare(`UPDATE twin_update_runs SET state = 'failed', error = ?, ended_at = ? WHERE id = ? AND state = 'queued'`)
        .run(`产线 ${run.lineId}/配方 ${run.recipeId || '(任意)'} 无可用数据集:先 aml_dataset_build`, new Date().toISOString(), run.id)
      continue
    }
    const claimed = rt.db.prepare(`UPDATE twin_update_runs SET state = 'running', started_at = ? WHERE id = ? AND state = 'queued'`)
      .run(new Date().toISOString(), run.id)
    if (Number(claimed.changes) !== 1) continue
    try {
      const manifest = compileDeclarativeProvider(spec).manifest
      const job = submitJob({
        datasetId: dataset.id,
        jobKind: 'hybrid_residual',
        sceneId: run.sceneId,
        sceneVersion: scene.sceneVersion,
        objectiveId: scene.objectiveProfileIds[0] ?? undefined,
        physicsSpec: spec as unknown as Record<string, unknown>,
        providerId: manifest.physicsModelId,
        providerVersion: manifest.version,
        providerHash: manifest.sourceHash,
        modelName: `持续校准 ${run.sceneId}@${scene.sceneVersion}`,
        modelDescription: `校准 worker 自动发起:${run.sceneId} 场景在产线 ${run.lineId}/配方 ${run.recipeId || '(任意)'} 的 hybrid 残差重训候选`,
      })
      const payload = { ...(JSON.parse(run.payloadJson || '{}') as Record<string, unknown>), jobId: job.id }
      rt.db.prepare(`UPDATE twin_update_runs SET payload_json = ? WHERE id = ?`).run(JSON.stringify(payload), run.id)
      dispatched += 1
      log.info(`[twin-worker] 校准信号 ${run.id} → 训练作业 ${job.id}(scene=${run.sceneId}, dataset=${dataset.id})`)
    }
    catch (err) {
      rt.db.prepare(`UPDATE twin_update_runs SET state = 'failed', error = ?, ended_at = ? WHERE id = ? AND state = 'running'`)
        .run(`训练作业提交失败:${err instanceof Error ? err.message : String(err)}`, new Date().toISOString(), run.id)
    }
  }
  return dispatched
}

/** concludeJob 钩子:按 job_id 收口 running 状态的校准 run(成功=候选就绪,失败=保留旧生产) */
export function markTwinUpdateRunFinished(jobId: string, ok: boolean, error?: string): void {
  try {
    const rt = getAmlRuntime()
    const rows = rt.db.prepare(`SELECT id, payload_json AS payloadJson FROM twin_update_runs WHERE state = 'running'`).all() as unknown as Array<{ id: string, payloadJson: string }>
    for (const row of rows) {
      try {
        const payload = JSON.parse(row.payloadJson || '{}') as { jobId?: string }
        if (payload.jobId !== jobId) continue
        rt.db.prepare(`UPDATE twin_update_runs SET state = ?, error = ?, ended_at = ?, cooldown_until = ? WHERE id = ?`)
          .run(ok ? 'succeeded' : 'failed', ok ? '' : (error ?? 'training failed'), new Date().toISOString(), new Date(Date.now() + 3600_000).toISOString(), row.id)
        return
      }
      catch { /* payload 损坏的行跳过 */ }
    }
  }
  catch (err) {
    log.warn(`[twin-worker] 校准 run 收口失败(job=${jobId}):${err instanceof Error ? err.message : String(err)}`)
  }
}
