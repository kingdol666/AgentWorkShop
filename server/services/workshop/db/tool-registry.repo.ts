/**
 * ToolRegistry 仓储:工具目录 + Channel 级工具策略。
 *
 * 三张表:
 *  - tool_registry          内置 + 插件注册工具的元数据快照(执行代码不入库)
 *  - channel_tool_policies  Channel 选择模式(all | selected)
 *  - channel_tool_settings  Channel × 工具显式选择行
 *
 * 语义:
 *  - 无 policy 行 = mode='all' + 无显式行 = 全部合格工具启用(向后兼容);
 *  - all 模式只存 enabled=0 的行(deny-list);
 *  - selected 模式按提交的全量视图存行(allow-list;缺行=不启用)。
 *
 * 与 channel_plugins.repo.ts 同模式:自持连接、无外键、删除 Channel 时由 manager 显式清理。
 * 所有外部输入一律走 prepared statement 参数绑定;动态 IN 只拼占位符。
 */
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { ensureDataDir } from '@/shared/config/home.mjs'

const DB_PATH = join(ensureDataDir(), 'workshop.sqlite')

let db: DatabaseSync | null = null

function ensureSchema(d: DatabaseSync): void {
  d.prepare(`CREATE TABLE IF NOT EXISTS tool_registry (
    name             TEXT PRIMARY KEY,
    source           TEXT NOT NULL,
    plugin_name      TEXT NOT NULL DEFAULT '',
    plugin_scope     TEXT NOT NULL DEFAULT '',
    label            TEXT NOT NULL DEFAULT '',
    description      TEXT NOT NULL DEFAULT '',
    parameters_json  TEXT NOT NULL DEFAULT '{}',
    roles_json       TEXT NOT NULL DEFAULT '["lead","worker"]',
    group_name       TEXT NOT NULL DEFAULT '',
    metadata_json    TEXT NOT NULL DEFAULT '{}',
    definition_hash  TEXT NOT NULL DEFAULT '',
    available        INTEGER NOT NULL DEFAULT 1,
    first_seen_at    TEXT NOT NULL,
    last_seen_at     TEXT NOT NULL,
    updated_at       TEXT NOT NULL
  )`).run()
  d.prepare('CREATE INDEX IF NOT EXISTS idx_tool_registry_source ON tool_registry(source, available)').run()
  d.prepare('CREATE INDEX IF NOT EXISTS idx_tool_registry_plugin ON tool_registry(plugin_name)').run()
  d.prepare(`CREATE TABLE IF NOT EXISTS channel_tool_policies (
    channel_id   TEXT PRIMARY KEY,
    mode         TEXT NOT NULL DEFAULT 'all',
    updated_by   TEXT NOT NULL DEFAULT '',
    updated_at   TEXT NOT NULL
  )`).run()
  d.prepare(`CREATE TABLE IF NOT EXISTS channel_tool_settings (
    channel_id   TEXT NOT NULL,
    tool_name    TEXT NOT NULL,
    enabled      INTEGER NOT NULL DEFAULT 1,
    updated_by   TEXT NOT NULL DEFAULT '',
    updated_at   TEXT NOT NULL,
    PRIMARY KEY (channel_id, tool_name)
  )`).run()
  d.prepare('CREATE INDEX IF NOT EXISTS idx_channel_tool_settings_channel ON channel_tool_settings(channel_id, enabled)').run()
}

function getDb(): DatabaseSync {
  if (!db) {
    db = new DatabaseSync(DB_PATH)
    db.prepare('PRAGMA busy_timeout=4000').run()
    ensureSchema(db)
  }
  return db
}

export type ToolSource = 'builtin' | 'plugin'
export type ToolPolicyMode = 'all' | 'selected'
export type ToolRole = 'lead' | 'worker'

export interface ToolRegistryRow {
  name: string
  source: ToolSource
  pluginName: string
  pluginScope: string
  label: string
  description: string
  parameters: Record<string, unknown>
  roles: ToolRole[]
  group: string
  metadata: Record<string, unknown>
  definitionHash: string
  available: boolean
  firstSeenAt: string
  lastSeenAt: string
  updatedAt: string
}

export interface ToolRegistryUpsert {
  name: string
  source: ToolSource
  pluginName?: string
  pluginScope?: string
  label?: string
  description: string
  parameters?: Record<string, unknown>
  roles?: ToolRole[]
  group?: string
  metadata?: Record<string, unknown>
  definitionHash: string
}

export interface ChannelToolPolicySnapshot {
  channelId: string
  mode: ToolPolicyMode
  source: 'default' | 'explicit'
  updatedBy: string
  updatedAt: string | null
  /** 显式行:all 模式只有 enabled=0 的行有意义;selected 模式 enabled=1 为选中 */
  settings: Map<string, boolean>
}

export interface ChannelToolPolicyEntry {
  name: string
  enabled: boolean
}

interface RegistryDbRow {
  name: string
  source: string
  plugin_name: string
  plugin_scope: string
  label: string
  description: string
  parameters_json: string
  roles_json: string
  group_name: string
  metadata_json: string
  definition_hash: string
  available: number
  first_seen_at: string
  last_seen_at: string
  updated_at: string
}

function parseJsonObject(text: unknown): Record<string, unknown> {
  try {
    const parsed = JSON.parse(String(text ?? '{}'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  }
  catch {
    return {}
  }
}

function parseRoles(text: unknown): ToolRole[] {
  try {
    const parsed = JSON.parse(String(text ?? '[]'))
    if (!Array.isArray(parsed)) return ['lead', 'worker']
    const roles = parsed.filter((r): r is ToolRole => r === 'lead' || r === 'worker')
    return roles.length > 0 ? roles : ['lead', 'worker']
  }
  catch {
    return ['lead', 'worker']
  }
}

function rowToRegistry(row: RegistryDbRow): ToolRegistryRow {
  return {
    name: row.name,
    source: row.source === 'plugin' ? 'plugin' : 'builtin',
    pluginName: row.plugin_name,
    pluginScope: row.plugin_scope,
    label: row.label,
    description: row.description,
    parameters: parseJsonObject(row.parameters_json),
    roles: parseRoles(row.roles_json),
    group: row.group_name,
    metadata: parseJsonObject(row.metadata_json),
    definitionHash: row.definition_hash,
    available: row.available === 1,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    updatedAt: row.updated_at,
  }
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(',')
}

export class ToolRegistryRepo {
  /** 批量 upsert 当前快照;first_seen_at 保留,hash 未变时不推进 updated_at。 */
  upsertMany(rows: ToolRegistryUpsert[], now = new Date().toISOString()): number {
    if (rows.length === 0) return 0
    const d = getDb()
    const stmt = d.prepare(`INSERT INTO tool_registry (
      name, source, plugin_name, plugin_scope, label, description, parameters_json, roles_json,
      group_name, metadata_json, definition_hash, available, first_seen_at, last_seen_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      source = excluded.source,
      plugin_name = excluded.plugin_name,
      plugin_scope = excluded.plugin_scope,
      label = excluded.label,
      description = excluded.description,
      parameters_json = excluded.parameters_json,
      roles_json = excluded.roles_json,
      group_name = excluded.group_name,
      metadata_json = excluded.metadata_json,
      definition_hash = excluded.definition_hash,
      available = 1,
      last_seen_at = excluded.last_seen_at,
      updated_at = CASE
        WHEN tool_registry.definition_hash <> excluded.definition_hash THEN excluded.updated_at
        ELSE tool_registry.updated_at
      END`)
    d.prepare('BEGIN IMMEDIATE').run()
    try {
      for (const row of rows) {
        stmt.run(
          row.name,
          row.source,
          row.pluginName ?? '',
          row.pluginScope ?? '',
          row.label ?? '',
          row.description ?? '',
          JSON.stringify(row.parameters ?? {}),
          JSON.stringify(row.roles && row.roles.length > 0 ? row.roles : ['lead', 'worker']),
          row.group ?? '',
          JSON.stringify(row.metadata ?? {}),
          row.definitionHash,
          now,
          now,
          now,
        )
      }
      d.prepare('COMMIT').run()
      return rows.length
    }
    catch (err) {
      try {
        d.prepare('ROLLBACK').run()
      }
      catch { /* ignore */ }
      throw err
    }
  }

  /**
   * 把本轮未出现的工具标记为 unavailable。
   * names 可能为空(插件全部卸载):此时全部置 0;动态 IN 只拼占位符。
   */
  markUnavailableExcept(names: string[]): number {
    const d = getDb()
    if (names.length === 0) {
      return Number(d.prepare('UPDATE tool_registry SET available = 0 WHERE available = 1').run().changes ?? 0)
    }
    const sql = `UPDATE tool_registry SET available = 0
      WHERE available = 1 AND name NOT IN (${placeholders(names.length)})`
    return Number(d.prepare(sql).run(...names).changes ?? 0)
  }

  list(): ToolRegistryRow[] {
    return (getDb().prepare('SELECT * FROM tool_registry ORDER BY source ASC, name ASC').all() as unknown as RegistryDbRow[])
      .map(rowToRegistry)
  }

  get(name: string): ToolRegistryRow | null {
    const row = getDb().prepare('SELECT * FROM tool_registry WHERE name = ?').get(name) as unknown as RegistryDbRow | undefined
    return row ? rowToRegistry(row) : null
  }

  counts(): { total: number, builtin: number, plugin: number, available: number } {
    const row = getDb().prepare(`SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN source = 'builtin' THEN 1 ELSE 0 END) AS builtin,
      SUM(CASE WHEN source = 'plugin' THEN 1 ELSE 0 END) AS plugin,
      SUM(CASE WHEN available = 1 THEN 1 ELSE 0 END) AS available
      FROM tool_registry`).get() as { total?: number, builtin?: number, plugin?: number, available?: number } | undefined
    return {
      total: Number(row?.total ?? 0),
      builtin: Number(row?.builtin ?? 0),
      plugin: Number(row?.plugin ?? 0),
      available: Number(row?.available ?? 0),
    }
  }

  lastSyncedAt(): string | null {
    const row = getDb().prepare('SELECT MAX(last_seen_at) AS at FROM tool_registry').get() as { at?: string | null } | undefined
    return row?.at ?? null
  }

  snapshot(channelId: string): ChannelToolPolicySnapshot {
    const policy = getDb().prepare('SELECT mode, updated_by, updated_at FROM channel_tool_policies WHERE channel_id = ?')
      .get(channelId) as { mode?: string, updated_by?: string, updated_at?: string } | undefined
    const rows = getDb().prepare('SELECT tool_name, enabled FROM channel_tool_settings WHERE channel_id = ?')
      .all(channelId) as Array<{ tool_name: string, enabled: number }>
    const mode: ToolPolicyMode = policy?.mode === 'selected' ? 'selected' : 'all'
    return {
      channelId,
      mode,
      source: policy || rows.length > 0 ? 'explicit' : 'default',
      updatedBy: policy?.updated_by ?? '',
      updatedAt: policy?.updated_at ?? null,
      settings: new Map(rows.map(r => [r.tool_name, r.enabled === 1])),
    }
  }

  /** 全量替换 Channel 策略。all 模式只落 enabled=0;selected 模式落全部提交行。 */
  savePolicy(channelId: string, mode: ToolPolicyMode, entries: ChannelToolPolicyEntry[], updatedBy: string): void {
    const d = getDb()
    const now = new Date().toISOString()
    const rows = mode === 'all'
      ? entries.filter(e => e.enabled === false)
      : entries
    d.prepare('BEGIN IMMEDIATE').run()
    try {
      d.prepare(`INSERT INTO channel_tool_policies (channel_id, mode, updated_by, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(channel_id) DO UPDATE SET mode = excluded.mode, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
        .run(channelId, mode, updatedBy, now)
      d.prepare('DELETE FROM channel_tool_settings WHERE channel_id = ?').run(channelId)
      const ins = d.prepare(`INSERT INTO channel_tool_settings (channel_id, tool_name, enabled, updated_by, updated_at)
        VALUES (?, ?, ?, ?, ?)`)
      for (const entry of rows) {
        ins.run(channelId, entry.name, entry.enabled ? 1 : 0, updatedBy, now)
      }
      d.prepare('COMMIT').run()
    }
    catch (err) {
      try {
        d.prepare('ROLLBACK').run()
      }
      catch { /* ignore */ }
      throw err
    }
  }

  resetPolicy(channelId: string): void {
    const d = getDb()
    d.prepare('BEGIN IMMEDIATE').run()
    try {
      d.prepare('DELETE FROM channel_tool_settings WHERE channel_id = ?').run(channelId)
      d.prepare('DELETE FROM channel_tool_policies WHERE channel_id = ?').run(channelId)
      d.prepare('COMMIT').run()
    }
    catch (err) {
      try {
        d.prepare('ROLLBACK').run()
      }
      catch { /* ignore */ }
      throw err
    }
  }

  removeForChannel(channelId: string): void {
    this.resetPolicy(channelId)
  }

  /** 全部显式策略(全局透明化页统计用) */
  listPolicies(): Array<{ channelId: string, mode: ToolPolicyMode, updatedBy: string, updatedAt: string }> {
    const rows = getDb().prepare('SELECT channel_id, mode, updated_by, updated_at FROM channel_tool_policies')
      .all() as Array<{ channel_id: string, mode: string, updated_by: string, updated_at: string }>
    return rows.map(r => ({
      channelId: r.channel_id,
      mode: r.mode === 'selected' ? 'selected' : 'all',
      updatedBy: r.updated_by,
      updatedAt: r.updated_at,
    }))
  }

  listAllSettings(): Array<{ channelId: string, toolName: string, enabled: boolean }> {
    const rows = getDb().prepare('SELECT channel_id, tool_name, enabled FROM channel_tool_settings')
      .all() as Array<{ channel_id: string, tool_name: string, enabled: number }>
    return rows.map(r => ({ channelId: r.channel_id, toolName: r.tool_name, enabled: r.enabled === 1 }))
  }

  /** Channel 名称映射(全局页展示“被哪些 Channel 停用”;不存在/已删的悬挂 id 返回空名) */
  channelNames(): Map<string, string> {
    const rows = getDb().prepare('SELECT id, name FROM channels').all() as Array<{ id: string, name: string }>
    return new Map(rows.map(r => [r.id, r.name]))
  }
}

let repo: ToolRegistryRepo | null = null

export function getToolRegistryRepo(): ToolRegistryRepo {
  repo ??= new ToolRegistryRepo()
  return repo
}

/** 单测用:关闭连接并重置单例(隔离临时 AW_HOME 时调用) */
export function closeToolRegistryRepoForTests(): void {
  try {
    db?.close()
  }
  catch { /* ignore */ }
  db = null
  repo = null
}
