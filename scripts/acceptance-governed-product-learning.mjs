#!/usr/bin/env node
/**
 * 受治理产品学习:隔离模拟验收 runner(Task 13)。
 *
 * 职责:
 *  1) 校验 SimulationRunManifest(环境必须是 simulation、revision 固定、AW_HOME 隔离、
 *     模拟目标在许可集合内、孪生归属证明引用存在、各实验臂数据根/索引命名空间互不复用);
 *     任一不满足 → 在任何任务启动/写操作之前返回 BLOCKED;
 *  2) 按 Task 1 的 classifyEvidenceCheck 口径汇总索引条目:非终态不得计 PASS,
 *     无 decisionId 的召回不得计 PASS,物理未执行恒 NOT_RUN;
 *  3) 输出可追加的报告 JSON(不产生控制指令;不触发设备写)。
 *
 * 用法:node scripts/acceptance-governed-product-learning.mjs --manifest <manifest.json> [--index <index.json>]
 */
import { readFileSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { classifyEvidenceCheck } from './_audit/governed-learning-evidence.mjs'

export const SIMULATION_ENVIRONMENTS = new Set(['simulation'])

/**
 * @param {object} manifest
 * @returns {{ ok: boolean, status: 'READY'|'BLOCKED', blockers: string[] }}
 */
export function validateSimulationManifest(manifest) {
  const blockers = []
  if (!manifest || typeof manifest !== 'object') return { ok: false, status: 'BLOCKED', blockers: ['MANIFEST_INVALID'] }
  if (manifest.environment !== 'simulation') blockers.push('ENVIRONMENT_NOT_SIMULATION')
  if (!manifest.revision || !/^[0-9a-f]{7,40}$/i.test(String(manifest.revision))) blockers.push('REVISION_UNPINNED')
  if (!manifest.runId) blockers.push('RUN_ID_MISSING')
  if (!manifest.awHome || !String(manifest.awHome).includes('tmp') && !String(manifest.awHome).includes('home')) {
    blockers.push('AW_HOME_NOT_ISOLATED')
  }
  const allowed = Array.isArray(manifest.allowedTargets) ? manifest.allowedTargets : []
  if (allowed.length === 0) blockers.push('ALLOWED_TARGETS_EMPTY')
  const targets = Array.isArray(manifest.targets) ? manifest.targets : []
  for (const target of targets) {
    if (!allowed.includes(target)) blockers.push(`TARGET_NOT_ALLOWED:${target}`)
  }
  if (!manifest.ownershipProofRef) blockers.push('OWNERSHIP_PROOF_MISSING')
  else if (!existsSync(manifest.ownershipProofRef)) blockers.push('OWNERSHIP_PROOF_UNREADABLE')
  const arms = Array.isArray(manifest.arms) ? manifest.arms : []
  if (arms.length === 0) blockers.push('ARMS_MISSING')
  const roots = new Map()
  for (const arm of arms) {
    if (!arm.dataRoot) { blockers.push(`ARM_DATA_ROOT_MISSING:${arm.id ?? '?'}`); continue }
    if (roots.has(arm.dataRoot)) blockers.push(`ARM_DATA_ROOT_SHARED:${arms.find(a => a.id === roots.get(arm.dataRoot))?.id ?? '?'}:${arm.id ?? '?'}`)
    roots.set(arm.dataRoot, arm.id)
    if (arm.credentialRefs?.some(r => typeof r === 'string' && /^(sk-|gho_|Bearer )/.test(r))) blockers.push(`ARM_CREDENTIAL_LITERAL:${arm.id}`)
  }
  const credentials = Array.isArray(manifest.credentials) ? manifest.credentials : []
  for (const cred of credentials) {
    if (typeof cred === 'string' && /^(sk-|gho_|Bearer )/.test(cred)) blockers.push('CREDENTIAL_VALUE_INLINE')
  }
  return { ok: blockers.length === 0, status: blockers.length === 0 ? 'READY' : 'BLOCKED', blockers: [...new Set(blockers)] }
}

/**
 * 验收结论:索引条目按严格口径分级。
 * @param {Array<{id:string, stage:string, status:string, evidence?:string[], execution?:string, passed?:boolean, blockedReason?:string, decisionId?:string, artifactPresent?:boolean}>} entries
 * @param {{ physicalExecuted?: boolean }} options
 */
export function evaluateAcceptance(entries, options = {}) {
  const checks = []
  for (const entry of entries) {
    let status
    if (entry.stage === 'field') {
      status = options.physicalExecuted ? 'PARTIAL' : 'NOT_RUN'
    }
    else {
      const declared = entry.status
      const execution = entry.execution ?? (declared === 'NOT_RUN' ? 'not_started' : declared === 'PARTIAL' ? 'incomplete' : 'terminal')
      const passed = entry.passed ?? (declared === 'PASS')
      status = classifyEvidenceCheck({ execution, passed, blockedReason: entry.blockedReason })
      // 无产物/无 decisionId 的条目不得计 PASS
      if (status === 'PASS' && entry.artifactPresent === false) status = 'PARTIAL'
      if (status === 'PASS' && entry.requiresDecisionId && !entry.decisionId) status = 'PARTIAL'
    }
    checks.push({ id: entry.id, stage: entry.stage, status, evidence: entry.evidence ?? [] })
  }
  const failed = checks.filter(c => c.status === 'FAIL' || c.status === 'BLOCKED')
  const overall = failed.length > 0 ? 'BLOCKED' : checks.every(c => c.status === 'PASS') ? 'PASS'
    : checks.every(c => c.status === 'NOT_RUN') ? 'NOT_RUN' : 'PARTIAL'
  return { overall, checks, denominators: { checks: checks.length, passed: checks.filter(c => c.status === 'PASS').length } }
}

function main() {
  const args = process.argv.slice(2)
  const argOf = (k, d = '') => {
    const i = args.indexOf(k)
    return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d
  }
  const manifestPath = argOf('--manifest')
  if (!manifestPath) {
    console.error('用法:--manifest <manifest.json> [--index <index.json>]')
    process.exit(2)
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const verdict = validateSimulationManifest(manifest)
  if (!verdict.ok) {
    console.log(JSON.stringify({ status: verdict.status, blockers: verdict.blockers, runStarted: false, writeCalls: 0 }, null, 1))
    process.exit(1)
  }
  const indexPath = argOf('--index', resolve(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'audit', 'evidence', '2026-11-20-governed-acceptance-round', 'acceptance-index.json'))
  const index = JSON.parse(readFileSync(indexPath, 'utf8'))
  const report = evaluateAcceptance(index.entries, { physicalExecuted: Boolean(manifest.physicalExecuted) })
  console.log(JSON.stringify({ status: verdict.status, runId: manifest.runId, revision: manifest.revision, report }, null, 1))
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main()
