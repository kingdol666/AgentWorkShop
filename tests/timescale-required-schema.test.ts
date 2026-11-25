// Timescale init must fail on every required schema step (samples table/hypertable,
// all tag columns, frames table/hypertable) and release the pool on that path;
// optional objects (helper indexes, physical policies) stay best-effort.
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-ts-schema-'))

const { TimescaleAdapter } = await import('../server/services/workshop/daq/storage/timescale.adapter')

interface PoolLike {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>
  end: () => Promise<void>
}

function fakePool(failOn: RegExp | null) {
  const state = { closed: false, queries: [] as string[] }
  const pool: PoolLike = {
    async query(sql: string) {
      state.queries.push(sql)
      if (failOn && failOn.test(sql)) throw new Error(`simulated failure for: ${sql.slice(0, 60)}`)
      return { rows: [{ node_id: 'dn-x', ts: new Date().toISOString() }] }
    },
    async end() {
      state.closed = true
    },
  }
  return { pool, state }
}

const asPool = (pool: PoolLike) => pool as unknown as Parameters<InstanceType<typeof TimescaleAdapter>['init']>[0]
const initializedOf = (adapter: InstanceType<typeof TimescaleAdapter>) =>
  (adapter as unknown as { initialized: boolean }).initialized

const REQUIRED: Array<[string, RegExp]> = [
  ['samples table', /CREATE TABLE IF NOT EXISTS daq_samples/],
  ['samples hypertable', /create_hypertable\('daq_samples'/],
  ['node_ts index', /CREATE INDEX IF NOT EXISTS idx_daq_samples_node_ts/],
  ['quality column', /ADD COLUMN IF NOT EXISTS quality/],
  ['line_id column', /ADD COLUMN IF NOT EXISTS line_id/],
  ['product_id column', /ADD COLUMN IF NOT EXISTS product_id/],
  ['recipe_id column', /ADD COLUMN IF NOT EXISTS recipe_id/],
  ['run_id column', /ADD COLUMN IF NOT EXISTS run_id/],
  ['ingested_at column', /ADD COLUMN IF NOT EXISTS ingested_at/],
  ['frames table', /CREATE TABLE IF NOT EXISTS daq_frames/],
  ['frames hypertable', /create_hypertable\('daq_frames'/],
]

for (const [name, pattern] of REQUIRED) {
  test(`init rejects and releases the pool when required ${name} fails`, async () => {
    const adapter = new TimescaleAdapter('postgres://fake')
    const { pool, state } = fakePool(pattern)
    await assert.rejects(adapter.init(asPool(pool)), /simulated failure/)
    assert.equal(initializedOf(adapter), false, 'failed schema must not mark the adapter initialized')
    assert.equal(state.closed, true, 'degraded path must close the pool')
  })
}

test('optional helper index failure does not reject init', async () => {
  const adapter = new TimescaleAdapter('postgres://fake')
  const warnings: string[] = []
  const original = console.warn
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(' '))
  }
  try {
    const { pool } = fakePool(/CREATE INDEX IF NOT EXISTS idx_daq_samples_tag/)
    await adapter.init(asPool(pool))
    assert.equal(initializedOf(adapter), true)
    await adapter.close()
  }
  finally {
    console.warn = original
  }
  assert.ok(warnings.some(w => /idx_daq_samples_tag/.test(w)), 'optional failure must be logged, not silent')
})

test('physical policy failure stays best-effort and init still succeeds', async () => {
  const adapter = new TimescaleAdapter('postgres://fake')
  const warnings: string[] = []
  const original = console.warn
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(' '))
  }
  try {
    const { pool } = fakePool(/set_chunk_time_interval|add_compression_policy|SET \(timescaledb\.compress/)
    await adapter.init(asPool(pool))
    assert.equal(initializedOf(adapter), true)
    await adapter.close()
  }
  finally {
    console.warn = original
  }
  assert.ok(warnings.length >= 6, `all six policy steps warn: ${warnings.length}`)
})

test('a clean schema pass leaves the adapter writable', async () => {
  const adapter = new TimescaleAdapter('postgres://fake')
  const { pool } = fakePool(null)
  await adapter.init(asPool(pool))
  assert.equal(initializedOf(adapter), true)
  await adapter.writeSamples([{ nodeId: 'dn-x', tsMs: Date.now(), value: 1, state: 'ok' }])
  await adapter.close()
})
