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

test('duplicate session clientMessageId is isolated by actor and conflicts on payload mismatch', async () => {
  const f = fixture()
  try {
    const input = {
      channelId: f.channel.id,
      sessionId: f.session.id,
      actor: { id: 'user-1', role: 'user' },
      text: '请继续处理当前会话',
      clientMessageId: 'session-client-message-1',
    }
    const first = await f.manager.sendSessionMessage(input as never)
    const second = await f.manager.sendSessionMessage(input as never)
    assert.deepEqual(second, first, '重试应返回同一逻辑结果(messageId/toAgentId)')

    await assert.rejects(
      f.manager.sendSessionMessage({ ...input, text: '不同 payload' } as never),
      (err: unknown) => (err as { code?: string }).code === 'SESSION_MESSAGE_IDEMPOTENCY_CONFLICT',
    )

    const otherActor = await f.manager.sendSessionMessage({ ...input, actor: { id: 'user-2', role: 'admin' } } as never)
    assert.notEqual(otherActor.messageId, first.messageId, '不同 actor 必须有独立幂等命名空间')

    const rows = f.messages.listRecentByChannel(f.channel.id, 20)
      .filter(row => row.toAgentId === f.clone.id && row.sessionId === f.session.id)
    assert.equal(rows.length, 2, '不同 actor 的同 key 应产生各自消息')
    assert.deepEqual(new Set(rows.map(row => row.actorUserId)), new Set(['user-1', 'user-2']))
  }
  finally {
    await f.manager.shutdown()
    f.db.close()
  }
})
