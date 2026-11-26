/**
 * SessionBindingOverrideRepo —— 会话绑定范围覆盖（session_binding_overrides）。
 *
 * 无行 = 使用创建快照；有行 = product/line/recipe 以覆盖为准，recipe 版本按当前定义实时解析。
 * revision 是 CAS 版本：首次写入为 1，之后每次 +1。
 */
import type { DatabaseSync } from 'node:sqlite'

export interface SessionBindingOverrideRow {
  sessionId: string
  revision: number
  bindingJson: string
  bindingHash: string
  createdAt: string
  updatedAt: string
  updatedBy: string
}

const COLS = 'session_id AS sessionId, revision, binding_json AS bindingJson, binding_hash AS bindingHash, created_at AS createdAt, updated_at AS updatedAt, updated_by AS updatedBy'

export type SessionBindingOverrideRepo = ReturnType<typeof createSessionBindingOverrideRepo>

export function createSessionBindingOverrideRepo(db: DatabaseSync) {
  const getStmt = db.prepare(`SELECT ${COLS} FROM session_binding_overrides WHERE session_id = ?`)
  const insertStmt = db.prepare(
    `INSERT INTO session_binding_overrides (session_id, revision, binding_json, binding_hash, created_at, updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id) DO NOTHING`,
  )
  const updateStmt = db.prepare(
    `UPDATE session_binding_overrides
        SET revision = ?, binding_json = ?, binding_hash = ?, updated_at = ?, updated_by = ?
      WHERE session_id = ? AND revision = ?`,
  )
  const deleteStmt = db.prepare('DELETE FROM session_binding_overrides WHERE session_id = ?')

  return {
    get(sessionId: string): SessionBindingOverrideRow | undefined {
      return getStmt.get(sessionId) as SessionBindingOverrideRow | undefined
    },

    /**
     * CAS 写入：expectedRevision 必须匹配；首次写入必须是 0。
     * bindingJson 必须已包含本次 revision（expectedRevision + 1）。
     */
    save(input: {
      sessionId: string
      expectedRevision: number
      revision: number
      bindingJson: string
      bindingHash: string
      updatedBy: string
      at?: string
    }): boolean {
      const at = input.at ?? new Date().toISOString()
      if (input.expectedRevision === 0) {
        const result = insertStmt.run(input.sessionId, input.revision, input.bindingJson, input.bindingHash, at, at, input.updatedBy)
        return Number(result.changes) === 1
      }
      const result = updateStmt.run(
        input.revision,
        input.bindingJson,
        input.bindingHash,
        at,
        input.updatedBy,
        input.sessionId,
        input.expectedRevision,
      )
      return Number(result.changes) === 1
    },

    remove(sessionId: string): boolean {
      return Number(deleteStmt.run(sessionId).changes) === 1
    },
  }
}
