import { sha256 } from './contracts'

export interface EnsembleEvaluation {
  predictions: Array<Record<string, number>>
  targets?: Record<string, number>
  calibrationCoverage?: number
  calibrationSetHash?: string
  inputDistance?: number
}

export interface UqOodResult {
  maxStd: number
  coverage: number
  ensembleSize: number
  distance: number
  disagreement: number
  accepted: boolean
  rejectCode?: 'UQ_COVERAGE_LOW' | 'OOD_DISTANCE_HIGH' | 'ENSEMBLE_DISAGREEMENT_HIGH' | 'CALIBRATION_STALE'
  calibrationSetHash?: string
  inputDistance?: number
}

export function evaluateEnsemble(input: EnsembleEvaluation, policy: {
  coverageTarget: number
  distanceThreshold: number
  disagreementThreshold: number
  calibrationFresh: boolean
  inputDistance?: number
}): UqOodResult {
  const keys = [...new Set(input.predictions.flatMap(p => Object.keys(p)))]
  const perKey = keys.map((key) => {
    const series = input.predictions.map(p => p[key]).filter((v): v is number => Number.isFinite(v))
    const mean = series.length ? series.reduce((a, b) => a + b, 0) / series.length : 0
    const variance = series.length ? series.reduce((a, b) => a + (b - mean) ** 2, 0) / series.length : Infinity
    return { std: Math.sqrt(variance), mean }
  })
  const maxStd = perKey.length ? Math.max(...perKey.map(x => x.std)) : Infinity
  const disagreement = perKey.length
    ? Math.max(...perKey.map(x => x.std / Math.max(1e-6, Math.abs(x.mean) + 1e-6)))
    : Infinity
  const distance = input.inputDistance ?? 0
  let rejectCode: UqOodResult['rejectCode']
  if (!policy.calibrationFresh) rejectCode = 'CALIBRATION_STALE'
  else if ((input.calibrationCoverage ?? 0) < policy.coverageTarget) rejectCode = 'UQ_COVERAGE_LOW'
  else if (distance > policy.distanceThreshold) rejectCode = 'OOD_DISTANCE_HIGH'
  else if (disagreement > policy.disagreementThreshold) rejectCode = 'ENSEMBLE_DISAGREEMENT_HIGH'
  return {
    maxStd,
    coverage: input.calibrationCoverage ?? 0,
    ensembleSize: input.predictions.length,
    distance,
    disagreement,
    accepted: !rejectCode,
    rejectCode,
    calibrationSetHash: input.calibrationSetHash,
  }
}

export function diagonalMahalanobis(input: number[], mean: number[], std: number[]): number {
  const terms = input.map((v, i) => ((v - (mean[i] ?? 0)) / Math.max(1e-6, std[i] ?? 1)) ** 2)
  return Math.sqrt(terms.reduce((a, b) => a + b, 0))
}

export function ensembleFingerprint(predictions: Array<Record<string, number>>): string {
  return sha256(predictions)
}
