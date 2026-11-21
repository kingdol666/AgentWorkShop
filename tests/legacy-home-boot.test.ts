import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-legacy-home-'))

const { initWorkshopDb } = await import('../server/services/workshop/db/database/open')

test('legacy pre-ledger home with old chat_deliveries boots: columns backfilled before SCHEMA_SQL indexes', () => {
  const db = new DatabaseSync(':memory:')
  // 0.7-era chat_deliveries shape (observed on a real 2026-11-02 home): no
  // attempts/next_retry_at/claimed_at columns. SCHEMA_SQL's
  // idx_chat_deliveries_retry(status, next_retry_at) must not run before the
  // columns are backfilled, or boot crashes with "no such column: next_retry_at".
  db.exec(`CREATE TABLE chat_deliveries (
    id TEXT PRIMARY KEY,
    chat_message_id TEXT,
    channel_id TEXT,
    target_agent_id TEXT,
    mailbox_message_id TEXT,
    status TEXT,
    error TEXT,
    created_at TEXT,
    updated_at TEXT
  )`)
  db.exec(`INSERT INTO chat_deliveries (id, chat_message_id, channel_id, target_agent_id, status, created_at, updated_at)
    VALUES ('d1', 'm1', 'ch', 'agent-1', 'pending', '2026-11-02T00:00:00Z', '2026-11-02T00:00:00Z')`)

  assert.doesNotThrow(() => initWorkshopDb(db))

  const cols = db.prepare('PRAGMA table_info(chat_deliveries)').all().map(r => r.name)
  for (const c of ['attempts', 'next_retry_at', 'claimed_at']) assert.ok(cols.includes(c), `column ${c} must be backfilled`)
  // legacy row survives with the new-column defaults
  const row = db.prepare('SELECT attempts, next_retry_at, claimed_at FROM chat_deliveries WHERE id = ?').get('d1') as Record<string, unknown>
  assert.equal(row.attempts, 0)
  assert.equal(row.next_retry_at, null)
  // the crash-candidate index now exists
  const idx = db.prepare('SELECT name FROM sqlite_master WHERE type = \'index\' AND name = \'idx_chat_deliveries_retry\'').get()
  assert.ok(idx, 'idx_chat_deliveries_retry must exist after boot')
  // schema contract is recorded on the legacy home
  const ledger = db.prepare('SELECT MAX(version) AS v FROM aw_migration_ledger WHERE name = \'schema-contract\'').get() as { v?: number }
  assert.equal(Number(ledger.v), 9)
})
