/**
 * 迁移契约与表重建恢复性:
 *  1. SCHEMA_SQL 契约按版本记录 —— 存量库(旧版本号)不得因新契约哈希拒绝启动;
 *  2. 同版本内 SQL 漂移仍然 fail-closed;
 *  3. 旧 channels 表缺 channel_mode 时由增量迁移补齐;
 *  4. 表重建 DDL 全程事务化 —— 中途失败整体回滚,不留半迁移库。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-migration-contract-'))
delete process.env.DAQ_TSDB_URL

const { DatabaseSync } = await import('node:sqlite')
const { openWorkshopDb, initWorkshopDb } = await import('../server/services/workshop/db/database/open')
const { fingerprintMigration } = await import('../server/services/workshop/db/database/migration-ledger')
const { migrateDropOwnerFks } = await import('../server/services/workshop/db/database/migrations')
const { SCHEMA_SQL } = await import('../server/services/workshop/db/database/schema')

type Db = InstanceType<typeof DatabaseSync>

const CONTRACT_VERSION = 2

/** 语句逐条执行(不用 exec:与生产写入走同一参数化入口)。 */
function run(db: Db, sql: string, ...params: unknown[]): void {
  db.prepare(sql).run(...(params as never[]))
}

function legacyLedger(db: Db): void {
  run(db, 'DELETE FROM aw_migration_ledger WHERE version = ?', CONTRACT_VERSION)
  run(db, 'INSERT INTO aw_migration_ledger(version, name, fingerprint, applied_at) VALUES (1, ?, ?, ?)',
    'schema-contract', 'legacy-contract-hash', new Date().toISOString())
}

function ledgerRow(db: Db, version: number) {
  return db.prepare('SELECT version, fingerprint FROM aw_migration_ledger WHERE version = ?').get(version) as { version: number, fingerprint: string } | undefined
}

test('a database created before the contract bump still boots and records the current version', () => {
  const db = openWorkshopDb(':memory:')
  const current = ledgerRow(db, CONTRACT_VERSION)
  assert.equal(current?.fingerprint, fingerprintMigration(SCHEMA_SQL))

  // 模拟升级前创建的库:只有 v1 记录,且 v1 哈希属于旧 SCHEMA_SQL
  legacyLedger(db)
  assert.equal(ledgerRow(db, CONTRACT_VERSION), undefined)
  assert.doesNotThrow(() => initWorkshopDb(db))
  assert.equal(ledgerRow(db, CONTRACT_VERSION)?.fingerprint, fingerprintMigration(SCHEMA_SQL))
  db.close()
})

test('schema drift inside the current contract version still fails closed', () => {
  const db = openWorkshopDb(':memory:')
  run(db, 'UPDATE aw_migration_ledger SET fingerprint = ? WHERE version = ?', 'drifted-hash', CONTRACT_VERSION)
  assert.throws(() => initWorkshopDb(db), /migration fingerprint drift/)
  db.close()
})

test('legacy channels table without channel_mode is upgraded in place', () => {
  const db = openWorkshopDb(':memory:')
  run(db, 'ALTER TABLE channels DROP COLUMN channel_mode')
  const colsBefore = db.prepare('PRAGMA table_info(channels)').all() as Array<{ name: string }>
  assert.equal(colsBefore.some(c => c.name === 'channel_mode'), false)

  legacyLedger(db)
  assert.doesNotThrow(() => initWorkshopDb(db))
  const colsAfter = db.prepare('PRAGMA table_info(channels)').all() as Array<{ name: string }>
  assert.equal(colsAfter.some(c => c.name === 'channel_mode'), true)
  db.close()
})

test('a failing table rebuild rolls back every prior rebuild and keeps the old data', () => {
  const db = new DatabaseSync(':memory:')
  run(db, 'CREATE TABLE users (id TEXT PRIMARY KEY)')
  run(db, 'CREATE TABLE workspaces (id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL, created_at TEXT NOT NULL)')
  run(db, 'CREATE TABLE channels (id TEXT PRIMARY KEY, owner_user_id TEXT REFERENCES users(id), name TEXT NOT NULL)')
  run(db, 'CREATE TABLE agents (id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL)')
  run(db, 'CREATE TABLE teams (id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL)')
  run(db, 'INSERT INTO users(id) VALUES (?)', 'u1')
  run(db, 'INSERT INTO workspaces(id, owner_user_id, name, created_at) VALUES (?, ?, ?, ?)', 'w1', 'u1', 'legacy workspace', '2026-01-01')
  run(db, 'INSERT INTO channels(id, owner_user_id, name) VALUES (?, ?, ?)', 'c1', 'u1', 'legacy channel')
  run(db, 'INSERT INTO agents(id, owner_user_id, name) VALUES (?, ?, ?)', 'a1', 'u1', 'legacy agent')
  run(db, 'INSERT INTO teams(id, owner_user_id, name) VALUES (?, ?, ?)', 't1', 'u1', 'legacy team')
  // 预先占用 channels_new,让重建在 workspaces 之后、channels 阶段失败(注入故障)
  run(db, 'CREATE TABLE channels_new (planted TEXT)')

  assert.throws(() => migrateDropOwnerFks(db), /already exists/)

  // 事务回滚:workspaces 仍是带 FK 的旧表,数据完好;没有半成品 workspaces_new
  const workspaceFks = db.prepare('PRAGMA foreign_key_list(workspaces)').all() as Array<{ table: string }>
  assert.equal(workspaceFks.some(fk => fk.table === 'users'), true)
  const workspace = db.prepare('SELECT name FROM workspaces WHERE id = ?').get('w1') as { name?: string } | undefined
  assert.equal(workspace?.name, 'legacy workspace')
  const leftovers = db.prepare('SELECT name FROM sqlite_master WHERE type = ? AND name = ?').all('table', 'workspaces_new')
  assert.equal(leftovers.length, 0)
  // 旧 channels 也完好(失败点之前没有删旧表)
  const channel = db.prepare('SELECT name FROM channels WHERE id = ?').get('c1') as { name?: string } | undefined
  assert.equal(channel?.name, 'legacy channel')
  db.close()
})
