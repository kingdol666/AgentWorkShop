import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'

const { openWorkshopDb } = await import('../server/services/workshop/db/database')
const { createChannelRepo } = await import('../server/services/workshop/db/channel.repo')
const { createAgentRepo } = await import('../server/services/workshop/db/agent.repo')
const { createChannelAgentRepo } = await import('../server/services/workshop/db/channel-agent.repo')
const { createTaskRepo } = await import('../server/services/workshop/db/task.repo')
const { createMemoryRepo } = await import('../server/services/workshop/db/memory.repo')
const { createChannelEventRepo } = await import('../server/services/workshop/db/channel-event.repo')
const { createTeamRepo } = await import('../server/services/workshop/db/team.repo')
const { createTeamMemberRepo } = await import('../server/services/workshop/db/team-member.repo')
const { createMessageRepo } = await import('../server/services/workshop/db/message.repo')
const { createSubscriptionRepo } = await import('../server/services/workshop/db/subscription.repo')
const { createChannelSessionRepo } = await import('../server/services/workshop/db/channel-session.repo')
const { createAgentChannelManager } = await import('../server/services/workshop/runtime/manager')
const { createAgentImpl } = await import('../server/services/workshop/agents/factory')

function fixture() {
  const db = openWorkshopDb(':memory:')
  const channels = createChannelRepo(db)
  const agents = createAgentRepo(db)
  const channelAgents = createChannelAgentRepo(db)
  const tasks = createTaskRepo(db)
  const messages = createMessageRepo(db)
  const channel = channels.create({ name: 'session idempotency', ownerUserId: 'user-1' })
  const base = channelAgents.create({ channelId: channel.id, templateId: null, name: 'lead', harness: 'mock', role: 'lead' })
  const clone = channelAgents.create({ channelId: channel.id, templateId: null, name: 'lead·session·1', harness: 'mock', role: 'worker' })
  channels.update(channel.id, { leadAgentId: base.id })
  const session = createChannelSessionRepo(db).create({
    channelId: channel.id,
    title: 'idempotency session',
    memberMap: { [base.id]: clone.id },
    createdBy: 'user-1',
  })
  const manager = createAgentChannelManager({
    repos: {
      channels,
      agents,
      channelAgents,
      messages,
      subscriptions: createSubscriptionRepo(db),
      tasks,
      memories: createMemoryRepo(db),
      channelEvents: createChannelEventRepo(db),
      teams: createTeamRepo(db),
      teamMembers: createTeamMemberRepo(db),
    },
    implFactory: createAgentImpl,
    db,
  })
  return { db, manager, messages, channel, session, clone }
}

test('session endpoint forwards clientMessageId instead of dropping it', () => {
  const source = readFileSync('server/api/workshop/channels/[id]/sessions/[sid]/messages.post.ts', 'utf8')
  assert.match(source, /clientMessageId:\s*body\.clientMessageId/)
})

test('concurrent identical session clientMessageId requests share one atomic message', async () => {
  const f = fixture()
  try {
    const input = {
      channelId: f.channel.id,
      sessionId: f.session.id,
      actor: { id: 'user-1', role: 'user' },
      text: '并发请求应只入队一次',
      clientMessageId: 'session-concurrent-same-1',
    }
    const results = await Promise.all(Array.from({ length: 8 }, () => f.manager.sendSessionMessage(input as never)))
    assert.equal(new Set(results.map(result => result.messageId)).size, 1, '相同 payload 并发请求必须共享同一 messageId')
    assert.equal(new Set(results.map(result => result.toAgentId)).size, 1)
    const rows = f.messages.listRecentByChannel(f.channel.id, 50)
      .filter(row => row.sessionId === f.session.id && row.actorUserId === input.actor.id && row.clientMessageId === input.clientMessageId)
    assert.equal(rows.length, 1, '原子唯一键必须只留下一个 mailbox 行')
  }
  finally {
    await f.manager.shutdown()
    f.db.close()
  }
})

test('concurrent different session payloads deterministically reject the loser with conflict', async () => {
  const f = fixture()
  try {
    const base = {
      channelId: f.channel.id,
      sessionId: f.session.id,
      actor: { id: 'user-1', role: 'user' },
      clientMessageId: 'session-concurrent-conflict-1',
    }
    const results = await Promise.allSettled([
      f.manager.sendSessionMessage({ ...base, text: 'payload-A' } as never),
      f.manager.sendSessionMessage({ ...base, text: 'payload-B' } as never),
    ])
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
    const rejected = results.find(result => result.status === 'rejected')
    assert.ok(rejected && rejected.status === 'rejected')
    assert.equal((rejected.reason as { code?: string }).code, 'SESSION_MESSAGE_IDEMPOTENCY_CONFLICT')
    const rows = f.messages.listRecentByChannel(f.channel.id, 50)
      .filter(row => row.sessionId === f.session.id && row.actorUserId === base.actor.id && row.clientMessageId === base.clientMessageId)
    assert.equal(rows.length, 1, '冲突并发不得产生第二条消息')
  }
  finally {
    await f.manager.shutdown()
    f.db.close()
  }
})
