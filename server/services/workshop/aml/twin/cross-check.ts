/**
 * 下发前双通道互审(科学探索计划 P5,docs/plans/2026-11-02-scientific-exploration-plan.md):
 *  - 通道 A(模型):AML 代理模型对拟下发 Δ 的稳态增益(ARX 用阶跃仿真;无模型 = unknown);
 *  - 通道 B(本体/机理):已发布本体的 actuator→target 耦合断言(有路径/明确无路径/无声明)。
 * 三值逻辑,只有**确证冲突**才拦(unknown 不拦 —— 缺证据不是反证):
 *   A 有效应 & B 明确无路径 → conflict(自动模式拒;人工模式必须写明理由)
 *   A 无效应 & B 断言有路径   → conflict(同规则)
 *   UQ 拒收(OOD/覆盖率低)    → require_human(auto 模式下拒)
 *   可辨识性欠功效/混杂       → allow_with_warning(卡片写明"当前步幅不构成可分辨干预")
 * 输出科学载荷(审批卡自动填):效应估计/CI/MDE/动作覆盖/证据边/可证伪方式。
 */
import { arxStepResponseGain, type ArxArtifactLike, type ActionCoverage } from '../action-coverage'

export interface ModelChannelInput {
  /** null = 无可用模型/工件不支持 */
  artifact: ArxArtifactLike | null
  targetNodeId: string
  /** UQ/OOD 结论(来自 uq-ood.evaluateEnsemble;无模型时省略) */
  uq?: { accepted: boolean, rejectCode?: string }
}

export interface OntologyChannelInput {
  /** true=存在 actuator→target 耦合路径;false=本体**明确断言无耦合**;null=本体未声明(unknown) */
  hasCouplingPath: boolean | null
  /** 支撑边/证据的人类可读摘要(进审批卡) */
  evidence: string[]
}

export interface IdentifiabilityInputSummary {
  verdict: string
  effect?: number | null
  ciLow?: number | null
  ciHigh?: number | null
  mde?: number | null
}

export interface ScientificPayload {
  controlNodeId: string
  targetNodeId: string
  proposedDelta: number
  /** 模型侧预测的稳态变化(物理单位;unknown → null) */
  modelEffect: number | null
  modelConverged: boolean
  ontologyHasCouplingPath: boolean | null
  identifiabilityVerdict: string | null
  effectEstimate: number | null
  ciLow: number | null
  ciHigh: number | null
  mde: number | null
  actionCoverage: Pick<ActionCoverage, 'distinctLevels' | 'collinearityWithTime' | 'monolithicSequence'> | null
  evidenceEdges: string[]
  /** 该结论的可证伪方式(机器可读 + 人读) */
  falsificationMethod: string
}

export type CrossCheckDecision = 'allow' | 'allow_with_warning' | 'require_human' | 'reject'

export interface CrossCheckResult {
  decision: CrossCheckDecision
  conflicts: string[]
  warnings: string[]
  payload: ScientificPayload
}

export interface CrossCheckInput {
  controlNodeId: string
  targetNodeId: string
  proposedDelta: number
  /** 自动模式下冲突/需人审是否直接拒(auto=true 时 require_human → reject) */
  auto: boolean
  model?: ModelChannelInput
  ontology?: OntologyChannelInput
  identifiability?: IdentifiabilityInputSummary
  actionCoverage?: ActionCoverage
  /** 判定"有效应"的增益下限(物理单位/单位Δ);缺省 1e-9 */
  minGain?: number
}

/**
 * 三值互审判定(纯函数)。冲突判据:
 *  - 模型通道:converged 且 |gain×Δ| > minGain → 认为模型预测"有效应";
 *    否则(收敛但增益≈0)→ 预测"无效应";未收敛/无模型 → unknown(不参与冲突)
 *  - 本体通道:hasCouplingPath true/false/null
 * 只有 (有效应 & 明确无路径) 或 (无效应 & 明确有路径) 才 conflict。
 */
export function evaluateCrossCheck(input: CrossCheckInput): CrossCheckResult {
  const minGain = input.minGain ?? 1e-9
  const conflicts: string[] = []
  const warnings: string[] = []

  let modelEffect: number | null = null
  let modelConverged = false
  let modelHasEffect: boolean | null = null
  if (input.model?.artifact) {
    const sensitivity = arxStepResponseGain(input.model.artifact, input.controlNodeId)
    if (sensitivity) {
      modelConverged = sensitivity.converged
      if (sensitivity.converged) {
        const gain = sensitivity.gains[input.model.targetNodeId]
        if (typeof gain === 'number' && Number.isFinite(gain)) {
          modelEffect = gain * input.proposedDelta
          modelHasEffect = Math.abs(gain) > minGain
        }
      }
    }
  }

  const onto = input.ontology ?? { hasCouplingPath: null, evidence: [] }
  if (modelHasEffect === true && onto.hasCouplingPath === false) {
    conflicts.push(`模型预测有效应(Δy≈${modelEffect?.toPrecision(4)})但本体明确断言 ${input.controlNodeId}→${input.targetNodeId} 无耦合路径`)
  }
  if (modelHasEffect === false && onto.hasCouplingPath === true) {
    conflicts.push(`模型预测无可分辨效应但本体断言存在耦合路径(${onto.evidence[0] ?? '无证据摘要'}):模型可能未学到该动作维度,先查 G6 动作覆盖`)
  }
  if (input.model?.uq && !input.model.uq.accepted) {
    warnings.push(`模型 UQ/OOD 未通过(${input.model.uq.rejectCode ?? 'unknown'}):预测不可作为下发依据`)
    if (input.auto) conflicts.push('UQ/OOD 未通过,自动模式拒绝;请转人工审批或先补充标定')
  }

  const v = input.identifiability
  if (v && (v.verdict === 'UNDERPOWERED' || v.verdict === 'CONFOUNDED')) {
    warnings.push(`可辨识性 ${v.verdict}:当前步幅/窗口不足以分辨效应${v.mde != null ? `(MDE=${v.mde.toPrecision(3)})` : ''};卡片请写明"不构成可分辨干预"`)
  }

  const coverage = input.actionCoverage
  const payload: ScientificPayload = {
    controlNodeId: input.controlNodeId,
    targetNodeId: input.targetNodeId,
    proposedDelta: input.proposedDelta,
    modelEffect,
    modelConverged,
    ontologyHasCouplingPath: onto.hasCouplingPath,
    identifiabilityVerdict: v?.verdict ?? null,
    effectEstimate: v?.effect ?? null,
    ciLow: v?.ciLow ?? null,
    ciHigh: v?.ciHigh ?? null,
    mde: v?.mde ?? null,
    actionCoverage: coverage
      ? { distinctLevels: coverage.distinctLevels, collinearityWithTime: coverage.collinearityWithTime, monolithicSequence: coverage.monolithicSequence }
      : null,
    evidenceEdges: onto.evidence,
    falsificationMethod: buildFalsificationMethod(input, modelHasEffect),
  }

  let decision: CrossCheckDecision
  if (conflicts.length > 0) decision = input.auto ? 'reject' : 'require_human'
  else if (warnings.length > 0) decision = input.auto ? 'require_human' : 'allow_with_warning'
  else decision = 'allow'
  if (decision === 'require_human' && input.auto) decision = 'reject'

  return { decision, conflicts, warnings, payload }
}

/** 可证伪方式:写清楚"什么结果会推翻这次下发" */
export function buildFalsificationMethod(input: CrossCheckInput, modelHasEffect: boolean | null): string {
  const delta = input.proposedDelta
  const parts = [
    `对 ${input.controlNodeId} 的干预若在响应窗(≥3 个主导扰动周期)内使 ${input.targetNodeId} 的变化量 95% CI 不含 0 且方向与模型预测(${modelHasEffect === true ? '有' : modelHasEffect === false ? '无' : '未知'}效应)不一致,则本次因果断言被否证`,
    `比较基准 = 干预前同长窗口;置信区间用 bootstrap(种子固定可复现)`,
    `Δ控制=${delta} 的效应若小于 MDE,结论只能记为"不可辨识",不得外推`,
  ]
  if (input.ontology?.hasCouplingPath === false) parts.push('本体无耦合断言与实测有效应冲突时,以实测为准并回灌本体证据(需人工确认版本)')
  return parts.join(';')
}

/** 审批卡人读段落(与 payload 同源;detail 文本 + 结构化载荷双通道) */
export function scientificPayloadLines(payload: ScientificPayload): string[] {
  const fmt = (x: number | null): string => (x != null && Number.isFinite(x) ? x.toPrecision(4) : '—')
  return [
    `[科学依据] 模型预测:${payload.modelEffect == null ? '无可用模型(unknown)' : `Δy≈${fmt(payload.modelEffect)}${payload.modelConverged ? '' : '(未收敛)'}`}`,
    `[科学依据] 本体耦合:${payload.ontologyHasCouplingPath == null ? '未声明' : payload.ontologyHasCouplingPath ? `存在路径(${payload.evidenceEdges.slice(0, 2).join(' / ') || '无证据摘要'})` : '明确无耦合路径'}`,
    `[科学依据] 可辨识性:${payload.identifiabilityVerdict ?? '未评估'}${payload.mde != null ? `;MDE=${fmt(payload.mde)}` : ''}${payload.effectEstimate != null ? `;上次效应 ${fmt(payload.effectEstimate)} CI[${fmt(payload.ciLow)}, ${fmt(payload.ciHigh)}]` : ''}`,
    payload.actionCoverage ? `[科学依据] 动作覆盖:水平 ${payload.actionCoverage.distinctLevels} 个,时间共线 |r|=${payload.actionCoverage.collinearityWithTime.toFixed(3)}${payload.actionCoverage.monolithicSequence ? '(纯阶梯,与时间不可分)' : ''}` : null,
    `[可证伪] ${payload.falsificationMethod}`,
  ].filter((x): x is string => x != null)
}
