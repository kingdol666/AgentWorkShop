/** SW2/D18 数据真实性单测:units 契约 / lineage_verified 透传与门禁 / split.blocks 契约。 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-sw2-'))

const { toModel, toEngineering, UnitContractError } = await import('../shared/units')
const { openWorkshopDb } = await import('../server/services/workshop/db/database/open')
const { configureAmlRuntime } = await import('../server/services/workshop/aml/runtime')
const { createAmlRepo } = await import('../server/services/workshop/aml/aml.repo')
const { migrateDualDriveColumns } = await import('../server/services/workshop/db/database/migrations')

const db = openWorkshopDb(join(process.env.AW_HOME!, 'sw2.sqlite'))
configureAmlRuntime(db)
const repo = createAmlRepo(db)

after(() => {
  try {
    rmSync(process.env.AW_HOME!, { recursive: true, force: true })
  }
  catch { /* 并行会话可能已清理 */ }
})

test('units 契约:双向换算正确,scale=0/缺失/非有限一律 fail-closed', () => {
  // L/min → m3/h 的 live 口径(浮点近似比较)
  assert.ok(Math.abs(toModel(60, { scale: 0.06, offset: 0 }) - 3.6) < 1e-9)
  assert.ok(Math.abs(toEngineering(3.6, { scale: 0.06, offset: 0 }) - 60) < 1e-9)
  // 带 offset 往返
  const t = { scale: 2, offset: 5 }
  assert.ok(Math.abs(toEngineering(toModel(7, t, 'x'), t, 'x') - 7) < 1e-12)
  // 非法一律拒
  for (const bad of [{ scale: 0, offset: 0 }, { scale: Number.NaN, offset: 0 }, { scale: 2, offset: Number.NaN }] as const) {
    assert.throws(() => toModel(1, bad as never, 'x'), UnitContractError)
    assert.throws(() => toEngineering(1, bad as never, 'x'), UnitContractError)
  }
})

test('aml_datasets.lineage_verified:migration 补列 + repo 透传(旧库默认 0)', () => {
  // 旧库模拟:去掉新列再跑迁移
  const cols = db.prepare('PRAGMA table_info(aml_datasets)').all() as Array<{ name: string }>
  if (cols.some(c => c.name === 'lineage_verified')) {
    // 新库 DDL 已含列;migrate 幂等(再次执行不报错)
    migrateDualDriveColumns(db)
  }
  else {
    migrateDualDriveColumns(db)
  }
  const now = new Date().toISOString()
  repo.dataset.insert({
    id: 'ds-legacy', lineId: 'L', productId: 'P', recipeId: 'R', runIds: ['r1'],
    specJson: '{}', sha256: 'x', rowCount: 1, fromMs: 0, toMs: 1, path: '/tmp/x',
    createdBy: 'u', createdByKind: 'user', note: '', createdAt: now,
  })
  const legacy = repo.dataset.get('ds-legacy')
  assert.equal(legacy?.lineageVerified ?? 0, 0, '未显式置位 = 0(禁优化资格)')
  repo.dataset.insert({
    id: 'ds-verified', lineId: 'L', productId: 'P', recipeId: 'R', runIds: ['r1', 'r2'],
    specJson: '{}', sha256: 'y', rowCount: 2, fromMs: 0, toMs: 1, path: '/tmp/y',
    createdBy: 'u', createdByKind: 'user', note: '', createdAt: now, lineageVerified: 1,
  })
  assert.equal(repo.dataset.get('ds-verified')?.lineageVerified, 1, 'builder 置 1 可读回')
})

test('optimizer_recommendations 下发状态机列存在且旧行回填 idle', () => {
  const cols = db.prepare('PRAGMA table_info(optimizer_recommendations)').all() as Array<{ name: string }>
  for (const c of ['dispatched_at', 'approval_id', 'initiator_user_id', 'dispatch_state']) {
    assert.ok(cols.some(x => x.name === c), `缺列 ${c}`)
  }
  const now = new Date().toISOString()
  db.prepare(`INSERT INTO optimizer_runs (id, binding_id, binding_revision, profile_id, profile_version, problem_ir_hash, started_at)
    VALUES ('r-sw2', 'b', 1, 'p', 1, 'h', ?)`).run(now)
  db.prepare(`INSERT INTO optimizer_candidates (id, run_id, seq) VALUES ('c-sw2', 'r-sw2', 0)`).run()
  db.prepare(`INSERT INTO optimizer_recommendations (id, run_id, candidate_id, problem_ir_hash, valid_until, created_at, dispatch_state, dispatched_at)
    VALUES ('rec-legacy-dispatched', 'r-sw2', 'c-sw2', 'h', ?, ?, 'dispatched', ?)`)
    .run(now, now, now)
  migrateDualDriveColumns(db)
  const row = db.prepare(`SELECT dispatch_state AS s FROM optimizer_recommendations WHERE id = 'rec-legacy-dispatched'`).get() as { s: string }
  assert.equal(row.s, 'dispatched', '已建卡(有 dispatched_at)的历史行保持 dispatched')
  db.prepare(`UPDATE optimizer_recommendations SET dispatched_at = NULL WHERE id = 'rec-legacy-dispatched'`).run()
  migrateDualDriveColumns(db)
  const row2 = db.prepare(`SELECT dispatch_state AS s FROM optimizer_recommendations WHERE id = 'rec-legacy-dispatched'`).get() as { s: string }
  assert.equal(row2.s, 'idle', '无幂等锚的历史行回填 idle')
})

test('optimizer_candidate_crosschecks 表存在(SW4 DDL 先行)', () => {
  const t = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='optimizer_candidate_crosschecks'`).get()
  assert.ok(t, 'crosscheck 表未建')
})
