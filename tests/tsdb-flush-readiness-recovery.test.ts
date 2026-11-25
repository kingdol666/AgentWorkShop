/**
 * 就绪门拒绝不得冻结刷盘管线:
 * waitForTsdb() 在 Timescale 与 SQLite 双双初始化失败时保持 reject(供验收面读取失败),
 * 但采集侧不能因此永远停在屏障上 —— 适配器写入本身是自愈(SQLite ensureDb)或
 * fail-closed(Timescale TSDB_NOT_READY),刷盘应记录失败后继续尝试,样本最终仍能落库。
 *
 * 回归背景(2026-11-25 复审):flushTsdb 首行 await waitForTsdb() 且调用点是 void,
 * 旧实现下屏障一旦永久 reject,每次刷盘都在屏障处抛出,批次只增不减,直到进程重启。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-tsdb-flush-barrier-'))
delete process.env.AW_BENCH_MODE
delete process.env.DAQ_TSDB_URL

const { bindDaqHostPorts } = await import('../server/services/workshop/daq/host-ports')
const { getDaqController } = await import('../server/services/workshop/daq/daq-controller')
const { getTsdb, waitForTsdb } = await import('../server/services/workshop/daq/storage')

const LINE = 'ln-flush-barrier'

bindDaqHostPorts({
  telemetry: {
    applyTelemetry: () => ({ ok: true, twinId: null }),
    scenePayload: () => null,
    deviceExists: () => true,
    listDaqTwins: () => [],
  },
  lineRun: {
    activeRun: lineId => (lineId === LINE ? { lineId: LINE, runId: 'run-barrier', recipeId: 'rec-barrier', productId: 'prod-barrier' } : null),
    hasAnyActiveRun: () => true,
    recipeWindow: () => null,
    lineExists: () => true,
    bumpTaggedSamples: () => {},
  },
})

const tsdb = getTsdb()
await waitForTsdb()
const readSamples = tsdb.query.bind(tsdb)
const ctrl = getDaqController()
const node = ctrl.create({
  templateRef: 'daq-temp-tc',
  name: 'flush-barrier-temp',
  driver: 'mock',
  lineId: LINE,
  intervalMs: 1000,
})

test('readiness rejection is recorded but flush keeps writing (no frozen buffer)', async () => {
  const state = (globalThis as typeof globalThis & {
    __daqTsdbState?: { initialization?: unknown }
  }).__daqTsdbState
  assert.ok(state, 'storage state must be initialized')
  const original = state.initialization
  // Thenable 只在被 await 时拒绝:仓库内不得产生一个无人持有的 rejected Promise。
  state.initialization = {
    then: (_resolve: unknown, reject: (err: Error) => void) => reject(new Error('simulated readiness rejection')),
  }

  let unhandled: unknown = null
  const onUnhandled = (err: unknown) => {
    unhandled = err
  }
  process.on('unhandledRejection', onUnhandled)

  try {
    const fromMs = Date.now() - 60_000
    ctrl.startAll()
    await new Promise(r => setTimeout(r, 3200))
    ctrl.stopAll()
    await new Promise(r => setTimeout(r, 1200))

    const toMs = Date.now() + 1000
    const points = await readSamples(node.id, { fromMs, toMs, limit: 100 })
    assert.ok(points.length >= 1, `屏障拒绝后样本仍应落库,实际 ${points.length} 点`)
    assert.equal(unhandled, null, '屏障拒绝必须被刷盘路径消化,不得产生未处理拒绝')
  }
  finally {
    process.off('unhandledRejection', onUnhandled)
    state.initialization = original
  }
})
