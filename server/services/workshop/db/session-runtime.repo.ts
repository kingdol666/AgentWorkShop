/**
 * SessionRuntimeOverrideRepo —— 会话级 runtime 覆盖（session_runtime_overrides）。
 *
 * 主键 (session_id, agent_id)；agent_id 就是 runtime 对象 id（channel_agents clone id）。
 * revision 是 CAS 版本：每次成功写入 +1，空 overrides ('{}') 表示已重置为继承。
 */
import type { DatabaseSync } from 'node:sqlite'

export interface SessionRuntimeOverrideRow {
  sessionId: string
  agentId: string
  revision: number
  overridesJson: string
  createdAt: string
  updatedAt: string
  updatedBy: string
}

const COLS = 'session_id AS sessionId, agent_id AS agentId, revision, overrides_json AS overridesJson, created_at AS createdAt, updated_at AS updatedAt, updated_by AS updatedBy'

export type SessionRuntimeOverrideRepo = ReturnType<typeof createSessionRuntimeOverrideRepo>

export function createSessionRuntimeOverrideRepo(db: DatabaseSync) {
  const getStmt = db.prepare(`SELECT ${COLS} FROM session_runtime_overrides WHERE session_id = ? AND agent_id = ?`)
  const byAgentStmt = db.prepare(`SELECT ${COLS} FROM session_runtime_overrides WHERE agent_id = ? LIMIT 1`)
  const bySessionStmt = db.prepare(`SELECT ${COLS} FROM session_runtime_overrides WHERE session_id = ? ORDER BY created_at ASC`)
  const insertStmt = db.prepare(
    `INSERT INTO session_runtime_overrides (session_id, agent_id, revision, overrides_json, created_at, updated_at, updated_by)
     VALUES (?, ?, 1, ?, ?, ?, ?)
     ON CONFLICT(session_id, agent_id) DO UPDATE SET
       revision = session_runtime_overrides.revision + 1,
       overrides_json = excluded.overrides_json,
       updated_at = excluded.updated_at,
       updated_by = excluded.updated_by
     WHERE session_runtime_overrides.revision = 0`,
  )
  const updateStmt = db.prepare(
    `UPDATE session_runtime_overrides
        SET revision = revision + 1, overrides_json = ?, updated_at = ?, updated_by = ?
      WHERE session_id = ? AND agent_id = ? AND revision = ?`,
  )

  return {
    get(sessionId: string, agentId: string): SessionRuntimeOverrideRow | undefined {
      return getStmt.get(sessionId, agentId) as SessionRuntimeOverrideRow | undefined
    },

    /** resolver 用：agent 唯一（clone 只属于一个会话），按对象 id 点查 */
    findByAgent(agentId: string): SessionRuntimeOverrideRow | undefined {
      return byAgentStmt.get(agentId) as SessionRuntimeOverrideRow | undefined
    },

    listBySession(sessionId: string): SessionRuntimeOverrideRow[] {
      return bySessionStmt.all(sessionId) as unknown as SessionRuntimeOverrideRow[]
    },

    /**
     * CAS 写入：expectedRevision 必须匹配；首次写入必须是 0。
     * 返回 false = 并发冲突/版本不匹配（调用方转 409，不覆盖新值）。
     */
    save(input: {
      sessionId: string
      agentId: string
      expectedRevision: number
      overridesJson: string
      updatedBy: string
      at?: string
    }): boolean {
      const at = input.at ?? new Date().toISOString()
      if (input.expectedRevision === 0) {
        const result = insertStmt.run(input.sessionId, input.agentId, input.overridesJson, at, at, input.updatedBy)
        return Number(result.changes) === 1
      }
      const result = updateStmt.run(input.overridesJson, at, input.updatedBy, input.sessionId, input.agentId, input.expectedRevision)
      return Number(result.changes) === 1
    },
  }
}
