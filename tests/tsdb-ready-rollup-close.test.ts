import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

test('raw TSDB recovery does not wait for optional rollup shutdown', async () => {
  process.env.AGENTWORKSHOP_TEST = '1'
  process.env.AW_MODE = 'home'
  process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-tsdb-rollup-close-'))
  process.env.DAQ_TSDB_URL = 'postgres://test:test@127.0.0.1/aw'

  const { TimescaleAdapter } = await import('../server/services/workshop/daq/storage/timescale.adapter')
  const { TimescaleRollupStore } = await import('../server/services/workshop/daq/storage/timescale-rollup')
  const originalAdapterInit = TimescaleAdapter.prototype.init
  const originalStoreInit = TimescaleRollupStore.prototype.init
  const originalStoreClose = TimescaleRollupStore.prototype.close
  let releaseClose!: () => void
  const closePending = new Promise<void>((resolve) => {
    releaseClose = resolve
  })
  let closeStarted!: () => void
  const closing = new Promise<void>((resolve) => {
    closeStarted = resolve
  })
  TimescaleAdapter.prototype.init = async function () {}
  TimescaleRollupStore.prototype.init = async function () {}

  try {
    const storage = await import('../server/services/workshop/daq/storage')
    await storage.waitForTsdb()
    const oldStore = storage.getRollupStore()
    assert.ok(oldStore, 'initial optional rollup store should be attached')
    oldStore.close = async function () {
      closeStarted()
      await closePending
    }

    const rebuilding = storage.rebuildTsdb(true, process.env.DAQ_TSDB_URL)
    await closing
    await rebuilding
    await storage.waitForTsdb()
    assert.equal(storage.getTsdb().backend, 'timescale')
  }
  finally {
    releaseClose()
    TimescaleAdapter.prototype.init = originalAdapterInit
    TimescaleRollupStore.prototype.init = originalStoreInit
    TimescaleRollupStore.prototype.close = originalStoreClose
  }
})
