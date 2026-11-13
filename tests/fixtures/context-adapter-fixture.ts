import type { ContextAdapter, ContextAdapterCapabilities, ContextAdapterOperationRequest } from '../../server/services/workshop/context/contracts'

export type FixtureDocument = {
  id: string
  title: string
  body: string
  revision: string
}

export type FixtureEvent = {
  id: string
  type: string
  at: string
  data: Record<string, unknown>
}

export type FixtureReplay = {
  replayId: string
  eventIds: string[]
  state: Record<string, unknown>
}

export function createDocumentEventReplayAdapter(options: { adapterId?: string, generation?: number, ownerId?: string } = {}): ContextAdapter {
  const adapterId = options.adapterId ?? 'fixture.document-event-replay'
  const generation = options.generation ?? 1
  const documents: FixtureDocument[] = [{ id: 'doc-1', title: 'Fixture document', body: 'domain-neutral fixture', revision: 'r1' }]
  const events: FixtureEvent[] = [{ id: 'event-1', type: 'document.created', at: '2026-11-13T00:00:00.000Z', data: { documentId: 'doc-1' } }]
  const replay: FixtureReplay = { replayId: 'replay-1', eventIds: events.map(event => event.id), state: { documents: documents.length } }
  const operation = (request: ContextAdapterOperationRequest): unknown => {
    if (request.signal.aborted) throw new Error('fixture operation cancelled')
    switch (request.capability) {
      case 'discover': return { documents: documents.map(document => ({ id: document.id, title: document.title })), events: events.map(event => event.id) }
      case 'snapshot': return { documents, events }
      case 'observe': return events[events.length - 1]
      case 'query': return { documents: [...documents], events: [...events] }
      case 'replay': return replay
      case 'verify': return { verified: true, eventCount: events.length }
      case 'export': return { format: 'json', documents, events, replay }
      case 'simulate': return { kind: 'simulation', candidate: true, projectedEvents: events.length + 1 }
      default: return { ok: false, error: { code: 'FIXTURE_UNSUPPORTED', category: 'capability', message: `unsupported ${request.capability}`, retryable: false } }
    }
  }
  const capabilities: ContextAdapterCapabilities = {
    discover: true,
    snapshot: true,
    observe: true,
    query: true,
    simulate: true,
    replay: true,
    verify: true,
    export: true,
  }
  return {
    adapterId,
    apiVersion: 'context-adapter.v1',
    version: '1.0.0',
    capabilities,
    sideEffect: 'candidate-only',
    generation,
    health: { status: 'healthy', checkedAt: '2026-11-13T00:00:00.000Z' },
    timeout: { defaultMs: 100, maxMs: 1000 },
    owner: { ownerId: options.ownerId ?? 'fixture-owner', dispose: async () => undefined },
    discover: operation,
    snapshot: operation,
    observe: operation,
    query: operation,
    simulate: operation,
    replay: operation,
    verify: operation,
    export: operation,
    drain: async () => undefined,
    retire: async () => undefined,
  }
}
