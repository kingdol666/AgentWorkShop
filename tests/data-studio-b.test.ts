/**
 * data-studio Phase B 单测:eda_charts B4 可见性矩阵。
 * golden 的相位数学走真实环境 e2e(需要 tsdb/节点/批次实料)。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-studio-b-test-'))

const { createChart, chartById, listChartsFor, updateChart, deleteChart } = await import('../server/services/workshop/eda/chart-repo')
const { mirrorRunCreated } = await import('../server/services/workshop/eda/eda-run.repo')

const owner = { id: 'u-owner', name: 'owner', role: 'user' }
const other = { id: 'u-other', name: 'other', role: 'user' }
const admin = { id: 'u-admin', name: 'admin', role: 'admin' }

describe('eda_charts B4 可见性', () => {
  let privateId = ''
  let lineChartId = ''

  it('创建:private 合法;line 无 line_id 拒;非法 viz_type 拒;public 拒', () => {
    const c = createChart(owner, { title: '私图', vizType: 'trend', encoding: { y: ['dn-1'] } })
    privateId = c.id
    assert.equal(c.visibility, 'private')
    assert.throws(() => createChart(owner, { title: 'x', vizType: 'trend', visibility: 'line' }), /line_id/)
    assert.throws(() => createChart(owner, { title: 'x', vizType: 'wordcloud' }), /viz_type/)
    assert.throws(() => createChart(owner, { title: 'x', vizType: 'trend', visibility: 'public' }), /visibility/)
  })

  it('读:private 仅 owner/admin;他人 404 语义(null);列表谓词不丢 owner 无产线私图', () => {
    assert.ok(chartById(owner, privateId))
    assert.ok(chartById(admin, privateId))
    assert.equal(chartById(other, privateId), null)
    const mine = listChartsFor(owner, { mine: true })
    assert.ok(mine.some(c => c.id === privateId))
    const otherAll = listChartsFor(other)
    assert.ok(!otherAll.some(c => c.id === privateId))
  })

  it('line 图:无授权者不可见;写仅 owner/admin;version 自增', () => {
    const c = createChart(owner, { title: '线图', vizType: 'bar', visibility: 'line', lineId: 'ln-x' })
    lineChartId = c.id
    assert.equal(chartById(owner, lineChartId)?.visibility, 'line')
    assert.equal(chartById(other, lineChartId), null)
    assert.throws(() => updateChart(other, lineChartId, { title: '篡改' }), /仅 owner/)
    const updated = updateChart(owner, lineChartId, { title: '线图2' })
    assert.equal(updated.version, 2)
    assert.equal(updated.title, '线图2')
  })

  it('删除:级联看板关联(此处仅验证删除与再次不可见)', () => {
    mirrorRunCreated({ id: 'rr-b', lineId: 'ln-x', productId: 'pd', recipeId: 'rc', recipeName: 'r', startedAt: new Date().toISOString(), endedAt: null })
    assert.ok(deleteChart(owner, privateId))
    assert.equal(chartById(owner, privateId), null)
    assert.ok(deleteChart(admin, lineChartId))
  })
})
