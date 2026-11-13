/**
 * Session Context（A 方案 M1）：brief / history / catalog / session_id 落库。
 * 纯内存 DB；不依赖 manager/harness。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-session-context-'))
delete process.env.AW_BENCH_MODE

const { openWorkshopDb } = await import('../server/services/workshop/db/database')
const { createChannelRepo } = await import('../server/services/workshop/db/channel.repo')
const { createTaskRepo } = await import('../server/services/workshop/db/task.repo')
const { createMessageRepo } = await import('../server/services/workshop/db/message.repo')
const { createChannelSessionRepo } = await import('../server/services/workshop/db/channel-session.repo')
const { SessionContextService, formatBriefText } = await import('../server/services/workshop/sessions/context')

function fixture() {
  const db = openWorkshopDb(':memory:')
  const channels = createChannelRepo(db)
  const tasks = createTaskRepo(db)
  const messages = createMessageRepo(db)
  const sessions = createChannelSessionRepo(db)
  const channel = channels.create({ name: '交付频道', ownerUserId: 'u-owner' })
  const session = sessions.create({
    channelId: channel.id,
    title: '交付会话 A',
    memberMap: { 'base-lead': 'clone-lead' },
    createdBy: 'u-owner',
    instanceKind: 'manual',
  })
  return { db, channels, tasks, messages, sessions, channel, session }
}

test('brief：session_id 贯通 task/message，brief/history/catalog 可读', () => {
  const f = fixture()
  try {
    const task = f.tasks.create({
      channelId: f.channel.id,
      assigneeId: 'clone-lead',
      creatorId: 'u-owner',
      title: '交付值班手册',
      description: '覆盖巡检/升级/交接',
      state: 'WORKING',
      progress: 40,
      sessionId: f.session.id,
    })
    f.messages.create({
      channelId: f.channel.id,
      taskId: task.id,
      sessionId: f.session.id,
      fromAgentId: null,
      toAgentId: 'clone-lead',
      role: 'ROLE_USER',
      parts: [{ text: '请先补 FAQ 增量' }],
      metadata: { 'x-aw-session-id': f.session.id },
    })
    const svc = new SessionContextService(f.db, f.sessions)
    const brief = svc.buildBrief(f.session.id, { refresh: true })
    assert.ok(brief)
    assert.equal(brief!.kind, 'manual')
    assert.equal(brief!.currentTask?.title, '交付值班手册')
    assert.equal(brief!.currentTask?.progress, 40)
    assert.match(brief!.recentMessages[0]?.text ?? '', /FAQ/)
    assert.equal(brief!.nextStep, '执行中（40%）')
    assert.match(formatBriefText(brief!), /Session Boundary/)
    assert.match(formatBriefText(brief!), /session_id=/)

    const history = svc.history(f.session.id)
    assert.ok(history.some(h => h.type === 'task' && h.text === '交付值班手册'))
    assert.ok(history.some(h => h.type === 'message' && /FAQ/.test(h.text ?? '')))

    const catalog = svc.catalog(f.channel.id)
    assert.equal(catalog.length, 1)
    assert.equal(catalog[0]!.id, f.session.id)
    assert.match(catalog[0]!.summary, /交付值班手册/)

    // 刷新回写 summary/brief_json/last_active_at
    const row = f.sessions.findById(f.session.id)!
    assert.ok(row.summary.length > 0)
    assert.notEqual(row.briefJson, '{}')
    assert.ok(row.lastActiveAt)
  }
  finally {
    f.db.close()
  }
})

test('history：关闭后的 session 仍可读，catalog 标记 closed', () => {
  const f = fixture()
  try {
    f.tasks.create({
      channelId: f.channel.id,
      assigneeId: 'clone-lead',
      creatorId: 'u-owner',
      title: '已完成任务',
      state: 'COMPLETED',
      sessionId: f.session.id,
    })
    f.sessions.close(f.session.id)
    const svc = new SessionContextService(f.db, f.sessions)
    const brief = svc.buildBrief(f.session.id, { refresh: true })
    assert.equal(brief?.status, 'closed')
    assert.equal(brief?.currentTask?.state, 'COMPLETED')
    assert.equal(brief?.nextStep, '任务已完成，等待成果验收')
    assert.equal(svc.catalog(f.channel.id)[0]?.status, 'closed')
    assert.ok(svc.history(f.session.id).length > 0)
  }
  finally {
    f.db.close()
  }
})

test('task session：无 session_id 的同频道旧任务不再回退混入 authoritative context', () => {
  const f = fixture()
  try {
    const taskSession = f.sessions.create({
      channelId: f.channel.id,
      title: '任务实例会话',
      memberMap: { 'base-lead': 'task-lead' },
      projectId: 'p-1',
      projectWorkItemId: 'wi-1',
      createdByKind: 'project',
      instanceKind: 'task',
    })
    // 旧任务（本迁移前）只有 channel_id，没有 session_id；不得成为当前 session 的权威事实。
    f.tasks.create({
      channelId: f.channel.id,
      assigneeId: 'task-lead',
      creatorId: 'project:p-1',
      title: '遗留任务',
      state: 'WORKING',
    })
    const svc = new SessionContextService(f.db, f.sessions)
    const brief = svc.buildBrief(taskSession.id, { refresh: true })
    assert.equal(brief?.kind, 'task')
    assert.equal(brief?.tasks.length, 0)
    assert.equal(brief?.currentTask, null)
  }
  finally {
    f.db.close()
  }
})

test('task/project sessions：同频道双 session 只读严格 session_id，NULL 行不得混入', () => {
  const f = fixture()
  try {
    const taskSession = f.sessions.create({
      channelId: f.channel.id,
      title: '任务会话',
      memberMap: {},
      instanceKind: 'task',
    })
    const projectSession = f.sessions.create({
      channelId: f.channel.id,
      title: '项目会话',
      memberMap: {},
      instanceKind: 'project',
    })
    const taskA = f.tasks.create({
      channelId: f.channel.id,
      assigneeId: 'task-lead',
      title: '任务 A 权威事实',
      state: 'WORKING',
      sessionId: taskSession.id,
    })
    const taskB = f.tasks.create({
      channelId: f.channel.id,
      assigneeId: 'project-lead',
      title: '项目 B 权威事实',
      state: 'WORKING',
      sessionId: projectSession.id,
    })
    f.tasks.create({
      channelId: f.channel.id,
      assigneeId: 'legacy-lead',
      title: 'NULL 遗留事实',
      state: 'WORKING',
    })
    f.messages.create({
      channelId: f.channel.id,
      taskId: taskA.id,
      sessionId: taskSession.id,
      role: 'ROLE_USER',
      parts: [{ text: 'task-session-A message' }],
    })
    f.messages.create({
      channelId: f.channel.id,
      taskId: taskB.id,
      sessionId: projectSession.id,
      role: 'ROLE_USER',
      parts: [{ text: 'project-session-B message' }],
    })
    f.messages.create({
      channelId: f.channel.id,
      role: 'ROLE_USER',
      parts: [{ text: 'NULL legacy message' }],
    })

    const svc = new SessionContextService(f.db, f.sessions)
    const taskBrief = svc.buildBrief(taskSession.id)
    const projectBrief = svc.buildBrief(projectSession.id)
    assert.deepEqual(taskBrief?.tasks.map(t => t.title), ['任务 A 权威事实'])
    assert.deepEqual(projectBrief?.tasks.map(t => t.title), ['项目 B 权威事实'])
    assert.deepEqual(taskBrief?.recentMessages.map(m => m.text), ['task-session-A message'])
    assert.deepEqual(projectBrief?.recentMessages.map(m => m.text), ['project-session-B message'])
    assert.ok(!JSON.stringify(taskBrief).includes('NULL'))
    assert.ok(!JSON.stringify(projectBrief).includes('NULL'))

    const taskHistory = svc.history(taskSession.id)
    const projectHistory = svc.history(projectSession.id)
    assert.deepEqual(taskHistory.filter(h => h.type === 'message').map(h => h.text), ['task-session-A message'])
    assert.deepEqual(projectHistory.filter(h => h.type === 'message').map(h => h.text), ['project-session-B message'])
    assert.ok(!JSON.stringify(taskHistory).includes('project-session-B'))
    assert.ok(!JSON.stringify(projectHistory).includes('task-session-A'))
  }
  finally {
    f.db.close()
  }
})

test('history：混合 task/message 按 created_at 排序，同时间按 source 和表内 rowid 稳定排序', () => {
  const f = fixture()
  try {
    const task1 = f.tasks.create({ channelId: f.channel.id, assigneeId: 'lead', title: 'task-1', sessionId: f.session.id })
    const task2 = f.tasks.create({ channelId: f.channel.id, assigneeId: 'lead', title: 'task-2', sessionId: f.session.id })
    const message1 = f.messages.create({ channelId: f.channel.id, sessionId: f.session.id, role: 'ROLE_USER', parts: [{ text: 'message-1' }] })
    const message2 = f.messages.create({ channelId: f.channel.id, sessionId: f.session.id, role: 'ROLE_USER', parts: [{ text: 'message-2' }] })
    f.db.prepare('UPDATE tasks SET created_at = ? WHERE id = ?').run('2026-01-01T00:00:01.000Z', task1.id)
    f.db.prepare('UPDATE tasks SET created_at = ? WHERE id = ?').run('2026-01-01T00:00:02.000Z', task2.id)
    f.db.prepare('UPDATE messages SET created_at = ? WHERE id = ?').run('2026-01-01T00:00:02.000Z', message1.id)
    f.db.prepare('UPDATE messages SET created_at = ? WHERE id = ?').run('2026-01-01T00:00:02.000Z', message2.id)

    const history = new SessionContextService(f.db, f.sessions).history(f.session.id)
    assert.deepEqual(history.map(item => item.text), ['task-1', 'task-2', 'message-1', 'message-2'])
  }
  finally {
    f.db.close()
  }
})

test('recent/history：300 条消息返回真正最新窗口，rowid DESC 后 reverse', () => {
  const f = fixture()
  try {
    for (let i = 1; i <= 300; i++) {
      f.messages.create({
        channelId: f.channel.id,
        sessionId: f.session.id,
        role: 'ROLE_USER',
        parts: [{ text: `message-${String(i).padStart(3, '0')}` }],
      })
    }
    const svc = new SessionContextService(f.db, f.sessions)
    const brief = svc.buildBrief(f.session.id)
    assert.deepEqual(brief?.recentTurns.map(m => m.text), [
      'message-293', 'message-294', 'message-295', 'message-296',
      'message-297', 'message-298', 'message-299', 'message-300',
    ])
    assert.deepEqual(svc.history(f.session.id, 8).filter(h => h.type === 'message').map(h => h.text), [
      'message-293', 'message-294', 'message-295', 'message-296',
      'message-297', 'message-298', 'message-299', 'message-300',
    ])
  }
  finally {
    f.db.close()
  }
})

test('compaction：稳定 created_at+id cursor 在删除重插后不重复或停滞', () => {
  const f = fixture()
  try {
    for (let i = 1; i <= 10; i++) {
      f.messages.create({
        channelId: f.channel.id,
        sessionId: f.session.id,
        role: 'ROLE_USER',
        parts: [{ text: `retained-${String(i).padStart(2, '0')}` }],
      })
    }
    const svc = new SessionContextService(f.db, f.sessions)
    const first = svc.buildBrief(f.session.id, { refresh: true })!
    assert.ok(first.compressed.uptoCreatedAt)
    const stored = f.sessions.findById(f.session.id)!
    const storedCompressed = JSON.parse(stored.briefJson).compressed as { uptoCreatedAt?: string, uptoMessageId?: string }
    assert.equal(storedCompressed.uptoCreatedAt, first.compressed.uptoCreatedAt)
    assert.equal(storedCompressed.uptoMessageId, first.compressed.uptoMessageId)
    const cursorId = first.compressed.uptoMessageId
    f.db.prepare('DELETE FROM messages WHERE id = ?').run(cursorId)
    f.messages.create({
      channelId: f.channel.id,
      sessionId: f.session.id,
      role: 'ROLE_USER',
      parts: [{ text: 'retained-after-delete-reinsert' }],
    })
    const second = svc.buildBrief(f.session.id, { refresh: true })!
    assert.equal(second.compressed.lines.filter(line => line.includes('retained-after-delete-reinsert')).length, 0, 'newer recent message must not be compacted')
    assert.ok(second.compressed.uptoCreatedAt >= first.compressed.uptoCreatedAt)
    assert.notEqual(second.compressed.uptoMessageId, cursorId)
  }
  finally {
    f.db.close()
  }
})

test('compaction：200 条非文本消息后仍推进 cursor 并折叠后续文本', () => {
  const f = fixture()
  try {
    for (let i = 1; i <= 200; i++) {
      const row = f.messages.create({
        channelId: f.channel.id,
        sessionId: f.session.id,
        role: 'ROLE_USER',
        parts: [{ url: `https://example.test/empty/${i}` }],
      })
      f.db.prepare('UPDATE messages SET created_at = ? WHERE id = ?').run(
        new Date(Date.parse('2026-01-01T00:00:00.000Z') + i * 1000).toISOString(),
        row.id,
      )
    }
    const afterEmpty = f.messages.create({
      channelId: f.channel.id,
      sessionId: f.session.id,
      role: 'ROLE_USER',
      parts: [{ text: 'after-empty-batch' }],
    })
    f.db.prepare('UPDATE messages SET created_at = ? WHERE id = ?').run('2026-01-01T00:03:21.000Z', afterEmpty.id)
    for (let i = 1; i <= 8; i++) {
      const row = f.messages.create({
        channelId: f.channel.id,
        sessionId: f.session.id,
        role: 'ROLE_USER',
        parts: [{ text: `post-empty-${i}` }],
      })
      f.db.prepare('UPDATE messages SET created_at = ? WHERE id = ?').run(
        new Date(Date.parse('2026-01-01T00:03:21.000Z') + i * 1000).toISOString(),
        row.id,
      )
    }
    const svc = new SessionContextService(f.db, f.sessions)
    const first = svc.buildBrief(f.session.id, { refresh: true })!
    const stored = f.sessions.findById(f.session.id)!
    const storedCompressed = JSON.parse(stored.briefJson).compressed as { uptoCreatedAt?: string, uptoMessageId?: string }
    assert.equal(storedCompressed.uptoCreatedAt, first.compressed.uptoCreatedAt)
    assert.equal(storedCompressed.uptoMessageId, first.compressed.uptoMessageId)
    const second = svc.buildBrief(f.session.id, { refresh: true })!
    assert.ok(first.compressed.uptoCreatedAt, 'empty rows must advance the cursor')
    assert.ok(second.compressed.uptoCreatedAt >= first.compressed.uptoCreatedAt)
    assert.ok(second.compressed.lines.some(line => line.includes('after-empty-batch')), 'text after empty batch must eventually compact')
  }
  finally {
    f.db.close()
  }
})

test('compaction：长 pinned 行与 topic 行总字符数不超过预算', () => {
  const f = fixture()
  try {
    for (let i = 1; i <= 30; i++) {
      f.messages.create({
        channelId: f.channel.id,
        sessionId: f.session.id,
        role: 'ROLE_USER',
        parts: [{ text: `决策：${String(i).padStart(2, '0')} ${'关键事实'.repeat(100)}` }],
      })
    }
    const brief = new SessionContextService(f.db, f.sessions).buildBrief(f.session.id)!
    assert.ok(brief.compressed.lines.length > 0)
    assert.ok(brief.compressed.lines.reduce((sum, line) => sum + line.length, 0) <= 1200)
    assert.equal(new Set(brief.compressed.lines).size, brief.compressed.lines.length)
    assert.ok(brief.compressed.lines.every(line => line.length <= 204), 'pinned retention must truncate each line deterministically')
  }
  finally {
    f.db.close()
  }
})

test('compaction：uptoSeq 作为游标分批推进，超过 200 条不停止或重复', () => {
  const f = fixture()
  try {
    for (let i = 1; i <= 300; i++) {
      const row = f.messages.create({
        channelId: f.channel.id,
        sessionId: f.session.id,
        role: 'ROLE_USER',
        parts: [{ text: `compact-${String(i).padStart(3, '0')}` }],
      })
      f.db.prepare('UPDATE messages SET created_at = ? WHERE id = ?').run(
        new Date(Date.parse('2026-01-01T00:00:00.000Z') + i * 1000).toISOString(),
        row.id,
      )
    }
    const svc = new SessionContextService(f.db, f.sessions)
    const first = svc.buildBrief(f.session.id, { refresh: true })!
    const second = svc.buildBrief(f.session.id, { refresh: true })!
    const third = svc.buildBrief(f.session.id, { refresh: true })!
    assert.ok(first.compressed.uptoCreatedAt)
    assert.ok(
      second.compressed.uptoCreatedAt > first.compressed.uptoCreatedAt
      || (second.compressed.uptoCreatedAt === first.compressed.uptoCreatedAt
        && second.compressed.uptoMessageId > first.compressed.uptoMessageId),
      '第二批必须越过首批 stable cursor',
    )
    assert.equal(second.compressed.generation, first.compressed.generation + 1)
    assert.equal(third.compressed.uptoCreatedAt, second.compressed.uptoCreatedAt, '已到 recent window 后不得重复折叠')
    assert.equal(third.compressed.uptoMessageId, second.compressed.uptoMessageId, 'stable cursor 不得回退或重复')
    assert.equal(third.compressed.generation, second.compressed.generation)
    assert.equal(new Set(second.compressed.lines).size, second.compressed.lines.length, '压缩行不得重复')
    assert.ok(second.compressed.lines.some(line => line.includes('compact-292')), '第二批旧消息必须被折叠')
  }
  finally {
    f.db.close()
  }
})
