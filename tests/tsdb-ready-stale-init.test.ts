import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

test('late Timescale startup failure cannot replace a recovered adapter', async () => {
  process.env.AGENTWORKSHOP_TEST = '1'
  process.env.AW_MODE = 'home'
  process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-tsdb-stale-init-'))
  process.env.DAQ_TSDB_URL = 'postgres://test:test@127.0.0.1/aw'

  const { TimescaleAdapter } = await import('../server/services/workshop/daq/storage/timescale.adapter')
  const { TimescaleRollupStore } = await import('../server/services/workshop/daq/storage/timescale-rollup')
  const originalInit = TimescaleAdapter.prototype.init
  const originalClose = TimescaleAdapter.prototype.close
  const originalRollupInit = TimescaleRollupStore.prototype.init
  let releaseFirstClose!: () => void
  let closeStarted!: () => void
  const firstCloseStarted = new Promise<void>((resolve) => {
    closeStarted = resolve
  })
  const firstClose = new Promise<void>((resolve) => {
    releaseFirstClose = resolve
  })
  let initCalls = 0
  let closeCalls = 0
  TimescaleAdapter.prototype.init = async function () {
    initCalls++
    if (initCalls === 1) throw new Error('simulated late startup failure')
  }
  TimescaleAdapter.prototype.close = async function () {
    closeCalls++
    if (closeCalls === 1) {
      closeStarted()
      await firstClose
    }
  }
  TimescaleRollupStore.prototype.init = async function () {}

  try {
    const storage = await import('../server/services/workshop/daq/storage')
    const initialReadiness = storage.waitForTsdb()
    await firstCloseStarted

    await storage.rebuildTsdb(true, process.env.DAQ_TSDB_URL)
    releaseFirstClose()
    await initialReadiness
    await storage.waitForTsdb()

    assert.equal(storage.getTsdb().backend, 'timescale')
  }
  finally {
    releaseFirstClose()
    TimescaleAdapter.prototype.init = originalInit
    TimescaleAdapter.prototype.close = originalClose
    TimescaleRollupStore.prototype.init = originalRollupInit
  }
})
