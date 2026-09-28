/**
 * 阶段与状态读取 / stub 运行 / 结题
 * (由 server/services/workshop/aml/job-orchestrator.ts 按职责拆出;内容逐行原文搬运)
 */
import type { AmlJobRow } from '../aml.repo'
import type { PlatformMetrics } from '../gates'
import type { RunningJob } from './shared'
import { evaluateGates } from '../gates'
import { finishRun, safeParse } from './failure'
import { getAmlRuntime } from '../runtime'
import { join } from 'node:path'
import { loadManifest } from '../dataset-builder'
import { log } from './shared'
import { readFileSync, writeFileSync } from 'node:fs'
import { recordOps } from '../../ops/ops'
import { registerModelFromJob } from '../model-registry'
import { wsJob, wsStage } from './broadcast'

export function currentStatus(jobId: string): AmlJobRow['status'] {
  const row = getAmlRuntime().repo.job.get(jobId)
  return row?.status ?? 'training'
}
export function currentStage(jobId: string): string {
  return getAmlRuntime().repo.job.get(jobId)?.stage ?? ''
}

/** 存根运行器(AML_STUB=1):不依赖 Python,模拟训练并产出可达标 metrics + STUB 标记 */
export async function runStub(run: RunningJob, artifacts: string): Promise<void> {
  const rt = getAmlRuntime()
  rt.repo.job.setState(run.row.id, 'training', 'train', 30)
  wsStage(run.row, 'train')
  await new Promise(r => setTimeout(r, 500))
  const params = safeParse(rt.repo.job.get(run.row.id)?.budget ?? {}).params ?? {}
  const p = params as { stubNrmse?: number, stubRolloutNrmse?: number }
  const oneStep = Number(p.stubNrmse ?? 0.07)
  const rollout = Number(p.stubRolloutNrmse ?? 0.18)
  rt.repo.job.setState(run.row.id, 'evaluating', 'evaluate', 80)
  wsStage(run.row, 'evaluate')
  await new Promise(r => setTimeout(r, 200))
  const metrics: PlatformMetrics = {
    oneStepVal: { windows: 100, nrmse: oneStep * 0.9 },
    oneStepTest: { windows: 100, nrmse: oneStep },
    rolloutTest: { windows: 50, nrmse: rollout, horizon: 12 },
  }
  writeFileSync(join(artifacts, 'metrics.json'), JSON.stringify({ ...params, ...metrics }, null, 2))
  writeFileSync(join(artifacts, 'STUB'), new Date().toISOString())
  concludeJob(run, artifacts)
}

export function concludeJob(run: RunningJob, artifactsDir: string): void {
  const rt = getAmlRuntime()
  const dataset = rt.repo.dataset.get(run.row.datasetId)
  if (!dataset) {
    rt.repo.job.fail(run.row.id, 'failed', '数据集已被删除', new Date().toISOString())
    finishRun(run)
    return
  }
  let metrics: PlatformMetrics | undefined
  try {
    // 存储形态:平台指标平铺顶层(消费方契约)+ 保留其余自报块(hybrid/physics/uncertainty
    // 等 Twin Gate 消费)与嵌套 platform 原样 —— 两种读取形状同源,不丢块。
    const parsed = JSON.parse(readFileSync(join(artifactsDir, 'metrics.json'), 'utf8')) as { platform?: PlatformMetrics, agent?: unknown } & PlatformMetrics
    metrics = { ...parsed, ...(parsed.platform ?? {}) } as PlatformMetrics
  }
  catch { /* 缺 metrics → 门禁全挂 */ }
  const manifest = loadManifest(dataset)
  const gates = evaluateGates(run.row.purpose, dataset, manifest, metrics, artifactsDir)
  const gatesJson = JSON.stringify(gates)
  const metricsJson = JSON.stringify(metrics ?? {})
  rt.repo.job.finish(run.row.id, gates.passed ? 'done' : 'failed', metricsJson, gatesJson, artifactsDir, new Date().toISOString())
  if (!gates.passed) {
    rt.repo.job.fail(run.row.id, 'failed', `评测门未通过:${gates.checks.filter(c => !c.pass).map(c => `${c.id} ${c.detail}`).join('; ')}`, new Date().toISOString())
    // 门禁未过=实验记录 gates_failed(非作业错误语义,但作业 fail 承载原因)
  }
  // 实验与模型登记(实验 id = job id 首跑对应;重试复用)
  let registeredModelId: string | undefined
  try {
    registeredModelId = registerModelFromJob(run.row.id, gates, metricsJson).modelId
  }
  catch (err) {
    log.warn(`[aml-job] ${run.row.id} 模型登记失败:${err instanceof Error ? err.message : String(err)}`)
  }
  // 建模任务收口:该作业若由 aml_training_plans 派生,回写 plan 终态与模型 id。
  void import('../twin/training-plans')
    .then(m => m.settleTrainingPlanByJob(run.row.id, gates.passed ? 'done' : 'failed', registeredModelId, gates.checks.filter(c => !c.pass).map(c => `${c.id} ${c.detail}`).join('; ')))
    .catch(() => { /* plan 模块不可用不阻断作业收口 */ })
  // 持续校准 worker 收口:该作业若由 twin_update_runs 派生,更新其终态(成功/失败)。
  // 动态 import 规避 stages ↔ calibration-worker ↔ job-orchestrator 的循环装载。
  void import('../twin/calibration-worker')
    .then(m => m.markTwinUpdateRunFinished(
      run.row.id,
      gates.passed,
      gates.checks.filter(c => !c.pass).map(c => `${c.id} ${c.detail}`).join('; '),
    ))
    .catch(() => { /* worker 不可用不阻断作业收口 */ })
  const datasetFresh = rt.repo.dataset.get(run.row.datasetId)
  const byKind = safeParse(run.row.budget).byKind
  const actorKind: 'user' | 'agent' | 'system' = byKind === 'user' || byKind === 'agent' ? byKind : run.row.agentId ? 'agent' : 'system'
  recordOps({
    actor: run.row.agentId || 'aml', actorName: run.row.agentId || 'AML', actorKind,
    action: 'aml.job.finish', kind: 'system',
    summary: `作业 ${run.row.id} 结束:门禁${gates.passed ? '全部通过' : '未通过'}`,
    targetKind: 'aml_job', targetId: run.row.id,
    lineId: datasetFresh?.lineId, productId: datasetFresh?.productId, recipeId: datasetFresh?.recipeId,
  })
  wsJob(rt.repo.job.get(run.row.id) ?? run.row, datasetFresh)
  finishRun(run)
}
