/**
 * 晋升/回滚执行面（WP-B3/B4）—— 门判定 + 状态迁移 + 审计。
 *
 * 调用方只有两类：
 *  - REST（channel owner/admin，即**人**在审批）—— 本文件不暴露给 Agent 工具面；
 *  - bench 晋升脚本（WP-B2，附配对结果）。
 * 因此「Agent 自己给自己晋级」在结构上不可达（不在 host-tools 白名单）。
 */
import type { DatabaseSync } from 'node:sqlite'
import { createMemoryRepo } from '../db/memory.repo'
import { createImprovementActionRepo } from '../db/improvement-action.repo'
import { recordOps } from '../ops/ops'
import { createHarnessProfileRepo } from './harness-profile'
import { evaluateExperienceGate, evaluateProfileGate, rollbackTarget, type PairedBenchResult } from './gates'
import { resolveBenchRunForPromote } from './bench-run'

export interface PromoteResult<S extends string> {
  ok: boolean
  next?: S
  reasons: string[]
}

/** 经验条目晋升（candidate→validated）或退休（→retired） */
export function promoteExperience(
  db: DatabaseSync,
  input: { memoryId: string, channelId: string, to: 'validated' | 'retired', actor: string, actorName?: string },
): PromoteResult<'validated' | 'retired'> {
  const repo = createMemoryRepo(db)
  const row = repo.getById(input.memoryId)
  if (!row || row.channelId !== input.channelId || row.kind !== 'experience') {
    return { ok: false, reasons: ['经验条目不存在或不属于该频道'] }
  }
  const decision = evaluateExperienceGate(row, input.to)
  if (!decision.allowed || !decision.next) return { ok: false, reasons: decision.reasons }
  repo.markStatus(input.memoryId, decision.next)
  // WP-C3:元层成效入表(哪类改进动作有效,由事实计数回答)
  createImprovementActionRepo(db).record({
    actionKind: 'experience_promote',
    subjectKind: 'experience',
    subjectId: input.memoryId,
    channelId: input.channelId,
    decision: decision.next === 'validated' ? 'promoted' : 'rejected',
    decidedBy: input.actor,
    detail: { reasons: decision.reasons, to: decision.next },
  })
  try {
    recordOps({
      actor: input.actor, actorName: input.actorName ?? input.actor, actorKind: 'agent',
      action: `experience.promote.${decision.next}`,
      kind: 'system', targetKind: 'memory', targetId: input.memoryId,
      summary: `经验条目 ${input.memoryId.slice(0, 8)} → ${decision.next}（${decision.reasons.join('；')}）`,
    })
  }
  catch { /* 审计失败不影响晋升 */ }
  return { ok: true, next: decision.next, reasons: decision.reasons }
}

/** Harness Profile 晋升（→shadow / →active，active 需配对结果） */
export function promoteProfile(
  db: DatabaseSync,
  input: {
    profileId: string
    channelId: string
    to: 'shadow' | 'active'
    actor: string
    actorName?: string
    /**
     * 配对评测的**台账 id**（promote→active 唯一合法证据来源）。
     * 旧接口直接收 body.bench 三个数字 —— 与任何一次运行都没有绑定,
     * 同一份数字可喂给任意 profile 并双双过门(2026-11-10 审计)。
     */
    benchRunId?: string
    /** @deprecated 仅供测试/历史兼容;to='active' 时不再接受 */
    bench?: PairedBenchResult | null
  },
): PromoteResult<'shadow' | 'active' | 'superseded'> {
  const repo = createHarnessProfileRepo(db)
  const row = repo.get(input.profileId)
  if (!row || row.channelId !== input.channelId) return { ok: false, reasons: ['profile 不存在或不属于该频道'] }

  let bench = input.bench ?? null
  let benchRunId: string | null = null
  if (input.to === 'active') {
    if (!input.benchRunId) {
      return { ok: false, reasons: ['BENCH_PROVENANCE_REQUIRED: 晋级 active 必须引用已落库的 benchRunId（不接受客户端自报数字）'] }
    }
    const resolved = resolveBenchRunForPromote(db, { channelId: input.channelId, profileId: input.profileId, benchRunId: input.benchRunId })
    if (!resolved.ok) return { ok: false, reasons: resolved.reasons }
    benchRunId = resolved.run.id
    bench = { pValue: resolved.run.pValue, primaryDelta: resolved.run.primaryDelta, costDelta: resolved.run.costDelta }
  }

  const decision = evaluateProfileGate(row, input.to, bench)
  if (!decision.allowed || !decision.next) return { ok: false, reasons: decision.reasons }
  repo.markStatus(input.profileId, decision.next)
  if (benchRunId) {
    // 采纳证据绑定到 profile:审计/复盘可追溯到具体一次配对评测
    db.prepare('UPDATE channel_harness_profiles SET bench_run_id = ?, promoted_at = ? WHERE id = ?')
      .run(benchRunId, new Date().toISOString(), input.profileId)
  }
  createImprovementActionRepo(db).record({
    actionKind: 'profile_promote',
    subjectKind: 'harness_profile',
    subjectId: input.profileId,
    channelId: input.channelId,
    decision: decision.next === 'active' ? 'promoted' : 'accepted',
    outcomeDelta: bench?.primaryDelta ?? null,
    decidedBy: input.actor,
    detail: { reasons: decision.reasons, to: decision.next, bench: bench ?? null, benchRunId },
  })
  try {
    recordOps({
      actor: input.actor, actorName: input.actorName ?? input.actor, actorKind: 'agent',
      action: `harness.profile.${decision.next}`,
      kind: 'system', targetKind: 'harness_profile', targetId: input.profileId,
      summary: `Harness Profile v${row.version} → ${decision.next}（${decision.reasons.join('；')}）`,
    })
  }
  catch { /* 审计失败不影响晋升 */ }
  return { ok: true, next: decision.next, reasons: decision.reasons }
}

/**
 * Profile 自动回滚（WP-B4）：把当前 active 的上一版本重新激活。
 * 触发面：REST 手动 / 劣化告警脚本；不自动静默执行（写面永远过人）。
 */
export function rollbackProfile(
  db: DatabaseSync,
  input: { channelId: string, actor: string, actorName?: string },
): PromoteResult<'active'> & { targetId?: string } {
  const repo = createHarnessProfileRepo(db)
  const active = repo.activeOf(input.channelId)
  if (!active) return { ok: false, reasons: ['当前没有 active profile，无需回滚'] }
  const targetId = rollbackTarget(repo.listByChannel(input.channelId, 50), active.id)
  if (!targetId) return { ok: false, reasons: ['没有更早版本可回滚（唯一版本）'] }
  repo.markStatus(targetId, 'active')
  createImprovementActionRepo(db).record({
    actionKind: 'profile_rollback',
    subjectKind: 'harness_profile',
    subjectId: targetId,
    channelId: input.channelId,
    decision: 'rolled_back',
    decidedBy: input.actor,
    detail: { from: active.id, to: targetId, fromVersion: active.version },
  })
  try {
    recordOps({
      actor: input.actor, actorName: input.actorName ?? input.actor, actorKind: 'agent',
      action: 'harness.profile.rollback',
      kind: 'system', targetKind: 'harness_profile', targetId,
      summary: `Harness Profile 回滚：v${active.version} → 上一版本（${targetId.slice(0, 10)}）`,
    })
  }
  catch { /* 审计失败不影响回滚 */ }
  return { ok: true, next: 'active', targetId, reasons: [`回滚到 ${targetId}`] }
}
