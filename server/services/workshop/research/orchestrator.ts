import { canonicalHash } from '@/shared/context/hash'
import type { ContextAdapterRegistry } from '@/server/services/workshop/context/registry'
import type {
  ContextAdapterCapability,
  ContextAdapterResult,
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
import { assertResearchTransition } from './state'
import type {
  CandidateEvidenceEnvelope,
  ResearchCreateResult,
  ResearchExecutionOptions,
  ResearchPlan,
  ResearchRequest,
  ResearchRun,
  ResearchState,
  ResearchStep,
  ResearchVerdict,
  ResearchCounters,
  ResearchOrchestratorOptions,
} from './contracts'

export const RESEARCH_ERROR_CODES = {
  INVALID_REQUEST: 'RESEARCH_INVALID_REQUEST',
  NOT_FOUND: 'RESEARCH_NOT_FOUND',
  INVALID_STATE: 'RESEARCH_INVALID_STATE',
  ABORTED: 'RESEARCH_CANCELLED',
  EXPIRED: 'RESEARCH_EXPIRED',
  BUDGET_EXCEEDED: 'RESEARCH_BUDGET_EXCEEDED',
  ACTUATE_FORBIDDEN: 'RESEARCH_ACTUATE_FORBIDDEN',
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
  contextSnapshotId?: string
  researchCaseId?: string
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

function outputPayload(result: ContextAdapterResult): unknown {
  return result.ok ? result.payload : result.error
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
    const requestFingerprint = canonicalHash({ ...request, budget: normalizeResearchBudget(request.budget) })
    const existingId = this.idempotency.get(request.idempotencyKey)
    if (existingId) {
      const existing = this.runs.get(existingId)!
      const existingFingerprint = canonicalHash({ id: existing.id, idempotencyKey: existing.idempotencyKey, objective: existing.objective, question: existing.question, subjectRefs: existing.subjectRefs, scope: existing.scope, contextSnapshotId: existing.contextSnapshotId, researchCaseId: existing.researchCaseId, budget: existing.budget })
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
      ...(request.contextSnapshotId ? { contextSnapshotId: request.contextSnapshotId } : {}),
      ...(request.researchCaseId ? { researchCaseId: request.researchCaseId } : {}),
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

  plan(id: string, plan: ResearchPlan): ResearchRun {
    const run = this.mutable(id)
    this.transition(run, 'planned')
    if (!plan.id.trim() || plan.steps.length > run.budget.maxSteps) throw new ResearchOrchestratorError(RESEARCH_ERROR_CODES.INVALID_REQUEST, 'plan id is required and steps must fit the budget')
    const steps = plan.steps.map(step => this.normalizeStep(step))
    const counters = this.planCounters(steps, run.budget)
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
    this.transition(run, 'running')
    run.startedAt = this.now()
    const startedAtMs = Date.parse(run.startedAt)
    const signal = options.signal
    try {
      this.checkCancellation(signal)
      for (const [index, step] of run.plan.steps.entries()) {
        this.checkCancellation(signal)
        assertDuration(startedAtMs, Date.parse(this.now()), run.budget)
        if (step.capability === ('actuate' as ContextAdapterCapability) || step.capability.toLowerCase() === 'actuate') throw new ResearchOrchestratorError(RESEARCH_ERROR_CODES.ACTUATE_FORBIDDEN, 'research cannot actuate')
        const result = await this.registry.invoke(step.adapterId, step.capability, clone(step.payload), { idempotencyKey: `${run.id}:${step.id}`, signal })
        const payload = outputPayload(result)
        const outputBytes = jsonBytes(payload)
        const nextCounters = { ...run.counters, outputBytes: run.counters.outputBytes + outputBytes }
        assertBudgetMetric('outputBytes', nextCounters.outputBytes, run.budget.maxOutputBytes)
        run.counters = nextCounters
        const candidate = this.toCandidate(run, step, payload, index)
        this.candidates.add(candidate)
        run.evidenceIds.push(candidate.id)
      }
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
  }

  cancel(id: string): ResearchRun {
    const run = this.mutable(id)
    if (!['completed', 'failed', 'cancelled', 'expired'].includes(run.state)) this.transition(run, 'cancelled')
    run.endedAt ??= this.now()
    run.errorCode = RESEARCH_ERROR_CODES.ABORTED
    run.errorMessage = 'research cancelled'
    return freezeRun(run)
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
