/**
 * A2A 会话作用域(2026-11-22 会话戳贯通):
 *  - 服务端按成员关系派生会话戳,不信任调用方传入的 x-aw-session-id;
 *  - 活跃会话克隆之间跨会话投递 → 403 SESSION_MEMBER_SCOPE_MISMATCH(fail-closed);
 *  - 基础成员保留频道级邮件语义(无戳),基础→克隆按目标会话盖章;
 *  - 关闭中/失配的克隆不得再被寻址;project 办公室会话不参与该守卫。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-session-a2a-'))

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
const { createChannelSessionRepo } = await import('../server/services/workshop/db/channel-session.repo')
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
  const channel = repos.channels.create({ name: 'a2a scope', ownerUserId: 'user-1' })
  const lead = repos.channelAgents.create({ channelId: channel.id, templateId: null, name: 'lead', harness: 'mock', role: 'lead' })
  const worker = repos.channelAgents.create({ channelId: channel.id, templateId: null, name: 'worker', harness: 'mock', role: 'worker' })
  repos.channels.update(channel.id, { leadAgentId: lead.id })
  const manager = createAgentChannelManager({ db, repos, implFactory: createAgentImpl })
  return { db, repos, manager, channel, lead, worker }
}

const actor = { id: 'user-1', role: 'user' }

async function createSession(f: ReturnType<typeof fixture>, title: string) {
  return f.manager.createChannelSession({ channelId: f.channel.id, actor, title })
}

function cloneOf(session: { members: Array<{ baseAgentId: string, cloneId: string }> }, baseAgentId: string): string {
  const member = session.members.find(m => m.baseAgentId === baseAgentId)
  assert.ok(member, `session must clone base member ${baseAgentId}`)
  return member.cloneId
}

/** 按 messageId 读落库行(与信箱消费状态无关:runtime 可能在 await 续体前已 claim)。 */
function storedMetadata(f: ReturnType<typeof fixture>, messageId: string): Record<string, unknown> {
  const row = f.db.prepare('SELECT metadata_json AS metadataJson FROM messages WHERE id = ?').get(messageId) as { metadataJson: string } | undefined
  assert.ok(row, `message ${messageId} must be persisted`)
  return JSON.parse(row.metadataJson) as Record<string, unknown>
}

test('cross-session A2A between live clones is rejected with SESSION_MEMBER_SCOPE_MISMATCH', async (t) => {
  const f = fixture()
  t.after(async () => {
    await f.manager.shutdown()
    f.db.close()
  })
  const s1 = await createSession(f, 's1')
  const s2 = await createSession(f, 's2')
  const s1Lead = cloneOf(s1, f.lead.id)
  const s2Worker = cloneOf(s2, f.worker.id)

  await assert.rejects(
    () => f.manager.sendA2A(f.channel.id, s1Lead, { toAgentId: s2Worker, parts: [{ text: '跨会话投递' }] }),
    (err: unknown) => {
      const e = err as { status?: number, code?: string }
      assert.equal(e.status, 403)
      assert.equal(e.code, 'SESSION_MEMBER_SCOPE_MISMATCH')
      return true
    },
  )
  const rejected = f.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE to_agent_id = ?').get(s2Worker) as { n: number }
  assert.equal(rejected.n, 0, '被拒绝的消息不得进入目标信箱')
})

test('same-session A2A is stamped by the server and ignores a spoofed session metadata', async (t) => {
  const f = fixture()
  t.after(async () => {
    await f.manager.shutdown()
    f.db.close()
  })
  const s1 = await createSession(f, 's1')
  const s2 = await createSession(f, 's2')
  const s1Lead = cloneOf(s1, f.lead.id)
  const s1Worker = cloneOf(s1, f.worker.id)

  const message = await f.manager.sendA2A(f.channel.id, s1Lead, {
    toAgentId: s1Worker,
    parts: [{ text: '本会话协作' }],
    // 伪造/过期的会话戳必须被覆盖为服务端事实(目标成员所属会话)
    metadata: { 'x-aw-session-id': s2.sessionId, 'x-aw-trace': 'keep-me' },
  })
  assert.equal(message.metadata?.['x-aw-session-id'], s1.sessionId)
  assert.equal(message.metadata?.['x-aw-trace'], 'keep-me', '非会话元数据必须保留')

  assert.equal(storedMetadata(f, message.messageId)['x-aw-session-id'], s1.sessionId)
})

test('base members keep channel-level mail; base→clone adopts the target session', async (t) => {
  const f = fixture()
  t.after(async () => {
    await f.manager.shutdown()
    f.db.close()
  })
  const s1 = await createSession(f, 's1')
  const s1Worker = cloneOf(s1, f.worker.id)

  const channelMail = await f.manager.sendA2A(f.channel.id, f.lead.id, { toAgentId: f.worker.id, parts: [{ text: '频道级邮件' }] })
  assert.equal(channelMail.metadata?.['x-aw-session-id'], undefined, '基础成员间不盖会话戳')

  const sessionMail = await f.manager.sendA2A(f.channel.id, f.lead.id, { toAgentId: s1Worker, parts: [{ text: '定向到会话' }] })
  assert.equal(sessionMail.metadata?.['x-aw-session-id'], s1.sessionId, '基础成员寻址克隆时按目标会话盖章')
})

test('a closing or ambiguous session clone can no longer be addressed', async (t) => {
  const f = fixture()
  t.after(async () => {
    await f.manager.shutdown()
    f.db.close()
  })
  const sessions = createChannelSessionRepo(f.db)
  const clone = f.repos.channelAgents.create({ channelId: f.channel.id, templateId: null, name: 'worker·session·9', harness: 'mock', role: 'worker' })
  const session = sessions.create({ channelId: f.channel.id, title: 'closing', memberMap: { [f.worker.id]: clone.id } })
  sessions.beginClosing(session.id)

  await assert.rejects(
    () => f.manager.sendA2A(f.channel.id, f.lead.id, { toAgentId: clone.id, parts: [{ text: '关闭中' }] }),
    (err: unknown) => (err as { code?: string }).code === 'SESSION_MEMBER_SCOPE_MISMATCH',
  )
})

test('project office sessions are identity mappings and do not block channel mail', async (t) => {
  const f = fixture()
  t.after(async () => {
    await f.manager.shutdown()
    f.db.close()
  })
  createChannelSessionRepo(f.db).create({
    channelId: f.channel.id,
    title: 'project office',
    memberMap: { [f.lead.id]: f.lead.id },
    instanceKind: 'project',
    createdByKind: 'project',
  })
  const message = await f.manager.sendA2A(f.channel.id, f.lead.id, { toAgentId: f.worker.id, parts: [{ text: '项目办公室场景' }] })
  assert.equal(message.metadata?.['x-aw-session-id'], undefined)
})
