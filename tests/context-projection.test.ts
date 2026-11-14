import assert from 'node:assert/strict'
import { test } from 'node:test'
import { canonicalHash } from '../shared/context/hash'
import { parseContextSnapshot } from '../server/services/workshop/context/validator'
import { projectGenericFixture } from '../server/services/workshop/context/projection'
import { createIndustrialReadAdapter } from '../server/services/workshop/context/adapters/industrial-read'
import type { ContextAdapterOperationRequest } from '../server/services/workshop/context/contracts'

const capturedAt = '2026-11-13T00:00:00.000Z'
const window = { from: '2026-11-12T00:00:00.000Z', to: capturedAt }

function request(capability: ContextAdapterOperationRequest['capability'], payload: unknown, authorization?: ContextAdapterOperationRequest['authorization']): ContextAdapterOperationRequest {
  return { adapterId: 'test', apiVersion: 'context-adapter.v1', version: '1.0.0', generation: 1, capability, payload, idempotencyKey: `test-${capability}`, timeoutMs: 1000, signal: new AbortController().signal, ...(authorization ? { authorization } : {}) }
}

test('generic projection supports a non-line fixture and carries provenance, scope, window, and hash', () => {
  const snapshot = projectGenericFixture({
    id: 'fixture-snapshot',
    subject: { id: 'case-1', type: 'customer.case', label: 'Case 1' },
    objects: [{ id: 'request-1', type: 'customer.request', label: 'Request' }],
    attributes: [{ id: 'priority', ownerId: 'request-1', key: 'customer.priority', value: 'high', valueKind: 'scalar' }],
    materials: [{ id: 'document-1', label: 'Evidence document', role: 'evidence', quantity: { value: 1, unit: 'item' } }],
    scope: { workspaceId: 'workspace-1', tags: ['fixture'] },
    window,
    source: { adapterId: 'fixture.document-event-replay', version: '1.0.0', sourceRef: 'fixture:case-1', sourceRevision: 'r1', capturedAt },
  })

  assert.equal(snapshot.scope.workspaceId, 'workspace-1')
  assert.deepEqual(snapshot.scope.timeWindow, window)
  assert.equal(snapshot.adapterRefs[0]?.adapterId, 'fixture.document-event-replay')
  assert.ok(snapshot.subjects[0]?.provenance[0]?.sourceRef === 'fixture:case-1')
  assert.ok(snapshot.materialAssignments[0]?.quantity?.unit === 'item')
  assert.match(snapshot.contentHash, /^[a-f0-9]{64}$/)
  assert.deepEqual(parseContextSnapshot(snapshot).contentHash, snapshot.contentHash)
})

test('industrial read adapter projects line and industrial metadata without changing legacy context output', async () => {
  const line = { id: 'line-1', name: 'Line 1', description: 'Demo line', color: '#fff', controlMode: 'manual', simulated: true, createdAt: capturedAt }
  const product = { id: 'product-1', lineId: 'line-1', name: 'Product 1', description: 'Product', paramLimits: {}, createdAt: capturedAt }
  const recipe = { id: 'recipe-1', productId: 'product-1', lineId: 'line-1', name: 'Recipe 1', description: 'Recipe', params: [], daqWindows: [], version: 2, createdAt: capturedAt, updatedAt: capturedAt }
  const run = { id: 'run-1', recipeId: 'recipe-1', recipeName: 'Recipe 1', productId: 'product-1', lineId: 'line-1', startedAt: capturedAt, endedAt: null, results: [], paramsSnapshot: [] }
  const dcw = { id: 'dcw-1', lineId: 'line-1', name: 'Setpoint', templateRef: 'dcw.temp', driver: 'mock', enabled: true, unit: 'C', min: 0, max: 100, value: 42, readValue: 42, state: 'ok', deviceIds: ['twin-1'], driverConfig: {} }
  const daq = { id: 'daq-1', lineId: 'line-1', name: 'Temperature', templateRef: 'daq.temp', driver: 'mock', enabled: true, unit: 'C', min: 0, max: 100, value: 40, state: 'ok', deviceIds: ['twin-1'], driverConfig: {} }
  const binding = { id: 'binding-1', agentId: 'agent-1', nodeId: 'recipe-1', kind: 'recipe', mode: 'manual', createdAt: capturedAt }
  const twin = { id: 'twin-1', workspaceId: '', name: 'Twin 1', modelRef: 'model-1', boundAgentId: null, kind: 'device', telemetry: { temperature: 40 }, desired: {}, state: 'running', controls: [], updatedAt: capturedAt, createdAt: capturedAt }
  const services = {
    lines: { all: () => [line], byId: () => line },
    products: { all: () => [product], byId: () => product },
    recipes: { list: () => [recipe], byId: () => recipe, listRuns: () => [run], runById: () => run },
    dcwNodes: { all: () => [dcw] },
    daqNodes: { all: () => [daq] },
    bindings: { all: () => [binding] },
    twins: { listAll: () => [twin], findById: () => twin },
  }
  const adapter = createIndustrialReadAdapter({ services, now: () => capturedAt })
  assert.equal(adapter.sideEffect, 'none')
  assert.equal(adapter.capabilities.snapshot, true)
  assert.equal(adapter.capabilities.query, true)
  assert.equal(adapter.capabilities.observe, true, 'PR-C: observe is the read-only operational evidence capability')

  const result = await adapter.snapshot!(request('snapshot', { lineId: 'line-1', window })) as { snapshot: ReturnType<typeof projectGenericFixture> }
  const snapshot = result.snapshot
  assert.equal(snapshot.scope.timeWindow?.from, window.from)
  assert.equal(snapshot.source, undefined)
  assert.ok(snapshot.objects.some(item => item.objectType === 'industrial.production-line' || item.objectType === 'industrial.recipe'))
  assert.ok(snapshot.objects.some(item => item.objectType === 'industrial.device-twin'))
  assert.ok(snapshot.objects.some(item => item.objectType === 'industrial.binding'))
  assert.ok(snapshot.attributes.some(item => item.key === 'industrial.dcw.value'))
  assert.ok(snapshot.materialAssignments.some(item => item.assignmentRole === 'product'))
  assert.equal(snapshot.projection.adapterId, 'industrial-read')
  assert.equal(snapshot.projection.window?.to, capturedAt)
  assert.match(snapshot.contentHash, /^[a-f0-9]{64}$/)
  const { projection: _projection, contentHash: _contentHash, ...snapshotContent } = snapshot
  assert.equal(snapshot.contentHash, canonicalHash(snapshotContent))
})

test('industrial read adapter bounds multi-line authorization to authorized lines and discover counts', async () => {
  const lines = [
    { id: 'line-1', name: 'Line 1' },
    { id: 'line-2', name: 'Line 2' },
    { id: 'line-foreign', name: 'Foreign line' },
  ]
  const products = [
    { id: 'product-1', lineId: 'line-1', description: 'Product 1', paramLimits: {} },
    { id: 'product-2', lineId: 'line-2', description: 'Product 2', paramLimits: {} },
    { id: 'product-foreign', lineId: 'line-foreign', description: 'Foreign product', paramLimits: {} },
  ]
  const recipes = [
    { id: 'recipe-1', productId: 'product-1', lineId: 'line-1', description: 'Recipe 1', params: [], daqWindows: [], version: 1 },
    { id: 'recipe-2', productId: 'product-2', lineId: 'line-2', description: 'Recipe 2', params: [], daqWindows: [], version: 1 },
    { id: 'recipe-foreign', productId: 'product-foreign', lineId: 'line-foreign', description: 'Foreign recipe', params: [], daqWindows: [], version: 1 },
  ]
  const runs = [
    { id: 'run-1', recipeId: 'recipe-1', productId: 'product-1', lineId: 'line-1', startedAt: capturedAt, results: [] },
    { id: 'run-2', recipeId: 'recipe-2', productId: 'product-2', lineId: 'line-2', startedAt: capturedAt, results: [] },
    { id: 'run-foreign', recipeId: 'recipe-foreign', productId: 'product-foreign', lineId: 'line-foreign', startedAt: capturedAt, results: [] },
  ]
  const dcwNodes = [
    { id: 'dcw-1', lineId: 'line-1', name: 'DCW 1', enabled: true, state: 'ok', deviceIds: ['twin-1'] },
    { id: 'dcw-2', lineId: 'line-2', name: 'DCW 2', enabled: true, state: 'ok', deviceIds: ['twin-2'] },
    { id: 'dcw-foreign', lineId: 'line-foreign', name: 'Foreign DCW', enabled: true, state: 'ok', deviceIds: ['twin-foreign'] },
  ]
  const daqNodes = [
    { id: 'daq-1', lineId: 'line-1', name: 'DAQ 1', enabled: true, state: 'ok', deviceIds: ['twin-1'] },
    { id: 'daq-2', lineId: 'line-2', name: 'DAQ 2', enabled: true, state: 'ok', deviceIds: ['twin-2'] },
    { id: 'daq-foreign', lineId: 'line-foreign', name: 'Foreign DAQ', enabled: true, state: 'ok', deviceIds: ['twin-foreign'] },
  ]
  const bindings = [
    { id: 'binding-1', agentId: 'agent-1', nodeId: 'recipe-1', kind: 'recipe', mode: 'manual' },
    { id: 'binding-2', agentId: 'agent-1', nodeId: 'dcw-2', kind: 'dcw', mode: 'manual' },
    { id: 'binding-foreign', agentId: 'agent-1', nodeId: 'recipe-foreign', kind: 'recipe', mode: 'manual' },
  ]
  const twins = [
    { id: 'twin-1', workspaceId: '', name: 'Twin 1', modelRef: 'model-1', kind: 'device', telemetry: {}, state: 'running' },
    { id: 'twin-2', workspaceId: '', name: 'Twin 2', modelRef: 'model-2', kind: 'device', telemetry: {}, state: 'running' },
    { id: 'twin-foreign', workspaceId: '', name: 'Foreign twin', modelRef: 'model-foreign', kind: 'device', telemetry: {}, state: 'running' },
  ]
  const services = {
    lines: { all: () => lines, byId: () => undefined },
    products: { all: () => products, byId: () => undefined },
    recipes: { list: () => recipes, byId: () => undefined, listRuns: () => runs, runById: () => undefined },
    dcwNodes: { all: () => dcwNodes },
    daqNodes: { all: () => daqNodes },
    bindings: { all: () => bindings },
    twins: { listAll: () => twins, findById: () => undefined },
  }
  const authorization = { scope: { workspaceId: 'ws-1', channelId: 'ch-1', workerId: 'agent-1', industrial: true }, principal: { id: 'operator' }, metadata: { boundLineIds: ['line-1', 'line-2'] }, industrial: true }
  const adapter = createIndustrialReadAdapter({ services, authorize: () => authorization, now: () => capturedAt })

  const result = await adapter.snapshot!(request('snapshot', {}, authorization)) as { snapshot: ReturnType<typeof projectGenericFixture>, source: { counts: Record<string, number> } }
  const projectedIds = result.snapshot.objects.map(item => item.ref.id)
  assert.deepEqual(result.source.counts, { lines: 2, products: 2, recipes: 2, runs: 2, dcwNodes: 2, daqNodes: 2, bindings: 2, twins: 2 })
  assert.equal(projectedIds.includes('line-foreign'), false)
  assert.equal(projectedIds.includes('product-foreign'), false)
  assert.equal(projectedIds.includes('recipe-foreign'), false)
  assert.equal(projectedIds.includes('run-foreign'), false)
  assert.equal(projectedIds.includes('dcw-foreign'), false)
  assert.equal(projectedIds.includes('daq-foreign'), false)
  assert.equal(projectedIds.includes('binding-foreign'), false)
  assert.equal(projectedIds.includes('twin-foreign'), false)

  const discovered = await adapter.discover!(request('discover', {}, authorization)) as { counts: Record<string, number> }
  assert.deepEqual(discovered.counts, { lines: 2, products: 2, recipes: 2 })
})

test('industrial read adapter does not require lineId for an empty non-line repository', async () => {
  const empty = {
    lines: { all: () => [], byId: () => undefined },
    products: { all: () => [], byId: () => undefined },
    recipes: { list: () => [], byId: () => undefined, listRuns: () => [], runById: () => undefined },
    dcwNodes: { all: () => [] },
    daqNodes: { all: () => [] },
    bindings: { all: () => [] },
    twins: { listAll: () => [], findById: () => undefined },
  }
  const adapter = createIndustrialReadAdapter({ services: empty, now: () => capturedAt })
  const result = await adapter.snapshot!(request('snapshot', {})) as { snapshot: ReturnType<typeof projectGenericFixture> }
  assert.equal(result.snapshot.scope.timeWindow, undefined)
  assert.equal(result.snapshot.subjects[0]?.ref.id, 'global')
})
