import assert from 'node:assert/strict'
import { test } from 'node:test'
import { compileSceneDraft, discoverSceneNodes, freezeSceneDraft, sceneSemanticHash, type NodeSemanticInput } from '../server/services/workshop/aml/twin/scene-builder'

const nodes: NodeSemanticInput[] = [
  { nodeId: 'daq-quality', kind: 'daq', name: '成品重量', physicalMeaning: '质量目标', unit: 'g', min: 30, max: 35 },
  { nodeId: 'daq-temp', kind: 'daq', name: '模具温度', physicalMeaning: '过程状态', unit: 'degC', min: 0, max: 300 },
  { nodeId: 'dcw-pressure', kind: 'dcw', name: '保压设定', physicalMeaning: '执行器控制量', unit: 'bar', min: 0, max: 100, maxStep: 2 },
  { nodeId: 'daq-batch', kind: 'daq', name: '来料批次', physicalMeaning: '扰动', unit: 'ratio', roleHint: 'disturbance' },
  { nodeId: 'daq-alarm', kind: 'daq', name: '安全报警', physicalMeaning: 'guard', unit: 'ratio', min: 0, max: 1 },
]

test('discovers node roles with evidence and deterministic counts', () => {
  const result = discoverSceneNodes(nodes)
  assert.equal(result.counts.control, 1)
  assert.equal(result.counts.target, 1)
  assert.equal(result.counts.state, 1)
  assert.equal(result.counts.disturbance, 1)
  assert.equal(result.counts.guard, 1)
  assert.equal(result.nodes.find(n => n.nodeId === 'dcw-pressure')?.inferred.confidence, 1)
})

test('compiles a stable semantic draft and enforces the 60 second write policy', async () => {
  const a = compileSceneDraft({ sceneId: 'scene-a', sceneVersion: '1.0.0', lineId: 'line-a', createdBy: 'agent-a', nodes, prompt: 'temperature and pressure quality control' })
  await new Promise(resolve => setTimeout(resolve, 2))
  const b = compileSceneDraft({ sceneId: 'scene-a', sceneVersion: '1.0.0', lineId: 'line-a', createdBy: 'agent-b', nodes: [...nodes].reverse(), prompt: 'temperature and pressure quality control' })
  assert.equal(a.draftMeta.status, 'draft')
  assert.equal(a.draftMeta.contractHash, b.draftMeta.contractHash)
  assert.equal(sceneSemanticHash(a), sceneSemanticHash(b))
  assert.equal(a.writePolicy.minNodeIntervalSec, 60)
  assert.equal(a.writePolicy.minLineActionIntervalSec, 60)
  assert.equal(a.controls[0]?.maxStep, 2)
  const targetId = a.observations.find(v => v.nodeId === 'daq-quality')?.id
  assert.ok(targetId && a.constraints.some(c => c.id === targetId && c.kind === 'hard_range'))
})

test('freezes only with an approver without renaming the version', () => {
  const draft = compileSceneDraft({ sceneId: 'scene-b', sceneVersion: '0.1.0-draft', lineId: 'line-b', createdBy: 'agent', nodes })
  const frozen = freezeSceneDraft(draft, 'operator-1', '2026-09-25T00:00:00.000Z')
  assert.equal(frozen.draftMeta.status, 'frozen')
  assert.equal(frozen.sceneVersion, '0.1.0-draft')
  assert.equal(frozen.draftMeta.approvedBy, 'operator-1')
  assert.equal(frozen.draftMeta.approvedAt, '2026-09-25T00:00:00.000Z')
  assert.throws(() => freezeSceneDraft(draft, ''), /SCENE_APPROVER_REQUIRED/)
})

test('rejects unbounded scenes without controls or observables', () => {
  assert.throws(() => compileSceneDraft({ sceneId: 'no-control', lineId: 'line', createdBy: 'agent', nodes: [{ nodeId: 'x', kind: 'daq', name: '状态', unit: 'ratio' }] }), /SCENE_NO_CONTROLS/)
  assert.throws(() => compileSceneDraft({ sceneId: 'no-observable', lineId: 'line', createdBy: 'agent', nodes: [{ nodeId: 'u', kind: 'dcw', name: '设定', unit: 'ratio' }] }), /SCENE_NO_OBSERVABLES/)
})
