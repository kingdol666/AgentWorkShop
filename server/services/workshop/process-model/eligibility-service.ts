/**
 * 资格评估编排:从已构建的 manifest v2 数据集重建各变量序列 → evaluateEligibility → 落库。
 * 不接受 Agent 自报指标;序列来自不可变数据集工件。
 */
import { AppError } from '../../../utils/errors'
import { getAmlRuntime } from '../aml/runtime'
import { readDataset, pvX, pvY } from './trainers/dataset-reader'
import { evaluateEligibility, getEligibilityRepo, type ActionEvidence, type EligibilitySeries } from './eligibility'
import { getProcessModelSpecRepo, parseSpecRow } from './spec.repo'
import type { EligibilityReport } from './contracts'
import { getDcwLineRepo } from '../dcw/dcw-line.repo'

export interface EvaluateEligibilityInput {
  specId: string
  specVersion?: number
  datasetId: string
  scope?: 'simulation' | 'real'
  evidenceVersion?: string
}

export function evaluateEligibilityFromDataset(input: EvaluateEligibilityInput): EligibilityReport {
  const specRow = getProcessModelSpecRepo().get(input.specId, input.specVersion)
  if (!specRow) throw new AppError(404, 'SPEC_NOT_FOUND', `ProcessModelSpec ${input.specId} 不存在`)
  const spec = parseSpecRow(specRow)
  if (!spec) throw new AppError(404, 'SPEC_NOT_FOUND', `ProcessModelSpec ${input.specId} 不存在`)
  const dataset = getAmlRuntime().repo.dataset.get(input.datasetId)
  if (!dataset) throw new AppError(404, 'DATASET_NOT_FOUND', `数据集 ${input.datasetId} 不存在`)
  if (dataset.lineId !== spec.lineId || dataset.recipeId !== spec.recipeId) {
    throw new AppError(403, 'DATASET_LINEAGE_MISMATCH', '数据集与 ProcessModelSpec 的产线/配方谱系不一致')
  }
  const scope = input.scope ?? 'real'
  // 作用域不能自报且必须与产线性质一致(双向):模拟线只能有 simulation 资格,
  // 真实线只能有 real 资格;否则「real 报告」会被当成可授权真实线的最新资格。
  const line = getDcwLineRepo().byId(spec.lineId)
  if (!line) throw new AppError(404, 'LINE_NOT_FOUND', `产线 ${spec.lineId} 不存在`)
  if (scope === 'simulation' && line.simulated !== true) {
    throw new AppError(422, 'ELIGIBILITY_SCOPE_MISMATCH', '该产线不是模拟产线,不能生成 simulation 作用域资格')
  }
  if (scope === 'real' && line.simulated === true) {
    throw new AppError(422, 'ELIGIBILITY_SCOPE_MISMATCH', '模拟产线的数据只能生成 simulation 作用域资格;real 作用域需要真实产线')
  }
  let ds
  try {
    ds = readDataset(dataset.path)
  }
  catch (err) {
    throw new AppError(422, 'DATASET_READ_FAILED', `数据集读取失败(需要 manifest v2):${err instanceof Error ? err.message : String(err)}`)
  }
  if (ds.manifest.version !== 2) throw new AppError(422, 'DATASET_NOT_V2', '资格评估需要 manifest v2 数据集(由 Process Model 构建)')
  const variables = spec.variables
  const series: EligibilitySeries[] = []
  for (const variable of variables) {
    const idx = ds.allNodes.indexOf(variable.nodeId)
    if (idx < 0) continue
    const values: number[] = []
    // 逐窗口取**同一时点对齐**的值(MV=历史末拍,CV=未来首拍),避免把历史+未来
    // 拼接成一条序列后做滞后相关(会把延迟抹平/错位)。
    for (let n = 0; n < ds.N; n++) {
      if (variable.role === 'cv') {
        const targetIndex = Math.max(0, ds.targetNodes.indexOf(variable.nodeId))
        values.push(pvY(ds, n, 0, Math.min(targetIndex, ds.nTgt - 1)))
      }
      else {
        values.push(pvX(ds, n, ds.H - 1, idx))
      }
    }
    series.push({ variableId: variable.id, role: variable.role, values })
  }
  // 动作证据不从调用方读取:模拟产线视为 simulation_commanded;真实线在动作账本
  // 接入前保持 unknown(fail-closed,不允许 Agent 自报 observed)。
  const actionEvidence: ActionEvidence = scope === 'simulation' ? 'simulation_commanded' : 'unknown'
  const report = evaluateEligibility({
    spec, scope, conditionId: spec.conditions[0]?.id ?? '',
    series,
    actionEvidence,
    sampleCount: dataset.rowCount,
    runCount: dataset.runIds.length,
    evidenceVersion: input.evidenceVersion ?? `ds:${dataset.id}:${dataset.sha256.slice(0, 12)}`,
  })
  // D20:资格行携带 dataset 谱系(dataset_id+hash),solve 按"模型的训练数据集"精确取用
  const id = getEligibilityRepo().save(spec.id, spec.version, report, { datasetId: dataset.id, datasetHash: dataset.sha256 })
  return { ...report, evidenceVersion: report.evidenceVersion || id }
}
