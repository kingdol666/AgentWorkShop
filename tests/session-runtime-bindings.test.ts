import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openWorkshopDb } from '../server/services/workshop/db/database'
import { createChannelRepo } from '../server/services/workshop/db/channel.repo'
import { createChannelAgentRepo } from '../server/services/workshop/db/channel-agent.repo'
import { createChannelSessionRepo } from '../server/services/workshop/db/channel-session.repo'
import { createChannelSessionBindingSnapshot } from '../server/services/workshop/agents/session-snapshot'
import {
  createSessionRuntimeBindingService,
  type SessionRuntimeBindingDeps,
} from '../server/services/workshop/sessions/runtime-bindings'

process.env.AGENTWORKSHOP_TEST = '1'

function deps(): SessionRuntimeBindingDeps {
  return {
    listDaqNodes: () => [
      { id: 'dn-1', name: '温度', unit: 'C', lineId: 'ln-1' },
      { id: 'dn-2', name: '压力', unit: 'bar', lineId: 'ln-1' },
      { id: 'dn-x', name: '别的线', unit: '', lineId: 'ln-2' },
    ],
    listDcwNodes: () => [
      { id: 'dcw-1', name: '阀门', unit: '%', lineId: 'ln-1' },
    ],
    listRecipes: () => [
      { id: 'rc-1', name: '配方A', version: 3, lineId: 'ln-1', productId: 'pd-1' },
      { id: 'rc-x', name: '配方X', version: 1, lineId: 'ln-2', productId: 'pd-x' },
    ],
    listLines: () => [
      { id: 'ln-1', name: '一线' },
      { id: 'ln-2', name: '二线' },
    ],
    lineMode: (_user, lineId) => (lineId === 'ln-1' || lineId === null ? 'operate' : 'none'),
    bindingsOf: () => [
      { id: 'nb-1', nodeId: 'dn-1', kind: 'daq', mode: 'auto' },
      { id: 'nb-2', nodeId: 'rc-1', kind: 'recipe', mode: 'manual' },
      { id: 'nb-3', nodeId: 'dn-x', kind: 'daq', mode: 'auto' },
      { id: 'nb-4', nodeId: 'missing', kind: 'dcw', mode: 'manual' },
    ],
    toolRefresh: () => 'native',
  }
}

function fixture() {
  const db = openWorkshopDb(':memory:')
  const channels = createChannelRepo(db)
  const agents = createChannelAgentRepo(db)
  const sessions = createChannelSessionRepo(db)
  const channel = channels.create({ name: 'bindings', ownerUserId: 'owner' })
  channels.setLine(channel.id, 'ln-1')
  const base = agents.create({ channelId: channel.id, templateId: null, name: 'lead', harness: 'omp', role: 'lead', config: {} })
  const clone = agents.create({ channelId: channel.id, templateId: null, name: 'lead·session·1', harness: 'omp', role: 'worker', config: {} })
  const session = sessions.create({ channelId: channel.id, title: 'A', memberMap: { [base.id]: clone.id } })
  return { db, channels, agents, sessions, channel, base, clone, session }
}

test('binding summary filters resources and bindings by channel line and caller permission', () => {
  const f = fixture()
  try {
    const service = createSessionRuntimeBindingService(f.db, deps())
    const summary = service.get({
      channelId: f.channel.id,
      sessionId: f.session.id,
      agentId: f.clone.id,
      user: { id: 'owner', role: 'admin' },
    })
    assert.equal(summary.lineId, 'ln-1')
    assert.equal(summary.toolRefresh, 'native')
    assert.equal(summary.effectiveAt, 'next_turn')
    assert.deepEqual(summary.bindings.map(b => b.id), ['nb-1', 'nb-2', 'nb-4'])
    assert.equal(summary.bindings.find(b => b.id === 'nb-4')?.name, 'missing', 'dangling binding stays visible by id')
    assert.deepEqual(summary.resources.daqNodes.map(n => n.id), ['dn-1', 'dn-2'])
    assert.deepEqual(summary.resources.dcwNodes.map(n => n.id), ['dcw-1'])
    assert.deepEqual(summary.resources.recipes.map(r => r.id), ['rc-1'])
    assert.deepEqual(summary.resources.lines.map(l => l.id), ['ln-1'])
    assert.deepEqual(summary.scopeRecipes, [])
    assert.equal(summary.scopeMutable, false)
    assert.equal(summary.scopeSource, 'none')
  }
  finally {
    f.db.close()
  }
})

test('binding summary exposes the effective scope recipes for a trusted session', () => {
  const db = openWorkshopDb(':memory:')
  try {
    const channels = createChannelRepo(db)
    const agents = createChannelAgentRepo(db)
    const sessions = createChannelSessionRepo(db)
    const channel = channels.create({ name: 'bindings-trusted', ownerUserId: 'owner' })
    channels.setLine(channel.id, 'ln-1')
    const base = agents.create({ channelId: channel.id, templateId: null, name: 'lead', harness: 'omp', role: 'lead', config: {} })
    const clone = agents.create({ channelId: channel.id, templateId: null, name: 'lead·session·1', harness: 'omp', role: 'worker', config: {} })
    const snapshot = createChannelSessionBindingSnapshot({
      channelId: channel.id,
      selectedProductId: 'pd-1',
      lineId: 'ln-1',
      bindingRevision: 1,
      boundProductIds: ['pd-1'],
      recipes: [{ id: 'rc-1', productId: 'pd-1', lineId: 'ln-1', version: 3, params: [], daqWindows: [] }],
      agentBindings: [],
      executionProfile: { mode: 'manual' },
    })
    const session = sessions.create({
      channelId: channel.id,
      title: 'trusted',
      memberMap: { [base.id]: clone.id },
      channelMode: 'production_line_integrated',
      productId: 'pd-1',
      lineId: 'ln-1',
      bindingSnapshotJson: snapshot.json,
      bindingSnapshotHash: snapshot.hash,
      bindingSnapshotRevision: snapshot.revision,
    })
    const service = createSessionRuntimeBindingService(db, deps())
    const summary = service.get({
      channelId: channel.id,
      sessionId: session.id,
      agentId: clone.id,
      user: { id: 'owner', role: 'admin' },
    })
    assert.equal(summary.channelMode, 'production_line_integrated')
    assert.equal(summary.productId, 'pd-1')
    assert.equal(summary.bindingSnapshotRevision, 1)
    assert.deepEqual(summary.scopeRecipes, [{ id: 'rc-1', name: '配方A', version: 3 }])
    assert.equal(summary.scopeMutable, false)
    assert.equal(summary.scopeSource, 'snapshot')
  }
  finally {
    db.close()
  }
})

test('binding summary rejects a runtime object outside the session', () => {
  const f = fixture()
  try {
    const service = createSessionRuntimeBindingService(f.db, deps())
    assert.throws(
      () => service.get({
        channelId: f.channel.id,
        sessionId: f.session.id,
        agentId: 'not-in-session',
        user: { id: 'owner', role: 'admin' },
      }),
      (err: { code?: string }) => err?.code === 'NOT_FOUND',
    )
  }
  finally {
    f.db.close()
  }
})
