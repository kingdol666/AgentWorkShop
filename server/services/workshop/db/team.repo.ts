/**
 * AgentTeam 仓储:teams 表 CRUD(Agent 模板编组,无 channel 绑定)。
 * 成员关系见 team-member.repo.ts。
 * 工厂接收 DatabaseSync(依赖注入),不持有任何单例。
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { TeamRow } from './database'

export interface TeamCreateInput {
  name: string
  description?: string
  /** 归属用户(null = 遗留公共) */
  ownerUserId?: string | null
}

export interface TeamPatch {
  name?: string
  description?: string
}

/** teams 表仓储契约 */
export interface TeamRepo {
  /** 创建 team(description 缺省空串) */
  create(input: TeamCreateInput): TeamRow
  list(): TeamRow[]
  /** 按 owner 过滤(含 NULL 遗留公共行) */
  listForOwner(ownerUserId: string): TeamRow[]
  findById(id: string): TeamRow | undefined
  /** 局部更新;未命中返回 undefined */
  update(id: string, patch: TeamPatch): TeamRow | undefined
  remove(id: string): void
}

const COLS = 'id, name, description, owner_user_id AS ownerUserId, created_at AS createdAt, updated_at AS updatedAt'

export function createTeamRepo(db: DatabaseSync): TeamRepo {
  const insert = db.prepare(
    `INSERT INTO teams (id, name, description, owner_user_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
  const selectAll = db.prepare(`SELECT ${COLS} FROM teams ORDER BY createdAt ASC`)
  const selectByOwner = db.prepare(`SELECT ${COLS} FROM teams WHERE owner_user_id = ? OR owner_user_id IS NULL ORDER BY createdAt ASC`)
  const selectById = db.prepare(`SELECT ${COLS} FROM teams WHERE id = ?`)
  const updateStmt = db.prepare(
    `UPDATE teams SET name = ?, description = ?, updated_at = ? WHERE id = ?`,
  )
  const removeStmt = db.prepare(`DELETE FROM teams WHERE id = ?`)

  return {
    create(input: TeamCreateInput): TeamRow {
      const now = new Date().toISOString()
      const row: TeamRow = {
        id: randomUUID(),
        name: input.name,
        description: input.description ?? '',
        ownerUserId: input.ownerUserId ?? null,
        createdAt: now,
        updatedAt: now,
      }
      insert.run(row.id, row.name, row.description, row.ownerUserId, row.createdAt, row.updatedAt)
      return row
    },

    list(): TeamRow[] {
      return selectAll.all() as unknown as TeamRow[]
    },

    /** 按 owner 过滤(含 NULL 遗留公共行) */
    listForOwner(ownerUserId: string): TeamRow[] {
      return selectByOwner.all(ownerUserId) as unknown as TeamRow[]
    },

    findById(id: string): TeamRow | undefined {
      return selectById.get(id) as unknown as TeamRow | undefined
    },

    update(id: string, patch: TeamPatch): TeamRow | undefined {
      const current = selectById.get(id) as unknown as TeamRow | undefined
      if (!current) return undefined
      const next: TeamRow = {
        ...current,
        name: patch.name ?? current.name,
        description: patch.description ?? current.description,
        updatedAt: new Date().toISOString(),
      }
      updateStmt.run(next.name, next.description, next.updatedAt, id)
      return next
    },

    remove(id: string): void {
      removeStmt.run(id)
    },
  }
}
