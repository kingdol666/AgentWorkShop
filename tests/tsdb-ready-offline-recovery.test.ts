import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

test('offline rebuild retries a failed SQLite placeholder and refreshes readiness', async () => {
  process.env.AGENTWORKSHOP_TEST = '1'
  process.env.AW_MODE = 'home'
  process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-tsdb-offline-recovery-'))
  delete process.env.DAQ_TSDB_URL

  const { SqliteTimeSeriesAdapter } = await import('../server/services/workshop/daq/storage/sqlite.adapter')
  const originalInit = SqliteTimeSeriesAdapter.prototype.init
  let initCalls = 0
  SqliteTimeSeriesAdapter.prototype.init = async function () {
    initCalls++
    if (initCalls === 1) throw new Error('simulated placeholder initialization failure')
  }

  try {
    const storage = await import('../server/services/workshop/daq/storage')
    await assert.rejects(storage.waitForTsdb(), /simulated placeholder initialization failure/)

    await storage.rebuildTsdb(false)
    await storage.waitForTsdb()
    assert.equal(initCalls, 2)
    assert.equal(storage.getTsdb().backend, 'sqlite-emulated')
  }
  finally {
    SqliteTimeSeriesAdapter.prototype.init = originalInit
  }
})
