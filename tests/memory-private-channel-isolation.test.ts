import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-memory-private-channel-'))
delete process.env.AW_BENCH_MODE

const { openWorkshopDb } = await import('../server/services/workshop/db/database')
const { createMemoryRepo, TEAM_AGENT_ID } = await import('../server/services/workshop/db/memory.repo')
const { AgentMemory } = await import('../server/services/workshop/runtime/memory')

test('private memories are isolated between channels for the same agent', async () => {
  const db = openWorkshopDb(':memory:')
  try {
    const repo = createMemoryRepo(db)
    const channelA = new AgentMemory(repo, { channelId: 'channel-a', agentId: 'agent-1' })
    const channelB = new AgentMemory(repo, { channelId: 'channel-b', agentId: 'agent-1' })

    await channelA.save({
      title: 'Private channel secret protocol',
      content: 'The private channel secret protocol uses valve seven.',
      scope: 'private',
    })

    const recalled = await channelB.recallRows('private channel secret protocol', { scope: 'private' })

    assert.deepEqual(recalled, [], 'channel B must not recall channel A private memories')
  }
  finally {
    db.close()
  }
})

test('shared near-neighbor merge is limited to the current channel', async () => {
  const db = openWorkshopDb(':memory:')
  try {
    const repo = createMemoryRepo(db)
    const channelA = new AgentMemory(repo, { channelId: 'channel-a', agentId: 'agent-1' })
    const channelB = new AgentMemory(repo, { channelId: 'channel-b', agentId: 'agent-1' })
    const entry = {
      title: 'Shared pressure target',
      content: 'Set the shared pressure target to 7 bar.',
      scope: 'shared' as const,
      dedupKey: 'shared-pressure-target',
    }

    await channelA.save(entry)
    await channelB.save(entry)

    const rowsA = repo.listByAgentChannel('channel-a', TEAM_AGENT_ID, 10)
    const rowsB = repo.listByAgentChannel('channel-b', TEAM_AGENT_ID, 10)
    assert.equal(rowsA.length, 1)
    assert.equal(rowsB.length, 1, 'channel B must create its own shared entry')
    assert.equal(rowsA[0]!.content, 'Set the shared pressure target to 7 bar.', 'channel A entry must not be mutated by channel B')
    assert.equal(rowsB[0]!.content, 'Set the shared pressure target to 7 bar.')
  }
  finally {
    db.close()
  }
})

test('product experience recall requires an exact current product match', async () => {
  const db = openWorkshopDb(':memory:')
  try {
    const repo = createMemoryRepo(db)
    const memory = new AgentMemory(repo, { channelId: 'channel-a', agentId: 'agent-1', industrialScopeEnabled: true, productId: 'product-a' })
    for (const [productId, suffix] of [['product-a', 'A'], ['product-b', 'B']] as const) {
      repo.upsertExperience({
        channelId: 'channel-a',
        agentId: 'agent-1',
        kind: 'experience',
        title: `Product ${suffix} pressure finding`,
        titleFts: `product ${suffix} pressure finding`,
        content: 'Distinctive product pressure finding.',
        importance: 0.7,
        dedupKey: `product-pressure-${suffix}`,
        evidence: { taskIds: [`task-${suffix}`] },
        scopeKind: 'product',
        scopeKey: productId,
        status: 'active',
      })
    }

    const matching = await memory.recallRows('distinctive product pressure finding', {
      scope: 'private',
      scopeContext: { productId: 'product-a' },
    })
    const missingContext = await new AgentMemory(repo, { channelId: 'channel-a', agentId: 'agent-1', industrialScopeEnabled: true }).recallRows('distinctive product pressure finding', {
      scope: 'private',
      scopeContext: { productId: 'product-a' },
    })

    assert.deepEqual(matching.map(row => row.scopeKey), ['product-a'])
    assert.deepEqual(missingContext, [], 'tool scopeContext must not grant product access without trusted Session context')
  }
  finally {
    db.close()
  }
})

test('candidate product experiences are excluded from automatic memory injection', async () => {
  const db = openWorkshopDb(':memory:')
  try {
    const repo = createMemoryRepo(db)
    const memory = new AgentMemory(repo, { channelId: 'channel-a', agentId: 'agent-1' })
    repo.upsertExperience({
      channelId: 'channel-a',
      agentId: 'agent-1',
      kind: 'experience',
      title: 'Candidate product pressure finding',
      titleFts: 'candidate product pressure finding',
      content: 'Candidate product pressure finding.',
      importance: 0.7,
      dedupKey: 'candidate-product-pressure',
      evidence: { taskIds: ['task-candidate'] },
      scopeKind: 'product',
      scopeKey: 'product-a',
      status: 'candidate',
    })

    const block = await memory.recall('candidate product pressure finding', {
      scopeContext: { productId: 'product-a' },
    })

    assert.equal(block, null)
  }
  finally {
    db.close()
  }
})
