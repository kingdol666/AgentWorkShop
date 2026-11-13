import type { ZodIssue } from 'zod'

export const CONTEXT_ERROR_CODES = {
  INVALID_CONTRACT: 'CONTEXT_INVALID_CONTRACT',
  INVALID_REF: 'CONTEXT_INVALID_REF',
  INVALID_PROVENANCE: 'CONTEXT_INVALID_PROVENANCE',
  INVALID_WINDOW: 'CONTEXT_INVALID_WINDOW',
  INVALID_REDACTION: 'CONTEXT_INVALID_REDACTION',
  DANGLING_REF: 'CONTEXT_DANGLING_REF',
  DUPLICATE_REF: 'CONTEXT_DUPLICATE_REF',
  DUPLICATE_ASSIGNMENT: 'CONTEXT_DUPLICATE_ASSIGNMENT',
  INVALID_SCOPE: 'CONTEXT_INVALID_SCOPE',
  INVALID_QUALITY: 'CONTEXT_INVALID_QUALITY',
  INVALID_CLAIM_LEVEL: 'CONTEXT_INVALID_CLAIM_LEVEL',
  HASH_MISMATCH: 'CONTEXT_HASH_MISMATCH',
} as const

export type ContextErrorCode = typeof CONTEXT_ERROR_CODES[keyof typeof CONTEXT_ERROR_CODES]

export type ContextIssue = {
  code: ContextErrorCode
  path: string
  message: string
}

export class ContextValidationError extends Error {
  readonly code: ContextErrorCode
  readonly path: string
  readonly issues: readonly ContextIssue[]

  constructor(code: ContextErrorCode, message: string, path = '', issues: readonly ContextIssue[] = []) {
    super(message)
    this.name = 'ContextValidationError'
    this.code = code
    this.path = path
    this.issues = issues.length > 0 ? issues : [{ code, path, message }]
  }
}

export function zodIssues(issues: readonly ZodIssue[], code: ContextErrorCode = CONTEXT_ERROR_CODES.INVALID_CONTRACT): ContextIssue[] {
  return issues.map(issue => ({
    code,
    path: issue.path.join('.') || '$',
    message: issue.message,
  }))
}

export function firstContextError(issues: readonly ContextIssue[]): ContextValidationError {
  const first = issues[0] ?? {
    code: CONTEXT_ERROR_CODES.INVALID_CONTRACT,
    path: '$',
    message: 'context contract validation failed',
  }
  return new ContextValidationError(first.code, first.message, first.path, issues)
}
