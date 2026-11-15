/**
 * DAQ 节点元数据校验门(2026-11-15 测评 P1-7 回归):
 * create/patch 都必须按**合并后的有效值**校验,拒绝 min>=max、warn 带反转、
 * warn 越出量程、decimals 非整数、unit 空白等带病元数据。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-daq-node-metadata-'))
delete process.env.DAQ_TSDB_URL

const { getDaqController } = await import('../server/services/workshop/daq/daq-controller')

const ctrl = getDaqController()

test('合法元数据可创建并读取', () => {
  const node = ctrl.create({
    templateRef: 'daq-temp-tc',
    name: 'metadata-ok',
    driver: 'mock',
    unit: '℃',
    decimals: 2,
    min: 0,
    max: 100,
    warnLow: 10,
    warnHigh: 90,
    semantics: '熔体温度',
  })
  assert.equal(node.unit, '℃')
  assert.equal(node.min, 0)
  assert.equal(node.max, 100)
  assert.equal(node.warnLow, 10)
  assert.equal(node.warnHigh, 90)
})

test('create 拒绝 min >= max', () => {
  assert.throws(() => ctrl.create({ templateRef: 'daq-temp-tc', driver: 'mock', min: 100, max: 100 }), /量程非法/)
})

test('create 拒绝 warnLow > warnHigh', () => {
  assert.throws(() => ctrl.create({ templateRef: 'daq-temp-tc', driver: 'mock', min: 0, max: 100, warnLow: 80, warnHigh: 20 }), /预警带非法/)
})

test('create 拒绝 warn 越出量程', () => {
  assert.throws(() => ctrl.create({ templateRef: 'daq-temp-tc', driver: 'mock', min: 0, max: 100, warnLow: -5 }), /不能低于量程下限/)
  assert.throws(() => ctrl.create({ templateRef: 'daq-temp-tc', driver: 'mock', min: 0, max: 100, warnHigh: 120 }), /不能高于量程上限/)
})

test('create 拒绝非法 decimals / 空白 unit', () => {
  assert.throws(() => ctrl.create({ templateRef: 'daq-temp-tc', driver: 'mock', decimals: 2.5 }), /小数位/)
  assert.throws(() => ctrl.create({ templateRef: 'daq-temp-tc', driver: 'mock', unit: '   ' }), /单位不能为空/)
})

test('patch 按合并后的有效值校验(只改 min 也不能越过 max)', () => {
  const node = ctrl.create({ templateRef: 'daq-temp-tc', driver: 'mock', min: 0, max: 100 })
  assert.throws(() => ctrl.patch(node.id, { min: 150 }), /量程非法/)
  // 同一次 patch 把 min 上移时同步调整 warnLow,则合法
  const updated = ctrl.patch(node.id, { min: 10, max: 200, warnLow: 20 })
  assert.equal(updated.min, 10)
  assert.equal(updated.max, 200)
  assert.equal(updated.warnLow, 20)
})

test('patch 拒绝把预警带改到量程外', () => {
  const node = ctrl.create({ templateRef: 'daq-temp-tc', driver: 'mock', min: 0, max: 100 })
  assert.throws(() => ctrl.patch(node.id, { warnHigh: 101 }), /不能高于量程上限/)
})
