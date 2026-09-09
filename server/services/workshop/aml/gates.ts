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

export interface PlatformMetrics {
  oneStepVal?: { windows: number, nrmse: number } | null
  oneStepTest?: { windows: number, nrmse: number } | null
  rolloutTest?: { windows: number, nrmse: number, horizon: number } | null
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
  manifest: Pick<AmlManifest, 'split'>,
  metrics: PlatformMetrics | undefined,
  artifactsDir: string,
): GateReport {
  const g = amlSettings().gates
  const checks: GateCheck[] = []

  const testNrmse = metrics?.oneStepTest?.nrmse
  checks.push({
    id: 'G1',
    name: '单步精度(测试集 NRMSE)',
    value: numOrNull(testNrmse),
    threshold: g.nrmse,
    pass: testNrmse !== undefined && testNrmse !== null && testNrmse <= g.nrmse,
    detail: testNrmse == null ? 'metrics 缺少 platform.oneStepTest(评估器未产出)' : `实测 ${testNrmse.toFixed(4)} / 上限 ${g.nrmse}`,
  })

  if (purpose === 'mpc_surrogate') {
    const roll = metrics?.rolloutTest?.nrmse
    checks.push({
      id: 'G2',
      name: `多步滚动精度(horizon=${metrics?.rolloutTest?.horizon ?? '?'} NRMSE)`,
      value: numOrNull(roll),
      threshold: g.rolloutNrmse,
      pass: roll !== undefined && roll !== null && roll <= g.rolloutNrmse,
      detail: roll == null ? 'metrics 缺少 platform.rolloutTest' : `实测 ${roll.toFixed(4)} / 上限 ${g.rolloutNrmse}`,
    })
  }

  const val = metrics?.oneStepVal?.nrmse
  // mpc_surrogate 下 G3 恒入列:val 缺失/切分为空一律不通过(防 valRatio:0 静默绕过泛化门)
  if (purpose === 'mpc_surrogate' || (val != null && testNrmse != null)) {
    const gap = val != null && testNrmse != null && val > 1e-9
      ? Math.abs(testNrmse - val) / Math.abs(val)
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

  const runsOk = dataset.runIds.length >= g.minRuns
  checks.push({
    id: 'G4',
    name: '数据覆盖(行数/批次数)',
    value: dataset.runIds.length,
    threshold: g.minRuns,
    pass: dataset.rowCount >= g.minRows && runsOk,
    detail: `${dataset.rowCount} 行(≥${g.minRows});${dataset.runIds.length} 批次(≥${g.minRuns})`,
  })

  // G5:契约工件存在(模型文件或 STUB 标记);加载验证由注册时 predictor 深检兜底
  const onnxPath = join(artifactsDir, 'model.onnx')
  const stubPath = join(artifactsDir, 'STUB')
  const hasOnnx = existsSync(onnxPath)
  let g5pass = false
  let g5detail: string
  if (hasOnnx) {
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
  checks.push({ id: 'G5', name: '工件完整(契约 ONNX)', value: null, threshold: null, pass: g5pass, detail: g5detail })

  return { passed: checks.every(c => c.pass), checks }
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}
