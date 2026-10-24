/**
 * 到达时间水位(C6/A16):availabilityWatermark = max(ingested_at) over 最近窗口。
 * 旧数据无 ingested_at → null(= unknown,不得用于严格在线回放)。
 */
import type { TsdbPort } from '../daq/storage/tsdb-port'
import type { ProcessModelSpec } from './contracts'

export async function computeWatermark(tsdb: TsdbPort, spec: ProcessModelSpec, _runIds?: string[]): Promise<number | null> {
  const toMs = Date.now()
  const fromMs = toMs - spec.timing.beatMs * Math.max(2, spec.timing.historySteps) * 2
  const marks: number[] = []
  for (const variable of spec.variables) {
    if (typeof tsdb.queryTaggedPage !== 'function') continue
    const page = await tsdb.queryTaggedPage(variable.nodeId, { fromMs, toMs, limit: 5000, withState: true })
    for (const point of page.points) if (point.ingestedAt != null) marks.push(point.ingestedAt)
  }
  return marks.length ? Math.max(...marks) : null
}
