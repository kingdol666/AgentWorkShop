import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-session-recall-'))
delete process.env.AW_BENCH_MODE

const { openWorkshopDb } = await import('../server/services/workshop/db/database')
const { createMemoryRepo } = await import('../server/services/workshop/db/memory.repo')
const { AgentMemory } = await import('../server/services/workshop/runtime/memory')

test('session-scoped recall never returns another session private records', async () => {
  const db = openWorkshopDb(':memory:')
  try {
    const repo = createMemoryRepo(db)
    const memory = new AgentMemory(repo, { channelId: 'channel-1', agentId: 'agent-1' })

    await memory.save({
      title: 'Session A private record',
      content: 'shared query marker calibration value 7351',
      scope: 'private',
      sessionId: 'session-a',
    })
    await memory.save({
      title: 'Session B private record',
      content: 'shared query marker calibration value 7351',
      scope: 'private',
      sessionId: 'session-b',
    })

    const rows = await memory.recallRows('shared query marker calibration 7351', {
      scope: 'session',
      sessionId: 'session-b',
      limit: 10,
    })

    assert.ok(rows.some(row => row.title === 'Session B private record'), 'session B should recall its own record')
    assert.ok(!rows.some(row => row.title === 'Session A private record'), 'session B must not recall session A private record')
    assert.ok(rows.every(row => row.sessionId === 'session-b'), 'all results must belong to session B')
  }
  finally {
    db.close()
  }
})
