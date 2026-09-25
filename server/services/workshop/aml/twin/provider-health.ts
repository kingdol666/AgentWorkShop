import type { ProviderHealth, ProviderHealthStatus, TwinPhysicsProvider } from './provider-contracts'

export interface ProviderHealthOptions { timeoutMs?: number, now?: () => number }

function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' }
function status(value: unknown): ProviderHealthStatus {
  const raw = String(value ?? 'unknown').toLowerCase()
  if (raw === 'healthy' || raw === 'degraded' || raw === 'unhealthy' || raw === 'unknown') return raw
  if (raw === 'ok' || raw === 'ready' || raw === 'pass' || raw === 'passed') return 'healthy'
  if (raw === 'warn' || raw === 'warning') return 'degraded'
  if (raw === 'failed' || raw === 'fail' || raw === 'error') return 'unhealthy'
  return 'unknown'
}

export function normalizeProviderHealth(value: unknown, checkedAt = new Date().toISOString()): ProviderHealth {
  if (value === true) return { status: 'healthy', checkedAt, detail: 'Provider health check passed' }
  if (value === false) return { status: 'unhealthy', checkedAt, detail: 'Provider health check failed' }
  if (!isRecord(value)) return { status: 'unknown', checkedAt, detail: 'Provider does not expose a health result' }
  return {
    ...value,
    status: status(value.status ?? value.state),
    checkedAt: typeof value.checkedAt === 'string' && value.checkedAt ? value.checkedAt : checkedAt,
    detail: value.detail == null ? (value.message == null ? undefined : String(value.message)) : String(value.detail),
    latencyMs: Number.isFinite(Number(value.latencyMs)) ? Number(value.latencyMs) : undefined,
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Provider health check timed out')), timeoutMs)
    promise.then(value => { clearTimeout(timer); resolve(value) }, error => { clearTimeout(timer); reject(error) })
  })
}

export async function checkProviderHealth(provider: TwinPhysicsProvider, options: ProviderHealthOptions = {}): Promise<ProviderHealth> {
  const started = options.now?.() ?? Date.now()
  const checkedAt = new Date(started).toISOString()
  const hook = (provider as unknown as { health?: unknown }).health
  if (hook == null) return { status: 'unknown', checkedAt, detail: 'Provider health hook is not declared' }
  try {
    const raw = typeof hook === 'function' ? (hook as () => unknown)() : hook
    const result = normalizeProviderHealth(await withTimeout(Promise.resolve(raw), options.timeoutMs ?? 0), checkedAt)
    if (result.latencyMs == null) result.latencyMs = Math.max(0, (options.now?.() ?? Date.now()) - started)
    return result
  }
  catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return { status: 'unhealthy', checkedAt, detail, errors: [detail], latencyMs: Math.max(0, (options.now?.() ?? Date.now()) - started) }
  }
}

export function providerHealthAllowsUse(health: ProviderHealth): boolean { return health.status !== 'unhealthy' }
export function providerHealthIsHealthy(health: ProviderHealth): boolean { return health.status === 'healthy' }
