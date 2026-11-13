export type DaqQuality = 'good' | 'uncertain' | 'bad' | 'stale' | 'offline'

export interface QualityInput {
  enabled: boolean
  value: number | null
  state: string
  driverOk: boolean
  ageMs: number
  staleMs?: number
}

export function qualityFromReading(input: QualityInput): DaqQuality {
  if (!input.enabled) return 'offline'
  if (!input.driverOk) return 'bad'
  if (input.value == null || !Number.isFinite(input.value)) return 'uncertain'
  if (input.staleMs != null && input.staleMs > 0 && input.ageMs > input.staleMs) return 'stale'
  return 'good'
}
