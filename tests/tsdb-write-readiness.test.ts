import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-tsdb-write-readiness-'))

const { SqliteTimeSeriesAdapter } = await import('../server/services/workshop/daq/storage/sqlite.adapter')
const { TimescaleAdapter } = await import('../server/services/workshop/daq/storage/timescale.adapter')

test('SQLite direct writes initialize the adapter rather than silently dropping rows', async () => {
  const adapter = new SqliteTimeSeriesAdapter()
  const tsMs = Date.now()
  await adapter.writeSamples([{ nodeId: 'n-early', tsMs, value: 42, state: 'ok' }])
  const points = await adapter.query('n-early', { fromMs: tsMs, toMs: tsMs, limit: 1 })
  assert.equal(points[0]?.value, 42)
  await adapter.close()
})

test('Timescale direct writes reject until schema initialization completes', async () => {
  const adapter = new TimescaleAdapter('postgres://unused')
  const tsMs = Date.now()
  const sample = [{ nodeId: 'n-early', tsMs, value: 42, state: 'ok' }]
  const frame = [{ nodeId: 'n-early', tsMs, kind: 'vector' as const, points: 1, meta: {}, metrics: {} }]
  ;(adapter as unknown as { pool: unknown }).pool = { query: async () => ({ rows: [] }) }

  await assert.rejects(adapter.writeSamples(sample), /TSDB_NOT_READY/)
  await assert.rejects(adapter.writeFrames(frame), /TSDB_NOT_READY/)
})
