/**
 * AgentPrefab 仓储：草稿 + 不可变发布 revision。
 *
 * 发布使用 head CAS（expectedHead），并发发布只有一个成功；revision 永不原地修改。
 * 读取投影返回 draft JSON，由 service 校验/解析。
 */
import { createHash, randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { AgentPrefabDraft, AgentPrefabRevisionRow, AgentPrefabRevisionSnapshot, AgentPrefabRow } from '../agent-prefabs/types'
import { AppError } from '../../../utils/errors'
import { withTransaction } from './transaction'

const COLS = 'id, name, description, visibility, owner_user_id AS ownerUserId, draft_json AS draftJson, head_revision AS headRevision, archived_at AS archivedAt, created_at AS createdAt, updated_at AS updatedAt'
const REV_COLS = 'prefab_id AS prefabId, revision, snapshot_json AS snapshotJson, content_hash AS contentHash, created_at AS createdAt, created_by AS createdBy'

/** 对象键排序 canonical JSON（发布 hash 稳定） */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const obj = value as Record<string, unknown>
  return `{${Object.keys(obj).sort().filter(k => obj[k] !== undefined).map(k => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`
}

export function prefabSnapshotHash(draft: AgentPrefabDraft): string {
  const snapshot: AgentPrefabRevisionSnapshot = { schemaVersion: 1, draft }
  return createHash('sha256').update(canonicalJson(snapshot), 'utf8').digest('hex')
}

export interface AgentPrefabCreateInput {
  name: string
  description?: string
  visibility?: 'private' | 'public'
  ownerUserId: string
  draft: AgentPrefabDraft
}

export function createAgentPrefabRepo(db: DatabaseSync) {
  const insert = db.prepare(
    `INSERT INTO agent_prefabs (id, name, description, visibility, owner_user_id, draft_json, head_revision, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
  )
  const selectAll = db.prepare(`SELECT ${COLS} FROM agent_prefabs WHERE archived_at IS NULL ORDER BY updated_at DESC`)
  const selectVisible = db.prepare(`SELECT ${COLS} FROM agent_prefabs WHERE archived_at IS NULL AND (owner_user_id = ? OR visibility = 'public') ORDER BY updated_at DESC`)
  const selectById = db.prepare(`SELECT ${COLS} FROM agent_prefabs WHERE id = ?`)
  const updateDraftStmt = db.prepare(
    `UPDATE agent_prefabs SET name = ?, description = ?, visibility = ?, draft_json = ?, updated_at = ? WHERE id = ? AND updated_at = ? AND archived_at IS NULL`,
  )
  const updateHeadStmt = db.prepare(
    `UPDATE agent_prefabs SET head_revision = ?, updated_at = ? WHERE id = ? AND head_revision = ? AND updated_at = ? AND archived_at IS NULL`,
  )
  const archiveStmt = db.prepare(`UPDATE agent_prefabs SET archived_at = ?, updated_at = ? WHERE id = ? AND updated_at = ? AND archived_at IS NULL`)
  const deleteDraftStmt = db.prepare(`DELETE FROM agent_prefabs
    WHERE id = ? AND updated_at = ? AND head_revision = 0 AND archived_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM agent_prefab_revisions WHERE prefab_id = agent_prefabs.id)`)
  const hasRevision = db.prepare('SELECT 1 FROM agent_prefab_revisions WHERE prefab_id = ? LIMIT 1')
  const insertRevision = db.prepare(
    `INSERT INTO agent_prefab_revisions (prefab_id, revision, snapshot_json, content_hash, created_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
  const selectRevision = db.prepare(`SELECT ${REV_COLS} FROM agent_prefab_revisions WHERE prefab_id = ? AND revision = ?`)
  const selectRevisions = db.prepare(`SELECT ${REV_COLS} FROM agent_prefab_revisions WHERE prefab_id = ? ORDER BY revision DESC`)

  return {
    create(input: AgentPrefabCreateInput): AgentPrefabRow {
      const now = new Date().toISOString()
      const row: AgentPrefabRow = {
        id: `prefab-${randomUUID().slice(0, 8)}`,
        name: input.name,
        description: input.description ?? '',
        visibility: input.visibility ?? 'private',
        ownerUserId: input.ownerUserId,
        draftJson: JSON.stringify(input.draft),
        headRevision: 0,
        archivedAt: null,
        createdAt: now,
        updatedAt: now,
      }
      insert.run(row.id, row.name, row.description, row.visibility, row.ownerUserId, row.draftJson, row.createdAt, row.updatedAt)
      return row
    },

    listVisible(userId: string): AgentPrefabRow[] {
      return selectVisible.all(userId) as unknown as AgentPrefabRow[]
    },

    listAll(): AgentPrefabRow[] {
      return selectAll.all() as unknown as AgentPrefabRow[]
    },

    findById(id: string): AgentPrefabRow | undefined {
      return selectById.get(id) as unknown as AgentPrefabRow | undefined
    },

    /** 草稿更新 CAS：expectedUpdatedAt 必须等于当前值（防并发覆盖） */
    updateDraft(id: string, expectedUpdatedAt: string, patch: { name?: string, description?: string, visibility?: 'private' | 'public', draft: AgentPrefabDraft }): AgentPrefabRow {
      const current = selectById.get(id) as unknown as AgentPrefabRow | undefined
      if (!current) throw new AppError(404, 'NOT_FOUND', `AgentPrefab 不存在：${id}`)
      if (current.updatedAt !== expectedUpdatedAt) {
        throw new AppError(409, 'PREFAB_EDIT_CONFLICT', 'AgentPrefab 已被其他编辑修改，请刷新后重试')
      }
      const nextUpdatedAt = new Date(Math.max(Date.now(), Date.parse(current.updatedAt) + 1)).toISOString()
      const next: AgentPrefabRow = {
        ...current,
        name: patch.name ?? current.name,
        description: patch.description ?? current.description,
        visibility: patch.visibility ?? current.visibility,
        draftJson: JSON.stringify(patch.draft),
        updatedAt: nextUpdatedAt,
      }
      const result = updateDraftStmt.run(next.name, next.description, next.visibility, next.draftJson, next.updatedAt, id, expectedUpdatedAt)
      if (Number(result.changes ?? 0) !== 1) throw new AppError(409, 'PREFAB_EDIT_CONFLICT', 'AgentPrefab 并发更新冲突')
      return next
    },

    /** Unpublished drafts have no pins. Retain the parent and every published revision otherwise. */
    remove(id: string, expectedUpdatedAt: string): { id: string, archived: boolean } {
      return withTransaction(db, () => {
        const current = selectById.get(id) as unknown as AgentPrefabRow | undefined
        if (!current) throw new AppError(404, 'NOT_FOUND', `AgentPrefab 不存在：${id}`)
        if (current.archivedAt) throw new AppError(409, 'PREFAB_ARCHIVED', 'AgentPrefab 已归档')
        if (current.updatedAt !== expectedUpdatedAt) throw new AppError(409, 'PREFAB_EDIT_CONFLICT', 'AgentPrefab 已变化，请刷新后重试')
        const archived = current.headRevision > 0 || Boolean(hasRevision.get(id))
        const now = new Date(Math.max(Date.now(), Date.parse(current.updatedAt) + 1)).toISOString()
        const result = archived ? archiveStmt.run(now, now, id, expectedUpdatedAt) : deleteDraftStmt.run(id, expectedUpdatedAt)
        if (Number(result.changes) !== 1) throw new AppError(409, 'PREFAB_EDIT_CONFLICT', 'AgentPrefab 已变化，请刷新后重试')
        return { id, archived }
      })
    },

    /** 发布：head + draft CAS，revision 不可变。 */
    publish(id: string, expectedHead: number, draft: AgentPrefabDraft, actorId: string, expectedUpdatedAt?: string): AgentPrefabRevisionRow {
      const current = selectById.get(id) as unknown as AgentPrefabRow | undefined
      if (!current) throw new AppError(404, 'NOT_FOUND', `AgentPrefab 不存在：${id}`)
      if (current.headRevision !== expectedHead) {
        throw new AppError(409, 'PREFAB_REVISION_CONFLICT', 'AgentPrefab head 已变化，请刷新后重试')
      }
      if (current.archivedAt) throw new AppError(409, 'PREFAB_ARCHIVED', 'AgentPrefab 已归档')
      if (expectedUpdatedAt !== undefined && current.updatedAt !== expectedUpdatedAt) {
        throw new AppError(409, 'PREFAB_EDIT_CONFLICT', 'AgentPrefab 草稿已变化，请刷新后再发布')
      }
      const revision = current.headRevision + 1
      const snapshot: AgentPrefabRevisionSnapshot = { schemaVersion: 1, draft }
      const snapshotJson = JSON.stringify(snapshot)
      const contentHash = prefabSnapshotHash(draft)
      const now = new Date(Math.max(Date.now(), Date.parse(current.updatedAt) + 1)).toISOString()
      const row: AgentPrefabRevisionRow = { prefabId: id, revision, snapshotJson, contentHash, createdAt: now, createdBy: actorId }
      return withTransaction(db, () => {
        const updated = updateHeadStmt.run(revision, now, id, expectedHead, current.updatedAt)
        if (Number(updated.changes ?? 0) !== 1) {
          throw new AppError(409, 'PREFAB_REVISION_CONFLICT', 'AgentPrefab head 并发变化，发布未生效')
        }
        insertRevision.run(row.prefabId, row.revision, row.snapshotJson, row.contentHash, row.createdAt, row.createdBy)
        return row
      })
    },

    findRevision(prefabId: string, revision: number): AgentPrefabRevisionRow | undefined {
      return selectRevision.get(prefabId, revision) as unknown as AgentPrefabRevisionRow | undefined
    },

    listRevisions(prefabId: string): AgentPrefabRevisionRow[] {
      return selectRevisions.all(prefabId) as unknown as AgentPrefabRevisionRow[]
    },
  }
}

export type AgentPrefabRepo = ReturnType<typeof createAgentPrefabRepo>
