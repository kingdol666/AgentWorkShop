import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

test('tsdbReady waits for SQLite fallback initialization after Timescale failure', async () => {
  process.env.AGENTWORKSHOP_TEST = '1'
  process.env.AW_MODE = 'home'
  process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-tsdb-fallback-ready-'))
  process.env.DAQ_TSDB_URL = 'postgres://test:test@127.0.0.1/aw'

  const { SqliteTimeSeriesAdapter } = await import('../server/services/workshop/daq/storage/sqlite.adapter')
  const { TimescaleAdapter } = await import('../server/services/workshop/daq/storage/timescale.adapter')
  const originalSqliteInit = SqliteTimeSeriesAdapter.prototype.init
  const originalTimescaleInit = TimescaleAdapter.prototype.init
  let releaseFallbackInitialization!: () => void
  let fallbackInitStarted = false
  const fallbackInitialization = new Promise<void>((resolve) => {
    releaseFallbackInitialization = resolve
  })
  SqliteTimeSeriesAdapter.prototype.init = async function () {
    fallbackInitStarted = true
    await fallbackInitialization
  }
  TimescaleAdapter.prototype.init = async function () {
    throw new Error('simulated Timescale initialization failure')
  }

  try {
    const { getTsdb, waitForTsdb } = await import('../server/services/workshop/daq/storage')
    const ready = waitForTsdb()
    let readySettled = false
    let readyError: unknown
    void ready.then(
      () => { readySettled = true },
      (error) => {
        readySettled = true
        readyError = error
      },
    )

    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(fallbackInitStarted, true)
    assert.equal(getTsdb().backend, 'sqlite-emulated')
    assert.equal(readySettled, false, 'readiness must include initialization of the fallback adapter')

    releaseFallbackInitialization()
    await ready
    assert.equal(readySettled, true)
    assert.equal(readyError, undefined)
  }
  finally {
    releaseFallbackInitialization()
    SqliteTimeSeriesAdapter.prototype.init = originalSqliteInit
    TimescaleAdapter.prototype.init = originalTimescaleInit
  }
})
