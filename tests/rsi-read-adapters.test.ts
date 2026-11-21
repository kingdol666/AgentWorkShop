import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ContextScope, ProvenanceRef } from '../shared/context/contracts'
import type { MemoryRow } from '../server/services/workshop/db/database'
import { createAnalysisReadAdapter } from '../server/services/workshop/rsi-adapter/analysis'
import { createExperienceReadAdapter } from '../server/services/workshop/rsi-adapter/experience'
import { createMemoryReadAdapter } from '../server/services/workshop/rsi-adapter/memory'
import { createOntologyReadAdapter } from '../server/services/workshop/rsi-adapter/ontology'
import { createProjectReadAdapter } from '../server/services/workshop/rsi-adapter/project'
import type { RsiSourceRecord } from '../server/services/workshop/rsi-adapter/contracts'

const scopeA: ContextScope = {
  tenantId: 'tenant-a',
  workspaceId: 'workspace-a',
  subjectRefs: [{ namespace: 'case', id: 'subject-a', revision: '1' }],
  tags: ['research'],
  timeWindow: { from: '2026-11-01T00:00:00.000Z', to: '2026-11-30T00:00:00.000Z' },
}
const scopeB: ContextScope = { ...scopeA, tenantId: 'tenant-b' }
const provenance: ProvenanceRef[] = [{ adapterId: 'fixture.reader', sourceRef: 'fixture/source-a', sourceRevision: 'r1', capturedAt: '2026-11-13T00:00:00.000Z' }]

function metadata(sourceType: RsiSourceRecord['metadata']['sourceType'], overrides: Partial<RsiSourceRecord['metadata']> = {}) {
  return {
    sourceType,
    sourceId: `${sourceType}-a`,
    sourceVersion: '1',
    scope: scopeA,
    provenance,
    status: 'active' as const,
    capturedAt: '2026-11-13T00:00:00.000Z',
    ...overrides,
  }
}

const memory: MemoryRow = {
  id: 'memory-a', channelId: 'channel-a', agentId: 'agent-a', kind: 'semantic', title: 'Memory', content: 'read only', importance: 0.5,
  taskId: null, sessionId: 'session-a', accessCount: 0, lastAccessedAt: null, createdAt: '2026-11-13T00:00:00.000Z', status: 'active',
}

function source<T>(sourceType: RsiSourceRecord['metadata']['sourceType'], payload: T, overrides: Partial<RsiSourceRecord['metadata']> = {}): RsiSourceRecord<T> {
  return { metadata: metadata(sourceType, overrides), payload }
}

test('memory and experience adapters preserve source metadata while projecting read-only payloads', async () => {
  let reads = 0
  const memoryAdapter = createMemoryReadAdapter({ reader: () => {
    reads += 1
    return source('memory', memory)
  } })
  const result = await memoryAdapter.read({ scope: scopeA, now: '2026-11-13T01:00:00.000Z' })
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.records[0]?.metadata.sourceType, 'memory')
    assert.equal(result.records[0]?.metadata.sourceId, 'memory-a')
    assert.equal(result.records[0]?.payload.id, 'memory-a')
  }
  assert.equal(reads, 1)

  const experienceAdapter = createExperienceReadAdapter({ reader: () => source('memory', { ...memory, kind: 'experience' }) })
  const experience = await experienceAdapter.read({ scope: scopeA })
  assert.equal(experience.ok, true)
  if (experience.ok) assert.equal(experience.records[0]?.payload.kind, 'experience')
})

test('all pure adapters accept injected readers without importing source services', async () => {
  const project = await createProjectReadAdapter({ reader: () => source('project', {
    id: 'project-a', name: 'Project', description: '', objective: 'objective', status: 'active', mode: 'research', ownerUserId: 'user-a', planVersion: 1, createdAt: '2026-11-13T00:00:00.000Z', updatedAt: '2026-11-13T00:00:00.000Z',
  }) }).read({ scope: scopeA })
  const ontology = await createOntologyReadAdapter({ reader: () => source('ontology', {
    version: { id: 'ontology-a', version: 1, name: 'Ontology', lineId: '', parentVersion: null, contentHash: 'a'.repeat(64), status: 'published', createdAt: '2026-11-13T00:00:00.000Z', updatedAt: '2026-11-13T00:00:00.000Z' }, entities: [], relations: [], rules: [], bindings: [], evidence: [],
  }) }).read({ scope: scopeA })
  const analysis = await createAnalysisReadAdapter({ reader: () => source('analysis', {
    id: 'analysis-a', title: 'Analysis', category: 'research', summary: 'summary', conclusions: [], metrics: {}, recipeId: '', recipeVersion: '', windowFrom: null, windowTo: null, dataSources: 'fixture', channelId: 'channel-a', channelName: 'Channel', actor: 'user-a', actorName: 'User', createdAt: '2026-11-13T00:00:00.000Z', updatedAt: null,
  }) }).read({ scope: scopeA })
  assert.equal(project.ok, true)
  assert.equal(ontology.ok, true)
  assert.equal(analysis.ok, true)
})

test('cross-tenant and cross-subject reads fail closed', async () => {
  const adapter = createMemoryReadAdapter({ reader: () => source('memory', memory) })
  const tenant = await adapter.read({ scope: scopeB })
  assert.equal(tenant.ok, false)
  if (!tenant.ok) assert.equal(tenant.error.code, 'RSI_READ_SCOPE_MISMATCH')

  const subject = await adapter.read({ scope: { ...scopeA, subjectRefs: [{ namespace: 'case', id: 'subject-b', revision: '1' }] } })
  assert.equal(subject.ok, false)
  if (!subject.ok) assert.equal(subject.error.code, 'RSI_READ_SCOPE_MISMATCH')
})

test('stale, revoked, conflicting and missing provenance records are rejected', async () => {
  const read = (overrides: Partial<RsiSourceRecord['metadata']>) => createMemoryReadAdapter({ reader: () => source('memory', memory, overrides) }).read({ scope: scopeA, now: '2026-11-13T01:00:00.000Z' })
  const stale = await read({ staleAt: '2026-11-13T00:30:00.000Z' })
  assert.equal(stale.ok, false)
  if (!stale.ok) assert.equal(stale.error.code, 'RSI_READ_STALE')
  const revoked = await read({ status: 'revoked' })
  assert.equal(revoked.ok, false)
  if (!revoked.ok) assert.equal(revoked.error.code, 'RSI_READ_REVOKED')
  const conflict = await read({ status: 'conflicted' })
  assert.equal(conflict.ok, false)
  if (!conflict.ok) assert.equal(conflict.error.code, 'RSI_READ_CONFLICT')
  const missingProvenance = await read({ provenance: [] })
  assert.equal(missingProvenance.ok, false)
  if (!missingProvenance.ok) assert.equal(missingProvenance.error.code, 'RSI_READ_INVALID_PROVENANCE')
})

test('duplicate source versions with different payloads are rejected as conflicts', async () => {
  const adapter = createMemoryReadAdapter({ reader: () => [
    source('memory', memory),
    source('memory', { ...memory, content: 'different' }),
  ] })
  const result = await adapter.read({ scope: scopeA })
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.error.code, 'RSI_READ_CONFLICT')
})
