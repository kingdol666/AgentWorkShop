import type { CandidateEvidenceEnvelope, CandidateEvidenceRef } from '../research/contracts'
import { candidateEvidenceRef } from './normalizer'
import { canonicalHash } from '@/shared/context/hash'
import { validateEvidenceEnvelope } from '../context/validator'

export const CANDIDATE_STORE_ERROR_CODES = {
  DUPLICATE_ID: 'EVIDENCE_CANDIDATE_DUPLICATE_ID',
  HASH_CONFLICT: 'EVIDENCE_CANDIDATE_HASH_CONFLICT',
  NOT_FOUND: 'EVIDENCE_CANDIDATE_NOT_FOUND',
  IMMUTABLE: 'EVIDENCE_CANDIDATE_IMMUTABLE',
} as const

export class CandidateEvidenceStoreError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'CandidateEvidenceStoreError'
    this.code = code
  }
}

function assertCandidate(value: CandidateEvidenceEnvelope): void {
  if (value.candidateOnly !== true || value.claimLevel !== 'candidate') {
    throw new CandidateEvidenceStoreError(CANDIDATE_STORE_ERROR_CODES.IMMUTABLE, 'only candidate-only evidence may enter the local store')
  }
}

/**
 * P1 完整性(2026-11-14):结构/声明/内容哈希校验从 restore 提升为 add 入口不变式 ——
 * 任何内部调用方注入畸形/篡改候选在插入即拒,不再等到恢复时才暴露。
 */
function assertValidCandidate(value: CandidateEvidenceEnvelope): void {
  assertCandidate(value)
  const issues = validateEvidenceEnvelope(value)
  if (issues.length) throw new CandidateEvidenceStoreError(CANDIDATE_STORE_ERROR_CODES.IMMUTABLE, issues.map(issue => `${issue.path}: ${issue.message}`).join('; '))
  const expectedContentHash = canonicalHash(Object.fromEntries(Object.entries(value as unknown as Record<string, unknown>).filter(([key]) => key !== 'candidateOnly' && key !== 'contentHash')))
  if (value.contentHash !== expectedContentHash) throw new CandidateEvidenceStoreError(CANDIDATE_STORE_ERROR_CODES.HASH_CONFLICT, `candidate ${value.id} has invalid content hash`)
}

/** 深冻结(候选不可变契约:顶层与嵌套都不可改) */
function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value
  seen.add(value)
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested, seen)
  return Object.freeze(value)
}

/** In-memory, append-only candidate store with explicit JSON snapshot hooks. */
export class CandidateEvidenceStore {
  private readonly records = new Map<string, CandidateEvidenceEnvelope>()

  add(value: CandidateEvidenceEnvelope): CandidateEvidenceRef {
    assertCandidate(value)
    const existing = this.records.get(value.id)
    if (existing) {
      // 追加不变式(既有语义):同 id 不同内容 → immutable 冲突
      if (existing.contentHash !== value.contentHash) throw new CandidateEvidenceStoreError(CANDIDATE_STORE_ERROR_CODES.HASH_CONFLICT, `candidate ${value.id} has immutable content`)
      return candidateEvidenceRef(existing)
    }
    // P1 完整性:新插入必须在入口全量校验(结构/声明/内容哈希),入库即深冻结
    assertValidCandidate(value)
    this.records.set(value.id, deepFreeze(structuredClone(value)))
    return candidateEvidenceRef(value)
  }

  addMany(values: readonly CandidateEvidenceEnvelope[]): readonly CandidateEvidenceRef[] {
    const refs: CandidateEvidenceRef[] = []
    for (const value of values) refs.push(this.add(value))
    return Object.freeze(refs)
  }

  get(id: string): CandidateEvidenceEnvelope | undefined {
    return this.records.get(id)
  }

  require(id: string): CandidateEvidenceEnvelope {
    const value = this.get(id)
    if (!value) throw new CandidateEvidenceStoreError(CANDIDATE_STORE_ERROR_CODES.NOT_FOUND, `candidate ${id} was not found`)
    return value
  }

  list(): readonly CandidateEvidenceEnvelope[] {
    return Object.freeze([...this.records.values()])
  }

  refs(): readonly CandidateEvidenceRef[] {
    return Object.freeze([...this.records.values()].map(candidateEvidenceRef))
  }

  size(): number {
    return this.records.size
  }

  /** Return a JSON-safe immutable snapshot; candidates remain candidate-only. */
  serialize(): readonly CandidateEvidenceEnvelope[] {
    return Object.freeze(this.list().map(value => structuredClone(value)))
  }

  /** Restore a previously serialized snapshot, validating every record before publishing it. */
  restore(values: readonly CandidateEvidenceEnvelope[] | unknown): void {
    if (!Array.isArray(values)) throw new CandidateEvidenceStoreError(CANDIDATE_STORE_ERROR_CODES.IMMUTABLE, 'candidate snapshot must be an array')
    const restored: CandidateEvidenceEnvelope[] = []
    for (const value of values) {
      assertValidCandidate(value as CandidateEvidenceEnvelope)
      restored.push(structuredClone(value as CandidateEvidenceEnvelope))
    }
    for (const value of restored) this.add(value)
  }
}

export function createCandidateEvidenceStore(): CandidateEvidenceStore {
  return new CandidateEvidenceStore()
}
