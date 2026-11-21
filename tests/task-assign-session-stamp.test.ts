/**
 * REST 直派(POST /channels/:id/tasks)的 assign 消息会话归属:
 * 目标是会话 clone → 服务端按持久化成员关系盖 x-aw-session-id(消息行 session_id 落戳);
 * 目标是基础成员 → 保持频道级(无戳)。与 sendA2A 的服务端派生同源,均不可由客户端伪造。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-task-assign-stamp-'))

const { openWorkshopDb } = await import('../server/services/workshop/db/database')
const { createChannelRepo } = await import('../server/services/workshop/db/channel.repo')
const { createAgentRepo } = await import('../server/services/workshop/db/agent.repo')
const { createChannelAgentRepo } = await import('../server/services/workshop/db/channel-agent.repo')
const { createTaskRepo } = await import('../server/services/workshop/db/task.repo')
const { createMemoryRepo } = await import('../server/services/workshop/db/memory.repo')
const { createChannelEventRepo } = await import('../server/services/workshop/db/channel-event.repo')
const { createChannelTemplateRepo } = await import('../server/services/workshop/db/channel-template.repo')
const { createTeamRepo } = await import('../server/services/workshop/db/team.repo')
const { createTeamMemberRepo } = await import('../server/services/workshop/db/team-member.repo')
const { createMessageRepo } = await import('../server/services/workshop/db/message.repo')
const { createSubscriptionRepo } = await import('../server/services/workshop/db/subscription.repo')
const { createScheduledTaskRepo } = await import('../server/services/workshop/db/scheduled-task.repo')
const { createChatMessageRepo } = await import('../server/services/workshop/db/chat-message.repo')
const { createOutboxRepo } = await import('../server/services/workshop/db/outbox.repo')
const { createAgentChannelManager } = await import('../server/services/workshop/runtime/manager')
const { createAgentImpl } = await import('../server/services/workshop/agents/factory')

function fixture() {
  const db = openWorkshopDb(':memory:')
  const repos = {
    channels: createChannelRepo(db),
    agents: createAgentRepo(db),
    channelAgents: createChannelAgentRepo(db),
    tasks: createTaskRepo(db),
    memories: createMemoryRepo(db),
    channelEvents: createChannelEventRepo(db),
    channelTemplates: createChannelTemplateRepo(db),
    teams: createTeamRepo(db),
    teamMembers: createTeamMemberRepo(db),
    messages: createMessageRepo(db),
    subscriptions: createSubscriptionRepo(db),
    schedules: createScheduledTaskRepo(db),
    chatMessages: createChatMessageRepo(db),
    outbox: createOutboxRepo(db),
  }
  const channel = repos.channels.create({ name: 'assign stamp', ownerUserId: 'user-1' })
  const lead = repos.channelAgents.create({ channelId: channel.id, templateId: null, name: 'lead', harness: 'mock', role: 'lead' })
  const worker = repos.channelAgents.create({ channelId: channel.id, templateId: null, name: 'worker', harness: 'mock', role: 'worker' })
  repos.channels.update(channel.id, { leadAgentId: lead.id })
  const manager = createAgentChannelManager({ db, repos, implFactory: createAgentImpl })
  return { db, repos, manager, channel, lead, worker }
}

test('direct assign to a session clone stamps the assign message with the persisted session', async (t) => {
  const f = fixture()
  t.after(async () => {
    await f.manager.shutdown()
    f.db.close()
  })
  const session = await f.manager.createChannelSession({
    channelId: f.channel.id,
    actor: { id: 'user-1', role: 'user' },
    title: 's1',
  })
  const cloneId = session.members.find(m => m.baseAgentId === f.worker.id)?.cloneId
  assert.ok(cloneId, 'worker clone must exist')

  const task = await f.manager.submitChannelTask({
    channelId: f.channel.id,
    title: 'clone assign probe',
    description: 'probe',
    assigneeId: cloneId,
    fromLabel: 'tester',
  })
  assert.equal(task.assigneeId, cloneId)
  // 状态无关读行:runtime 可能在 await 续体前已 claim(pending→consuming),按 id 查表才不依赖调度序
  const row = f.db.prepare('SELECT id, session_id AS sessionId, metadata_json AS metadataJson FROM messages WHERE to_agent_id = ? ORDER BY rowid DESC LIMIT 1').get(cloneId) as { sessionId: string | null, metadataJson: string } | undefined
  assert.ok(row, 'assign message must be enqueued')
  assert.equal(row.sessionId, session.sessionId, 'message row session_id must be stamped')
  const metadata = JSON.parse(row.metadataJson) as Record<string, unknown>
  assert.equal(metadata['x-aw-session-id'], session.sessionId)
  assert.equal(metadata['x-aw-task-kind'], 'assign')
})

test('direct assign to a base member keeps channel-level mail without a session stamp', async (t) => {
  const f = fixture()
  t.after(async () => {
    await f.manager.shutdown()
    f.db.close()
  })
  const task = await f.manager.submitChannelTask({
    channelId: f.channel.id,
    title: 'base assign probe',
    description: 'probe',
    assigneeId: f.worker.id,
    fromLabel: 'tester',
  })
  assert.equal(task.assigneeId, f.worker.id)
  const row = f.db.prepare('SELECT session_id AS sessionId FROM messages WHERE to_agent_id = ? ORDER BY rowid DESC LIMIT 1').get(f.worker.id) as { sessionId: string | null } | undefined
  assert.ok(row, 'assign message must be enqueued')
  assert.equal(row.sessionId ?? null, null, 'base member mail stays channel-level')
})
