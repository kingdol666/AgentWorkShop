/**
 * Agent 仓储:agents 表 CRUD(全局 Agent 元数据定义,无 channel 绑定)。
 * Channel 成员关系见 channel-agent.repo.ts。
 * 工厂接收 DatabaseSync(依赖注入),不持有任何单例。
 * 可见性(v10):private 仅属主可见;public 全员可读可用;owner NULL = 内置(恒 public,不可变更)。
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { AgentRow } from './database'

const COLS = 'id, name, harness, config_json AS configJson, enabled, visibility, owner_user_id AS ownerUserId, created_at AS createdAt, updated_at AS updatedAt'

export interface AgentCreateInput {
  name: string
  harness: string
  config?: Record<string, unknown>
  /** 可见性(缺省 private) */
  visibility?: string
  /** 归属用户(null = 内置公共) */
  ownerUserId?: string | null
}

export interface AgentPatch {
  name?: string
  harness?: string
  config?: Record<string, unknown>
  enabled?: number
  visibility?: string
}

export type AgentRepo = ReturnType<typeof createAgentRepo>

export function createAgentRepo(db: DatabaseSync) {
  const insert = db.prepare(
    `INSERT INTO agents (id, name, harness, config_json, enabled, visibility, owner_user_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const selectAll = db.prepare(`SELECT ${COLS} FROM agents ORDER BY createdAt ASC`)
  const selectByOwner = db.prepare(`SELECT ${COLS} FROM agents WHERE owner_user_id = ? OR owner_user_id IS NULL ORDER BY createdAt ASC`)
  const selectVisible = db.prepare(`SELECT ${COLS} FROM agents WHERE owner_user_id = ? OR visibility = 'public' ORDER BY createdAt ASC`)
  const selectById = db.prepare(`SELECT ${COLS} FROM agents WHERE id = ?`)
  const updateStmt = db.prepare(
    `UPDATE agents SET name = ?, harness = ?, config_json = ?, enabled = ?, visibility = ?, updated_at = ? WHERE id = ?`,
  )
  const removeStmt = db.prepare(`DELETE FROM agents WHERE id = ?`)

  return {
    /** 创建 agent 定义(config 缺省 {};visibility 缺省 private) */
    create(input: AgentCreateInput): AgentRow {
      const now = new Date().toISOString()
      const row: AgentRow = {
        id: randomUUID(),
        name: input.name,
        harness: input.harness,
        configJson: JSON.stringify(input.config ?? {}),
        enabled: 1,
        visibility: input.visibility ?? 'private',
        ownerUserId: input.ownerUserId ?? null,
        createdAt: now,
        updatedAt: now,
      }
      insert.run(row.id, row.name, row.harness, row.configJson, row.enabled, row.visibility, row.ownerUserId, row.createdAt, row.updatedAt)
      return row
    },

    list(): AgentRow[] {
      return selectAll.all() as unknown as AgentRow[]
    },

    /** 按 owner 过滤(含 NULL 内置公共行) */
    listForOwner(ownerUserId: string): AgentRow[] {
      return selectByOwner.all(ownerUserId) as unknown as AgentRow[]
    },

    /** 用户可见集:本人(任意可见性)+ 全部 public(含内置) */
    listVisible(userId: string): AgentRow[] {
      return selectVisible.all(userId) as unknown as AgentRow[]
    },

    findById(id: string): AgentRow | undefined {
      return selectById.get(id) as unknown as AgentRow | undefined
    },

    /** 局部更新;config 提供时重新序列化;未命中返回 undefined */
    update(id: string, patch: AgentPatch): AgentRow | undefined {
      const current = selectById.get(id) as unknown as AgentRow | undefined
      if (!current) return undefined
      const next: AgentRow = {
        ...current,
        name: patch.name ?? current.name,
        harness: patch.harness ?? current.harness,
        configJson: patch.config !== undefined ? JSON.stringify(patch.config) : current.configJson,
        enabled: patch.enabled ?? current.enabled,
        visibility: patch.visibility ?? current.visibility,
        updatedAt: new Date().toISOString(),
      }
      updateStmt.run(next.name, next.harness, next.configJson, next.enabled, next.visibility, next.updatedAt, id)
      return next
    },

    remove(id: string): void {
      removeStmt.run(id)
    },
  }
}
