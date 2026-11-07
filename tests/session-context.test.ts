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

test('task session：无 session_id 的旧任务按实例 Channel 回退可见（legacy 兼容）', () => {
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
    // 旧任务（本迁移前）只有 channel_id，没有 session_id
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
    assert.equal(brief?.currentTask?.title, '遗留任务')
  }
  finally {
    f.db.close()
  }
})
