import type { CandidateEvidenceEnvelope, CandidateEvidenceRef } from '../research/contracts'
import { candidateEvidenceRef } from './normalizer'

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

/** In-memory, append-only candidate store. It intentionally has no persistence hooks. */
export class CandidateEvidenceStore {
  private readonly records = new Map<string, CandidateEvidenceEnvelope>()

  add(value: CandidateEvidenceEnvelope): CandidateEvidenceRef {
    assertCandidate(value)
    const existing = this.records.get(value.id)
    if (existing) {
      if (existing.contentHash !== value.contentHash) throw new CandidateEvidenceStoreError(CANDIDATE_STORE_ERROR_CODES.HASH_CONFLICT, `candidate ${value.id} has immutable content`)
      return candidateEvidenceRef(existing)
    }
    this.records.set(value.id, value)
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
}

export function createCandidateEvidenceStore(): CandidateEvidenceStore {
  return new CandidateEvidenceStore()
}
