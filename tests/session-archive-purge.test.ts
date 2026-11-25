/**
 * 会话归档与永久清理(Ralph 2026-11-25):
 *  - archived_at 增量补列;listByChannel 默认隐藏已归档,归档清单单独可查;
 *  - 永久清理只允许「已归档 + 已关闭 + 手工会话」,级联删除该会话的 clone 成员、
 *    mailbox/群聊/任务/记忆,同频道其他会话与审计事件保持完整。
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-session-archive-'))
delete process.env.DAQ_TSDB_URL

const { openWorkshopDb } = await import('../server/services/workshop/db/database/open')
const { createChannelSessionRepo } = await import('../server/services/workshop/db/channel-session.repo')
const { purgeArchivedSessionData } = await import('../server/services/workshop/agents/session-purge')

const NOW = '2026-11-25T10:00:00.000Z'

function seedChannel(db: ReturnType<typeof openWorkshopDb>, channelId: string): void {
  db.prepare('INSERT INTO channels (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(channelId, `channel-${channelId}`, NOW, NOW)
}

function seedAgent(db: ReturnType<typeof openWorkshopDb>, channelId: string, id: string, role = 'worker'): void {
  db.prepare(`INSERT INTO channel_agents (id, channel_id, name, harness, role, token, enabled, created_at, updated_at)
    VALUES (?, ?, ?, 'mock', ?, ?, 1, ?, ?)`)
    .run(id, channelId, id, role, `token-${id}`, NOW, NOW)
}

function seedMailbox(db: ReturnType<typeof openWorkshopDb>, id: string, channelId: string, sessionId: string, from: string, to: string): void {
  db.prepare(`INSERT INTO messages (id, channel_id, session_id, from_agent_id, to_agent_id, role, parts_json, state, created_at)
    VALUES (?, ?, ?, ?, ?, 'ROLE_USER', '[]', 'pending', ?)`)
    .run(id, channelId, sessionId, from, to, NOW)
}

function seedTask(db: ReturnType<typeof openWorkshopDb>, id: string, channelId: string, sessionId: string | null, assigneeId: string, parentId: string | null = null): void {
  db.prepare(`INSERT INTO tasks (id, channel_id, parent_id, assignee_id, title, state, session_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'CANCELED', ?, ?, ?)`)
    .run(id, channelId, parentId, assigneeId, id, sessionId, NOW, NOW)
}

function seedChat(db: ReturnType<typeof openWorkshopDb>, id: string, channelId: string, sessionId: string, senderId: string, targetAgentId: string): void {
  db.prepare(`INSERT INTO chat_messages (id, channel_id, session_id, sender_type, sender_id, text, client_message_id, created_at)
    VALUES (?, ?, ?, 'user', ?, 'hello', ?, ?)`)
    .run(id, channelId, sessionId, senderId, `cm-${id}`, NOW)
  db.prepare(`INSERT INTO chat_deliveries (id, chat_message_id, channel_id, session_id, target_agent_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(`d-${id}`, id, channelId, sessionId, targetAgentId, NOW, NOW)
}

function seedMemory(db: ReturnType<typeof openWorkshopDb>, id: string, channelId: string, agentId: string, sessionId: string): void {
  db.prepare(`INSERT INTO agent_memories (id, channel_id, agent_id, kind, title, title_fts, content, dedup_key, session_id, created_at)
    VALUES (?, ?, ?, 'episodic-task', ?, ?, ?, ?, ?, ?)`)
    .run(id, channelId, agentId, id, id, id, `dedup-${id}`, sessionId, NOW)
}

function seedSubscription(db: ReturnType<typeof openWorkshopDb>, channelId: string, agentId: string, targetAgentId: string): void {
  db.prepare(`INSERT INTO subscriptions (channel_id, agent_id, target_agent_id, created_at) VALUES (?, ?, ?, ?)`)
    .run(channelId, agentId, targetAgentId, NOW)
}

function count(db: ReturnType<typeof openWorkshopDb>, sql: string, ...params: Array<string | null>): number {
  return Number((db.prepare(sql).get(...params) as { n?: number } | undefined)?.n ?? 0)
}

test('archiving hides a session from channel listings and restore brings it back', () => {
  const db = openWorkshopDb(':memory:')
  try {
    const sessions = createChannelSessionRepo(db)
    const archived = sessions.create({ channelId: 'ch-1', title: 'A', memberMap: { m1: 'clone-a1' } })
    const visible = sessions.create({ channelId: 'ch-1', title: 'B', memberMap: { m1: 'clone-b1' } })
    assert.equal(archived.archivedAt, null, 'new sessions are not archived')

    assert.equal(sessions.setArchived(archived.id, NOW), true)
    const row = sessions.findById(archived.id)
    assert.equal(row?.archivedAt, NOW, 'archived timestamp is persisted')
    assert.deepEqual(sessions.listByChannel('ch-1').map(s => s.id), [visible.id], 'default listing hides archived sessions')
    assert.deepEqual(sessions.listArchivedByChannel('ch-1').map(s => s.id), [archived.id], 'archive listing only returns archived rows')

    assert.equal(sessions.setArchived(archived.id, null), true)
    assert.equal(sessions.findById(archived.id)?.archivedAt, null)
    assert.equal(sessions.listByChannel('ch-1').length, 2, 'restored session is listed again')

    assert.equal(sessions.rename(archived.id, 'renamed'), true)
    assert.equal(sessions.findById(archived.id)?.title, 'renamed')

    assert.equal(sessions.remove(archived.id), true)
    assert.equal(sessions.findById(archived.id), undefined)
    assert.equal(sessions.remove(archived.id), false, 'removing a missing row is not reported as success')
  }
  finally {
    db.close()
  }
})

test('permanent purge deletes only the archived session data and keeps other sessions intact', () => {
  const db = openWorkshopDb(':memory:')
  try {
    seedChannel(db, 'ch-1')
    seedAgent(db, 'ch-1', 'base-lead', 'lead')
    seedAgent(db, 'ch-1', 'clone-a1')
    seedAgent(db, 'ch-1', 'clone-a2')
    seedAgent(db, 'ch-1', 'clone-b1')
    const sessions = createChannelSessionRepo(db)
    const target = sessions.create({ channelId: 'ch-1', title: 'target', memberMap: { lead: 'clone-a1', worker: 'clone-a2' } })
    const other = sessions.create({ channelId: 'ch-1', title: 'other', memberMap: { lead: 'clone-b1' } })

    seedMailbox(db, 'm-a', 'ch-1', target.id, 'user-1', 'clone-a1')
    seedMailbox(db, 'm-b', 'ch-1', other.id, 'user-1', 'clone-b1')
    seedMailbox(db, 'm-channel', 'ch-1', '', 'user-1', 'base-lead')
    // 旧路径/直投可能不落 session_id：仍必须按 clone 身份命中。
    seedMailbox(db, 'm-clone-only', 'ch-1', '', 'user-1', 'clone-a1')
    seedMailbox(db, 'm-clone-from', 'ch-1', '', 'clone-a1', 'base-lead')
    seedTask(db, 't-a', 'ch-1', target.id, 'clone-a1')
    seedTask(db, 't-a-child', 'ch-1', null, 'base-lead', 't-a')
    seedTask(db, 't-a-null', 'ch-1', null, 'clone-a2')
    seedTask(db, 't-b', 'ch-1', other.id, 'clone-b1')
    seedTask(db, 't-b-child', 'ch-1', null, 'base-lead', 't-b')
    seedChat(db, 'c-a', 'ch-1', target.id, 'user-1', 'clone-a1')
    seedChat(db, 'c-b', 'ch-1', other.id, 'user-1', 'clone-b1')
    seedMemory(db, 'mem-a', 'ch-1', 'clone-a1', target.id)
    seedMemory(db, 'mem-b', 'ch-1', 'clone-b1', other.id)
    seedMemory(db, 'mem-team', 'ch-1', '__team__', '')
    // shared 策略会把团队行也带上当前 session_id；它仍是频道级共享行，不能随会话删除。
    seedMemory(db, 'mem-team-session', 'ch-1', '__team__', target.id)
    seedSubscription(db, 'ch-1', 'clone-a1', 'base-lead')
    seedSubscription(db, 'ch-1', 'base-lead', 'clone-a1')
    seedSubscription(db, 'ch-1', 'clone-b1', 'base-lead')

    assert.equal(sessions.setArchived(target.id, NOW), true)
    assert.equal(sessions.close(target.id), true)
    const session = sessions.findById(target.id)!
    const counts = purgeArchivedSessionData(db, session)

    assert.deepEqual(counts, {
      sessions: 1,
      agents: 2,
      messages: 3,
      tasks: 3,
      chatMessages: 1,
      chatDeliveries: 1,
      memories: 1,
    })
    assert.equal(sessions.findById(target.id), undefined, 'session row is gone')
    assert.ok(sessions.findById(other.id), 'other session survives')
    assert.equal(count(db, `SELECT COUNT(*) AS n FROM channel_agents WHERE id IN ('clone-a1','clone-a2')`), 0)
    assert.equal(count(db, `SELECT COUNT(*) AS n FROM channel_agents WHERE id IN ('base-lead','clone-b1')`), 2, 'base members and other sessions survive')
    assert.equal(count(db, `SELECT COUNT(*) AS n FROM messages WHERE session_id = ?`, target.id), 0)
    assert.equal(count(db, `SELECT COUNT(*) AS n FROM messages WHERE id IN ('m-clone-only','m-clone-from')`), 0, 'clone-only mailbox rows are purged')
    assert.equal(count(db, `SELECT COUNT(*) AS n FROM messages WHERE session_id IN ('', ?)`, other.id), 2, 'other session and base mailbox rows survive')
    assert.equal(count(db, `SELECT COUNT(*) AS n FROM tasks WHERE id IN ('t-a','t-a-child','t-a-null')`), 0)
    assert.equal(count(db, `SELECT COUNT(*) AS n FROM tasks WHERE id IN ('t-b','t-b-child')`), 2, 'other session task tree survives')
    assert.equal(count(db, `SELECT COUNT(*) AS n FROM chat_messages WHERE session_id = ?`, target.id), 0)
    assert.equal(count(db, `SELECT COUNT(*) AS n FROM chat_messages WHERE session_id = ?`, other.id), 1)
    assert.equal(count(db, `SELECT COUNT(*) AS n FROM chat_deliveries WHERE session_id = ?`, target.id), 0)
    assert.equal(count(db, `SELECT COUNT(*) AS n FROM chat_deliveries WHERE session_id = ?`, other.id), 1)
    assert.equal(count(db, `SELECT COUNT(*) AS n FROM agent_memories WHERE agent_id = 'clone-a1'`), 0)
    assert.equal(count(db, `SELECT COUNT(*) AS n FROM agent_memories WHERE agent_id IN ('clone-b1','__team__')`), 3, 'other memories and both team rows survive')
    assert.equal(count(db, `SELECT COUNT(*) AS n FROM subscriptions WHERE agent_id = 'clone-a1' OR target_agent_id = 'clone-a1'`), 0)
    assert.equal(count(db, `SELECT COUNT(*) AS n FROM subscriptions WHERE agent_id = 'clone-b1' OR target_agent_id = 'clone-b1'`), 1, 'other session subscriptions survive')
  }
  finally {
    db.close()
  }
})

function assertCode(fn: () => unknown, code: string): void {
  assert.throws(fn, (err: unknown) => (err as { code?: string } | null)?.code === code)
}

test('purge re-reads the session row inside the transaction', () => {
  const db = openWorkshopDb(':memory:')
  try {
    const sessions = createChannelSessionRepo(db)
    const session = sessions.create({ channelId: 'ch-1', title: 'stale snapshot', memberMap: {} })
    sessions.setArchived(session.id, NOW)
    sessions.close(session.id)
    const snapshot = sessions.findById(session.id)!
    // 通过闸门后并发 restore：purge 不得用旧快照继续删除。
    sessions.setArchived(session.id, null)
    assertCode(() => purgeArchivedSessionData(db, snapshot), 'SESSION_NOT_ARCHIVED')
    assert.ok(sessions.findById(session.id), 'row survives a stale-snapshot purge')
    // 重新归档后，同一旧快照只能作为 id 使用；事务内读到最新行才允许删除。
    sessions.setArchived(session.id, NOW)
    const counts = purgeArchivedSessionData(db, snapshot)
    assert.equal(counts.sessions, 1)
    assert.equal(sessions.findById(session.id), undefined)
  }
  finally {
    db.close()
  }
})

test('permanent purge refuses unarchived, unclosed or managed sessions', () => {
  const db = openWorkshopDb(':memory:')
  try {
    const sessions = createChannelSessionRepo(db)
    const active = sessions.create({ channelId: 'ch-1', title: 'active', memberMap: {} })
    assertCode(() => purgeArchivedSessionData(db, sessions.findById(active.id)!), 'SESSION_NOT_ARCHIVED')

    sessions.setArchived(active.id, NOW)
    assertCode(() => purgeArchivedSessionData(db, sessions.findById(active.id)!), 'SESSION_NOT_CLOSED')

    sessions.close(active.id)
    assert.doesNotThrow(() => purgeArchivedSessionData(db, sessions.findById(active.id)!))

    const managed = sessions.create({ channelId: 'ch-1', title: 'managed', memberMap: {}, instanceKind: 'task' })
    sessions.setArchived(managed.id, NOW)
    sessions.close(managed.id)
    assertCode(() => purgeArchivedSessionData(db, sessions.findById(managed.id)!), 'SESSION_MANAGED')
  }
  finally {
    db.close()
  }
})
