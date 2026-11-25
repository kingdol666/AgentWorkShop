import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

test('successful Timescale rebuild replaces rejected readiness after SQLite init failure', async () => {
  process.env.AGENTWORKSHOP_TEST = '1'
  process.env.AW_MODE = 'home'
  process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-tsdb-online-recovery-'))
  process.env.DAQ_TSDB_URL = 'postgres://test:test@127.0.0.1/aw'

  const { SqliteTimeSeriesAdapter } = await import('../server/services/workshop/daq/storage/sqlite.adapter')
  const { TimescaleAdapter } = await import('../server/services/workshop/daq/storage/timescale.adapter')
  const { TimescaleRollupStore } = await import('../server/services/workshop/daq/storage/timescale-rollup')
  const originalSqliteInit = SqliteTimeSeriesAdapter.prototype.init
  const originalTimescaleInit = TimescaleAdapter.prototype.init
  const originalRollupInit = TimescaleRollupStore.prototype.init
  SqliteTimeSeriesAdapter.prototype.init = async function () {
    throw new Error('simulated SQLite fallback initialization failure')
  }
  let timescaleInitCalls = 0
  TimescaleAdapter.prototype.init = async function () {
    timescaleInitCalls++
    if (timescaleInitCalls === 1) throw new Error('simulated initial Timescale initialization failure')
  }
  TimescaleRollupStore.prototype.init = async function () {}

  try {
    const storage = await import('../server/services/workshop/daq/storage')
    await assert.rejects(storage.waitForTsdb(), /simulated SQLite fallback initialization failure/)

    await storage.rebuildTsdb(true, process.env.DAQ_TSDB_URL)
    await storage.waitForTsdb()
    assert.equal(storage.getTsdb().backend, 'timescale')
  }
  finally {
    SqliteTimeSeriesAdapter.prototype.init = originalSqliteInit
    TimescaleAdapter.prototype.init = originalTimescaleInit
    TimescaleRollupStore.prototype.init = originalRollupInit
  }
})
