/**
 * HITL 可见性 fail-closed 回归（2026-11-07 运行时审查 P2）：
 *
 * 旧实现 `if (!manager || !channelId) return` 在鉴权面不可用 / 待办无归属时
 * **静默放行** —— 任何登录用户都能裁决无 Channel 归属的待办（审批旁路）。
 * 现在：运行时不可用 → 503；无归属 → 仅 admin 可处理；正常归属仍走原有
 * 可见性 + requireCanApprove 双检。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { configureHitlRuntime, type HitlRuntimePort } from '../server/services/workshop/agents/hitl-registry'
import { assertCanDecideHitlChannel, canDecideHitlChannel } from '../server/services/workshop/agents/hitl-decision/visibility'
import { AppError } from '../server/utils/errors'

const user = { id: 'u-member', role: 'user' }
const admin = { id: 'u-admin', role: 'admin' }

function stubManager(overrides: Partial<HitlRuntimePort> = {}): { manager: HitlRuntimePort, calls: string[] } {
  const calls: string[] = []
  const manager = {
    listChannelsVisibleTo: () => [{ id: 'ch-1' }],
    listChannelsForUser: () => [],
    requireChannelMember: (channelId: string) => {
      calls.push(`member:${channelId}`)
      return { id: channelId }
    },
    requireCanApprove: (channelId: string, acting: { id: string }) => {
      calls.push(`approve:${channelId}:${acting.id}`)
      if (acting.id !== 'u-ok') throw new AppError(403, 'SCOPE_VIOLATION', '不在审批资格内')
      return { id: channelId }
    },
    ...overrides,
  } as unknown as HitlRuntimePort
  return { manager, calls }
}

function errorCode(fn: () => void): string {
  try {
    fn()
  }
  catch (err) {
    return (err as { code?: string }).code ?? 'NO_CODE'
  }
  return 'NO_THROW'
}

test('H-1 运行时不可用 → fail-closed（503），不再静默放行', (t) => {
  configureHitlRuntime(() => null)
  t.after(() => configureHitlRuntime(null))
  assert.equal(errorCode(() => assertCanDecideHitlChannel('ch-1', user)), 'HITL_AUTH_UNAVAILABLE')
  assert.equal(canDecideHitlChannel('ch-1', user), false, '列表过滤同样不显示')
  assert.equal(canDecideHitlChannel('ch-1', admin), false, '运行时不可用时管理员也不放行')
})

test('H-2 待办无 Channel 归属 → 非管理员 403，管理员放行', (t) => {
  const { manager, calls } = stubManager()
  configureHitlRuntime(() => manager)
  t.after(() => configureHitlRuntime(null))
  assert.equal(errorCode(() => assertCanDecideHitlChannel('', user)), 'SCOPE_VIOLATION')
  assert.equal(canDecideHitlChannel('', user), false)
  assert.equal(errorCode(() => assertCanDecideHitlChannel('', admin)), 'NO_THROW', '管理员可处理无归属待办')
  assert.equal(canDecideHitlChannel('', admin), true)
  assert.deepEqual(calls, [], '无归属路径不触碰 Channel 成员校验')
})

test('H-3 正常归属：admin 走成员校验；普通用户走可见性 + 审批资格', (t) => {
  const { manager, calls } = stubManager()
  configureHitlRuntime(() => manager)
  t.after(() => configureHitlRuntime(null))
  assert.equal(errorCode(() => assertCanDecideHitlChannel('ch-1', admin)), 'NO_THROW')
  assert.equal(errorCode(() => assertCanDecideHitlChannel('ch-1', { id: 'u-ok', role: 'user' })), 'NO_THROW')
  assert.equal(errorCode(() => assertCanDecideHitlChannel('ch-1', user)), 'SCOPE_VIOLATION', '资格不足仍拒绝')
  assert.deepEqual(calls, ['member:ch-1', 'approve:ch-1:u-ok', 'approve:ch-1:u-member'])
})

test('H-4 不可见 Channel → 403（可见性仍先于资格）', (t) => {
  const { manager } = stubManager({ listChannelsVisibleTo: () => [] })
  configureHitlRuntime(() => manager)
  t.after(() => configureHitlRuntime(null))
  assert.equal(errorCode(() => assertCanDecideHitlChannel('ch-404', { id: 'u-ok', role: 'user' })), 'SCOPE_VIOLATION')
})
