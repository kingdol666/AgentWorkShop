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
const { openWorkshopDb, initWorkshopDb, SCHEMA_CONTRACT_VERSION } = await import('../server/services/workshop/db/database/open')
const { fingerprintMigration } = await import('../server/services/workshop/db/database/migration-ledger')
const { migrateDropOwnerFks, migrateMissingForeignKeys } = await import('../server/services/workshop/db/database/migrations')
const { SCHEMA_SQL } = await import('../server/services/workshop/db/database/schema')

type Db = InstanceType<typeof DatabaseSync>

const CONTRACT_VERSION = SCHEMA_CONTRACT_VERSION

/** 语句逐条执行(不用 exec:与生产写入走同一参数化入口)。 */
function run(db: Db, sql: string, ...params: unknown[]): void {
  db.prepare(sql).run(...(params as never[]))
}

function legacyLedger(db: Db): void {
  run(db, 'DELETE FROM aw_migration_ledger WHERE version = ?', CONTRACT_VERSION)
  run(db, 'INSERT OR IGNORE INTO aw_migration_ledger(version, name, fingerprint, applied_at) VALUES (2, ?, ?, ?)',
    'schema-contract', 'legacy-contract-hash', new Date().toISOString())
}

function ledgerRow(db: Db, version: number) {
  return db.prepare('SELECT version, fingerprint FROM aw_migration_ledger WHERE version = ?').get(version) as { version: number, fingerprint: string } | undefined
}

test('a database created before the contract bump still boots and records the current version', () => {
  const db = openWorkshopDb(':memory:')
  const current = ledgerRow(db, CONTRACT_VERSION)
  assert.equal(current?.fingerprint, fingerprintMigration(SCHEMA_SQL))

  // Simulate a database whose latest recorded contract predates claim tokens.
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

test('a failing rebuild inside migrateMissingForeignKeys rolls back atomically', () => {
  const db = new DatabaseSync(':memory:')
  run(db, 'CREATE TABLE channels (id TEXT PRIMARY KEY)')
  run(db, 'CREATE TABLE channel_agents (id TEXT PRIMARY KEY)')
  run(db, `CREATE TABLE tasks (
    id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, parent_id TEXT, root_queue_seq INTEGER,
    assignee_id TEXT NOT NULL, creator_id TEXT, title TEXT NOT NULL, description TEXT,
    state TEXT NOT NULL, progress INTEGER NOT NULL DEFAULT 0, retry_count INTEGER NOT NULL DEFAULT 0,
    artifacts_json TEXT NOT NULL DEFAULT '[]', history_json TEXT NOT NULL DEFAULT '[]',
    route_reason TEXT NOT NULL DEFAULT '', source_chat_message_id TEXT, source_chat_delivery_id TEXT,
    close_reason TEXT, deadline_at TEXT, superseded_by_task_id TEXT, source TEXT NOT NULL DEFAULT 'channel',
    project_id TEXT, project_work_item_id TEXT, project_attempt_no INTEGER, session_id TEXT,
    trace_id TEXT NOT NULL DEFAULT '', assignment_generation INTEGER NOT NULL DEFAULT 0,
    execution_lease_id TEXT, execution_lease_agent_id TEXT, execution_lease_started_at TEXT,
    execution_lease_revoked_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`)
  run(db, 'CREATE TABLE subscriptions (channel_id TEXT NOT NULL, agent_id TEXT NOT NULL, target_agent_id TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (channel_id, agent_id, target_agent_id))')
  run(db, 'INSERT INTO channels(id) VALUES (?)', 'ch1')
  run(db, 'INSERT INTO tasks(id, channel_id, assignee_id, title, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    't1', 'ch1', 'a1', 'legacy task', 'COMPLETED', '2026-01-01', '2026-01-01')
  // 预先占用 subscriptions_new:任务重建完成后,订阅阶段 CREATE 失败 → 整体回滚
  run(db, 'CREATE TABLE subscriptions_new (planted TEXT)')

  assert.throws(() => migrateMissingForeignKeys(db), /already exists/)

  const task = db.prepare('SELECT title FROM tasks WHERE id = ?').get('t1') as { title?: string } | undefined
  assert.equal(task?.title, 'legacy task')
  const leftovers = db.prepare('SELECT name FROM sqlite_master WHERE type = ? AND name = ?').all('table', 'tasks_new')
  assert.equal(leftovers.length, 0)
  const taskFks = db.prepare('PRAGMA foreign_key_list(tasks)').all()
  assert.equal(taskFks.length, 0, 'rollback must restore the legacy tasks table (no FK yet)')
  db.close()
})

test('owner-FK rebuild preserves an existing channel_mode (integrated channel keeps its mode)', () => {
  const db = new DatabaseSync(':memory:')
  run(db, 'CREATE TABLE users (id TEXT PRIMARY KEY)')
  // 另三张表存在但无 owner FK → 只触发 channels 重建(聚焦 channel_mode 保留)
  run(db, 'CREATE TABLE workspaces (id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL)')
  run(db, 'CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT NOT NULL, harness TEXT NOT NULL, config_json TEXT NOT NULL DEFAULT \'{}\', enabled INTEGER NOT NULL DEFAULT 1, visibility TEXT NOT NULL DEFAULT \'private\', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, owner_user_id TEXT)')
  run(db, 'CREATE TABLE teams (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT \'\', visibility TEXT NOT NULL DEFAULT \'private\', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, owner_user_id TEXT)')
  run(db, `CREATE TABLE channels (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
    scenario_prompt TEXT NOT NULL DEFAULT '', llm_json TEXT NOT NULL DEFAULT '',
    lead_agent_id TEXT, workspace TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    owner_user_id TEXT REFERENCES users(id), visibility TEXT NOT NULL DEFAULT 'private',
    join_policy TEXT NOT NULL DEFAULT 'owner_approve', approval_policy TEXT NOT NULL DEFAULT 'owner_only',
    chat_enabled INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 1,
    line_id TEXT NOT NULL DEFAULT '',
    channel_mode TEXT NOT NULL DEFAULT 'generic' CHECK (channel_mode IN ('generic', 'production_line_integrated'))
  )`)
  run(db, 'INSERT INTO users(id) VALUES (?)', 'u1')
  // 关键场景:integrated 但 line_id 为空(手工/历史数据)——重建后不得回落 generic
  run(db, 'INSERT INTO channels(id, name, created_at, updated_at, owner_user_id, line_id, channel_mode) VALUES (?, ?, ?, ?, ?, ?, ?)',
    'c1', 'integrated no line', '2026-01-01', '2026-01-01', 'u1', '', 'production_line_integrated')

  migrateDropOwnerFks(db)

  const row = db.prepare('SELECT channel_mode AS mode, line_id AS line FROM channels WHERE id = ?').get('c1') as { mode?: string, line?: string } | undefined
  assert.equal(row?.mode, 'production_line_integrated')
  assert.equal(row?.line, '')
  const fks = db.prepare('PRAGMA foreign_key_list(channels)').all()
  assert.equal(fks.length, 0)
  db.close()
})
