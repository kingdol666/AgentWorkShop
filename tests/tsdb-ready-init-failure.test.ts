import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

test('initialization rejection is observed and remains available to readiness readers', async () => {
  process.env.AGENTWORKSHOP_TEST = '1'
  process.env.AW_MODE = 'home'
  process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-tsdb-init-failed-'))
  process.env.DAQ_TSDB_URL = 'postgres://test:test@127.0.0.1/aw'

  const { SqliteTimeSeriesAdapter } = await import('../server/services/workshop/daq/storage/sqlite.adapter')
  const { TimescaleAdapter } = await import('../server/services/workshop/daq/storage/timescale.adapter')
  const originalSqliteInit = SqliteTimeSeriesAdapter.prototype.init
  const originalTimescaleInit = TimescaleAdapter.prototype.init
  let unhandled = false
  const onUnhandled = () => {
    unhandled = true
  }
  process.on('unhandledRejection', onUnhandled)
  SqliteTimeSeriesAdapter.prototype.init = async function () {
    throw new Error('simulated SQLite fallback initialization failure')
  }
  TimescaleAdapter.prototype.init = async function () {
    throw new Error('simulated Timescale initialization failure')
  }

  try {
    const storage = await import('../server/services/workshop/daq/storage')
    await new Promise<void>(resolve => setTimeout(resolve, 25))
    assert.equal(unhandled, false, 'startup failure must have an internal rejection observer')
    await assert.rejects(storage.waitForTsdb(), /simulated SQLite fallback initialization failure/)
  }
  finally {
    process.off('unhandledRejection', onUnhandled)
    SqliteTimeSeriesAdapter.prototype.init = originalSqliteInit
    TimescaleAdapter.prototype.init = originalTimescaleInit
  }
})
