#!/usr/bin/env node
/**
 * 合并后主干审计检查器(Task 15)。
 *
 * 只做证据完整性判定,不产出"主干通过"结论:必须由调用方提供本次运行的真实
 * 检查结果(绑定同一 SHA 的命令/退出码/证据摘要),缺项、重复、版本漂移、
 * 非祖先合并提交、脏检出或证据摘要缺失都不得判 PASS。
 */
export const REQUIRED_MAIN_AUDIT_CHECKS = Object.freeze([
  'typecheck',
  'lint',
  'test:unit',
  'i18n:check',
  'check:cssvars',
  'frontend-lifecycle-contract',
  'test:acceptance-context',
  'test:onboarding-v6',
  'test:sdk-surface',
  'test:plugin-lifecycle',
  'test:mcp',
  'docs:check',
  'build',
])

/**
 * @typedef {{ id: string, revision: string, status: string, exitCode: number, evidenceRef?: string, evidenceSha256?: string }} AuditCheckResult
 * @typedef {{ mainSha: string, checkoutSha: string, buildSha: string, allMergeCommitsReachable: boolean, cleanCheckout: boolean, checks: AuditCheckResult[] }} MainAuditInput
 */

/**
 * @param {MainAuditInput} input
 * @returns {{ status: 'PASS'|'FAIL'|'BLOCKED', blockingChecks: Array<{ id: string, reason: string }> }}
 */
export function checkMainAudit(input) {
  const blockingChecks = []
  if (!input?.mainSha) blockingChecks.push({ id: 'mainSha', reason: 'MAIN_SHA_MISSING' })
  if (input?.checkoutSha !== input?.mainSha) blockingChecks.push({ id: 'checkoutSha', reason: 'CHECKOUT_NOT_MAIN' })
  if (input?.buildSha !== input?.mainSha) blockingChecks.push({ id: 'buildSha', reason: 'BUILD_NOT_MAIN' })
  if (input?.allMergeCommitsReachable !== true) blockingChecks.push({ id: 'mergeCommits', reason: 'MERGE_COMMIT_UNREACHABLE' })
  if (input?.cleanCheckout !== true) blockingChecks.push({ id: 'cleanCheckout', reason: 'CHECKOUT_DIRTY' })
  const checks = Array.isArray(input?.checks) ? input.checks : []
  const seen = new Set()
  for (const check of checks) {
    if (seen.has(check.id)) blockingChecks.push({ id: check.id, reason: 'DUPLICATE_CHECK' })
    seen.add(check.id)
    if (check.revision !== input?.mainSha) blockingChecks.push({ id: check.id, reason: 'STALE_REVISION' })
    if (!check.evidenceRef || !check.evidenceSha256) blockingChecks.push({ id: check.id, reason: 'EVIDENCE_MISSING' })
    if (check.exitCode !== 0 || check.status !== 'PASS') blockingChecks.push({ id: check.id, reason: `CHECK_${check.status ?? 'UNKNOWN'}` })
  }
  for (const required of REQUIRED_MAIN_AUDIT_CHECKS) {
    if (!seen.has(required)) blockingChecks.push({ id: required, reason: 'REQUIRED_CHECK_MISSING' })
  }
  for (const id of seen) {
    if (!REQUIRED_MAIN_AUDIT_CHECKS.includes(id)) blockingChecks.push({ id, reason: 'UNEXPECTED_CHECK_ID' })
  }
  const status = blockingChecks.length === 0 ? 'PASS' : blockingChecks.some(b => b.reason === 'REQUIRED_CHECK_MISSING' || b.reason.startsWith('CHECK_')) ? 'FAIL' : 'BLOCKED'
  return { status, blockingChecks }
}
