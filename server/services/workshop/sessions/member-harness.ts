/**
 * 成员（基础成员/会话 clone）harness 变更预检。
 *
 * 与 runtime-service 的 dry-run 同源：结构支持矩阵 + 已绑定 AgentPrefab profile。
 * 必须在 DB 事务之前调用 —— 否则 PATCH 成功、下一回合装配才 409。
 */
import type { DatabaseSync } from 'node:sqlite'
import type { ChannelAgentRow } from '../db/database/rows'
import { AppError } from '../../../utils/errors'
import { resolveRuntimeForMember, prefabBlockedReason } from '../agent-prefabs/runtime'
import { applyPrefabProfile, assertProfileStructurallyValid } from '../agent-prefabs/profile'

export function validateMemberHarnessChange(
  db: DatabaseSync,
  member: ChannelAgentRow,
  nextHarness: string,
  nextConfig: Record<string, unknown>,
): void {
  if (nextHarness === member.harness) return
  assertProfileStructurallyValid(nextHarness, nextConfig)
  const candidate: ChannelAgentRow = { ...member, harness: nextHarness, configJson: JSON.stringify(nextConfig) }
  let resolved
  try {
    resolved = resolveRuntimeForMember(db, candidate, { ignoreStoredOverrides: true })
  }
  catch (err) {
    throw new AppError(500, 'PREFAB_RESOLUTION_FAILED', `runtime 预检失败：${err instanceof Error ? err.message : String(err)}`)
  }
  if (resolved.bindingError) throw new AppError(400, 'PREFAB_BINDING_INVALID', resolved.bindingError)
  const blocked = prefabBlockedReason(resolved.resolution)
  if (blocked) throw new AppError(409, 'PREFAB_REQUIRED_CAPABILITY_MISSING', blocked)
  if (resolved.draft) applyPrefabProfile({ ...nextConfig }, nextHarness, resolved.draft.profile)
}
