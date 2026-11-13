import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createContextAdapterRegistry } from '../server/services/workshop/context/registry'
import type { ContextAdapter } from '../server/services/workshop/context/contracts'
import { CandidateEvidenceStore } from '../server/services/workshop/evidence/candidate-store'
import { normalizeCandidateEvidence } from '../server/services/workshop/evidence/normalizer'
import { createResearchOrchestrator, ResearchOrchestratorError } from '../server/services/workshop/research/orchestrator'

const now = '2026-11-13T00:00:00.000Z'
const scope = { workspaceId: 'workspace-1' }
const subject = { namespace: 'fixture.subject', id: 'subject-1' }

function adapter(): ContextAdapter {
  return {
    adapterId: 'fixture.adapter', apiVersion: 'context-adapter.v1', version: '1.0.0', generation: 1,
    capabilities: { discover: false, snapshot: false, observe: true, query: false, simulate: true, replay: true, verify: false, export: false },
    sideEffect: 'none', health: { status: 'healthy', checkedAt: now }, timeout: { defaultMs: 1000, maxMs: 5000 },
    owner: { ownerId: 'fixture', dispose: async () => undefined },
    observe: async request => ({ ok: true, payload: { observed: request.payload } }),
    simulate: async request => ({ ok: true, payload: { simulated: request.payload } }),
    replay: async request => ({ ok: true, payload: { replayed: request.payload } }),
    drain: async () => undefined, retire: async () => undefined,
  }
}

function create() {
  const registry = createContextAdapterRegistry()
  registry.registerOne(adapter())
  return { registry, store: new CandidateEvidenceStore() }
}

test('bounded research runs produce immutable candidate-only evidence', async () => {
  const { registry, store } = create()
  const research = createResearchOrchestrator(registry, store, { now: () => now, createId: prefix => `${prefix}-1` })
  research.create({ id: 'run-1', idempotencyKey: 'key-1', objective: 'observe', question: 'what happened?', subjectRefs: [subject], scope, allowedCapabilities: ['observe'] })
  research.plan('run-1', { id: 'plan-1', steps: [{ id: 'step-1', adapterId: 'fixture.adapter', capability: 'observe', payload: { value: 1 }, sourceRef: 'fixture:one' }] })
  research.approveRead('run-1')
  const run = await research.execute('run-1')
  assert.equal(run.state, 'completed')
  assert.equal(run.evidenceIds.length, 1)
  const candidate = store.require(run.evidenceIds[0]!)
  assert.equal(candidate.candidateOnly, true)
  assert.equal(candidate.claimLevel, 'candidate')
  assert.throws(() => {
    (candidate as { claimLevel: string }).claimLevel = 'validated'
  })
})

test('default capability allowlist is persisted and planned capabilities are enforced', async () => {
  const { registry } = create()
  const research = createResearchOrchestrator(registry, undefined, { now: () => now })
  const created = research.create({ id: 'run-default-capabilities', idempotencyKey: 'key-default-capabilities', objective: 'observe', question: 'q', subjectRefs: [subject], scope })
  assert.deepEqual(created.run.allowedCapabilities, ['discover', 'snapshot', 'observe', 'query', 'verify'])
  assert.throws(() => research.plan('run-default-capabilities', { id: 'plan-1', steps: [{ id: 'step-1', adapterId: 'fixture.adapter', capability: 'simulate', payload: {}, sourceRef: 'fixture:simulate' }] }), (error: unknown) => error instanceof ResearchOrchestratorError && error.code === 'RESEARCH_CAPABILITY_UNDECLARED')
  const serialized = research.serialize()
  const restored = createResearchOrchestrator(registry)
  restored.restore(serialized)
  assert.deepEqual(restored.get('run-default-capabilities').allowedCapabilities, created.run.allowedCapabilities)
})

test('structured adapter failure fails the run without creating candidate evidence', async () => {
  const { registry, store } = create()
  const failingAdapter = { ...adapter(), adapterId: 'failing.adapter', observe: async () => ({ ok: false as const, error: { code: 'FIXTURE_FAILURE', category: 'internal' as const, message: 'fixture failed', retryable: false } }) }
  registry.registerOne(failingAdapter)
  const research = createResearchOrchestrator(registry, store, { now: () => now })
  research.create({ id: 'run-failure', idempotencyKey: 'key-failure', objective: 'observe', question: 'q', subjectRefs: [subject], scope, allowedCapabilities: ['observe'] })
  research.plan('run-failure', { id: 'plan-failure', steps: [{ id: 'step-1', adapterId: 'failing.adapter', capability: 'observe', payload: {}, sourceRef: 'fixture:failure' }] })
  research.approveRead('run-failure')
  await assert.rejects(() => research.execute('run-failure'), (error: unknown) => error instanceof ResearchOrchestratorError && error.code === 'RESEARCH_ADAPTER_FAILURE')
  assert.equal(research.get('run-failure').state, 'failed')
  assert.equal(research.get('run-failure').evidenceIds.length, 0)
  assert.equal(store.size(), 0)
})

test('idempotency conflict and actuation are fail-closed', async () => {
  const { registry } = create()
  const research = createResearchOrchestrator(registry, undefined, { now: () => now })
  research.create({ id: 'run-1', idempotencyKey: 'key-1', objective: 'observe', question: 'q', subjectRefs: [subject], scope })
  assert.throws(() => research.create({ id: 'run-2', idempotencyKey: 'key-1', objective: 'different', question: 'q', subjectRefs: [subject], scope }), (error: unknown) => error instanceof ResearchOrchestratorError && error.code === 'RESEARCH_IDEMPOTENCY_CONFLICT')
  assert.throws(() => research.plan('run-1', { id: 'plan-1', steps: [{ id: 'step-1', adapterId: 'fixture.adapter', capability: 'actuate', payload: {}, sourceRef: 'fixture:write' }] }), (error: unknown) => error instanceof ResearchOrchestratorError && error.code === 'RESEARCH_ACTUATE_FORBIDDEN')
})

test('candidate normalizer rejects overclaiming evidence and store is append-only', () => {
  const candidate = normalizeCandidateEvidence({
    id: 'candidate-1', kind: 'observation', subjectRefs: [subject], source: { adapterId: 'fixture.adapter', sourceRef: 'fixture:one' },
    payloadRef: 'research://candidate-1', payloadHash: 'a'.repeat(64), quality: 'raw', accessScope: scope, createdAt: now,
  })
  const store = new CandidateEvidenceStore()
  store.add(candidate)
  assert.throws(() => store.add({ ...candidate, contentHash: 'b'.repeat(64) }), /immutable/)
})
