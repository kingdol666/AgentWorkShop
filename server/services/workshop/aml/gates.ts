/**
 * AML 评测门(平台判定,不采信 Agent 自报;阈值来自 amlSettings().gates,live 可调)。
 *  - mpc_surrogate:G1 单步 NRMSE / G2 多步滚动 NRMSE / G3 泛化差 / G4 数据覆盖 / G5 工件完整
 *  - quality_predict:G1/G3/G4/G5(无滚动语义)
 */
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { amlSettings } from '../settings'
import type { AmlManifest } from './dataset-builder'
import type { AmlDatasetRow } from './aml.repo'
import { assessDatasetActionCoverage } from './action-coverage'

export interface PlatformMetrics {
  oneStepVal?: { windows: number, nrmse: number } | null
  oneStepTest?: { windows: number, nrmse: number } | null
  rolloutTest?: { windows: number, nrmse: number, horizon: number } | null
  /** 新工件类型分派(G1.2):linear_state_space@1 / static_response@1 / onnx_one_step@1 / hybrid_manifest@1 */
  artifactKind?: string
  modelKind?: string
  /** 多步相对持值基线改善(A3:新模型 ≥20%) */
  rolloutImprovement?: number
  persistenceNrmse?: number
}

export interface GateCheck {
  id: string
  name: string
  value: number | null
  threshold: number | null
  pass: boolean
  detail: string
}

export interface GateReport {
  passed: boolean
  checks: GateCheck[]
}

export function evaluateGates(
  purpose: string,
  dataset: Pick<AmlDatasetRow, 'rowCount' | 'runIds'>,
  manifest: Pick<AmlManifest, 'split' | 'actionCoverage'>,
  metrics: PlatformMetrics | undefined,
  artifactsDir: string,
): GateReport {
  const g = amlSettings().gates
  const checks: GateCheck[] = []
  const artifactKind = metrics?.artifactKind ?? (existsSync(join(artifactsDir, 'model.json')) ? 'linear_state_space@1' : 'onnx_one_step@1')
  const isStatic = artifactKind === 'static_response@1'
  const isLinear = artifactKind === 'linear_state_space@1'

  const testNrmse = metrics?.oneStepTest?.nrmse
  const hasTest = manifest.split.test > 0 && (metrics?.oneStepTest?.windows ?? 0) > 0 && numOrNull(testNrmse) != null && testNrmse! >= 0
  checks.push({
    id: 'G1',
    name: '单步精度(测试集 NRMSE)',
    value: numOrNull(testNrmse),
    threshold: g.nrmse,
    pass: hasTest && testNrmse! <= g.nrmse,
    detail: !hasTest ? '缺少非空独立测试集或有效 platform.oneStepTest 指标' : `实测 ${testNrmse!.toFixed(4)} / 上限 ${g.nrmse}(${artifactKind})`,
  })

  if (isLinear) {
    // 新模型:多步相对持值基线改善(A3 ≥20%),而不是旧 NN 的绝对 0.25 阈值。
    const improvement = metrics?.rolloutImprovement
    const roll = metrics?.rolloutTest?.nrmse
    checks.push({
      id: 'G2',
      name: `多步相对持值基线改善(horizon=${metrics?.rolloutTest?.horizon ?? '?'})`,
      value: numOrNull(improvement),
      threshold: 0.2,
      pass: hasTest && (metrics?.rolloutTest?.windows ?? 0) > 0 && numOrNull(roll) != null && roll! >= 0 && numOrNull(improvement) != null && improvement! >= 0.2,
      detail: improvement == null
        ? 'metrics 缺少 rolloutImprovement'
        : `改善 ${(improvement * 100).toFixed(1)}% / 下限 20%(rollout=${roll?.toFixed(4) ?? '?'}, 持值=${metrics?.persistenceNrmse?.toFixed(4) ?? '?'})`,
    })
  }
  else if (purpose === 'mpc_surrogate' && !isStatic) {
    const roll = metrics?.rolloutTest?.nrmse
    checks.push({
      id: 'G2',
      name: `多步滚动精度(horizon=${metrics?.rolloutTest?.horizon ?? '?'} NRMSE)`,
      value: numOrNull(roll),
      threshold: g.rolloutNrmse,
      pass: hasTest && (metrics?.rolloutTest?.windows ?? 0) > 0 && numOrNull(roll) != null && roll! >= 0 && roll! <= g.rolloutNrmse,
      detail: roll == null ? 'metrics 缺少 platform.rolloutTest' : `实测 ${roll.toFixed(4)} / 上限 ${g.rolloutNrmse}`,
    })
  }

  const val = metrics?.oneStepVal?.nrmse
  // 静态模型按"独立稳定段/批次"评估留出误差,不做 val/test 泛化差(计划 §3.5)
  if (!isStatic && (purpose === 'mpc_surrogate' || (val != null && testNrmse != null))) {
    const gap = hasTest && manifest.split.val > 0 && (metrics?.oneStepVal?.windows ?? 0) > 0 && val != null && numOrNull(val) != null && val >= 0 && testNrmse != null
      ? Math.abs(testNrmse - val) / Math.max(1e-9, Math.abs(val))
      : null
    checks.push({
      id: 'G3',
      name: '泛化一致(|test−val|/val)',
      value: numOrNull(gap),
      threshold: g.valTestGap,
      pass: gap != null && gap <= g.valTestGap,
      detail: gap == null
        ? (manifest.split.val === 0 ? 'val 切分为空(批次数不足或 valRatio=0,无法校验泛化)' : 'metrics 缺少 val 指标')
        : `实测 ${(gap * 100).toFixed(1)}% / 上限 ${(g.valTestGap * 100).toFixed(0)}%`,
    })
  }

  // G4:数据覆盖。单长 run 用合法隔离时间切分时,以 train/val/test 三段非空替代批次门
  // (计划 §3.5:不能把重叠窗口当独立试验,也不能用旧 minRuns 误杀合法切分)。
  const isolatedSplit = (isLinear || isStatic) && manifest.split.train > 0 && manifest.split.val > 0 && manifest.split.test > 0
  const runsOk = dataset.runIds.length >= g.minRuns || isolatedSplit
  checks.push({
    id: 'G4',
    name: '数据覆盖(行数/批次数)',
    value: dataset.runIds.length,
    threshold: g.minRuns,
    pass: dataset.rowCount >= g.minRows && runsOk,
    detail: `${dataset.rowCount} 行(≥${g.minRows});${dataset.runIds.length} 批次(≥${g.minRuns}${isolatedSplit ? ',单长 run 隔离切分已生效' : ''})`,
  })

  // G5:契约工件存在(按 artifactKind 分派;加载验证由注册时深检兜底)
  const onnxPath = join(artifactsDir, 'model.onnx')
  const jsonPath = join(artifactsDir, 'model.json')
  const stubPath = join(artifactsDir, 'STUB')
  let g5pass = false
  let g5detail: string
  if (isLinear || isStatic) {
    if (existsSync(jsonPath)) {
      let size = 0
      try {
        size = statSync(jsonPath).size
      }
      catch { /* 探测失败按缺失 */ }
      g5pass = size > 0
      g5detail = `model.json(${(size / 1024).toFixed(1)}KB,${artifactKind})`
    }
    else {
      g5detail = `artifacts/model.json 缺失(${artifactKind})`
    }
  }
  else if (existsSync(onnxPath)) {
    let size = 0
    try {
      size = statSync(onnxPath).size
    }
    catch { /* 探测失败按缺失 */ }
    g5pass = size > 0
    g5detail = g5pass ? `model.onnx(${(size / 1024).toFixed(1)}KB)` : 'model.onnx 为空文件'
  }
  else if (existsSync(stubPath)) {
    g5pass = true
    g5detail = 'STUB 存根工件(无真实模型,不可用于预测服务)'
  }
  else {
    g5detail = 'artifacts/model.onnx 缺失'
  }
  checks.push({ id: 'G5', name: '工件完整(按工件类型)', value: null, threshold: null, pass: g5pass, detail: g5detail })

  // G6:动作覆盖度(科学探索计划 P3)。回答"这份数据在动作维度有没有信息量":
  // 水平数不足 → 模型学不到动作;与时间共线 → 学到的"效应"可能只是漂移。
  // v1 数据集无 actionCoverage 字段 = unknown(不追溯误杀,detail 如实说明)。
  const coverage = manifest.actionCoverage
  if (coverage === undefined) {
    checks.push({
      id: 'G6',
      name: '动作覆盖(控制水平数/时间共线)',
      value: null,
      threshold: null,
      pass: true,
      detail: '数据集未携带动作覆盖度(v1 数据集/unknown):门禁不追溯,重建数据集(v2)后强制校验',
    })
  }
  else if (coverage.length === 0) {
    checks.push({
      id: 'G6',
      name: '动作覆盖(控制水平数/时间共线)',
      value: null,
      threshold: null,
      pass: true,
      detail: '数据集未声明 role=control 节点:动作覆盖门不适用(纯预测器,不可用于控制决策)',
    })
  }
  else {
    const assessment = assessDatasetActionCoverage(coverage, {
      minControlLevels: g.minControlLevels,
      maxCollinearity: g.maxCollinearity,
    })
    const minLevels = Math.min(...coverage.map(c => c.distinctLevels))
    const maxR = Math.max(...coverage.map(c => c.collinearityWithTime))
    checks.push({
      id: 'G6',
      name: '动作覆盖(控制水平数/时间共线)',
      value: minLevels,
      threshold: g.minControlLevels,
      pass: assessment.pass,
      detail: assessment.pass
        ? `${coverage.length} 个控制节点,最少 ${minLevels} 个水平(≥${g.minControlLevels}),时间共线 max |r|=${maxR.toFixed(3)}(≤${g.maxCollinearity})`
        : assessment.reasons.join(';'),
    })
  }

  return { passed: checks.every(c => c.pass), checks }
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}
