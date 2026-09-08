/**
 * ChannelPlugins 仓储:channel_plugins 表(channel × 插件启停,团队级独立开关)。
 *
 * 语义:无显式行 = 未配置 → 全部启用插件对团队可见(向后兼容,存量 channel 不受影响);
 * 显式行(建队勾选/团队设置切换)写入后按行过滤 —— 关闭的插件其工具不注入该团队
 * Agent,dispatch 同源拒绝,防止不需要插件的 channel 上下文被污染。
 * 自持连接(user.repository.ts 同模式):workshop.sqlite 单文件 WAL。
 */
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { ensureDataDir } from '@/shared/config/home.mjs'

const DB_PATH = join(ensureDataDir(), 'workshop.sqlite')

let db: DatabaseSync | null = null
function getDb(): DatabaseSync {
  if (!db) {
    db = new DatabaseSync(DB_PATH)
    db.exec('PRAGMA busy_timeout=4000')
    db.exec(`CREATE TABLE IF NOT EXISTS channel_plugins (
      channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      plugin     TEXT NOT NULL,
      enabled    INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (channel_id, plugin)
    )`)
  }
  return db
}

export interface ChannelPluginToggle {
  name: string
  enabled: boolean
}

export class ChannelPluginsRepo {
  /** 该团队的显式插件开关;无行 → null(未配置,默认全启用) */
  explicitFor(channelId: string): Map<string, boolean> | null {
    const rows = getDb()
      .prepare('SELECT plugin, enabled FROM channel_plugins WHERE channel_id = ?')
      .all(channelId) as Array<{ plugin: string, enabled: number }>
    if (!rows.length) return null
    return new Map(rows.map(r => [r.plugin, r.enabled === 1]))
  }

  /** 写入/更新显式开关(未知插件名由调用方过滤) */
  setMany(channelId: string, entries: ChannelPluginToggle[]): void {
    const d = getDb()
    const up = d.prepare('INSERT OR REPLACE INTO channel_plugins (channel_id, plugin, enabled, updated_at) VALUES (?, ?, ?, ?)')
    for (const e of entries) {
      if (!e?.name) continue
      up.run(channelId, String(e.name), e.enabled === false ? 0 : 1, new Date().toISOString())
    }
  }

  removeForChannel(channelId: string): void {
    getDb().prepare('DELETE FROM channel_plugins WHERE channel_id = ?').run(channelId)
  }
}

let repo: ChannelPluginsRepo | null = null
export function getChannelPluginsRepo(): ChannelPluginsRepo {
  repo ??= new ChannelPluginsRepo()
  return repo
}
