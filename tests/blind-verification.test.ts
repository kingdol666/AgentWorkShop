/**
 * 独立回读验证器（WP-C1）：match / mismatch / inconclusive + 幂等 + 批量补扫。
 * 纯内存库；探针注入以验证判定语义（生产探针读 dcw 节点实时值）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-rsi-c1-'))
delete process.env.AW_BENCH_MODE

const { openWorkshopDb } = await import('../server/services/workshop/db/database')
const { verifyInterventionEvent, verifyPendingInterventions, verifyAllPending, listBlindVerifications, blindCheckForTask, blindMetricsForTask, selectIndependentReadback } = await import('../server/services/workshop/verify/blind-verifier')

const now = new Date().toISOString()

function fixture() {
  const db = openWorkshopDb(':memory:')
  db.exec('PRAGMA foreign_keys = OFF')
  return db
}

function seedEvent(db: ReturnType<typeof fixture>, id: string, opts: { to?: number, actual?: number, channelId?: string } = {}): void {
  db.prepare(`INSERT INTO intervention_events (id, ts, line_id, node_id, node_name, from_value, to_value, actual_value, ack, path, channel_id, verdict, created_at, updated_at)
    VALUES (?,?, 'line-1','n-1','均热段', 220, ?, ?, 'readback-verified','agent',?, 'pending', ?, ?)`)
    .run(id, now, opts.to ?? 218.5, opts.actual ?? 218.52, opts.channelId ?? 'ch-1', now, now)
}

const probeWith = (actual: number | null) => () => (actual === null
  ? { values: [], detail: '节点无实时值' }
  : { values: [{ nodeId: 'n-1', nodeName: '均热段', expected: 218.5, actual, tol: 0.5, ok: Math.abs(actual - 218.5) <= 0.5 }], detail: `回读 ${actual}` })

test('match：设备回读与指令在容差内', () => {
  const db = fixture()
  try {
    seedEvent(db, 'ie-1')
    const res = verifyInterventionEvent(db, 'ie-1', probeWith(218.52))!
    assert.equal(res.verdict, 'match')
    const board = listBlindVerifications(db, 'ch-1')
    assert.equal(board.length, 1)
    assert.equal(board[0]!.verdict, 'match')
  }
  finally {
    db.close()
  }
})

test('mismatch：设备实际值超差（Agent 自报达标也拦得住）', () => {
  const db = fixture()
  try {
    seedEvent(db, 'ie-2')
    const res = verifyInterventionEvent(db, 'ie-2', probeWith(231))!
    assert.equal(res.verdict, 'mismatch')
    assert.match(res.detail, /回读 231/)
  }
  finally {
    db.close()
  }
})

test('inconclusive ≠ pass：无证据时判 inconclusive，且不落 match', () => {
  const db = fixture()
  try {
    seedEvent(db, 'ie-3')
    const res = verifyInterventionEvent(db, 'ie-3', probeWith(null))!
    assert.equal(res.verdict, 'inconclusive')
    assert.equal(listBlindVerifications(db, 'ch-1').some(r => r.verdict === 'match'), false)
  }
  finally {
    db.close()
  }
})

test('幂等：同 event 重复验证返回既有判定，不新增行', () => {
  const db = fixture()
  try {
    seedEvent(db, 'ie-4')
    const first = verifyInterventionEvent(db, 'ie-4', probeWith(218.5))!
    const second = verifyInterventionEvent(db, 'ie-4', probeWith(999))!
    assert.equal(first.verdict, 'match')
    assert.equal(second.verdict, 'match', '既有判定不被第二次探针改写')
    assert.match(second.detail, /幂等/)
    assert.equal(listBlindVerifications(db, 'ch-1').length, 1)
  }
  finally {
    db.close()
  }
})

test('批量补扫：按频道计数 + 全库补扫跳过已验证', () => {
  const db = fixture()
  try {
    seedEvent(db, 'ie-5', { channelId: 'ch-1' })
    seedEvent(db, 'ie-6', { channelId: 'ch-1' })
    seedEvent(db, 'ie-7', { channelId: 'ch-2' })
    const probe = probeWith(218.5)
    const c1 = verifyPendingInterventions(db, 'ch-1', { probe })
    assert.deepEqual(c1, { match: 2, mismatch: 0, inconclusive: 0, total: 2 })
    const all = verifyAllPending(db, { probe })
    assert.deepEqual(all, { match: 1, mismatch: 0, inconclusive: 0, total: 1 }, '仅剩下 ch-2 一条')
    assert.equal(verifyAllPending(db, { probe }).total, 0, '再扫无新项')
  }
  finally {
    db.close()
  }
})

test('不存在的台账：返回 null 而非抛错', () => {
  const db = fixture()
  try {
    assert.equal(verifyInterventionEvent(db, 'missing'), null)
  }
  finally {
    db.close()
  }
})

// ===== WP-C1 → L1/C4 接线：任务归属 / 判定 / 指标 =====

test('任务归属：验证落 task_id；定时器先验后任务终态补归属（不覆盖已有值）', () => {
  const db = fixture()
  try {
    seedEvent(db, 'ie-t1')
    // 定时器先跑（无任务归属）
    verifyInterventionEvent(db, 'ie-t1', probeWith(218.5))
    // 任务终态补扫带 taskId（sinceIso 覆盖定时器已验行）→ 补归属
    verifyPendingInterventions(db, 'ch-1', { probe: probeWith(218.5), taskId: 't-1', sinceIso: new Date(Date.now() - 3600_000).toISOString() })
    const row = db.prepare('SELECT task_id AS taskId FROM blind_verifications WHERE event_id = ?').get('ie-t1') as { taskId: string }
    assert.equal(row.taskId, 't-1')

    seedEvent(db, 'ie-t2')
    verifyInterventionEvent(db, 'ie-t2', probeWith(218.5), 't-2')
    assert.equal((db.prepare('SELECT task_id AS taskId FROM blind_verifications WHERE event_id = ?').get('ie-t2') as { taskId: string }).taskId, 't-2')
  }
  finally {
    db.close()
  }
})

test('L1 判定：无记录 null；全 match 通过；mismatch/inconclusive 一律阻断（fail-closed）', () => {
  const db = fixture()
  try {
    assert.equal(blindCheckForTask(db, 't-none'), null, '没有设备写验证的任务不虚构 check')

    seedEvent(db, 'ie-t3')
    verifyInterventionEvent(db, 'ie-t3', probeWith(218.5), 't-ok')
    const ok = blindCheckForTask(db, 't-ok')!
    assert.equal(ok.pass, true)
    assert.match(ok.detail, /全部 match/)

    seedEvent(db, 'ie-t4')
    verifyInterventionEvent(db, 'ie-t4', probeWith(231), 't-bad')
    const bad = blindCheckForTask(db, 't-bad')!
    assert.equal(bad.pass, false)
    assert.match(bad.detail, /mismatch/)

    seedEvent(db, 'ie-t5')
    verifyInterventionEvent(db, 'ie-t5', probeWith(null), 't-inc')
    const inc = blindCheckForTask(db, 't-inc')!
    assert.equal(inc.pass, false, 'inconclusive ≠ pass')
    assert.match(inc.detail, /inconclusive/)
  }
  finally {
    db.close()
  }
})

test('C4 指标源：从 probe_json 取节点 id/名称 → 实际回读值（非自述）', () => {
  const db = fixture()
  try {
    seedEvent(db, 'ie-t6')
    verifyInterventionEvent(db, 'ie-t6', probeWith(218.52), 't-metrics')
    const metrics = blindMetricsForTask(db, 't-metrics')
    assert.equal(metrics['n-1'], 218.52)
    assert.equal(metrics['均热段'], 218.52)
    assert.deepEqual(blindMetricsForTask(db, 't-none'), {}, '无记录 → 空指标（metric 判据仍 fail-closed）')
  }
  finally {
    db.close()
  }
})

test('故障注入：探针抛错不阻断批量，且不落任何判定', () => {
  const db = fixture()
  try {
    seedEvent(db, 'ie-fault')
    const counts = verifyPendingInterventions(db, 'ch-1', {
      probe: () => {
        throw new Error('probe exploded')
      },
    })
    assert.deepEqual(counts, { match: 0, mismatch: 0, inconclusive: 0, total: 0 })
    assert.equal(listBlindVerifications(db, 'ch-1').length, 0)
    assert.equal(blindCheckForTask(db, 't-fault'), null)
  }
  finally {
    db.close()
  }
})

test('迁移幂等/升级：旧表缺 task_id → 补列且不丢行', async () => {
  const db = fixture()
  try {
    const { migrateBlindVerifications } = await import('../server/services/workshop/db/database/migrations-blind-verification')
    db.exec('DROP TABLE blind_verifications')
    db.exec(`CREATE TABLE blind_verifications (
      id TEXT PRIMARY KEY, event_id TEXT NOT NULL UNIQUE, channel_id TEXT NOT NULL DEFAULT '',
      line_id TEXT NOT NULL DEFAULT '', verdict TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '',
      probe_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL)`)
    db.prepare(`INSERT INTO blind_verifications (id, event_id, channel_id, line_id, verdict, detail, probe_json, created_at)
      VALUES ('legacy-bv','ie-legacy','ch-1','line-1','match','旧行','{}',?)`).run(now)
    migrateBlindVerifications(db)
    migrateBlindVerifications(db)
    const cols = db.prepare('PRAGMA table_info(blind_verifications)').all() as Array<{ name: string }>
    assert.ok(cols.some(c => c.name === 'task_id'))
    const row = db.prepare(`SELECT task_id AS taskId FROM blind_verifications WHERE id = 'legacy-bv'`).get() as { taskId: string }
    assert.equal(row.taskId, '', '旧行按默认值解释')
  }
  finally {
    db.close()
  }
})

// ── 独立回读语义（2026-11-13 审计修复）：write 的 ACK 回执不是独立证据 ──
test('独立回读：fresh readValue 才算证据，缺失/过期一律 inconclusive 理由', () => {
  const nowMs = Date.parse('2026-11-13T10:00:00.000Z')
  const fresh = selectIndependentReadback({ readValue: 218.5, lastReadAt: '2026-11-13T09:59:50.000Z' }, nowMs, 30_000)
  assert.deepEqual(fresh, { value: 218.5 })

  const missing = selectIndependentReadback({ readValue: null, lastReadAt: '2026-11-13T09:59:50.000Z' }, nowMs, 30_000)
  assert.ok('reason' in missing && /无独立设备读数/.test(missing.reason))

  const noStamp = selectIndependentReadback({ readValue: 218.5, lastReadAt: null }, nowMs, 30_000)
  assert.ok('reason' in noStamp && /缺少时间戳/.test(noStamp.reason))

  const stale = selectIndependentReadback({ readValue: 218.5, lastReadAt: '2026-11-13T09:58:00.000Z' }, nowMs, 30_000)
  assert.ok('reason' in stale && /已过期/.test(stale.reason))
})
