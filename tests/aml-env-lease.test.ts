/**
 * G1 环境租约:持读租约时安装/重建返回 ENV_BUSY;释放后可维护。
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-aml-env-lease-'))

const { openWorkshopDb } = await import('../server/services/workshop/db/database/open')
const { configureAmlRuntime, getAmlRuntime } = await import('../server/services/workshop/aml/runtime')
const { acquireEnvReadLease, assertEnvIdleForMaintenance, envLeaseStatus } = await import('../server/services/workshop/aml/env-lease')
const { ensureVenv } = await import('../server/services/workshop/aml/python-runtime')

configureAmlRuntime(openWorkshopDb(join(process.env.AW_HOME!, 'env-lease.sqlite')))

test('读租约计数与 ENV_BUSY', async () => {
  const lease = acquireEnvReadLease('training-job')
  assert.equal(envLeaseStatus().readers, 1)
  assert.throws(() => assertEnvIdleForMaintenance('rebuild'), (err: { code?: string }) => err.code === 'ENV_BUSY')
  await assert.rejects(() => ensureVenv(getAmlRuntime(), { force: true }), (err: { code?: string }) => err.code === 'ENV_BUSY')
  lease.release()
  assert.equal(envLeaseStatus().readers, 0)
  assert.doesNotThrow(() => assertEnvIdleForMaintenance('rebuild'))
})
