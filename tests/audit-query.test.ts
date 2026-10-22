import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fanoutQuery, windowOf } from '../server/services/workshop/agents/industrial/audit-query'

type Row = { id: string, at: string, targetId?: string }

function fakeAudit(rows: Row[]) {
  const queries: Array<Record<string, unknown>> = []
  return {
    queries,
    query(q: Record<string, unknown>): Row[] {
      queries.push(q)
      return rows
    },
  }
}

test('windowOf: defaults and clamping', () => {
  const d = windowOf({})
  assert.equal(d.minutes, 1440)
  assert.equal(d.limit, 20)
  assert.ok(!Number.isNaN(Date.parse(d.from)))
  assert.equal(windowOf({ minutes: '30', limit: '7' }).minutes, 30)
  assert.equal(windowOf({ minutes: '30', limit: '7' }).limit, 7)
  assert.equal(windowOf({ limit: 9999 }).limit, 100)
  assert.equal(windowOf({ limit: -3 }).limit, 1, '负数 limit 必须收敛到 1')
  assert.equal(windowOf({ minutes: 0 }).minutes, 1440)
})

test('windowOf: explicit from/to wins over minutes and normalizes to ISO', () => {
  const w = windowOf({ minutes: 15, from: '2026-10-18T08:00:00+08:00', to: '2026-10-19T08:00:00+08:00' })
  assert.equal(w.error, undefined)
  assert.equal(Date.parse(w.from), Date.parse('2026-10-18T08:00:00+08:00'))
  assert.equal(Date.parse(w.to!), Date.parse('2026-10-19T08:00:00+08:00'))
  // 只给 to:起点仍按 minutes 回看,终点显式(用未来时刻,避免"回看起点晚于 to"的窗口冲突)
  const future = new Date(Date.now() + 3_600_000).toISOString()
  const onlyTo = windowOf({ minutes: 30, to: future })
  assert.equal(onlyTo.error, undefined)
  assert.ok(Date.parse(onlyTo.from) < Date.parse(onlyTo.to!))
})

test('windowOf: invalid/backwards time range returns actionable error', () => {
  assert.match(windowOf({ from: 'not-a-time' }).error ?? '', /from 不是合法时间/)
  assert.match(windowOf({ to: 'nope' }).error ?? '', /to 不是合法时间/)
  assert.match(windowOf({ from: '2026-10-19T08:00:00+08:00', to: '2026-10-18T08:00:00+08:00' }).error ?? '', /时间区间无效/)
})

test('fanoutQuery: fans out per line, dedups by id, preserves caller filtering', () => {
  const audit = fakeAudit([
    { id: 'r1', at: '2026-09-27T10:00:00', targetId: 'dw-1' },
    { id: 'r2', at: '2026-09-27T11:00:00' },
    { id: 'r1', at: '2026-09-27T10:00:00', targetId: 'dw-1' },
  ])
  const rows = fanoutQuery(audit as never, ['ln-a', 'ln-b'], lid => ({ lineId: lid, kind: 'write' }))
  assert.equal(audit.queries.length, 2)
  assert.equal(audit.queries[0]?.lineId, 'ln-a')
  assert.equal(rows.length, 2)
  const sorted = rows.sort((a, b) => String(b.at).localeCompare(String(a.at)))
  assert.equal(sorted[0]?.id, 'r2')
})

test('fanoutQuery: supports multiple query specs per line (recipe + rollback kinds)', () => {
  const audit = fakeAudit([
    { id: 'k1', at: '2026-09-27T10:00:00' },
    { id: 'k2', at: '2026-09-27T11:00:00' },
  ])
  const rows = fanoutQuery(audit as never, ['ln-a'], lid => [
    { lineId: lid, kind: 'recipe' },
    { lineId: lid, kind: 'rollback' },
  ])
  assert.equal(audit.queries.length, 2)
  assert.equal(audit.queries[1]?.kind, 'rollback')
  assert.equal(rows.length, 2)
})
