/**
 * F7 单测:
 *  - 未开线样本按节点所属产线打标(product/recipe/run 保持 null);
 *  - 导出护栏设置化:缺省 = 原常量,环境覆盖生效,硬上限钳位;
 *  - 未分配产线节点不冒充产线。
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-export-limits-'))

const { tsdbRowOf } = await import('../server/services/workshop/daq/daq-controller/tsdb-row')
const { exportPagesPerNode, exportWindowMaxMs, exportWindowMaxH, DEFAULT_PAGES_PER_NODE, HARD_MAX_PAGES_PER_NODE, DEFAULT_WINDOW_MAX_H } = await import('../server/services/workshop/daq/export-limits')
const { invalidateRuntimeSettingsCache } = await import('../server/services/workshop/settings')

const ENV_PAGES = 'AW_DAQ_EXPORT_PAGESPERNODE'
const ENV_WINDOW = 'AW_DAQ_EXPORT_WINDOWMAXH'

describe('tsdbRowOf(未开线打标)', () => {
  it('未开线:lineId=节点所属产线,product/recipe/run=null', () => {
    const row = tsdbRowOf({ nodeId: 'dn-1', tsMs: 1000, value: 42, state: 'running', nodeLineId: 'ln-1', run: null })
    assert.equal(row.lineId, 'ln-1')
    assert.equal(row.productId, null)
    assert.equal(row.recipeId, null)
    assert.equal(row.runId, null)
  })

  it('活动批次窗口内:四列齐备', () => {
    const row = tsdbRowOf({
      nodeId: 'dn-1',
      tsMs: 1000,
      value: 42,
      state: 'running',
      nodeLineId: 'ln-1',
      run: { lineId: 'ln-1', productId: 'p-1', recipeId: 'rr-1', runId: 'run-1' },
    })
    assert.deepEqual(
      { lineId: row.lineId, productId: row.productId, recipeId: row.recipeId, runId: row.runId },
      { lineId: 'ln-1', productId: 'p-1', recipeId: 'rr-1', runId: 'run-1' },
    )
  })

  it('节点未分配产线 → lineId=null(不冒充)', () => {
    const row = tsdbRowOf({ nodeId: 'dn-1', tsMs: 1000, value: 1, state: 'running', nodeLineId: '', run: null })
    assert.equal(row.lineId, null)
  })
})

describe('export-limits(设置化护栏)', () => {
  before(() => {
    Reflect.deleteProperty(process.env, ENV_PAGES)
    Reflect.deleteProperty(process.env, ENV_WINDOW)
    invalidateRuntimeSettingsCache()
  })

  after(() => {
    Reflect.deleteProperty(process.env, ENV_PAGES)
    Reflect.deleteProperty(process.env, ENV_WINDOW)
    invalidateRuntimeSettingsCache()
  })

  it('缺省值等于原常量(400 页 / 168 小时)', () => {
    assert.equal(exportPagesPerNode(), DEFAULT_PAGES_PER_NODE)
    assert.equal(exportWindowMaxMs(), DEFAULT_WINDOW_MAX_H * 3600_000)
    assert.equal(exportWindowMaxH(), DEFAULT_WINDOW_MAX_H)
  })

  it('环境变量可调升,超过硬上限时钳位', () => {
    process.env[ENV_PAGES] = '800'
    process.env[ENV_WINDOW] = '336'
    invalidateRuntimeSettingsCache()
    assert.equal(exportPagesPerNode(), 800)
    assert.equal(exportWindowMaxH(), 336)

    process.env[ENV_PAGES] = '99999'
    process.env[ENV_WINDOW] = '99999'
    invalidateRuntimeSettingsCache()
    assert.equal(exportPagesPerNode(), HARD_MAX_PAGES_PER_NODE)
    assert.equal(exportWindowMaxH(), 8760)
  })

  it('非法值(0/负/字符串)回落缺省', () => {
    process.env[ENV_PAGES] = 'not-a-number'
    process.env[ENV_WINDOW] = '0'
    invalidateRuntimeSettingsCache()
    assert.equal(exportPagesPerNode(), DEFAULT_PAGES_PER_NODE)
    assert.equal(exportWindowMaxH(), DEFAULT_WINDOW_MAX_H)
  })
})
