import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { defaultInjectionScene, InjectionGreyboxProvider, smallStepCandidates } from '../server/services/workshop/aml/twin/physics-runtime'
import { assertFreshSnapshot, createTwinSnapshot } from '../server/services/workshop/aml/twin/snapshot-service'
import { evaluateHybridGates, chooseTuningMode } from '../server/services/workshop/aml/twin/acceptance'
import { runVirtualTrial, issueRecommendationCertificate } from '../server/services/workshop/aml/twin/trial-service'
import { sha256 } from '../server/services/workshop/aml/twin/contracts'

const now = Date.now()
const scene = defaultInjectionScene('acceptance-aml-hybrid-twin')
scene.observations = scene.observations.map(v => ({ ...v, nodeId: v.id === 'weight' ? 'daq-part-weight' : v.id === 'flash_rate' ? 'daq-flash-rate' : 'daq-sink-rate' }))
scene.states = scene.states.map(v => ({ ...v, nodeId: v.id === 'melt_temperature' ? 'daq-melt-temperature' : 'daq-cavity-pressure' }))
const provider = new InjectionGreyboxProvider()
const baselineControls = { hold_pressure: 65, hold_time: 8, melt_temperature_setpoint: 247 }
const samples = [
  ...scene.observations.map((v, i) => ({ nodeId: v.nodeId!, at: now - 1000 - i, value: i === 0 ? 32.3 : 0, sequence: `seq-${i}` })),
  ...scene.states.map((v, i) => ({ nodeId: v.nodeId!, at: now - 1000 - i, value: i === 0 ? 247 : 65, sequence: `state-${i}` })),
]
const snapshot = createTwinSnapshot({ scene, channelId: 'acceptance-channel', createdBy: 'acceptance', phase: 'holding', controls: baselineControls, states: { melt_temperature: 247, cavity_pressure: 65, fill_fraction: 1 }, disturbances: { material_batch_factor: 1 }, samples, nowMs: now })

const candidates = smallStepCandidates(scene, baselineControls).map(c => Array.from({ length: 4 }, () => c))
const trials = candidates.map((trajectory, i) => runVirtualTrial({
  scene,
  snapshot,
  modelId: 'twin-injection-acceptance-v1',
  modelHash: sha256(provider.manifest),
  objective: { schemaVersion: 1, createdAt: new Date(now).toISOString(), createdBy: 'acceptance', objectiveId: 'weight-quality', twinModelId: 'twin-injection-acceptance-v1', targets: { weight: 32.5 }, weights: { weight: 1 }, controlCosts: { hold_pressure: 0.01 }, horizonSteps: 4, trustRegion: { hold_pressure: { maxDelta: 2 }, hold_time: { maxDelta: 0.5 }, melt_temperature_setpoint: { maxDelta: 2 } } },
  baselineControls,
  candidateControls: trajectory,
  provider,
  uncertainty: { predictions: [{ weight: 32.5, flash_rate: 0.1, sink_rate: 0.1 }, { weight: 32.5, flash_rate: 0.1, sink_rate: 0.1 }, { weight: 32.5, flash_rate: 0.1, sink_rate: 0.1 }], coverage: 0.96, inputDistance: 1.2, calibrationFresh: true },
  createdBy: `acceptance-worker-${i}`,
  nowMs: now,
}))

const undertrained = evaluateHybridGates({ rows: 220, runs: 1, oneStepTestNrmse: 0.18, rolloutTestNrmse: 0.40, valTestGap: 0.35, calibrationRows: 80, calibrationCoverage: 0.72, candidateTrials: trials.slice(0, 3), physicsSolverFailureRate: 0.01 })
const trained = evaluateHybridGates({ rows: 900, runs: 6, oneStepTestNrmse: 0.06, rolloutTestNrmse: 0.14, valTestGap: 0.08, calibrationRows: 420, calibrationCoverage: 0.96, candidateTrials: [...trials, ...trials, ...trials].slice(0, 12), physicsSolverFailureRate: 0 })
const preciseTrial = trials.find(t => t.baselineComparison.improvement > 0 && t.constraintResults.every(c => c.passed) && t.outOfDistribution.accepted)
const certificate = preciseTrial ? issueRecommendationCertificate(preciseTrial, 'acceptance', sha256(provider.manifest), sha256({ objectiveId: 'weight-quality' }), now) : null
const unsafeTrial = runVirtualTrial({
  scene,
  snapshot,
  modelId: 'twin-injection-acceptance-v1',
  modelHash: sha256(provider.manifest),
  objective: { schemaVersion: 1, createdAt: new Date(now).toISOString(), createdBy: 'acceptance', objectiveId: 'weight-quality', targets: { weight: 32.5 }, weights: { weight: 1 }, controlCosts: {}, horizonSteps: 2, trustRegion: {} },
  baselineControls,
  candidateControls: Array.from({ length: 20 }, () => ({ ...baselineControls, hold_pressure: 90 })),
  provider,
  uncertainty: { predictions: [{ weight: 35, flash_rate: 2, sink_rate: 0 }], coverage: 0.96, inputDistance: 1, calibrationFresh: true },
  createdBy: 'acceptance-unsafe',
  nowMs: now,
})
let staleRejected = false
try {
  const stale = createTwinSnapshot({ scene, channelId: 'acceptance-channel', createdBy: 'acceptance', phase: 'holding', controls: baselineControls, samples, nowMs: now + 120_000 })
  assertFreshSnapshot(stale, now + 120_000, 60_000)
}
catch { staleRejected = true }

const report = {
  acceptanceId: `aml-hybrid-twin-${new Date(now).toISOString()}`,
  generatedAt: new Date(now).toISOString(),
  noRealDcwWrites: true,
  scene: { sceneId: scene.sceneId, version: scene.sceneVersion, lineId: scene.lineId },
  snapshot: { id: snapshot.snapshotId, fresh: snapshot.dataQuality.fresh, completeness: snapshot.dataQuality.completeness, hash: snapshot.snapshotHash },
  undertrained: { passed: undertrained.passed, mode: chooseTuningMode(undertrained), rejectCodes: undertrained.rejectCodes },
  trained: { passed: trained.passed, mode: chooseTuningMode(trained), rejectCodes: trained.rejectCodes },
  recommendation: { issued: Boolean(certificate), certificateHash: certificate?.certificateHash ?? null, candidateExecuted: certificate?.candidateExecuted ?? false },
  unsafeTrial: { hardConstraintsPassed: unsafeTrial.constraintResults.every(c => c.passed), rejectCodes: unsafeTrial.constraintResults.filter(c => !c.passed).map(c => c.id) },
  staleSnapshotRejected: staleRejected,
  tuningPolicy: { whenModelNotReady: 'safe_small_step', whenModelGatesPass: 'precise_search', writeMode: 'recommendation_only' },
}
const outDir = join(process.cwd(), 'bench', 'results', `aml-hybrid-twin-acceptance-${new Date(now).toISOString().replaceAll(':', '').replaceAll('.', '')}`)
await mkdir(outDir, { recursive: true })
await writeFile(join(outDir, 'summary.json'), JSON.stringify(report, null, 2), 'utf8')
await writeFile(join(outDir, 'report.md'), [
  '# AML Hybrid Twin Acceptance',
  '',
  `- generatedAt: ${report.generatedAt}`,
  '- real DCW writes: 0',
  `- undertrained mode: ${report.undertrained.mode} (${report.undertrained.passed ? 'unexpected pass' : 'correctly blocked'})`,
  `- trained mode: ${report.trained.mode} (${report.trained.passed ? 'gates passed' : 'gates failed'})`,
  `- recommendation issued: ${report.recommendation.issued}`,
  `- candidateExecuted: ${report.recommendation.candidateExecuted}`,
  `- unsafe candidate rejected: ${report.unsafeTrial.hardConstraintsPassed}`,
  `- stale snapshot rejected: ${report.staleSnapshotRejected}`,
  '',
  '## Control policy',
  '',
  '训练门禁未通过时仅允许 safe_small_step 试探，用于收集数据；只有训练、UQ/OOD、物理和候选轨迹门禁全部通过时，才允许 precise_search recommendation。所有推荐均为 recommendation-only，未写入 PLC/DCW。',
].join('\n'), 'utf8')
console.log(JSON.stringify({ ...report, outDir }, null, 2))
if (undertrained.passed || !trained.passed || !certificate || report.unsafeTrial.hardConstraintsPassed || !staleRejected) process.exit(1)
