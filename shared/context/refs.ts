import { z } from 'zod'

/** A stable, domain-neutral identifier. The namespace is the extension boundary. */
export const contextNamespaceSchema = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-z][a-z0-9]*(?:[-_.][a-z0-9]+)*$/, 'namespace must be lowercase and qualified')

export const contextIdSchema = z.string().trim().min(1).max(240)
export const revisionSchema = z.string().trim().min(1).max(120)

export const contextRefSchema = z.object({
  namespace: contextNamespaceSchema,
  id: contextIdSchema,
  revision: revisionSchema.optional(),
})
export type ContextRef = z.infer<typeof contextRefSchema>

export const isoTimestampSchema = z.string().trim().refine((value) => {
  // Date.parse accepts date-only strings; context windows require an instant.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return false
  return Number.isFinite(Date.parse(value))
}, 'must be an ISO-8601 timestamp with an explicit timezone')
export type IsoTimestamp = z.infer<typeof isoTimestampSchema>

export const contextWindowSchema = z.object({
  from: isoTimestampSchema,
  to: isoTimestampSchema,
})
export type ContextWindow = z.infer<typeof contextWindowSchema>

export const redactionSchema = z.object({
  status: z.enum(['none', 'partial', 'full']).default('none'),
  policyRef: z.string().trim().min(1).max(240).optional(),
  fields: z.array(z.string().trim().min(1).max(240)).default([]),
  reason: z.string().trim().max(500).optional(),
})
export type Redaction = z.infer<typeof redactionSchema>

/**
 * A provenance pointer, not a copy of the source payload. Source adapters are
 * intentionally identified by open strings so extensions do not need a core
 * registry or a domain-specific enum.
 */
export const provenanceRefSchema = z.object({
  adapterId: z.string().trim().min(1).max(200),
  sourceRef: z.string().trim().min(1).max(500),
  sourceRevision: revisionSchema.optional(),
  capturedAt: isoTimestampSchema.optional(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/i, 'contentHash must be a SHA-256 hex digest').optional(),
  redaction: redactionSchema.optional(),
})
export type ProvenanceRef = z.infer<typeof provenanceRefSchema>

const refList = z.array(contextRefSchema)

/** Scope is an authorization and visibility boundary, not a domain model. */
export const contextScopeSchema = z.object({
  tenantId: contextIdSchema.optional(),
  workspaceId: contextIdSchema.optional(),
  subjectRefs: refList.optional(),
  objectRefs: refList.optional(),
  attributeRefs: refList.optional(),
  materialAssignmentRefs: refList.optional(),
  tags: z.array(z.string().trim().min(1).max(120)).max(100).optional(),
  timeWindow: contextWindowSchema.optional(),
})
export type ContextScope = z.infer<typeof contextScopeSchema>

export function refKey(ref: ContextRef): string {
  return `${ref.namespace}:${ref.id}:${ref.revision ?? ''}`
}

export function sameRef(left: ContextRef, right: ContextRef): boolean {
  return refKey(left) === refKey(right)
}

export function isContextRef(value: unknown): value is ContextRef {
  return contextRefSchema.safeParse(value).success
}

export function isIsoTimestamp(value: string): boolean {
  return isoTimestampSchema.safeParse(value).success
}
