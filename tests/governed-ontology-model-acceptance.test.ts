/**
 * Task 12/13/15:本体证据候选、容器复用边界、隔离验收 runner 与主干审计检查器。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { proposeOntologyDiff, evaluateConstraintVerdict, assessModelReuse } =
  await import('../server/services/workshop/experience/ontology-proposals')
const { validateSimulationManifest, evaluateAcceptance } = await import('../scripts/acceptance-governed-product-learning.mjs')
const { checkMainAudit, REQUIRED_MAIN_AUDIT_CHECKS } = await import('../scripts/_audit/governed-main-audit.mjs')

const context = {
  actor: 'user-1', channelId: 'ch-1', sessionId: 's-1', authorizationEpoch: 0,
  subjectRef: 'line:ln-1', environment: 'simulation' as const,
  industrial: { lineId: 'ln-1', productId: 'prod-a' },
}
const ref = (over: Record<string, unknown> = {}) => ({
  id: 'ev-1', sourceKind: 'task' as const, environment: 'simulation' as const,
  observedAt: '2026-11-20T10:00:00.000Z', supportUnitId: 'run-1', polarity: 'support' as const, ...over,
})

test('unknown_coupling_and_unobservable_guard', () => {
  // 无声明边且观测到无耦合 → unknown(不是 false/不是通过)
  assert.equal(evaluateConstraintVerdict({ declaredEdge: false, refutedEdge: false, observedCoupled: false, observationWindowValid: true }), 'unknown')
  // 缺关键观测 → unobservable,不得作为执行依据
  assert.equal(evaluateConstraintVerdict({ declaredEdge: true, refutedEdge: false, observedCoupled: null, observationWindowValid: true }), 'unobservable')
  assert.equal(evaluateConstraintVerdict({ declaredEdge: true, refutedEdge: false, observedCoupled: true, observationWindowValid: false }), 'unobservable')
  // 声明边 + 观测耦合 → verified;观测反证 → violated
  assert.equal(evaluateConstraintVerdict({ declaredEdge: true, refutedEdge: false, observedCoupled: true, observationWindowValid: true }), 'verified')
  assert.equal(evaluateConstraintVerdict({ declaredEdge: true, refutedEdge: false, observedCoupled: false, observationWindowValid: true }), 'violated')

  const base = {
    modelLineage: { productId: 'prod-a', recipeRevision: 'rev-1', datasetHash: 'd1', artifactHash: 'a1' },
    targetLineage: { productId: 'prod-a', recipeRevision: 'rev-1' },
    io: { inputUnits: ['MPa'], outputUnits: ['g'], expectedInputUnits: ['MPa'], expectedOutputUnits: ['g'] },
    calibration: 'present' as const,
    criticalGuards: { total: 3, observables: 3 },
    ensembleMembers: { required: 2, present: 2 },
    drift: 'within' as const,
  }
  assert.equal(assessModelReuse(base).modelUsable, true)
  assert.equal(assessModelReuse({ ...base, targetLineage: { productId: 'prod-a', recipeRevision: 'rev-2' } }).modelUsable, false, '跨配方拒绝')
  const missingGuard = assessModelReuse({ ...base, criticalGuards: { total: 3, observables: 2 } })
  assert.equal(missingGuard.executable, false)
  assert.ok(missingGuard.reasons.includes('CRITICAL_GUARD_UNOBSERVABLE'))
})

test('ontology proposal keeps provenance and blocks beta/conflicts', () => {
  const ok = proposeOntologyDiff(context, [ref({ id: 's1' })], { texts: ['设备「注塑主机」与克重存在耦合'] })
  assert.equal(ok.blockedReasons.includes('NO_SUPPORTING_EVIDENCE'), false)
  assert.ok(ok.diff.some(d => d.kind === 'entity' && d.key.includes('注塑主机')))
  assert.deepEqual(ok.diff[0]!.sourceEvidenceIds, ['s1'])

  const beta = proposeOntologyDiff(context, [ref({ betaAncestors: ['beta-1'] })], { texts: [] })
  assert.ok(beta.blockedReasons.includes('BETA_ANCESTOR_PRESENT'))
  const conflict = proposeOntologyDiff(context, [ref({ id: 's1' }), ref({ id: 'r1', polarity: 'refute' })], { texts: [] })
  assert.ok(conflict.blockedReasons.includes('CONFLICTING_EVIDENCE_REQUIRES_REVIEW'))
})

test('rejects_unknown_or_unowned_simulation_target', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aw-sim-manifest-'))
  const proof = join(dir, 'attestation.json')
  writeFileSync(proof, '{"nonce":"x"}')
  const base = {
    environment: 'simulation', revision: 'cf9dfab3', runId: 'run-1', awHome: join(dir, 'home'),
    allowedTargets: ['sim://twin-4056'], targets: ['sim://twin-4056'], ownershipProofRef: proof,
    arms: [{ id: 'A', dataRoot: join(dir, 'arm-a') }, { id: 'B', dataRoot: join(dir, 'arm-b') }],
    credentials: ['vault:rag-token'],
  }
  const ready = validateSimulationManifest(base)
  assert.equal(ready.status, 'READY')

  const unowned = validateSimulationManifest({ ...base, ownershipProofRef: join(dir, 'missing.json') })
  assert.equal(unowned.status, 'BLOCKED')
  assert.equal(unowned.runStarted ?? false, false)
  assert.equal(unowned.writeCalls ?? 0, 0)
  assert.ok(unowned.blockers.includes('OWNERSHIP_PROOF_UNREADABLE'))

  const unknownTarget = validateSimulationManifest({ ...base, targets: ['sim://unknown-9999'] })
  assert.equal(unknownTarget.status, 'BLOCKED')
  assert.ok(unknownTarget.blockers.some(b => b.startsWith('TARGET_NOT_ALLOWED')))

  const sharedRoot = validateSimulationManifest({ ...base, arms: [{ id: 'A', dataRoot: '/tmp/x' }, { id: 'B', dataRoot: '/tmp/x' }] })
  assert.ok(sharedRoot.blockers.some(b => b.startsWith('ARM_DATA_ROOT_SHARED')))

  const production = validateSimulationManifest({ ...base, environment: 'production' })
  assert.ok(production.blockers.includes('ENVIRONMENT_NOT_SIMULATION'))

  const inlineCredential = validateSimulationManifest({ ...base, credentials: ['sk-live-1234567890'] })
  assert.ok(inlineCredential.blockers.includes('CREDENTIAL_VALUE_INLINE'))
})

test('acceptance_never_counts_nonterminal_as_delivered', () => {
  const entries = [
    { id: 'htmlWithoutArtifact', stage: 'project-generic', status: 'PASS', artifactPresent: false },
    { id: 'recallWithoutDecisionId', stage: 'rsi', status: 'PASS', requiresDecisionId: true },
    { id: 'interrupted', stage: 'project', status: 'PARTIAL', execution: 'incomplete' },
    { id: 'physicalNotRun', stage: 'field', status: 'NOT_RUN' },
    { id: 'ok', stage: 'line-ops', status: 'PASS' },
  ]
  const report = evaluateAcceptance(entries, { physicalExecuted: false })
  const byId = Object.fromEntries(report.checks.map(c => [c.id, c.status]))
  assert.notEqual(byId.htmlWithoutArtifact, 'PASS')
  assert.notEqual(byId.recallWithoutDecisionId, 'PASS')
  assert.equal(byId.physicalNotRun, 'NOT_RUN')
  assert.equal(report.overall, 'PARTIAL')
})

test('audit_requires_exact_merged_main_and_fresh_evidence', () => {
  const sha = 'a'.repeat(40)
  const ok = checkMainAudit({
    mainSha: sha, checkoutSha: sha, buildSha: sha, allMergeCommitsReachable: true, cleanCheckout: true,
    checks: REQUIRED_MAIN_AUDIT_CHECKS.map(id => ({ id, revision: sha, status: 'PASS', exitCode: 0, evidenceRef: `ev/${id}.log`, evidenceSha256: 'b'.repeat(64) })),
  })
  assert.equal(ok.status, 'PASS')

  const wrongCheckout = checkMainAudit({
    mainSha: sha, checkoutSha: 'c'.repeat(40), buildSha: sha, allMergeCommitsReachable: true, cleanCheckout: true,
    checks: REQUIRED_MAIN_AUDIT_CHECKS.map(id => ({ id, revision: sha, status: 'PASS', exitCode: 0, evidenceRef: 'x', evidenceSha256: 'b'.repeat(64) })),
  })
  assert.notEqual(wrongCheckout.status, 'PASS')

  const missingMergeCommit = checkMainAudit({
    mainSha: sha, checkoutSha: sha, buildSha: sha, allMergeCommitsReachable: false, cleanCheckout: true,
    checks: REQUIRED_MAIN_AUDIT_CHECKS.map(id => ({ id, revision: sha, status: 'PASS', exitCode: 0, evidenceRef: 'x', evidenceSha256: 'b'.repeat(64) })),
  })
  assert.notEqual(missingMergeCommit.status, 'PASS')

  const requiredCheckNotRun = checkMainAudit({
    mainSha: sha, checkoutSha: sha, buildSha: sha, allMergeCommitsReachable: true, cleanCheckout: true,
    checks: REQUIRED_MAIN_AUDIT_CHECKS.slice(1).map(id => ({ id, revision: sha, status: 'PASS', exitCode: 0, evidenceRef: 'x', evidenceSha256: 'b'.repeat(64) })),
  })
  assert.equal(requiredCheckNotRun.status, 'FAIL')
  assert.ok(requiredCheckNotRun.blockingChecks.some(b => b.reason === 'REQUIRED_CHECK_MISSING'))
})
