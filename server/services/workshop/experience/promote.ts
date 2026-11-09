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
import { recordOps } from '../ops/ops'
import { createHarnessProfileRepo } from './harness-profile'
import { evaluateExperienceGate, evaluateProfileGate, rollbackTarget, type PairedBenchResult } from './gates'

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
  input: { profileId: string, channelId: string, to: 'shadow' | 'active', actor: string, actorName?: string, bench?: PairedBenchResult | null },
): PromoteResult<'shadow' | 'active' | 'superseded'> {
  const repo = createHarnessProfileRepo(db)
  const row = repo.get(input.profileId)
  if (!row || row.channelId !== input.channelId) return { ok: false, reasons: ['profile 不存在或不属于该频道'] }
  const decision = evaluateProfileGate(row, input.to, input.bench ?? null)
  if (!decision.allowed || !decision.next) return { ok: false, reasons: decision.reasons }
  repo.markStatus(input.profileId, decision.next)
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
