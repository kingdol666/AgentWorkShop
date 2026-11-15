import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openWorkshopDb } from '../server/services/workshop/db/database'
import { createChannelRepo } from '../server/services/workshop/db/channel.repo'
import { createChannelAgentRepo } from '../server/services/workshop/db/channel-agent.repo'
import { createMessageRepo } from '../server/services/workshop/db/message.repo'
import { createMemoryRepo } from '../server/services/workshop/db/memory.repo'
import { ManagerRuntimeWiring } from '../server/services/workshop/runtime/manager/runtime-wiring'
import { AgentRuntime } from '../server/services/workshop/runtime/agent-runtime/facade'

process.env.AGENTWORKSHOP_TEST = '1'

test('wireMember calls setChannelSessionScope with the impl as receiver', () => {
  const db = openWorkshopDb(':memory:')
  try {
    const channels = createChannelRepo(db)
    const channel = channels.create({ name: 'scope-wire' })
    const agents = createChannelAgentRepo(db)
    const agent = agents.create({ channelId: channel.id, templateId: null, name: 'lead', harness: 'fake', role: 'lead' })
    let calls = 0
    const impl = {
      bridgeCtx: { identity: {} } as Record<string, unknown>,
      setChannelSessionScope(scope: unknown) {
        calls += 1
        // 解构后裸调用时 this=undefined → 这里抛 TypeError,与线上频道激活 500 同型
        this.bridgeCtx.channelSessionScope = scope
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
      const wire = (manager as { wireMember: (m: unknown) => { stop: () => Promise<void> } }).wireMember
      const runtime = wire.call(manager, agents.findById(agent.id))
      assert.equal(calls, 1, 'setChannelSessionScope must be invoked exactly once')
      assert.equal(impl.bridgeCtx.channelSessionScope, null, 'generic channel wires a null session scope')
      assert.ok(runtime)
    }
    finally {
      AgentRuntime.prototype.start = start
    }
  }
  finally {
    db.close()
  }
})
