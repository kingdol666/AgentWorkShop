import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CONTEXT_ADAPTER_API_VERSION, type ContextAdapter } from '../server/services/workshop/context/contracts'
import { ContextAdapterRegistry, ContextAdapterRegistryError, CONTEXT_ADAPTER_ERROR_CODES } from '../server/services/workshop/context/registry'
import { ContextAdapterValidationError, normalizeAdapterResult, normalizeContextAdapter } from '../server/services/workshop/context/normalizer'
import { createDocumentEventReplayAdapter } from './fixtures/context-adapter-fixture'

function adapter(overrides: Partial<ContextAdapter> = {}): ContextAdapter {
  return {
    ...createDocumentEventReplayAdapter(),
    ...overrides,
    capabilities: { ...createDocumentEventReplayAdapter().capabilities, ...overrides.capabilities },
  }
}

test('normalizes the adapter contract and requires every declared capability operation', () => {
  const normalized = normalizeContextAdapter(adapter())
  assert.equal(normalized.apiVersion, CONTEXT_ADAPTER_API_VERSION)
  assert.equal(normalized.timeout.defaultMs, 100)
  assert.equal(normalized.capabilities.replay, true)
  assert.throws(() => normalizeContextAdapter(adapter({ capabilities: { ...adapter().capabilities, replay: true }, replay: undefined })), ContextAdapterValidationError)
})

test('registration is transactional when a batch contains malformed adapters', () => {
  const registry = new ContextAdapterRegistry()
  const good = adapter({ adapterId: 'good' })
  const bad = adapter({ adapterId: '' })
  assert.throws(() => registry.register([good, bad]), (error: unknown) => error instanceof ContextAdapterRegistryError && error.code === CONTEXT_ADAPTER_ERROR_CODES.INVALID_ADAPTER)
  assert.deepEqual(registry.list(), [])
})

test('invocation carries generation, idempotency, timeout and cancellation signal', async () => {
  const registry = new ContextAdapterRegistry()
  let received: { generation: number, idempotencyKey: string, signal: AbortSignal } | undefined
  const registered = adapter({
    adapterId: 'request-check',
    observe: async (request) => {
      received = { generation: request.generation, idempotencyKey: request.idempotencyKey, signal: request.signal }
      return { observed: true }
    },
    capabilities: { ...adapter().capabilities, observe: true },
  })
  registry.registerOne(registered)
  const result = await registry.invoke('request-check', 'observe', { ref: 'doc-1' }, { idempotencyKey: 'request-1' })
  assert.deepEqual(result, { ok: true, payload: { observed: true } })
  assert.equal(received?.generation, 1)
  assert.equal(received?.idempotencyKey, 'request-1')
  assert.ok(received?.signal instanceof AbortSignal)
})

test('caller cancellation and timeout abort the adapter operation and return structured errors', async () => {
  const registry = new ContextAdapterRegistry()
  const waiting = adapter({
    adapterId: 'cancel-check',
    observe: async ({ signal }) => await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('operation stopped')), { once: true })),
  })
  registry.registerOne(waiting)
  const controller = new AbortController()
  const cancelled = registry.invoke('cancel-check', 'observe', {}, { idempotencyKey: 'cancel-1', signal: controller.signal })
  controller.abort()
  await assert.rejects(cancelled, (error: unknown) => error instanceof ContextAdapterRegistryError && error.code === CONTEXT_ADAPTER_ERROR_CODES.ABORTED)
  const timed = registry.invoke('cancel-check', 'observe', {}, { idempotencyKey: 'timeout-1', timeoutMs: 1 })
  await assert.rejects(timed, (error: unknown) => error instanceof ContextAdapterRegistryError && error.code === CONTEXT_ADAPTER_ERROR_CODES.TIMEOUT)
})

test('capability mismatch, stale generation and malformed results fail closed', async () => {
  const registry = new ContextAdapterRegistry()
  registry.registerOne(adapter({ adapterId: 'guarded', generation: 2 }))
  await assert.rejects(() => registry.invoke('guarded', 'observe', {}, { idempotencyKey: 'x', generation: 1 }), (error: unknown) => error instanceof ContextAdapterRegistryError && error.code === CONTEXT_ADAPTER_ERROR_CODES.GENERATION_STALE)
  const noQuery = adapter({ adapterId: 'no-query', capabilities: { ...adapter().capabilities, query: false }, query: undefined })
  registry.registerOne(noQuery)
  await assert.rejects(() => registry.invoke('no-query', 'query', {}, { idempotencyKey: 'x' }), (error: unknown) => error instanceof ContextAdapterRegistryError && error.code === CONTEXT_ADAPTER_ERROR_CODES.CAPABILITY_UNSUPPORTED)
  const malformed = adapter({ adapterId: 'malformed', observe: async () => ({ ok: true }) })
  registry.registerOne(malformed)
  await assert.rejects(() => registry.invoke('malformed', 'observe', {}, { idempotencyKey: 'x' }), (error: unknown) => error instanceof ContextAdapterRegistryError && error.code === CONTEXT_ADAPTER_ERROR_CODES.MALFORMED_RESULT)
})

test('replacement drains the previous generation and owner disposal retires it', async () => {
  const lifecycle: string[] = []
  const first = adapter({ adapterId: 'reloadable', generation: 1, drain: async () => lifecycle.push('drain-1'), retire: async () => lifecycle.push('retire-1'), owner: { ownerId: 'owner-1', dispose: async () => lifecycle.push('dispose-1') } })
  const second = adapter({ adapterId: 'reloadable', generation: 2, drain: async () => lifecycle.push('drain-2'), retire: async () => lifecycle.push('retire-2'), owner: { ownerId: 'owner-2', dispose: async () => lifecycle.push('dispose-2') } })
  const registry = new ContextAdapterRegistry()
  registry.registerOne(first)
  registry.registerOne(second)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(registry.list().map(item => `${item.adapterId}@${item.generation}`), ['reloadable@2'])
  assert.deepEqual(lifecycle, ['drain-1', 'retire-1', 'dispose-1'])
  await registry.dispose()
  assert.deepEqual(lifecycle, ['drain-1', 'retire-1', 'dispose-1', 'drain-2', 'retire-2', 'dispose-2'])
})

test('reload re-registers a draining same-generation adapter and preserves the new active pointer', async () => {
  const lifecycle: string[] = []
  const first = adapter({
    adapterId: 'reload-reregister',
    generation: 1,
    observe: async request => ({ generation: request.generation, owner: 'first' }),
    drain: async () => lifecycle.push('drain-first'),
    retire: async () => lifecycle.push('retire-first'),
    owner: { ownerId: 'reload-owner', dispose: async () => lifecycle.push('dispose-first') },
  })
  const registry = new ContextAdapterRegistry()
  registry.registerOne(first)
  registry.unregister(first.adapterId, first.version)

  const second = adapter({
    adapterId: first.adapterId,
    version: first.version,
    generation: first.generation,
    observe: async request => ({ generation: request.generation, owner: 'second' }),
    owner: { ownerId: 'reload-owner', dispose: async () => lifecycle.push('dispose-second') },
  })
  const registration = registry.registerOne(second)
  assert.equal(registration.idempotent, undefined)
  assert.equal(registration.generation, 2)
  const invoked = await registry.invoke(first.adapterId, 'observe', {}, { idempotencyKey: 'reload-reregister-1', generation: registration.generation })
  assert.deepEqual(invoked, { ok: true, payload: { generation: 2, owner: 'second' } })

  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(registry.list().map(item => `${item.adapterId}@${item.generation}`), ['reload-reregister@2'])
  const stillActive = await registry.invoke(first.adapterId, 'observe', {}, { idempotencyKey: 'reload-reregister-2', generation: 2 })
  assert.deepEqual(stillActive, { ok: true, payload: { generation: 2, owner: 'second' } })
  assert.deepEqual(lifecycle, ['drain-first', 'retire-first', 'dispose-first'])
  await registry.dispose()
  assert.deepEqual(lifecycle, ['drain-first', 'retire-first', 'dispose-first', 'dispose-second'])
})

test('document/event/replay fixture exercises all capabilities without physical side effects', async () => {
  const registry = new ContextAdapterRegistry()
  registry.registerOne(createDocumentEventReplayAdapter({ adapterId: 'documents' }))
  for (const capability of ['discover', 'snapshot', 'observe', 'query', 'simulate', 'replay', 'verify', 'export'] as const) {
    const result = await registry.invoke('documents', capability, {}, { idempotencyKey: `fixture-${capability}` })
    assert.equal(result.ok, true)
  }
  assert.equal(registry.list()[0]?.sideEffect, 'candidate-only')
})

test('structured result normalization rejects malformed errors and preserves valid errors', () => {
  assert.deepEqual(normalizeAdapterResult({ ok: false, error: { code: 'FIXTURE', category: 'validation', message: 'bad payload', retryable: false } }), {
    ok: false,
    error: { code: 'FIXTURE', category: 'validation', message: 'bad payload', retryable: false },
  })
  assert.throws(() => normalizeAdapterResult({ ok: false, error: { code: 'FIXTURE' } }), ContextAdapterValidationError)
})
