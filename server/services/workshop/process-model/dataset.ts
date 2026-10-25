/**
 * Process Model 数据集构建(G2.6/G2.9):
 *   spec(变量/单位/延迟/窗口/工况) → 复用 AML buildDataset → manifest v2(可追溯)。
 *
 * 不复制 AML 数据集实现;只在规格映射与 v2 元数据上扩展。取数走 queryTaggedPage
 * (dataset-builder 内部,C7),不使用 EDA 图表的最多 2000 点展示数据。
 */
import { AppError } from '../../../utils/errors'
import { getTsdb } from '../daq/storage'
import { getDaqNodeRepo } from '../daq/daq-node.repo'
import { getDcwRecipeRepo } from '../dcw/dcw-recipe.repo'
import { getDcwLineRepo } from '../dcw/dcw-line.repo'
import type { AmlDatasetSpec } from '../aml/spec'
import { buildDataset, type ProcessDatasetExtras } from '../aml/dataset-builder'
import type { ProcessModelSpec } from './contracts'
import { parseProcessModelSpec } from './spec'
import { recipeContentHash, getContextSegmentRepo } from './context-segments.repo'
import { computeWatermark } from './watermark'

export interface BuildProcessDatasetResult {
  datasetId: string
  rowCount: number
  sha256: string
  path: string
  evidenceSource: 'simulation' | 'real' | 'unassessed'
  availabilityWatermark: number | null
  recipeVersion: number
  runIds: string[]
  /** D18:1 = 每 run 均有已确认 segment 且版本匹配;0 = 存在 unknown/排除(模型禁优化资格) */
  lineageVerified: number
  runLineage: { verified: string[], unknown: string[], excluded: Array<{ runId: string, reason: string }> }
}

/** ProcessModelSpec → 旧 AML 数据集规格(节点角色/窗口/切分/清洗一一映射)。 */
export function toAmlDatasetSpec(spec: ProcessModelSpec): AmlDatasetSpec {
  const nodes = spec.variables.map(variable => ({
    nodeId: variable.nodeId,
    role: variable.role === 'mv' ? 'control' as const : variable.role === 'cv' ? 'target' as const : 'feature' as const,
  }))
  if (!nodes.some(n => n.role === 'target')) {
    throw new AppError(422, 'SPEC_INVALID', 'ProcessModelSpec 至少需要 1 个 CV(target)节点')
  }
  return {
    lineId: spec.lineId,
    productId: spec.productId,
    recipeId: spec.recipeId,
    runIds: spec.datasetPolicy.runIds,
    fromMs: spec.datasetPolicy.fromMs,
    toMs: spec.datasetPolicy.toMs,
    nodes,
    beatMs: spec.timing.beatMs,
    window: { historySteps: spec.timing.historySteps, horizonSteps: spec.timing.horizonSteps },
    cleaning: spec.datasetPolicy.cleaning,
    split: spec.datasetPolicy.split,
    purpose: spec.purpose,
    note: spec.note ?? '',
  }
}

export async function buildProcessModelDataset(raw: unknown, by: { id: string, kind: 'user' | 'agent' }): Promise<BuildProcessDatasetResult> {
  const spec = parseProcessModelSpec(raw)
  // 节点必须属于该产线(隔离硬约束;逐节点再核一次,给可定位错误)
  const nodeRepo = getDaqNodeRepo()
  for (const variable of spec.variables) {
    const node = nodeRepo.byId(variable.nodeId)
    if (!node) throw new AppError(404, 'PROCESS_NODE_MISSING', `变量 ${variable.id} 映射的节点 ${variable.nodeId} 不存在`)
    if (node.lineId !== spec.lineId) throw new AppError(403, 'PROCESS_NODE_LINE_MISMATCH', `节点 ${variable.nodeId} 属于产线 ${node.lineId},与规格产线 ${spec.lineId} 不一致`)
  }
  const recipe = getDcwRecipeRepo().byId(spec.recipeId)
  if (!recipe) throw new AppError(404, 'PROCESS_RECIPE_MISSING', `配方 ${spec.recipeId} 不存在`)
  if (recipe.version !== undefined && spec.recipeVersion !== 0 && recipe.version !== spec.recipeVersion) {
    throw new AppError(409, 'PROCESS_RECIPE_VERSION_MISMATCH', `配方当前版本 v${recipe.version} 与规格冻结版本 v${spec.recipeVersion} 不一致;请基于当前版本重建规格`)
  }
  const runs = getDcwRecipeRepo().listRuns().filter(r => r.recipeId === spec.recipeId && !!r.endedAt)
  if (!runs.length) throw new AppError(422, 'PROCESS_NO_RUNS', '该配方没有已完结批次;先在产线跑完一批(或执行模拟试验)')
  // D18 逐 run 版本归属:以已确认 context segment 为准,不用当前配方版本倒填历史。
  //   - 段已确认且版本/内容 hash 与规格冻结一致 → verified
  //   - 段版本不一致 → 该 run 排除(防止 v1 批次被 v2 规格冒名收编)
  //   - 无任何段 → unknown(数据保留但 lineage_verified=0,模型禁优化资格)
  const segmentRepo = getContextSegmentRepo()
  const segmentsByRun = new Map<string, Array<{ confirmed: number, recipeId: string, recipeVersion: number, recipeContentHash: string }>>()
  try {
    for (const seg of segmentRepo.listByLine(spec.lineId)) {
      const list = segmentsByRun.get(seg.runId) ?? []
      list.push({ confirmed: seg.confirmed, recipeId: seg.recipeId, recipeVersion: seg.recipeVersion, recipeContentHash: seg.recipeContentHash })
      segmentsByRun.set(seg.runId, list)
    }
  }
  catch { /* 段表未初始化(单测)→ 全部按 unknown 处理 */ }
  const frozenHash = recipeContentHash(recipe)
  const verifiedRunIds: string[] = []
  const unknownRunIds: string[] = []
  const excludedRuns: Array<{ runId: string, reason: string }> = []
  for (const r of runs) {
    const segs = segmentsByRun.get(r.id) ?? []
    if (!segs.length) {
      unknownRunIds.push(r.id)
      continue
    }
    const ok = segs.some(s => s.confirmed === 1
      && s.recipeId === spec.recipeId
      && (spec.recipeVersion === 0 || s.recipeVersion === spec.recipeVersion)
      && s.recipeContentHash === frozenHash)
    if (ok) verifiedRunIds.push(r.id)
    else excludedRuns.push({ runId: r.id, reason: `context segment 版本与规格冻结版本 v${spec.recipeVersion || recipe.version} 不一致` })
  }
  const keptRuns = runs.filter(r => !excludedRuns.some(e => e.runId === r.id))
  if (!keptRuns.length) throw new AppError(422, 'PROCESS_NO_RUNS', '全部历史批次的 context segment 与规格冻结版本不一致;请基于对应版本重建规格')
  // 来源由产线性质决定:模拟线不能把数据标成 real(反之亦然)。
  const line = getDcwLineRepo().byId(spec.lineId)
  const evidenceSource: 'simulation' | 'real' | 'unassessed' = line?.simulated === true ? 'simulation' : 'real'
  const availabilityWatermark = await computeWatermark(getTsdb(), spec, runs.map(r => r.id))

  const amlSpec = toAmlDatasetSpec(spec)
  // D18:被排除的 run 不进数据集(builder 按 runIds 过滤)
  amlSpec.runIds = keptRuns.map(r => r.id)
  const extras: ProcessDatasetExtras = {
    specRef: spec.id,
    specVersion: spec.version,
    trainerRef: spec.trainer.ref,
    conditionId: spec.conditions[0]?.id ?? '',
    recipeVersion: spec.recipeVersion || recipe.version || 0,
    recipeContentHash: recipeContentHash(recipe),
    evidenceSource,
    variables: spec.variables.map(v => ({
      id: v.id, nodeId: v.nodeId, role: v.role, unit: v.unit, modelUnit: v.modelUnit, scale: v.scale, offset: v.offset, delayMs: v.delayMs,
    })),
    availabilityWatermark,
    runLineage: { verified: verifiedRunIds, unknown: unknownRunIds, excluded: excludedRuns },
  }
  const built = await buildDataset(amlSpec, by, extras)
  return {
    datasetId: built.dataset.id,
    rowCount: built.dataset.rowCount,
    sha256: built.dataset.sha256,
    path: built.dataset.path,
    evidenceSource,
    availabilityWatermark,
    recipeVersion: extras.recipeVersion,
    runIds: built.dataset.runIds,
    lineageVerified: extras.runLineage ? (unknownRunIds.length === 0 && excludedRuns.length === 0 && verifiedRunIds.length > 0 ? 1 : 0) : 0,
    runLineage: extras.runLineage ?? { verified: [], unknown: [], excluded: [] },
  }
}
