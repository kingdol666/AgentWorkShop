/**
 * User 仓储:用户级隔离身份(users 表)+ 服务端 Workspace(workspaces/workspace_channels)。
 * - 用户 token = 管理 API 的 Bearer 凭证(区别于 agent 实例 token)
 * - Workspace 持久化挂载关系(channel 引用不 FK,channel 删除后挂载行残留由清理兜底)
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { UserRow, WorkspaceRow } from './database'

export type UserRepo = ReturnType<typeof createUserRepo>

export function createUserRepo(db: DatabaseSync) {
  const insertUser = db.prepare(
    `INSERT INTO users (id, name, token, created_at) VALUES (?, ?, ?, ?)`,
  )
  const findById = db.prepare(
    `SELECT id, name, token, created_at AS createdAt FROM users WHERE id = ?`,
  )
  const findByName = db.prepare(
    `SELECT id, name, token, created_at AS createdAt FROM users WHERE name = ?`,
  )
  const findByToken = db.prepare(
    `SELECT id, name, token, created_at AS createdAt FROM users WHERE token = ?`,
  )

  // workspaces
  const insertWs = db.prepare(
    `INSERT INTO workspaces (id, owner_user_id, name, created_at) VALUES (?, ?, ?, ?)`,
  )
  const wsCols = 'id, owner_user_id AS ownerUserId, name, created_at AS createdAt'
  const listWsByOwner = db.prepare(
    `SELECT ${wsCols} FROM workspaces WHERE owner_user_id = ? ORDER BY created_at ASC`,
  )
  const findWs = db.prepare(`SELECT ${wsCols} FROM workspaces WHERE id = ?`)
  const deleteWs = db.prepare(`DELETE FROM workspaces WHERE id = ?`)

  // workspace_channels(挂载关系)
  const insertMount = db.prepare(
    `INSERT OR IGNORE INTO workspace_channels (workspace_id, channel_id, created_at) VALUES (?, ?, ?)`,
  )
  const deleteMount = db.prepare(
    `DELETE FROM workspace_channels WHERE workspace_id = ? AND channel_id = ?`,
  )
  const listMounts = db.prepare(
    `SELECT channel_id AS channelId FROM workspace_channels WHERE workspace_id = ? ORDER BY created_at ASC`,
  )

  return {
    /** 注册用户(name 唯一;token 仅创建时生成返回,库中仅存明文哈希对照) */
    create(name: string): UserRow {
      const row: UserRow = {
        id: randomUUID(),
        name,
        token: `u-${randomUUID().replace(/-/g, '')}`,
        createdAt: new Date().toISOString(),
      }
      insertUser.run(row.id, row.name, row.token, row.createdAt)
      return row
    },
    getById(id: string): UserRow | null {
      return (findById.get(id) as UserRow | undefined) ?? null
    },
    getByName(name: string): UserRow | null {
      return (findByName.get(name) as UserRow | undefined) ?? null
    },
    getByToken(token: string): UserRow | null {
      return (findByToken.get(token) as UserRow | undefined) ?? null
    },

    // ===== Workspace(服务端持久化;按 owner 隔离)=====
    createWorkspace(ownerUserId: string, name: string): WorkspaceRow {
      const row: WorkspaceRow = {
        id: randomUUID(),
        ownerUserId,
        name,
        createdAt: new Date().toISOString(),
      }
      insertWs.run(row.id, row.ownerUserId, row.name, row.createdAt)
      return row
    },
    listWorkspaces(ownerUserId: string): WorkspaceRow[] {
      return listWsByOwner.all(ownerUserId) as unknown as WorkspaceRow[]
    },
    getWorkspace(id: string): WorkspaceRow | null {
      return (findWs.get(id) as WorkspaceRow | undefined) ?? null
    },
    deleteWorkspace(id: string): boolean {
      return deleteWs.run(id).changes > 0
    },
    mountChannel(workspaceId: string, channelId: string): void {
      insertMount.run(workspaceId, channelId, new Date().toISOString())
    },
    unmountChannel(workspaceId: string, channelId: string): void {
      deleteMount.run(workspaceId, channelId)
    },
    listMountedChannels(workspaceId: string): string[] {
      return (listMounts.all(workspaceId) as Array<{ channelId: string }>).map(r => r.channelId)
    },
  }
}
