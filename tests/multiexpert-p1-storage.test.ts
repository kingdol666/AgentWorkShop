/**
 * 2026-10-28 多专家审查整改 · 数据域 P1:
 *  D-P1-1 Timescale queryTagged 返回 state/ingestedAt + queryTaggedPage(与 sqlite 契约等价);
 *  D-P1-2 owner-FK 老库迁移不得丢列(scenario_prompt/llm_json 等全部业务列)。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-mx-storage-'))
delete process.env.AW_BENCH_MODE

const { SqliteTimeSeriesAdapter } = await import('../server/services/workshop/daq/storage/sqlite.adapter')
const { TimescaleAdapter } = await import('../server/services/workshop/daq/storage/timescale.adapter')
const { initWorkshopDb } = await import('../server/services/workshop/db/database/open')

const T0 = Date.parse('2026-10-28T00:00:00.000Z')
const SAMPLE = [
  { nodeId: 'dn-1', tsMs: T0, value: 10.5, state: 'ok', ingestedAt: T0 + 5 },
  { nodeId: 'dn-1', tsMs: T0 + 1000, value: 11.5, state: 'bad', ingestedAt: T0 + 1001 },
  { nodeId: 'dn-1', tsMs: T0 + 2000, value: 12.5, state: 'alarm', ingestedAt: T0 + 2001 },
]

/** 假 pg Pool:只回答本用例用到的两种查询形状(列/行映射即被测面);
 *  2026-10-29:queryTaggedPage 改为 8 参数静态 SQL(node,from,to,line,product,recipe,run,limit),
 *  桩按参数位置解构,标签参数 NULL 即不过滤(与真实语义一致)。 */
function fakePool(rows: Array<{ node_id: string, ts: string, value: number, state: string | null, ingested_at: number | null }> = SAMPLE.map(r => ({
  node_id: r.nodeId,
  ts: new Date(r.tsMs).toISOString(),
  value: r.value,
  state: r.state,
  ingested_at: r.ingestedAt,
}))) {
  return {
    async query(sql: string, params: unknown[]) {
      if (sql.includes('SELECT node_id, ts, value, state, ingested_at')) {
        const fromMs = Date.parse(String(params[params.length - 3]))
        return { rows: rows.filter(r => Date.parse(r.ts) >= fromMs) }
      }
      if (sql.includes('FROM daq_samples') && sql.includes('ORDER BY ts ASC LIMIT')) {
        const [nodeId, fromIso, toIso, lineId, productId, recipeId, runId, limit] = params as [string, string, string, string | null, string | null, string | null, string | null, number]
        const from = Date.parse(fromIso)
        const to = Date.parse(toIso)
        const tagOk = (col: keyof (typeof rows)[number], v: string | null) => v == null || (rows[0]![col] as string | null) === v
        return {
          rows: rows
            .filter(r => r.node_id === nodeId
              && Date.parse(r.ts) >= from && Date.parse(r.ts) <= to
              && tagOk('line_id', lineId) && tagOk('product_id', productId)
              && tagOk('recipe_id', recipeId) && tagOk('run_id', runId))
            .slice(0, limit)
            .map(r => sql.includes('state')
              ? { ts: r.ts, value: r.value, state: r.state, ingested_at: r.ingested_at }
              : { ts: r.ts, value: r.value }),
        }
      }
      return { rows: [] }
    },
  }
}

async function sqliteAdapter() {
  const a = new SqliteTimeSeriesAdapter()
  await a.init()
  await a.writeSamples(SAMPLE)
  return a
}

test('D-P1-1:Timescale queryTagged 返回 state/ingestedAt,与 sqlite 同输入同输出', async () => {
  const sq = await sqliteAdapter()
  const ts = new TimescaleAdapter('postgres://fake')
  ;(ts as unknown as { pool: unknown }).pool = fakePool()

  const q = { nodeIds: ['dn-1'], fromMs: T0, toMs: T0 + 10_000, limit: 100 }
  const a = await sq.queryTagged(q)
  const b = await ts.queryTagged(q)
  assert.deepEqual([...b.keys()], ['dn-1'])
  assert.deepEqual(b.get('dn-1'), a.get('dn-1'), '两后端返回必须逐字段等价')
  const first = b.get('dn-1')![0]!
  assert.equal(first.state, 'ok')
  assert.equal(first.ingestedAt, T0 + 5)
})

test('D-P1-1:Timescale queryTaggedPage 与 sqlite 的分页/游标/done 语义一致', async () => {
  const sq = await sqliteAdapter()
  const ts = new TimescaleAdapter('postgres://fake')
  ;(ts as unknown as { pool: unknown }).pool = fakePool()

  for (const limit of [1, 2, 10]) {
    const pageSqlite = await sq.queryTaggedPage!('dn-1', { limit })
    const pageTs = await ts.queryTaggedPage!('dn-1', { limit })
    assert.deepEqual(pageTs, pageSqlite, `limit=${limit} 分页结果必须等价`)
  }
  // 游标严格大于 afterTs
  const next = await ts.queryTaggedPage!('dn-1', { afterTs: T0 })
  assert.deepEqual(next.points.map(p => p.at), [T0 + 1000, T0 + 2000])
  // withState=false 省列
  const noState = await ts.queryTaggedPage!('dn-1', { withState: false })
  assert.equal(noState.points[0]!.state, undefined)
})

test('D-P1-1:无连接池时 queryTaggedPage 安全返回空页(不抛)', async () => {
  const ts = new TimescaleAdapter('postgres://fake')
  const page = await ts.queryTaggedPage!('dn-1', {})
  assert.deepEqual(page, { nodeId: 'dn-1', points: [], nextCursor: null, done: true })
})

test('D-P1-1:ingested_at 为 NULL 的存量行不注入 ingestedAt(不造假水位)', async () => {
  const ts = new TimescaleAdapter('postgres://fake')
  ;(ts as unknown as { pool: unknown }).pool = fakePool([
    { node_id: 'dn-1', ts: new Date(T0).toISOString(), value: 1, state: 'ok', ingested_at: null },
  ])
  const page = await ts.queryTaggedPage!('dn-1', {})
  assert.equal(page.points.length, 1)
  assert.equal('ingestedAt' in page.points[0]!, false)
  assert.equal(page.points[0]!.state, 'ok')
})

// ===== D-P1-2:老库(带 users 外键)升级 =====

const LEGACY_SQL = [
  `CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL)`,
  `CREATE TABLE workspaces (
    id TEXT PRIMARY KEY,
    owner_user_id TEXT NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE channels (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    scenario_prompt TEXT NOT NULL DEFAULT '',
    llm_json TEXT NOT NULL DEFAULT '',
    lead_agent_id TEXT,
    workspace TEXT NOT NULL DEFAULT '',
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    owner_user_id TEXT REFERENCES users(id),
    visibility TEXT NOT NULL DEFAULT 'private',
    join_policy TEXT NOT NULL DEFAULT 'owner_approve',
    approval_policy TEXT NOT NULL DEFAULT 'owner_only',
    chat_enabled INTEGER NOT NULL DEFAULT 0,
    version INTEGER NOT NULL DEFAULT 1,
    line_id TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE TABLE agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    harness TEXT NOT NULL,
    config_json TEXT NOT NULL DEFAULT '{}',
    enabled INTEGER NOT NULL DEFAULT 1,
    visibility TEXT NOT NULL DEFAULT 'private',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    owner_user_id TEXT REFERENCES users(id)
  )`,
  `CREATE TABLE teams (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    visibility TEXT NOT NULL DEFAULT 'private',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    owner_user_id TEXT REFERENCES users(id)
  )`,
]

const NOW = '2026-10-28T00:00:00.000Z'

function legacyDb() {
  const db = new DatabaseSync(':memory:')
  for (const sql of LEGACY_SQL) db.prepare(sql).run()
  db.prepare('INSERT INTO users (id, name) VALUES (?, ?)').run('u-1', 'Legacy User')
  db.prepare(`INSERT INTO workspaces (id, owner_user_id, name, created_at) VALUES ('ws-1','u-1','w','${NOW}')`).run()
  db.prepare(`INSERT INTO channels (id, name, description, scenario_prompt, llm_json, lead_agent_id, workspace,
      enabled, created_at, updated_at, owner_user_id, visibility, join_policy, approval_policy, chat_enabled, version, line_id)
    VALUES ('ch-1','产线频道','desc-保真','场景提示词-保真','{"provider":"p","model":"m"}','ag-lead','w1',1,
      '${NOW}','${NOW}','u-1','private','owner_approve','owner_only',0,3,'ln-1')`).run()
  db.prepare(`INSERT INTO agents (id, name, harness, config_json, enabled, visibility, created_at, updated_at, owner_user_id)
    VALUES ('ag-1','模板','omp','{"model":"x"}',1,'public','${NOW}','${NOW}','u-1')`).run()
  db.prepare(`INSERT INTO teams (id, name, description, visibility, created_at, updated_at, owner_user_id)
    VALUES ('tm-1','班组','desc','private','${NOW}','${NOW}','u-1')`).run()
  return db
}

function colNames(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(r => r.name).sort()
}

function userFkTables(db: DatabaseSync): string[] {
  return ['workspaces', 'channels', 'agents', 'teams'].filter((t) => {
    const fks = db.prepare(`PRAGMA foreign_key_list(${t})`).all() as Array<{ table: string }>
    return fks.some(f => f.table === 'users')
  })
}

test('D-P1-2:带 owner FK 的老库升级后:外键消失、列集不变、业务数据逐列保留', () => {
  const db = legacyDb()
  const beforeCols = Object.fromEntries(['workspaces', 'channels', 'agents', 'teams'].map(t => [t, colNames(db, t)]))
  assert.deepEqual(userFkTables(db).sort(), ['agents', 'channels', 'teams', 'workspaces'], '前置:老库必须带 users 外键')

  initWorkshopDb(db)

  assert.deepEqual(userFkTables(db), [], '升级后不得再持有 users 外键')
  // 列集不漂移(重建白名单漏列 → 这里立刻红)
  for (const t of ['workspaces', 'channels', 'agents', 'teams']) {
    assert.deepEqual(colNames(db, t), beforeCols[t], `${t} 列集在升级中漂移`)
  }
  // 业务数据逐列保留(审查原缺陷:scenario_prompt/llm_json 被静默清空)
  const ch = db.prepare('SELECT * FROM channels WHERE id = ?').get('ch-1') as Record<string, unknown>
  assert.equal(ch.scenario_prompt, '场景提示词-保真')
  assert.equal(ch.llm_json, '{"provider":"p","model":"m"}')
  assert.equal(ch.description, 'desc-保真')
  assert.equal(ch.line_id, 'ln-1')
  assert.equal(ch.version, 3)
  assert.equal(ch.approval_policy, 'owner_only')
  assert.equal(ch.owner_user_id, 'u-1')
  const ag = db.prepare('SELECT * FROM agents WHERE id = ?').get('ag-1') as Record<string, unknown>
  assert.equal(ag.config_json, '{"model":"x"}')
  assert.equal(ag.visibility, 'public')
  assert.equal(ag.owner_user_id, 'u-1')
  const tm = db.prepare('SELECT * FROM teams WHERE id = ?').get('tm-1') as Record<string, unknown>
  assert.equal(tm.description, 'desc')
  const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get('ws-1') as Record<string, unknown>
  assert.equal(ws.owner_user_id, 'u-1')
  // 索引被重建
  const idx = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_workspaces_owner'`).get()
  assert.ok(idx, 'idx_workspaces_owner 必须重建')
})

test('D-P1-2:迁移幂等 —— 二次初始化不改变数据、不抛错', () => {
  const db = legacyDb()
  initWorkshopDb(db)
  const snapshot = JSON.stringify({
    ch: db.prepare('SELECT * FROM channels WHERE id = ?').get('ch-1'),
    ag: db.prepare('SELECT * FROM agents WHERE id = ?').get('ag-1'),
    cols: colNames(db, 'channels'),
  })
  initWorkshopDb(db)
  const again = JSON.stringify({
    ch: db.prepare('SELECT * FROM channels WHERE id = ?').get('ch-1'),
    ag: db.prepare('SELECT * FROM agents WHERE id = ?').get('ag-1'),
    cols: colNames(db, 'channels'),
  })
  assert.equal(again, snapshot)
})
