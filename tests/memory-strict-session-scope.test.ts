import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-mem-strict-session-'))
delete process.env.AW_BENCH_MODE

const { openWorkshopDb } = await import('../server/services/workshop/db/database')
const { createMemoryRepo } = await import('../server/services/workshop/db/memory.repo')
const { AgentMemory } = await import('../server/services/workshop/runtime/memory')

test('session scope returns only its session and fails closed without a sessionId', async () => {
  const db = openWorkshopDb(':memory:')
  try {
    const repo = createMemoryRepo(db)
    const memory = new AgentMemory(repo, { channelId: 'channel-a', agentId: 'agent-a' })
    await memory.save({ title: 'Session A finding', content: 'distinctive session scope finding', scope: 'private', sessionId: 'session-A' })
    await memory.save({ title: 'Session B finding', content: 'distinctive session scope finding', scope: 'private', sessionId: 'session-B' })

    const sessionB = await memory.recallRows('distinctive session scope finding', { scope: 'session', sessionId: 'session-B' })
    assert.deepEqual(sessionB.map(row => row.sessionId), ['session-B'])

    const missingSession = await memory.recallRows('distinctive session scope finding', { scope: 'session' })
    assert.deepEqual(missingSession, [])
  }
  finally {
    db.close()
  }
})
