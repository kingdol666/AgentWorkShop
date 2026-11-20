/** @typedef {'not_started' | 'incomplete' | 'terminal'} CheckExecution */
/** @typedef {'PASS' | 'FAIL' | 'PARTIAL' | 'BLOCKED' | 'NOT_RUN'} CheckStatus */
/** @typedef {{ execution: CheckExecution, blockedReason?: string, passed?: boolean }} CheckInput */
/** @typedef {'mechanism' | 'effect' | 'resilience' | 'field_admission'} CheckCategory */
/** @typedef {'simulation' | 'offline' | 'physical_hil' | 'production' | 'unknown'} RunEnvironment */
/** @typedef {'real_model' | 'fixture' | 'mixed' | 'unknown'} ModelProvenance */
/** @typedef {CheckInput & { id: string, category: CheckCategory }} BaselineCheck */
/** @typedef {'current' | 'historical'} CaptureOrigin */
/** @typedef {{ revision: string | null, runId: string, environment: RunEnvironment, modelProvenance: ModelProvenance, captureOrigin: CaptureOrigin, checks: readonly BaselineCheck[], missing: readonly { id: string, reason: string }[], captureHashes: Readonly<Record<string, string>> }} BaselineInput */

/** @param {CheckInput} input @returns {CheckStatus} */
export function classifyEvidenceCheck(input) {
  if (input.blockedReason?.trim()) return 'BLOCKED'
  if (input.execution === 'not_started') return 'NOT_RUN'
  if (input.execution === 'incomplete') return 'PARTIAL'
  if (input.execution !== 'terminal' || typeof input.passed !== 'boolean') return 'BLOCKED'
  return input.passed ? 'PASS' : 'FAIL'
}

/**
 * Summarize one captured run. The caller owns provenance and terminal criteria;
 * this offline summary is not authorizing evidence for devices, releases or site admission.
 * @param {BaselineInput} input
 */
export function buildBaselineManifest(input) {
  const denominators = { mechanism: 0, effect: 0, resilience: 0, field_admission: 0 }
  const ids = new Set()
  const checks = input.checks.map((check) => {
    if (!Object.hasOwn(denominators, check.category)) throw new TypeError(`Unknown baseline check category: ${check.category}`)
    if (!check.id.trim() || ids.has(check.id)) throw new TypeError(`Empty or duplicate baseline check ID: ${check.id}`)
    ids.add(check.id)
    denominators[check.category]++
    const status = classifyEvidenceCheck(check)
    if (check.category === 'field_admission' && status === 'PASS') {
      if (input.environment !== 'physical_hil' && input.environment !== 'production') {
        return { ...check, status: /** @type {const} */ ('BLOCKED'), blockedReason: 'physical evidence required' }
      }
      if (input.captureOrigin !== 'current' || !input.revision) {
        return { ...check, status: /** @type {const} */ ('BLOCKED'), blockedReason: 'current revision-bound evidence required' }
      }
    }
    return { ...check, status }
  })
  return {
    ...input,
    checks,
    denominators,
    missing: input.missing.map(item => ({ ...item })),
    captureHashes: { ...input.captureHashes },
  }
}
