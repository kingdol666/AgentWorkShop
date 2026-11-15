/**
 * 会话关闭的崩溃可恢复性:
 *  1. close 先持久化 closing 意图 —— 级联失败/进程中断后不会留下"active 但 clone 已停用";
 *  2. 重试 close 可重新跑级联并收敛 closed;
 *  3. 启动对账把 closing 会话补完(停用全部 clone + closed),幂等且单成员失败不阻断。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-session-close-recovery-'))
delete process.env.DAQ_TSDB_URL

const { openWorkshopDb } = await import('../server/services/workshop/db/database/open')
const { createChannelSessionRepo } = await import('../server/services/workshop/db/channel-session.repo')
const { closeChannelSession, reconcileClosingSessions } = await import('../server/services/workshop/agents/session-clone')

test('an interrupted close stays closing and a retry converges to closed', async () => {
  let status = 'active'
  const repo = {
    findById: () => ({ status, memberMapJson: JSON.stringify({ m1: 'clone-1' }) }),
    beginClosing: () => {
      if (status === 'closed') return false
      status = 'closing'
      return true
    },
    close: () => {
      if (status === 'closed') return false
      status = 'closed'
      return true
    },
  }
  const baseDeps = {
    tasks: { list: () => [], cancelTree: () => [] },
    unloadAgent: async () => { throw new Error('process crashed mid-close') },
  }
  const input = { channelId: 'ch', sessionId: 's1', actorId: 'u1', sessionRepo: repo }

  // 级联中途失败:关闭意图已落库,会话不可再被寻址,但尚未 closed
  const deps = baseDeps as unknown as Parameters<typeof closeChannelSession>[0]
  await assert.rejects(() => closeChannelSession(deps, input), /process crashed mid-close/)
  assert.equal(status, 'closing')

  // 重试:重新跑级联后收敛 closed
  const retryDeps = { ...baseDeps, unloadAgent: async () => {} } as unknown as Parameters<typeof closeChannelSession>[0]
  const result = await closeChannelSession(retryDeps, input)
  assert.deepEqual(result.clones, ['clone-1'])
  assert.equal(status, 'closed')
})

test('startup reconciliation completes a closing session and disables every clone', () => {
  const db = openWorkshopDb(':memory:')
  const repo = createChannelSessionRepo(db)
  const session = repo.create({ channelId: 'ch-1', memberMap: { m1: 'clone-1', m2: 'clone-2' } })
  assert.equal(repo.beginClosing(session.id), true)
  assert.equal(repo.findById(session.id)?.status, 'closing')

  const disabled: string[] = []
  const closed = reconcileClosingSessions(repo, (_channelId, cloneId) => {
    // 一个成员行已被删除(失败)不得阻断其余 clone 与会话收敛
    if (cloneId === 'clone-2') throw new Error('member row already gone')
    disabled.push(cloneId)
  })

  assert.equal(closed, 1)
  assert.deepEqual(disabled, ['clone-1'])
  const after = repo.findById(session.id)
  assert.equal(after?.status, 'closed')
  assert.equal(typeof after?.closedAt, 'string')

  // 幂等:没有 closing 会话时不再执行任何停用动作
  const again = reconcileClosingSessions(repo, () => {
    throw new Error('must not run')
  })
  assert.equal(again, 0)
  db.close()
})

test('closing a session that is already closed is a no-op', async () => {
  const repo = {
    findById: () => ({ status: 'closed', memberMapJson: '{}' }),
    beginClosing: () => false,
    close: () => false,
  }
  const deps = {
    tasks: { list: () => [], cancelTree: () => [] },
    unloadAgent: async () => {},
  } as unknown as Parameters<typeof closeChannelSession>[0]
  const result = await closeChannelSession(deps, { channelId: 'ch', sessionId: 's1', actorId: 'u1', sessionRepo: repo })
  assert.deepEqual(result, { canceledTasks: 0, clones: [] })
})
