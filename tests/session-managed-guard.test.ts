/**
 * 会话生命周期边界（2026-11-25 评审回归）：
 * task/project 会话由项目生命周期管理，改名/归档必须在调用 close/停摘之前直接拒绝，
 * 且跨频道 sid 不得被按 id 越权操作。
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-session-managed-guard-'))
delete process.env.DAQ_TSDB_URL

const { openWorkshopDb } = await import('../server/services/workshop/db/database/open')
const { createChannelSessionRepo } = await import('../server/services/workshop/db/channel-session.repo')
const { ManagerAdminAgents } = await import('../server/services/workshop/runtime/manager/admin-agents')

type ManagerLike = {
  deps: { db: ReturnType<typeof openWorkshopDb>, repos: { channels: { findById: (id: string) => unknown } } }
  renameChannelSession: (input: { channelId: string, sessionId: string, actor: { id: string, role: string }, title: string }) => Promise<unknown>
  archiveChannelSession: (input: { channelId: string, sessionId: string, actor: { id: string, role: string } }) => Promise<unknown>
  restoreChannelSession: (input: { channelId: string, sessionId: string, actor: { id: string, role: string } }) => Promise<{ restored: true, already: boolean }>
  closeChannelSession?: (input: { channelId: string, sessionId: string, actor: { id: string, role: string }, reason?: string }) => Promise<{ canceledTasks: number, clones: string[] }>
  listArchivedSessions: (actor: { id: string, role: string }) => Array<{ channelId: string }>
  listChannelsVisibleTo: (actor: { id: string, role: string }) => unknown[]
}

function makeManager(db: ReturnType<typeof openWorkshopDb>, channelId = 'ch-1'): ManagerLike {
  const channel = {
    id: channelId, name: 'guard channel', description: '', scenarioPrompt: '', workspace: '',
    enabled: 1, channelMode: 'generic', leadAgentId: null, llmJson: '', ownerUserId: 'u-owner',
  }
  const manager = Object.create(ManagerAdminAgents.prototype) as ManagerLike
  manager.deps = { db, repos: { channels: { findById: () => channel } } }
  return manager
}

function assertCode(fn: () => Promise<unknown>, code: string): Promise<void> {
  return assert.rejects(fn, (err: unknown) => (err as { code?: string } | null)?.code === code) as Promise<void>
}

test('task/project sessions cannot be renamed or archived', async () => {
  const db = openWorkshopDb(':memory:')
  try {
    const sessions = createChannelSessionRepo(db)
    const task = sessions.create({ channelId: 'ch-1', title: 'task session', memberMap: {}, instanceKind: 'task', channelMode: 'generic' })
    const project = sessions.create({ channelId: 'ch-1', title: 'project session', memberMap: {}, instanceKind: 'project', channelMode: 'generic' })
    const manager = makeManager(db)
    const actor = { id: 'u-owner', role: 'user' }

    await assertCode(() => manager.renameChannelSession({ channelId: 'ch-1', sessionId: task.id, actor, title: 'renamed task' }), 'SESSION_MANAGED')
    await assertCode(() => manager.renameChannelSession({ channelId: 'ch-1', sessionId: project.id, actor, title: 'renamed project' }), 'SESSION_MANAGED')
    await assertCode(() => manager.archiveChannelSession({ channelId: 'ch-1', sessionId: task.id, actor }), 'SESSION_MANAGED')
    await assertCode(() => manager.archiveChannelSession({ channelId: 'ch-1', sessionId: project.id, actor }), 'SESSION_MANAGED')

    assert.equal(sessions.findById(task.id)?.title, 'task session', 'rejected rename leaves title unchanged')
    assert.equal(sessions.findById(task.id)?.archivedAt, null, 'rejected archive leaves row unarchived')
    assert.equal(sessions.findById(project.id)?.archivedAt, null)

    // 即使库里存在历史归档行（非 API 产生），恢复也不能把 managed 会话拉回普通清单。
    sessions.setArchived(task.id, '2026-11-25T00:00:00.000Z')
    sessions.close(task.id)
    await assertCode(() => manager.restoreChannelSession({ channelId: 'ch-1', sessionId: task.id, actor }), 'SESSION_MANAGED')
    assert.equal(sessions.findById(task.id)?.archivedAt, '2026-11-25T00:00:00.000Z')
  }
  finally {
    db.close()
  }
})

test('a session id from another channel is not addressable through this channel', async () => {
  const db = openWorkshopDb(':memory:')
  try {
    const sessions = createChannelSessionRepo(db)
    const foreign = sessions.create({ channelId: 'ch-other', title: 'foreign', memberMap: {}, channelMode: 'generic' })
    const manager = makeManager(db)
    const actor = { id: 'u-owner', role: 'user' }
    await assertCode(() => manager.renameChannelSession({ channelId: 'ch-1', sessionId: foreign.id, actor, title: 'hijack' }), 'NOT_FOUND')
    await assertCode(() => manager.archiveChannelSession({ channelId: 'ch-1', sessionId: foreign.id, actor }), 'NOT_FOUND')
    assert.equal(sessions.findById(foreign.id)?.title, 'foreign')
    assert.equal(sessions.findById(foreign.id)?.archivedAt, null)
  }
  finally {
    db.close()
  }
})

test('archived catalog stays owner-scoped even when channel visibility is broad', () => {
  const db = openWorkshopDb(':memory:')
  try {
    const sessions = createChannelSessionRepo(db)
    const own = sessions.create({ channelId: 'ch-1', title: 'own', memberMap: {}, channelMode: 'generic' })
    const other = sessions.create({ channelId: 'ch-2', title: 'other', memberMap: {}, channelMode: 'generic' })
    for (const id of [own.id, other.id]) {
      sessions.setArchived(id, '2026-11-25T00:00:00.000Z')
      sessions.close(id)
    }
    const manager = makeManager(db)
    // 产线可见性放开到两个频道，但 owner 过滤仍只允许本人频道。
    manager.listChannelsVisibleTo = () => [
      { id: 'ch-1', name: 'own channel', ownerUserId: 'u-owner' },
      { id: 'ch-2', name: 'other channel', ownerUserId: 'u-other' },
    ]
    const rows = manager.listArchivedSessions({ id: 'u-owner', role: 'user' })
    assert.deepEqual(rows.map(row => row.channelId), ['ch-1'])
    const adminRows = manager.listArchivedSessions({ id: 'u-admin', role: 'admin' })
    assert.deepEqual(adminRows.map(row => row.channelId).sort(), ['ch-1', 'ch-2'], 'admin sees both channels')
  }
  finally {
    db.close()
  }
})

test('restore is idempotent and returns the row to the normal catalog', async () => {
  const db = openWorkshopDb(':memory:')
  try {
    const sessions = createChannelSessionRepo(db)
    const session = sessions.create({ channelId: 'ch-1', title: 'archived', memberMap: {}, channelMode: 'generic' })
    sessions.setArchived(session.id, '2026-11-25T00:00:00.000Z')
    sessions.close(session.id)
    const manager = makeManager(db)
    const actor = { id: 'u-owner', role: 'user' }
    const first = await manager.restoreChannelSession({ channelId: 'ch-1', sessionId: session.id, actor })
    const second = await manager.restoreChannelSession({ channelId: 'ch-1', sessionId: session.id, actor })
    assert.equal(first.already, false)
    assert.equal(second.already, true, 'second restore is a no-op')
    assert.equal(sessions.findById(session.id)?.archivedAt, null)
    assert.ok(sessions.listByChannel('ch-1').some(row => row.id === session.id), 'restored row is back in the normal list')
  }
  finally {
    db.close()
  }
})

test('archive waits for an in-flight close before writing archived_at', async () => {
  const db = openWorkshopDb(':memory:')
  try {
    const sessions = createChannelSessionRepo(db)
    const session = sessions.create({ channelId: 'ch-1', title: 'active manual', memberMap: {}, channelMode: 'generic' })
    const manager = makeManager(db)
    manager.closeChannelSession = async () => {
      // 模拟并发 close 在飞：本调用先返回，150ms 后事务才收敛 closed。
      sessions.beginClosing(session.id)
      setTimeout(() => sessions.close(session.id), 150)
      return { canceledTasks: 1, clones: [] }
    }
    const result = await manager.archiveChannelSession({
      channelId: 'ch-1',
      sessionId: session.id,
      actor: { id: 'u-owner', role: 'user' },
    }) as { archived: boolean, archivedAt: string }
    assert.equal(result.archived, true)
    const stored = sessions.findById(session.id)
    assert.equal(stored?.status, 'closed')
    assert.ok(stored?.archivedAt, 'archived_at is only written after close convergence')
  }
  finally {
    db.close()
  }
})
