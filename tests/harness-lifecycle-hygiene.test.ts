/**
 * WP2/WP9 生命周卫回归（plan 2026-11-07-harness-orchestration-hardening-plan.md §3/§8）：
 *
 *   LH-1 会话关闭优先走「强制摘除」stopAgentRuntime（绕过 idle/pending 闸门），
 *        取消在飞任务后立即停机；不再落到带闸门的 unloadAgent（僵尸克隆根因）
 *   LH-2 未提供 stopAgentRuntime 时回退 unloadAgent（兼容测试替身）
 *   LH-3 busy-stuck 救援判定：健康 busy 不救援 / 超阈值卡死 busy 救援 / 无活动信号保守不救援
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { closeChannelSession, type SessionCloneDeps } from '../server/services/workshop/agents/session-clone'
import { shouldRescueBusyStuck } from '../server/services/workshop/runtime/manager/rescue-policy'

function closeFixture(withStop: boolean) {
  const calls: string[] = []
  const deps: SessionCloneDeps = {
    channelAgents: {
      listByChannel: () => [],
      create: () => ({ id: 'x', name: 'x', role: 'worker' }),
    },
    tasks: {
      list: () => [{ id: 't1', state: 'WORKING', assigneeId: 'clone-1' }],
      cancelTree: () => {
        calls.push('cancelTree:t1')
        return []
      },
    },
    bindings: { byAgent: () => [], bind: () => ({}) },
    unloadAgent: async () => {
      calls.push('unloadAgent')
    },
    ...(withStop
      ? {
          stopAgentRuntime: async () => {
            calls.push('stopAgentRuntime')
          },
        }
      : {}),
  }
  const sessionRepo = {
    findById: () => ({ status: 'active', memberMapJson: JSON.stringify({ 'base-1': 'clone-1' }) }),
    close: () => {
      calls.push('close')
      return true
    },
  }
  return { deps, sessionRepo, calls }
}

test('LH-1 会话关闭：取消在飞任务后走强制摘除（stopAgentRuntime），不再走 unloadAgent', async () => {
  const { deps, sessionRepo, calls } = closeFixture(true)
  const result = await closeChannelSession(deps, {
    channelId: 'ch-1',
    sessionId: 'cs-1',
    actorId: 'u-1',
    sessionRepo,
  })
  assert.equal(result.canceledTasks, 1)
  assert.deepEqual(result.clones, ['clone-1'])
  assert.deepEqual(calls, ['cancelTree:t1', 'stopAgentRuntime', 'close'], '顺序：取消任务 → 强制停机 → 会话 closed')
})

test('LH-2 会话关闭：无强制停机能力时回退 unloadAgent（兼容测试替身）', async () => {
  const { deps, sessionRepo, calls } = closeFixture(false)
  await closeChannelSession(deps, {
    channelId: 'ch-1',
    sessionId: 'cs-1',
    actorId: 'u-1',
    sessionRepo,
  })
  assert.deepEqual(calls, ['cancelTree:t1', 'unloadAgent', 'close'])
})

test('LH-3 busy-stuck 判定：健康 busy 不救援、超阈值救援、无信号保守不救援', () => {
  const now = Date.parse('2026-11-07T12:00:00.000Z')
  // 非 busy
  assert.equal(shouldRescueBusyStuck({ busy: false, lastUsedAt: '2026-11-07T11:00:00.000Z', now }), false)
  // 健康长回合（最后回合推进 5 分钟前，阈值 30 分钟）→ 不救援
  assert.equal(shouldRescueBusyStuck({ busy: true, lastUsedAt: '2026-11-07T11:55:00.000Z', now }), false)
  // 卡死 busy（40 分钟无推进）→ 救援
  assert.equal(shouldRescueBusyStuck({ busy: true, lastUsedAt: '2026-11-07T11:20:00.000Z', now }), true)
  // 无活动信号（保守不救援）
  assert.equal(shouldRescueBusyStuck({ busy: true, lastUsedAt: null, now }), false)
  // 自定义阈值生效（10 分钟）
  assert.equal(shouldRescueBusyStuck({ busy: true, lastUsedAt: '2026-11-07T11:45:00.000Z', now, minBusyMs: 10 * 60_000 }), true)
  // 阈值下限 60s 钳制
  assert.equal(shouldRescueBusyStuck({ busy: true, lastUsedAt: '2026-11-07T11:59:30.000Z', now, minBusyMs: 1 }), false)
})
