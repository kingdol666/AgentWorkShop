/**
 * G1 Adapter 真实注册与租约:训练适配器可解析(未注册返回 null);Solver 租约/drain;
 * 环境读租约阻止重建(ENV_BUSY)。
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-optimizer-adapters-'))

const { openWorkshopDb } = await import('../server/services/workshop/db/database/open')
const { configureAmlRuntime, getAmlRuntime } = await import('../server/services/workshop/aml/runtime')
const { getTwinProviderRegistry } = await import('../server/services/workshop/aml/twin/provider-registry')
const { registerBuiltinOptimizerAdapters } = await import('../server/services/workshop/process-model/trainers')

const db = openWorkshopDb(join(process.env.AW_HOME!, 'adapters.sqlite'))
configureAmlRuntime(db)

test('TrainingAdapter 真实注册:内置两家族可解析,未注册返回 null(不再恒 accepted)', () => {
  registerBuiltinOptimizerAdapters()
  const registry = getTwinProviderRegistry()
  const linear = registry.resolveTrainingAdapter('linear_arx@1')
  assert.ok(linear, 'linear_arx@1 应可解析')
  assert.equal(linear!.manifest.artifactKind, 'linear_state_space@1')
  const staticAdapter = registry.resolveTrainingAdapter('static_response@1')
  assert.ok(staticAdapter)
  assert.equal(staticAdapter!.manifest.artifactKind, 'static_response@1')
  assert.equal(registry.resolveTrainingAdapter('nope@9'), null)
  assert.ok(registry.listTrainingAdapters().length >= 2)
  // 目标模板同样真实注册
  assert.ok(registry.resolveObjectiveAdapter('linear_mpc_quadratic@1'))
  assert.ok(registry.resolveObjectiveAdapter('steady_response@1'))
  assert.equal(registry.resolveObjectiveAdapter('unknown@1'), null)
})

test('SolverAdapter 租约:acquire→inFlight=1→release;drain 期间新 acquire 被拒', () => {
  const registry = getTwinProviderRegistry()
  registry.registerTwinPluginContribution('test-solver-plugin', {
    solverAdapters: [{ manifest: { adapterId: 'fake_solver', version: '1' }, solve: () => ({ ok: true }) }],
  })
  assert.equal(registry.solverLeaseCount('fake_solver'), 0)
  const lease = registry.acquireSolverAdapter('fake_solver')
  assert.equal(registry.solverLeaseCount('fake_solver'), 1)
  lease.release()
  assert.equal(registry.solverLeaseCount('fake_solver'), 0)
  registry.drainSolverAdapter('fake_solver')
  assert.throws(() => registry.acquireSolverAdapter('fake_solver'), (err: { code?: string }) => err.code === 'SOLVER_DRAINING')
  // 在途租约不被 drain 替换(热更新纪律)
  assert.throws(() => registry.acquireSolverAdapter('missing_solver'), (err: { code?: string }) => err.code === 'SOLVER_NOT_FOUND')
})

test('环境读租约:持租约时重建返回 ENV_BUSY', async () => {
  const { acquireEnvReadLease, assertEnvIdleForMaintenance, envLeaseStatus } = await import('../server/services/workshop/aml/env-lease')
  const { ensureVenv } = await import('../server/services/workshop/aml/python-runtime')
  const lease = acquireEnvReadLease('test-training')
  assert.equal(envLeaseStatus().readers, 1)
  assert.throws(() => assertEnvIdleForMaintenance('ensure-venv-force'), (err: { code?: string }) => err.code === 'ENV_BUSY')
  await assert.rejects(() => ensureVenv(getAmlRuntime(), { force: true }), (err: { code?: string }) => err.code === 'ENV_BUSY')
  lease.release()
  assert.equal(envLeaseStatus().readers, 0)
  assert.doesNotThrow(() => assertEnvIdleForMaintenance('rebuild'))
})
