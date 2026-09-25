import { createId, sha256, type NodeBindingSnapshot, type SceneContract, type TwinSnapshot } from './contracts'

export interface DaqSample { nodeId: string, at: number, value: number, sequence?: string }

export interface SnapshotInput {
  scene: SceneContract
  channelId: string
  createdBy: string
  phase: string
  controls: Record<string, number>
  states?: Record<string, number>
  disturbances?: Record<string, number>
  samples: DaqSample[]
  bindingSnapshot?: NodeBindingSnapshot
  physicsModelVersion?: string
  residualModelVersion?: string
  nowMs?: number
  freshnessMaxMs?: number
}

export function createTwinSnapshot(input: SnapshotInput): TwinSnapshot {
  const now = input.nowMs ?? Date.now()
  const byNode = new Map<string, DaqSample[]>()
  for (const sample of input.samples) {
    if (!Number.isFinite(sample.at) || !Number.isFinite(sample.value)) continue
    const list = byNode.get(sample.nodeId) ?? []
    list.push(sample)
    byNode.set(sample.nodeId, list)
  }
  const staleNodeIds: string[] = []
  let watermark = 0
  let duplicateCount = 0
  const required = [...input.scene.observations, ...input.scene.states].filter(v => v.nodeId).map(v => v.nodeId!)
  for (const nodeId of required) {
    const samples = (byNode.get(nodeId) ?? []).sort((a, b) => a.at - b.at)
    const latest = samples.at(-1)
    if (!latest) {
      staleNodeIds.push(nodeId)
      continue
    }
    watermark = Math.max(watermark, latest.at)
    const seen = new Set<number>()
    for (const sample of samples) {
      if (seen.has(sample.at)) duplicateCount++
      seen.add(sample.at)
    }
    if (now - latest.at > (input.freshnessMaxMs ?? 60_000)) staleNodeIds.push(nodeId)
  }
  const totalRequired = Math.max(1, required.length)
  const completeness = (totalRequired - staleNodeIds.length) / totalRequired
  const snapshotBase = {
    schemaVersion: 1,
    createdAt: new Date(now).toISOString(),
    createdBy: input.createdBy,
    snapshotId: createId('snap'),
    sceneId: input.scene.sceneId,
    sceneVersion: input.scene.sceneVersion,
    lineId: input.scene.lineId,
    productId: input.scene.productId,
    recipeId: input.scene.recipeId,
    phase: input.phase,
    capturedAt: new Date(watermark || now).toISOString(),
    daqWatermark: watermark,
    sourceSequence: input.samples.map(s => s.sequence).filter(Boolean).at(-1),
    controlValues: input.controls,
    stateEstimate: input.states ?? {},
    disturbances: input.disturbances ?? {},
    dataQuality: { fresh: staleNodeIds.length === 0 && watermark > 0, completeness, staleNodeIds, duplicateCount },
    estimatorVersion: 'raw-last-observation-v1',
    bindingSnapshotHash: input.bindingSnapshot?.snapshotHash,
    physicsModelVersion: input.physicsModelVersion,
    residualModelVersion: input.residualModelVersion,
  }
  return { ...snapshotBase, snapshotHash: sha256(snapshotBase) }
}

export function assertFreshSnapshot(snapshot: TwinSnapshot, nowMs = Date.now(), maxAgeMs = 60_000): void {
  if (!snapshot.dataQuality.fresh || snapshot.daqWatermark <= 0) throw new Error('SNAPSHOT_STALE')
  if (nowMs - snapshot.daqWatermark > maxAgeMs) throw new Error('SNAPSHOT_STALE')
  if (snapshot.dataQuality.completeness < 1) throw new Error('SNAPSHOT_INCOMPLETE')
}
