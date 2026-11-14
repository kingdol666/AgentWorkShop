import type { ContextRef, ContextScope, ContextSnapshot } from '@/shared/context/contracts'

export * from '@/shared/context/contracts'
export * from '@/shared/context/refs'
export * from '@/shared/context/hash'

export const CONTEXT_ADAPTER_API_VERSION = 'context-adapter.v1' as const

export const CONTEXT_ADAPTER_CAPABILITIES = [
  'discover',
  'snapshot',
  'observe',
  'query',
  'simulate',
  'replay',
  'verify',
  'export',
] as const

export type ContextAdapterCapability = typeof CONTEXT_ADAPTER_CAPABILITIES[number]
export type ContextAdapterSideEffect = 'none' | 'candidate-only'
export type MaybePromise<T> = T | Promise<T>

export type ContextAdapterCapabilities = {
  [capability in ContextAdapterCapability]: boolean
}

export type ContextAdapterHealthStatus = 'healthy' | 'degraded' | 'unhealthy' | 'unknown'

export interface ContextAdapterHealth {
  status: ContextAdapterHealthStatus
  checkedAt?: string
  message?: string
  latencyMs?: number
  details?: Record<string, unknown>
}

export interface ContextAdapterTimeoutPolicy {
  defaultMs: number
  maxMs: number
}

export type ContextAdapterTimeout = number | ContextAdapterTimeoutPolicy

export interface ContextAdapterOwner {
  ownerId: string
  dispose(context: ContextAdapterLifecycleContext): MaybePromise<void>
}

export interface ContextAdapterLifecycleContext {
  adapterId: string
  version: string
  generation: number
  reason: 'replaced' | 'unregistered' | 'owner-disposed' | 'registry-disposed'
  inFlight: number
  signal: AbortSignal
}

export type ContextAdapterAuthorizationScope = ContextScope & {
  workspaceId?: string
  channelId?: string
  workerId?: string
}

export type ContextAdapterAuthorizationContext = {
  scope: ContextAdapterAuthorizationScope
  principal: { id: string, role?: string }
  /** Derived bindings returned by authorization; never accepted from caller input. */
  lineIds: readonly string[]
}

export type ContextAdapterAuthorizationInput = {
  adapterId: string
  capability: ContextAdapterCapability
  payload: unknown
  principal?: { id: string, role?: string }
  scope?: ContextAdapterAuthorizationScope
}

export type ContextAdapterAuthorizer = (input: ContextAdapterAuthorizationInput) => MaybePromise<ContextAdapterAuthorizationContext | false>

export interface ContextAdapterOperationRequest<TPayload = unknown> {
  adapterId: string
  apiVersion: string
  version: string
  generation: number
  capability: ContextAdapterCapability
  payload: TPayload
  idempotencyKey: string
  timeoutMs: number
  signal: AbortSignal
  authorization?: ContextAdapterAuthorizationContext
}

export type ContextAdapterOperation
  = (request: ContextAdapterOperationRequest) => MaybePromise<unknown>

export type ContextAdapterErrorCategory
  = 'validation'
    | 'capability'
    | 'generation'
    | 'lifecycle'
    | 'timeout'
    | 'cancellation'
    | 'unavailable'
    | 'conflict'
    | 'internal'

export interface StructuredAdapterError {
  code: string
  category: ContextAdapterErrorCategory
  message: string
  retryable: boolean
  details?: Record<string, unknown>
}

export interface ContextAdapterSuccess {
  ok: true
  payload: unknown
  metadata?: Record<string, unknown>
}

export interface ContextAdapterFailure {
  ok: false
  error: StructuredAdapterError
}

export type ContextAdapterResult = ContextAdapterSuccess | ContextAdapterFailure

export interface ContextAdapter {
  adapterId: string
  apiVersion: string
  version: string
  capabilities: ContextAdapterCapabilities
  sideEffect: ContextAdapterSideEffect
  generation: number
  health: ContextAdapterHealth | (() => MaybePromise<unknown>)
  timeout: ContextAdapterTimeout
  owner: ContextAdapterOwner
  /** Industrial adapters must be invoked through an authorized runtime context. */
  requiresAuthorization?: boolean
  /** Optional host authorizer; direct registry calls use it when present. */
  authorize?: ContextAdapterAuthorizer
  discover?: ContextAdapterOperation
  snapshot?: ContextAdapterOperation
  observe?: ContextAdapterOperation
  query?: ContextAdapterOperation
  simulate?: ContextAdapterOperation
  replay?: ContextAdapterOperation
  verify?: ContextAdapterOperation
  export?: ContextAdapterOperation
  drain(context: ContextAdapterLifecycleContext): MaybePromise<void>
  retire(context: ContextAdapterLifecycleContext): MaybePromise<void>
}

export interface NormalizedContextAdapter extends Omit<ContextAdapter, 'health' | 'timeout'> {
  health: ContextAdapterHealth | (() => MaybePromise<unknown>)
  timeout: ContextAdapterTimeoutPolicy
}

export interface ContextAdapterInvokeOptions {
  idempotencyKey: string
  signal?: AbortSignal
  timeoutMs?: number
  generation?: number
  authorization?: ContextAdapterAuthorizationContext
  principal?: { id: string, role?: string }
  scope?: ContextAdapterAuthorizationScope
}

export type ContextAdapterLifecycleState = 'ready' | 'draining' | 'retired' | 'failed'

export interface ContextAdapterSummary {
  adapterId: string
  apiVersion: string
  version: string
  generation: number
  capabilities: ContextAdapterCapabilities
  sideEffect: ContextAdapterSideEffect
  health: ContextAdapterHealth
  timeout: ContextAdapterTimeoutPolicy
  ownerId: string
  state: ContextAdapterLifecycleState
  inFlight: number
  registeredAt: string
  drainingAt?: string
  retiredAt?: string
  errors: readonly StructuredAdapterError[]
}

export interface ContextAdapterRegistrationResult {
  ok: true
  adapterId: string
  version: string
  generation: number
  state: 'ready'
  idempotent?: boolean
  drainedGenerations: number[]
}

export interface ContextAdapterDrainResult {
  ok: true
  adapterId: string
  generation: number
  state: ContextAdapterLifecycleState
  inFlight: number
  retired: boolean
}

export interface ContextAdapterRetireResult {
  ok: true
  adapterId: string
  generation: number
  state: ContextAdapterLifecycleState
  inFlight: number
  retired: boolean
}

/** Common payload shape used by test fixtures and simple document/event adapters. */
export interface ContextAdapterFixturePayload {
  refs?: ContextRef[]
  scope?: ContextScope
  snapshot?: ContextSnapshot
  [key: string]: unknown
}

export type OperationalContextAdapter = ContextAdapter
export type OperationalContextAdapterRegistryResult = ContextAdapterRegistrationResult
export type AdapterCapabilities = ContextAdapterCapabilities
