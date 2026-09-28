import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createNodeBindingSnapshot, hashNodeBindingSnapshot, validateNodeBindingSnapshot, verifyNodeBindingSnapshot, type BindingSource } from '../server/services/workshop/aml/twin/binding-snapshot'
import { createTwinSnapshot, hashTwinSnapshot, validateTwinSnapshot, verifyTwinSnapshot } from '../server/services/workshop/aml/twin/snapshot-service'
import { freezeSceneDraft, type SceneWithDraftMetadata } from '../server/services/workshop/aml/twin/scene-lifecycle'
import type { SceneContract } from '../server/services/workshop/aml/twin/contracts'

const NOW = Date.parse('2026-09-25T12:00:00.000Z')
const recipe = { id: 'recipe-1', productId: 'product-1', lineId: 'line-1', version: 3, params: [{ nodeId: 'dcw-pressure', value: 20 }] }

function sceneDraft(): SceneContract {
  return {
    schemaVersion: 1,
    createdAt: '2026-09-25T11:00:00.000Z',
    createdBy: 'test',
    sceneId: 'scene-1',
    sceneVersion: '1.0.0',
    lineId: 'line-1',
    productId: 'product-1',
    recipeId: 'recipe-1',
    phases: ['holding'],
    controls: [{ id: 'pressure', nodeId: 'dcw-pressure', role: 'control', physicalMeaning: '保压压力', unit: 'bar', min: 0, max: 100, maxStep: 2 }],
    states: [{ id: 'temperature', nodeId: 'daq-temperature', role: 'state', physicalMeaning: '模具温度', unit: 'degC', min: 0, max: 300 }],
    disturbances: [],
    observations: [{ id: 'weight', nodeId: 'daq-weight', role: 'observation', physicalMeaning: '成品重量', unit: 'g', min: 30, max: 35 }],
    guards: [],
    constraints: [],
    physicsProfileId: 'physics-1',
    objectiveProfileIds: [],
    writePolicy: { minNodeIntervalSec: 60, minLineActionIntervalSec: 60, maxActionsPerRun: 3, maxDeltaPerAction: { pressure: 2 } },
  }
}

function frozenScene(): SceneWithDraftMetadata {
  return freezeSceneDraft(sceneDraft(), 'operator-1', '2026-09-25T11:30:00.000Z').scene
}

function bindings(overrides: Partial<BindingSource> = {}): BindingSource[] {
  return [
    { agentId: 'agent-1', agentRole: 'lead', nodeId: 'dcw-pressure', kind: 'dcw', mode: 'manual', controlPolicy: 'hitl_governed', physicalMeaning: '保压压力', unit: 'bar', min: 0, max: 100, lineId: 'line-1' },
    { agentId: 'agent-1', agentRole: 'lead', nodeId: 'daq-temperature', kind: 'daq', mode: 'auto', controlPolicy: 'recommendation_only', physicalMeaning: '模具温度', unit: 'degC', min: 0, max: 300, lineId: 'line-1', samplePeriodMs: 1000 },
    { agentId: 'agent-1', agentRole: 'lead', nodeId: 'daq-weight', kind: 'daq', mode: 'auto', controlPolicy: 'recommendation_only', physicalMeaning: '成品重量', unit: 'g', min: 30, max: 35, lineId: 'line-1', samplePeriodMs: 1000 },
  ].map(binding => ({ ...binding, ...overrides }))
}

function bindingSnapshot() {
  return createNodeBindingSnapshot({
    channelId: 'channel-1',
    createdBy: 'service',
    scene: frozenScene(),
    recipe,
    bindings: bindings(),
    requireFrozenScene: true,
    snapshotId: 'binding-fixed',
    nowMs: NOW,
  })
}

function validSnapshot(overrides: Record<string, unknown> = {}) {
  const scene = frozenScene()
  const binding = bindingSnapshot()
  return createTwinSnapshot({
    scene,
    frozenScene: scene,
    channelId: 'channel-1',
    createdBy: 'service',
    phase: 'holding',
    recipe,
    bindingSnapshot: binding,
    controls: { pressure: 20 },
    states: { temperature: 180 },
    samples: [
      { nodeId: 'daq-temperature', at: NOW - 500, value: 180, sequence: 1, lineId: 'line-1', productId: 'product-1', recipeId: 'recipe-1' },
      { nodeId: 'daq-weight', at: NOW - 500, value: 32.5, sequence: 2, lineId: 'line-1', productId: 'product-1', recipeId: 'recipe-1' },
    ],
    nowMs: NOW,
    freshnessMaxMs: 1000,
    strict: true,
    requireFrozenScene: true,
    ...overrides,
  })
}

test('builds an authoritative binding snapshot from channel bindings with canonical epoch/hash', () => {
  const snapshot = bindingSnapshot()
  const reordered = createNodeBindingSnapshot({
    channelId: 'channel-1',
    createdBy: 'service',
    scene: frozenScene(),
    recipe,
    bindings: [...bindings()].reverse(),
    requireFrozenScene: true,
    snapshotId: 'binding-fixed',
    nowMs: NOW,
  })
  assert.equal(snapshot.bindingEpoch, reordered.bindingEpoch)
  assert.equal(snapshot.snapshotHash, reordered.snapshotHash)
  assert.equal(snapshot.bindings[0]?.kind, 'daq')
  assert.equal(snapshot.bindings.find(binding => binding.nodeId === 'dcw-pressure')?.controlPolicy, 'hitl_governed')
  assert.equal(snapshot.bindings.find(binding => binding.nodeId === 'daq-weight')?.physicalMeaning, '成品重量')
  assert.equal(snapshot.lineId, 'line-1')
  assert.equal(snapshot.productId, 'product-1')
  assert.equal(snapshot.recipeId, 'recipe-1')
})

test('validates binding hash, epoch, frozen scene, recipe and node semantics', () => {
  const snapshot = bindingSnapshot()
  const options = { frozenScene: frozenScene(), expectedChannelId: 'channel-1', recipe, requireFrozenScene: true, requireRecipe: true }
  const result = validateNodeBindingSnapshot(snapshot, options)
  assert.equal(result.valid, true, result.errors.join(', '))
  assert.equal(result.calculatedHash, hashNodeBindingSnapshot(snapshot))
  assert.equal(verifyNodeBindingSnapshot(snapshot, options), true)

  const tampered = { ...snapshot, bindings: snapshot.bindings.map(binding => binding.nodeId === 'daq-weight' ? { ...binding, unit: 'kg' } : binding) }
  assert.equal(verifyNodeBindingSnapshot(tampered, options), false)
  assert.ok(validateNodeBindingSnapshot(tampered, options).errors.includes('BINDING_SNAPSHOT_HASH_MISMATCH'))
})

test('rejects duplicate bindings and cross-recipe bindings at construction', () => {
  assert.throws(() => createNodeBindingSnapshot({
    channelId: 'channel-1', createdBy: 'service', scene: frozenScene(), recipe,
    bindings: [...bindings(), bindings()[0]!], requireFrozenScene: true,
  }), /BINDING_DUPLICATE/)
  assert.throws(() => createNodeBindingSnapshot({
    channelId: 'channel-1', createdBy: 'service', scene: frozenScene(), recipe,
    bindings: bindings({ recipeId: 'recipe-2' }), requireFrozenScene: true,
  }), /BINDING_RECIPE_MISMATCH/)
})

test('creates and verifies a TwinSnapshot only when binding and frozen scene lineage agree', () => {
  const snapshot = validSnapshot()
  const binding = bindingSnapshot()
  const scene = frozenScene()
  assert.equal(snapshot.bindingSnapshotHash, binding.snapshotHash)
  assert.equal(snapshot.bindingEpoch, binding.bindingEpoch)
  assert.ok(snapshot.sceneContractHash)
  assert.equal(hashTwinSnapshot(snapshot), snapshot.snapshotHash)
  const result = validateTwinSnapshot(snapshot, {
    scene,
    frozenScene: scene,
    bindingSnapshot: binding,
    channelId: 'channel-1',
    recipe,
    requireFresh: true,
    requireBindingSnapshot: true,
    requireFrozenScene: true,
    requireRecipe: true,
    nowMs: NOW,
    maxAgeMs: 1000,
  })
  assert.equal(result.valid, true, result.errors.join(', '))
  assert.equal(verifyTwinSnapshot(snapshot, { bindingSnapshot: binding, expectedBindingEpoch: binding.bindingEpoch, channelId: 'channel-1', nowMs: NOW, maxAgeMs: 1000, requireFresh: true }), true)
})

test('rejects missing, stale, duplicate, out-of-order and cross-recipe samples in strict production mode', () => {
  const scene = frozenScene()
  const binding = bindingSnapshot()
  const base = {
    scene, frozenScene: scene, channelId: 'channel-1', createdBy: 'service', phase: 'holding', recipe,
    bindingSnapshot: binding, controls: { pressure: 20 }, states: { temperature: 180 }, nowMs: NOW,
    freshnessMaxMs: 1000, strict: true, requireFrozenScene: true,
  }
  const sample = (recipeId = 'recipe-1', at = NOW - 500, sequence: number = 1) => ({ nodeId: 'daq-temperature', at, value: 180, sequence, lineId: 'line-1', productId: 'product-1', recipeId })
  assert.throws(() => createTwinSnapshot({ ...base, samples: [sample(), sample(), { ...sample(), nodeId: 'daq-weight', sequence: 3 }] }), /SNAPSHOT_DUPLICATE_SAMPLE/)
  assert.throws(() => createTwinSnapshot({ ...base, samples: [sample('recipe-1', NOW - 100, 1), sample('recipe-1', NOW - 500, 2), { ...sample(), nodeId: 'daq-weight', sequence: 3 }] }), /SNAPSHOT_SAMPLE_OUT_OF_ORDER/)
  assert.throws(() => createTwinSnapshot({ ...base, samples: [sample('recipe-2'), { ...sample(), nodeId: 'daq-weight', sequence: 3 }] }), /SNAPSHOT_CROSS_RECIPE/)
  assert.throws(() => createTwinSnapshot({ ...base, samples: [sample()] }), /SNAPSHOT_STALE/)
  assert.throws(() => createTwinSnapshot({ ...base, samples: [sample('recipe-1', NOW - 10_000, 1), { ...sample(), nodeId: 'daq-weight', sequence: 3 }] }), /SNAPSHOT_STALE/)
})

test('keeps the legacy TwinSnapshot path compatible when authority inputs are absent', () => {
  const scene = sceneDraft()
  const snapshot = createTwinSnapshot({
    scene,
    channelId: 'legacy-channel',
    createdBy: 'legacy-test',
    phase: 'holding',
    controls: {},
    samples: [
      { nodeId: 'daq-temperature', at: NOW - 1000, value: 180 },
      { nodeId: 'daq-temperature', at: NOW - 1000, value: 181 },
      { nodeId: 'daq-weight', at: NOW - 1000, value: 32.5 },
    ],
    nowMs: NOW,
    freshnessMaxMs: 2000,
  })
  assert.equal(snapshot.dataQuality.duplicateCount, 1)
  assert.equal(snapshot.dataQuality.fresh, true)
})
