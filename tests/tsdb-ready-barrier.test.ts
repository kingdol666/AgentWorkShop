import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

test('tsdbReady waits for the default SQLite adapter initialization', async () => {
  process.env.AGENTWORKSHOP_TEST = '1'
  process.env.AW_MODE = 'home'
  process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-tsdb-ready-'))
  delete process.env.DAQ_TSDB_URL

  const { SqliteTimeSeriesAdapter } = await import('../server/services/workshop/daq/storage/sqlite.adapter')
  const originalInit = SqliteTimeSeriesAdapter.prototype.init
  let releaseInitialization!: () => void
  let initStarted = false
  const initialization = new Promise<void>((resolve) => {
    releaseInitialization = resolve
  })
  SqliteTimeSeriesAdapter.prototype.init = async function () {
    initStarted = true
    await initialization
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
    assert.equal(getTsdb().backend, 'sqlite-emulated')
    assert.equal(initStarted, true)
    assert.equal(readySettled, false, 'readiness must wait for the SQLite schema initialization')

    releaseInitialization()
    await ready
    assert.equal(readySettled, true)
    assert.equal(readyError, undefined)
  }
  finally {
    releaseInitialization()
    SqliteTimeSeriesAdapter.prototype.init = originalInit
  }
})
