/**
 * Session Context：任务 session_id 贯通（root → 子任务 → assign 消息）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-session-task-link-'))
delete process.env.AW_BENCH_MODE

const { openWorkshopDb } = await import('../server/services/workshop/db/database')
const { createTaskRepo } = await import('../server/services/workshop/db/task.repo')
const { createMessageRepo } = await import('../server/services/workshop/db/message.repo')
const { TaskEngine } = await import('../server/services/workshop/runtime/task-engine')

function harness() {
  const db = openWorkshopDb(':memory:')
  const now = new Date().toISOString()
  db.prepare('INSERT INTO channels (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run('ch-session', 'session link', now, now)
  const repos = { tasks: createTaskRepo(db), messages: createMessageRepo(db) }
  const engine = new TaskEngine(repos, { onTaskChange: () => {} })
  return { db, repos, engine }
}

test('root session_id 落库；子任务继承；assign 消息带 session_id + metadata', () => {
  const f = harness()
  try {
    const root = f.engine.create({
      channelId: 'ch-session',
      creatorId: 'u-1',
      assigneeId: 'lead-1',
      title: 'root',
      sessionId: 'cs-test-1',
    })
    assert.equal(root.sessionId, 'cs-test-1')
    const child = f.engine.dispatch(root, {
      assigneeId: 'worker-1',
      title: 'child',
      description: 'do work',
    })
    assert.equal(child.sessionId, 'cs-test-1', '子任务必须继承父任务 session')
    const childRow = f.repos.tasks.findById(child.id)!
    assert.equal(childRow.sessionId, 'cs-test-1')

    const msg = f.repos.messages.firstPendingByChannelAgent('ch-session', 'worker-1')
    assert.ok(msg, 'assign 消息应落库')
    assert.equal(msg!.sessionId, 'cs-test-1')
    const meta = JSON.parse(msg!.metadataJson) as Record<string, unknown>
    assert.equal(meta['x-aw-session-id'], 'cs-test-1')
  }
  finally {
    f.db.close()
  }
})

test('createOrGetRoot 保留 session；同 source 幂等命中仍返回原 session', () => {
  const f = harness()
  try {
    const first = f.engine.createOrGetRoot({
      channelId: 'ch-session',
      creatorId: 'project:p-1',
      assigneeId: 'lead-1',
      title: 'root',
      sourceChatMessageId: 'src-1',
      sessionId: 'cs-root-1',
    })
    assert.equal(first.task.sessionId, 'cs-root-1')
    const again = f.engine.createOrGetRoot({
      channelId: 'ch-session',
      creatorId: 'project:p-1',
      assigneeId: 'lead-1',
      title: 'root changed',
      sourceChatMessageId: 'src-1',
      sessionId: 'cs-root-1',
    })
    assert.equal(again.created, false)
    assert.equal(again.task.sessionId, 'cs-root-1')
  }
  finally {
    f.db.close()
  }
})
