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
  assert.equal(windowOf({ minutes: 0 }).minutes, 1440)
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
