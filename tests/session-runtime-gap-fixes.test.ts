/**
 * Session/Runtime 双缺口修复回归：
 *  1) 事件录制空洞 — publish 的延迟刷盘不再以 hub.boundManager 为前提，
 *     workshop 插件启动即绑定 hub("全时事件录制,与订阅者无关")。
 *  2) generic 会话记忆 session_id 未戳 — 无工业快照的会话回落到仅会话 id 的
 *     可信身份(wireMember 注入 + REST 路径 sessionIdOfAgent)，记忆归属按会话生效。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { test } from 'node:test'
import { openWorkshopDb } from '../server/services/workshop/db/database'
import { createChannelRepo } from '../server/services/workshop/db/channel.repo'
import { createChannelAgentRepo } from '../server/services/workshop/db/channel-agent.repo'
import { createChannelSessionRepo } from '../server/services/workshop/db/channel-session.repo'
import { createMessageRepo } from '../server/services/workshop/db/message.repo'
import { createMemoryRepo } from '../server/services/workshop/db/memory.repo'
import { ManagerRuntimeWiring } from '../server/services/workshop/runtime/manager/runtime-wiring'
import { ManagerHostTools } from '../server/services/workshop/runtime/manager/host-tools'
import { AgentRuntime } from '../server/services/workshop/runtime/agent-runtime/facade'
import { initToolRegistryDb } from '../server/services/workshop/db/tool-registry.repo'

process.env.AGENTWORKSHOP_TEST = '1'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')

test('wireMember injects the trusted session id into the clone impl (generic channel)', (t) => {
  const db = openWorkshopDb(':memory:')
  t.after(() => db.close())
  const channels = createChannelRepo(db)
  const channel = channels.create({ name: 'gap2-wire' })
  const agents = createChannelAgentRepo(db)
  const base = agents.create({ channelId: channel.id, templateId: null, name: 'worker', harness: 'fake', role: 'worker' })
  const sessions = createChannelSessionRepo(db)
  const clone = agents.create({ channelId: channel.id, templateId: null, name: 'worker·session·a1', harness: 'fake', role: 'worker' })
  const session = sessions.create({ channelId: channel.id, title: 's1', memberMap: { [base.id]: clone.id } })

  const received: Array<string | null | undefined> = []
  const impl = {
    bridgeCtx: { identity: {} } as Record<string, unknown>,
    setChannelSessionScope() { /* generic → null,不关心 */ },
    setTrustedSessionId(id: string | null) {
      received.push(id)
    },
  }
  const manager = Object.create(ManagerRuntimeWiring.prototype) as Record<string, unknown>
  manager.deps = {
    db,
    repos: { channels, channelAgents: agents, messages: createMessageRepo(db), memories: createMemoryRepo(db) },
    implFactory: () => impl,
  }
  manager.buses = new Map([[channel.id, { notifyAgent() {}, publish() {} }]])
  manager.agentIndex = new Map()
  manager.ensureChannelRuntime = () => ({ addAgent() {}, scheduler: null, wakeScheduler() {} })
  manager.buildWorkspace = () => ({})
  manager.channelWorkspace = () => ''
  manager.getTaskEngine = () => ({})
  manager.reviveScheduler = () => {}
  const start = AgentRuntime.prototype.start
  AgentRuntime.prototype.start = function () {}
  try {
    const wire = (manager as { wireMember: (m: unknown) => unknown }).wireMember
    wire.call(manager, agents.findById(clone.id))
    assert.deepEqual(received, [session.id], 'setTrustedSessionId must receive the persisted session id exactly once')
  }
  finally {
    AgentRuntime.prototype.start = start
  }
})

test('invokeHostTool stamps generic-session memory with the trusted session id and stays isolated across sessions', async (t) => {
  const db = openWorkshopDb(':memory:')
  t.after(() => db.close())
  initToolRegistryDb(db)
  const channels = createChannelRepo(db)
  const channel = channels.create({ name: 'gap2-invoke' })
  const agents = createChannelAgentRepo(db)
  const sessions = createChannelSessionRepo(db)
  const base = agents.create({ channelId: channel.id, templateId: null, name: 'worker', harness: 'mock', role: 'worker' })
  const cloneA = agents.create({ channelId: channel.id, templateId: null, name: 'worker·session·a1', harness: 'mock', role: 'worker' }).id
  const cloneB = agents.create({ channelId: channel.id, templateId: null, name: 'worker·session·b1', harness: 'mock', role: 'worker' }).id
  const sessionA = sessions.create({ channelId: channel.id, title: 'A', memberMap: { [base.id]: cloneA } })
  sessions.create({ channelId: channel.id, title: 'B', memberMap: { [base.id]: cloneB } })

  const savedMemory: Array<{ sessionId: string | null | undefined, title: string }> = []
  const fakeWorkspace = {
    saveMemory: async (input: { title: string, sessionId?: string | null }) => {
      savedMemory.push(input)
      return { scope: 'private' as const, dedupKey: `agent-save:${input.title}` }
    },
  }
  const manager = Object.create(ManagerHostTools.prototype) as Record<string, unknown>
  manager.deps = {
    db,
    repos: { channels, channelAgents: agents, messages: createMessageRepo(db), memories: createMemoryRepo(db) },
  }
  // dispatch 存活校验读全局 manager(与生产同源);夹具注册并在退出后还原
  const globals = globalThis as typeof globalThis & { __workshopManager?: unknown }
  const previousManager = globals.__workshopManager
  globals.__workshopManager = { deps: manager.deps }
  t.after(() => {
    globals.__workshopManager = previousManager
  })
  manager.lastToolInvokeAt = new Map()
  manager.activeInvocationScopes = new Map()
  manager.ensureAgentRuntime = (channelId: string, agentId: string) => {
    if (agentId !== cloneA) return undefined
    return { workspace: fakeWorkspace, dispatchHostTool: async () => null }
  }
  manager.channelSessionScopeOfAgent = () => null // generic 会话:无工业快照

  const result = await (manager as {
    invokeHostTool: (input: { agentId: string, tool: string, args?: Record<string, unknown> }) => Promise<{ text: string, isError?: boolean }>
  }).invokeHostTool({ agentId: cloneA, tool: 'save_memory', args: { title: 'note-a', content: 'content-a', scope: 'private' } })

  assert.notEqual(result.isError, true, `save must succeed: ${result.text}`)
  assert.equal(savedMemory.length, 1)
  assert.equal(savedMemory[0]?.sessionId, sessionA.id, 'memory must be stamped with the trusted generic-session id')

  // 歧义防护：同一克隆同时出现在两个会话 → activeSessionOfMember fail-closed → 不戳
  sessions.create({ channelId: channel.id, title: 'A2', memberMap: { [base.id]: cloneA } })
  savedMemory.length = 0
  const ambiguous = await (manager as {
    invokeHostTool: (input: { agentId: string, tool: string, args?: Record<string, unknown> }) => Promise<{ text: string, isError?: boolean }>
  }).invokeHostTool({ agentId: cloneA, tool: 'save_memory', args: { title: 'note-a2', content: 'content-a2', scope: 'private' } })
  assert.notEqual(ambiguous.isError, true, `ambiguous save must still succeed: ${ambiguous.text}`)
  assert.equal(savedMemory[0]?.sessionId ?? null, null, 'ambiguous session membership must not be stamped')
})

test('source contract: deferred event flush uses the closure manager and the plugin binds the hub at startup', () => {
  const publish = readFileSync(join(ROOT, 'server/api/workshop/ws/publish.ts'), 'utf-8')
  assert.ok(!publish.includes('if (hub.boundManager) flushDbBuffer'), 'deferred flush must not be gated on hub.boundManager')
  assert.ok(publish.includes('flushDbBuffer(manager, stream)'), 'deferred flush must use the closure manager')

  const plugin = readFileSync(join(ROOT, 'server/plugins/workshop.ts'), 'utf-8')
  assert.match(plugin, /ensureHubBound\(manager\)/, 'workshop plugin must bind the hub at startup (all-time event recording)')

  const streams = readFileSync(join(ROOT, 'server/api/workshop/ws/streams.ts'), 'utf-8')
  assert.match(streams, /rebindStreamIfStale\(hub\.boundManager, stream\)/, 'rebind sweep self-heal must stay wired')
})
