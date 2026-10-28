/**
 * 2026-10-28 P2 加固单测:S11 未知驱动 fail-loud / S12 ingest 时间戳 / S15 Modbus 原始值范围。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-p2-'))

const { migrateDriverKind } = await import('@/server/services/workshop/daq/drivers')
const { ingestTimeVerdict, ingestFutureSkewMs, ingestBackfillWindowMs } = await import('@/server/services/workshop/daq/ingest-policy')
const { engToRaw, encodeWords, assertDriverRawRange } = await import('@/server/services/workshop/dcw/drivers/shared')
const { getDaqController } = await import('@/server/services/workshop/daq/daq-controller')

test('S11:未知驱动保留原名并标记 unknown,绝不降级 mock', () => {
  const unknown = migrateDriverKind('definitely-not-a-driver')
  assert.equal(unknown.kind, 'definitely-not-a-driver')
  assert.equal(unknown.unknown, true)
  assert.notEqual(unknown.kind, 'mock')

  const alias = migrateDriverKind('modbus')
  assert.equal(alias.kind, 'modbus-tcp')
  assert.equal(alias.unknown, undefined)
})

test('S12:未来时间戳判 future;过去超窗判 out-of-window;正常判 ok', () => {
  const now = 1_000_000_000_000
  const window = ingestBackfillWindowMs({})
  const skew = ingestFutureSkewMs({})
  assert.equal(ingestTimeVerdict(now + skew + 1, now, window, skew), 'future')
  assert.equal(ingestTimeVerdict(now - window - 1, now, window, skew), 'out-of-window')
  assert.equal(ingestTimeVerdict(now - 1000, now, window, skew), 'ok')
  assert.equal(ingestTimeVerdict(now + skew - 1, now, window, skew), 'ok')
})

test('S15:工程量换算越出原始量程 → 抛错(不再静默回绕)', () => {
  const input = {
    eng: 200,
    tolerance: 1,
    domain: { min: 0, max: 100 },
    driverConfig: { rawMin: 0, rawMax: 32767, engMin: 0, engMax: 100, dataType: 'int16' },
  }
  assert.throws(() => engToRaw(200, input as never), /超出驱动原始量程/)
  assert.equal(engToRaw(50, input as never), 16383.5)
})

test('S15:int16/uint16 越界编码 → 抛错', () => {
  assert.throws(() => encodeWords(65534, 'int16', 'big'), /超出 int16/)
  assert.throws(() => encodeWords(-1, 'uint16', 'big'), /超出 uint16/)
  assert.deepEqual(encodeWords(100, 'int16', 'big'), [100])
})

test('S15:配置期原始量程必须可被 dataType 表示', () => {
  assert.throws(() => assertDriverRawRange('modbus-tcp', { rawMin: 0, rawMax: 70000, dataType: 'uint16' }), /超出 uint16/)
  assert.throws(() => assertDriverRawRange('modbus-rtu', { rawMin: 10, rawMax: 10, dataType: 'float32' }), /rawMin 必须小于 rawMax/)
  assert.doesNotThrow(() => assertDriverRawRange('modbus-tcp', { rawMin: 0, rawMax: 32767, dataType: 'int16' }))
  assert.doesNotThrow(() => assertDriverRawRange('opcua', { rawMin: 0, rawMax: 999999, dataType: 'uint16' }))
})

test('S10:基础设施降级时 startAll 拒绝开采', () => {
  const g = globalThis as typeof globalThis & { __daqInfraStatus?: () => { degraded: boolean, warning?: string } }
  g.__daqInfraStatus = () => ({ degraded: true, warning: 'test-degraded' })
  try {
    assert.throws(() => getDaqController().startAll(), /降级/)
  }
  finally {
    delete g.__daqInfraStatus
  }
})
