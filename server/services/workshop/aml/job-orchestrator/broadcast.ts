/**
 * WS 广播:作业 / 阶段 / 进度
 * (由 server/services/workshop/aml/job-orchestrator.ts 按职责拆出;内容逐行原文搬运)
 */
import type { AmlJobRow } from '../aml.repo'
import { PROGRESS_WS_MIN_MS, state } from './shared'
import { broadcastSceneEvent } from '../../scene-events'
import { currentStage, currentStatus } from './stages'
import { getAmlRuntime } from '../runtime'

export function wsJob(row: AmlJobRow | undefined, dataset: { lineId: string } | undefined): void {
  if (!row) return
  broadcastSceneEvent('aml.job', {
    jobId: row.id, datasetId: row.datasetId, lineId: dataset?.lineId,
    status: row.status, stage: row.stage, progress: row.progress, purpose: row.purpose,
  })
}

export function wsStage(row: AmlJobRow, stage: string): void {
  const rt = getAmlRuntime()
  wsJob(rt.repo.job.get(row.id), rt.repo.dataset.get(row.datasetId))
  void stage
}

export function wsProgress(row: AmlJobRow, progress: number, note: string): void {
  const rt = getAmlRuntime()
  const run = state().running.get(row.id)
  const now = Date.now()
  if (run && now - run.lastWsAt < PROGRESS_WS_MIN_MS && progress < 100) return
  if (run) run.lastWsAt = now
  broadcastSceneEvent('aml.job', {
    jobId: row.id, datasetId: row.datasetId, lineId: rt.repo.dataset.get(row.datasetId)?.lineId,
    status: currentStatus(row.id), stage: currentStage(row.id), progress, note,
  })
}

/** 探针(python 缺失时给 UI/工具明确状态) */
