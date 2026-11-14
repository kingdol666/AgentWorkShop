import { canonicalHash } from '@/shared/context/hash'
import { CONTEXT_ADAPTER_CAPABILITIES } from '@/server/services/workshop/context/contracts'
import { ContextAdapterRegistryError, CONTEXT_ADAPTER_ERROR_CODES } from '@/server/services/workshop/context/registry'
import type { ContextAdapterRegistry } from '@/server/services/workshop/context/registry'
import type {
  ContextAdapterCapability,
  ContextRef,
} from '@/server/services/workshop/context/contracts'
import { normalizeCandidateEvidence } from '../evidence/normalizer'
import { CandidateEvidenceStore } from '../evidence/candidate-store'
import {
  assertBudgetMetric,
  assertCounters,
  assertDuration,
  jsonBytes,
  normalizeResearchBudget,
  ResearchBudgetError,
} from './budget'
import { assertResearchTransition, RESEARCH_STATE_TRANSITIONS } from './state'
import type {
  CandidateEvidenceEnvelope,
  ResearchCreateResult,
  ResearchExecutionOptions,
  ResearchPlan,
  ResearchRequest,
  ResearchRun,
  ResearchCapability,
  ResearchState,
  ResearchStep,
  ResearchVerdict,
  ResearchCounters,
  ResearchOrchestratorOptions,
} from './contracts'
import { SAFE_READ_ONLY_CAPABILITIES } from './contracts'

export const RESEARCH_ERROR_CODES = {
  INVALID_REQUEST: 'RESEARCH_INVALID_REQUEST',
  NOT_FOUND: 'RESEARCH_NOT_FOUND',
  INVALID_STATE: 'RESEARCH_INVALID_STATE',
  ABORTED: 'RESEARCH_CANCELLED',
  EXPIRED: 'RESEARCH_EXPIRED',
  BUDGET_EXCEEDED: 'RESEARCH_BUDGET_EXCEEDED',
  ACTUATE_FORBIDDEN: 'RESEARCH_ACTUATE_FORBIDDEN',
  CAPABILITY_UNDECLARED: 'RESEARCH_CAPABILITY_UNDECLARED',
  ADAPTER_FAILURE: 'RESEARCH_ADAPTER_FAILURE',
  IDEMPOTENCY_CONFLICT: 'RESEARCH_IDEMPOTENCY_CONFLICT',
} as const

export class ResearchOrchestratorError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'ResearchOrchestratorError'
    this.code = code
  }
}

type MutableRun = {
  id: string
  idempotencyKey: string
  state: ResearchState
  objective: string
  question: string
  subjectRefs: readonly ContextRef[]
  scope: ResearchRequest['scope']
  principal?: ResearchRequest['principal']
  authorizationScope?: ResearchRequest['authorizationScope']
  contextSnapshotId?: string
  researchCaseId?: string
  allowedCapabilities: readonly ResearchCapability[]
  budget: ResearchRun['budget']
  plan?: ResearchPlan
  counters: ResearchCounters
  evidenceIds: string[]
  verdict?: ResearchVerdict
  errorCode?: string
  errorMessage?: string
  createdAt: string
  startedAt?: string
  endedAt?: string
}

function nowDefault(): string {
  return new Date().toISOString()
}

function idDefault(prefix: string): string {
  return `${prefix}-${canonicalHash({ prefix, at: nowDefault(), random: Math.random() }).slice(0, 24)}`
}

function freezeRun(run: MutableRun): ResearchRun {
  return Object.freeze({
    ...run,
    subjectRefs: Object.freeze([...run.subjectRefs]),
    scope: Object.freeze({ ...run.scope }),
    allowedCapabilities: Object.freeze([...run.allowedCapabilities]),
    counters: Object.freeze({ ...run.counters }),
    evidenceIds: Object.freeze([...run.evidenceIds]),
    ...(run.plan ? { plan: Object.freeze({ ...run.plan, steps: Object.freeze([...run.plan.steps]) }) } : {}),
    ...(run.verdict ? { verdict: Object.freeze({ ...run.verdict, evidenceIds: Object.freeze([...run.verdict.evidenceIds]) }) } : {}),
  }) as ResearchRun
}

function clone(value: unknown): unknown {
  if (value === undefined) return undefined
  return structuredClone(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export interface ResearchOrchestrator {
  create(request: ResearchRequest): ResearchCreateResult
  get(id: string): ResearchRun
  plan(id: string, plan: ResearchPlan): ResearchRun
  approveRead(id: string): ResearchRun
  execute(id: string, options?: ResearchExecutionOptions): Promise<ResearchRun>
  cancel(id: string): ResearchRun
}

/**
 * Service-local bounded research. The registry is the only execution boundary;
 * this service deliberately exposes no actuate operation and performs no I/O.
 */
export class LocalResearchOrchestrator implements ResearchOrchestrator {
  private readonly runs = new Map<string, MutableRun>()
  private readonly idempotency = new Map<string, string>()
  private readonly registry: ContextAdapterRegistry
  private readonly candidates: CandidateEvidenceStore
  private readonly now: () => string
  private readonly createId: (prefix: string) => string
  private readonly controllers = new Map<string, AbortController>()
  constructor(registry: ContextAdapterRegistry, candidates = new CandidateEvidenceStore(), options: ResearchOrchestratorOptions = {}) {
    this.registry = registry
    this.candidates = candidates
    this.now = options.now ?? nowDefault
    this.createId = options.createId ?? idDefault
  }

  create(request: ResearchRequest): ResearchCreateResult {
    if (!request.id.trim() || !request.idempotencyKey.trim() || !request.objective.trim() || !request.question.trim() || request.subjectRefs.length === 0) {
      throw new ResearchOrchestratorError(RESEARCH_ERROR_CODES.INVALID_REQUEST, 'id, idempotencyKey, objective, question, and subjectRefs are required')
    }
    const allowedCapabilities = normalizeAllowedCapabilities(request.allowedCapabilities)
    const requestFingerprint = canonicalHash({
      id: request.id,
      idempotencyKey: request.idempotencyKey,
      objective: request.objective,
      question: request.question,
      subjectRefs: request.subjectRefs,
      scope: request.scope,
      principal: request.principal,
      authorizationScope: request.authorizationScope,
      contextSnapshotId: request.contextSnapshotId,
      researchCaseId: request.researchCaseId,
      allowedCapabilities,
      budget: normalizeResearchBudget(request.budget),
    })
    const existingId = this.idempotency.get(request.idempotencyKey)
    if (existingId) {
      const existing = this.runs.get(existingId)!
      const existingFingerprint = canonicalHash({ id: existing.id, idempotencyKey: existing.idempotencyKey, objective: existing.objective, question: existing.question, subjectRefs: existing.subjectRefs, scope: existing.scope, principal: existing.principal, authorizationScope: existing.authorizationScope, contextSnapshotId: existing.contextSnapshotId, researchCaseId: existing.researchCaseId, allowedCapabilities: existing.allowedCapabilities, budget: existing.budget })
      if (existingFingerprint !== requestFingerprint) throw new ResearchOrchestratorError(RESEARCH_ERROR_CODES.IDEMPOTENCY_CONFLICT, `idempotency key ${request.idempotencyKey} conflicts with an existing request`)
      return { run: freezeRun(existing), idempotent: true }
    }
    if (this.runs.has(request.id)) throw new ResearchOrchestratorError(RESEARCH_ERROR_CODES.IDEMPOTENCY_CONFLICT, `research run ${request.id} already exists`)
    const run: MutableRun = {
      id: request.id,
      idempotencyKey: request.idempotencyKey,
      state: 'draft',
      objective: request.objective,
      question: request.question,
      subjectRefs: Object.freeze([...request.subjectRefs]),
      scope: Object.freeze({ ...request.scope }),
      ...(request.principal ? { principal: Object.freeze({ ...request.principal }) } : {}),
      ...(request.authorizationScope ? { authorizationScope: Object.freeze({ ...request.authorizationScope }) } : {}),
      ...(request.contextSnapshotId ? { contextSnapshotId: request.contextSnapshotId } : {}),
      ...(request.researchCaseId ? { researchCaseId: request.researchCaseId } : {}),
      allowedCapabilities,
      budget: normalizeResearchBudget(request.budget),
      counters: { steps: 0, bytes: 0, sources: 0, outputBytes: 0, rsiIterations: 0 },
      evidenceIds: [],
      createdAt: this.now(),
    }
    this.runs.set(run.id, run)
    this.idempotency.set(run.idempotencyKey, run.id)
    return { run: freezeRun(run), idempotent: false }
  }

  get(id: string): ResearchRun {
    const run = this.runs.get(id)
    if (!run) throw new ResearchOrchestratorError(RESEARCH_ERROR_CODES.NOT_FOUND, `research run ${id} was not found`)
    return freezeRun(run)
  }

  list(): readonly ResearchRun[] {
    return Object.freeze([...this.runs.values()].map(freezeRun))
  }

  /** Return a JSON-safe snapshot of runs and idempotency state. */
  serialize(): { runs: readonly ResearchRun[], idempotency: Readonly<Record<string, string>> } {
    return {
      runs: Object.freeze(this.list().map(run => structuredClone(run))),
      idempotency: Object.freeze(Object.fromEntries(this.idempotency.entries())),
    }
  }

  /** Restore draft and terminal state only; in-flight execution never survives restart. */
  restore(snapshot: unknown): void {
    if (!isRecord(snapshot) || !Array.isArray(snapshot.runs)) throw new ResearchOrchestratorError(RESEARCH_ERROR_CODES.INVALID_REQUEST, 'research snapshot is invalid')
    const restored = snapshot.runs.map(value => this.restoreRun(value))
    const idempotency = isRecord(snapshot.idempotency) ? snapshot.idempotency : {}
    for (const run of restored) {
      if (this.runs.has(run.id)) throw new ResearchOrchestratorError(RESEARCH_ERROR_CODES.IDEMPOTENCY_CONFLICT, `research run ${run.id} already exists`)
      this.runs.set(run.id, run)
      this.idempotency.set(run.idempotencyKey, run.id)
    }
    for (const [key, id] of Object.entries(idempotency)) {
      if (this.idempotency.get(key) !== id) throw new ResearchOrchestratorError(RESEARCH_ERROR_CODES.IDEMPOTENCY_CONFLICT, `idempotency key ${key} does not match its research run`)
    }
  }

  plan(id: string, plan: ResearchPlan): ResearchRun {
    const run = this.mutable(id)
    if (!plan.id.trim() || plan.steps.length > run.budget.maxSteps) throw new ResearchOrchestratorError(RESEARCH_ERROR_CODES.INVALID_REQUEST, 'plan id is required and steps must fit the budget')
    const steps = plan.steps.map(step => this.normalizeStep(step))
    this.assertAllowedCapabilities(run, steps)
    const counters = this.planCounters(steps, run.budget)
    this.transition(run, 'planned')
    run.plan = Object.freeze({ id: plan.id, steps: Object.freeze(steps), ...(plan.verdict ? { verdict: plan.verdict } : {}) })
    run.counters = counters
    return freezeRun(run)
  }

  approveRead(id: string): ResearchRun {
    const run = this.mutable(id)
    this.transition(run, 'read-approval')
    return freezeRun(run)
  }

  async execute(id: string, options: ResearchExecutionOptions = {}): Promise<ResearchRun> {
    const run = this.mutable(id)
    if (!run.plan) throw new ResearchOrchestratorError(RESEARCH_ERROR_CODES.INVALID_STATE, 'a research plan is required before execution')
    this.assertAllowedCapabilities(run, run.plan.steps)
    this.transition(run, 'running')
    run.startedAt = this.now()
    const startedAtMs = Date.parse(run.startedAt)
    const controller = new AbortController()
    const previousController = this.controllers.get(run.id)
    previousController?.abort()
    this.controllers.set(run.id, controller)
    const onAbort = () => controller.abort(options.signal?.reason)
    options.signal?.addEventListener('abort', onAbort, { once: true })
    if (options.signal?.aborted) controller.abort(options.signal.reason)
    const signal = controller.signal
    let deadlineBoundAdapterCall = false
    try {
      this.checkCancellation(signal)
      const pendingCandidates: CandidateEvidenceEnvelope[] = []
      for (const [index, step] of run.plan.steps.entries()) {
        this.checkCancellation(signal)
        assertDuration(startedAtMs, Date.parse(this.now()), run.budget)
        if (step.capability === ('actuate' as ContextAdapterCapability) || step.capability.toLowerCase() === 'actuate') throw new ResearchOrchestratorError(RESEARCH_ERROR_CODES.ACTUATE_FORBIDDEN, 'research cannot actuate')
        const remainingMs = run.budget.maxDurationMs - Math.max(0, Date.parse(this.now()) - startedAtMs)
        if (remainingMs <= 0) {
          throw new ResearchBudgetError('RESEARCH_BUDGET_EXCEEDED', 'duration budget exceeded', { metric: 'durationMs', limit: run.budget.maxDurationMs, actual: run.budget.maxDurationMs - remainingMs })
        }
        const adapter = this.registry.list().find(item => item.adapterId === step.adapterId && item.state === 'ready')
        const timeoutMs = Math.min(Math.floor(remainingMs), adapter?.timeout.maxMs ?? Math.floor(remainingMs))
        deadlineBoundAdapterCall = timeoutMs === Math.floor(remainingMs)
        if (timeoutMs <= 0) {
          throw new ResearchBudgetError('RESEARCH_BUDGET_EXCEEDED', 'duration budget exceeded', { metric: 'durationMs', limit: run.budget.maxDurationMs, actual: run.budget.maxDurationMs - remainingMs })
        }
        const result = await this.registry.invoke(step.adapterId, step.capability, clone(step.payload), {
          idempotencyKey: `${run.id}:${step.id}`,
          signal,
          timeoutMs,
          ...(options.principal ?? run.principal ? { principal: options.principal ?? run.principal } : {}),
          ...(options.authorizationScope ?? run.authorizationScope ? { scope: options.authorizationScope ?? run.authorizationScope } : {}),
        })
        this.checkCancellation(signal)
        if (!result.ok) {
          throw new ResearchOrchestratorError(RESEARCH_ERROR_CODES.ADAPTER_FAILURE, `${step.adapterId} ${step.capability} failed: ${result.error.code}: ${result.error.message}`)
        }
        const payload = result.payload
        this.checkCancellation(signal)
        const outputBytes = jsonBytes(payload)
        const nextCounters = { ...run.counters, outputBytes: run.counters.outputBytes + outputBytes }
        assertBudgetMetric('outputBytes', nextCounters.outputBytes, run.budget.maxOutputBytes)
        run.counters = nextCounters
        this.checkCancellation(signal)
        const candidate = this.toCandidate(run, step, payload, index)
        this.checkCancellation(signal)
        pendingCandidates.push(candidate)
      }
      this.checkCancellation(signal)
      this.candidates.addMany(pendingCandidates)
      run.evidenceIds.push(...pendingCandidates.map(candidate => candidate.id))
      this.transition(run, 'verdict')
      run.verdict = { summary: run.plan.verdict ?? 'bounded research completed with candidate evidence', claimLevel: 'candidate', evidenceIds: [...run.evidenceIds] }
      this.transition(run, 'evidence-candidate')
      this.transition(run, 'completed')
      run.endedAt = this.now()
      return freezeRun(run)
    }
    catch (error) {
      run.endedAt = this.now()
      if (error instanceof ResearchOrchestratorError && error.code === RESEARCH_ERROR_CODES.ACTUATE_FORBIDDEN) {
        run.errorCode = error.code
        run.errorMessage = error.message
        this.transitionIfAllowed(run, 'failed')
        throw error
      }
      if (error instanceof ResearchBudgetError) {
        run.errorCode = error.code
        run.errorMessage = error.message
        this.transitionIfAllowed(run, error.metric === 'durationMs' ? 'expired' : 'failed')
        throw new ResearchOrchestratorError(error.metric === 'durationMs' ? RESEARCH_ERROR_CODES.EXPIRED : RESEARCH_ERROR_CODES.BUDGET_EXCEEDED, error.message)
      }
      if (error instanceof ContextAdapterRegistryError && error.code === CONTEXT_ADAPTER_ERROR_CODES.TIMEOUT && deadlineBoundAdapterCall) {
        const expired = new ResearchOrchestratorError(RESEARCH_ERROR_CODES.EXPIRED, 'duration budget exceeded')
        run.errorCode = expired.code
        run.errorMessage = expired.message
        this.transitionIfAllowed(run, 'expired')
        throw expired
      }
      if (this.isAbort(error, signal)) {
        run.errorCode = RESEARCH_ERROR_CODES.ABORTED
        run.errorMessage = 'research cancelled'
        this.transitionIfAllowed(run, 'cancelled')
        throw new ResearchOrchestratorError(RESEARCH_ERROR_CODES.ABORTED, 'research cancelled')
      }
      run.errorCode = error instanceof ResearchOrchestratorError ? error.code : RESEARCH_ERROR_CODES.ADAPTER_FAILURE
      run.errorMessage = error instanceof Error ? error.message : String(error)
      this.transitionIfAllowed(run, 'failed')
      throw error
    }
    finally {
      options.signal?.removeEventListener('abort', onAbort)
      if (this.controllers.get(run.id) === controller) this.controllers.delete(run.id)
    }
  }

  cancel(id: string): ResearchRun {
    const run = this.mutable(id)
    this.controllers.get(id)?.abort()
    if (!['completed', 'failed', 'cancelled', 'expired'].includes(run.state)) this.transition(run, 'cancelled')
    run.endedAt ??= this.now()
    run.errorCode = RESEARCH_ERROR_CODES.ABORTED
    run.errorMessage = 'research cancelled'
    return freezeRun(run)
  }

  private restoreRun(value: unknown): MutableRun {
    if (!isRecord(value) || typeof value.id !== 'string' || typeof value.idempotencyKey !== 'string' || typeof value.objective !== 'string' || typeof value.question !== 'string' || !Array.isArray(value.subjectRefs) || !isRecord(value.scope) || !isRecord(value.budget) || !isRecord(value.counters) || !Array.isArray(value.evidenceIds) || typeof value.createdAt !== 'string') {
      throw new ResearchOrchestratorError(RESEARCH_ERROR_CODES.INVALID_REQUEST, 'research snapshot contains an invalid run')
    }
    const state = value.state
    if (typeof state !== 'string' || !Object.prototype.hasOwnProperty.call(RESEARCH_STATE_TRANSITIONS, state)) throw new ResearchOrchestratorError(RESEARCH_ERROR_CODES.INVALID_REQUEST, 'research snapshot contains an invalid state')
    const run: MutableRun = {
      id: value.id,
      idempotencyKey: value.idempotencyKey,
      state: state as ResearchState,
      objective: value.objective,
      question: value.question,
      subjectRefs: Object.freeze(structuredClone(value.subjectRefs) as ContextRef[]),
      scope: Object.freeze(structuredClone(value.scope) as ResearchRequest['scope']),
      ...(isRecord(value.principal) && typeof value.principal.id === 'string' ? { principal: Object.freeze({ id: value.principal.id, ...(typeof value.principal.role === 'string' ? { role: value.principal.role } : {}) }) } : {}),
      ...(isRecord(value.authorizationScope) ? { authorizationScope: Object.freeze(structuredClone(value.authorizationScope) as ResearchRequest['authorizationScope']) } : {}),
      ...(typeof value.contextSnapshotId === 'string' ? { contextSnapshotId: value.contextSnapshotId } : {}),
      ...(typeof value.researchCaseId === 'string' ? { researchCaseId: value.researchCaseId } : {}),
      allowedCapabilities: normalizeAllowedCapabilities(value.allowedCapabilities as ResearchCapability[] | undefined),
      budget: Object.freeze(structuredClone(value.budget) as unknown as ResearchRun['budget']),
      ...(isRecord(value.plan) ? { plan: Object.freeze(structuredClone(value.plan) as unknown as ResearchPlan) } : {}),
      counters: Object.freeze(structuredClone(value.counters) as unknown as ResearchCounters),
      evidenceIds: [...value.evidenceIds.filter(item => typeof item === 'string')],
      ...(isRecord(value.verdict) ? { verdict: Object.freeze(structuredClone(value.verdict) as unknown as ResearchVerdict) } : {}),
      ...(typeof value.errorCode === 'string' ? { errorCode: value.errorCode } : {}),
      ...(typeof value.errorMessage === 'string' ? { errorMessage: value.errorMessage } : {}),
      createdAt: value.createdAt,
      ...(typeof value.startedAt === 'string' ? { startedAt: value.startedAt } : {}),
      ...(typeof value.endedAt === 'string' ? { endedAt: value.endedAt } : {}),
    }
    if (run.state === 'running') {
      run.state = 'cancelled'
      run.errorCode = RESEARCH_ERROR_CODES.ABORTED
      run.errorMessage = 'research cancelled during restart'
      run.endedAt ??= this.now()
    }
    return run
  }

  private mutable(id: string): MutableRun {
    const run = this.runs.get(id)
    if (!run) throw new ResearchOrchestratorError(RESEARCH_ERROR_CODES.NOT_FOUND, `research run ${id} was not found`)
    return run
  }

  private transition(run: MutableRun, next: ResearchState): void {
    try {
      assertResearchTransition(run.state, next)
    }
    catch (error) {
      throw new ResearchOrchestratorError(RESEARCH_ERROR_CODES.INVALID_STATE, error instanceof Error ? error.message : String(error))
    }
    run.state = next
  }

  private transitionIfAllowed(run: MutableRun, next: ResearchState): void {
    try {
      assertResearchTransition(run.state, next)
      run.state = next
    }
    catch {
      // Terminal failure handling is best effort after the original error.
    }
  }

  private normalizeStep(step: ResearchStep): ResearchStep {
    if (!step.id.trim() || !step.adapterId.trim() || !step.sourceRef.trim()) throw new ResearchOrchestratorError(RESEARCH_ERROR_CODES.INVALID_REQUEST, 'research steps require id, adapterId, and sourceRef')
    if (step.capability === ('actuate' as ContextAdapterCapability) || step.capability.toLowerCase() === 'actuate') throw new ResearchOrchestratorError(RESEARCH_ERROR_CODES.ACTUATE_FORBIDDEN, 'research cannot actuate')
    return Object.freeze({ ...step, payload: clone(step.payload), ...(step.subjectRefs ? { subjectRefs: Object.freeze([...step.subjectRefs]) } : {}) })
  }

  private assertAllowedCapabilities(run: MutableRun, steps: readonly ResearchStep[]): void {
    const undeclared = steps.find(step => !run.allowedCapabilities.includes(step.capability))
    if (undeclared) {
      throw new ResearchOrchestratorError(RESEARCH_ERROR_CODES.CAPABILITY_UNDECLARED, `research step ${undeclared.id} uses undeclared capability ${undeclared.capability}`)
    }
  }

  private planCounters(steps: readonly ResearchStep[], budget: ResearchRun['budget']): ResearchCounters {
    const sources = new Set(steps.map(step => `${step.adapterId}:${step.sourceRef}:${step.sourceRevision ?? ''}`)).size
    const bytes = steps.reduce((total, step) => total + jsonBytes(step.payload), 0)
    const rsiIterations = steps.reduce((max, step) => Math.max(max, step.rsiIteration ?? 0), 0)
    const counters = { steps: steps.length, bytes, sources, outputBytes: 0, rsiIterations }
    assertCounters(counters, budget)
    return counters
  }

  private toCandidate(run: MutableRun, step: ResearchStep, payload: unknown, index: number): CandidateEvidenceEnvelope {
    const payloadHash = canonicalHash(payload)
    const sourceRef = `${step.sourceRef}#${index}`
    return normalizeCandidateEvidence({
      id: this.createId(`evidence-candidate-${run.id}-${step.id}`),
      kind: step.kind ?? 'observation',
      subjectRefs: step.subjectRefs ?? run.subjectRefs,
      researchCaseId: run.researchCaseId,
      researchRunId: run.id,
      ...(step.window ? { window: step.window } : {}),
      source: { adapterId: step.adapterId, sourceRef, ...(step.sourceRevision ? { sourceRevision: step.sourceRevision } : {}) },
      payloadRef: `research://${run.id}/${step.id}/${index}`,
      payloadHash,
      quality: step.quality ?? 'raw',
      claimLevel: 'candidate',
      accessScope: run.scope,
      ...(step.redaction ? { redaction: step.redaction } : {}),
      createdAt: this.now(),
    })
  }

  private checkCancellation(signal?: AbortSignal): void {
    if (signal?.aborted) throw new ResearchOrchestratorError(RESEARCH_ERROR_CODES.ABORTED, 'research cancelled')
  }

  private isAbort(error: unknown, signal?: AbortSignal): boolean {
    return Boolean(signal?.aborted) || (error instanceof ResearchOrchestratorError && error.code === RESEARCH_ERROR_CODES.ABORTED) || (isRecord(error) && error.code === 'CONTEXT_ADAPTER_ABORTED')
  }
}

export function createResearchOrchestrator(registry: ContextAdapterRegistry, candidates?: CandidateEvidenceStore, options?: ResearchOrchestratorOptions): LocalResearchOrchestrator {
  return new LocalResearchOrchestrator(registry, candidates, options)
}

function normalizeAllowedCapabilities(input?: readonly ResearchCapability[]): readonly ResearchCapability[] {
  if (input !== undefined && !Array.isArray(input)) {
    throw new ResearchOrchestratorError(RESEARCH_ERROR_CODES.INVALID_REQUEST, 'research allowedCapabilities must be an array')
  }
  const capabilities = input === undefined ? SAFE_READ_ONLY_CAPABILITIES : input
  const normalized = [...new Set(capabilities)]
  if (normalized.some(capability => !CONTEXT_ADAPTER_CAPABILITIES.includes(capability as ContextAdapterCapability))) {
    throw new ResearchOrchestratorError(RESEARCH_ERROR_CODES.INVALID_REQUEST, 'research allowedCapabilities contains an unsupported capability')
  }
  return Object.freeze(normalized as ResearchCapability[])
}
