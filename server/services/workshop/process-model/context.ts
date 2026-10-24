/**
 * Runtime Context(plan §3.2 / G2.6):
 *   getRuntimeContext(spec, asOf) → 真实 history + timestamps + dt + qualityMask
 *   + 当前实际输入 + 状态估计 + availabilityWatermark。
 *
 * 铁律:历史不足明确拒绝;不复制单快照伪造历史(旧 model-backed-provider 的缺陷);
 * watermark = max(ingested_at),全部为 NULL 时 = unknown(不得用于严格在线回放)。
 */
import { AppError } from '../../../utils/errors'
import { toModel as sharedToModel } from '@/shared/units'
import { getTsdb } from '../daq/storage'
import type { TsdbPoint } from '../daq/storage/tsdb-port'
import { getDcwRecipeRepo } from '../dcw/dcw-recipe.repo'
import type { VariableMap, ProcessModelSpec } from './contracts'
import { matchCondition } from './contracts'
import { fetchNodeSeries } from '../aml/dataset-builder'
import { getContextSegmentRepo, recipeContentHash } from './context-segments.repo'

export interface ContextSnapshot {
  lineId: string
  productId: string
  recipeId: string
  recipeVersion: number
  conditionId: string
  capturedAt: string
  /** 历史末点的事件时间(允许使用的最后观测) */
  eventAsOf: number
  /** 平台入库水位(= max(ingested_at));null = unknown */
  availabilityWatermark: number | null
  dtMs: number
  variables: VariableMap[]
  /** [H][F],按 spec.variables 顺序,已换算到模型单位 */
  history: number[][]
  timestamps: number[]
  /** [H][F],state=ok 且值有限 */
  qualityMask: boolean[][]
  /** 当前 MV 实际值(模型单位) */
  currentInputs: Record<string, number>
  /** 最近一次 CV 观测(模型单位) */
  currentOutputs: Record<string, number>
  /** 数据来源(由资格作用域决定;缺省 unassessed) */
  evidenceSource: 'simulation' | 'real' | 'unassessed'
}

function toModel(value: number, variable: VariableMap): number {
  // D23 唯一换算边界:spec parse 已强制 scale/offset 有限(scale≠0);此处缺失/非法 = 契约破坏,fail-closed
  return sharedToModel(value, { scale: variable.scale as number, offset: variable.offset as number }, `变量 ${variable.id}`)
}

/** 从点列取最后一个 ≤ t 的值;过期/非 ok 一律视为缺失(不拿坏点当历史)。 */
function valueAt(points: TsdbPoint[], t: number, maxAgeMs: number): { value: number, state: string } | null {
  let best: TsdbPoint | null = null
  for (const p of points) {
    if (p.at <= t && (!best || p.at > best.at)) best = p
  }
  if (!best || best.value === undefined || !Number.isFinite(best.value)) return null
  if (t - best.at > maxAgeMs) return null
  return { value: best.value, state: best.state ?? 'unknown' }
}

export async function getRuntimeContext(spec: ProcessModelSpec, asOfMs?: number): Promise<ContextSnapshot> {
  const asOf = asOfMs ?? Date.now()
  const beat = spec.timing.beatMs
  const H = spec.timing.historySteps
  const maxDelay = Math.max(0, ...spec.variables.filter(v => v.role === 'mv').map(v => v.delayMs ?? 0))
  const fromMs = asOf - (H * beat + maxDelay + beat * 5)
  const tsdb = getTsdb()
  const pointsByVariable = new Map<string, TsdbPoint[]>()
  for (const variable of spec.variables) {
    const points = await fetchNodeSeries(tsdb, variable.nodeId, {
      lineId: spec.lineId, productId: spec.productId, recipeId: spec.recipeId,
      fromMs, toMs: asOf,
    })
    if (!points.length) {
      throw new AppError(422, 'CONTEXT_INSUFFICIENT', `变量 ${variable.id}(节点 ${variable.nodeId})在 ${new Date(fromMs).toISOString()} ~ ${new Date(asOf).toISOString()} 无样本`)
    }
    pointsByVariable.set(variable.id, points)
  }

  const history: number[][] = []
  const timestamps: number[] = []
  const qualityMask: boolean[][] = []
  const watermarks: number[] = []
  let anyIngest = false
  for (let i = H - 1; i >= 0; i--) {
    const t = asOf - i * beat
    const row: number[] = []
    const mask: boolean[] = []
    for (const variable of spec.variables) {
      const points = pointsByVariable.get(variable.id) ?? []
      const hit = valueAt(points, t, beat * 1.5)
      if (hit && hit.state === 'ok') {
        row.push(toModel(hit.value, variable))
        mask.push(true)
        const ingested = points.filter(p => p.at === t && p.ingestedAt != null).map(p => p.ingestedAt as number)
        if (ingested.length) {
          anyIngest = true
          watermarks.push(Math.max(...ingested))
        }
      }
      else {
        // 坏点/过期点不进入历史(否则常量持值会伪装成观测)
        row.push(Number.NaN)
        mask.push(false)
      }
    }
    history.push(row)
    timestamps.push(t)
    qualityMask.push(mask)
  }

  // 历史末行必须全部可观测(MV/CV 都不允许 NaN);否则明确拒绝,不用持值/复制伪造
  const lastRow = history[history.length - 1] ?? []
  const missing = spec.variables.filter((v, idx) => !Number.isFinite(lastRow[idx]))
  if (missing.length) {
    throw new AppError(422, 'CONTEXT_INSUFFICIENT', `历史末点缺少可观测变量:${missing.map(v => v.id).join(', ')}`)
  }

  const conditionId = requireCondition(spec, asOf)
  const currentInputs: Record<string, number> = {}
  const currentOutputs: Record<string, number> = {}
  for (let idx = 0; idx < spec.variables.length; idx++) {
    const variable = spec.variables[idx]!
    const value = lastRow[idx]!
    if (variable.role === 'mv') {
      const domain = spec.effectiveDomain.mv[variable.id]
      if (domain && (value < domain.min - 1e-9 || value > domain.max + 1e-9)) {
        throw new AppError(422, 'CONTEXT_OOD', `当前 MV ${variable.id}=${value} 超出模型有效域[${domain.min}, ${domain.max}];拒绝用域外状态求解`)
      }
      currentInputs[variable.id] = value
    }
    if (variable.role === 'cv') {
      const domain = spec.effectiveDomain.cv?.[variable.id]
      if (domain && (value < domain.min - 1e-9 || value > domain.max + 1e-9)) {
        throw new AppError(422, 'CONTEXT_OOD', `当前 CV ${variable.id}=${value} 超出模型有效域[${domain.min}, ${domain.max}]`)
      }
      currentOutputs[variable.id] = value
    }
  }

  return {
    lineId: spec.lineId,
    productId: spec.productId,
    recipeId: spec.recipeId,
    recipeVersion: spec.recipeVersion,
    conditionId,
    capturedAt: new Date().toISOString(),
    eventAsOf: asOf,
    availabilityWatermark: anyIngest ? Math.max(...watermarks) : null,
    dtMs: beat,
    variables: spec.variables,
    history,
    timestamps,
    qualityMask,
    currentInputs,
    currentOutputs,
    evidenceSource: 'unassessed',
  }
}

function requireCondition(spec: ProcessModelSpec, _asOf: number): string {
  // 运行时用声明身份 exactly-one 命中(exactly-one 由 matchCondition 强制);
  // 批次谱系段版本不一致 → 旧计划失效。
  const segment = getContextSegmentRepo().at(spec.lineId, _asOf)
  if (segment && segment.confirmed === 1) {
    if (segment.recipeId !== spec.recipeId) {
      throw new AppError(409, 'CONDITION_MISMATCH', `运行批次已切换到配方 ${segment.recipeId},与模型规格 ${spec.recipeId} 不一致;旧计划失效`)
    }
    if (segment.recipeVersion !== 0 && segment.recipeVersion !== spec.recipeVersion) {
      throw new AppError(409, 'CONDITION_MISMATCH', `运行批次配方版本 v${segment.recipeVersion} 与模型规格 v${spec.recipeVersion} 不一致;旧计划失效`)
    }
  }
  return matchCondition(spec.conditions, {
    lineId: spec.lineId, productId: spec.productId, recipeId: spec.recipeId, recipeVersion: spec.recipeVersion,
  })
}

/** 运行批次开段(线开跑时调用):冻结配方内容 hash 与版本。 */
export function openContextSegment(run: { id: string, lineId: string, recipeId: string, startedAt: string, recipeVersion?: number, paramsSnapshot?: unknown }): void {
  const recipe = getDcwRecipeRepo().byId(run.recipeId)
  const version = run.recipeVersion ?? recipe?.version ?? 0
  const hash = recipe
    ? recipeContentHash(recipe, run.paramsSnapshot)
    : recipeContentHash({ id: run.recipeId, version })
  getContextSegmentRepo().insert({
    lineId: run.lineId,
    runId: run.id,
    fromTs: Date.parse(run.startedAt),
    toTs: null,
    recipeId: run.recipeId,
    recipeVersion: version,
    recipeContentHash: hash,
    conditionId: '',
    source: 'line_run',
    confirmed: true,
  })
}

/** 运行批次关段(线停止时调用)。 */
export function closeContextSegment(runId: string, atMs?: number): void {
  getContextSegmentRepo().close(runId, atMs ?? Date.now())
}
