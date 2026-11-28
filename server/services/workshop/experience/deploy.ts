/**
 * 经验部署（人工显式两步：晋升 → 部署）。
 *
 * 为什么不是直接复用 `release.ts`：受治理发布链要求 host-evaluation 评测行、epoch 与
 * 第二人复核（maker-checker），而记忆中心的手动部署是**无评测证据的人工决定**。
 * 这里不冒充 maker-checker：走 `setVersionState` + 审计记 `manual-unverified`，
 * 并在同域内撤下其他 active（保持"单域单 active"不变量，语义对齐 release.ts:133-141）。
 *
 * 部署域（2026-11-26，G11）：
 *  - line/product：`(scope_kind, scope_key)` —— 同产线经验本就跨频道；
 *  - channel：`(scope_kind, channel_id)` —— 避免 A 频道部署撤掉 B 频道；
 *  - global：`(scope_kind, owner_user_id)` —— 避免撤掉其他 owner 的全局经验。
 */
import type { DatabaseSync } from 'node:sqlite'
import { createMemoryRepo } from '../db/memory.repo'
import { withTransaction } from '../db/transaction'
import { recordOps } from '../ops/ops'
import { ensureLegacyVersion, getVersion, headVersionId, setVersionState } from './versions'
import { invalidateHarnessOverlayCache } from './overlay'

export type DeployTarget = 'active' | 'withdrawn'

export interface DeployResult {
  ok: boolean
  versionId?: string
  withdrawnSiblings?: number
  reasons: string[]
}

export function deployExperience(
  db: DatabaseSync,
  input: {
    memoryId: string
    channelId: string
    target: DeployTarget
    actor: string
    actorName?: string
    reason?: string
  },
): DeployResult {
  const repo = createMemoryRepo(db)
  const row = repo.getById(input.memoryId)
  if (!row || row.channelId !== input.channelId || row.kind !== 'experience') {
    return { ok: false, reasons: ['经验条目不存在或不属于该频道'] }
  }
  if ((row.status ?? 'active') !== 'validated') {
    return { ok: false, reasons: [`仅 validated 经验可部署（当前 ${row.status ?? 'active'}）`] }
  }
  const versionId = headVersionId(db, input.memoryId) ?? ensureLegacyVersion(db, input.memoryId)
  if (!versionId) return { ok: false, reasons: ['经验版本头缺失（无法建立部署状态）'] }
  const version = getVersion(db, versionId)
  if (!version) return { ok: false, reasons: ['经验版本不存在'] }
  if (version.lifecycle !== 'validated') {
    return { ok: false, reasons: [`版本生命周期为 ${version.lifecycle}，不可部署（需 validated）`] }
  }

  let withdrawnSiblings = 0
  try {
    withTransaction(db, () => {
      if (input.target === 'active') {
        for (const sibling of siblingActiveVersions(db, {
          memoryId: input.memoryId,
          scopeKind: row.scopeKind ?? 'channel',
          scopeKey: row.scopeKey ?? '',
          channelId: row.channelId,
          ownerUserId: row.ownerUserId ?? null,
        })) {
          setVersionState(db, sibling, { deployment: 'withdrawn' }, input.actor)
          withdrawnSiblings += 1
        }
      }
      // lifecycle 保持 validated；只推进部署维度（withdrawn 可再次 active）
      setVersionState(db, versionId, { deployment: input.target }, input.actor)
    })
  }
  catch (err) {
    return { ok: false, reasons: [err instanceof Error ? err.message : String(err)] }
  }

  try {
    recordOps({
      actor: input.actor,
      actorName: input.actorName ?? input.actor,
      actorKind: 'agent',
      action: `experience.deploy.${input.target}`,
      kind: 'system',
      targetKind: 'memory',
      targetId: input.memoryId,
      summary: `人工部署（manual-unverified）：${input.memoryId.slice(0, 8)} → ${input.target}`
        + (withdrawnSiblings > 0 ? `；同域撤下 ${withdrawnSiblings} 条 active` : '')
        + (input.reason ? `；理由：${input.reason}` : ''),
    })
  }
  catch { /* 审计失败不影响部署 */ }

  // 部署/撤下立即生效（不等 overlay 60s TTL）：同进程下一回合重新装配
  invalidateHarnessOverlayCache(input.channelId)

  return {
    ok: true,
    versionId,
    withdrawnSiblings,
    reasons: [
      input.target === 'active' ? '已部署为 active（人工部署，无评测证据）' : '已撤下（withdrawn）',
      ...(withdrawnSiblings > 0 ? [`同域撤下 ${withdrawnSiblings} 条旧 active`] : []),
    ],
  }
}

/** 同部署域内其他 active 版本（只取当前 head，避免历史版本反复撤下） */
function siblingActiveVersions(
  db: DatabaseSync,
  ctx: { memoryId: string, scopeKind: string, scopeKey: string, channelId: string, ownerUserId: string | null },
): string[] {
  if (ctx.scopeKind === 'line' || ctx.scopeKind === 'product') {
    return (db.prepare(
      `SELECT h.version_id AS versionId
         FROM experience_versions v JOIN experience_heads h ON h.version_id = v.version_id
        WHERE v.scope_kind = ? AND v.scope_key = ? AND v.deployment = 'active' AND v.experience_id != ?`,
    ).all(ctx.scopeKind, ctx.scopeKey, ctx.memoryId) as Array<{ versionId: string }>).map(r => r.versionId)
  }
  if (ctx.scopeKind === 'global') {
    if (!ctx.ownerUserId) return []
    return (db.prepare(
      `SELECT h.version_id AS versionId
         FROM experience_versions v
         JOIN experience_heads h ON h.version_id = v.version_id
         JOIN agent_memories m ON m.id = v.experience_id
        WHERE v.scope_kind = 'global' AND v.deployment = 'active' AND v.experience_id != ?
          AND m.owner_user_id = ?`,
    ).all(ctx.memoryId, ctx.ownerUserId) as Array<{ versionId: string }>).map(r => r.versionId)
  }
  return (db.prepare(
    `SELECT h.version_id AS versionId
       FROM experience_versions v
       JOIN experience_heads h ON h.version_id = v.version_id
       JOIN agent_memories m ON m.id = v.experience_id
      WHERE v.scope_kind = 'channel' AND v.deployment = 'active' AND v.experience_id != ?
        AND m.channel_id = ?`,
  ).all(ctx.memoryId, ctx.channelId) as Array<{ versionId: string }>).map(r => r.versionId)
}
