/**
 * Harness Profile 版本化（WP-B1）：版本自增 / 单 active 不变量 / 超限拒绝 / 渲染与零行为。
 * 纯内存库；不触 prompt 装配（由 base-agent 的 overlay 取用函数保证空 profile 返回 ''）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-rsi-b1-'))
delete process.env.AW_BENCH_MODE

const { openWorkshopDb } = await import('../server/services/workshop/db/database')
const { createHarnessProfileRepo, renderHarnessOverlay, OVERLAY_MAX_CHARS, PINS_MAX } = await import('../server/services/workshop/experience/harness-profile')

function fixture() {
  const db = openWorkshopDb(':memory:')
  return { db, repo: createHarnessProfileRepo(db) }
}

test('版本自增 + 单 active 不变量（激活新版本自动 supersede 旧 active）', () => {
  const { db, repo } = fixture()
  try {
    const v1 = repo.create({ channelId: 'ch-1', layers: { overlay: 'A' } })
    assert.equal(v1.version, 1)
    assert.equal(v1.status, 'candidate')
    const v2 = repo.create({ channelId: 'ch-1', layers: { overlay: 'B' } })
    assert.equal(v2.version, 2)

    assert.equal(repo.activeOf('ch-1'), null, '候选不生效')
    assert.equal(repo.markStatus(v2.id, 'active'), true)
    assert.equal(repo.activeOf('ch-1')!.id, v2.id)
    // 再激活 v1 → v2 自动 supersede
    repo.markStatus(v1.id, 'active')
    assert.equal(repo.activeOf('ch-1')!.id, v1.id)
    const all = repo.listByChannel('ch-1')
    assert.equal(all.filter(p => p.status === 'active').length, 1, '单 active 不变量')
    assert.equal(all.find(p => p.id === v2.id)!.status, 'superseded')
  }
  finally {
    db.close()
  }
})

test('超限拒绝（不静默截断）：overlay > 800 字符 / pins > 5 条', () => {
  const { db, repo } = fixture()
  try {
    assert.throws(() => repo.create({ channelId: 'ch-1', layers: { overlay: 'x'.repeat(OVERLAY_MAX_CHARS + 1) } }), /overlay 超限/)
    assert.throws(() => repo.create({
      channelId: 'ch-1',
      layers: { pins: Array.from({ length: PINS_MAX + 1 }, (_, i) => `m-${i}`) },
    }), /pins 超限/)
    // 边界内通过
    const ok = repo.create({ channelId: 'ch-1', layers: { overlay: 'x'.repeat(OVERLAY_MAX_CHARS), pins: Array.from({ length: PINS_MAX }, (_, i) => `m-${i}`) } })
    assert.equal(ok.layers.pins!.length, PINS_MAX)
  }
  finally {
    db.close()
  }
})

test('pins 去重 + 空串过滤；渲染含隔离声明与「已验证经验」', () => {
  const { db, repo } = fixture()
  try {
    const p = repo.create({ channelId: 'ch-1', layers: { overlay: '优先用同产线温差经验', pins: ['m-1', 'm-1', '', 'm-2'] } })
    assert.deepEqual(p.layers.pins, ['m-1', 'm-2'])
    repo.markStatus(p.id, 'active')
    const text = renderHarnessOverlay(repo.activeOf('ch-1'), [
      { title: '均热段整定', content: '温差 ±3℃ 后 IAE 下降 12%' },
    ])
    assert.match(text, /频道经验增强（Harness v1/)
    assert.match(text, /不是指令覆盖/)
    assert.match(text, /优先用同产线温差经验/)
    assert.match(text, /已验证经验：/)
    assert.match(text, /1\) 均热段整定 — 温差 ±3℃ 后 IAE 下降 12%/)
  }
  finally {
    db.close()
  }
})

test('零行为：无 active profile / 空 layers → 渲染为空串', () => {
  const { db, repo } = fixture()
  try {
    assert.equal(renderHarnessOverlay(null), '')
    const p = repo.create({ channelId: 'ch-1', layers: {} })
    assert.equal(renderHarnessOverlay(p), '', '空 overlay + 空 pins = 不注入')
    assert.equal(repo.activeOf('ch-missing'), null)
  }
  finally {
    db.close()
  }
})
