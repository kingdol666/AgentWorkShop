/**
 * REST/脚本创建的频道必须能在 console 里被发现。
 *
 * console 按 workspace 作用域读取频道(`/workshop/w/:wsId`),所以
 * `POST /api/workshop/channels` 在缺省情况下会复用/创建 owner 的「默认工作区」
 * 并挂载新频道;显式 `workspaceId` 时只挂到指定 workspace。
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-channel-default-workspace-'))

const { openWorkshopDb } = await import('../server/services/workshop/db/database')
const { createUserRepo } = await import('../server/services/workshop/db/user.repo')
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
const { DEFAULT_WORKSPACE_NAME, chooseWorkspaceForNewChannel } = await import('../server/services/workshop/runtime/manager/workspace-defaults')

function fixture() {
  const db = openWorkshopDb(':memory:')
  const repos = {
    users: createUserRepo(db),
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
  const manager = createAgentChannelManager({ db, repos, implFactory: createAgentImpl })
  return { db, repos, manager }
}

function ownedChannel(repos: ReturnType<typeof fixture>['repos'], ownerUserId: string, name = 'channel') {
  return repos.channels.create({ name, ownerUserId })
}

test('default workspace is created on demand and the channel is mounted exactly once', async (t) => {
  const f = fixture()
  t.after(async () => {
    await f.manager.shutdown()
    f.db.close()
  })
  const channel = ownedChannel(f.repos, 'user-1')
  const workspace = f.manager.ensureChannelWorkspaceMount('user-1', channel.id)
  assert.equal(workspace.name, DEFAULT_WORKSPACE_NAME)
  const listed = f.manager.listWorkspaces('user-1')
  assert.equal(listed.length, 1)
  assert.deepEqual(listed[0].channelIds, [channel.id])
  // 幂等:重复调用不会创建第二个 workspace,也不会产生重复挂载行
  const again = f.manager.ensureChannelWorkspaceMount('user-1', channel.id)
  assert.equal(again.id, workspace.id)
  assert.deepEqual(f.manager.listWorkspaces('user-1').map(w => w.channelIds), [[channel.id]])
})

test('a second API channel reuses the same default workspace', async (t) => {
  const f = fixture()
  t.after(async () => {
    await f.manager.shutdown()
    f.db.close()
  })
  const first = ownedChannel(f.repos, 'user-1', 'first')
  const second = ownedChannel(f.repos, 'user-1', 'second')
  const ws1 = f.manager.ensureChannelWorkspaceMount('user-1', first.id)
  const ws2 = f.manager.ensureChannelWorkspaceMount('user-1', second.id)
  assert.equal(ws2.id, ws1.id)
  const listed = f.manager.listWorkspaces('user-1')
  assert.equal(listed.length, 1)
  assert.deepEqual([...listed[0].channelIds].sort(), [first.id, second.id].sort())
})

test('an explicitly named default workspace wins over older workspaces', async (t) => {
  const f = fixture()
  t.after(async () => {
    await f.manager.shutdown()
    f.db.close()
  })
  const older = f.repos.users.createWorkspace('user-1', 'Team A')
  const named = f.repos.users.createWorkspace('user-1', DEFAULT_WORKSPACE_NAME)
  const channel = ownedChannel(f.repos, 'user-1')
  const mounted = f.manager.ensureChannelWorkspaceMount('user-1', channel.id)
  assert.equal(mounted.id, named.id)
  assert.notEqual(mounted.id, older.id)
  assert.equal(f.repos.users.listMountedChannels(named.id).includes(channel.id), true)
})

test('with no named default, the oldest workspace is reused instead of creating another', async (t) => {
  const f = fixture()
  t.after(async () => {
    await f.manager.shutdown()
    f.db.close()
  })
  const oldest = f.repos.users.createWorkspace('user-2', 'Team B')
  f.repos.users.createWorkspace('user-2', 'Team C')
  const channel = ownedChannel(f.repos, 'user-2')
  const mounted = f.manager.ensureChannelWorkspaceMount('user-2', channel.id)
  assert.equal(mounted.id, oldest.id)
  assert.equal(f.manager.listWorkspaces('user-2').length, 2)
})

test('an explicit workspaceId mounts there and never falls back', async (t) => {
  const f = fixture()
  t.after(async () => {
    await f.manager.shutdown()
    f.db.close()
  })
  const explicit = f.repos.users.createWorkspace('user-3', 'Explicit')
  const other = f.repos.users.createWorkspace('user-3', DEFAULT_WORKSPACE_NAME)
  const channel = ownedChannel(f.repos, 'user-3')
  const mounted = f.manager.ensureChannelWorkspaceMount('user-3', channel.id, explicit.id)
  assert.equal(mounted.id, explicit.id)
  assert.equal(f.repos.users.listMountedChannels(explicit.id).includes(channel.id), true)
  assert.equal(f.repos.users.listMountedChannels(other.id).includes(channel.id), false)
})

test('an explicit target never leaks the channel into the oldest workspace', async (t) => {
  const f = fixture()
  t.after(async () => {
    await f.manager.shutdown()
    f.db.close()
  })
  // console 的「新建并挂载」弹窗在第二个工作区里建频道:没有命名的默认区时,
  // 缺省规则会选中最早的 workspace —— 显式目标必须完全绕开这条规则。
  const oldest = f.repos.users.createWorkspace('user-4', 'Team Old')
  const target = f.repos.users.createWorkspace('user-4', 'Team New')
  const channel = ownedChannel(f.repos, 'user-4')
  const mounted = f.manager.ensureChannelWorkspaceMount('user-4', channel.id, target.id)
  assert.equal(mounted.id, target.id)
  assert.notEqual(mounted.id, oldest.id)
  assert.deepEqual(
    f.manager.listWorkspaces('user-4').map(w => [w.name, [...w.channelIds].sort()]),
    [['Team Old', []], ['Team New', [channel.id]]],
  )
})

test('foreign or unknown workspaces and foreign channels are rejected before mounting', async (t) => {
  const f = fixture()
  t.after(async () => {
    await f.manager.shutdown()
    f.db.close()
  })
  const foreign = f.repos.users.createWorkspace('user-9', 'Foreign')
  const unknown = '00000000-0000-4000-8000-000000000000'
  const channel = ownedChannel(f.repos, 'user-1')
  assert.throws(() => f.manager.ensureChannelWorkspaceMount('user-1', channel.id, foreign.id), /不属于当前用户/)
  assert.throws(() => f.manager.ensureChannelWorkspaceMount('user-1', channel.id, unknown), /workspace 不存在/)
  assert.throws(() => f.manager.ensureChannelWorkspaceMount('user-2', channel.id), /不属于当前用户/)
  assert.deepEqual(f.manager.listWorkspaces('user-1'), [], 'failed mounts must not create a workspace')
})

test('createChannel mounts into the given workspace and reports it in the response', async (t) => {
  const f = fixture()
  t.after(async () => {
    await f.manager.shutdown()
    f.db.close()
  })
  const target = f.repos.users.createWorkspace('user-5', 'Target')
  const created = await f.manager.createChannel({
    name: 'rest-channel',
    ownerUserId: 'user-5',
    mountToDefaultWorkspace: true,
    workspaceId: target.id,
  })
  assert.equal(created.workspaceId, target.id)
  assert.equal(created.workspaceName, 'Target')
  assert.deepEqual(f.repos.users.listMountedChannels(target.id), [created.channelId])
})

test('createChannel rejects a foreign workspace BEFORE creating the channel', async (t) => {
  const f = fixture()
  t.after(async () => {
    await f.manager.shutdown()
    f.db.close()
  })
  const foreign = f.repos.users.createWorkspace('user-9', 'Foreign')
  await assert.rejects(
    f.manager.createChannel({ name: 'orphan-probe', ownerUserId: 'user-5', mountToDefaultWorkspace: true, workspaceId: foreign.id }),
    /不属于当前用户/,
  )
  const owned = (await f.manager.listChannels()).filter(c => c.name === 'orphan-probe')
  assert.equal(owned.length, 0, '被拒的创建请求不得留下孤儿频道')
  assert.deepEqual(f.manager.listWorkspaces('user-5'), [], '被拒的创建请求不得创建默认工作区')
})

test('createChannel without the mount flag never mounts the channel', async (t) => {
  const f = fixture()
  t.after(async () => {
    await f.manager.shutdown()
    f.db.close()
  })
  const created = await f.manager.createChannel({ name: 'internal-channel', ownerUserId: 'user-6' })
  assert.equal(created.workspaceId, undefined)
  assert.deepEqual(f.manager.listWorkspaces('user-6'), [])
})

test('pure selection prefers the named default and falls back to the oldest workspace', () => {
  const make = (id: string, name: string) => ({ id, ownerUserId: 'u', name, createdAt: id })
  assert.equal(chooseWorkspaceForNewChannel([]), null)
  const oldest = make('1', 'A')
  const named = make('2', DEFAULT_WORKSPACE_NAME)
  assert.equal(chooseWorkspaceForNewChannel([oldest, named])?.id, named.id)
  assert.equal(chooseWorkspaceForNewChannel([oldest, make('3', 'B')])?.id, oldest.id)
})
