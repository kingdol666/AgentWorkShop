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
const { verifyInterventionEvent, verifyPendingInterventions, verifyAllPending, listBlindVerifications } = await import('../server/services/workshop/verify/blind-verifier')

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
