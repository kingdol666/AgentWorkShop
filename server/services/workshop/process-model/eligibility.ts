/**
 * 资格评估(A2 / plan §3.3):
 *   predictionEligible 与 optimizationEligible 分开,带 simulation/real 作用域。
 *
 * 硬规则:
 *  - U 恒定、Y 波动再大也不能通过优化资格;
 *  - MV 与扰动混杂 / 多输入共线 → 辨识不足,只能预测;
 *  - 动作失败 / 仅 ACK / 时间未知 → 不能获得优化资格;
 *  - 不足以"具体缺口 + 模拟试验建议"返回,绝不伪造激励样本。
 */
import type { DatabaseSync } from 'node:sqlite'
import { AppError } from '../../../utils/errors'
import type { EligibilityGap, EligibilityReport, ProcessModelSpec } from './contracts'
import { getAmlRuntime } from '../aml/runtime'

export type ActionEvidence = 'observed' | 'simulation_commanded' | 'ack_only' | 'failed' | 'unknown'

export interface EligibilitySeries {
  variableId: string
  role: 'mv' | 'cv' | 'md' | 'feature'
  values: number[]
  states?: string[]
}

export interface EligibilityInput {
  spec: ProcessModelSpec
  scope: 'simulation' | 'real'
  conditionId: string
  series: EligibilitySeries[]
  actionEvidence: ActionEvidence
  /** 训练/评估产物指标(可选;缺省不评预测性能门) */
  metrics?: { oneStepNrmse?: number, rolloutNrmse?: number, persistenceNrmse?: number }
  sampleCount?: number
  runCount?: number
  evidenceVersion?: string
}

const MIN_SAMPLES = 50
const MIN_DISTINCT_CHANGES = 3
const MIN_VARIATION_RATIO = 0.02
const MAX_COLLINEARITY = 0.95
const MIN_DELAYED_CORR = 0.2

function finite(values: number[]): number[] {
  return values.filter(v => Number.isFinite(v))
}

function pearson(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length)
  if (n < 3) return 0
  let ma = 0
  let mb = 0
  for (let i = 0; i < n; i++) {
    ma += a[i]!
    mb += b[i]!
  }
  ma /= n
  mb /= n
  let num = 0
  let da = 0
  let db = 0
  for (let i = 0; i < n; i++) {
    const x = a[i]! - ma
    const y = b[i]! - mb
    num += x * y
    da += x * x
    db += y * y
  }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0
}

export function diff(values: number[]): number[] {
  const out: number[] = []
  for (let i = 1; i < values.length; i++) out.push(values[i]! - values[i - 1]!)
  return out
}

/** 计划写明"变化后的可观测延迟响应":取 1..maxLag 步滞后互相关峰值。 */
export function laggedCorrelation(input: number[], response: number[], maxLag: number): { lag: number, corr: number } {
  const di = diff(input)
  const dr = diff(response)
  let best = { lag: 0, corr: 0 }
  for (let lag = 1; lag <= maxLag; lag++) {
    if (di.length <= lag + 2) break
    const corr = pearson(di.slice(0, di.length - lag), dr.slice(lag))
    if (Math.abs(corr) > Math.abs(best.corr)) best = { lag, corr }
  }
  return best
}

export function evaluateEligibility(input: EligibilityInput): EligibilityReport {
  const gaps: EligibilityGap[] = []
  const mv = input.series.filter(s => s.role === 'mv')
  const cv = input.series.filter(s => s.role === 'cv')
  const md = input.series.filter(s => s.role === 'md')
  const metrics: Record<string, number | string | boolean | null> = {}
  const evidenceVersion = input.evidenceVersion ?? `elig-${Date.now()}`

  if (!mv.length) gaps.push({ code: 'NO_MV', message: '没有可调设定值(MV)变量;无法构成优化问题' })
  if (!cv.length) gaps.push({ code: 'NO_CV', message: '没有质量目标(CV)变量;无法评价优化收益' })

  const lengths = input.series.map(s => s.values.length)
  const sampleCount = input.sampleCount ?? (lengths.length ? Math.min(...lengths) : 0)
  metrics.sampleCount = sampleCount
  if (sampleCount < MIN_SAMPLES) {
    gaps.push({ code: 'INSUFFICIENT_SAMPLES', message: `有效样本 ${sampleCount} < ${MIN_SAMPLES}`, detail: { sampleCount } })
  }
  if (input.runCount != null && input.runCount < 1) {
    gaps.push({ code: 'NO_RUNS', message: '没有已完结批次可用于训练/验证' })
  }

  // ---- MV 激励与覆盖 ----
  const mvVariation: Record<string, number> = {}
  const mvChanges: Record<string, number> = {}
  let anyMvVaries = false
  for (const series of mv) {
    const vals = finite(series.values)
    const range = input.spec.effectiveDomain.mv[series.variableId]
    const span = range ? range.max - range.min : 0
    const lo = vals.length ? Math.min(...vals) : 0
    const hi = vals.length ? Math.max(...vals) : 0
    const ratio = span > 0 ? (hi - lo) / span : 0
    // 有效变化次数:|Δ| > max(绝对噪声下限, 1% 量程)
    const threshold = Math.max(1e-9, span * 0.01)
    const changes = diff(vals).filter(d => Math.abs(d) > threshold).length
    mvVariation[series.variableId] = ratio
    mvChanges[series.variableId] = changes
    metrics[`mvVariation.${series.variableId}`] = Number(ratio.toFixed(6))
    metrics[`mvChanges.${series.variableId}`] = changes
    if (ratio >= MIN_VARIATION_RATIO && changes >= 1) anyMvVaries = true
    if (ratio < MIN_VARIATION_RATIO) {
      gaps.push({
        code: 'MV_CONSTANT',
        message: `MV ${series.variableId} 在窗口内几乎不变(覆盖 ${(ratio * 100).toFixed(1)}% 量程);恒定输入无法识别参数作用`,
        detail: { variableId: series.variableId, variationRatio: ratio },
      })
    }
    if (changes < MIN_DISTINCT_CHANGES) {
      gaps.push({
        code: 'MV_INSUFFICIENT_EXCITATION',
        message: `MV ${series.variableId} 有效变化仅 ${changes} 次(< ${MIN_DISTINCT_CHANGES});建议做阶跃/多水平参数试验`,
        detail: { variableId: series.variableId, changes },
      })
    }
  }

  // ---- 多输入共线 ----
  let maxCollinearity = 0
  for (let i = 0; i < mv.length; i++) {
    for (let j = i + 1; j < mv.length; j++) {
      const corr = Math.abs(pearson(diff(mv[i]!.values), diff(mv[j]!.values)))
      maxCollinearity = Math.max(maxCollinearity, corr)
      if (corr > MAX_COLLINEARITY) {
        gaps.push({
          code: 'INPUT_COLLINEAR',
          message: `MV ${mv[i]!.variableId} 与 ${mv[j]!.variableId} 同步变化(|corr|=${corr.toFixed(3)});无法区分各自作用`,
          detail: { a: mv[i]!.variableId, b: mv[j]!.variableId, corr },
        })
      }
    }
  }
  metrics.maxMvCollinearity = Number(maxCollinearity.toFixed(6))

  // ---- 扰动混杂 ----
  let maxConfounding = 0
  for (const mvSeries of mv) {
    for (const mdSeries of md) {
      const corr = Math.abs(pearson(diff(mvSeries.values), diff(mdSeries.values)))
      maxConfounding = Math.max(maxConfounding, corr)
      if (corr > 0.9) {
        gaps.push({
          code: 'CONFOUNDED_DISTURBANCE',
          message: `MV ${mvSeries.variableId} 与扰动 ${mdSeries.variableId} 完全混杂(|corr|=${corr.toFixed(3)});不能把效果归因于调参`,
          detail: { mv: mvSeries.variableId, md: mdSeries.variableId, corr },
        })
      }
    }
  }
  metrics.maxDisturbanceConfounding = Number(maxConfounding.toFixed(6))

  // ---- 延迟响应可观测 ----
  const maxDelaySteps = Math.max(1, ...mv.map((s) => {
    const variable = input.spec.variables.find(v => v.id === s.variableId)
    return Math.ceil((variable?.delayMs ?? 0) / input.spec.timing.beatMs) + 3
  }))
  let bestResponse: { mv: string, cv: string, lag: number, corr: number } | null = null
  for (const mvSeries of mv) {
    for (const cvSeries of cv) {
      const hit = laggedCorrelation(mvSeries.values, cvSeries.values, maxDelaySteps)
      if (!bestResponse || Math.abs(hit.corr) > Math.abs(bestResponse.corr)) {
        bestResponse = { mv: mvSeries.variableId, cv: cvSeries.variableId, lag: hit.lag, corr: hit.corr }
      }
    }
  }
  if (bestResponse) {
    metrics.bestDelayedResponse = Number(bestResponse.corr.toFixed(6))
    metrics.bestDelayedResponseLag = bestResponse.lag
    metrics.bestDelayedResponsePair = `${bestResponse.mv}->${bestResponse.cv}`
    // 延迟响应只对动态辨识是必要条件;静态响应面不需要"MV 变化后滞后可见",
    // 用动态门槛会误杀 static_response 场景(A11 要求静态场景可资格评估/求解)。
    if (input.spec.trainer.ref === 'linear_arx@1' && anyMvVaries && Math.abs(bestResponse.corr) < MIN_DELAYED_CORR) {
      gaps.push({
        code: 'NO_OBSERVABLE_DELAYED_RESPONSE',
        message: `MV 变化后未见可观测的延迟响应(最大滞后相关 ${bestResponse.corr.toFixed(3)} < ${MIN_DELAYED_CORR})`,
        detail: { ...bestResponse },
      })
    }
  }

  // ---- 动作证据 ----
  metrics.actionEvidence = input.actionEvidence
  if (input.actionEvidence === 'unknown') {
    gaps.push({ code: 'ACTION_EVIDENCE_UNKNOWN', message: '历史输入缺少请求/生效/回读时间证据;不能作为优化资格样本(可继续用于预测训练)' })
  }
  else if (input.actionEvidence === 'ack_only') {
    gaps.push({ code: 'ACTION_ACK_ONLY', message: '只有传输 ACK,没有生效/回读证据;不能宣称参数已生效' })
  }
  else if (input.actionEvidence === 'failed') {
    gaps.push({ code: 'ACTION_FAILED', message: '关联动作失败;该窗口不能进入干预资格样本' })
  }

  // ---- 多步预测质量(有指标才评)----
  if (input.metrics?.rolloutNrmse != null && input.metrics.persistenceNrmse != null && input.metrics.persistenceNrmse > 0) {
    const improvement = 1 - input.metrics.rolloutNrmse / input.metrics.persistenceNrmse
    metrics.rolloutImprovement = Number(improvement.toFixed(6))
    if (improvement < 0.2) {
      gaps.push({
        code: 'POOR_MULTISTEP',
        message: `多步 RMSE 相对持值基线仅改善 ${(improvement * 100).toFixed(1)}%(< 20%);模型不足以支撑优化`,
        detail: { improvement },
      })
    }
  }

  const predictionEligible = !gaps.some(g => ['INSUFFICIENT_SAMPLES', 'NO_RUNS', 'NO_MV', 'NO_CV'].includes(g.code))
  const optimizationEligible = predictionEligible && gaps.length === 0 && anyMvVaries

  // 明确反例:U 恒定但 Y 大波动 → 只允许预测
  if (!anyMvVaries && gaps.some(g => g.code === 'MV_CONSTANT')) {
    gaps.push({ code: 'OPTIMIZATION_BLOCKED_BY_EXCITATION', message: '输入无有效激励(即使输出波动很大);优化资格不成立,建议先做模拟参数试验' })
  }

  return {
    predictionEligible,
    optimizationEligible,
    scope: input.scope,
    conditionId: input.conditionId,
    evidenceVersion,
    gaps,
    metrics,
    createdAt: new Date().toISOString(),
  }
}

export function createEligibilityRepo(db: DatabaseSync) {
  return {
    /** D20:资格行显式携带 dataset 谱系(dataset_id+hash);latest 按谱系查询,不再裸取 spec 最新 */
    save(specId: string, specVersion: number, report: EligibilityReport, lineage?: { datasetId: string, datasetHash: string }): string {
      const id = `elig-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
      db.prepare(`INSERT INTO process_model_eligibility
        (id, spec_id, spec_version, scope, condition_id, prediction_eligible, optimization_eligible, report_json, evidence_version, created_at, dataset_id, dataset_hash)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, specId, specVersion, report.scope, report.conditionId, report.predictionEligible ? 1 : 0,
          report.optimizationEligible ? 1 : 0, JSON.stringify(report), report.evidenceVersion, report.createdAt,
          lineage?.datasetId ?? '', lineage?.datasetHash ?? '')
      return id
    },
    /** 谱系精确查询:datasetId 非空时只返回该数据集的资格报告(D20;旧数据无谱系 → 仅当 allowLegacy 才回退) */
    latestForDataset(specId: string, datasetId: string): EligibilityReport | null {
      const row = db.prepare(`SELECT report_json FROM process_model_eligibility
        WHERE spec_id = ? AND dataset_id = ? ORDER BY created_at DESC LIMIT 1`).get(specId, datasetId) as { report_json: string } | undefined
      return row ? JSON.parse(row.report_json) as EligibilityReport : null
    },
    latest(specId: string): EligibilityReport | null {
      const row = db.prepare('SELECT report_json FROM process_model_eligibility WHERE spec_id = ? ORDER BY created_at DESC LIMIT 1').get(specId) as { report_json: string } | undefined
      return row ? JSON.parse(row.report_json) as EligibilityReport : null
    },
    list(specId: string, limit = 20): EligibilityReport[] {
      return (db.prepare('SELECT report_json FROM process_model_eligibility WHERE spec_id = ? ORDER BY created_at DESC LIMIT ?').all(specId, limit) as Array<{ report_json: string }>)
        .map(r => JSON.parse(r.report_json) as EligibilityReport)
    },
    /** D20 撤销:删除某数据集的全部资格行(撤销传播到所有使用者) */
    revokeForDataset(datasetId: string): number {
      return Number(db.prepare('DELETE FROM process_model_eligibility WHERE dataset_id = ?').run(datasetId).changes)
    },
  }
}

export type EligibilityRepo = ReturnType<typeof createEligibilityRepo>

const g = globalThis as typeof globalThis & { __processModelEligibilityRepo?: EligibilityRepo }

export function getEligibilityRepo(): EligibilityRepo {
  g.__processModelEligibilityRepo ??= createEligibilityRepo(getAmlRuntime().db)
  return g.__processModelEligibilityRepo
}

export function assertOptimizationEligible(report: EligibilityReport | null): EligibilityReport {
  if (!report) throw new AppError(409, 'ELIGIBILITY_MISSING', '该模型没有资格报告;先运行资格评估')
  if (!report.optimizationEligible) {
    const detail = report.gaps.map(g => g.message).join('; ')
    throw new AppError(422, 'OPTIMIZATION_NOT_ELIGIBLE', `不具备优化资格:${detail}`)
  }
  return report
}
