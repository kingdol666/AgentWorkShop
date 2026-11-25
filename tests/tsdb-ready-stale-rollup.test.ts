import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

test('stale rollup initialization cannot replace the current adapter rollup', async () => {
  process.env.AGENTWORKSHOP_TEST = '1'
  process.env.AW_MODE = 'home'
  process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-tsdb-stale-rollup-'))
  process.env.DAQ_TSDB_URL = 'postgres://test:test@127.0.0.1/aw'

  const { TimescaleAdapter } = await import('../server/services/workshop/daq/storage/timescale.adapter')
  const { TimescaleRollupStore } = await import('../server/services/workshop/daq/storage/timescale-rollup')
  const originalAdapterInit = TimescaleAdapter.prototype.init
  const originalRollupInit = TimescaleRollupStore.prototype.init
  let releaseFirstRollup!: () => void
  let firstRollupStarted!: () => void
  let secondRollupStarted!: () => void
  const firstStarted = new Promise<void>((resolve) => {
    firstRollupStarted = resolve
  })
  const secondStarted = new Promise<void>((resolve) => {
    secondRollupStarted = resolve
  })
  const firstRollup = new Promise<void>((resolve) => {
    releaseFirstRollup = resolve
  })
  let rollupInitCalls = 0
  TimescaleAdapter.prototype.init = async function () {}
  TimescaleRollupStore.prototype.init = async function () {
    rollupInitCalls++
    if (rollupInitCalls === 1) {
      firstRollupStarted()
      await firstRollup
    }
    else if (rollupInitCalls === 2) {
      Object.assign(this, { testMarker: 'current' })
      secondRollupStarted()
    }
  }

  try {
    const storage = await import('../server/services/workshop/daq/storage')
    await storage.waitForTsdb()
    await firstStarted

    await storage.rebuildTsdb(true, process.env.DAQ_TSDB_URL)
    await storage.waitForTsdb()
    await secondStarted
    assert.equal((storage.getRollupStore() as (TimescaleRollupStore & { testMarker?: string }) | null)?.testMarker, 'current')

    releaseFirstRollup()
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal((storage.getRollupStore() as (TimescaleRollupStore & { testMarker?: string }) | null)?.testMarker, 'current')
  }
  finally {
    releaseFirstRollup()
    TimescaleAdapter.prototype.init = originalAdapterInit
    TimescaleRollupStore.prototype.init = originalRollupInit
  }
})
