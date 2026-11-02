import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { initWorkshopDb } from '../../server/services/workshop/db/database/open.ts'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
function sha(bytes) { return createHash('sha256').update(bytes).digest('hex') }
function fail(message) { throw new Error(`synthetic workshop fixture refused: ${message}`) }

function inventoryTables(db) {
  return db.prepare('SELECT name FROM sqlite_master WHERE type = \'table\' AND name NOT LIKE \'sqlite_%\' ORDER BY name')
    .all().map(row => String(row.name))
}

function countRows(db, table) {
  if (!/^[a-z][a-z0-9_]*$/.test(table)) fail('unexpected table identifier')
  return Number(db.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get().count)
}

function validateAppFtsInternalMetadata(db) {
  const fts = db.prepare('SELECT type, sql FROM sqlite_master WHERE name = \'agent_memories_fts\'').get()
  const config = db.prepare('SELECT type, sql FROM sqlite_master WHERE name = \'agent_memories_fts_config\'').get()
  const data = db.prepare('SELECT type, sql FROM sqlite_master WHERE name = \'agent_memories_fts_data\'').get()
  const normalizeSql = sql => String(sql ?? '').replace(/["'`]/g, '').replace(/\s+/g, ' ').trim().toLowerCase()
  const ftsSql = normalizeSql(fts?.sql)
  const configSql = normalizeSql(config?.sql)
  const dataSql = normalizeSql(data?.sql)
  if (fts?.type !== 'table'
    || !/^create virtual table(?: if not exists)? agent_memories_fts using fts5\(\s*title,\s*content,\s*agent_id unindexed,\s*memory_rowid unindexed\s*\)$/.test(ftsSql)) {
    fail('application FTS5 virtual-table definition differs from the fixed agent-memory schema')
  }
  if (config?.type !== 'table'
    || !/^create table(?: if not exists)? agent_memories_fts_config\s*\(\s*k primary key\s*,\s*v\s*\)\s+without rowid$/.test(configSql)) {
    fail('FTS5 config table DDL is not the fixed application shadow-table schema')
  }
  if (data?.type !== 'table'
    || !/^create table(?: if not exists)? agent_memories_fts_data\s*\(\s*id integer primary key\s*,\s*block blob\s*\)$/.test(dataSql)) {
    fail('FTS5 data table DDL is not the fixed application shadow-table schema')
  }

  const tableList = db.prepare('PRAGMA table_list').all()
  const configListed = tableList.find(row => row.schema === 'main' && row.name === 'agent_memories_fts_config')
  if (!configListed || configListed.type !== 'shadow' || Number(configListed.ncol) !== 2 || Number(configListed.wr) !== 1 || Number(configListed.strict) !== 0) {
    fail('FTS5 config table metadata is not the expected two-column WITHOUT ROWID shadow table')
  }
  const dataListed = tableList.find(row => row.schema === 'main' && row.name === 'agent_memories_fts_data')
  if (!dataListed || dataListed.type !== 'shadow' || Number(dataListed.ncol) !== 2 || Number(dataListed.wr) !== 0 || Number(dataListed.strict) !== 0) {
    fail('FTS5 data table metadata is not the expected two-column rowid shadow table')
  }
  const columns = db.prepare('PRAGMA table_info(\'agent_memories_fts_config\')').all()
    .map(row => [Number(row.cid), String(row.name), Number(row.pk)])
  if (JSON.stringify(columns) !== JSON.stringify([[0, 'k', 1], [1, 'v', 0]])) {
    fail('FTS5 config table columns differ from the expected (k PRIMARY KEY, v) shape')
  }
  const dataColumns = db.prepare('PRAGMA table_info(\'agent_memories_fts_data\')').all()
    .map(row => [Number(row.cid), String(row.name), String(row.type).toUpperCase(), Number(row.pk)])
  if (JSON.stringify(dataColumns) !== JSON.stringify([[0, 'id', 'INTEGER', 1], [1, 'block', 'BLOB', 0]])) {
    fail('FTS5 data table columns differ from the expected (id INTEGER PRIMARY KEY, block BLOB) shape')
  }
  const configRows = db.prepare('SELECT k, v, typeof(v) AS value_type FROM agent_memories_fts_config ORDER BY k').all()
  if (configRows.length !== 1 || configRows[0].k !== 'version' || Number(configRows[0].v) !== 4 || configRows[0].value_type !== 'integer') {
    fail('FTS5 config table contains non-default options or unexpected version metadata')
  }
  const dataRows = db.prepare('SELECT id, block, typeof(block) AS block_type FROM agent_memories_fts_data ORDER BY id').all()
  const expectedDataRows = [
    { id: 1, hex: '' },
    { id: 10, hex: '00000000000000' },
  ]
  if (dataRows.length !== expectedDataRows.length || dataRows.some((row, index) => {
    const expected = expectedDataRows[index]
    const block = row.block
    const bytes = block instanceof Uint8Array || Buffer.isBuffer(block) ? Buffer.from(block) : null
    return Number(row.id) !== expected.id || row.block_type !== 'blob' || !bytes || bytes.toString('hex') !== expected.hex
  })) {
    fail('FTS5 data table rows differ from the exact empty-index metadata')
  }
  return {
    virtual_table: { name: 'agent_memories_fts', schema_sha256: sha(Buffer.from(String(fts.sql))) },
    shadow_tables: [
      {
        name: 'agent_memories_fts_config', table_type: configListed.type,
        schema_sha256: sha(Buffer.from(String(config.sql))), columns,
        rows: [{ key: 'version', value: 4, storage_class: 'integer' }],
      },
      {
        name: 'agent_memories_fts_data', table_type: dataListed.type,
        schema_sha256: sha(Buffer.from(String(data.sql))), columns: dataColumns,
        rows: dataRows.map((row, index) => ({
          id: expectedDataRows[index].id,
          bytes: Buffer.from(row.block).length,
          sha256: sha(Buffer.from(row.block)),
        })),
      },
    ],
  }
}

function assertFreshRuntimeTables(db, permittedRows) {
  const tables = inventoryTables(db)
  const internalFtsTables = new Set(['agent_memories_fts_config', 'agent_memories_fts_data'])
  for (const table of internalFtsTables) if (!tables.includes(table)) fail(`application FTS5 internal shadow table is missing: ${table}`)
  const ftsMetadata = validateAppFtsInternalMetadata(db)
  for (const table of tables) {
    if (permittedRows.has(table) || internalFtsTables.has(table)) continue
    if (countRows(db, table) !== 0) fail(`unexpected non-empty runtime table: ${table}`)
  }
  return ftsMetadata
}

function initialize(requestPath) {
  const requestBytes = readFileSync(requestPath)
  const request = JSON.parse(requestBytes.toString('utf8'))
  const { db_path: dbPath, ids, line_id: lineId, run_id: runId, created_at: now } = request
  if (typeof dbPath !== 'string' || !resolve(dbPath).replaceAll('\\', '/').endsWith('/data/workshop.sqlite')) fail('database path is not the synthetic AW_HOME workshop database')
  if (existsSync(dbPath)) fail('refusing to initialize over an existing database')
  if (typeof runId !== 'string' || !/^[a-zA-Z0-9_-]{8,80}$/.test(runId)
    || ids?.user_id !== `a1-${sha(`${runId}:user`).slice(0, 24)}`
    || ids?.channel_id !== `a1-${sha(`${runId}:channel`).slice(0, 24)}`
    || ids?.agent_id !== `a1-${sha(`${runId}:agent`).slice(0, 24)}`
    || ids?.run_id !== `a1-${sha(`${runId}:active-run`).slice(0, 24)}`
    || typeof lineId !== 'string' || !lineId
    || typeof now !== 'string' || !Number.isFinite(Date.parse(now))
    || typeof request.agent_token !== 'string' || request.agent_token.length < 32) fail('synthetic identifiers or seed request fields are malformed')

  const db = new DatabaseSync(dbPath)
  try {
    db.exec('PRAGMA foreign_keys = ON')
    initWorkshopDb(db)

    const staticSeedTables = ['agents', 'teams', 'team_members', 'channel_templates']
    const permittedRows = new Set([...staticSeedTables, 'channels', 'channel_agents', 'channel_members'])
    const initialFtsMetadata = assertFreshRuntimeTables(db, new Set(staticSeedTables))
    for (const table of ['channels', 'channel_agents', 'channel_members']) {
      if (countRows(db, table) !== 0) fail(`fresh database unexpectedly contains rows in ${table}`)
    }

    db.exec('BEGIN IMMEDIATE')
    try {
      db.prepare(`INSERT INTO channels
        (id, name, description, scenario_prompt, llm_json, lead_agent_id, workspace, enabled,
         created_at, updated_at, owner_user_id, visibility, join_policy, approval_policy,
         chat_enabled, version, line_id)
        VALUES (?, 'A1 Synthetic Channel', '', '', '', NULL, '', 1, ?, ?, ?, 'private', 'owner_approve', 'owner_only', 0, 1, ?)`)
        .run(ids.channel_id, now, now, ids.user_id, lineId)
      db.prepare(`INSERT INTO channel_members
        (channel_id, user_id, role, status, generation, joined_at, left_at)
        VALUES (?, ?, 'owner', 'active', 1, ?, NULL)`)
        .run(ids.channel_id, ids.user_id, now)
      db.prepare(`INSERT INTO channel_agents
        (id, channel_id, template_id, name, harness, config_json, role, token, enabled, created_at, updated_at)
        VALUES (?, ?, NULL, 'A1 Synthetic Agent', 'omp', '{"rpcMode":"rpc"}', 'worker', ?, 1, ?, ?)`)
        .run(ids.agent_id, ids.channel_id, request.agent_token, now, now)
      db.exec('COMMIT')
    }
    catch (error) {
      db.exec('ROLLBACK')
      throw error
    }

    const expectedCounts = { channels: 1, channel_agents: 1, channel_members: 1 }
    for (const [table, expected] of Object.entries(expectedCounts)) {
      if (countRows(db, table) !== expected) fail(`${table} count does not match the synthetic fixture`)
    }
    const finalFtsMetadata = assertFreshRuntimeTables(db, permittedRows)
    if (JSON.stringify(initialFtsMetadata) !== JSON.stringify(finalFtsMetadata)) fail('FTS5 internal metadata changed during synthetic fixture insertion')
    const idsRow = db.prepare('SELECT ca.id, ca.channel_id, c.owner_user_id, c.line_id FROM channel_agents ca JOIN channels c ON c.id = ca.channel_id WHERE ca.id = ?')
      .get(ids.agent_id)
    if (!idsRow || idsRow.channel_id !== ids.channel_id || idsRow.owner_user_id !== ids.user_id || idsRow.line_id !== lineId) {
      fail('synthetic identity linkage failed read-after-write verification')
    }
    const checkpoint = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()
    if (Number(checkpoint.busy) !== 0 || Number(checkpoint.log) !== Number(checkpoint.checkpointed)) fail('synthetic database WAL checkpoint did not complete')

    const sourceFiles = [
      'server/services/workshop/db/database/schema.ts',
      'server/services/workshop/db/database/open.ts',
      'server/services/workshop/db/database/migrations.ts',
      'server/services/workshop/db/database/seed.ts',
      'server/services/workshop/db/database/seed-data.ts',
      'server/services/workshop/db/aml-team-seeds.ts',
    ]
    const schemaProvenance = Object.fromEntries(sourceFiles.map(path => {
      const bytes = readFileSync(resolve(repo, path))
      return [path, sha(bytes)]
    }))
    return {
      schema_version: 1,
      method: 'fresh-app-schema-and-migrations-plus-synthetic-records',
      source_database_rows_read: false,
      source_database_files_copied: false,
      database_sha256: sha(readFileSync(dbPath)),
      schema_provenance: schemaProvenance,
      synthetic_ids: { user_id: ids.user_id, channel_id: ids.channel_id, agent_id: ids.agent_id, line_id: lineId },
      synthetic_rows: expectedCounts,
      static_seed_tables: Object.fromEntries(staticSeedTables.map(table => [table, countRows(db, table)])),
      validated_internal_metadata: finalFtsMetadata,
      other_runtime_tables_empty: true,
      harness: 'omp',
      channel_policy: { visibility: 'private', join_policy: 'owner_approve', approval_policy: 'owner_only', chat_enabled: 0 },
      api_paths: {
        invoke: 'POST /api/workshop/agent-tools/invoke',
        approval_decision: 'POST /api/workshop/agent-tools/approvals/:id/decide',
      },
    }
  }
  finally { db.close() }
}

try {
  if (process.argv.length !== 3) fail('expected one request JSON path')
  process.stdout.write(`${JSON.stringify(initialize(process.argv[2]))}\n`)
}
catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
