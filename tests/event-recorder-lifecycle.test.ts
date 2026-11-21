import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test, type TestContext } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import type { AgentInfo } from '../server/services/workshop/agents/agent-interface'

// The WS HITL subscription reads the user repository during binding. Keep even
// that auxiliary store isolated; no server, harness subprocess, or device is used.
const home = mkdtempSync(join(tmpdir(), 'aw-event-recorders-'))
process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = home

// #imports is supplied by Nitro, which is deliberately not booted by this test.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '#imports') {
      return { url: 'data:text/javascript,export const useRuntimeConfig = () => ({ public: {} })', shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
})

const { userRepository } = await import('../server/repositories/user.repository')
const { openWorkshopDb } = await import('../server/services/workshop/db/database')
const { createUserRepo } = await import('../server/services/workshop/db/user.repo')
const { createChannelRepo } = await import('../server/services/workshop/db/channel.repo')
const { createChannelAgentRepo } = await import('../server/services/workshop/db/channel-agent.repo')
const { createAgentRepo } = await import('../server/services/workshop/db/agent.repo')
const { createChannelEventRepo } = await import('../server/services/workshop/db/channel-event.repo')
const { createChannelTemplateRepo } = await import('../server/services/workshop/db/channel-template.repo')
const { createMessageRepo } = await import('../server/services/workshop/db/message.repo')
const { createSubscriptionRepo } = await import('../server/services/workshop/db/subscription.repo')
const { createTaskRepo } = await import('../server/services/workshop/db/task.repo')
const { createMemoryRepo } = await import('../server/services/workshop/db/memory.repo')
const { createTeamRepo } = await import('../server/services/workshop/db/team.repo')
const { createTeamMemberRepo } = await import('../server/services/workshop/db/team-member.repo')
const { createScheduledTaskRepo } = await import('../server/services/workshop/db/scheduled-task.repo')
const { createChatMessageRepo } = await import('../server/services/workshop/db/chat-message.repo')
const { createOutboxRepo } = await import('../server/services/workshop/db/outbox.repo')
const { createAgentChannelManager } = await import('../server/services/workshop/runtime/manager')
const { MockAgentImpl } = await import('../server/services/workshop/agents/mock-agent')
const { ensureAllEventRecorders } = await import('../server/api/workshop/ws')
const { ensureHubBound } = await import('../server/api/workshop/ws/hub')
const { closeStream, closeAllStreams, ensureStream } = await import('../server/api/workshop/ws/streams')
const { withTransaction } = await import('../server/services/workshop/db/transaction')
const { hub, streams } = await import('../server/api/workshop/ws/shared')

function fixture(t: TestContext, channelId?: string, implFactory = (agent: AgentInfo) => new MockAgentImpl(agent.config)) {
  const db = openWorkshopDb(':memory:')
  const repos = {
    users: createUserRepo(db),
    channels: createChannelRepo(db),
    channelEvents: createChannelEventRepo(db),
    channelAgents: createChannelAgentRepo(db),
    agents: createAgentRepo(db),
    channelTemplates: createChannelTemplateRepo(db),
    messages: createMessageRepo(db),
    subscriptions: createSubscriptionRepo(db),
    tasks: createTaskRepo(db),
    memories: createMemoryRepo(db),
    teams: createTeamRepo(db),
    teamMembers: createTeamMemberRepo(db),
    schedules: createScheduledTaskRepo(db),
    chatMessages: createChatMessageRepo(db),
    outbox: createOutboxRepo(db),
  }
  const row = repos.channels.create({ name: 'recorder lifecycle', chatEnabled: 1 })
  const id = channelId ?? row.id
  if (id !== row.id) db.prepare('UPDATE channels SET id = ? WHERE id = ?').run(id, row.id)
  const manager = createAgentChannelManager({ db, repos, implFactory })
  t.after(async () => {
    await manager.shutdown()
    if (hub.boundManager === manager) {
      for (const channelId of streams.keys()) closeStream(manager, channelId)
      hub.boundManager = null
    }
    db.close()
  })
  return { db, repos, id, manager }
}

after(() => {
  userRepository._resetForTest()
  // Windows 上 SQLite/WAL 句柄释放滞后会让 rm 抛 EPERM;临时目录清理不参与断言。
  try {
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  catch { /* best-effort temp cleanup */ }
})

// Wait for the batching timer without letting the 3s housekeeping sweep repair
// a missed binding. Events themselves are emitted synchronously in the test.
async function waitForEvents(read: () => number, count: number): Promise<void> {
  const deadline = Date.now() + 1500
  while (read() < count && Date.now() < deadline) await delay(15)
  assert.equal(read(), count)
}

test('startup prewarms zero-peer recorders synchronously before restore replays chat outbox', async (t) => {
  const { manager, repos, id } = fixture(t)
  const { row } = repos.chatMessages.create({ channelId: id, senderType: 'system', senderId: 'test', text: 'recovered message' })
  const eventId = `chat.message:${row.id}`
  repos.outbox.enqueue({ id: eventId, aggregateType: 'chat_message', aggregateId: row.id, eventType: 'chat.message', payload: { channelId: id, chatMessageId: row.id } })

  ensureHubBound(manager)
  const recording = ensureAllEventRecorders(manager)
  await manager.restore()
  await recording
  assert.equal(repos.outbox.findById(eventId)?.status, 'published')
  await waitForEvents(() => repos.channelEvents.count(id), 1)
  assert.deepEqual(repos.channelEvents.listRecent(id, 5).map(e => e.type), ['chat.message'])
  assert.deepEqual(manager.runtimeStatus(), { wiredAgents: [], activeChannels: [] })
})

test('subscribing to a dormant channel does not activate its runtime', async (t) => {
  const { manager, repos, id } = fixture(t)
  ensureHubBound(manager)
  await ensureAllEventRecorders(manager)
  const seen: string[] = []
  const unsubscribe = manager.subscribeChatEvents(id, e => seen.push(e.type))
  manager.publishChatSettings(id)
  unsubscribe()
  manager.publishChatSettings(id)
  assert.deepEqual(seen, ['chat.settings'])
  assert.deepEqual(manager.runtimeStatus(), { wiredAgents: [], activeChannels: [] })
  await waitForEvents(() => repos.channelEvents.count(id), 2)
})

test('idle unloading the last agent does not interrupt event persistence or reactivation', async (t) => {
  const { manager, repos, id } = fixture(t)
  const lead = repos.channelAgents.create({ channelId: id, templateId: null, name: 'local lead', harness: 'mock', role: 'lead' })
  repos.channels.update(id, { leadAgentId: lead.id })
  ensureHubBound(manager)
  await ensureAllEventRecorders(manager)
  manager.ensureChannelActive(id)
  assert.deepEqual(manager.runtimeStatus().wiredAgents, [lead.id])
  await manager.unloadAgent(id, lead.id)
  assert.deepEqual(manager.runtimeStatus(), { wiredAgents: [], activeChannels: [] })

  manager.publishChatSettings(id)
  manager.ensureChannelActive(id)
  assert.deepEqual(manager.runtimeStatus().wiredAgents, [lead.id])
  manager.publishChatSettings(id)
  const settings = () => repos.channelEvents.listByTypes(id, ['chat.settings'], 10)
  await waitForEvents(() => settings().length, 2)
  assert.ok(settings()[0]!.seq < settings()[1]!.seq)
})

test('manager swap immediately keeps zero-peer recorders and flushes pending frames to their original database', async (t) => {
  const old = fixture(t)
  const fresh = fixture(t, old.id)
  ensureHubBound(old.manager)
  ensureStream(old.manager, old.id)
  old.manager.publishChatSettings(old.id)
  assert.equal(old.repos.channelEvents.count(old.id), 0, 'event must still be buffered at swap')

  ensureHubBound(fresh.manager)
  old.manager.publishChatSettings(old.id)
  fresh.manager.publishChatSettings(fresh.id)
  assert.equal(old.repos.channelEvents.count(old.id), 1)
  await waitForEvents(() => fresh.repos.channelEvents.count(fresh.id), 1)
  assert.equal(old.repos.channelEvents.count(old.id), 1, 'old bus must be detached')
  assert.ok(fresh.repos.channelEvents.maxSeq(fresh.id) > old.repos.channelEvents.maxSeq(old.id))
})

test('manager swap inside an open transaction never leaks old frames into the new database', async (t) => {
  const old = fixture(t)
  const fresh = fixture(t, old.id)
  ensureHubBound(old.manager)
  ensureStream(old.manager, old.id)
  old.manager.publishChatSettings(old.id)
  assert.equal(old.repos.channelEvents.count(old.id), 0)

  // 换绑发生在未提交事务内 → 旧缓冲只能延后刷盘;延迟重试必须用 stream.manager(旧库)
  withTransaction(old.db, () => {
    ensureHubBound(fresh.manager)
  })
  await waitForEvents(() => old.repos.channelEvents.count(old.id), 1)
  // 再等一个刷盘窗口,确认延迟重试没有把旧帧写进新库
  await delay(700)
  assert.equal(fresh.repos.channelEvents.count(fresh.id), 0, 'old frames must never leak into the replacement database')
})

test('swap into a database without the channel closes the stale stream and flushes to its original database', async (t) => {
  const old = fixture(t)
  const fresh = fixture(t) // 不同频道 id:替换库不认识旧频道
  ensureHubBound(old.manager)
  ensureStream(old.manager, old.id)
  old.manager.publishChatSettings(old.id)

  ensureHubBound(fresh.manager)
  assert.equal(streams.has(old.id), false, 'stream for a channel missing from the active db must be reclaimed immediately')
  assert.equal(old.repos.channelEvents.count(old.id), 1, 'buffered frame must still land in its original database')
  assert.equal(fresh.repos.channelEvents.count(old.id), 0)
})

test('channel creation attaches a recorder through the plugin sink (MCP/Project/template paths)', async (t) => {
  const { manager, repos } = fixture(t)
  ensureHubBound(manager)
  ensureAllEventRecorders(manager)
  manager.channelCreatedSink = (channelId) => {
    ensureStream(manager, channelId)
  }
  const created = await manager.createChannel({ name: 'sink-created' })
  assert.equal(streams.has(created.channelId), true, 'recorder must exist immediately after createChannel')
  manager.publishChatSettings(created.channelId)
  await waitForEvents(() => repos.channelEvents.count(created.channelId), 1)
})

test('shutdown flushes and detaches recorders before the database closes', async (t) => {
  const { manager, repos, id } = fixture(t)
  ensureHubBound(manager)
  ensureStream(manager, id)
  manager.publishChatSettings(id)
  assert.equal(repos.channelEvents.count(id), 0)

  await manager.shutdown()
  closeAllStreams(manager)
  assert.equal(repos.channelEvents.count(id), 1, 'tail events must be flushed after shutdown and before db.close')
  assert.equal(streams.has(id), false)
})
