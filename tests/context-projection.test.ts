import assert from 'node:assert/strict'
import { test } from 'node:test'
import { canonicalHash } from '../shared/context/hash'
import { parseContextSnapshot } from '../server/services/workshop/context/validator'
import { projectGenericFixture } from '../server/services/workshop/context/projection'
import { createIndustrialReadAdapter } from '../server/services/workshop/context/adapters/industrial-read'
import type { ContextAdapterOperationRequest } from '../server/services/workshop/context/contracts'

const capturedAt = '2026-11-13T00:00:00.000Z'
const window = { from: '2026-11-12T00:00:00.000Z', to: capturedAt }

function request(capability: ContextAdapterOperationRequest['capability'], payload: unknown): ContextAdapterOperationRequest {
  return { adapterId: 'test', apiVersion: 'context-adapter.v1', version: '1.0.0', generation: 1, capability, payload, idempotencyKey: `test-${capability}`, timeoutMs: 1000, signal: new AbortController().signal }
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
  assert.equal(adapter.capabilities.observe, false)

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
