import { test } from 'node:test'
import assert from 'node:assert/strict'

const { normalizeExecutionMode, resolveExecutionModeChange, effectiveHitlRequired, executionModeOfChannel } = await import('../server/services/workshop/agents/execution-mode')

// 三模式执行(observe/manual/auto)语义单一声明源 —— 计划 docs/plans/2026-10-28-execution-modes-plan.md M1。
// 铁律:频道层是叠加钳位,中性缺省恒 auto(升级零行为变化,fail-safe 由线级缺省 manual 与首绑恒 manual 承担);
// 任一层 manual 即挂审批(三层取最严);收紧方向自由、放开方向必须显式 confirm。

test('execution-mode: normalize 合法值原样,非法/空一律 auto(中性缺省)', () => {
  assert.equal(normalizeExecutionMode('observe'), 'observe')
  assert.equal(normalizeExecutionMode('manual'), 'manual')
  assert.equal(normalizeExecutionMode('auto'), 'auto')
  assert.equal(normalizeExecutionMode(undefined), 'auto')
  assert.equal(normalizeExecutionMode(null), 'auto')
  assert.equal(normalizeExecutionMode(''), 'auto')
  assert.equal(normalizeExecutionMode('MANUAL'), 'auto')
  assert.equal(normalizeExecutionMode(42), 'auto')
})

test('execution-mode: executionModeOfChannel 运行时不可用 → auto(中性,零行为变化)', () => {
  // 单测环境无 AML runtime:profile 读取内部 catch 回 legacy → 归一 auto
  assert.equal(executionModeOfChannel('ch-nonexistent'), 'auto')
})

// effectiveHitlRequired:三层(频道/产线/绑定)任一 manual 即挂审批;全 auto 才免批
test('execution-mode: 任一层 manual 即挂审批(3×2×2 组合)', () => {
  for (const channel of ['observe', 'manual', 'auto'] as const) {
    for (const line of ['auto', 'manual'] as const) {
      for (const binding of ['auto', 'manual'] as const) {
        const expected = channel === 'manual' || line === 'manual' || binding === 'manual'
        assert.equal(effectiveHitlRequired(channel, line, binding), expected, `${channel}/${line}/${binding}`)
      }
    }
  }
})

test('execution-mode: 频道 auto(中性缺省)与 observe 的差异 —— 不额外收紧/由写守卫短路', () => {
  assert.equal(effectiveHitlRequired('auto', 'auto', 'auto'), false)
  assert.equal(effectiveHitlRequired('observe', 'auto', 'auto'), false) // observe 不进本函数语义,写守卫另行拒写
})

// 切换判定:同名 noop;收紧自由;放开必须显式 confirm:true(严格布尔)
test('execution-mode: 同名 mode → noop', () => {
  assert.deepEqual(resolveExecutionModeChange('manual', 'manual', undefined), { ok: true, noop: true })
  assert.deepEqual(resolveExecutionModeChange('observe', 'observe', true), { ok: true, noop: true })
  assert.deepEqual(resolveExecutionModeChange('auto', 'auto', undefined), { ok: true, noop: true })
})

test('execution-mode: 收紧方向(auto→manual、auto/manual→observe)免 confirm', () => {
  assert.deepEqual(resolveExecutionModeChange('auto', 'manual', undefined), { ok: true })
  assert.deepEqual(resolveExecutionModeChange('auto', 'observe', undefined), { ok: true })
  assert.deepEqual(resolveExecutionModeChange('manual', 'observe', undefined), { ok: true })
})

test('execution-mode: manual→auto 无 confirm → 拒绝(needConfirm)', () => {
  const d = resolveExecutionModeChange('manual', 'auto', undefined)
  assert.equal(d.ok, false)
  assert.equal(d.needConfirm, true)
  assert.ok(d.error && d.error.includes('auto'), '错误文案应说明 auto 风险')
})

test('execution-mode: observe→manual / observe→auto 均为放开,无 confirm → 拒绝', () => {
  for (const target of ['manual', 'auto'] as const) {
    const d = resolveExecutionModeChange('observe', target, undefined)
    assert.equal(d.ok, false, `observe→${target}`)
    assert.equal(d.needConfirm, true, `observe→${target}`)
  }
})

test('execution-mode: 放开方向 confirm=true → 放行;confirm 须严格布尔', () => {
  assert.deepEqual(resolveExecutionModeChange('manual', 'auto', true), { ok: true })
  assert.deepEqual(resolveExecutionModeChange('observe', 'manual', true), { ok: true })
  assert.deepEqual(resolveExecutionModeChange('observe', 'auto', true), { ok: true })
  assert.equal(resolveExecutionModeChange('manual', 'auto', 'true').ok, false)
  assert.equal(resolveExecutionModeChange('manual', 'auto', 1).ok, false)
})

test('execution-mode: execution_mode 列迁移幂等(重复执行不炸,列唯一)', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  const { migrateChannelExecutionModeColumn } = await import('../server/services/workshop/db/database/migrations')
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE aml_channel_profiles (channel_id TEXT PRIMARY KEY, optimization_mode TEXT)')
  migrateChannelExecutionModeColumn(db)
  migrateChannelExecutionModeColumn(db)
  const cols = (db.prepare('PRAGMA table_info(aml_channel_profiles)').all() as Array<{ name: string }>).map(c => c.name)
  assert.equal(cols.filter(c => c === 'execution_mode').length, 1)
})
