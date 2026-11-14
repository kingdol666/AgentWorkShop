import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { canonicalHash, canonicalJson } from '../shared/context/hash'
import { openWorkshopDb, initWorkshopDb } from '../server/services/workshop/db/database'
import { createChannelRepo } from '../server/services/workshop/db/channel.repo'
import { createChannelSessionRepo } from '../server/services/workshop/db/channel-session.repo'
import { createChannelAgentRepo } from '../server/services/workshop/db/channel-agent.repo'
import { createChannelSession } from '../server/services/workshop/agents/session-clone'
import { migrateChannelModeColumn } from '../server/services/workshop/db/database/migrations'
import { migrateSessionChannelModeColumn } from '../server/services/workshop/db/database/migrations-session'

function validSessionSnapshot(channelId: string, productId: string, lineId: string, revision = 1): { json: string, hash: string } {
  const snapshot = { schemaVersion: 1, channelId, bindingRevision: revision, productId, lineId, recipes: [], agentBindings: [], executionProfile: { mode: 'auto' } }
  return { json: canonicalJson(snapshot), hash: canonicalHash(snapshot) }
}

type ManagerHarness = {
  deps: unknown
  requireWritable: (...args: never[]) => void
  getTaskEngine: () => unknown
  getSessionContextService: () => unknown
  notifyMember: (...args: never[]) => void
  channelModeOf: (id: string) => string
  channelModeForAgent: (id: string) => string
  createChannelSession: (input: { channelId: string, actor: { id: string, role: string } }) => Promise<{ sessionId: string, channelMode: string }>
}

test('legacy channels and sessions are backfilled once, not on subsequent mode changes', () => {
  const db = new DatabaseSync(':memory:')
  try {
    db.exec(`CREATE TABLE channels (id TEXT PRIMARY KEY, line_id TEXT NOT NULL DEFAULT '');
      CREATE TABLE channel_sessions (id TEXT PRIMARY KEY, channel_id TEXT NOT NULL);
      INSERT INTO channels VALUES ('line', 'line-a'), ('plain', '');
      INSERT INTO channel_sessions VALUES ('s1', 'line'), ('s2', 'plain');`)
    migrateChannelModeColumn(db)
    migrateSessionChannelModeColumn(db)
    assert.equal((db.prepare('SELECT channel_mode FROM channels WHERE id=\'line\'').get() as { channel_mode: string }).channel_mode, 'production_line_integrated')
    assert.equal((db.prepare('SELECT channel_mode FROM channels WHERE id=\'plain\'').get() as { channel_mode: string }).channel_mode, 'generic')
    assert.equal((db.prepare('SELECT channel_mode FROM channel_sessions WHERE id=\'s1\'').get() as { channel_mode: string }).channel_mode, 'production_line_integrated')
    db.exec('UPDATE channels SET channel_mode=\'generic\' WHERE id=\'line\'')
    migrateChannelModeColumn(db)
    migrateSessionChannelModeColumn(db)
    assert.equal((db.prepare('SELECT channel_mode FROM channels WHERE id=\'line\'').get() as { channel_mode: string }).channel_mode, 'generic')
    assert.equal((db.prepare('SELECT channel_mode FROM channel_sessions WHERE id=\'s1\'').get() as { channel_mode: string }).channel_mode, 'production_line_integrated')
  }
  finally { db.close() }
})

test('Channel mode changes recycle cached base runtimes while Session snapshots remain stored', async () => {
  const { ManagerAdminChannel } = await import('../server/services/workshop/runtime/manager/admin-channel')
  let channel = { id: 'ch', name: 'mode', description: '', scenarioPrompt: '', workspace: '', enabled: 1, channelMode: 'generic', leadAgentId: 'lead', llmJson: '' } as never
  let unloads = 0
  const manager = Object.create(ManagerAdminChannel.prototype) as Record<string, unknown>
  Object.assign(manager, {
    deps: { repos: { channels: { findById: () => channel, update: (_id: string, patch: Record<string, unknown>) => (channel = { ...channel, ...patch } as never) } } },
    requireChannelRow: () => channel,
    unloadChannelAgents: async () => { unloads++ },
    ensureChannelActive: () => {},
  })
  await (manager.updateChannel as (id: string, patch: { channelMode: 'generic' | 'production_line_integrated' }) => Promise<unknown>).call(manager, 'ch', { channelMode: 'production_line_integrated' })
  assert.equal(unloads, 1)
})

test('new channels default to generic and session mode stays frozen after channel changes', () => {
  const db = openWorkshopDb(':memory:')
  try {
    const channels = createChannelRepo(db)
    const sessions = createChannelSessionRepo(db)
    const channel = channels.create({ name: 'generic' })
    assert.equal(channel.channelMode, 'generic')
    channels.setLine(channel.id, 'legacy-line')
    assert.equal(channels.findById(channel.id)?.channelMode, 'generic')
    const first = sessions.create({ channelId: channel.id, memberMap: {} })
    channels.update(channel.id, { channelMode: 'production_line_integrated' })
    const second = sessions.create({ channelId: channel.id, memberMap: {} })
    channels.update(channel.id, { channelMode: 'generic' })
    initWorkshopDb(db)
    assert.equal(sessions.findById(first.id)?.channelMode, 'generic')
    assert.equal(sessions.findById(second.id)?.channelMode, 'production_line_integrated')
    assert.equal(channels.findById(channel.id)?.channelMode, 'generic')
  }
  finally { db.close() }
})

test('generic session cloning does not copy industrial bindings or require a product', () => {
  const db = openWorkshopDb(':memory:')
  try {
    const channel = createChannelRepo(db).create({ name: 'generic' })
    const agents = createChannelAgentRepo(db)
    agents.create({ channelId: channel.id, templateId: null, name: 'Lead', harness: 'mock', role: 'lead' })
    let binds = 0
    const result = createChannelSession({
      channelAgents: agents,
      tasks: { list: () => [], cancelTree: () => [] },
      bindings: { byAgent: () => [{ nodeId: 'legacy-node', kind: 'daq' }], bind: () => { binds++ } },
      unloadAgent: async () => undefined,
    }, { channelId: channel.id, actorId: 'owner', channelMode: 'generic', sessionRepo: createChannelSessionRepo(db) })
    const session = createChannelSessionRepo(db).findById(result.sessionId)!
    assert.equal(session.channelMode, 'generic')
    assert.equal(session.productId, null)
    assert.equal(session.bindingSnapshotJson, '')
    assert.equal(binds, 0)
  }
  finally { db.close() }
})

test('manager resolves exact active session snapshot and fails closed for unknown agents', async () => {
  const { ManagerAdminAgents } = await import('../server/services/workshop/runtime/manager/admin-agents')
  const db = openWorkshopDb(':memory:')
  try {
    const channels = createChannelRepo(db)
    const agents = createChannelAgentRepo(db)
    const sessions = createChannelSessionRepo(db)
    const channel = channels.create({ name: 'mode', channelMode: 'production_line_integrated' })
    const agent = agents.create({ channelId: channel.id, templateId: null, name: 'agent', harness: 'mock', role: 'worker' })
    const snapshot = validSessionSnapshot(channel.id, 'prod-a', 'line-a')
    const session = sessions.create({ channelId: channel.id, memberMap: { base: agent.id }, productId: 'prod-a', lineId: 'line-a', bindingSnapshotJson: snapshot.json, bindingSnapshotHash: snapshot.hash, bindingSnapshotRevision: 1 })
    channels.update(channel.id, { channelMode: 'generic' })
    const manager = Object.create(ManagerAdminAgents.prototype) as unknown as ManagerHarness
    manager.deps = { db, repos: { channels, channelAgents: agents } }
    assert.equal(manager.channelModeOf(channel.id), 'generic')
    assert.equal(manager.channelModeOf('missing'), 'generic')
    assert.equal(manager.channelModeForAgent(agent.id), 'production_line_integrated')
    assert.equal(manager.channelModeForAgent('missing'), 'generic')
    sessions.close(session.id)
    assert.equal(manager.channelModeForAgent(agent.id), 'generic')
  }
  finally { db.close() }
})

test('manager generic creation skips product requirement; integrated mode requires product', async () => {
  const { ManagerAdminAgents } = await import('../server/services/workshop/runtime/manager/admin-agents')
  const db = openWorkshopDb(':memory:')
  try {
    const channels = createChannelRepo(db)
    const agents = createChannelAgentRepo(db)
    const channel = channels.create({ name: 'mode' })
    agents.create({ channelId: channel.id, templateId: null, name: 'Lead', harness: 'mock', role: 'lead' })
    channels.setLine(channel.id, 'legacy-line')
    const manager = Object.create(ManagerAdminAgents.prototype) as unknown as ManagerHarness
    manager.deps = { db, repos: { channels, channelAgents: agents } }
    manager.requireWritable = () => undefined
    manager.getTaskEngine = () => ({ list: () => [], cancelTree: () => [] })
    manager.getSessionContextService = () => ({ refresh: () => undefined })
    manager.notifyMember = () => undefined
    const created = await manager.createChannelSession({ channelId: channel.id, actor: { id: 'owner', role: 'user' } })
    assert.equal(created.channelMode, 'generic')
    assert.equal(createChannelSessionRepo(db).findById(created.sessionId)?.productId, null)
    channels.update(channel.id, { channelMode: 'production_line_integrated' })
    await assert.rejects(manager.createChannelSession({ channelId: channel.id, actor: { id: 'owner', role: 'user' } }), (err: unknown) => (err as { code?: string }).code === 'SESSION_PRODUCT_REQUIRED')
  }
  finally { db.close() }
})

test('session clones fail closed when membership is missing, malformed, ambiguous, or unavailable', async () => {
  const { ManagerAdminAgents } = await import('../server/services/workshop/runtime/manager/admin-agents')
  const db = openWorkshopDb(':memory:')
  try {
    const channels = createChannelRepo(db)
    const agents = createChannelAgentRepo(db)
    const sessions = createChannelSessionRepo(db)
    const channel = channels.create({ name: 'integrated', channelMode: 'production_line_integrated' })
    const base = agents.create({ channelId: channel.id, templateId: null, name: 'base', harness: 'mock', role: 'lead' })
    const clone = agents.create({ channelId: channel.id, templateId: null, name: 'base·session·1', harness: 'mock', role: 'worker' })
    const manager = Object.create(ManagerAdminAgents.prototype) as unknown as ManagerHarness
    manager.deps = { db, repos: { channels, channelAgents: agents } }
    assert.equal(manager.channelModeForAgent(base.id), 'production_line_integrated')
    assert.equal(manager.channelModeForAgent(clone.id), 'generic', 'orphan clone')
    const snapshot = validSessionSnapshot(channel.id, 'prod-a', 'line-a')
    const first = sessions.create({ channelId: channel.id, memberMap: { [base.id]: clone.id }, productId: 'prod-a', lineId: 'line-a', bindingSnapshotJson: snapshot.json, bindingSnapshotHash: snapshot.hash, bindingSnapshotRevision: 1 })
    assert.equal(manager.channelModeForAgent(clone.id), 'production_line_integrated')
    const second = sessions.create({ channelId: channel.id, memberMap: { [base.id]: clone.id } })
    assert.equal(manager.channelModeForAgent(clone.id), 'generic', 'ambiguous membership')
    sessions.close(second.id)
    db.prepare('UPDATE channel_sessions SET member_map_json = ? WHERE id = ?').run('{', first.id)
    assert.equal(manager.channelModeForAgent(clone.id), 'generic', 'malformed map')
    sessions.close(first.id)
    assert.equal(manager.channelModeForAgent(clone.id), 'generic', 'closed session')
  }
  finally { db.close() }
})

test('failed session lookup for a session clone returns generic', async () => {
  const { ManagerAdminAgents } = await import('../server/services/workshop/runtime/manager/admin-agents')
  const db = openWorkshopDb(':memory:')
  const channels = createChannelRepo(db)
  const agents = createChannelAgentRepo(db)
  const channel = channels.create({ name: 'integrated', channelMode: 'production_line_integrated' })
  const clone = agents.create({ channelId: channel.id, templateId: null, name: 'base·session·2', harness: 'mock', role: 'worker' })
  const manager = Object.create(ManagerAdminAgents.prototype) as unknown as ManagerHarness
  manager.deps = {
    db: { prepare: () => { throw new Error('db failure') } },
    repos: { channels, channelAgents: agents },
  }
  try {
    assert.equal(manager.channelModeForAgent(clone.id), 'generic')
  }
  finally { db.close() }
})

test('task clone without a product selector remains generic and does not inherit production bindings', async () => {
  const { ManagerAdminAgents } = await import('../server/services/workshop/runtime/manager/admin-agents')
  const db = openWorkshopDb(':memory:')
  try {
    const channels = createChannelRepo(db)
    const agents = createChannelAgentRepo(db)
    const sessions = createChannelSessionRepo(db)
    const channel = channels.create({ name: 'integrated template', channelMode: 'production_line_integrated' })
    const base = agents.create({ channelId: channel.id, templateId: null, name: 'base', harness: 'mock', role: 'lead' })
    const taskClone = agents.create({ channelId: channel.id, templateId: null, name: 'base·任务·a1', harness: 'mock', role: 'worker' })
    const incompleteTaskSession = sessions.create({ channelId: channel.id, memberMap: { [base.id]: taskClone.id }, instanceKind: 'task', channelMode: 'production_line_integrated' })
    const manager = Object.create(ManagerAdminAgents.prototype) as unknown as ManagerHarness
    manager.deps = { db, repos: { channels, channelAgents: agents } }
    assert.equal(manager.channelModeForAgent(taskClone.id), 'generic', 'integrated task mode without immutable product snapshot')
    sessions.close(incompleteTaskSession.id)
    assert.equal(manager.channelModeForAgent(taskClone.id), 'generic', 'closed task clone')
  }
  finally { if (db.isOpen) db.close() }
})
